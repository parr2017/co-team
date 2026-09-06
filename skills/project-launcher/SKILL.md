---
name: project-launcher
description: |
  Non-blocking background command/project launcher for Windows. Kills existing processes on the target port, starts the project or arbitrary command in background/foreground, and returns log path + PID so agents can track logs and diagnose issues.

  Triggers when user mentions:
  - "启动项目" / "部署项目" / "后台运行"
  - "launch" / "start server" / "deploy"
  - "启动后端" / "启动服务" / "run in background"
  - Running a long/blocking command (build, test, npm install, python script, powershell/bash) that must not block the conversation
  - Stopping or checking a previously launched process
compatibility: Windows (primary), Python 3.8+, psutil
---

# Project Launcher

Launch Java/Python/Node/Docker projects or arbitrary blocking commands. Non-blocking by default — returns immediately with log path and PID; caller agent tails logs independently.

## When to use

- Start a Spring Boot jar / Maven reactor, FastAPI/Flask/Django app, Vue/Node dev server, or any custom command
- Run a potentially long/blocking command (mvn build, npm install, tests, powershell/bash scripts, python jobs) in background so the conversation is not blocked
- Must kill existing process on the target port first
- Need log file path for agent-driven log tracking and issue diagnosis
- JDK version mismatch: launcher auto-detects the right JDK from `pom.xml` (e.g. Java 17 for Spring Boot 3)

## When NOT to use (use direct bash instead)

| Scenario | Why |
|----------|-----|
| Quick read-only commands (`ls`/`grep`/`git status`/`git log`) | Sub-second and non-blocking; backgrounding adds polling latency |
| Interactive commands (`python -i`, `mysql` shell, `npm init` wizards) | Background stdin is DEVNULL; they hang or exit immediately |
| Chained commands that depend on a previous exit code | Background gets no synchronous exit code; use foreground for `&&` pipelines |
| Output you must watch live while it runs | Use `--foreground` (streams to console + log) instead |

## Scripts overview

| Script | Purpose | Dependencies |
|--------|---------|-------------|
| `scripts/launcher.py` | launch/stop/status/tail; conda/venv/python chain; JDK resolution; port kill; background start | Python 3.8+, `psutil` |

## Quick Usage

### 1. Install dependencies (first time only)

Run the launcher with a Python that already has `psutil` — e.g. the base miniconda Python:

```bash
D:/ProgramData/miniconda3/python.exe -m pip install psutil
```

Use the **same interpreter to invoke the launcher** (it needs psutil to kill ports):

```bash
D:/ProgramData/miniconda3/python.exe scripts/launcher.py launch --path <project-or-jar>
```

> The target project's interpreter is chosen independently via the environment degradation chain (below) — the launcher's own interpreter only needs psutil.

### 2. Launch a project

```bash
D:/ProgramData/miniconda3/python.exe scripts/launcher.py launch --path <project-or-jar> [options]
```

### 3. Agent tails logs / checks status / stops

```bash
D:/ProgramData/miniconda3/python.exe scripts/launcher.py tail --log <log-path> --lines 20
D:/ProgramData/miniconda3/python.exe scripts/launcher.py status --pid <pid> --log <log-path>
D:/ProgramData/miniconda3/python.exe scripts/launcher.py stop --port <port>   # or --pid <pid>
```

## Subcommands

| Subcommand | Purpose |
|------------|---------|
| `launch` | Start a project or command (default when no subcommand given — legacy compatible) |
| `stop` | Kill a process tree by `--pid` or by `--port` |
| `status` | Check PID liveness; optionally tail last N log lines |
| `tail` | Read last N lines of a log (utf-8 → gbk fallback) |

Legacy usage `launcher.py --path <x> --port <y> ...` is equivalent to `launch`.

## Environment degradation chain (target command interpreter)

Priority, top wins. **Not specifying any option = system PATH python (zero-dependency fallback).**

| Priority | Trigger | Behavior |
|----------|---------|----------|
| 1 | `--conda-env <name>` | Wrap with `conda run -n <name> --no-capture-output <cmd>`; auto-creates env if missing (`conda create -n <name> python=3.9 -y`); degrades to next level if conda itself unavailable |
| 2 | `--venv <path>` / `--python <path>` | Set `VIRTUAL_ENV` + prepend Scripts to PATH / prepend interpreter dir to PATH |
| 3 | default | System PATH python (no conda, no venv) |

`.env` knobs: `LAUNCHER_DEFAULT_CONDA_ENV` (used when no `--conda-env` and no `--no-conda`), `LAUNCHER_CONDA_PYTHON` (version for auto-create, default 3.9).

## JDK resolution (Java projects)

