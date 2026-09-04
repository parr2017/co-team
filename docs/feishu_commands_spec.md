# 飞书命令集及项目切换逻辑规范

## 1. 概述
本文档定义了通过飞书机器人与 Agent 系统交互的指令集（Slash Commands）以及在多项目、多 Agent 环境下的上下文切换逻辑。其目的是为用户提供直观的操作界面，并确保后端能够正确识别当前请求的目标项目和执行主体。

## 2. 命令集设计 (Command Set)
所有命令均以 `/` 开头，支持参数输入。

| 命令 | 参数 | 功能描述 | 示例 |
| :--- | :--- | :--- | :--- |
| `/help` | 无 | 显示当前可用的所有指令及简要说明 | `/help` |
| `/agent` | `[agent_name]` | 切换当前的执行 Agent。若不带参数，则列出可用 Agent | `/agent dev` |
| `/project` | `[project_id/name]` | 切换当前操作的目标项目上下文 | `/project project-alpha` |
| `/status` | 无 | 查看当前会话的状态（当前项目、当前 Agent） | `/status` |
| `/reset` | 无 | 重置当前会话的所有上下文，清除临时状态 | `/reset` |
| `/list` | `[type]` | 列出所有可用项目 (`/list project`) 或 Agent (`/list agent`) | `/list project` |

### 2.1 命令交互细节
- **模糊匹配**：对于 `/agent` 和 `/project`，系统应支持部分名称匹配并返回建议列表。
- **反馈机制**：每个命令执行后，机器人需立即回复一条确认消息（例如："✅ 已将当前 Agent 切换为 [dev]"）。

## 3. 项目与 Agent 切换逻辑

### 3.1 上下文状态模型 (Context State)
系统需在缓存层（如 Redis）维护一个基于 `userId` 的会话映射表：

```json
{
  "user_id": "ou_xxxxxx",
  "context": {
    "current_project_id": "proj_123",
    "current_agent_id": "agent_dev",
    "last_active_time": "2023-10-27T10:00:00Z",
    "session_id": "sess_abc123"
  }
}
```

### 3.2 切换流程
1. **请求接收**：飞书 Webhook 收到消息 $\rightarrow$ 解析 `userId`。
2. **状态检索**：从缓存中读取该用户的 `current_project_id` 和 `current_agent_id`。
3. **指令拦截**：
   - 若消息以 `/` 开头，进入命令处理逻辑 $\rightarrow$ 更新缓存中的状态 $\rightarrow$ 返回确认结果。
   - 若为普通文本，则使用当前检索到的状态作为请求参数发送给 Agent 调度层。
4. **缺省处理**：
   - 若 `current_project_id` 为空 $\rightarrow$ 机器人回复："请先使用 `/project [name]` 选择一个项目。"
   - 若 `current_agent_id` 为空 $\rightarrow$ 默认分配给 `general` 或 `docs` Agent。

### 3.3 生命周期管理
- **超时失效**：会话状态在 24 小时无活动后自动过期，强制用户重新选择项目。
- **隔离性**：不同用户的上下文完全隔离，确保权限安全。

## 4. 交互流程图 (Sequence)

`User` $\xrightarrow{/project A}$ `Feishu Bot` $\rightarrow$ `Context Manager` (Update State) $\rightarrow$ `User` (Confirm)
`User` $\xrightarrow{\text{"分析代码"}}$ `Feishu Bot` $\rightarrow$ `Context Manager` (Get Project A, Agent Dev) $\rightarrow$ `Agent Dispatcher` $\rightarrow$ `Dev Agent` $\rightarrow$ `User` (Result)