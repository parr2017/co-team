#!/usr/bin/env python3
"""bg-shell: detached background command runner with uuid-keyed log tracking.

No daemon, no keeper. Each `run` spawns a shell wrapper that redirects its own
output to a log file and writes its exit code to a marker file, then the parent
process exits immediately. Queries are pure file reads + cheap pid liveness checks.
"""
from __future__ import annotations

import argparse
import ctypes
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid as _uuid
from pathlib import Path

try:
    import psutil
except Exception:
    psutil = None

UUID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
LOG_MAX_BYTES = 5 * 1024 * 1024
LOG_TAIL_KEEP = 1 * 1024 * 1024
DEFAULT_KEEP_HOURS = 24.0
SPAWN_PROBE = 0.5
PID_TIME_TOL = 5.0

WINDOWS = os.name == "nt"
if WINDOWS:
    CREATE_NEW_PROCESS_GROUP = 0x00000200
    CREATE_NO_WINDOW = 0x08000000
    SPAWN_FLAGS = CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
else:
    SPAWN_FLAGS = 0


# ── State directory ──────────────────────────────────────────────────────────


def state_dir() -> Path:
    base = os.environ.get("BG_SHELL_HOME")
    if base:
        root = Path(base)
    elif WINDOWS and os.environ.get("LOCALAPPDATA"):
        root = Path(os.environ["LOCALAPPDATA"]) / "bg-shell"
    else:
        root = Path.home() / ".bg-shell"
    for sub in ("logs", "meta", "exits", "run"):
        (root / sub).mkdir(parents=True, exist_ok=True)
    return root


# ── Meta helpers ─────────────────────────────────────────────────────────────


def _meta_path(root: Path, uuid: str) -> Path:
    return root / "meta" / f"{uuid}.json"


def _log_path(root: Path, uuid: str) -> Path:
    return root / "logs" / f"{uuid}.log"


def _exit_path(root: Path, uuid: str) -> Path:
    return root / "exits" / f"{uuid}.txt"


def _script_path(root: Path, uuid: str, shell: str) -> Path:
    ext = {"cmd": ".bat", "powershell": ".ps1", "bash": ".sh"}[shell]
    return root / "run" / f"{uuid}{ext}"


def load_meta(root: Path, uuid: str) -> dict | None:
    p = _meta_path(root, uuid)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text("utf-8"))
    except Exception:
        return None


def save_meta(root: Path, meta: dict) -> None:
    _meta_path(root, meta["uuid"]).write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), "utf-8"
    )


def load_all_metas(root: Path) -> list[dict]:
    metas = []
    for f in (root / "meta").glob("*.json"):
        try:
            metas.append(json.loads(f.read_text("utf-8")))
        except Exception:
            pass
    metas.sort(key=lambda m: m.get("started_epoch", 0), reverse=True)
    return metas


def now_epoch() -> float:
    return time.time()


def now_iso() -> str:
    return dt.datetime.now().isoformat(timespec="seconds")


def gen_uuid() -> str:
    return _uuid.uuid4().hex[:8]


def resolve_uuid(root: Path, uuid_arg: str) -> tuple[str | None, list[str]]:
    """Exact match or unique prefix match. Returns (resolved_uuid, ambiguities)."""
    if _meta_path(root, uuid_arg).exists():
        return uuid_arg, []
    all_uuids = [m["uuid"] for m in load_all_metas(root)]
    matches = [u for u in all_uuids if u.startswith(uuid_arg)]
    if len(matches) == 1:
        return matches[0], []
    if len(matches) > 1:
        return None, matches
    return None, []


# ── Liveness ─────────────────────────────────────────────────────────────────


def pid_alive(meta: dict) -> bool:
    pid = meta.get("pid")
    if not pid:
        return False
    if psutil is not None:
        try:
            proc = psutil.Process(pid)
            ct = proc.create_time()
            recorded = meta.get("pid_create_time")
            if recorded and abs(ct - recorded) > PID_TIME_TOL:
                return False
            return True
        except psutil.NoSuchProcess:
            return False
        except Exception:
            return True
    if WINDOWS:
        PROCESS_QUERY_LIMITED = 0x1000
        k32 = ctypes.windll.kernel32
        h = k32.OpenProcess(PROCESS_QUERY_LIMITED, False, int(pid))
        if h:
            k32.CloseHandle(h)
            return True
        return ctypes.GetLastError() == 5
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


