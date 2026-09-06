---
name: bg-shell
description: |
  Background command runner with uuid-keyed log tracking for Windows (cmd/powershell/bash).
  Launch any command detached — returns JSON immediately with the tracking uuid;
  then poll logs, exit code and status by uuid. No daemon, no blocking.

  Use proactively (without being asked) when a command may run longer than ~30s:
  builds, full test suites, npm install/pip install, data migration, codegen —
  and for never-exiting processes: dev server, watch mode, local services.

  Also use when user mentions: "后台执行" / "后台运行" / "后台跑" / "别阻塞" /
  "查后台日志" / "run in background" / "background command" / "track logs by uuid".

  Generic arbitrary commands with uuid tracking; when project type/port/JDK
  concerns matter (Spring Boot jar, conda env, port kill), prefer
  project-launcher instead.
---

# bg-shell

后台命令运行器，基于 uuid 日志索引，零守护进程、零死进程。

## Quick Usage

```bash
# Python with psutil (preferred)
D:/ProgramData/miniconda3/python.exe scripts/bgsh.py <subcommand> [options]
```

## Subcommands

| 子命令 | 作用 |
|--------|------|
| `run` | 后台启动命令，返回 uuid + launched 状态 |
| `log` | 按 uuid 读日志（支持 --offset 增量、--grep 过滤） |
| `status` | 按 uuid 查状态 + exit code |
| `wait` | 等待任务结束，返回尾部日志 |
| `list` | 列出所有任务 |
| `stop` | 按 uuid 杀进程树 |
| `gc` | 清理已结束任务（默认 24h）+ 孤立文件 |

## run

```bash
D:/ProgramData/miniconda3/python.exe scripts/bgsh.py run \
  --shell bash --cmd "npm run dev" --uuid my-frontend
```

| Param | Required | 说明 |
|-------|----------|------|
| `--uuid` | 否 | agent 提供语义 id，缺省自动生成 8 位 hex |
| `--shell` | 否 | `cmd`/`powershell`/`bash`/`auto`（默认 auto，按扩展名检测） |
| `--cmd` / `-c` | 是* | 完整命令字符串（优先） |
| `command_pos` | 是* | 位置参数（fallback，`--` 分隔） |
| `--cwd` | 否 | 工作目录（默认 cwd） |
| `--env KEY=VAL` | 否 | 环境变量，可重复 |
| `--force` | 否 | 覆盖已有同名 uuid（运行中的先杀） |

返回 JSON：
```json
{
  "status": "ok",
  "launched": true,
  "uuid": "my-frontend",
  "pid": 12345,
  "shell": "bash",
  "cmd": "npm run dev",
  "log": "C:\\...\\logs\\my-frontend.log",
  "job_status": "running",
  "cwd": "...",
  "started_at": "2026-09-04T10:00:00"
}
```

**启动失败时**：`"launched": false` + `"error"` 字段。

## log

```bash
# 最近 50 行（默认）
D:/ProgramData/miniconda3/python.exe scripts/bgsh.py log --uuid my-frontend

# 增量拉取：记住上次 offset，继续取新内容
D:/ProgramData/miniconda3/python.exe scripts/bgsh.py log --uuid my-frontend --offset 120

# 错误筛查
D:/ProgramData/miniconda3/python.exe scripts/bgsh.py log --uuid my-frontend --grep "ERROR|Exception"
```

| Param | 说明 |
|-------|------|
| `--uuid` | 必填（支持前缀匹配） |
| `--lines N` | 返回行数（默认 50） |
| `--offset N` | 起始行号（增量拉取） |
| `--grep REGEX` | 正则过滤 |

返回 JSON 含 `total_lines`（上次总数）和 `offset`（下次起点），用于增量跟踪。

## status

```bash
D:/ProgramData/miniconda3/python.exe scripts/bgsh.py status --uuid my-frontend
```

返回：`job_status`、`alive`、`exit_code`、`elapsed_seconds`、`log_size_bytes`。

## wait