Priority, top wins. Solves the "system java is Java 8 but project needs Java 17" problem.

| Priority | Trigger | Behavior |
|----------|---------|----------|
| 1 | `--java-home <path>` | Set `JAVA_HOME` and use its `bin/java.exe` |
| 2 | `LAUNCHER_JAVA_HOME` (.env) | Same, project-level config |
| 3 | auto-detect | Read `<java.version>`/`<maven.compiler.source>` from pom.xml, scan `D:\JAVA`, `C:\Program Files\Java`, `%ProgramW6432%\Java` for a matching `jdk-<ver>`, verify with `java -version` |
| — | not found | Error: reports required version + what was found; suggests `--java-home` |

`JAVA_HOME` is set in the subprocess env so **Maven also picks the right JDK**, not just the `java` command.

## Launch parameters

| Param | Required | Description |
|-------|----------|-------------|
| `--path` | yes* | Project dir, `.jar` file, or Maven reactor root (`*` optional if `--run-cmd` given) |
| `--port` | no | Target port (auto-detected: reads application.yml / vite.config.js / manage.py) |
| `--type` | no | Force: `java`/`python`/`node`/`docker`/`custom` (skip auto-detect) |
| `--run-cmd` | no | Full custom command; skips type detection entirely |
| `--shell` | no | `cmd`/`powershell`/`bash`/`auto` for `--run-cmd` (auto detects `.ps1`→powershell, `.sh`→bash) |
| `--env` | no | Env vars, repeatable: `--env KEY1=VAL1 --env KEY2=VAL2` |
| `--log-dir` | no | Log directory (default `./logs`, fallback `%TEMP%/project-launcher`) |
| `--name` | no | Custom log file name prefix (default `<type>-<port>`) |
| `--conda-env` | no | Conda env (auto-created if missing) |
| `--venv` / `--python` | no | venv path / explicit interpreter |
| `--java-home` | no | Explicit JDK home |
| `--java-opts` | no | JVM options, e.g. `-Xmx512m` |
| `--profile` | no | Spring profile, adds `--spring.profiles.active=<name>` |
| `--health-url` | no | Poll this URL until ready (HTTP <500) or timeout before returning |
| `--health-timeout` | no | Readiness poll timeout seconds (default 60) |
| `--foreground` | no | Run in foreground; stream output to console AND log file (for live-watch) |
| `--encoding` | no | Output/read encoding (default utf-8; use `gbk` for Chinese Windows cmd output) |
| `--log-keep` | no | Keep at most N logs per name prefix (default 5) |

## Auto-detection rules

| Type | Detected by | Default command |
|------|-------------|-----------------|
| `java` | `.jar` (incl. `target/*.jar`) / `pom.xml` / `build.gradle` | `java -jar <jar>` / two-phase Maven / `gradle bootRun` |
| `python` | `requirements.txt` / `pyproject.toml` / `main.py` / `app.py` / `manage.py` | uvicorn / flask / django / `python app.py` |
| `node` | `package.json` | `npm run dev` or `npm start` (port auto-injected for vite) |
| `docker` | `Dockerfile` / `docker-compose.yml` | `docker compose up -d` |
| `custom` | `--run-cmd` (skips detection) | your command |

## Port auto-detection

- **Java**: reads `server.port` from the app module's `application.yml` / `application.properties` (walks Maven reactor); for a jar, walks up to the source tree
- **Python**: `--port` args in entry file; **Node**: `port:` in vite/vue config
- **Override**: always use `--port` to force

## Maven multi-module (reactor) support

Pointing at a reactor root (`backend/` with a parent `pom.xml` containing `<modules>`):

- Detects the module with `spring-boot-maven-plugin` (e.g. `dw-app`)
- Runs two-phase: `mvn install -DskipTests -pl <module> -am && mvn spring-boot:run -pl <module>`
  - Single `spring-boot:run -pl app -am` fails because the goal would also run on every module in the `-am` closure (aggregator has no main class)
- Port + JDK read from that module's source / pom
- Prefer the built jar (`target/*.jar`) for fast startup when one exists

## Output format (JSON on stdout)

```json
{
  "status": "ok",
  "type": "java",
  "port": 9595,
  "pid": 12345,
  "log": "D:\\logs\\java-9595-20260813_143022.log",
  "cmd": "mvn spring-boot:run -pl dw-app ...",
  "killed_pids": [3212],
  "conda_env": "demoone",
  "interpreter": "conda",
  "java_home": "D:\\JAVA\\jdk-17.0.9",
  "profile": "dev",
  "ready": true,
  "ready_check": "health"
}
```

On failure:

```json
{
  "status": "error",
  "message": "Java project detected but no JDK found. Use --java-home or LAUNCHER_JAVA_HOME."
}
```

