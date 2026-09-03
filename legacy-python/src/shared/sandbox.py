import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class PermissionPolicy:
    level: str = "normal"
    whitelist_commands: list[str] | None = None
    max_memory_mb: int = 512
    max_time_sec: int = 300

    @classmethod
    def from_config(cls, config: dict | None) -> "PermissionPolicy":
        cfg = (config or {}).get("permissions", {})
        return cls(
            level=cfg.get("level", "normal"),
            whitelist_commands=cfg.get("whitelist_commands"),
            max_time_sec=cfg.get("max_time_sec", 300),
        )

    def can_execute(self, command: str) -> bool:
        if self.whitelist_commands is None:
            return True
        parts = command.strip().split()
        if not parts:
            return False
        return Path(parts[0]).name in self.whitelist_commands


def create_sandbox(workspace: str, policy: PermissionPolicy | None = None) -> str:
    src = Path(workspace)
    if not src.exists():
        src.mkdir(parents=True, exist_ok=True)
    sandbox_dir = Path(tempfile.mkdtemp(prefix="coteam-sbx-"))
    shutil.copytree(src, sandbox_dir, dirs_exist_ok=True, ignore=shutil.ignore_patterns(".git", "__pycache__", "node_modules"))
    return str(sandbox_dir)


def merge_changes(sandbox: str, target: str) -> list[str]:
    changes = []
    src = Path(sandbox)
    dst = Path(target)
    for root, dirs, files in os.walk(src):
        rel = Path(root).relative_to(src)
        dst_dir = dst / rel
        dst_dir.mkdir(parents=True, exist_ok=True)
        for f in files:
            src_file = src / rel / f
            dst_file = dst / rel / f
            if not dst_file.exists() or src_file.stat().st_mtime > dst_file.stat().st_mtime:
                shutil.copy2(src_file, dst_file)
                changes.append(str(rel / f))
    return changes


def cleanup_sandbox(sandbox: str) -> None:
    shutil.rmtree(sandbox, ignore_errors=True)


def write_files(workspace: str, files: list[dict]) -> list[str]:
    """Write agent-produced files into the workspace. Each item: {path, content}."""
    written = []
    base = Path(workspace).resolve()
    for f in files:
        rel = str(f.get("path", "")).strip()
        if not rel:
            continue
        target = (base / rel).resolve()
        if not str(target).startswith(str(base)):
            continue  # refuse path traversal outside workspace
        target.parent.mkdir(parents=True, exist_ok=True)
        content = f.get("content", "")
        if isinstance(content, list):
            content = "\n".join(str(line) for line in content)
        target.write_text(str(content), encoding="utf-8")
        written.append(rel)
    return written


def execute_command(command: str, cwd: str, policy: PermissionPolicy, timeout: int | None = None) -> dict:
    """Run a whitelisted command inside the sandbox with timeout."""
    if not policy.can_execute(command):
        return {"command": command, "allowed": False, "returncode": -1, "stdout": "", "stderr": "command not in whitelist"}
    timeout = timeout or policy.max_time_sec
    try:
        proc = subprocess.run(
            command,
            shell=True,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return {
            "command": command,
            "allowed": True,
            "returncode": proc.returncode,
            "stdout": (proc.stdout or "")[-4000:],
            "stderr": (proc.stderr or "")[-2000:],
        }
    except subprocess.TimeoutExpired:
        return {"command": command, "allowed": True, "returncode": -1, "stdout": "", "stderr": f"timeout after {timeout}s"}
    except Exception as e:
        return {"command": command, "allowed": True, "returncode": -1, "stdout": "", "stderr": str(e)[:500]}