```bash
# 等待最多 60s（默认），结束后返回尾部 30 行
D:/ProgramData/miniconda3/python.exe scripts/bgsh.py wait --uuid my-frontend

# 自定义超时
D:/ProgramData/miniconda3/python.exe scripts/bgsh.py wait --uuid my-frontend --timeout 120 --lines 50
```

- 结束 → 返回 `exit_code` + `tail`
- 超时 → 返回 `job_status: "running"` + `tail` + `hint`（再次调用即可续等）

## list

```bash
D:/ProgramData/miniconda3/python.exe scripts/bgsh.py list
D:/ProgramData/miniconda3/python.exe scripts/bgsh.py list --status running --limit 10
```

## stop

```bash
D:/ProgramData/miniconda3/python.exe scripts/bgsh.py stop --uuid my-frontend
```

杀整棵进程树（psutil 递归 + taskkill /F /T 兜底），返回 `killed_pids`。

## gc

```bash
D:/ProgramData/miniconda3/python.exe scripts/bgsh.py gc           # 默认 24h
D:/ProgramData/miniconda3/python.exe scripts/bgsh.py gc --max-age 1  # 1h
```

## Agent 持续跟踪日志模式

### 模式 A：会结束的任务（build/test/install）→ 用 `wait`

```bash
# 启动
D:/ProgramData/miniconda3/python.exe scripts/bgsh.py run --shell bash -c "npm run build" --uuid build-fe
# → 解析 JSON，确认 launched=true，拿到 uuid

# 等待（幂等，可反复调用）
D:/ProgramData/miniconda3/python.exe scripts/bgsh.py wait --uuid build-fe --timeout 120
# 结束 → 读 exit_code；超时 → 再次 wait 续等
```

### 模式 B：不退出的任务（dev server / watch）→ 轮询跟踪

```bash
# 启动
D:/ProgramData/miniconda3/python.exe scripts/bgsh.py run --shell bash -c "npm run dev" --uuid dev-server
# → launched=true → 进入轮询

# 每 30~60s 一次：
D:/ProgramData/miniconda3/python.exe scripts/bgsh.py log --uuid dev-server --lines 50
# → 记住返回的 total_lines 和 offset，下次用 offset 增量拉取

D:/ProgramData/miniconda3/python.exe scripts/bgsh.py log --uuid dev-server --offset 50 --lines 50
# → 只看新内容

# 错误筛查：
D:/ProgramData/miniconda3/python.exe scripts/bgsh.py log --uuid dev-server --grep "ERROR|Exception|FATAL"

# 就绪检测：在增量日志中 grep 就绪标记（如 "Listening on"、"ready"、"started"）
# → 检测到就绪标记后汇报用户

# 需要终止时：
D:/ProgramData/miniconda3/python.exe scripts/bgsh.py stop --uuid dev-server
```

## 反模式（禁止）

- ❌ 快命令（<5s，git status / ls）用本技能 → 直接前台执行
- ❌ `sleep` 循环阻塞会话 → 用 `wait --timeout` 分段
- ❌ 手工拼日志文件路径 → 全部通过 uuid 子命令
- ❌ 同 uuid 重复 run（除非 `--force`）
- ❌ 不解析 run 返回 JSON 就假设任务已启动

## Common Gotchas

- **编码**：cmd 输出可能为 GBK；bash/powershell 默认 UTF-8；日志自动 utf-8→gbk→utf-16 回退
- **cmd 多行**：命令中含 `)` 会破坏括号块；多行命令用 `&` 连接
- **powershell 非退出码**：纯 PS cmdlet 失败时 `$LASTEXITCODE` 可能为 null，用 `$?` 判断
- **uuid 重用**：默认拒绝同名 uuid；`--force` 强制覆盖（先杀后建）
- **日志截断**：单日志超 5MB 自动保留尾部 1MB（仅在 reconcile 时触发）
- **PID 复用防护**：通过 psutil create_time 校验进程身份，不会误判
- **死进程**：无常驻进程；所有进程树在 stop/gc 时彻底清理
