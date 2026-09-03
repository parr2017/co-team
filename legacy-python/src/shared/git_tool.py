import subprocess
from pathlib import Path


def _git(workspace: str, *args: str, timeout: int = 30) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=workspace,
            capture_output=True,
            text=True,
            timeout=timeout,
            encoding="utf-8",
            errors="replace",
        )
        return proc.returncode, (proc.stdout or "") + (proc.stderr or "")
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as e:
        return -1, str(e)


def is_git_repo(workspace: str) -> bool:
    code, _ = _git(workspace, "rev-parse", "--is-inside-work-tree")
    return code == 0


def ensure_branch(workspace: str, branch: str) -> bool:
    """Create (or reuse) a task branch without touching uncommitted user work."""
    code, _ = _git(workspace, "rev-parse", "--verify", branch)
    if code == 0:
        return True
    code, out = _git(workspace, "checkout", "-b", branch)
    return code == 0


def commit_changes(workspace: str, message: str, paths: list[str] | None = None) -> str | None:
    """Stage the given paths (or all changes) and commit. Returns commit hash or None."""
    if paths:
        for p in paths:
            _git(workspace, "add", "--", p)
    else:
        _git(workspace, "add", "-A")
    code, out = _git(workspace, "commit", "-m", message)
    if code != 0:
        # "nothing to commit" is not a failure worth surfacing
        if "nothing to commit" in out:
            return None
        return None
    code, out = _git(workspace, "rev-parse", "HEAD")
    return out.strip() if code == 0 else None