# ── Exit code ────────────────────────────────────────────────────────────────


def read_exit_code(root: Path, uuid: str) -> int | None:
    p = _exit_path(root, uuid)
    if not p.exists():
        return None
    try:
        raw = p.read_text("utf-8-sig").strip()
        if raw:
            return int(raw)
    except Exception:
        pass
    return None


# ── Reconcile ────────────────────────────────────────────────────────────────


def maybe_truncate_log(log: Path) -> None:
    try:
        size = log.stat().st_size
    except OSError:
        return
    if size <= LOG_MAX_BYTES:
        return
    with log.open("rb") as f:
        f.seek(-LOG_TAIL_KEEP, os.SEEK_END)
        data = f.read()
    nl = data.find(b"\n")
    if nl >= 0:
        data = data[nl + 1 :]
    tmp = log.with_suffix(".tmp")
    tmp.write_bytes(
        b"== bg-shell: log truncated (exceeded 5MB), keeping tail ==\n" + data
    )
    tmp.replace(log)


def reconcile_one(root: Path, meta: dict, truncate: bool = True) -> dict:
    status = meta.get("status", "")
    # Only reconcile "running" entries; non-terminal states unchanged
    if status != "running":
        # Still truncate oversized logs for completed entries
        if truncate and status in ("finished", "failed", "killed", "crashed"):
            maybe_truncate_log(_log_path(root, meta["uuid"]))
        return meta
    if pid_alive(meta):
        return meta
    # Process died — determine exit status
    code = read_exit_code(root, meta["uuid"])
    ended = now_epoch()
    meta["ended_epoch"] = ended
    meta["ended_at"] = now_iso()
    meta["elapsed_seconds"] = round(ended - meta.get("started_epoch", ended), 1)
    if code is None:
        meta["status"] = "crashed"
    else:
        meta["status"] = "finished" if code == 0 else "failed"
        meta["exit_code"] = code
    save_meta(root, meta)
    if truncate:
        maybe_truncate_log(_log_path(root, meta["uuid"]))
    return meta


def reconcile_all(root: Path) -> list[dict]:
    metas = load_all_metas(root)
    changed = False
    for i, m in enumerate(metas):
        new = reconcile_one(root, m)
        metas[i] = new
        if new.get("status") == "running":
            changed = True
    return metas


# ── Kill tree ────────────────────────────────────────────────────────────────


def kill_tree(pid: int) -> list[int]:
    killed = []
    if psutil is not None and pid:
        try:
            parent = psutil.Process(pid)
            procs = [parent] + parent.children(recursive=True)
            for p in procs:
                try:
                    p.kill()
                    killed.append(p.pid)
                except Exception:
                    pass
            psutil.wait_procs(procs, timeout=3)
        except Exception:
            pass
    if WINDOWS and pid:
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            capture_output=True,
        )
    return killed


# ── Shell resolution ─────────────────────────────────────────────────────────


def detect_shell(command: str) -> str:
    low = command.strip().lower()
    if low.endswith(".ps1"):
        return "powershell"
    if low.endswith(".sh") or low.endswith(".bash"):
        return "bash"
    if low.endswith(".bat") or low.endswith(".cmd"):
        return "cmd"
    return "bash" if shutil.which("bash") else "cmd"


def resolve_shell(shell_arg: str | None, command: str) -> tuple[str, str | None]:
    if shell_arg in (None, "auto"):
        name = detect_shell(command)
    else:
        name = shell_arg
    exe = {"cmd": "cmd", "powershell": "powershell", "bash": "bash"}[name]
    path = shutil.which(exe)
    return name, path


# ── Wrapper scripts ──────────────────────────────────────────────────────────


