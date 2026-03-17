# CLI/Channel Plugin V1 Migration Notes

## 变更摘要

- 引入 `core + providers` 分层，解耦任务编排与外部适配。
- 增加 `CLI_PROVIDER` 配置项（V1 仅支持 `codex`）。
- `BridgeService` 通过 `TaskOrchestrator` 调用 CLI provider。
- 启动入口改为 `FeishuChannelAdapter` 装配飞书 HTTP + WS 能力。

## 目录变化

- 新增 `src/core/cli-provider.js`
- 新增 `src/core/task-orchestrator.js`
- 新增 `src/core/channel-adapter.js`
- 新增 `src/providers/cli/codex-provider.js`
- 新增 `src/providers/channel/feishu/adapter.js`

## 配置兼容性

- `CLI_PROVIDER` 默认为 `codex`。
- 未设置 `CLI_PROVIDER` 时行为与旧版本一致。
- 设置不支持的 provider 会在启动时报错并退出。

## 健康检查兼容性

`/healthz` 的以下字段保持兼容：

- `transport`
- `feishu`
- `reconnect`
- `ws`
- 任务计数与上下文字段

## 后续扩展建议

- 新增 CLI 时，仅需在 `src/providers/cli/<name>-provider.js` 实现契约并注册。
- 新增渠道时，在 `src/providers/channel/<name>/` 实现 adapter，保持 `sendText/sendCard/updateCard/start/getMetrics` 语义一致。
- 按聊天/群组选择 CLI 时，优先在 `TaskOrchestrator.resolveProvider(chatKey)` 与 conversation 状态字段扩展，不要改动核心任务状态机。
