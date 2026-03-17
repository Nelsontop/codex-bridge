# ADR-001: 核心层与插件适配层边界

## 状态
已接受

## 背景
当前桥接服务把渠道接入（飞书）、CLI 执行（codex）、任务编排、命令路由和状态持久化耦合在同一个服务中。随着目标扩展到多 CLI（claude code/opencode/kimi-cli）和多渠道（钉钉/Telegram），直接在现有结构上叠加逻辑会持续放大改造成本与回归风险。

## 决策
保持模块化单体，不拆微服务。新增分层边界：

- `core`：定义任务编排与 provider/adapter 契约，不依赖具体 CLI 或 IM 渠道。
- `providers/cli`：各 CLI 执行器适配，实现统一 `CliProvider` 接口。
- `providers/channel`：各消息渠道适配，实现统一 `ChannelAdapter` 接口。
- `bridge-service`：聚焦业务流程，依赖契约而非具体实现。

V1 先支持全局单选 CLI（配置切换），但保留 `resolveProvider(chatKey)` 形态，为后续按聊天/群组选择 CLI 预留扩展位。

## 影响
更容易：
- 引入新 CLI 或新渠道时只增量开发 provider/adapter。
- 对任务编排和渠道接入分别测试，降低回归范围。
- 后续从模块化单体演进为服务化时边界清晰。

更困难：
- 初期需要补齐契约、注册与装配层，重构成本高于直接堆逻辑。
- 短期文件数量和抽象层次增加，需要更严格的测试约束。
