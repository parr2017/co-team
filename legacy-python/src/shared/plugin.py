import importlib.util
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import yaml


@dataclass
class AgentPlugin:
    name: str
    role: str = ""
    description: str = ""
    tags: list[str] = field(default_factory=list)
    prompt: str = ""
    model_override: str | None = None
    max_tokens: int = 4096
    timeout: int = 300
    permissions: list[str] = field(default_factory=list)
    pre_run: Callable[[dict], dict] | None = None
    post_run: Callable[[dict], dict] | None = None
    handler_module: str = ""


def discover_plugins(agents_dir: str) -> list[AgentPlugin]:
    plugins = []
    agents_path = Path(agents_dir)
    if not agents_path.exists():
        return plugins

    for agent_dir in sorted(agents_path.iterdir()):
        if not agent_dir.is_dir():
            continue
        config_file = agent_dir / "agent.yaml"
        if not config_file.exists():
            continue

        with open(config_file, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f)

        prompt_file = agent_dir / "prompt.md"
        prompt = ""
        if prompt_file.exists():
            prompt = prompt_file.read_text(encoding="utf-8")

        handler_file = agent_dir / "handler.py"
        pre_run = None
        post_run = None
        if handler_file.exists():
            spec = importlib.util.spec_from_file_location(
                f"handler_{cfg.get('name', 'unknown')}", handler_file
            )
            if spec and spec.loader:
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
                if hasattr(mod, "pre_run"):
                    pre_run = mod.pre_run
                if hasattr(mod, "post_run"):
                    post_run = mod.post_run

        plugin = AgentPlugin(
            name=cfg.get("name", agent_dir.name),
            role=cfg.get("role", ""),
            description=cfg.get("description", ""),
            tags=cfg.get("tags", []),
            prompt=prompt,
            model_override=cfg.get("model_override"),
            max_tokens=cfg.get("max_tokens", 4096),
            timeout=cfg.get("timeout", 300),
            permissions=cfg.get("permissions", []),
            pre_run=pre_run,
            post_run=post_run,
            handler_module=str(handler_file) if handler_file.exists() else "",
        )
        plugins.append(plugin)

    return plugins
