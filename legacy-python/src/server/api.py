import asyncio
import os
import sys
import threading
import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import yaml
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from src.main.orchestrator import Orchestrator
from src.main.scheduler import ModelPool
from src.shared.sandbox import PermissionPolicy
from src.shared.state import EventChannel, TaskNode, get_task_graph, save_task_graph
from src.shared.transport import get_bus, init_bus


class TaskRequest(BaseModel):
    description: str = ""
    request: str = ""
    workspace: str = "."
    auto_run: bool = True

    @property
    def task_text(self) -> str:
        return self.description or self.request


BASE_DIR = Path(__file__).parent.parent.parent
orchestrator: Orchestrator | None = None
model_pool: ModelPool | None = None


def load_config() -> dict:
    config_path = BASE_DIR / "config" / "config.yaml"
    if config_path.exists():
        with open(config_path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f.read()) or {}
    return {}


@asynccontextmanager
async def lifespan(application: FastAPI):
    global orchestrator, model_pool
    config = load_config()
    init_bus(**config.get("redis", {}))
    model_pool = ModelPool(config.get("model_pool", []))
    agents_dir = config.get("agents_dir", "./agents")
    if not os.path.isabs(agents_dir):
        agents_dir = str(BASE_DIR / agents_dir)
    orchestrator = Orchestrator(
        agents_dir=agents_dir,
        model_pool=model_pool,
        max_retries=config.get("orchestrator", {}).get("max_retries", 3),
        permission_policy=PermissionPolicy.from_config(config),
        orchestrator_config=config.get("orchestrator", {}),
    )
    yield


app = FastAPI(title="Co-Team API", version="0.2.0", lifespan=lifespan)


@app.get("/")
async def index():
    dash = BASE_DIR / "src" / "server" / "dashboard" / "index.html"
    if dash.exists():
        content = dash.read_text(encoding="utf-8")
        return Response(content=content, media_type="text/html; charset=utf-8")
    return Response(content="<h1>Co-Team</h1>", media_type="text/html; charset=utf-8")


def _agents_dir_abs() -> str:
    config = load_config()
    agents_dir = config.get("agents_dir", "./agents")
    if not os.path.isabs(agents_dir):
        agents_dir = str(BASE_DIR / agents_dir)
    return agents_dir


def _run_in_background(task_id: str, workspace: str) -> None:
    def worker():
        try:
            orchestrator.execute(task_id, workspace)
        except Exception as e:
            get_bus().set(f"task:graph:{task_id}:bg_error", {"error": str(e)[:500]})

    threading.Thread(target=worker, daemon=True).start()


def _validate_workspace(workspace: str) -> str:
    """Reject relative paths: they resolve against the server cwd, which is
    rarely what the caller (e.g. dashboard) means, and may be the server itself."""
    ws = (workspace or "").strip().strip('"')
    if not ws:
        raise HTTPException(status_code=400, detail="workspace is required")
    p = Path(ws)
    if not p.is_absolute():
        raise HTTPException(status_code=400, detail=f"workspace must be an absolute path, got: {ws}")
    return str(p)


@app.get("/api/fs")
async def fs_list(path: str = "") -> dict:
    """Directory browser for the dashboard workspace picker."""
    query = (path or "").strip()
    if not query:
        home = str(Path.home())
        drives = []
        if os.name == "nt":
            import string

            for letter in string.ascii_uppercase:
                drive = f"{letter}:\\"
                if Path(drive).exists():
                    drives.append({"name": drive, "path": drive})
        return {"path": "", "parent": None, "dirs": drives, "shortcuts": [{"name": "主目录", "path": home}]}

    p = Path(query)
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"path not found: {query}")
    if p.is_file():
        p = p.parent
    dirs = []
    try:
        for child in sorted(p.iterdir(), key=lambda c: c.name.lower()):
            if child.is_dir():
                name = child.name
                if name.startswith((".", "$")):
                    continue
                dirs.append({"name": name, "path": str(child)})
            if len(dirs) >= 300:
                break
    except PermissionError:
        pass
    parent = str(p.parent) if p.parent != p else None
    return {"path": str(p), "parent": parent, "dirs": dirs, "shortcuts": []}


@app.get("/api/tasks/{task_id}/logs")
async def task_logs(task_id: str) -> dict:
    """Per-node LLM conversation transcripts for replay in the dashboard."""
    bus = get_bus()
    logs = {}
    for key in bus.keys(f"task:log:{task_id}:*"):
        node_id = key.rsplit(":", 1)[-1]
        logs[node_id] = bus.get(key) or []
    return {"task_id": task_id, "logs": logs}


@app.post("/api/tasks")
async def create_task(req: TaskRequest):
    if not orchestrator:
        raise HTTPException(status_code=503, detail="orchestrator not ready")
    if not req.task_text:
        raise HTTPException(status_code=400, detail="description is required")
    workspace = _validate_workspace(req.workspace)
    nodes = orchestrator.plan(req.task_text)
    task_id = str(uuid.uuid4())[:8]
    task_nodes = [TaskNode(**n) for n in nodes["nodes"]]
    save_task_graph(task_id, task_nodes, nodes["edges"], meta={
        "description": req.task_text,
        "workspace": workspace,
        "status": "pending",
    })
    if req.auto_run:
        _run_in_background(task_id, workspace)
    return {"status": "created", "task_id": task_id, "graph": nodes, "auto_run": req.auto_run}


