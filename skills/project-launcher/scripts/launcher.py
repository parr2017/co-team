"""
project-launcher: non-blocking background command/project launcher for Windows.

Subcommands:
    launch  --path <project|jar> [options]     Launch a project or command in background
    stop    --pid <pid> [--port <port>]        Kill a process (tree) by PID or port
    status  --pid <pid> [--lines N] [--log P]  Check liveness; optionally tail last N lines
    tail    --log <path> [--lines N]           Read the last N lines of a log

Backward-compatible legacy usage (equivalent to `launch`):
    python launcher.py --path <project|jar> [--port <port>] [options]

Returns JSON on stdout:
    {"status":"ok","type":"java","port":9595,"pid":12345,"log":"...","cmd":"...","conda_env":null,"java_home":"..."}
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path


# ============================================================
#  Path & env helpers
# ============================================================

def resolve_root() -> Path:
    """Directory containing launcher.py (used to locate .env and defaults)."""
    return Path(__file__).resolve().parent.parent


def load_dotenv(skip_env_existing: bool = True) -> dict:
    """Load KEY=VALUE pairs from .env next to the skill. Returns a dict.

    Manual parser (no python-dotenv dependency). Values already present in
    os.environ are preserved (dotenv semantics) unless skip_env_existing=False.
    """
    cfg = {}
    env_path = resolve_root() / ".env"
    if not env_path.exists():
        return cfg
    for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if not k:
            continue
        if skip_env_existing and k in os.environ:
            continue
        cfg[k] = v
    return cfg


def find_conda() -> str | None:
    """Locate the conda executable."""
    import shutil
    exe = shutil.which("conda")
    if exe:
        return exe
    for p in [os.environ.get("CONDA_EXE"),
              r"D:\ProgramData\miniconda3\Scripts\conda.exe",
              r"D:\ProgramData\miniconda3\condabin\conda.bat"]:
        if p and os.path.exists(p):
            return p
    return None


def conda_env_exists(conda: str, env: str) -> bool:
    try:
        r = subprocess.run([conda, "env", "list", "--json"],
                           capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            return False
        data = json.loads(r.stdout)
        for e in data.get("envs", []):
            if os.path.basename(e) == env or e.replace("\\", "/").endswith("/" + env):
                return True
        return False
    except Exception:
        return False


# ============================================================
#  Process management (port kill + process tree kill)
# ============================================================

def kill_process_tree(pid: int):
    """Kill a process and all its descendants. Returns killed pids."""
    killed = []
    try:
        import psutil
        try:
            parent = psutil.Process(pid)
        except psutil.NoSuchProcess:
            return killed
        children = []
        try:
            children = parent.children(recursive=True)
        except psutil.AccessDenied:
            children = []
        for c in children:
            try:
                c.kill()
                killed.append(c.pid)
            except Exception:
                pass
        try:
            parent.kill()
            parent.wait(timeout=5)
            killed.append(pid)
        except Exception:
            pass
        return killed
    except ImportError:
        # fallback: taskkill /T (tree)
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                       capture_output=True, text=True)
        return [pid]


def kill_port(port: int):
    """Kill all processes (and their trees) listening on the given port."""
    try:
        import psutil
    except ImportError:
        print(json.dumps({"status": "error",
                          "message": "psutil not installed. Run: pip install psutil"}),
              file=sys.stderr)
        sys.exit(1)

    killed = []
    for conn in psutil.net_connections():
        if conn.laddr and conn.laddr.port == port:
            try:
                proc = psutil.Process(conn.pid)
            except psutil.NoSuchProcess:
                continue
            killed.extend(kill_process_tree(conn.pid))
    return list(dict.fromkeys(killed))


# ============================================================
#  Project type detection
# ============================================================

def _has_file(path: Path, *names: str) -> bool:
    for name in names:
        target = path if path.name == name else (path / name)
        if target.exists():
            return True
    return False


def _find_jar(path: Path):
    """If path is a .jar, return it. Otherwise look in dir and its target/ subdir."""
    if path.is_file() and path.suffix == ".jar":
        return path
    jars = list(path.glob("*.jar"))
    if jars:
        return jars[0]
    jars = list(path.glob("target/*.jar"))
    return jars[0] if jars else None


def find_app_module(path: Path):
    """For a Maven reactor root, return the module that has spring-boot-maven-plugin.

    Returns (reactor_root, app_module). For a non-reactor dir returns (None, None).
    """
    pom = path / "pom.xml"
    if not pom.exists():
        return None, None
    text = pom.read_text(encoding="utf-8", errors="replace")
    if "<modules>" not in text:
        # child module? check parent reactor
        parent_pom = path.parent / "pom.xml"
        if parent_pom.exists():
            ptext = parent_pom.read_text(encoding="utf-8", errors="replace")
            modules = re.findall(r"<module>\s*([^<]+?)\s*</module>", ptext)
            if "<modules>" in ptext and path.name in modules:
                return path.parent, path.name
        return None, None
    # this is a reactor root: find module with spring-boot-maven-plugin
    modules = re.findall(r"<module>\s*([^<]+?)\s*</module>", text)
    for m in modules:
        mpom = path / m / "pom.xml"
        if mpom.exists() and "spring-boot-maven-plugin" in mpom.read_text(encoding="utf-8", errors="replace"):
            return path, m
    return path, (modules[-1] if modules else None)


def detect_project_type(path: Path):
    """Detect project type and return (type, metadata_dict)."""
    path = path.resolve()
    if not path.exists():
        return None, {"error": f"Path does not exist: {path}"}

    jar = _find_jar(path)
    if jar:
        return "java", {"jar": str(jar), "build_tool": "jar"}
    if _has_file(path, "pom.xml"):
        return "java", {"build_tool": "mvn"}
    if _has_file(path, "build.gradle", "build.gradle.kts"):
        return "java", {"build_tool": "gradle"}

    if _has_file(path, "requirements.txt", "pyproject.toml", "Pipfile", "setup.py"):
        return _detect_python_type(path)
    if _has_file(path, "main.py", "app.py", "manage.py", "wsgi.py", "asgi.py"):
        return _detect_python_type(path)

    if _has_file(path, "package.json"):
        return "node", {}

    if _has_file(path, "Dockerfile", "docker-compose.yml", "docker-compose.yaml"):
        return "docker", {}

    return None, {}


def _detect_python_type(path: Path):
    for entry in ["manage.py", "app.py", "main.py", "wsgi.py", "asgi.py", "run.py"]:
        if (path / entry).exists():
            content = (path / entry).read_text(encoding="utf-8", errors="replace")[:2000]
            if "uvicorn" in content or "fastapi" in content.lower():
                return "python", {"entry": f"{path.name}.main:app"}
            if "flask" in content.lower():
                return "python", {"entry": entry, "framework": "flask"}
            if "django" in content.lower():
                return "python", {"entry": f"{path.name}.wsgi:application", "framework": "django"}
            return "python", {"entry": entry, "framework": "generic"}
    return "python", {}


# ============================================================
#  Port detection
# ============================================================

def _java_config_paths(path: Path, app_module: str | None = None):
    bases = [path]
    if app_module:
        bases.append(path / app_module)
    for base in bases:
        for name in ("application.yml", "application.yaml", "application.properties"):
            yield base / "src" / "main" / "resources" / name
            yield base / name


def detect_port(path: Path, ptype: str, meta: dict, port_arg: int = None):
    """Auto-detect port, falling back to default. --port always overrides."""
    if port_arg is not None:
        return port_arg

    defaults = {"java": 8080, "python": 8000, "node": 5173, "docker": 8080, "custom": 8080}

    try:
        if ptype == "java":
            _, app_module = find_app_module(path)
            for cfg in _java_config_paths(path, app_module):
                if cfg.exists():
                    text = cfg.read_text(encoding="utf-8", errors="replace")
                    if cfg.suffix in (".yml", ".yaml"):
                        m = re.search(r"server:\s*port:\s*(\d+)", text)
                        if m:
                            return int(m.group(1))
                    else:
                        m = re.search(r"server\.port\s*=\s*(\d+)", text)
                        if m:
                            return int(m.group(1))
            # path is a jar: try source next to target/
            if path.is_file() and path.suffix == ".jar":
                src = path.parent.parent / "src" / "main" / "resources" / "application.yml"
                if src.exists():
                    text = src.read_text(encoding="utf-8", errors="replace")
                    m = re.search(r"server:\s*port:\s*(\d+)", text)
                    if m:
                        return int(m.group(1))
            return defaults["java"]

        elif ptype == "python":
            for entry_name in ["manage.py", "app.py", "main.py"]:
                entry = path / entry_name
                if entry.exists():
                    text = entry.read_text(encoding="utf-8", errors="replace")
                    m = re.search(r"--port\s+(\d+)", text)
                    if m:
                        return int(m.group(1))
            return defaults["python"]

        elif ptype == "node":
            for cfg_name in ["vite.config.js", "vite.config.ts", "vue.config.js"]:
                cfg = path / cfg_name
                if cfg.exists():
                    text = cfg.read_text(encoding="utf-8", errors="replace")
                    m = re.search(r"port\s*:\s*(\d+)", text)
                    if m:
                        return int(m.group(1))
            return defaults["node"]

        return defaults.get(ptype, 8080)
    except Exception:
        return defaults.get(ptype, 8080)


# ============================================================
#  JDK resolution
# ============================================================

def _parse_java_version(java_exe: str):
    try:
        r = subprocess.run([java_exe, "-version"], capture_output=True, text=True, timeout=15)
        out = (r.stdout + r.stderr).lower()
        m = re.search(r'"(\d+)(?:\.(\d+))?', out)
        if m:
            major = int(m.group(1))
            if major == 1:  # 1.8, 1.7 ...
                return int(m.group(2) or 0)
            return major
    except Exception:
        pass
    return None


def _scan_java_dirs(req: int):
    """Scan common JDK install roots for a JDK whose major version == req."""
    roots = []
    for var in ("ProgramW6432", "ProgramFiles", "JAVA_HOME"):
        v = os.environ.get(var)
        if v:
            roots.append(Path(v))
    roots += [Path("D:/JAVA"), Path("C:/Program Files/Java"), Path("D:/Develop")]
    seen = set()
    for root in roots:
        if not root.exists():
            continue
        for d in sorted(root.iterdir()):
            if not d.is_dir():
                continue
            name = d.name.lower()
            if "jdk" not in name and "jre" not in name:
                continue
            if d in seen:
                continue
            seen.add(d)
            java = d / "bin" / "java.exe"
            if not java.exists():
                continue
            ver = _parse_java_version(str(java))
            if ver == req:
                return str(d)
    return None


def resolve_java_home(args, cfg: dict, path: Path, ptype: str):
    """Resolve JAVA_HOME with priority: --java-home > LAUNCHER_JAVA_HOME > pom auto-detect."""
    if ptype != "java":
        return None
    if getattr(args, "java_home", None):
        return args.java_home
    if cfg.get("LAUNCHER_JAVA_HOME"):
        return cfg["LAUNCHER_JAVA_HOME"]

    # auto-detect from pom.xml (walk up to find the project root)
    req = None
    p = path.parent if path.is_file() else path
    for _ in range(6):  # up to 6 levels: target/ -> module -> reactor root
        pom = p / "pom.xml"
        if pom.exists():
            text = pom.read_text(encoding="utf-8", errors="replace")
            m = re.search(r"<java\.version>\s*([^<]+?)\s*</java\.version>", text)
            if not m:
                m = re.search(r"<maven\.compiler\.source>\s*([^<]+?)\s*</maven\.compiler\.source>", text)
            if m:
                v = m.group(1).strip()
                digits = re.match(r"\d+", v)
                req = int(digits.group(0)) if digits else None
                break
        if p.parent == p:
            break
        p = p.parent
    if req:
        found = _scan_java_dirs(req)
        if found:
            return found
    return None


# ============================================================
#  Command building
# ============================================================

def build_command(ptype: str, path: Path, port: int, meta: dict, env_list: list,
                  run_cmd: str = None, java_home: str = None, java_opts: str = None,
                  profile: str = None):
    """Build (command, env_extra, cwd). Returns (cmd, env, cwd)."""
    env = {}
    for e in env_list:
        if "=" in e:
            k, v = e.split("=", 1)
            env[k] = v

    if run_cmd:
        return run_cmd, env, str(Path.cwd())

    path_str = str(path.resolve())

    if ptype == "java":
        if java_home:
            env["JAVA_HOME"] = java_home
            java_exe = os.path.join(java_home, "bin", "java.exe")
        else:
            java_exe = "java"

        profile_arg = f" --spring.profiles.active={profile}" if profile else ""

        jar = meta.get("jar")
        if jar:
            cmd = f"\"{java_exe}\" {java_opts or ''} -jar \"{jar}\" --server.port={port}{profile_arg}".strip()
            return cmd, env, str(path.parent if path.is_file() else path)
        elif meta.get("build_tool") == "mvn":
            reactor_root, app_module = find_app_module(path)
            if reactor_root and app_module:
                args_txt = f"--server.port={port}{profile_arg}"
                # Two-phase: install deps (only the -am closure) then run ONLY the app module.
                # Single `spring-boot:run -pl app -am` fails because the goal also runs
                # on every module in the -am closure (root aggregator has no main class).
                cmd = (f"mvn install -DskipTests -pl {app_module} -am && "
                       f"mvn spring-boot:run -pl {app_module} "
                       f"-Dspring-boot.run.arguments=\"{args_txt}\"")
                return cmd, env, str(reactor_root)
            cmd = (f"mvn spring-boot:run "
                   f"-Dspring-boot.run.arguments=\"--server.port={port}{profile_arg}\"")
            return cmd, env, path_str
        else:
            cmd = f"gradle bootRun --args=\"--server.port={port}\""
            return cmd, env, path_str

    elif ptype == "python":
        entry = meta.get("entry", "app.py")
        framework = meta.get("framework", "generic")
        if framework == "django":
            cmd = f"python manage.py runserver 0.0.0.0:{port}"
        elif framework == "flask":
            env.setdefault("FLASK_APP", entry)
            env.setdefault("FLASK_RUN_PORT", str(port))
            cmd = f"python -m flask run --host=0.0.0.0 --port={port}"
        elif "uvicorn" in str(entry) or "asgi" in str(meta.get("entry", "")):
            cmd = f"uvicorn {meta.get('entry', 'main:app')} --host 0.0.0.0 --port {port}"
        else:
            cmd = f"python \"{path / entry}\" --port={port}" if entry else f"python \"{path_str}\""
            if (path / "asgi.py").exists():
                cmd = f"uvicorn {path.name}.asgi:application --host 0.0.0.0 --port {port}"
        return cmd, env, path_str

    elif ptype == "node":
        pkg = path / "package.json"
        cmd = "npm run dev"
        if pkg.exists():
            try:
                data = json.loads(pkg.read_text(encoding="utf-8"))
                scripts = data.get("scripts", {})
                if "dev" in scripts and "vite" in scripts["dev"]:
                    env.setdefault("VITE_PORT", str(port))
                    if "--port" not in scripts["dev"]:
                        cmd = f"npm run dev -- --port {port}"
                    else:
                        cmd = "npm run dev"
                elif "start" in scripts:
                    cmd = "npm start"
                    env.setdefault("PORT", str(port))
                elif "dev" in scripts:
                    cmd = "npm run dev"
            except Exception:
                pass
        return cmd, env, path_str

    elif ptype == "docker":
        compose = path / "docker-compose.yml"
        if not compose.exists():
            compose = path / "docker-compose.yaml"
        if compose.exists():
            return f"docker compose -f \"{compose}\" up -d", env, path_str
        return f"docker build -t project \"{path_str}\" && docker run -d -p {port}:{port} project", env, path_str

    return "", env, path_str


def apply_shell(cmd: str, shell: str = None) -> str:
    """Wrap a raw command for a target shell. auto detects by content."""
    low = cmd.lower()
    if shell == "auto" or shell is None:
        if low.startswith("powershell") or ".ps1" in low:
            return f"powershell -NoProfile -ExecutionPolicy Bypass -Command \"{cmd}\""
        if low.startswith("bash") or ".sh" in low:
            return f"bash -c \"{cmd}\""
        return cmd  # cmd.exe (Popen shell=True default)
    if shell == "powershell":
        return f"powershell -NoProfile -ExecutionPolicy Bypass -Command \"{cmd}\""
    if shell == "bash":
        return f"bash -c \"{cmd}\""
    return cmd


# ============================================================
#  Runtime environment (conda/venv/python degradation chain)
# ============================================================

def resolve_runtime(cmd: str, args, cfg: dict):
    """Decide the interpreter chain.

    Priority: --conda-env (auto-create if missing; degrade if conda unavailable)
              > --venv / --python (prepend PATH / set VIRTUAL_ENV)
              > system PATH python (zero-dependency fallback)
    Returns (final_cmd, env_extra, runtime_info).
    """
    env = {}
    conda_env = getattr(args, "conda_env", None)
    if not conda_env and not getattr(args, "no_conda", False):
        conda_env = cfg.get("LAUNCHER_DEFAULT_CONDA_ENV") or None

    if conda_env:
        conda = find_conda()
        if conda:
            if not conda_env_exists(conda, conda_env):
                print(f"[launcher] conda env '{conda_env}' missing, creating ...", file=sys.stderr)
                py_ver = cfg.get("LAUNCHER_CONDA_PYTHON", "3.9")
                r = subprocess.run([conda, "create", "-n", conda_env, f"python={py_ver}", "-y"],
                                   capture_output=True, text=True, timeout=600)
                if r.returncode != 0:
                    print(f"[launcher] conda create failed: {r.stderr[-500:]}", file=sys.stderr)
                    print("[launcher] degrading to system python", file=sys.stderr)
                    return cmd, env, {"interpreter": "system-python", "conda_env": None}
            final = f"{conda} run -n {conda_env} --no-capture-output {cmd}"
            return final, env, {"interpreter": "conda", "conda_env": conda_env}
        else:
            print("[launcher] --conda-env given but conda not found; degrading to next level",
                  file=sys.stderr)

    if getattr(args, "venv", None):
        venv = Path(args.venv)
        scripts = venv / ("Scripts" if os.name == "nt" else "bin")
        if scripts.exists():
            env["VIRTUAL_ENV"] = str(venv)
            env["PATH"] = str(scripts) + os.pathsep + os.environ.get("PATH", "")
            return cmd, env, {"interpreter": "venv", "venv": str(venv)}

    if getattr(args, "python", None):
        py = args.python
        if os.path.isfile(py):
            # replace 'python'/'uvicorn' tokens in cmd with the explicit interpreter
            py_dir = os.path.dirname(py)
            env["PATH"] = py_dir + os.pathsep + os.environ.get("PATH", "")
            return cmd, env, {"interpreter": "python-path", "python": py}

    return cmd, env, {"interpreter": "system-python", "conda_env": None}


# ============================================================
#  Background / foreground launcher
# ============================================================

def _write_header(log_path: Path, title: str, meta_lines: list):
    with open(log_path, "w", encoding="utf-8") as f:
        f.write(f"=== {title} ===\n")
        for k, v in meta_lines:
            f.write(f"{k}: {v}\n")
        f.write("---\n")


def start_background(cmd: str, log_path: str, env: dict, cwd: str = None,
                     header: list = None):
    """Start a process detached in background. Returns (pid, alive)."""
    log_path = Path(log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    if header:
        _write_header(log_path, "launch", header)

    base_env = os.environ.copy()
    base_env.update(env)

    kwargs = {
        "stdout": open(log_path, "a", encoding="utf-8"),
        "stderr": subprocess.STDOUT,
        "stdin": subprocess.DEVNULL,
        "env": base_env,
        "cwd": cwd or str(Path.cwd()),
    }

    extra = {}
    if sys.platform == "win32":
        extra["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        extra["start_new_session"] = True

    try:
        proc = subprocess.Popen(cmd, shell=True, **kwargs, **extra)
    finally:
        kwargs["stdout"].close()  # parent no longer needs the handle; child keeps it

    time.sleep(1)
    alive = proc.poll() is None
    return proc.pid, alive


def start_foreground(cmd: str, log_path: str, env: dict, cwd: str = None,
                     header: list = None, encoding: str = "utf-8"):
    """Run in foreground, tee output to both console and log file. Returns (pid, ok)."""
    log_path = Path(log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    if header:
        _write_header(log_path, "launch", header)

    base_env = os.environ.copy()
    base_env.update(env)

    log = open(log_path, "a", encoding="utf-8", buffering=1)
    proc = subprocess.Popen(cmd, shell=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            env=base_env, cwd=cwd or str(Path.cwd()))
    try:
        for raw in proc.stdout:
            line = raw.decode(encoding, errors="replace")
            sys.stdout.write(line)
            sys.stdout.flush()
            log.write(line)
    finally:
        log.close()
    proc.wait()
    return proc.pid, proc.returncode == 0


# ============================================================
#  Readiness check
# ============================================================

def wait_ready(url: str, timeout: int) -> bool:
    import urllib.error
    import urllib.request
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status < 500:
                    return True
        except urllib.error.HTTPError as e:
            if e.code < 500:
                return True
        except Exception:
            pass
        time.sleep(1)
    return False


# ============================================================
#  Log directory / naming
# ============================================================

def get_log_dir(log_dir_arg: str = None) -> str:
    if log_dir_arg:
        p = Path(log_dir_arg)
        p.mkdir(parents=True, exist_ok=True)
        return str(p.resolve())
    p = Path.cwd() / "logs"
    try:
        p.mkdir(parents=True, exist_ok=True)
        return str(p.resolve())
    except (OSError, PermissionError):
        tmp = Path(tempfile.gettempdir()) / "project-launcher"
        tmp.mkdir(parents=True, exist_ok=True)
        return str(tmp.resolve())


def cleanup_old_logs(log_dir: str, name_prefix: str, keep: int):
    """Delete oldest logs matching prefix, keeping at most `keep` files."""
    if keep <= 0:
        return
    files = sorted(Path(log_dir).glob(f"{name_prefix}*.log"))
    while len(files) > keep:
        try:
            files.pop(0).unlink(missing_ok=True)
        except Exception:
            break


def read_log_tail(log_path: str, lines: int = 50, encoding: str = None):
    """Read last N lines. Tries utf-8 then gbk then latin-1."""
    encs = [encoding] if encoding else ["utf-8", "gbk", "latin-1"]
    data = None
    for enc in encs:
        try:
            data = Path(log_path).read_text(encoding=enc)
            break
        except (UnicodeDecodeError, LookupError):
            continue
    if data is None:
        data = Path(log_path).read_bytes().decode("utf-8", errors="replace")
    return "\n".join(data.splitlines()[-lines:])


# ============================================================
#  CLI
# ============================================================

def build_parser():
    parser = argparse.ArgumentParser(
        description="Non-blocking command/project launcher (Java/Python/Node/Docker/generic)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("launch", help="launch a project or command in background")
    p.add_argument("--path", help="Project directory or .jar path (optional if --run-cmd given)")
    p.add_argument("--port", type=int, default=None, help="Target port (auto-detected if omitted)")
    p.add_argument("--type", choices=["java", "python", "node", "docker", "custom"], help="Force project type")
    p.add_argument("--run-cmd", help="Full custom command (overrides auto-generate)")
    p.add_argument("--env", action="append", default=[], help="Env vars: KEY=VAL (repeatable)")
    p.add_argument("--log-dir", help="Log output directory")
    p.add_argument("--name", help="Custom log file name prefix (default: <type>-<port>)")
    p.add_argument("--shell", choices=["cmd", "powershell", "bash", "auto"], default=None,
                   help="Shell for --run-cmd (default: auto)")
    p.add_argument("--conda-env", help="Conda env to run command in (auto-created if missing)")
    p.add_argument("--no-conda", action="store_true", help="Do not apply .env conda default")
    p.add_argument("--venv", help="Python venv directory to activate")
    p.add_argument("--python", help="Explicit python interpreter path")
    p.add_argument("--java-home", help="Explicit JDK home (overrides LAUNCHER_JAVA_HOME and auto-detect)")
    p.add_argument("--java-opts", help="JVM options for java launch (e.g. -Xmx512m)")
    p.add_argument("--profile", help="Spring profile, e.g. dev/test (adds --spring.profiles.active)")
    p.add_argument("--health-url", help="URL to poll for readiness before returning")
    p.add_argument("--health-timeout", type=int, default=60, help="Readiness poll timeout (s)")
    p.add_argument("--foreground", action="store_true", help="Run in foreground, stream to console+log")
    p.add_argument("--encoding", help="Output decoding encoding (default utf-8)")
    p.add_argument("--log-keep", type=int, default=5, help="Keep at most N logs per prefix")

    p = sub.add_parser("stop", help="kill a process tree by PID or by port")
    p.add_argument("--pid", type=int, help="PID to kill (with its children)")
    p.add_argument("--port", type=int, help="Kill process(es) listening on port")

    p = sub.add_parser("status", help="check a PID; optionally tail its log")
    p.add_argument("--pid", type=int, help="PID to check")
    p.add_argument("--lines", type=int, default=20, help="Last N log lines to include")
    p.add_argument("--log", help="Log file to tail")
    p.add_argument("--encoding", help="Log decoding encoding")

    p = sub.add_parser("tail", help="read last N lines of a log")
    p.add_argument("--log", required=True, help="Log file path")
    p.add_argument("--lines", type=int, default=50, help="Number of lines")
    p.add_argument("--encoding", help="Log decoding encoding")

    return parser


def cmd_launch(args, cfg):
    if not args.path and not args.run_cmd:
        print(json.dumps({"status": "error",
                          "message": "--path is required unless --run-cmd is provided"}))
        sys.exit(1)

    path = Path(args.path) if args.path else Path.cwd()

    # 1. detect type (skip detection entirely when a raw command is provided)
    ptype = args.type
    meta = {}
    if args.run_cmd:
        ptype = "custom"
    elif not ptype:
        ptype, meta = detect_project_type(path)
        if ptype is None:
            print(json.dumps({"status": "error",
                              "message": meta.get("error",
                                "Could not detect project type. Use --type or --run-cmd.")}))
            sys.exit(1)

    # 2. port
    port = detect_port(path, ptype, meta, args.port)

    # 3. JDK (java only)
    java_home = resolve_java_home(args, cfg, path, ptype)
    if ptype == "java" and not java_home:
        print(json.dumps({"status": "error",
                          "message": "Java project detected but no JDK found. "
                                     "Install a matching JDK or use --java-home / LAUNCHER_JAVA_HOME."}))
        sys.exit(1)

    # 4. kill existing on port (only when a real port is used, not custom no-port)
    killed = kill_port(port) if ptype != "custom" or args.port else []

    # 5. build command
    raw_cmd, env, cwd = build_command(ptype, path, port, meta, args.env, args.run_cmd,
                                      java_home, args.java_opts, args.profile)
    if not raw_cmd:
        print(json.dumps({"status": "error", "message": "Failed to build startup command"}))
        sys.exit(1)

    # 6. apply shell wrapping (for custom / run-cmd)
    if args.run_cmd or ptype == "custom":
        raw_cmd = apply_shell(raw_cmd, args.shell)

    # 7. conda/venv/python degradation chain
    final_cmd, runtime_env, runtime_info = resolve_runtime(raw_cmd, args, cfg)
    env.update(runtime_env)

    # 8. log path
    log_dir = get_log_dir(args.log_dir)
    prefix = args.name or (f"{ptype}-{port}" if port else f"{ptype}")
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_file = str(Path(log_dir) / f"{prefix}-{ts}.log")
    cleanup_old_logs(log_dir, f"{prefix}-", args.log_keep)

    header = [
        ("cmd", final_cmd),
        ("cwd", cwd),
        ("type", ptype),
        ("port", port),
        ("conda_env", runtime_info.get("conda_env")),
        ("interpreter", runtime_info.get("interpreter")),
        ("java_home", java_home or ""),
        ("profile", args.profile or ""),
    ]

    # 9. launch
    if args.foreground:
        pid, ok = start_foreground(final_cmd, log_file, env, cwd, header, args.encoding or "utf-8")
        result = {
            "status": "ok" if ok else "failed",
            "type": ptype,
            "port": port,
            "pid": pid if ok else None,
            "log": log_file,
            "cmd": final_cmd,
            "exit_code": 0 if ok else -1,
            "killed_pids": killed,
            "conda_env": runtime_info.get("conda_env"),
            "java_home": java_home,
        }
        if not ok:
            result["message"] = "Process exited non-zero. Check log for details."
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0 if ok else 1)

    pid, alive = start_background(final_cmd, log_file, env, cwd, header)

    # 10. readiness
    ready = None
    ready_check = None
    if args.health_url:
        ready = wait_ready(args.health_url, args.health_timeout)
        ready_check = "health"

    result = {
        "status": "ok" if alive else "failed",
        "type": ptype,
        "port": port,
        "pid": pid if alive else None,
        "log": log_file,
        "cmd": final_cmd,
        "killed_pids": killed,
        "conda_env": runtime_info.get("conda_env"),
        "interpreter": runtime_info.get("interpreter"),
        "java_home": java_home,
        "profile": args.profile,
        "ready": ready,
        "ready_check": ready_check,
    }
    if not alive:
        result["message"] = "Process exited immediately. Check log for details."

    print(json.dumps(result, ensure_ascii=False))


def cmd_stop(args):
    killed = []
    if args.port:
        killed = kill_port(args.port)
    if args.pid:
        killed.extend(kill_process_tree(args.pid))
    if not args.port and not args.pid:
        print(json.dumps({"status": "error", "message": "Provide --pid or --port"}))
        sys.exit(1)
    killed = list(dict.fromkeys(killed))
    print(json.dumps({"status": "ok", "killed_pids": killed}, ensure_ascii=False))


def cmd_status(args):
    alive = False
    try:
        import psutil
        alive = psutil.pid_exists(args.pid) if args.pid else False
    except ImportError:
        alive = bool(args.pid)
    out = {"status": "ok", "pid": args.pid, "alive": alive}
    if args.log and Path(args.log).exists():
        out["tail"] = read_log_tail(args.log, args.lines, args.encoding)
    print(json.dumps(out, ensure_ascii=False))


def cmd_tail(args):
    if not Path(args.log).exists():
        print(json.dumps({"status": "error", "message": f"Log not found: {args.log}"}))
        sys.exit(1)
    print(read_log_tail(args.log, args.lines, args.encoding))


def main():
    argv = sys.argv[1:]
    subcommands = {"launch", "stop", "status", "tail"}
    if argv and argv[0] not in subcommands:
        argv = ["launch"] + argv

    parser = build_parser()
    args = parser.parse_args(argv)

    if not args.command:
        parser.print_help()
        sys.exit(1)

    cfg = load_dotenv()

    if args.command == "launch":
        cmd_launch(args, cfg)
    elif args.command == "stop":
        cmd_stop(args)
    elif args.command == "status":
        cmd_status(args)
    elif args.command == "tail":
        cmd_tail(args)


if __name__ == "__main__":
    main()
