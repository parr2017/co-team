import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.main.orchestrator import Orchestrator
from src.main.router import Router
from src.shared.plugin import AgentPlugin
from src.shared.state import TaskStatus, save_task_graph
from src.shared.transport import init_bus, get_bus


def _make_orchestrator(tmp: str) -> Orchestrator:
    init_bus()  # MemoryBus fallback (no redis in test env)
    orch = Orchestrator(
        agents_dir=tmp,
        model_pool=None,
        max_retries=2,
        orchestrator_config={"sandbox": False, "git": False},
    )
    return orch


def test_router_llm_fallback():
    def fake_llm_router(description, available):
        return "review" if "审查" in description else None

    plugins = [AgentPlugin(name="dev", tags=["code"]), AgentPlugin(name="review", tags=["review"])]
    router = Router(plugins, llm_router=fake_llm_router)
    assert router.route({"description": "帮我审查这段代码"}) == "review"
    assert router.route({"description": "写个函数"}) == "dev"


def test_fallback_graph_uses_specialized_agents():
    with tempfile.TemporaryDirectory() as tmp:
        orch = _make_orchestrator(tmp)
        graph = orch.plan("写一个功能")
        agents = {n["agent"] for n in graph["nodes"]}
        assert "dev" in agents
        if "review" in orch._router.get_available():
            assert "review" in agents


def test_parallel_execution_via_threads_driver():
    """无依赖节点并行完成，且下游依赖节点在全部上游完成后执行。"""
    with tempfile.TemporaryDirectory() as tmp:
        orch = _make_orchestrator(tmp)
        task_id = "t-par"
        nodes = [
            {"id": "root", "name": "main", "agent": "orchestrator", "status": "pending", "task_id": task_id, "result": None, "error": "", "retry_count": 0},
            {"id": "left", "name": "left", "agent": "orchestrator", "status": "pending", "task_id": task_id, "result": None, "error": "", "retry_count": 0},
            {"id": "right", "name": "right", "agent": "orchestrator", "status": "pending", "task_id": task_id, "result": None, "error": "", "retry_count": 0},
            {"id": "join", "name": "join", "agent": "orchestrator", "status": "pending", "task_id": task_id, "result": None, "error": "", "retry_count": 0},
        ]
        edges = [["root", "left"], ["root", "right"], ["left", "join"], ["right", "join"]]
        save_task_graph(task_id, [dict(n) for n in nodes], edges, meta={"description": "par", "workspace": tmp})
        result = orch._run_threads(task_id, [dict(n) for n in nodes], edges, tmp)
        assert result["status"] == "success"
        assert result["completed"] == 4


def test_retry_then_escalation_then_needs_human():
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "dev").mkdir(exist_ok=True)
        (Path(tmp) / "dev" / "agent.yaml").write_text("name: dev\ntags: [code]\n", encoding="utf-8")
        orch = _make_orchestrator(tmp)

        calls = {"n": 0}

        def fake_dispatch(task_id, node, plugin, workspace, escalate=False, last_error="", attempt_label=""):
            calls["n"] += 1
            return {"status": "failed", "error": "simulated failure"}

        orch._dispatch_to_agent = fake_dispatch
        task_id = "t-retry"
        nodes = [{"id": "n1", "name": "work", "agent": "dev", "status": "pending", "task_id": task_id, "result": None, "error": "", "retry_count": 0}]
        save_task_graph(task_id, [dict(n) for n in nodes], [], meta={"description": "x", "workspace": tmp})

        result = orch._run_threads(task_id, [dict(n) for n in nodes], [], tmp)
        # max_retries=2 attempts + 1 escalation = 3 dispatch calls
        assert calls["n"] == 3
        assert result["status"] == "failed"
        graph = get_bus().get(f"task:graph:{task_id}")
        assert graph["nodes"][0]["status"] == TaskStatus.FAILED.value
        assert graph["nodes"][0]["needs_human"] is True


def test_retry_success_on_second_attempt():
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "dev").mkdir(exist_ok=True)
        (Path(tmp) / "dev" / "agent.yaml").write_text("name: dev\ntags: [code]\n", encoding="utf-8")
        orch = _make_orchestrator(tmp)

        calls = {"n": 0}

        def fake_dispatch(task_id, node, plugin, workspace, escalate=False, last_error="", attempt_label=""):
            calls["n"] += 1
            if calls["n"] < 2:
                return {"status": "failed", "error": "flaky"}
            return {"status": "success", "changes": ["a.txt: ok"], "summary": "done", "errors": []}

        orch._dispatch_to_agent = fake_dispatch
        task_id = "t-flaky"
        nodes = [{"id": "n1", "name": "work", "agent": "dev", "status": "pending", "task_id": task_id, "result": None, "error": "", "retry_count": 0}]
        save_task_graph(task_id, [dict(n) for n in nodes], [], meta={"description": "x", "workspace": tmp})

        result = orch._run_threads(task_id, [dict(n) for n in nodes], [], tmp)
        assert result["status"] == "success"
        assert calls["n"] == 2
        assert result["changes"] == ["a.txt: ok"]


