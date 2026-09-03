import json
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, wait
from typing import Callable

from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

from src.main.router import Router, DEFAULT_RULES
from src.main.scheduler import ModelEntry, ModelPool
from src.shared import git_tool
from src.shared.plugin import discover_plugins
from src.shared.sandbox import (
    PermissionPolicy,
    cleanup_sandbox,
    create_sandbox,
    merge_changes,
)
from src.shared.state import (
    TaskNode,
    TaskStatus,
    add_memory,
    emit_event,
    get_memory,
    get_task_graph,
    save_task_graph,
)
from src.shared.tools import apply_final_output, apply_tool_calls
from src.shared.transport import get_bus


class AgentOutput(BaseModel):
    status: str = Field(description="success or failed")
    changes: list[str] = Field(default_factory=list)
    summary: str = Field(default="")
    errors: list[str] = Field(default_factory=list)
    files: list[dict] = Field(default_factory=list, description="files to write: [{path, content}]")
    commands: list[str] = Field(default_factory=list, description="commands to run in workspace")
    tool_calls: list[dict] = Field(default_factory=list, description="mid-run read tools: [{tool, path}]")


class BudgetExceeded(Exception):
    pass


class Orchestrator:
    def __init__(
        self,
        agents_dir: str = "./agents",
        router_rules: list[dict] | None = None,
        model_pool: ModelPool | None = None,
        max_retries: int = 3,
        permission_policy: PermissionPolicy | None = None,
        orchestrator_config: dict | None = None,
    ):
        self._plugins = discover_plugins(agents_dir)
        self._agents_dir = agents_dir
        self._model_pool = model_pool
        self._max_retries = max_retries
        self._policy = permission_policy or PermissionPolicy()
        cfg = orchestrator_config or {}
        self._sandbox_enabled = cfg.get("sandbox", True)
        self._git_enabled = cfg.get("git", True)
        self._token_budget = cfg.get("token_budget")
        self._llm_router = self._make_llm_router()
        self._router = Router(self._plugins, router_rules or DEFAULT_RULES, llm_router=self._llm_router)
        self._workspace = ""
        self._on_progress: Callable | None = None
        self._graph_lock = threading.Lock()
        self._task_tokens: dict[str, int] = {}

    # ---------- events ----------

    def set_progress_callback(self, callback: Callable):
        self._on_progress = callback

    def _progress(self, event_type: str, data: dict):
        if self._on_progress:
            try:
                self._on_progress(event_type, data)
            except Exception:
                pass
        try:
            from src.shared.state import EventChannel

            emit_event(EventChannel.TASK, event_type, data)
            emit_event(EventChannel.DASHBOARD, event_type, data)
        except Exception:
            pass

    # ---------- LLM helpers ----------

    def _get_llm(self, model_entry: ModelEntry, temperature: float = 0):
        return ChatOpenAI(
            model=model_entry.name,
            openai_api_key=model_entry.api_key,
            openai_api_base=model_entry.base_url.rstrip("/"),
            max_tokens=8192,
            temperature=temperature,
            streaming=False,
        )

    def _make_llm_router(self):
        if not self._model_pool:
            return None

        def route(description: str, available: list[str]) -> str | None:
            entry = self._model_pool.select_model(["code"], complexity="simple")
            if not entry:
                return None
            llm = self._get_llm(entry)
            resp = llm.invoke([
                {"role": "system", "content": "你是任务路由器。只输出一个 agent 名字，不要输出其他内容。"},
                {"role": "user", "content": f"可选 agent：{', '.join(available)}\n任务：{description}\n输出最合适的 agent 名字："},
            ])
            return str(resp.content).strip()

        return route

    # ---------- planning ----------

    def plan(self, user_request):
        return self._generate_task_graph(user_request)

    def _generate_task_graph(self, request):
        first_model = self._model_pool.select_model(["code"], complexity="simple") if self._model_pool else None
        if first_model:
            result = self._llm_plan(request, first_model)
            if result:
                return result
        return self._fallback_graph(request)

    def _llm_plan(self, request, model_entry):
        available = list(self._router.get_available().keys())
        agents_str = ", ".join(available) if available else "dev"
        agent_desc = "\n".join(
            f"- {p.name}: {p.role or p.description} (tags: {','.join(p.tags)})"
            for p in self._router.get_available().values()
        ) or "- dev: 开发实现"
        memory_str = "\n".join("- " + m for m in get_memory()) or "（暂无历史经验）"

        user_content = (
            "你是任务规划器。你只能使用这些 agent 名字：" + agents_str + "。不要发明新的 agent 名字。\n\n"
            "可用 agent 及职责：\n" + agent_desc + "\n\n"
            "历史经验（跨任务记忆，避免重复犯错）：\n" + memory_str + "\n\n"
            "把需求拆解为有序任务节点。注意：\n"
            "1. 节点按依赖排序，edges 描述依赖关系（[前, 后]）\n"
            "2. 无依赖关系的节点可以并行\n"
            "3. 涉及部署/删除等危险操作的节点标记 requires_approval: true\n"
            "4. 为每个节点标注 complexity: simple|normal|complex\n"
            '返回 JSON：{"nodes":[{"id":"1","name":"...","agent":"dev","complexity":"normal",'
            '"requires_approval":false}],"edges":[["1","2"]]}\n\n'
            "需求：" + request
        )
        try:
            llm = self._get_llm(model_entry)
            response = llm.invoke([
                {"role": "system", "content": "You are a task planner. Use ONLY the given agent names."},
                {"role": "user", "content": user_content},
            ])
            self._record_llm_usage(model_entry.name, response)
            content = response.content.strip()
            if content.startswith("```"):
                content = "\n".join(l for l in content.split("\n") if not l.startswith("```"))
            match = re.search(r"\{.*\}", content, re.DOTALL)
            graph = json.loads(match.group(0) if match else content)
            if "nodes" in graph and len(graph["nodes"]) > 0:
                for n in graph["nodes"]:
                    n.setdefault("id", str(uuid.uuid4())[:8])
                    n.setdefault("status", TaskStatus.PENDING.value)
                    n.setdefault("task_id", request[:20])
                    n.setdefault("agent", "dev")
                    n.setdefault("result", None)
                    n.setdefault("error", "")
                    n.setdefault("retry_count", 0)
                    n.setdefault("complexity", "normal")
                    n.setdefault("requires_approval", False)
                edges = graph.get("edges", [])
                node_ids = {n["id"] for n in graph["nodes"]}
                valid_edges = []
                for e in edges:
                    if isinstance(e, (list, tuple)) and len(e) == 2 and e[0] in node_ids and e[1] in node_ids:
                        valid_edges.append(list(e))
                if not valid_edges and len(graph["nodes"]) > 1:
                    valid_edges = [[graph["nodes"][i]["id"], graph["nodes"][i + 1]["id"]] for i in range(len(graph["nodes"]) - 1)]
                return {"nodes": graph["nodes"], "edges": valid_edges}
        except Exception:
            pass
        return None

    def _fallback_graph(self, request):
        main_id = str(uuid.uuid4())[:8]
        dev_id = str(uuid.uuid4())[:8]
        review_id = str(uuid.uuid4())[:8]
        test_id = str(uuid.uuid4())[:8]
        merge_id = str(uuid.uuid4())[:8]
        nodes = [
            {"id": main_id, "name": "Main Task", "status": TaskStatus.PENDING.value, "task_id": request[:20], "agent": "orchestrator", "result": None, "error": "", "retry_count": 0, "complexity": "simple", "requires_approval": False},
            {"id": dev_id, "name": "Development: " + request[:40], "status": TaskStatus.PENDING.value, "task_id": request[:20], "agent": "dev", "result": None, "error": "", "retry_count": 0, "complexity": "normal", "requires_approval": False},
            {"id": review_id, "name": "Code Review", "status": TaskStatus.PENDING.value, "task_id": request[:20], "agent": "review" if "review" in self._plugins else "dev", "result": None, "error": "", "retry_count": 0, "complexity": "normal", "requires_approval": False},
            {"id": test_id, "name": "Testing", "status": TaskStatus.PENDING.value, "task_id": request[:20], "agent": "test" if "test" in self._plugins else "dev", "result": None, "error": "", "retry_count": 0, "complexity": "normal", "requires_approval": False},
            {"id": merge_id, "name": "Merge Changes", "status": TaskStatus.PENDING.value, "task_id": request[:20], "agent": "orchestrator", "result": None, "error": "", "retry_count": 0, "complexity": "simple", "requires_approval": False},
        ]
        return {
            "nodes": nodes,
            "edges": [[main_id, dev_id], [dev_id, review_id], [dev_id, test_id], [review_id, merge_id], [test_id, merge_id]],
        }

    # ---------- execution ----------

    def execute(self, task_id, workspace):
        self._workspace = workspace
        graph = self._load_graph(task_id)
        if not graph:
            return {"status": "error", "message": "Task graph not found"}

        nodes = graph["nodes"]
        edges = graph["edges"]

        # reset non-completed nodes so a re-run (e.g. after approval) resumes cleanly
        for node in nodes:
            if node.get("status") not in (TaskStatus.COMPLETED.value, TaskStatus.CANCELLED.value):
                if node.get("status") == TaskStatus.RUNNING.value:
                    node["status"] = TaskStatus.PENDING.value

        self._persist(task_id, nodes, edges, workspace, "running")
        self._progress("execute_start", {"task_id": task_id, "workspace": workspace, "total_nodes": len(nodes)})

        sandbox = create_sandbox(workspace, self._policy) if self._sandbox_enabled else workspace
        result = {"status": "failed", "error": "execution did not run"}
        try:
            result = self._run_graph(task_id, nodes, edges, sandbox)
        finally:
            if self._sandbox_enabled and sandbox != workspace:
                if result.get("status") in ("success",):
                    merged = merge_changes(sandbox, workspace)
                    result["merged_files"] = merged
                cleanup_sandbox(sandbox)

        status = result.get("status")
        final_status = {"success": "success", "failed": "failed", "waiting_approval": "waiting_approval", "cancelled": "cancelled"}.get(status, status)

        # git integration: commit merged changes on a task branch
        if status == "success" and self._git_enabled and result.get("changes"):
            git_result = self._git_commit(task_id, workspace, result.get("changes", []))
            if git_result:
                result["git_commit"] = git_result

        self._persist(task_id, nodes, edges, workspace, final_status)
        self._progress("execute_complete" if status == "success" else "execute_" + final_status,
                       {"task_id": task_id, "completed": len([n for n in nodes if n.get("status") == TaskStatus.COMPLETED.value]),
                        "total": len(nodes), "all_changes": result.get("changes", []),
                        "status": final_status, **({"error": result["error"]} if result.get("error") else {})})

        # notifications + cross-task memory
        try:
            from src.notify import notify

            if status == "success":
                notify("task_success", {"task_id": task_id}, f"[Co-Team] 任务 {task_id} 完成，{len(result.get('changes', []))} 个文件变更")
                add_memory(f"任务「{graph.get('description', task_id)}」成功完成，产出了 {len(result.get('changes', []))} 个文件变更。")
            elif status == "failed":
                notify("task_failed", {"task_id": task_id, "error": result.get("error", "")}, f"[Co-Team] 任务 {task_id} 失败：{result.get('error', '')}")
                add_memory(f"任务「{graph.get('description', task_id)}」失败于节点：{result.get('error', '')}。后续类似任务注意规避。")
        except Exception:
            pass

        return result

    def _run_graph(self, task_id, nodes, edges, sandbox) -> dict:
        try:
            return self._run_langgraph(task_id, nodes, edges, sandbox)
        except ImportError:
            return self._run_threads(task_id, nodes, edges, sandbox)

    # ----- LangGraph driver (tech-debt P0: real StateGraph execution) -----

    def _run_langgraph(self, task_id, nodes, edges, sandbox) -> dict:
        from typing import Annotated, TypedDict

        from langgraph.graph import END, START, StateGraph

        class ExecState(TypedDict, total=False):
            task_id: Annotated[str, lambda old, new: new or old]

        node_map = {n["id"]: n for n in nodes}
        upstream = {nid: [e[0] for e in edges if e[1] == nid] for nid in node_map}

        def make_fn(node):
            def fn(_state):
                return self._langgraph_node(task_id, node, node_map, upstream, sandbox)
            return fn

        g = StateGraph(ExecState)
        for node in nodes:
            g.add_node(node["id"], make_fn(node))
        for node in nodes:
            deps = upstream[node["id"]]
            if not deps:
                g.add_edge(START, node["id"])
        for src, dst in edges:
            g.add_edge(src, dst)
        for node in nodes:
            if not any(e[0] == node["id"] for e in edges):
                g.add_edge(node["id"], END)

        app = g.compile()
        app.invoke(
            {"task_id": task_id},
            config={"recursion_limit": max(50, len(nodes) * 4)},
        )

        if self._is_cancelled(task_id):
            return {"status": "cancelled"}
        statuses = [n.get("status") for n in nodes]
        if any(s == TaskStatus.WAITING_APPROVAL.value for s in statuses):
            return {"status": "waiting_approval", "changes": []}
        if any(s == TaskStatus.FAILED.value for s in statuses):
            failed = next(n for n in nodes if n.get("status") == TaskStatus.FAILED.value)
            return {"status": "failed", "node": failed["id"], "error": failed.get("error", "node failed")}
        return {
            "status": "success",
            "completed": len([n for n in nodes if n.get("status") == TaskStatus.COMPLETED.value]),
            "total": len(nodes),
            "changes": self._collect_changes(nodes),
        }

    def _langgraph_node(self, task_id, node, node_map, upstream, sandbox) -> dict:
        nid = node["id"]

        if self._node_status(task_id, nid) == TaskStatus.COMPLETED.value:
            return {}
        if self._is_cancelled(task_id):
            self._set_node_status(task_id, node_map, nid, TaskStatus.CANCELLED.value, "task cancelled")
            return {}

        # gate: upstream must be completed (or skipped because they were cancelled upstream)
        for dep in upstream.get(nid, []):
            dep_status = self._node_status(task_id, dep)
            if dep_status in (TaskStatus.FAILED.value, TaskStatus.CANCELLED.value):
                self._set_node_status(task_id, node_map, nid, TaskStatus.CANCELLED.value, "upstream " + dep_status)
                return {}
            if dep_status in (TaskStatus.WAITING_APPROVAL.value, TaskStatus.RUNNING.value, TaskStatus.PENDING.value):
                # execution is paused upstream; stay pending
                return {}

        # approval gate
        approvals = get_bus().get(f"task:approvals:{task_id}") or []
        if node.get("requires_approval") and nid not in approvals:
            self._set_node_status(task_id, node_map, nid, TaskStatus.WAITING_APPROVAL.value, "needs human approval")
            self._progress("node_waiting_approval", {"task_id": task_id, "node_id": nid, "name": node.get("name", "")})
            try:
                from src.notify import notify
                notify("approval_required", {"task_id": task_id, "node_id": nid}, f"[Co-Team] 节点「{node.get('name', '')}」等待人工审批")
            except Exception:
                pass
            return {}

        outcome = self._execute_node(task_id, node, node_map, sandbox)
        if outcome == "failed":
            # fail fast: mark all downstream pending nodes cancelled
            self._cancel_downstream(task_id, node_map, upstream, nid)
        return {}

    # ----- fallback threaded driver (no langgraph) -----

    def _run_threads(self, task_id, nodes, edges, sandbox) -> dict:
        node_map = {n["id"]: n for n in nodes}
        upstream = {nid: [e[0] for e in edges if e[1] == nid] for nid in node_map}
        max_workers = max(1, self._model_pool.get_total_available() if self._model_pool else 2)

        while not self._is_cancelled(task_id):
            ready = []
            for node in nodes:
                nid = node["id"]
                if self._node_status(task_id, nid) != TaskStatus.PENDING.value:
                    continue
                deps = upstream.get(nid, [])
                if all(self._node_status(task_id, d) == TaskStatus.COMPLETED.value for d in deps):
                    ready.append(node)
            if not ready:
                break

            approvals = get_bus().get(f"task:approvals:{task_id}") or []
            blocked = [n for n in ready if n.get("requires_approval") and n["id"] not in approvals]
            runnable = [n for n in ready if n not in blocked]
            if blocked:
                for n in blocked:
                    self._set_node_status(task_id, node_map, n["id"], TaskStatus.WAITING_APPROVAL.value, "needs human approval")
                    self._progress("node_waiting_approval", {"task_id": task_id, "node_id": n["id"], "name": n.get("name", "")})
            if not runnable:
                return {"status": "waiting_approval", "changes": []}

            with ThreadPoolExecutor(max_workers=min(max_workers, len(runnable))) as pool:
                futures = [pool.submit(self._execute_node, task_id, n, node_map, sandbox) for n in runnable]
                wait(futures)

            if any(self._node_status(task_id, n["id"]) == TaskStatus.FAILED.value for n in runnable):
                failed = next(n for n in runnable if self._node_status(task_id, n["id"]) == TaskStatus.FAILED.value)
                self._cancel_downstream(task_id, node_map, upstream, failed["id"])
                return {"status": "failed", "node": failed["id"], "error": failed.get("error", "node failed")}

        if self._is_cancelled(task_id):
            for n in nodes:
                if self._node_status(task_id, n["id"]) == TaskStatus.PENDING.value:
                    self._set_node_status(task_id, node_map, n["id"], TaskStatus.CANCELLED.value, "task cancelled")
            return {"status": "cancelled"}
        return {
            "status": "success",
            "completed": len([n for n in nodes if self._node_status(task_id, n["id"]) == TaskStatus.COMPLETED.value]),
            "total": len(nodes),
            "changes": self._collect_changes(nodes),
        }

    # ----- single node execution with retry + escalation -----

    def _execute_node(self, task_id, node, node_map, sandbox) -> str:
        nid = node["id"]
        node["status"] = TaskStatus.RUNNING.value
        node["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        self._persist_running(task_id, node)
        self._progress("node_start", {"task_id": task_id, "node_id": nid, "name": node.get("name", ""), "agent": node.get("agent", "")})

        if node.get("agent") == "orchestrator":
            node["status"] = TaskStatus.COMPLETED.value
            self._persist_node_result(task_id, node, {"status": "success", "summary": "orchestrator step"})
            self._progress("node_complete", {"task_id": task_id, "node_id": nid, "name": node.get("name", ""), "changes": []})
            return "success"

        plugin = self._router.get_available().get(node.get("agent", "dev"))
        if not plugin:
            node["status"] = TaskStatus.FAILED.value
            node["error"] = "Agent " + str(node.get("agent")) + " not found"
            self._persist_node_result(task_id, node, node.get("result"))
            self._progress("node_error", {"task_id": task_id, "node_id": nid, "error": node["error"]})
            return "failed"

        error = ""
        for attempt in range(max(1, self._max_retries)):
            if attempt > 0:
                node["status"] = TaskStatus.RETRYING.value
                self._persist_running(task_id, node)
                self._progress("node_retry", {"task_id": task_id, "node_id": nid, "attempt": attempt + 1})

            node["retry_count"] = attempt
            result = self._dispatch_to_agent(task_id, node, plugin, sandbox, escalate=False, attempt_label=f"第 {attempt + 1} 次尝试")
            if result.get("status") == "success":
                node["status"] = TaskStatus.COMPLETED.value
                node["result"] = result
                node["error"] = ""
                self._persist_node_result(task_id, node, result)
                self._progress("node_complete", {"task_id": task_id, "node_id": nid, "name": node.get("name", ""), "changes": result.get("changes", []), "summary": result.get("summary", "")})
                return "success"
            error = result.get("error", "unknown error")
            if "token budget" in error.lower():
                break  # no point retrying on budget exhaustion

        # escalation: orchestrator (main agent) takes over with an adjusted strategy
        self._progress("node_escalate", {"task_id": task_id, "node_id": nid, "name": node.get("name", ""), "error": error})
        result = self._dispatch_to_agent(task_id, node, plugin, sandbox, escalate=True, last_error=error, attempt_label="主 Agent 接管")
        if result.get("status") == "success":
            node["status"] = TaskStatus.COMPLETED.value
            node["result"] = {**result, "escalated": True}
            node["error"] = ""
            self._persist_node_result(task_id, node, node["result"])
            self._progress("node_complete", {"task_id": task_id, "node_id": nid, "name": node.get("name", ""), "changes": result.get("changes", []), "summary": result.get("summary", "") + "（主 Agent 接管后完成）"})
            return "success"

        node["status"] = TaskStatus.FAILED.value
        node["error"] = result.get("error", error)
        node["result"] = result
        node["needs_human"] = True
        self._persist_node_result(task_id, node, result)
        self._progress("node_error", {"task_id": task_id, "node_id": nid, "name": node.get("name", ""), "error": node["error"]})
        try:
            from src.notify import notify
            notify("node_needs_human", {"task_id": task_id, "node_id": nid}, f"[Co-Team] 节点「{node.get('name', '')}」重试与接管均失败，需要人工介入")
        except Exception:
            pass
        return "failed"

    # ----- model dispatch with degradation chain -----

    def _dispatch_to_agent(self, task_id, node, plugin, workspace, escalate: bool = False, last_error: str = "", attempt_label: str = "") -> dict:
        self._check_budget(task_id)

        complexity = node.get("complexity", "normal")
        primary = self._select_model(plugin, complexity)
        if not primary:
            return {"status": "failed", "error": "No available model"}

        chain = self._model_pool.fallback_chain(primary, plugin.tags) if self._model_pool else [primary]
        last_err = ""
        for entry in chain:
            if not self._acquire_with_wait(entry):
                continue
            try:
                result = self._call_llm(task_id, node, plugin, entry, workspace, escalate, last_error, attempt_label)
                self._model_pool.mark_success(entry)
                return result
            except BudgetExceeded:
                return {"status": "failed", "error": "token budget exceeded for this task"}
            except Exception as e:
                last_err = str(e)[:500]
                self._model_pool.mark_failure(entry)
            finally:
                entry.release_slot()
        return {"status": "failed", "error": f"all models failed: {last_err or 'unknown'}"}

    def _select_model(self, plugin, complexity: str = "normal") -> ModelEntry | None:
        if self._model_pool:
            return self._model_pool.select_model(plugin.tags, complexity)
        return None

    def _acquire_with_wait(self, entry: ModelEntry, timeout: float = 120.0) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if entry.acquire_slot():
                return True
            time.sleep(0.2)
        return False

    def _check_budget(self, task_id) -> None:
        if not self._token_budget:
            return
        used = self._task_tokens.get(task_id, 0)
        if used > self._token_budget:
            raise BudgetExceeded(f"token budget {self._token_budget} exceeded (used {used})")

    # ----- agent LLM call with tool loop -----

    def _call_llm(self, task_id, node, plugin, model_entry, workspace, escalate: bool, last_error: str = "", attempt_label: str = "") -> dict:
        llm = self._get_llm(model_entry, temperature=0.3 if escalate else 0)
        context = self._upstream_context(task_id, node)
        workspace_files = ", ".join(self._workspace_listing(workspace, limit=50))

        escalation_block = ""
        if escalate:
            escalation_block = (
                f"\n\n## 重要：主 Agent 接管\n"
                f"该任务之前已尝试 {self._max_retries} 次均失败，最近一次错误：{last_error}\n"
                "请调整策略：换一种实现思路，或把任务范围缩小到可完成的最小闭环，确保本次成功。"
            )

        system_msg = (
            (plugin.prompt or "你是开发 Agent。")
            + "\n\n你可以请求读取工具（返回 JSON 时附带 tool_calls 字段）:"
            + ' {"tool_calls":[{"tool":"list_files"}]} 或 {"tool_calls":[{"tool":"read_file","path":"xxx"}]}'
            + "\n最终输出必须是 JSON（不要 markdown 代码块）："
            + '{"status":"success|failed","changes":["file: desc"],"summary":"摘要","errors":[],'
            + '"files":[{"path":"相对路径","content":"完整文件内容"}],"commands":["要执行的命令"]}'
            + "\nfiles 中给出需要创建或修改的文件的完整内容；commands 会在沙箱中执行（仅限白名单命令）。"
        )
        user_msg = (
            f"工作目录: {workspace}\n"
            f"现有文件: {workspace_files}\n"
            f"任务: {node.get('name', '')}\n"
            f"节点复杂度: {node.get('complexity', 'normal')}\n"
            + (f"前置节点成果:\n{context}\n" if context else "")
            + escalation_block
        )

        # conversation transcript for the dashboard replay view
        record = {
            "label": attempt_label or ("主 Agent 接管" if escalate else "尝试"),
            "agent": plugin.name,
            "model": model_entry.name,
            "node_name": node.get("name", ""),
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "system": system_msg,
            "rounds": [],
            "tokens": 0,
            "error": "",
        }
        start_ts = time.time()
        messages = [
            {"role": "system", "content": system_msg},
            {"role": "user", "content": user_msg},
        ]
        parsed = None
        content = ""
        try:
            # tool loop: agent may request read-only tools before final answer
            for _round in range(3):
                response = llm.invoke(messages)
                self._record_llm_usage(model_entry.name, response, task_id)
                content = self._strip_code_fence(str(response.content))
                parsed = self._extract_json(content)
                round_entry = {"assistant": content, "tool_results": None, "parse_error": None}
                if parsed is None:
                    round_entry["parse_error"] = "output was not valid JSON"
                    record["rounds"].append(round_entry)
                    record["error"] = "failed to parse agent output as JSON"
                    return {"status": "failed", "error": record["error"], "raw_output": content[:2000]}
                tool_calls = parsed.get("tool_calls") or []
                if not tool_calls:
                    record["rounds"].append(round_entry)
                    break
                results = apply_tool_calls(workspace, tool_calls, self._policy)
                tool_summary = json.dumps(results, ensure_ascii=False)[:8000]
                round_entry["tool_results"] = results
                record["rounds"].append(round_entry)
                messages.append({"role": "assistant", "content": content})
                messages.append({"role": "user", "content": "工具执行结果：\n" + tool_summary + "\n\n请基于以上信息给出最终 JSON 结果。"})
                record["rounds"].append({"user": "（工具执行结果已提供，见上一轮 tool_results）", "tool_results": results})

            if parsed.get("status") != "success":
                record["error"] = "; ".join(parsed.get("errors") or []) or parsed.get("summary", "") or "agent reported failure"
                return {
                    "status": "failed",
                    "error": record["error"],
                    "raw_output": content[:2000],
                }

            result = apply_final_output(workspace, parsed, self._policy)
            result.pop("tool_calls", None)
            return result
        finally:
            record["duration_sec"] = round(time.time() - start_ts, 1)
            self._save_conversation(task_id, node.get("id", ""), record)

    def _save_conversation(self, task_id, node_id, record: dict) -> None:
        if not task_id or not node_id:
            return
        try:
            bus = get_bus()
            key = f"task:log:{task_id}:{node_id}"
            logs = bus.get(key) or []
            logs.append(record)
            # cap transcript size: full file contents can be large
            bus.set(key, logs[-10:])
        except Exception:
            pass

    def _record_llm_usage(self, model_name: str, response, task_id: str | None = None) -> None:
        usage = getattr(response, "usage_metadata", None) or {}
        prompt_t = int(usage.get("input_tokens") or 0)
        completion_t = int(usage.get("output_tokens") or 0)
        if not prompt_t and not completion_t:
            content = getattr(response, "content", "") or ""
            completion_t = max(1, len(str(content)) // 4)
        if self._model_pool:
            self._model_pool.record_usage(model_name, prompt_t, completion_t)
        if task_id:
            self._task_tokens[task_id] = self._task_tokens.get(task_id, 0) + prompt_t + completion_t

    # ---------- helpers ----------

    def _upstream_context(self, task_id, node) -> str:
        graph = self._load_graph(task_id)
        if not graph:
            return ""
        node_map = {n["id"]: n for n in graph["nodes"]}
        deps = [e[0] for e in graph["edges"] if e[1] == node.get("id")]
        lines = []
        for dep in deps:
            d = node_map.get(dep)
            if d and d.get("status") == TaskStatus.COMPLETED.value:
                result = d.get("result") or {}
                summary = result.get("summary", "") if isinstance(result, dict) else str(result)
                changes = result.get("changes", []) if isinstance(result, dict) else []
                lines.append(f"- [{d.get('name', dep)}] {summary}" + (f"（变更: {', '.join(changes[:5])}）" if changes else ""))
        return "\n".join(lines)

    def _workspace_listing(self, workspace: str, limit: int = 50) -> list[str]:
        from src.shared.tools import list_files

        try:
            return list_files(workspace, limit=limit)
        except Exception:
            return []

    def _git_commit(self, task_id, workspace, changes: list[str]) -> dict | None:
        if not git_tool.is_git_repo(workspace):
            return None
        branch = f"coteam/task-{task_id}"
        if not git_tool.ensure_branch(workspace, branch):
            return None
        commit = git_tool.commit_changes(workspace, f"coteam: task {task_id} auto-commit", paths=changes)
        return {"branch": branch, "commit": commit} if commit else {"branch": branch, "commit": None}

    def _collect_changes(self, nodes) -> list[str]:
        all_changes = []
        for n in nodes:
            result = n.get("result")
            if isinstance(result, dict):
                all_changes.extend(result.get("changes", []))
        return list(dict.fromkeys(all_changes))

    def _node_status(self, task_id, node_id) -> str:
        graph = self._load_graph(task_id)
        if not graph:
            return TaskStatus.PENDING.value
        for n in graph["nodes"]:
            if n["id"] == node_id:
                return n.get("status", TaskStatus.PENDING.value)
        return TaskStatus.PENDING.value

    def _set_node_status(self, task_id, node_map, node_id, status, error: str = "") -> None:
        node = node_map.get(node_id)
        if not node:
            return
        node["status"] = status
        node["error"] = error
        self._persist_node_result(task_id, node, node.get("result"))
        if status == TaskStatus.CANCELLED.value:
            self._progress("node_cancelled", {"task_id": task_id, "node_id": node_id, "name": node.get("name", "")})

    def _cancel_downstream(self, task_id, node_map, upstream, failed_id) -> None:
        changed = True
        while changed:
            changed = False
            for nid, deps in upstream.items():
                if nid == failed_id:
                    continue
                if self._node_status(task_id, nid) == TaskStatus.PENDING.value and any(
                    self._node_status(task_id, d) == TaskStatus.CANCELLED.value or d == failed_id for d in deps
                ):
                    if all(self._node_status(task_id, d) in (TaskStatus.FAILED.value, TaskStatus.CANCELLED.value) for d in deps if d != failed_id) or failed_id in deps:
                        self._set_node_status(task_id, node_map, nid, TaskStatus.CANCELLED.value, "upstream failed")
                        changed = True

    def _is_cancelled(self, task_id) -> bool:
        return bool(get_bus().get(f"task:cancel:{task_id}"))

    def _persist(self, task_id, nodes, edges, workspace, status) -> None:
        with self._graph_lock:
            save_task_graph(
                task_id,
                [TaskNode(**n) for n in nodes],
                edges,
                meta={"workspace": workspace, "status": status},
            )

    def _persist_running(self, task_id, node) -> None:
        graph = self._load_graph(task_id)
        if not graph:
            return
        for n in graph["nodes"]:
            if n["id"] == node["id"]:
                n.update({k: node.get(k) for k in ("status", "error", "retry_count", "result")})
                n["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        get_bus().set(f"task:graph:{task_id}", graph)
        from src.shared.state import EventChannel

        self._progress("task_update", {"task_id": task_id, "node_id": node["id"], "status": node["status"]})

    def _persist_node_result(self, task_id, node, result) -> None:
        graph = self._load_graph(task_id)
        if not graph:
            return
        for n in graph["nodes"]:
            if n["id"] == node["id"]:
                n.update({
                    "status": node.get("status"),
                    "error": node.get("error", ""),
                    "retry_count": node.get("retry_count", 0),
                    "result": result,
                    "needs_human": bool(node.get("needs_human", False)),
                    "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                })
        get_bus().set(f"task:graph:{task_id}", graph)

    def _load_graph(self, task_id):
        return get_task_graph(task_id)

    def register_graph(self, task_id, nodes, edges):
        save_task_graph(task_id, nodes, edges)

    def reload_agents(self, agents_dir: str | None = None) -> list[str]:
        """Plugin hot-reload (阶段一: 动态热加载)."""
        directory = agents_dir or self._agents_dir
        self._plugins = discover_plugins(directory)
        self._router = Router(self._plugins, DEFAULT_RULES, llm_router=self._llm_router)
        return list(self._plugins.keys())

    @staticmethod
    def _strip_code_fence(content: str) -> str:
        content = content.strip()
        if content.startswith("```"):
            content = "\n".join(l for l in content.split("\n") if not l.strip().startswith("```"))
        return content.strip()

    @staticmethod
    def _extract_json(content: str) -> dict | None:
        match = re.search(r"\{.*\}", content, re.DOTALL)
        try:
            return json.loads(match.group(0) if match else content)
        except Exception:
            return None
