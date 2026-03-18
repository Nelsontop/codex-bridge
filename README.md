# Agent Bridge

本项目把渠道消息转为本机 CLI 任务执行，并把进度/结果回传原渠道。

目标：让你在 5 分钟内跑起来。

## 1. 你需要准备什么

- Node.js `>=18.18`
- 本机可执行的 CLI（默认 `codex`）
- 飞书企业自建应用（开启机器人）
- 可选：`gh`（如果你要在 `/bind` 时自动建 GitHub 仓库）

## 2. 最快启动（推荐路径）

1. 安装依赖

```bash
npm install
```

2. 生成配置

```bash
npm run setup
```

3. 启动服务

```bash
npm start
```

4. 检查健康状态

```bash
curl http://127.0.0.1:3000/healthz
```

返回 `{"ok":true,...}` 即服务正常。

## 3. 飞书后台必须配置

在飞书开发者后台完成以下 4 项：

1. 开启机器人能力
2. 安装应用到企业
3. 订阅事件：
   - `im.message.receive_v1`
   - `im.chat.member.bot.added_v1`
   - `card.action.trigger`
4. 订阅方式选择：`使用长连接接收事件/回调`

## 4. `.env` 最小可用配置

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_BOT_OPEN_ID=ou_xxx

HOST=127.0.0.1
PORT=3000

CODEX_WORKSPACE_DIR=/home/you/workspace/default-project
WORKSPACE_ALLOWED_ROOTS=/home/you/workspace

CLI_PROVIDER=codex
CHANNEL_PROVIDER=feishu
```

### 必填项说明（简版）

- `FEISHU_APP_ID` / `FEISHU_APP_SECRET`：飞书凭据
- `CODEX_WORKSPACE_DIR`：默认执行目录（私聊默认使用）
- `WORKSPACE_ALLOWED_ROOTS`：群聊 `/bind` 允许绑定的根目录

## 5. 聊天里怎么用

### 私聊机器人

- 直接发送任务文本即可

### 群聊

1. 先执行：

```text
/bind /你的工作目录 [可选仓库名]
```

2. 再 `@机器人` 发送任务

### 常用命令

- `/help`：查看帮助
- `/status`：查看当前聊天状态
- `/reset`：清空当前聊天 session（保留绑定目录）
- `/abort <任务号>`：取消任务
- `/retry [任务号]`：重试中断任务
- `/choose <选项ID>`：继续交互式任务

## 6. Provider 配置（V1）

当前架构是 `core + providers`，但运行时是“全局单选”。

### CLI_PROVIDER

支持值：

- `codex`（默认）
- `claude-code`
- `opencode`
- `kimi-cli`

按需补充命令：

- `CLAUDE_CODE_COMMAND` / `CLAUDE_CODE_ADDITIONAL_ARGS`
- `OPENCODE_COMMAND` / `OPENCODE_ADDITIONAL_ARGS`
- `KIMI_CLI_COMMAND` / `KIMI_CLI_ADDITIONAL_ARGS`

会话续跑说明：

- 仅支持会话续跑的 provider 会复用历史 `session`（当前默认 `codex`）。
- 不支持续跑的 provider（如 `claude-code` / `opencode` / `kimi-cli`）会按单任务执行，不复用上一轮 `session`，也不会触发上下文压缩。

### CHANNEL_PROVIDER

支持值：

- `feishu`（可用）

## 7. 健康检查与观测

访问：

```bash
curl http://127.0.0.1:${PORT:-3000}/healthz
```

重点字段：

- `ok`
- `transport`（由 `CHANNEL_PROVIDER` 对应 adapter 上报；当前 `feishu` 为 `feishu-ws`）
- `channelProvider`
- `cliProvider`
- `queuedTasks` / `runningTasks`
- `feishu` / `ws` / `reconnect`

## 8. 常用运行命令

- 开发模式：

```bash
npm run dev
```

- 测试：

```bash
npm test
```

- 安装 systemd 用户服务：

```bash
npm run service:install
```

- 查看日志：

```bash
npm run service:logs
```

## 9. 最常见问题（速查）

### 1) 群里 `@` 了机器人但没反应

优先检查：

- 是否真的 `@` 到机器人
- 飞书后台事件是否都已订阅
- 是否使用了“长连接接收事件”

### 2) 一直提示先 `/bind`

说明当前群未绑定目录，执行：

```text
/bind /你的工作目录
```

### 3) `/healthz` 访问不到

检查：

- 服务是否真的启动成功
- `HOST` / `PORT` 是否改过
- 端口是否被占用

## 10. 项目结构（只看核心）

- [`src/index.js`](/vol3/1000/workspace/codex-bridge/src/index.js)：入口与装配
- [`src/application/bridge-service.js`](/vol3/1000/workspace/codex-bridge/src/application/bridge-service.js)：应用服务，负责消息处理、队列、状态机
- [`src/domain/`](/vol3/1000/workspace/codex-bridge/src/domain)：领域规则与策略
- [`src/infrastructure/`](/vol3/1000/workspace/codex-bridge/src/infrastructure)：外部系统适配（CLI、飞书、状态持久化、系统服务）
- [`src/core/`](/vol3/1000/workspace/codex-bridge/src/core)：契约与任务编排
- [`src/providers/cli/`](/vol3/1000/workspace/codex-bridge/src/providers/cli)：CLI provider
- [`src/providers/channel/`](/vol3/1000/workspace/codex-bridge/src/providers/channel)：渠道 adapter
- [`test/`](/vol3/1000/workspace/codex-bridge/test)：Node 内置测试

## 11. 安全边界

- 删除/清空类操作需明确确认
- 建议设置 `FEISHU_ALLOWED_OPEN_IDS` 限制使用者
- 建议保留 `CODEX_SANDBOX=workspace-write`

---

如果你只想先跑通：按第 2、3、4、5 节执行即可。
