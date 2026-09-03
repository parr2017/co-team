import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.shared.transport import MemoryBus


def test_memory_bus_persists_across_instances():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "state.json")

        bus1 = MemoryBus(persist_path=path)
        bus1.set("task:graph:abc", {"nodes": [1, 2], "status": "success"})
        bus1.set("ephemeral", "x", ttl=1)
        bus1.flush()
        bus1.close()

        bus2 = MemoryBus(persist_path=path)
        assert bus2.get("task:graph:abc") == {"nodes": [1, 2], "status": "success"}
        assert bus2.get("ephemeral") == "x"


def test_memory_bus_basic_ops():
    bus = MemoryBus()
    bus.queue_push("q", {"a": 1})
    assert bus.queue_pop("q", timeout=1) == {"a": 1}
    assert bus.queue_pop("q", timeout=0) is None
    bus.set("k", {"v": 1})
    assert bus.get("k") == {"v": 1}
    assert bus.keys("k*") == ["k"]


if __name__ == "__main__":
    test_memory_bus_persists_across_instances(); print("  ✓ test_memory_bus_persists_across_instances")
    test_memory_bus_basic_ops(); print("  ✓ test_memory_bus_basic_ops")
    print("All tests passed!")
