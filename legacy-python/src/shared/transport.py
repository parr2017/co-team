import atexit
import json
import os
import threading
import time
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Generator

import redis


class MessageBus(ABC):
    @abstractmethod
    def publish(self, channel: str, message: dict) -> None: ...
    @abstractmethod
    def subscribe(self, channel: str): ...
    @abstractmethod
    def queue_push(self, queue: str, task: dict) -> None: ...
    @abstractmethod
    def queue_pop(self, queue: str, timeout: int = 1) -> dict | None: ...
    @abstractmethod
    def get(self, key: str) -> Any | None: ...
    @abstractmethod
    def set(self, key: str, value: Any, ttl: int | None = None) -> None: ...
    @abstractmethod
    def keys(self, pattern: str) -> list[str]: ...
    @abstractmethod
    def close(self) -> None: ...


class RedisBus(MessageBus):
    def __init__(self, host: str = "127.0.0.1", port: int = 6379, db: int = 0):
        self._client = redis.Redis(host=host, port=port, db=db, decode_responses=True)

    def publish(self, channel: str, message: dict) -> None:
        self._client.publish(channel, json.dumps(message, ensure_ascii=False))

    def subscribe(self, channel: str):
        pubsub = self._client.pubsub()
        pubsub.subscribe(channel)
        return pubsub

    def queue_push(self, queue: str, task: dict) -> None:
        self._client.rpush(queue, json.dumps(task, ensure_ascii=False))

    def queue_pop(self, queue: str, timeout: int = 1) -> dict | None:
        result = self._client.blpop(queue, timeout=timeout)
        if result is None:
            return None
        _, data = result
        return json.loads(data)

    def get(self, key: str) -> Any | None:
        val = self._client.get(key)
        if val is None:
            return None
        return json.loads(val)

    def set(self, key: str, value: Any, ttl: int | None = None) -> None:
        serialized = json.dumps(value, ensure_ascii=False)
        if ttl:
            self._client.setex(key, ttl, serialized)
        else:
            self._client.set(key, serialized)

    def keys(self, pattern: str) -> list[str]:
        return list(self._client.keys(pattern))

    def close(self) -> None:
        self._client.close()


class MemoryBus(MessageBus):
    """In-memory fallback when Redis is unavailable. Thread-safe.

    Optionally persists store contents to a JSON file so state survives restarts.
    """

    def __init__(self, persist_path: str | None = None):
        self._store: dict[str, Any] = {}
        self._queues: dict[str, list[dict]] = {}
        self._channels: dict[str, list[dict]] = {}
        self._lock = threading.Lock()
        self._expired: set[str] = set()
        self._ttl_map: dict[str, float] = {}
        self._persist_path = persist_path or os.environ.get("COTEAM_STATE_FILE", "")
        self._dirty = False
        if self._persist_path:
            self._load_persisted()
            atexit.register(self._flush)

    def _load_persisted(self) -> None:
        try:
            if os.path.exists(self._persist_path):
                with open(self._persist_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    now = time.time()
                    for k, v in data.get("store", {}).items():
                        expire_at = data.get("ttl", {}).get(k)
                        if expire_at and now > expire_at:
                            continue
                        self._store[k] = v
                        if expire_at:
                            self._ttl_map[k] = expire_at
        except Exception:
            pass

    def _flush(self) -> None:
        if not self._persist_path:
            return
        with self._lock:
            if not self._dirty:
                return
            snapshot = {"store": dict(self._store), "ttl": dict(self._ttl_map)}
            self._dirty = False
        try:
            os.makedirs(os.path.dirname(self._persist_path) or ".", exist_ok=True)
            tmp = self._persist_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(snapshot, f, ensure_ascii=False)
            os.replace(tmp, self._persist_path)
        except Exception:
            pass

    def flush(self) -> None:
        self._dirty = True
        self._flush()

    def publish(self, channel: str, message: dict) -> None:
        with self._lock:
            if channel not in self._channels:
                self._channels[channel] = []
            self._channels[channel].append(message)

    def subscribe(self, channel: str):
        return _MemoryPubSub(self, channel)

    def queue_push(self, queue: str, task: dict) -> None:
        with self._lock:
            if queue not in self._queues:
                self._queues[queue] = []
            self._queues[queue].append(task)

    def queue_pop(self, queue: str, timeout: int = 1) -> dict | None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                if queue in self._queues and self._queues[queue]:
                    return self._queues[queue].pop(0)
            time.sleep(0.05)
        return None

    def get(self, key: str) -> Any | None:
        with self._lock:
            self._purge_expired(key)
            return self._store.get(key)

    def set(self, key: str, value: Any, ttl: int | None = None) -> None:
        with self._lock:
            self._store[key] = value
            if ttl:
                self._ttl_map[key] = time.time() + ttl
            self._dirty = True

    def keys(self, pattern: str) -> list[str]:
        with self._lock:
            import fnmatch
            return [k for k in self._store.keys() if fnmatch.fnmatch(k, pattern)]

    def close(self) -> None:
        self._flush()

    def _purge_expired(self, key: str) -> None:
        if key in self._ttl_map and time.time() > self._ttl_map[key]:
            self._store.pop(key, None)
            self._ttl_map.pop(key, None)


class _MemoryPubSub:
    def __init__(self, bus: MemoryBus, channel: str):
        self._bus = bus
        self._channel = channel
        self._last_idx = 0

    def listen(self) -> Generator[dict, None, None]:
        while True:
            with self._bus._lock:
                messages = self._bus._channels.get(self._channel, [])
                if len(messages) > self._last_idx:
                    msg = messages[self._last_idx]
                    self._last_idx += 1
                    yield {"type": "message", "data": json.dumps(msg, ensure_ascii=False)}
            time.sleep(0.1)

    def close(self) -> None:
        pass


_bus: MessageBus | None = None


def get_bus() -> MessageBus:
    global _bus
    if _bus is None:
        raise RuntimeError("MessageBus not initialized. Call init_bus() first.")
    return _bus


def init_bus(**kwargs) -> MessageBus:
    global _bus
    try:
        host = kwargs.get("host", "127.0.0.1")
        port = kwargs.get("port", 6379)
        db = kwargs.get("db", 0)
        bus = RedisBus(host=host, port=port, db=db)
        bus.get("__health__")
        _bus = bus
        return bus
    except Exception:
        _bus = MemoryBus()
        return _bus


def shutdown_bus() -> None:
    global _bus
    if _bus:
        _bus.close()
    _bus = None