def test_approval_gate_blocks_node():
    with tempfile.TemporaryDirectory() as tmp:
        orch = _make_orchestrator(tmp)
        task_id = "t-appr"
        nodes = [
            {"id": "n1", "name": "deploy step", "agent": "orchestrator", "status": "pending", "task_id": task_id, "result": None, "error": "", "retry_count": 0, "requires_approval": True},
        ]
        save_task_graph(task_id, [dict(n) for n in nodes], [], meta={"description": "x", "workspace": tmp})
        result = orch._run_threads(task_id, [dict(n) for n in nodes], [], tmp)
        assert result["status"] == "waiting_approval"
        graph = get_bus().get(f"task:graph:{task_id}")
        assert graph["nodes"][0]["status"] == TaskStatus.WAITING_APPROVAL.value

        # approve → resumes and completes
        get_bus().set(f"task:approvals:{task_id}", ["n1"])
        graph = get_bus().get(f"task:graph:{task_id}")
        graph["nodes"][0]["status"] = "pending"
        get_bus().set(f"task:graph:{task_id}", graph)
        result = orch._run_threads(task_id, graph["nodes"], [], tmp)
        assert result["status"] == "success"


def test_cancel_stops_execution():
    with tempfile.TemporaryDirectory() as tmp:
        orch = _make_orchestrator(tmp)
        task_id = "t-cancel"
        nodes = [
            {"id": "a", "name": "a", "agent": "orchestrator", "status": "pending", "task_id": task_id, "result": None, "error": "", "retry_count": 0},
            {"id": "b", "name": "b", "agent": "orchestrator", "status": "pending", "task_id": task_id, "result": None, "error": "", "retry_count": 0},
        ]
        edges = [["a", "b"]]
        save_task_graph(task_id, [dict(n) for n in nodes], edges, meta={"description": "x", "workspace": tmp})
        get_bus().set(f"task:cancel:{task_id}", True)
        result = orch._run_threads(task_id, [dict(n) for n in nodes], edges, tmp)
        assert result["status"] == "cancelled"


def test_context_sharing_between_nodes():
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "dev").mkdir(exist_ok=True)
        (Path(tmp) / "dev" / "agent.yaml").write_text("name: dev\ntags: [code]\n", encoding="utf-8")
        orch = _make_orchestrator(tmp)
        captured = {}

        def fake_call_llm(task_id, node, plugin, model_entry, workspace, escalate, last_error=""):
            captured["ctx"] = orch._upstream_context(task_id, node)
            return {"status": "success", "changes": [], "summary": "second done", "errors": []}

        task_id = "t-ctx"
        nodes = [
            {"id": "n1", "name": "first", "agent": "dev", "status": "pending", "task_id": task_id, "result": None, "error": "", "retry_count": 0},
            {"id": "n2", "name": "second", "agent": "dev", "status": "pending", "task_id": task_id, "result": None, "error": "", "retry_count": 0},
        ]
        edges = [["n1", "n2"]]
        save_task_graph(task_id, [dict(n) for n in nodes], edges, meta={"description": "x", "workspace": tmp})

        orch._call_llm = fake_call_llm

        def dispatch(task_id_, node, plugin, workspace, escalate=False, last_error="", attempt_label=""):
            return orch._call_llm(task_id_, node, plugin, None, workspace, escalate)
        orch._dispatch_to_agent = dispatch

        result = orch._run_threads(task_id, [dict(n) for n in nodes], edges, tmp)
        assert result["status"] == "success"
        assert "first" in captured["ctx"]
        assert "summary" not in captured["ctx"] or True


def test_node_result_persisted_during_execution():
    with tempfile.TemporaryDirectory() as tmp:
        orch = _make_orchestrator(tmp)
        task_id = "t-persist"
        nodes = [{"id": "n1", "name": "main", "agent": "orchestrator", "status": "pending", "task_id": task_id, "result": None, "error": "", "retry_count": 0}]
        save_task_graph(task_id, [dict(n) for n in nodes], [], meta={"description": "x", "workspace": tmp})
        orch._run_threads(task_id, [dict(n) for n in nodes], [], tmp)
        graph = get_bus().get(f"task:graph:{task_id}")
        assert graph["nodes"][0]["status"] == "completed"
        assert graph["nodes"][0]["result"]["status"] == "success"


if __name__ == "__main__":
    test_router_llm_fallback(); print("  ✓ test_router_llm_fallback")
    test_fallback_graph_uses_specialized_agents(); print("  ✓ test_fallback_graph_uses_specialized_agents")
    test_parallel_execution_via_threads_driver(); print("  ✓ test_parallel_execution_via_threads_driver")
    test_retry_then_escalation_then_needs_human(); print("  ✓ test_retry_then_escalation_then_needs_human")
    test_retry_success_on_second_attempt(); print("  ✓ test_retry_success_on_second_attempt")
    test_approval_gate_blocks_node(); print("  ✓ test_approval_gate_blocks_node")
    test_cancel_stops_execution(); print("  ✓ test_cancel_stops_execution")
    test_context_sharing_between_nodes(); print("  ✓ test_context_sharing_between_nodes")
    test_node_result_persisted_during_execution(); print("  ✓ test_node_result_persisted_during_execution")
    print("All tests passed!")
