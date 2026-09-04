# 飞书开放平台 API 与 Webhook 机制调研报告

## 1. 概述
飞书 (Lark) 开放平台提供了一套完整的 RESTful API 和事件驱动机制，允许开发者构建企业级应用。其核心能力分为：**API 调用（主动推送/拉取）**和 **Webhook 事件订阅（被动接收）**。

## 2. 认证与授权机制 (Authentication)
飞书采用基于 OAuth 2.0 的令牌机制，主要包含三种类型的 Token：

### 2.1 Token 类型
| Token 名称 | 获取方式 | 生命周期 | 使用场景 |
| :--- | :--- | :--- | :--- |
| `tenant_access_token` | App ID + App Secret | 2 小时 | 代表企业，用于调用大多数企业级 API |
| `user_access_token` | 用户授权流程 (OAuth) | 7 天/刷新令牌 | 代表用户，用于以用户身份操作（如读取个人日程） |
| `app_access_token` | App ID + App Secret | 2 小时 | 代表应用本身，用于特定场景的 API 调用 |

### 2.2 获取流程
1. **申请凭证**：在飞书开放平台创建应用 $\rightarrow$ 获取 `App ID` 和 `App Secret`。
2. **请求 Token**：调用 `/open-apis/auth/v3/tenant_access_token/internal` 接口，通过 POST 请求换取令牌。
3. **携带 Token**：在所有 API 请求的 Header 中加入 `Authorization: Bearer <token>`。

## 3. Webhook 与事件机制
飞书的实时交互主要通过两种方式实现：**自定义机器人 (Custom Bot)** 和 **事件订阅 (Event Subscription)**。

### 3.1 自定义机器人 (Custom Bot)
- **场景**：简单的消息推送（如告警、通知）。
- **机制**：在群组中创建机器人 $\rightarrow$ 获取一个唯一的 `Webhook URL` $\rightarrow$ 向该 URL 发送 JSON 数据。
- **特点**：配置简单，无需复杂认证，但只能发送消息，不能接收用户交互。

### 3.2 事件订阅 (Event Subscription)
- **场景**：复杂的交互逻辑（如用户在群里 @机器人、文档被修改）。
- **机制**：
    1. **配置请求地址**：在开发者后台配置 `Request Address` (你的服务器 URL)。
    2. **URL 验证**：飞书发送一个 `challenge` 随机字符串，服务器需原样返回该字符串以证明所有权。
    3. **接收事件**：当触发预设事件时，飞书向该地址推送 JSON Payload。
- **安全校验**：通过 `X-Lark-Signature` 请求头进行签名验证，确保请求来自飞书服务器。

## 4. 核心 API 分类
| 模块 | 关键能力 | 常用接口示例 |
| :--- | :--- | :--- |
| **消息 (Messaging)** | 发送文本、富文本、卡片消息 | `/open-apis/im/v1/messages` |
| **用户 (User)** | 获取用户信息、部门结构 | `/open-apis/hr/v1/users` |
| **多维表格 (Bitable)** | 读写记录、更新字段 | `/open-apis/bitable/v1/apps/.../tables/.../records` |
| **文档 (Docs)** | 创建文档、读取内容 | `/open-apis/docx/v1/documents` |

## 5. 实现建议与注意事项

### 5.1 Token 管理
- **缓存机制**：不要每次请求都调用获取 Token 接口，应在本地（如 Redis）缓存 Token，并在过期前 5-10 分钟进行刷新。

### 5.2 消息卡片 (Message Card)
- 推荐使用 **飞书卡片搭建工具 (Card Builder)**。卡片支持交互按钮、输入框，能极大提升用户体验，且通过 `card_id` 可实现动态更新。

### 5.3 限流与重试
- 飞书 API 有严格的 QPS 限制。对于高频操作，建议引入消息队列 (MQ) 进行削峰填谷，并实现指数退避 (Exponential Backoff) 的重试机制。

### 5.4 安全实践
- **Secret 存储**：`App Secret` 严禁硬编码在代码中，应使用环境变量或配置中心管理。
- **签名验证**：所有接收 Webhook 的接口必须强制校验签名，防止伪造请求。