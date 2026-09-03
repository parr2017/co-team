import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.main.router import Router
from src.shared.plugin import AgentPlugin


def test_router_routes_by_tags():
    plugins = [
        AgentPlugin(name="dev", tags=["code", "develop"]),
        AgentPlugin(name="test", tags=["test"]),
        AgentPlugin(name="deploy", tags=["deploy"]),
    ]
    router = Router(plugins)
    assert router.route({"description": "实现用户登录", "tags": ["code"]}) == "dev"
    assert router.route({"description": "写测试用例", "tags": ["test"]}) == "test"


def test_router_fallback():
    plugins = [AgentPlugin(name="dev", tags=["code"])]
    router = Router(plugins)
    assert router.route({"description": "任意任务", "tags": []}) == "dev"


def test_router_llm_fallback():
    def fake_llm_router(description, available):
        return "review" if "审查" in description else None

    plugins = [AgentPlugin(name="dev", tags=["code"]), AgentPlugin(name="review", tags=["review"])]
    router = Router(plugins, llm_router=fake_llm_router)
    assert router.route({"description": "帮我审查这段代码"}) == "review"
    assert router.route({"description": "写个函数"}) == "dev"


if __name__ == "__main__":
    test_router_routes_by_tags()
    test_router_fallback()
    test_router_llm_fallback()
    print("All tests passed!")
