import json
import sys
import os

from openai import OpenAI


def run_agent(workspace: str, prompt: str, task: dict, model: str, api_key: str, base_url: str, max_tokens: int):
    client = OpenAI(api_key=api_key, base_url=base_url)

    task_context = task.get("context", {})
    user_message = f"""工作目录：{workspace}
任务描述：{task.get('description', '')}

系统提示词：
{prompt}

请执行任务并返回 JSON 结果：
{{
  "status": "success|failed",
  "changes": ["file1: 说明"],
  "summary": "完成摘要",
  "errors": []
}}"""

    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": user_message}],
        max_tokens=max_tokens,
        temperature=0,
    )

    content = response.choices[0].message.content or "{}"
    content = content.strip()
    if content.startswith("```"):
        lines = content.split("\n")
        content = "\n".join(l for l in lines if not l.startswith("```"))

    try:
        return json.loads(content)
    except json.JSONDecodeError:
        return {
            "status": "failed",
            "error": "Failed to parse agent output",
            "raw_output": content[:2000],
        }


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print(json.dumps({"status": "failed", "error": "Usage: agent_runner <task_json> <prompt> <model_config>"}))
        sys.exit(1)

    task = json.loads(sys.argv[1])
    prompt = sys.argv[2]
    model_cfg = json.loads(sys.argv[3])
    workspace = sys.argv[4] if len(sys.argv) > 4 else "."

    result = run_agent(
        workspace=workspace,
        prompt=prompt,
        task=task,
        model=model_cfg["name"],
        api_key=model_cfg["api_key"],
        base_url=model_cfg["base_url"],
        max_tokens=model_cfg.get("max_tokens", 4096),
    )
    print(json.dumps(result, ensure_ascii=False))