## Log files

Each launch writes a header (command, cwd, type, port, conda env, interpreter, java home, profile) followed by the child's raw output (stderr merged into stdout). Old logs per name prefix are pruned to `--log-keep` files. `tail`/`status` read with utf-8 first then fall back to gbk.

## Examples

### Java jar (auto JDK17 + port 9595)

```bash
D:/ProgramData/miniconda3/python.exe scripts/launcher.py launch \
  --path D:\pxx\VIZAInUse\datawarehouse\backend\dw-app\target\dw-app-1.0.0-SNAPSHOT.jar
```

### Java Maven reactor (auto module + port)

```bash
D:/ProgramData/miniconda3/python.exe scripts/launcher.py launch \
  --path D:\pxx\VIZAInUse\datawarehouse\backend \
  --health-url http://localhost:9595/swagger-ui/index.html --health-timeout 90
```

### Java with explicit JDK + profile

```bash
D:/ProgramData/miniconda3/python.exe scripts/launcher.py launch \
  --path D:\app\myapp.jar --java-home D:\JAVA\jdk-17.0.9 --profile test --java-opts "-Xmx1g"
```

### Python FastAPI in a conda env

```bash
D:/ProgramData/miniconda3/python.exe scripts/launcher.py launch \
  --path D:\pyapi --conda-env my_env --port 8000
```

### Python app with custom entry point

```bash
D:/ProgramData/miniconda3/python.exe scripts/launcher.py launch \
  --path D:\pyapi --port 8000 --env PYTHONPATH=src
```

### Node/Vue dev server

```bash
D:/ProgramData/miniconda3/python.exe scripts/launcher.py launch \
  --path D:\frontend --port 5179
```

### Generic blocking command (build/test/script) — no --path needed

```bash
D:/ProgramData/miniconda3/python.exe scripts/launcher.py launch \
  --run-cmd "mvn clean install -DskipTests" --name my-build --log-dir D:\buildlogs

D:/ProgramData/miniconda3/python.exe scripts/launcher.py launch \
  --run-cmd "D:\scripts\deploy.ps1 -Env prod" --shell auto
```

### Powershell/bash long script

```bash
D:/ProgramData/miniconda3/python.exe scripts/launcher.py launch \
  --run-cmd "powershell -File D:\scripts\etl.ps1" --shell powershell --name etl-job
```

### Foreground (live stream to console + log)

```bash
D:/ProgramData/miniconda3/python.exe scripts/launcher.py launch \
  --run-cmd "npm run build" --foreground --encoding gbk
```

### Stop a previously launched process (kills full tree)

```bash
D:/ProgramData/miniconda3/python.exe scripts/launcher.py stop --port 9595
D:/ProgramData/miniconda3/python.exe scripts/launcher.py stop --pid 12345
```

### Tail / status

```bash
D:/ProgramData/miniconda3/python.exe scripts/launcher.py tail --log D:\logs\java-9595-xxx.log --lines 20
D:/ProgramData/miniconda3/python.exe scripts/launcher.py status --pid 12345 --log D:\logs\java-9595-xxx.log
```

## Agent log tracking pattern

After launch, agent does:

```bash
D:/ProgramData/miniconda3/python.exe scripts/launcher.py tail --log <log-path> --lines 20
```

Poll periodically; if the log contains `ERROR`/`Exception` (or `status` shows `alive: false`), diagnose from the log and fix.

## Common Gotchas

- **Launcher interpreter**: always run `scripts/launcher.py` with a Python that has `psutil` (e.g. `D:/ProgramData/miniconda3/python.exe`). The target project's interpreter is a separate concern (degradation chain above).
- **Windows no `nohup`**: script uses `subprocess.Popen` with `CREATE_NEW_PROCESS_GROUP` — no `nohup` needed.
- **Port already in use**: script kills the occupying process tree before starting.
- **`conda run` children**: killing the reported shell PID alone leaves orphans; `stop --port` / `stop --pid` kill the full process tree (`taskkill /T` / psutil recursive children).
- **Path spaces**: quote paths (`--path "D:\my app\app.jar"`).
- **Blocked/pending output**: background child stdout to a file is block-buffered; long-running python may not flush until exit. Use `--health-url` to detect readiness instead of waiting on log lines.
- **Chinese Windows encoding**: cmd/native tool output is often GBK. Read logs with the auto utf-8→gbk fallback, or use `--encoding gbk` in foreground.
- **npm not found**: ensure Node.js is in PATH, or `--env PATH=%PATH%;C:\nodejs`.

## First-Time Setup

```bash
D:/ProgramData/miniconda3/python.exe -m pip install psutil
```
