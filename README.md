# Codex Feishu Bridge

一个本地桥接服务：通过飞书长连接接收机器人消息，把文本消息转成 `codex exec` / `codex exec resume` 任务，再把结果发回飞书。

## 实现方案

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
- 支持 reply-to-message，减少群聊串线
- 支持共享卡片更新：任务接收、进度更新、完成/失败会收敛到同一张卡片
- 支持带 `Abort` / `Reset Session` 按钮的消息卡片
- 支持按会话映射不同工作目录
- 支持任务结束后自动 Git 提交，再继续下一个任务
- 支持同一聊天内任务串行、不同聊天按配置并行
- 支持 `/help`、`/status`、`/reset`、`/abort <任务号>`，其中 `/abort` 可终止运行中任务或取消排队任务
- 支持本地状态持久化到 `.codex-feishu-bridge/state.json`，包含会话、任务编号、排队快照和重启中断任务
- 支持按聊天和用户维度限制待处理任务数量
- 健康检查会输出飞书 HTTP/WS 请求指标、重试和最近错误信息

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
FEISHU_REPLY_TO_MESSAGE_ENABLED=true
FEISHU_INTERACTIVE_CARDS_ENABLED=true
FEISHU_REQUEST_TIMEOUT_MS=10000
FEISHU_REQUEST_RETRIES=2
FEISHU_REQUEST_RETRY_DELAY_MS=300

CODEX_WORKSPACE_DIR=/home/jingqi/workspace/your-project
CHAT_WORKSPACE_MAPPINGS="group:oc_xxx=/home/jingqi/workspace/project-a;group:oc_yyy=/home/jingqi/workspace/project-b"
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
MAX_QUEUED_TASKS_PER_CHAT=5
MAX_QUEUED_TASKS_PER_USER=10
AUTO_COMMIT_AFTER_TASK_ENABLED=true
AUTO_COMMIT_MESSAGE_PREFIX="bridge: save"
```

## 飞书侧配置

1. 创建一个企业自建应用，并开启机器人能力
2. 在事件与回调中添加事件：`im.message.receive_v1`
3. 如果启用卡片按钮，再额外订阅卡片按钮回调事件
4. 在“订阅方式”中选择“使用长连接接收事件/回调”
5. 不需要配置公网请求地址
6. 把应用安装到企业，并确保机器人可以被私聊/被群聊 @

## 运行

```bash
npm start
```

健康检查：

```bash
curl http://127.0.0.1:3000/healthz
```

`CODEX_COMMAND` 可用于覆盖默认启动命令；未配置时才回退到 `CODEX_BIN` 或默认 `codex`。

开启 `FEISHU_STREAM_OUTPUT_ENABLED=true` 后，桥接器会把中间 `agent_message` 和命令状态更新到同一张任务卡片。可用 `FEISHU_STREAM_COMMAND_STATUS_ENABLED` 控制是否展示命令开始/结束提示，用 `FEISHU_STREAM_UPDATE_MIN_INTERVAL_MS` 控制最小更新间隔，避免刷屏。

开启 `FEISHU_REPLY_TO_MESSAGE_ENABLED=true` 后，桥接器会回复到原消息。开启 `FEISHU_INTERACTIVE_CARDS_ENABLED=true` 后，任务接收、进度和完成状态会复用同一张共享卡片；`/status` 也会返回交互卡片。

`CHAT_WORKSPACE_MAPPINGS` 支持用 `chatKey=/abs/path` 或 `chat_id=/abs/path` 按会话映射工作目录，条目之间用分号分隔。开启 `AUTO_COMMIT_AFTER_TASK_ENABLED=true` 后，桥接器会在每个任务结束后先执行自动提交，再继续下一个任务；因此会强制串行执行任务。

`FEISHU_REQUEST_TIMEOUT_MS`、`FEISHU_REQUEST_RETRIES` 和 `FEISHU_REQUEST_RETRY_DELAY_MS` 用于控制飞书 HTTP 请求的超时和重试。`MAX_QUEUED_TASKS_PER_CHAT`、`MAX_QUEUED_TASKS_PER_USER` 用于限制待处理任务数量，防止单个聊天或用户积压过多任务。

运行测试：

```bash
npm test
```

## 测试记录

- 已用真实飞书凭据成功调用 `auth/v3/tenant_access_token/internal`
- 已用真实飞书凭据成功调用 `/callback/ws/endpoint`
- 已本地启动长连接客户端，状态页返回 `transport: "feishu-ws"`
- 还没有用真实飞书聊天消息做最终回路验证；这一步依赖应用在飞书后台已开启长连接订阅，并且机器人已安装且可收消息

## 建议的后续版本

- 增加更细粒度的工作目录路由规则，例如按用户或按消息前缀切换
- 增加自动 push / PR 工作流，但应和自动 commit 解耦
- 增加任务历史查询与卡片归档能力，便于跨重启追踪执行结果
