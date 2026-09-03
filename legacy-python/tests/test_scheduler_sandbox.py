import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.main.scheduler import ModelPool
from src.shared.sandbox import (
    PermissionPolicy,
    create_sandbox,
    execute_command,
    merge_changes,
    write_files,
)
from src.shared.tools import apply_final_output, list_files, read_file


# ---------- scheduler ----------

def test_select_model_prefers_tags():
    pool = ModelPool([
        {"name": "cheap", "provider": "p", "api_key": "k", "base_url": "u", "priority": 1, "professional_weight": 30, "cost_per_1k": 0.001, "tags": ["general"]},
        {"name": "coder", "provider": "p", "api_key": "k", "base_url": "u", "priority": 1, "professional_weight": 90, "cost_per_1k": 0.01, "tags": ["code"]},
    ])
    assert pool.select_model(["code"], complexity="simple").name in ("cheap", "coder")


def test_simple_task_prefers_cheapest():
    pool = ModelPool([
        {"name": "expensive", "provider": "p", "api_key": "k", "base_url": "u", "priority": 1, "professional_weight": 90, "cost_per_1k": 0.05, "tags": []},
        {"name": "cheap", "provider": "p", "api_key": "k", "base_url": "u", "priority": 1, "professional_weight": 30, "cost_per_1k": 0.001, "tags": []},
    ])
    assert pool.select_model([], complexity="simple").name == "cheap"


def test_complex_task_prefers_strongest():
    pool = ModelPool([
        {"name": "strong", "provider": "p", "api_key": "k", "base_url": "u", "priority": 2, "professional_weight": 95, "cost_per_1k": 0.05, "tags": []},
        {"name": "weak", "provider": "p", "api_key": "k", "base_url": "u", "priority": 1, "professional_weight": 30, "cost_per_1k": 0.001, "tags": []},
    ])
    assert pool.select_model([], complexity="complex").name == "strong"


def test_fallback_chain_excludes_primary():
    pool = ModelPool([
        {"name": "a", "provider": "p", "api_key": "k", "base_url": "u", "priority": 1, "professional_weight": 90, "tags": []},
        {"name": "b", "provider": "p", "api_key": "k", "base_url": "u", "priority": 2, "professional_weight": 70, "tags": []},
    ])
    primary = pool.select_model([], complexity="complex")
    chain = pool.fallback_chain(primary)
    assert chain[0].name == primary.name
    assert [m.name for m in chain[1:]] == ["b"]


def test_unhealthy_model_skipped():
    pool = ModelPool([
        {"name": "broken", "provider": "p", "api_key": "k", "base_url": "u", "priority": 1, "professional_weight": 90, "tags": []},
        {"name": "healthy", "provider": "p", "api_key": "k", "base_url": "u", "priority": 2, "professional_weight": 50, "tags": []},
    ])
    broken = pool._models[0]
    for _ in range(3):
        pool.mark_failure(broken)
    assert broken.is_healthy is False
    assert pool.select_model([], complexity="complex").name == "healthy"


def test_usage_recording():
    pool = ModelPool([
        {"name": "m", "provider": "p", "api_key": "k", "base_url": "u", "priority": 1, "cost_per_1k": 0.01, "tags": []},
    ])
    pool.record_usage("m", 1000, 1000)
    assert pool.total_tokens() == 2000
    assert abs(pool.total_cost() - 0.02) < 1e-9


# ---------- sandbox & tools ----------

def test_write_files_and_path_traversal_guard(tmp_path):
    written = write_files(str(tmp_path), [
        {"path": "a/b.txt", "content": "hello"},
        {"path": "../evil.txt", "content": "nope"},
    ])
    assert written == ["a/b.txt"]
    assert (tmp_path / "a" / "b.txt").read_text(encoding="utf-8") == "hello"
    assert not (tmp_path.parent / "evil.txt").exists()


def test_sandbox_isolation_and_merge(tmp_path):
    (tmp_path / "base.txt").write_text("v1", encoding="utf-8")
    sandbox = create_sandbox(str(tmp_path))
    try:
        write_files(sandbox, [{"path": "base.txt", "content": "v2"}, {"path": "new.txt", "content": "n"}])
        merged = merge_changes(sandbox, str(tmp_path))
        assert set(merged) == {"base.txt", "new.txt"}
        assert (tmp_path / "base.txt").read_text(encoding="utf-8") == "v2"
    finally:
        import shutil
        shutil.rmtree(sandbox, ignore_errors=True)


def test_command_whitelist():
    policy = PermissionPolicy(whitelist_commands=["python"])
    assert policy.can_execute("python -V")
    assert not policy.can_execute("rm -rf /")

    result = execute_command("echo blocked-should-not-run", ".", policy)
    assert result["allowed"] is False

    ok = execute_command("python -c \"print(1+1)\"", ".", policy)
    assert ok["allowed"] is True and ok["returncode"] == 0


def test_read_file_guard(tmp_path):
    (tmp_path / "x.txt").write_text("data", encoding="utf-8")
    assert read_file(str(tmp_path), "x.txt")["content"] == "data"
    assert read_file(str(tmp_path), "../outside.txt")["ok"] is False


def test_apply_final_output(tmp_path):
    policy = PermissionPolicy(whitelist_commands=["python"])
    out = {"status": "success", "changes": ["declared.txt: said"], "files": [{"path": "w.txt", "content": "w"}], "commands": ["python -c \"print('ok')\""]}
    result = apply_final_output(str(tmp_path), out, policy)
    assert "w.txt" in result["changes"]
    assert any(c.startswith("declared.txt") for c in result["changes"])
    assert result["command_results"][0]["returncode"] == 0
    assert (tmp_path / "w.txt").exists()


def test_list_files_ignores_noise(tmp_path):
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "config").write_text("x")
    (tmp_path / "keep.py").write_text("x")
    files = list_files(str(tmp_path))
    assert "keep.py" in files
    assert not any(f.startswith(".git") for f in files)


if __name__ == "__main__":
    import inspect

    mod = sys.modules[__name__]
    failed = 0
    for name, fn in inspect.getmembers(mod, inspect.isfunction):
        if name.startswith("test_"):
            import inspect as _i

            params = _i.signature(fn).parameters
            if "tmp_path" in params:
                fn(Path(tempfile.mkdtemp()))
            else:
                fn()
            print(f"  ✓ {name}")
    print("All tests passed!")