def write_wrapper(root: Path, uuid: str, shell: str, command: str) -> Path:
    script = _script_path(root, uuid, shell)
    if shell == "cmd":
        cmd_line = command.replace("\r\n", " & ").replace("\n", " & ").replace("\r", " & ")
        content = (
            f'@echo off\r\n'
            f'{cmd_line} >>"%BG_LOG%" 2>&1\r\n'
            f'>"%BG_EXIT%" echo %errorlevel%\r\n'
        )
        script.write_text(content, encoding="mbcs", errors="replace")
    elif shell == "powershell":
        content = (
            "$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'\n"
            "& {\n"
            f"{command}\n"
            "} *>> $env:BG_LOG\n"
            "if ($?) { $code = 0 }\n"
            "elseif ($null -ne $LASTEXITCODE) { $code = $LASTEXITCODE }\n"
            "else { $code = 1 }\n"
            "Set-Content -Path $env:BG_EXIT -Value $code -Encoding ascii\n"
            "exit $code\n"
        )
        script.write_text(content, encoding="utf-8-sig")
    else:
        content = (
            "(\n"
            f"{command}\n"
            ") >>\"$BG_LOG\" 2>&1\n"
            "echo $? >\"$BG_EXIT\"\n"
        )
        script.write_text(content, encoding="utf-8")
    return script


# ── Log reading ──────────────────────────────────────────────────────────────


