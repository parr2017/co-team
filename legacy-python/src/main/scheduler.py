import random
import threading
import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ModelEntry:
    name: str
    provider: str
    api_key: str
    base_url: str
    concurrency: int = 4
    professional_weight: int = 50
    priority: int = 1
    tags: list[str] = field(default_factory=list)
    cost_per_1k: float = 0.0
    _active_slots: int = 0
    _fail_count: int = 0
    _last_failure_ts: float = 0.0

    @property
    def available_slots(self) -> int:
        return max(0, self.concurrency - self._active_slots)

    def acquire_slot(self) -> bool:
        if self.available_slots <= 0:
            return False
        self._active_slots += 1
        return True

    def release_slot(self) -> None:
        self._active_slots = max(0, self._active_slots - 1)

    @property
    def is_healthy(self) -> bool:
        # a model that failed recently is skipped for a cool-down window
        return self._fail_count < 3 or time.time() - self._last_failure_ts > 60


class ModelPool:
    def __init__(self, models: list[dict]):
        self._models: list[ModelEntry] = [ModelEntry(**m) for m in models]
        self._lock = threading.Lock()
        self._usage: dict[str, dict[str, float]] = {}

    def select_model(self, task_tags: list[str] | None = None, complexity: str = "normal") -> ModelEntry | None:
        """Pick a model by tags, health and task complexity.

        simple  -> prefer cheapest healthy model (cost optimization)
        normal  -> priority + professional weight
        complex -> strongest model by professional_weight
        """
        candidates = [m for m in self._filter_by_tags(task_tags) if m.is_healthy]
        available = [m for m in candidates if m.available_slots > 0]
        if not available:
            available = [m for m in self._models if m.is_healthy and m.available_slots > 0]
        if not available:
            return None

        if complexity == "simple":
            return min(available, key=lambda m: (m.priority, m.cost_per_1k))
        if complexity == "complex":
            return max(available, key=lambda m: (m.professional_weight, -m.priority))

        available.sort(key=lambda m: (m.priority, -m.professional_weight))
        top_n = available[: max(3, len(available) // 2)]
        weights = [m.professional_weight for m in top_n]
        return random.choices(top_n, weights=weights, k=1)[0]

    def fallback_chain(self, primary: ModelEntry, task_tags: list[str] | None = None) -> list[ModelEntry]:
        """Ordered degradation list: primary first, then remaining healthy models by priority."""
        candidates = [m for m in self._models if m.is_healthy and m.name != primary.name]
        candidates.sort(key=lambda m: (m.priority, -m.professional_weight))
        return [primary] + candidates

    def mark_failure(self, model: ModelEntry) -> None:
        model._fail_count += 1
        model._last_failure_ts = time.time()

    def mark_success(self, model: ModelEntry) -> None:
        model._fail_count = 0

    def record_usage(self, model_name: str, prompt_tokens: int, completion_tokens: int) -> None:
        entry = next((m for m in self._models if m.name == model_name), None)
        cost = 0.0
        if entry:
            cost = (prompt_tokens + completion_tokens) / 1000.0 * entry.cost_per_1k
        with self._lock:
            u = self._usage.setdefault(model_name, {"prompt_tokens": 0, "completion_tokens": 0, "calls": 0, "cost": 0.0})
            u["prompt_tokens"] += prompt_tokens
            u["completion_tokens"] += completion_tokens
            u["calls"] += 1
            u["cost"] = round(u["cost"] + cost, 6)

    def total_tokens(self) -> int:
        with self._lock:
            return int(sum(u["prompt_tokens"] + u["completion_tokens"] for u in self._usage.values()))

    def total_cost(self) -> float:
        with self._lock:
            return round(sum(u["cost"] for u in self._usage.values()), 6)

    def get_max_concurrent(self, task_tags: list[str] | None = None) -> int:
        candidates = self._filter_by_tags(task_tags)
        return sum(m.available_slots for m in candidates)

    def _filter_by_tags(self, tags: list[str] | None) -> list[ModelEntry]:
        if not tags:
            return list(self._models)
        tag_set = set(t.lower() for t in tags)
        matched = [m for m in self._models if set(t.lower() for t in m.tags) & tag_set]
        return matched if matched else list(self._models)

    def get_total_available(self) -> int:
        return sum(m.available_slots for m in self._models)

    def get_status(self) -> dict[str, Any]:
        return {
            m.name: {
                "concurrency": m.concurrency,
                "active": m._active_slots,
                "available": m.available_slots,
                "priority": m.priority,
                "tags": m.tags,
                "healthy": m.is_healthy,
                "cost_per_1k": m.cost_per_1k,
            }
            for m in self._models
        }
