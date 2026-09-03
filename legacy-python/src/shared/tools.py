import os
from pathlib import Path

from .sandbox import PermissionPolicy, execute_command, write_files

MAX_FILE_BYTES = 64 * 1024
IGNORED_DIRS = {".git", "__pycache__", "node_modules", ".venv", "venv", ".idea", ".vscode"}


def list_files(workspace: str, limit: int = 200) -> list[str]:
    base = Path(workspace).resolve()
    out = []
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if d not in IGNORED_DIRS]
        for f in files:
            rel = Path(root).relative_to(base) / f
            out.append(str(rel))
            if len(out) >= limit:
                return out
    return out


def read_file(workspace: str, path: str) -> dict:
    base = Path(workspace).resolve()
    target = (base / path).resolve()
    if not str(target).startswith(str(base)):
        return {"ok": False, "error": "path outside workspace"}
    if not target.exists() or not target.is_file():
        return {"ok": False, "error": f"file not found: {path}"}
    try:
        data = target.read_bytes()
        if len(data) > MAX_FILE_BYTES:
            return {"ok": False, "error": f"file too large: {len(data)} bytes"}
        return {"ok": True, "path": path, "content": data.decode("utf-8", errors="replace")}
    except OSError as e:
        return {"ok": False, "error": str(e)[:200]}


def apply_tool_calls(workspace: str, tool_calls: list[dict], policy: PermissionPolicy) -> list[dict]:
    """Execute tools an agent requested during its run. Only read tools run mid-conversation;
    writes and shell commands are applied by the orchestrator after the final answer."""
    results = []
    for call in tool_calls or []:
        name = str(call.get("tool", "")).lower()
        if name in ("list_files", "list", "ls"):
            results.append({"tool": "list_files", "files": list_files(workspace)})
        elif name in ("read_file", "read"):
            res = read_file(workspace, str(call.get("path", "")))
            results.append({"tool": "read_file", **res})
        else:
            results.append({"tool": name, "ok": False, "error": f"tool '{name}' not allowed mid-run"})
    return results


def apply_final_output(workspace: str, output: dict, policy: PermissionPolicy) -> dict:
    """Apply an agent's final output: write files, run whitelisted commands.
    Mutates output: fills changes with actually-written paths and command results."""
    files = output.get("files") or []
    written = write_files(workspace, files)

    commands = output.get("commands") or []
    command_results = [execute_command(str(c), workspace, policy) for c in commands]

    declared = output.get("changes") or []
    merged = list(dict.fromkeys(written + [str(c) for c in declared]))
    output["changes"] = merged
    output["command_results"] = [
        {"command": c["command"], "returncode": c["returncode"], "stderr": c["stderr"][-500:]}
        for c in command_results
    ]
    if command_results and any(c["returncode"] not in (0, None) for c in command_results):
        failed = [c for c in command_results if c["returncode"] not in (0, None)]
        output["errors"] = list(output.get("errors") or []) + [
            f"command failed: {c['command']}: {c['stderr'][-200:]}" for c in failed
        ]
    return output
