import re
from typing import Any

from src.shared.plugin import AgentPlugin


class Router:
    def __init__(self, plugins: list[AgentPlugin], rules: list[dict] | None = None, llm_router: Any = None):
        self._plugins = {p.name: p for p in plugins}
        self._rules = rules or []
        # optional async-free callable: (description, available_names) -> agent name
        self._llm_router = llm_router

    def route(self, task: dict) -> str:
        result = self._match_rules(task)
        if result:
            return result
        if self._llm_router and len(self._plugins) > 1:
            try:
                picked = self._llm_router(task.get("description", ""), list(self._plugins.keys()))
                if picked in self._plugins:
                    return picked
            except Exception:
                pass
        return self._llm_route(task)

    def _match_rules(self, task: dict) -> str | None:
        description = task.get("description", "")
        tags = task.get("tags", [])

        for rule in self._rules:
            pattern = rule.get("pattern", "")
            action = rule.get("action", "")
            if re.search(pattern, description, re.IGNORECASE):
                if action in self._plugins:
                    return action
            for tag in tags:
                if tag in rule.get("match_tags", []):
                    target = rule.get("action")
                    if target and target in self._plugins:
                        return target
        return None

    def _llm_route(self, task: dict) -> str:
        """Fallback: use LLM to decide which agent to route to."""
        available = list(self._plugins.keys())
        if len(available) == 1:
            return available[0]

        task_desc = task.get("description", "")
        for plugin_name, plugin in self._plugins.items():
            plugin_tags = set(plugin.tags)
            task_tags = set(t.lower() for t in task.get("tags", []))
            if plugin_tags & task_tags:
                return plugin_name

        description_lower = task_desc.lower()
        code_keywords = ["代码", "实现", "开发", "函数", "类", "模块", "api"]
        test_keywords = ["测试", "test", "用例"]
        deploy_keywords = ["部署", "发布", "docker", "server"]
        review_keywords = ["审查", "review", "检查"]

        if any(k in description_lower for k in code_keywords):
            for name in ["dev", "develop"]:
                if name in self._plugins:
                    return name
        if any(k in description_lower for k in test_keywords):
            if "test" in self._plugins:
                return "test"
        if any(k in description_lower for k in deploy_keywords):
            if "deploy" in self._plugins:
                return "deploy"
        if any(k in description_lower for k in review_keywords):
            if "review" in self._plugins:
                return "review"

        return available[0]

    def get_available(self) -> dict[str, AgentPlugin]:
        return self._plugins


DEFAULT_RULES = [
    {"pattern": r"(测试|test|用例)", "action": "test", "match_tags": ["test"]},
    {"pattern": r"(部署|发布|deploy)", "action": "deploy", "match_tags": ["deploy"]},
    {"pattern": r"(审查|review|检查)", "action": "review", "match_tags": ["review"]},
]
