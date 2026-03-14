# Codex Feishu Bridge

一个本地桥接服务：通过飞书长连接接收机器人消息，把文本消息转成 `codex exec` / `codex exec resume` 任务，再把结果发回飞书。

## 调研结论

这版方案参考了 OpenClaw 的核心交互方式，但没有照搬其 Gateway/ACP 控制面，而是先做一层更轻的飞书桥接：

- OpenClaw 对 ACP coding harness 的推荐形态是“线程或频道绑定一个外部 agent session，后续消息继续路由到同一个会话”。这正是远程控制 Codex 最关键的体验。来源：OpenClaw ACP Agents 文档 https://docs.openclaw.ai/tools/acp-agents
- OpenClaw 的 thread-bound 设计说明也强调了“会话身份、线程绑定、路由决策、生命周期恢复”应作为控制面的核心。来源：https://docs.openclaw.ai/experiments/plans/acp-thread-bound-agents
- 飞书官方 Node SDK 文档说明了两种接入方式：Webhook 事件订阅和长连接 WebSocket。为了贴近 OpenClaw 的本地常驻代理体验，当前实现已切到长连接模式。来源：https://github.com/larksuite/node-sdk
- 同一份飞书官方文档确认了长连接的关键行为：本地客户端先调用 `/callback/ws/endpoint` 获取 `wss://...` 地址，再通过持久连接接收入站事件。来源：https://github.com/larksuite/node-sdk
- 消息回发仍然走飞书消息 API `im.message.create`，用 `chat_id` 把执行结果发回原聊天。来源：https://github.com/larksuite/node-sdk

## 最终方案

### 架构

1. 本地服务启动后，先向飞书请求长连接 endpoint
2. 服务通过 WebSocket 持久连接接收 `im.message.receive_v1` 事件
3. 服务按聊天维度维护一个 Codex session
4. 新聊天第一次调用 `codex exec`
5. 同一聊天后续消息调用 `codex exec resume <sessionId>`
6. 结果再通过飞书消息 API 发送回原 chat

### 为什么这样做

- 保留了“会话绑定”这一点，体验上接近 OpenClaw 的 thread-bound ACP
- 不依赖额外网关、消息总线或数据库，能在当前空仓库里直接落地
- 不需要公网 webhook 地址，启动本地进程后即可主动连飞书取事件

### 安全边界

- Bridge 层会给 Codex 自动注入一段执行前导指令：除了删除类操作，其它任务默认直接执行；删除前必须确认
- 可通过 `FEISHU_ALLOWED_OPEN_IDS` 限制允许使用桥接器的飞书用户
- 默认使用 `CODEX_APPROVAL_POLICY=never` 和 `CODEX_SANDBOX=workspace-write`

## 当前能力

- 支持飞书私聊文本消息
- 支持群聊中 `@机器人` 后发送文本
- 支持聊天级别的会话恢复
- 支持串行任务队列
- 支持 `/help`、`/status`、`/reset`、`/abort <任务号>`
- 支持本地状态持久化到 `.codex-feishu-bridge/state.json`

## 已知限制

- 当前只处理文本消息
- 当前回复是发回原 chat，而不是严格 reply 到某一条原消息
- 当前依赖飞书后台已切到“使用长连接接收事件/回调”

## 配置

在项目根目录创建 `.env`：

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
# 如果群里需要精确判断是否 @ 到机器人，可以配置
FEISHU_BOT_OPEN_ID=ou_xxx

HOST=127.0.0.1
PORT=3000
ENABLE_HEALTH_SERVER=true

# 逗号分隔；不填则允许所有能给机器人发消息的人
FEISHU_ALLOWED_OPEN_IDS=

CODEX_WORKSPACE_DIR=/home/jingqi/workspace/your-project
CODEX_COMMAND="~/.local/bin/codex-proxy --dangerously-bypass-approvals-and-sandbox"
CODEX_BIN=codex
CODEX_MODEL=
CODEX_PROFILE=
CODEX_SANDBOX=workspace-write
CODEX_APPROVAL_POLICY=never
CODEX_SKIP_GIT_REPO_CHECK=true
MAX_CONCURRENT_TASKS=1
MAX_REPLY_CHARS=1800
FEISHU_STREAM_OUTPUT_ENABLED=true
FEISHU_STREAM_COMMAND_STATUS_ENABLED=true
FEISHU_STREAM_UPDATE_MIN_INTERVAL_MS=1200
```

## 飞书侧配置

1. 创建一个企业自建应用，并开启机器人能力
2. 在事件与回调中添加事件：`im.message.receive_v1`
3. 在“订阅方式”中选择“使用长连接接收事件/回调”
4. 不需要配置公网请求地址
5. 把应用安装到企业，并确保机器人可以被私聊/被群聊 @

## 运行

```bash
npm start
```

健康检查：

```bash
curl http://127.0.0.1:3000/healthz
```

`CODEX_COMMAND` 可用于覆盖默认启动命令；未配置时才回退到 `CODEX_BIN` 或默认 `codex`。

开启 `FEISHU_STREAM_OUTPUT_ENABLED=true` 后，桥接器会在任务执行过程中把中间 `agent_message` 和命令状态分段发回飞书。可用 `FEISHU_STREAM_COMMAND_STATUS_ENABLED` 控制是否发送命令开始/结束提示，用 `FEISHU_STREAM_UPDATE_MIN_INTERVAL_MS` 控制最小推送间隔，避免刷屏。

## 测试记录

- 已用真实飞书凭据成功调用 `auth/v3/tenant_access_token/internal`
- 已用真实飞书凭据成功调用 `/callback/ws/endpoint`
- 已本地启动长连接客户端，状态页返回 `transport: "feishu-ws"`
- 还没有用真实飞书聊天消息做最终回路验证；这一步依赖应用在飞书后台已开启长连接订阅，并且机器人已安装且可收消息

## 建议的后续版本

- 增加消息卡片，把 `/abort`、`/reset` 做成按钮
- 增加 reply-to-message 能力，减少群聊串线
- 为不同群聊映射不同工作目录
