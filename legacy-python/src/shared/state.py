import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any

from .transport import get_bus


class TaskStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    RETRYING = "retrying"
    CANCELLED = "cancelled"
    WAITING_APPROVAL = "waiting_approval"


class EventChannel:
    TASK = "coteam:tasks"
    AGENT = "coteam:agents"
    DASHBOARD = "coteam:dashboard"
    NOTIFY = "coteam:notify"


@dataclass
class TaskNode:
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    task_id: str = ""
    name: str = ""
    status: Any = TaskStatus.PENDING
    agent: str = ""
    result: Any = None
    error: str = ""
    retry_count: int = 0
    complexity: str = "normal"
    requires_approval: bool = False
    needs_human: bool = False
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat())

    def touch(self) -> None:
        self.updated_at = datetime.now().isoformat()

    @property
    def status_str(self) -> str:
        if isinstance(self.status, TaskStatus):
            return self.status.value
        return str(self.status)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "task_id": self.task_id,
            "name": self.name,
            "status": self.status_str,
            "agent": self.agent,
            "result": self.result,
            "error": self.error,
            "retry_count": self.retry_count,
            "complexity": self.complexity,
            "requires_approval": self.requires_approval,
            "needs_human": self.needs_human,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "TaskNode":
        allowed = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in d.items() if k in allowed})


def emit_event(channel: str, event_type: str, payload: dict) -> None:
    bus = get_bus()
    event = {
        "type": event_type,
        "ts": datetime.now().isoformat(),
        "payload": payload,
    }
    bus.publish(channel, event)


def save_node(node: TaskNode) -> None:
    bus = get_bus()
    bus.set(f"task:node:{node.id}", node.to_dict())
    emit_event(EventChannel.TASK, "task_update", node.to_dict())


def get_node(node_id: str) -> TaskNode | None:
    bus = get_bus()
    data = bus.get(f"task:node:{node_id}")
    if data is None:
        return None
    return TaskNode.from_dict(data)


def save_task_graph(task_id: str, nodes: list[TaskNode], edges: list[tuple[str, str]], meta: dict | None = None) -> None:
    bus = get_bus()
    existing = get_task_graph(task_id) or {}
    graph = {
        "task_id": task_id,
        "nodes": [n.to_dict() if hasattr(n, "to_dict") else n for n in nodes],
        "edges": [list(e) for e in edges],
        "description": (meta or {}).get("description", existing.get("description", "")),
        "workspace": (meta or {}).get("workspace", existing.get("workspace", "")),
        "status": (meta or {}).get("status", existing.get("status", "pending")),
        "created_at": existing.get("created_at", datetime.now().isoformat()),
        "updated_at": datetime.now().isoformat(),
    }
    bus.set(f"task:graph:{task_id}", graph)


def get_task_graph(task_id: str) -> dict | None:
    bus = get_bus()
    return bus.get(f"task:graph:{task_id}")


MEMORY_KEY = "coteam:memory:lessons"


def add_memory(lesson: str, max_items: int = 20) -> None:
    """Cross-task memory: keep the most recent lessons for future planning."""
    if not lesson:
        return
    bus = get_bus()
    lessons = bus.get(MEMORY_KEY) or []
    lessons.append({"ts": datetime.now().isoformat(), "lesson": lesson})
    bus.set(MEMORY_KEY, lessons[-max_items:])


def get_memory(limit: int = 10) -> list[str]:
    bus = get_bus()
    lessons = bus.get(MEMORY_KEY) or []
    return [item["lesson"] for item in lessons[-limit:]]
