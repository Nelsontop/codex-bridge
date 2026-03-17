# Codex Feishu Bridge

一个运行在本地机器上的桥接服务：通过飞书长连接接收机器人事件，把聊天消息转成 `codex exec` / `codex exec resume` 任务，再把执行进度和结果回传到飞书。

它适合这些场景：

- 在飞书里直接驱动本机上的 Codex CLI
- 按聊天维度复用 Codex session，而不是每条消息都重新开上下文
- 为群聊绑定固定工作目录，并在首次绑定时顺手初始化 Git / GitHub 仓库

## 核心能力

- 私聊直接发送文本任务
- 群聊通过 `@机器人` 发送任务
- 同一聊天自动复用 Codex session
- 群聊通过 `/bind <工作目录> [仓库名]` 绑定固定目录
- `/bind` 目录受 `WORKSPACE_ALLOWED_ROOTS` 白名单约束
- 绑定时自动初始化本地 Git 仓库，并在可用时调用 `gh repo create --public`
- 任务过程通过飞书消息或共享卡片持续更新
- 支持 `/help`、`/status`、`/reset`、`/abort`、`/retry`、`/choose`
- 本地持久化聊天状态、排队任务、交互选项和上下文记忆
- 可选任务完成后自动 Git 提交

## 运行前提

- Node.js 18.18 或更高版本
- 本机已安装 `codex`
- 已有飞书企业自建应用，并开启机器人能力
- 如果要自动创建 GitHub 公共仓库，本机还需要安装并登录 `gh`

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 生成 `.env`

```bash
npm run setup
```

向导会生成或补全项目根目录下的 `.env`。

### 3. 配置飞书应用

至少完成这些设置：

1. 开启机器人能力
2. 安装应用到企业
3. 在“事件与回调”中订阅：
   - `im.message.receive_v1`
   - `im.chat.member.bot.added_v1`
   - `card.action.trigger`
4. 订阅方式选择“使用长连接接收事件/回调”

### 4. 启动服务

```bash
npm start
```

如果你要让服务在终端断开后仍然常驻，优先用 `systemd --user`：

```bash
npm run service:install
```

安装后可用这些命令管理：

```bash
npm run service:status
npm run service:restart
npm run service:logs
```

### 5. 验证健康检查

```bash
curl http://127.0.0.1:3000/healthz
```

如果你在 `.env` 中修改了 `HOST` 或 `PORT`，这里也要跟着调整。

### 6. 在飞书里验证

- 私聊机器人，直接发送文本任务
- 把机器人拉进群
- 第一次进群后先执行 `/bind`
- 绑定成功后，在群里 `@机器人` 发送任务

## 典型流程

### 私聊

1. 用户发送文本消息
2. Bridge 创建或恢复该私聊对应的 Codex session
3. Codex 在默认工作目录执行任务
4. 结果通过文本或卡片回到飞书

### 群聊

1. 机器人首次被拉进群
2. Bridge 提示执行 `/bind <工作目录> [仓库名]`
3. 绑定成功后，把群与本地目录持久化关联
4. 后续该群所有任务都固定在该目录执行
5. `/reset` 只清空 session，不取消目录绑定

如果目录里有空格，可以这样写：

```text
/bind "/vol3/1000/workspace/Project A" project-a
```

## 命令说明

- `/help`：查看帮助
- `/bind <工作目录> [仓库名]`：绑定当前群组目录并准备 Git / GitHub 仓库
- `/status`：查看当前聊天的工作目录、session、队列和中断任务
- `/reset`：清空当前聊天的 Codex session，保留工作目录绑定
- `/abort <任务号>`：终止运行中的任务，或取消排队任务
- `/retry [任务号]`：重试当前聊天最近的中断任务，或指定任务
- `/choose <选项ID>`：继续等待用户选择的任务

其余文本会直接作为任务发送给 Codex。

## 配置说明

项目根目录使用 `.env` 配置。下面是一份最常用的起步配置：

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_BOT_OPEN_ID=ou_xxx

HOST=127.0.0.1
PORT=3000

CODEX_WORKSPACE_DIR=/home/you/workspace/default-project
WORKSPACE_ALLOWED_ROOTS=/home/you/workspace
GITHUB_REPO_OWNER=
CHAT_WORKSPACE_MAPPINGS=

CODEX_COMMAND=codex
CLI_PROVIDER=codex
CODEX_MODEL=
CODEX_PROFILE=

