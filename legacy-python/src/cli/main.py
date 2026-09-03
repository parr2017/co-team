import os
import time

import typer
import yaml
from rich.console import Console
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.table import Table

app = typer.Typer(name="coteam", help="Co-Team 多Agent开发助手")
console = Console()

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def load_config() -> dict:
    config_path = os.path.join(BASE_DIR, "config", "config.yaml")
    if config_path.exists():
        with open(config_path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f.read()) or {}
    return {}


def _build_orchestrator(config: dict):
    from src.main.orchestrator import Orchestrator
    from src.main.scheduler import ModelPool
    from src.shared.sandbox import PermissionPolicy
    from src.shared.transport import init_bus

    init_bus(**config.get("redis", {}))
    agents_dir = config.get("agents_dir", "./agents")
    if not os.path.isabs(agents_dir):
        agents_dir = os.path.join(BASE_DIR, agents_dir)
    return Orchestrator(
        agents_dir=agents_dir,
        model_pool=ModelPool(config.get("model_pool", [])),
        max_retries=config.get("orchestrator", {}).get("max_retries", 3),
        permission_policy=PermissionPolicy.from_config(config),
        orchestrator_config=config.get("orchestrator", {}),
    )


@app.command()
def setup():
    """交互式配置：模型、API Key 等"""
    console.print(Panel("[bold green]Co-Team Setup[/]", expand=False))

    config_path = os.path.join(BASE_DIR, "config", "config.yaml")
    config = load_config()

    console.print("\n[bold]当前模型池：[/]")
    for i, m in enumerate(config.get("model_pool", [])):
        console.print(f"  [{i}] {m['name']} ({m['provider']}) cost={m.get('cost_per_1k', 0)}/1k")

    new_key = typer.prompt("请输入 API Key（回车跳过保持不变）", default="", show_default=False)
    if new_key:
        for m in config.get("model_pool", []):
            m["api_key"] = new_key
        os.makedirs(os.path.dirname(config_path), exist_ok=True)
        with open(config_path, "w", encoding="utf-8") as f:
            yaml.safe_dump(config, f, allow_unicode=True, sort_keys=True)
        console.print(f"[green]已写入[/] {config_path}")

    console.print(f"\n[bold]配置文件：[/] {config_path}")
    console.print("[yellow]运行 coteam start 启动服务，coteam chat 进入多轮对话[/]")


@app.command()
def start():
    """启动 Co-Team 服务"""
    from uvicorn import run

    config = load_config()
    dashboard = config.get("dashboard", {})
    console.print(Panel("[bold green]Co-Team Starting...[/]", expand=False))
    console.print(f"  仪表盘: http://localhost:{dashboard.get('port', 8855)}")
    console.print(f"  API 文档: http://localhost:{dashboard.get('port', 8855)}/docs")
    console.print(f"  WS:     ws://localhost:{dashboard.get('port', 8855)}/ws/events")
    console.print("")

    run(
        "src.server.api:app",
        host=dashboard.get("host", "0.0.0.0"),
        port=dashboard.get("port", 8855),
        reload=False,
    )


@app.command()
def status():
    """查看系统状态"""
    config = load_config()
    table = Table(title="Co-Team Status")
    table.add_column("Model")
    table.add_column("Provider")
    table.add_column("Concurrency")
    table.add_column("Priority")
    table.add_column("Cost/1k")
    table.add_column("Tags")

    for m in config.get("model_pool", []):
        table.add_row(
            m["name"], m["provider"], str(m["concurrency"]), str(m["priority"]),
            str(m.get("cost_per_1k", 0)), ", ".join(m.get("tags", [])),
        )
    console.print(table)


@app.command()
def run(
    request: str = typer.Argument(help="任务描述"),
    workspace: str = typer.Option(".", "--workspace", "-w", help="工作目录"),
):
    """运行任务：coteam run "实现用户登录" """
    from src.shared.state import TaskNode, save_task_graph

    orchestrator = _build_orchestrator(load_config())

    console.print(f"\n[bold]任务：[/]{request}")
    console.print(f"[bold]工作目录：[/]{workspace}\n")

    with Progress(SpinnerColumn(), TextColumn("[progress.description]{task.description}")) as progress:
        task = progress.add_task("规划任务图...", total=None)
        nodes = orchestrator.plan(request)
        progress.update(task, description="任务图生成完成")

        table = Table(title="任务图")
        table.add_column("ID")
        table.add_column("任务")
        table.add_column("Agent")
        table.add_column("复杂度")
        table.add_column("状态")
        for n in nodes["nodes"]:
            table.add_row(n["id"], n["name"], n["agent"], n.get("complexity", "normal"), n["status"])
        console.print(table)

        task_id = "cli-" + str(int(time.time()))[-8:]
        save_task_graph(task_id, [TaskNode(**n) for n in nodes["nodes"]], nodes["edges"], meta={
            "description": request, "workspace": workspace, "status": "pending",
        })

        progress.update(task, description="执行中...")
        result = orchestrator.execute(task_id, workspace)

    if result["status"] == "success":
        console.print(f"\n[bold green]完成！[/] 共 {result.get('completed', 0)}/{result.get('total', 0)} 个节点")
        for c in result.get("changes", []):
            console.print(f"  [green]✓[/] {c}")
        if result.get("git_commit"):
            console.print(f"  [blue]git[/] {result['git_commit'].get('branch')} @ {result['git_commit'].get('commit')}")
    elif result["status"] == "waiting_approval":
        console.print("\n[bold yellow]任务等待人工审批[/]，可在 Dashboard 中审批后继续")
    else:
        console.print(f"\n[bold red]失败：[/]{result.get('error', 'unknown error')}")


@app.command()
def chat(
    workspace: str = typer.Option(".", "--workspace", "-w", help="工作目录"),
):
    """多轮对话模式：持续接收任务并执行"""
    from rich.markdown import Markdown

    orchestrator = _build_orchestrator(load_config())
    console.print(Panel("[bold green]Co-Team Chat[/]\n输入任务描述，空行/exit 退出", expand=False))

    while True:
        try:
            request = console.input("[bold cyan]你>[/] ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not request or request.lower() in ("exit", "quit", "q"):
            break

        with Progress(SpinnerColumn(), TextColumn("[progress.description]{task.description}")) as progress:
            task = progress.add_task("规划任务图...", total=None)
            nodes = orchestrator.plan(request)
            progress.update(task, description="执行中...")

            task_id = "chat-" + str(int(time.time()))[-8:]
            from src.shared.state import TaskNode, save_task_graph

            save_task_graph(task_id, [TaskNode(**n) for n in nodes["nodes"]], nodes["edges"], meta={
                "description": request, "workspace": workspace, "status": "pending",
            })
            result = orchestrator.execute(task_id, workspace)

        if result["status"] == "success":
            console.print(f"[bold green]完成[/]（{result.get('completed', 0)}/{result.get('total', 0)} 节点）")
            for c in result.get("changes", []):
                console.print(f"  [green]✓[/] {c}")
        elif result["status"] == "waiting_approval":
            console.print("[yellow]任务等待人工审批，已在 Dashboard 标记[/]")
        else:
            console.print(f"[bold red]失败：[/]{result.get('error', 'unknown error')}")
        console.print("")

    console.print("[dim]已退出[/]")


if __name__ == "__main__":
    app()