@app.post("/api/tasks/{task_id}/execute")
async def execute_task(task_id: str, workspace: str | None = None):
    graph = get_task_graph(task_id)
    if not graph:
        raise HTTPException(status_code=404, detail="task not found")
    ws = _validate_workspace(workspace or graph.get("workspace") or ".")
    _run_in_background(task_id, ws)
    return {"status": "started", "task_id": task_id, "workspace": ws}


@app.post("/api/tasks/{task_id}/cancel")
async def cancel_task(task_id: str):
    graph = get_task_graph(task_id)
    if not graph:
        raise HTTPException(status_code=404, detail="task not found")
    get_bus().set(f"task:cancel:{task_id}", True)
    return {"status": "cancelling", "task_id": task_id}


@app.post("/api/tasks/{task_id}/approve/{node_id}")
async def approve_node(task_id: str, node_id: str):
    graph = get_task_graph(task_id)
    if not graph:
        raise HTTPException(status_code=404, detail="task not found")
    approvals = get_bus().get(f"task:approvals:{task_id}") or []
    if node_id not in approvals:
        approvals.append(node_id)
        get_bus().set(f"task:approvals:{task_id}", approvals)
    ws = graph.get("workspace") or "."
    _run_in_background(task_id, ws)
    return {"status": "approved", "task_id": task_id, "node_id": node_id}


@app.get("/api/tasks/{task_id}")
async def get_task(task_id: str) -> dict:
    graph = get_task_graph(task_id)
    if not graph:
        raise HTTPException(status_code=404, detail="task not found")
    return graph


@app.get("/api/tasks")
async def list_tasks() -> dict:
    bus = get_bus()
    keys = bus.keys("task:graph:*")
    task_ids = [k.replace("task:graph:", "") for k in keys if ":bg_error" not in k]
    tasks = []
    for tid in task_ids:
        g = get_task_graph(tid)
        if g:
            tasks.append({
                "id": tid,
                "description": g.get("description", ""),
                "workspace": g.get("workspace", ""),
                "status": g.get("status", "pending"),
                "nodes": g.get("nodes", []),
                "edges": g.get("edges", []),
                "updated_at": g.get("updated_at", ""),
            })
    tasks.sort(key=lambda t: t.get("updated_at") or "", reverse=True)
    return {"tasks": tasks}


@app.get("/api/agents")
async def list_agents() -> dict:
    if not orchestrator:
        return {"agents": []}
    plugins = orchestrator._router.get_available()
    return {
        "agents": [
            {
                "name": p.name,
                "role": p.role,
                "description": p.description,
                "tags": p.tags,
                "model_override": p.model_override,
                "timeout": p.timeout,
            }
            for p in plugins.values()
        ]
    }


@app.post("/api/agents/reload")
async def reload_agents() -> dict:
    if not orchestrator:
        raise HTTPException(status_code=503, detail="orchestrator not ready")
    names = orchestrator.reload_agents(_agents_dir_abs())
    return {"status": "reloaded", "agents": names}


@app.get("/api/status")
async def status() -> dict:
    pool_status = model_pool.get_status() if model_pool else {}
    return {
        "status": "running",
        "time": datetime.now().isoformat(),
        "model_pool": pool_status,
        "agents_dir": _agents_dir_abs(),
        "tokens_total": model_pool.total_tokens() if model_pool else 0,
        "cost_total": model_pool.total_cost() if model_pool else 0.0,
    }


@app.get("/api/metrics")
async def metrics() -> dict:
    """阶段五: 性能指标 — token 消耗、成功率、Agent 负载。"""
    bus = get_bus()
    agent_stats: dict[str, dict] = {}
    tasks_total = 0
    tasks_success = 0
    for key in bus.keys("task:graph:*"):
        if ":bg_error" in key:
            continue
        g = bus.get(key)
        if not g:
            continue
        tasks_total += 1
        if g.get("status") == "success":
            tasks_success += 1
        for n in g.get("nodes", []):
            agent = n.get("agent") or "unknown"
            stat = agent_stats.setdefault(agent, {"tasks": 0, "completed": 0, "failed": 0, "retries": 0, "tokens": 0})
            stat["tasks"] += 1
            if n.get("status") == "completed":
                stat["completed"] += 1
            elif n.get("status") == "failed":
                stat["failed"] += 1
            stat["retries"] += int(n.get("retry_count") or 0)
            result = n.get("result")
            if isinstance(result, dict):
                stat["tokens"] += int(result.get("tokens", 0))
    return {
        "tasks": {"total": tasks_total, "success": tasks_success, "success_rate": round(tasks_success / tasks_total, 3) if tasks_total else 0.0},
        "agents": agent_stats,
        "model_pool": model_pool.get_status() if model_pool else {},
        "token_usage": {name: usage for name, usage in (model_pool._usage.items() if model_pool else [])},
        "tokens_total": model_pool.total_tokens() if model_pool else 0,
        "cost_total": model_pool.total_cost() if model_pool else 0.0,
    }


@app.websocket("/ws/events")
async def websocket_events(websocket: WebSocket):
    await websocket.accept()
    bus = get_bus()
    pubsub = bus.subscribe(EventChannel.DASHBOARD)
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def reader():
        try:
            for message in pubsub.listen():
                if message["type"] == "message":
                    loop.call_soon_threadsafe(queue.put_nowait, message["data"])
        except Exception:
            pass

    # pubsub.listen() is a blocking infinite generator; it must not run on the event loop
    threading.Thread(target=reader, daemon=True).start()
    try:
        while True:
            try:
                data = await asyncio.wait_for(queue.get(), timeout=15)
            except asyncio.TimeoutError:
                await websocket.send_text('{"type":"ping"}')
                continue
            await websocket.send_text(data)
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        pubsub.close()