def read_log_text(path: Path) -> str:
    if not path.exists():
        return ""
    data = path.read_bytes()
    if data.startswith(b"\xff\xfe"):
        return data.decode("utf-16-le", errors="replace")
    if data.startswith(b"\xfe\xff"):
        return data.decode("utf-16-be", errors="replace")
    for enc in ("utf-8-sig", "gbk"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            pass
    if WINDOWS:
        try:
            return data.decode("mbcs", errors="replace")
        except Exception:
            pass
    return data.decode("utf-8", errors="replace")


def tail_lines(text: str, n: int) -> list[str]:
    lines = text.splitlines()
    return lines[-n:] if len(lines) > n else lines


def filter_lines(lines: list[str], pattern: str) -> list[str]:
    try:
        rx = re.compile(pattern)
    except re.error:
        return lines
    return [l for l in lines if rx.search(l)]


# ── Output helpers ───────────────────────────────────────────────────────────


def out(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def err(msg: str) -> None:
    out({"status": "error", "error": msg})
    sys.exit(1)


# ── run ──────────────────────────────────────────────────────────────────────


def cmd_run(args) -> None:
    root = state_dir()
    command = (args.cmd or "").strip() or " ".join(getattr(args, "command_pos", []) or []).strip()
    if not command:
        err("empty command")

    uuid = args.uuid or gen_uuid()
    if not UUID_RE.match(uuid):
        err(f"invalid uuid: {uuid} (must match {UUID_RE.pattern})")

    existing = load_meta(root, uuid)
    if existing:
        reconcile_one(root, existing)
        if existing["status"] == "running":
            if args.force:
                kill_tree(existing.get("pid", 0))
                existing["status"] = "killed"
                existing["ended_epoch"] = now_epoch()
                existing["ended_at"] = now_iso()
                save_meta(root, existing)
            else:
                err(f"uuid '{uuid}' is running (pid={existing.get('pid')}); use --force or stop first")
        elif not args.force:
            err(f"uuid '{uuid}' already exists ({existing['status']}); use --force to overwrite")

    shell, shell_path = resolve_shell(args.shell, command)
    if not shell_path:
        err(f"{shell}.exe not found in PATH")

    cwd = args.cwd or os.getcwd()
    if not os.path.isdir(cwd):
        err(f"cwd does not exist: {cwd}")

    log = _log_path(root, uuid)
    exit_file = _exit_path(root, uuid)
    script = write_wrapper(root, uuid, shell, command)

    header = (
        f"== bg-shell =====================================================\n"
        f"== uuid: {uuid}  shell: {shell}\n"
        f"== started: {now_iso()}  cwd: {cwd}\n"
        f"== cmd: {command}\n"
        f"=================================================================\n"
    )
    with log.open("w", encoding="utf-8", errors="replace") as f:
        f.write(header)

    env = os.environ.copy()
    if WINDOWS:
        env["BG_LOG"] = str(log)
        env["BG_EXIT"] = str(exit_file)
    else:
        env["BG_LOG"] = log.as_posix()
        env["BG_EXIT"] = exit_file.as_posix()
    env["BG_UUID"] = uuid

    for kv in args.env or []:
        k, _, v = kv.partition("=")
        if k:
            env[k] = v

    try:
        if shell == "cmd":
            cmd_list = [shell_path, "/d", "/c", str(script)]
        elif shell == "powershell":
            cmd_list = [shell_path, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script)]
        else:
            cmd_list = [shell_path, script.as_posix()]

        kwargs = dict(
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            cwd=cwd,
            env=env,
            close_fds=True,
        )
        if SPAWN_FLAGS:
            kwargs["creationflags"] = SPAWN_FLAGS
        if not WINDOWS:
            kwargs["start_new_session"] = True

        p = subprocess.Popen(cmd_list, **kwargs)
        pid = p.pid
    except Exception as ex:
        err(f"spawn failed: {ex}")

    pid_ct = None
    if psutil is not None:
        try:
            pid_ct = psutil.Process(pid).create_time()
        except Exception:
            pass

    meta = {
        "uuid": uuid,
        "cmd": command,
        "shell": shell,
        "pid": pid,
        "pid_create_time": pid_ct,
        "log": str(log),
        "exit_file": str(exit_file),
        "script": str(script),
        "cwd": cwd,
        "status": "running",
        "exit_code": None,
        "started_at": now_iso(),
        "started_epoch": now_epoch(),
        "ended_at": None,
        "ended_epoch": None,
        "elapsed_seconds": None,
    }
    save_meta(root, meta)

    time.sleep(SPAWN_PROBE)
    reconcile_one(root, meta)

    launched = meta["status"] not in ("crashed",)
    result = {
        "status": "ok" if launched else "error",
        "launched": launched,
        "uuid": uuid,
        "pid": pid,
        "shell": shell,
        "cmd": command,
        "log": str(log),
        "job_status": meta["status"],
        "cwd": cwd,
        "started_at": meta["started_at"],
    }
    if meta["status"] != "running":
        result["exit_code"] = meta.get("exit_code")
    if meta["status"] == "crashed":
        result["error"] = "exited immediately without exit code"
    out(result)
    sys.exit(0 if launched else 1)


# ── log ──────────────────────────────────────────────────────────────────────


def cmd_log(args) -> None:
    root = state_dir()
    uuid, amb = resolve_uuid(root, args.uuid)
    if uuid is None:
        err(f"uuid not found" + (f"; did you mean: {', '.join(amb[:5])}" if amb else ""))
    meta = load_meta(root, uuid)
    if meta:
        reconcile_one(root, meta)
    text = read_log_text(_log_path(root, uuid))
    lines = text.splitlines()
    total = len(lines)
    if args.grep:
        lines = filter_lines(lines, args.grep)
    if args.offset is not None:
        start = args.offset
        returned = lines[start : start + args.lines]
        offset_used = start
    else:
        start = max(0, len(lines) - args.lines)
        returned = lines[start:]
        offset_used = start
    out({
        "status": "ok",
        "uuid": uuid,
        "job_status": meta.get("status") if meta else "unknown",
        "total_lines": total,
        "returned": len(returned),
        "offset": offset_used,
        "grep": args.grep,
        "lines": returned,
        "log": str(_log_path(root, uuid)),
        "size_bytes": _log_path(root, uuid).stat().st_size if _log_path(root, uuid).exists() else 0,
    })


# ── status ───────────────────────────────────────────────────────────────────


def cmd_status(args) -> None:
    root = state_dir()
    uuid, amb = resolve_uuid(root, args.uuid)
    if uuid is None:
        err(f"uuid not found" + (f"; did you mean: {', '.join(amb[:5])}" if amb else ""))
    meta = load_meta(root, uuid)
    if not meta:
        err(f"meta missing for uuid '{uuid}'")
    reconcile_one(root, meta)
    alive = pid_alive(meta) if meta["status"] == "running" else False
    elapsed = meta.get("elapsed_seconds")
    if meta["status"] == "running" and meta.get("started_epoch"):
        elapsed = round(now_epoch() - meta["started_epoch"], 1)
    out({
        "status": "ok",
        "uuid": uuid,
        "job_status": meta["status"],
        "pid": meta.get("pid"),
        "alive": alive,
        "exit_code": meta.get("exit_code"),
        "shell": meta.get("shell"),
        "cmd": meta.get("cmd"),
        "cwd": meta.get("cwd"),
        "started_at": meta.get("started_at"),
        "ended_at": meta.get("ended_at"),
        "elapsed_seconds": elapsed,
        "log": meta.get("log"),
        "log_size_bytes": Path(meta["log"]).stat().st_size if meta.get("log") and Path(meta["log"]).exists() else 0,
    })


# ── wait ─────────────────────────────────────────────────────────────────────


def cmd_wait(args) -> None:
    root = state_dir()
    uuid, amb = resolve_uuid(root, args.uuid)
    if uuid is None:
        err(f"uuid not found" + (f"; did you mean: {', '.join(amb[:5])}" if amb else ""))
    meta = load_meta(root, uuid)
    if not meta:
        err(f"meta missing for uuid '{uuid}'")
    deadline = time.time() + args.timeout
    while True:
        reconcile_one(root, meta)
        if meta["status"] != "running":
            break
        if time.time() >= deadline:
            break
        time.sleep(min(0.5, max(0.05, deadline - time.time())))
    text = read_log_text(_log_path(root, uuid))
    tail = tail_lines(text, args.lines)
    result = {
        "status": "ok",
        "uuid": uuid,
        "job_status": meta["status"],
        "exit_code": meta.get("exit_code"),
        "elapsed_seconds": meta.get("elapsed_seconds"),
        "tail": tail,
        "log": meta.get("log"),
    }
    if meta["status"] == "running":
        result["hint"] = "still running; re-invoke wait or use log to inspect"
    out(result)


# ── list ─────────────────────────────────────────────────────────────────────


def cmd_list(args) -> None:
    root = state_dir()
    metas = reconcile_all(root)
    if args.status:
        metas = [m for m in metas if m["status"] == args.status]
    entries = []
    for m in metas:
        elapsed = m.get("elapsed_seconds")
        if m["status"] == "running" and m.get("started_epoch"):
            elapsed = round(now_epoch() - m["started_epoch"], 1)
        entries.append({
            "uuid": m["uuid"],
            "status": m["status"],
            "exit_code": m.get("exit_code"),
            "shell": m.get("shell"),
            "cmd": (m.get("cmd") or "")[:80],
            "pid": m.get("pid"),
            "started_at": m.get("started_at"),
            "ended_at": m.get("ended_at"),
            "elapsed_seconds": elapsed,
        })
    if args.limit:
        entries = entries[: args.limit]
    out({"status": "ok", "count": len(entries), "entries": entries})


# ── stop ─────────────────────────────────────────────────────────────────────


def cmd_stop(args) -> None:
    root = state_dir()
    uuid, amb = resolve_uuid(root, args.uuid)
    if uuid is None:
        err(f"uuid not found" + (f"; did you mean: {', '.join(amb[:5])}" if amb else ""))
    meta = load_meta(root, uuid)
    if not meta:
        err(f"meta missing for uuid '{uuid}'")
    reconcile_one(root, meta, truncate=False)
    if meta["status"] != "running":
        out({"status": "ok", "uuid": uuid, "job_status": meta["status"], "message": "not running"})
        return
    killed = kill_tree(meta.get("pid", 0))
    meta["status"] = "killed"
    meta["exit_code"] = None
    meta["ended_epoch"] = now_epoch()
    meta["ended_at"] = now_iso()
    meta["elapsed_seconds"] = round(meta["ended_epoch"] - meta.get("started_epoch", meta["ended_epoch"]), 1)
    save_meta(root, meta)
    ep = _exit_path(root, uuid)
    if ep.exists():
        try:
            ep.unlink()
        except Exception:
            pass
    sp = _script_path(root, uuid, meta.get("shell", "bash"))
    if sp.exists():
        try:
            sp.unlink()
        except Exception:
            pass
    out({"status": "ok", "uuid": uuid, "job_status": "killed", "killed_pids": killed})


# ── gc ───────────────────────────────────────────────────────────────────────


def cmd_gc(args) -> None:
    root = state_dir()
    metas = load_all_metas(root)
    cutoff = now_epoch() - args.max_age * 3600
    deleted = []
    kept = 0
    for m in metas:
        if m["status"] == "running":
            kept += 1
            continue
        ended = m.get("ended_epoch") or m.get("started_epoch", 0)
        if ended < cutoff:
            for p in [_meta_path(root, m["uuid"]), _log_path(root, m["uuid"]), _exit_path(root, m["uuid"])]:
                try:
                    p.unlink(missing_ok=True)
                except Exception:
                    pass
            sp = _script_path(root, m["uuid"], m.get("shell", "bash"))
            try:
                sp.unlink(missing_ok=True)
            except Exception:
                pass
            deleted.append(m["uuid"])
        else:
            kept += 1
    orphan_deleted = []
    known = {m["uuid"] for m in metas} | set(deleted)
    for subdir in ("logs", "exits", "run"):
        d = root / subdir
        if not d.exists():
            continue
        for f in d.iterdir():
            uid = f.stem
            if uid not in known:
                try:
                    if f.stat().st_mtime < cutoff:
                        f.unlink(missing_ok=True)
                        orphan_deleted.append(str(f))
                except Exception:
                    pass
    out({
        "status": "ok",
        "deleted_uuids": deleted,
        "orphan_deleted": orphan_deleted,
        "kept": kept,
    })


# ── CLI ──────────────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="bgsh",
        description="Background command runner with uuid-keyed log tracking",
    )
    sub = p.add_subparsers(dest="cmd_name", required=True)

    run_p = sub.add_parser("run", help="Launch a command in background")
    run_p.add_argument("--uuid", help="Agent-provided semantic id or omitted for auto 8-hex")
    run_p.add_argument("--shell", choices=["cmd", "powershell", "bash", "auto"], default="auto")
    run_p.add_argument("--cwd", help="Working directory (default: cwd)")
    run_p.add_argument("--env", action="append", default=[], metavar="KEY=VALUE", help="Env vars, repeatable")
    run_p.add_argument("--force", action="store_true", help="Overwrite existing uuid (kill if running)")
    run_p.add_argument("-c", "--cmd", dest="cmd", help="Full command string (preferred)")
    run_p.add_argument("command_pos", nargs="*", help=argparse.SUPPRESS)

    log_p = sub.add_parser("log", help="Read log lines")
    log_p.add_argument("--uuid", required=True)
    log_p.add_argument("--lines", type=int, default=50)
    log_p.add_argument("--offset", type=int, default=None, help="Line offset for incremental read")
    log_p.add_argument("--grep", help="Regex filter")

    status_p = sub.add_parser("status", help="Check job status")
    status_p.add_argument("--uuid", required=True)

    wait_p = sub.add_parser("wait", help="Wait for job to finish")
    wait_p.add_argument("--uuid", required=True)
    wait_p.add_argument("--timeout", type=float, default=60, help="Seconds (default 60)")
    wait_p.add_argument("--lines", type=int, default=30, help="Tail lines on completion/timeout")

    list_p = sub.add_parser("list", help="List all tracked jobs")
    list_p.add_argument("--status", help="Filter by status (running/finished/failed/killed/crashed)")
    list_p.add_argument("--limit", type=int, help="Max entries to return")

    stop_p = sub.add_parser("stop", help="Kill a running job tree")
    stop_p.add_argument("--uuid", required=True)

    gc_p = sub.add_parser("gc", help="Purge old finished entries and orphan files")
    gc_p.add_argument("--max-age", type=float, default=DEFAULT_KEEP_HOURS, help="Hours (default 24)")

    return p


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        {
            "run": cmd_run,
            "log": cmd_log,
            "status": cmd_status,
            "wait": cmd_wait,
            "list": cmd_list,
            "stop": cmd_stop,
            "gc": cmd_gc,
        }[args.cmd_name](args)
    except SystemExit:
        raise
    except Exception as ex:
        out({"status": "error", "error": str(ex)})
        sys.exit(1)


if __name__ == "__main__":
    main()