AUTO_COMMIT_AFTER_TASK_ENABLED=false
AUTO_COMMIT_MESSAGE_PREFIX="bridge: save"
```

### 必填项

- `FEISHU_APP_ID` / `FEISHU_APP_SECRET`：飞书应用凭据
- `CODEX_WORKSPACE_DIR`：默认工作目录；私聊和未单独映射的聊天都使用它

### 常用项

- `FEISHU_BOT_OPEN_ID`：群聊中精确判断是否 `@` 到机器人时建议填写
- `FEISHU_ALLOWED_OPEN_IDS`：限制允许使用机器人的用户；不填则不限制
- `WORKSPACE_ALLOWED_ROOTS`：允许 `/bind` 使用的目录根路径；默认至少应覆盖 `CODEX_WORKSPACE_DIR`
- `GITHUB_REPO_OWNER`：`/bind` 创建 GitHub 仓库时使用的 owner；不填则使用当前 `gh` 登录用户
- `CHAT_WORKSPACE_MAPPINGS`：静态聊天目录映射，格式 `chatKey=/abs/path;chat_id=/abs/path`
- `CODEX_COMMAND`：覆盖默认 `codex` 启动命令，支持带参数
- `CLI_PROVIDER`：选择当前全局 CLI provider（V1 仅支持 `codex`）
- `CODEX_MODEL` / `CODEX_PROFILE`：需要固定模型或 profile 时再填

### 可选调优项

下面这些配置在代码中都支持，默认值通常已经够用：

- `ENABLE_HEALTH_SERVER`
- `STATE_DIR`
- `FEISHU_REQUIRE_MENTION_IN_GROUP`
- `FEISHU_REPLY_TO_MESSAGE_ENABLED`
- `FEISHU_INTERACTIVE_CARDS_ENABLED`
- `FEISHU_STREAM_OUTPUT_ENABLED`
- `FEISHU_STREAM_COMMAND_STATUS_ENABLED`
- `FEISHU_STREAM_UPDATE_MIN_INTERVAL_MS`
- `FEISHU_REQUEST_TIMEOUT_MS`
- `FEISHU_REQUEST_RETRIES`
- `FEISHU_REQUEST_RETRY_DELAY_MS`
- `MAX_CONCURRENT_TASKS`
- `MAX_QUEUED_TASKS_PER_CHAT`
- `MAX_QUEUED_TASKS_PER_USER`
- `MAX_REPLY_CHARS`
- `TASK_ACK_ENABLED`
- `CODEX_SANDBOX`
- `CODEX_APPROVAL_POLICY`
- `CODEX_ADDITIONAL_ARGS`
- `CODEX_SKIP_GIT_REPO_CHECK`
- `CODEX_PRELUDE`
- `CONTEXT_COMPACT_ENABLED`
- `CONTEXT_COMPACT_THRESHOLD`
- `CONTEXT_MEMORY_LOAD_FRACTION`
- `CONTEXT_WINDOW_FALLBACK_TOKENS`

如果你不确定是否需要这些开关，先使用默认值。

## 项目结构

运行时代码在 [`src/`](/vol3/1000/workspace/codex-bridge/src)：

V1 重构后采用 `core + providers` 分层：

- `src/core/`：核心契约与任务编排（与具体 CLI/渠道解耦）
- `src/providers/cli/`：CLI 适配层（当前含 `codex`）
- `src/providers/channel/`：渠道适配层（当前含 `feishu`）

- [`src/index.js`](/vol3/1000/workspace/codex-bridge/src/index.js)：进程入口，加载配置、启动健康检查与飞书长连接
- [`src/bridge-service.js`](/vol3/1000/workspace/codex-bridge/src/bridge-service.js)：事件分发、任务队列、状态同步、交互处理
- [`src/bridge-command-router.js`](/vol3/1000/workspace/codex-bridge/src/bridge-command-router.js)：`/bind`、`/status`、`/reset` 等命令路由
- [`src/codex-runner.js`](/vol3/1000/workspace/codex-bridge/src/codex-runner.js)：封装 `codex exec` / `codex exec resume`
- [`src/feishu-client.js`](/vol3/1000/workspace/codex-bridge/src/feishu-client.js)：调用飞书 HTTP API 发送消息和更新卡片
- [`src/feishu-ws-client.js`](/vol3/1000/workspace/codex-bridge/src/feishu-ws-client.js)：管理飞书长连接事件流
- [`src/state-store.js`](/vol3/1000/workspace/codex-bridge/src/state-store.js)：持久化聊天状态和运行时快照
- [`src/workspace-binding.js`](/vol3/1000/workspace/codex-bridge/src/workspace-binding.js)：目录绑定、Git 初始化、GitHub 仓库创建
- [`src/workspace-policy.js`](/vol3/1000/workspace/codex-bridge/src/workspace-policy.js)：校验 `/bind` 目标目录是否命中允许范围
- [`src/git-commit.js`](/vol3/1000/workspace/codex-bridge/src/git-commit.js)：可选自动提交与失败回滚
- [`src/init-guide.js`](/vol3/1000/workspace/codex-bridge/src/init-guide.js)：`npm run setup` 初始化向导

测试文件在 [`test/`](/vol3/1000/workspace/codex-bridge/test)。

本地状态默认写入：

- `.codex-feishu-bridge/state.json`
- `.codex-feishu-bridge/memory/`

## 开发与运维

### 本地开发

```bash
npm run dev
```

### 生产式启动

```bash
npm start
```

### 常驻后台启动（systemd --user）

适用前提：

- Linux，且宿主机使用 `systemd`
- 当前用户可执行 `systemctl --user`

安装并立即启动：

```bash
npm run service:install
```

这会把 unit 写到：

```text
~/.config/systemd/user/codex-feishu-bridge.service
```

常用管理命令：

```bash
npm run service:status
npm run service:start
npm run service:stop
npm run service:restart
npm run service:logs
npm run service:remove
```

如果你希望在“没有任何登录会话”时也继续常驻，例如 SSH 退出后仍保活，再额外执行：

```bash
loginctl enable-linger "$USER"
```

如果这个前提不成立会怎样？

- `systemctl --user` 不可用时，`npm run service:install` 会直接失败
- 没启用 linger 时，服务通常能跨终端存活，但未必能跨“最后一个用户会话退出”

### 健康检查

```bash
curl http://127.0.0.1:${PORT:-3000}/healthz
```

健康检查会返回：

- 当前会话数
- 排队和运行中的任务数
- 中断任务数
- 飞书 HTTP / WS 指标
- 最近重连信息

## 测试

运行测试：

```bash
npm test
```

当前仓库包含 Node 内置测试，覆盖：

- Bridge 路由与任务队列
- Codex runner 的取消和恢复
- 命令解析
- Feishu HTTP / WS 客户端
- 初始化向导
- Git 自动提交
- 工作目录绑定策略

对于涉及飞书真实环境的改动，仍建议补做一次手工验证：

1. 启动服务
2. 访问 `/healthz`
3. 用真实机器人完成一次私聊任务
4. 在群聊里执行一次 `/bind` 和一次普通任务

## 常见问题

### 群里发消息没反应

优先检查：

- 是否真的 `@` 到机器人
- 是否开启了 `FEISHU_REQUIRE_MENTION_IN_GROUP`
- 飞书后台是否已订阅 `im.message.receive_v1`
- 订阅方式是否确实是长连接

### 群里一直提示先 `/bind`

说明当前群还没有工作目录绑定，或者绑定信息被清掉了。直接执行：

```text
/bind /你的工作目录 仓库名
```

### `/bind` 失败

常见原因：

- 目录路径无效，或不在 `WORKSPACE_ALLOWED_ROOTS` 白名单内
- `git commit` 失败，本机未配置 `user.name` / `user.email`
- `gh` 未登录
- GitHub 上仓库名已存在，且当前账号无权创建

### 健康检查访问不到

检查：

- `.env` 里的 `HOST` 和 `PORT`
- `ENABLE_HEALTH_SERVER` 是否被关闭
- 服务是否已成功启动

### 任务执行到一半后服务重启

Bridge 会把运行快照写到 `.codex-feishu-bridge/state.json`。重启后：

- 排队任务会恢复
- 运行中的任务会被标记为中断
- 可以通过 `/retry` 重新入队

## 安全边界

- 默认要求删除、清空、销毁类操作前必须明确确认
- 可以通过 `FEISHU_ALLOWED_OPEN_IDS` 限制使用者
- 默认使用 `CODEX_APPROVAL_POLICY=never`
- 默认使用 `CODEX_SANDBOX=workspace-write`
- `/bind` 只能落到 `WORKSPACE_ALLOWED_ROOTS` 允许的目录中

## 当前限制

- 当前只支持文本消息
- 当前依赖飞书长连接模式
- 任务结果主要通过更新消息或共享卡片呈现，不会为每次状态变化都发送新消息
