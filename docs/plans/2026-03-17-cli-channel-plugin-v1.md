# CLI/Channel Plugin V1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在不破坏现有飞书+codex行为的前提下，完成插件化核心重构，并支持“全局单选 CLI（配置切换）”。

**Architecture:** 保持模块化单体，新增 `core + providers` 分层。核心层负责任务编排与接口契约，`providers/cli` 与 `providers/channel` 负责外部适配。V1 仅启用一个全局 CLI provider，但接口保留 `resolveProvider(chatKey)` 入口，便于后续升级到按群组选择。

**Tech Stack:** Node.js 18 ESM, Node built-in test runner (`node --test`), 现有 Feishu SDK 与本地状态存储。

---

### Task 1: Add ADR For Refactor Boundary

**Files:**
- Create: `docs/adr/ADR-001-core-plugin-boundary.md`

**Step 1: Write ADR document**

写入以下结构：背景（当前耦合）、决策（核心/适配层分离）、影响（收益与成本）、可逆性（仍为单体）。

**Step 2: Verify document exists**

Run: `test -f docs/adr/ADR-001-core-plugin-boundary.md && echo OK`
Expected: `OK`

**Step 3: Commit**

Run: `git add docs/adr/ADR-001-core-plugin-boundary.md && git commit -m "docs: add ADR for plugin boundary"`

### Task 2: Define CLI Provider Contract

**Files:**
- Create: `src/core/cli-provider.js`
- Create: `test/cli-provider-contract.test.js`

**Step 1: Write failing test**

在 `test/cli-provider-contract.test.js` 添加契约测试：provider 必须实现 `name`、`runTask()`、`supportsResume`。

**Step 2: Run test to verify it fails**

Run: `node --test test/cli-provider-contract.test.js`
Expected: FAIL（模块不存在或导出不完整）

**Step 3: Write minimal implementation**

在 `src/core/cli-provider.js` 导出 `assertCliProvider(provider)` 与 `createCliProviderRegistry()`。

**Step 4: Run test to verify it passes**

Run: `node --test test/cli-provider-contract.test.js`
Expected: PASS

**Step 5: Commit**

Run: `git add src/core/cli-provider.js test/cli-provider-contract.test.js && git commit -m "feat: add CLI provider contract"`

### Task 3: Wrap Existing Codex Runner As Codex Provider

**Files:**
- Create: `src/providers/cli/codex-provider.js`
- Modify: `src/codex-runner.js`
- Modify: `test/codex-runner.test.js`

**Step 1: Write failing test**

为 `codex-provider` 增加测试：调用 provider 后仍透传到现有 runner，返回 `cancel` 和 `result`。

**Step 2: Run test to verify it fails**

Run: `node --test test/codex-runner.test.js`
Expected: FAIL（provider 未接入）

**Step 3: Write minimal implementation**

新增 `createCodexProvider(config)`，内部调用 `runCodexTask`；声明 `name: "codex"`、`supportsResume: true`。

**Step 4: Run test to verify it passes**

Run: `node --test test/codex-runner.test.js`
Expected: PASS

**Step 5: Commit**

Run: `git add src/providers/cli/codex-provider.js src/codex-runner.js test/codex-runner.test.js && git commit -m "feat: add codex CLI provider"`

### Task 4: Add Global CLI Selection In Config

**Files:**
- Modify: `src/config.js`
- Create: `test/config-cli-provider.test.js`

**Step 1: Write failing test**

新增配置测试：
- 默认 `cliProvider = "codex"`
- 设置 `CLI_PROVIDER=codex` 生效
- 非法值时报错

**Step 2: Run test to verify it fails**

Run: `node --test test/config-cli-provider.test.js`
Expected: FAIL

**Step 3: Write minimal implementation**

在 `loadConfig` 中新增 `cliProvider` 字段并校验；当前允许值先仅 `codex`。

**Step 4: Run test to verify it passes**

Run: `node --test test/config-cli-provider.test.js`
Expected: PASS

**Step 5: Commit**

Run: `git add src/config.js test/config-cli-provider.test.js && git commit -m "feat: support global CLI provider config"`

### Task 5: Introduce Task Orchestrator Skeleton

**Files:**
- Create: `src/core/task-orchestrator.js`
- Modify: `src/bridge-service.js`
- Modify: `test/bridge-service.test.js`

**Step 1: Write failing test**

新增桥接测试：`BridgeService` 通过 orchestrator 调用 provider，而不是直接依赖 `runCodexTask`。

**Step 2: Run test to verify it fails**

Run: `node --test test/bridge-service.test.js`
Expected: FAIL

**Step 3: Write minimal implementation**

新增 orchestrator（先薄封装）：
- `enqueueTask`
- `pumpQueue`
- `runTaskWithProvider`

BridgeService 注入 orchestrator 实例并把现有流程迁移过去。

**Step 4: Run test to verify it passes**

Run: `node --test test/bridge-service.test.js`
Expected: PASS

**Step 5: Commit**

Run: `git add src/core/task-orchestrator.js src/bridge-service.js test/bridge-service.test.js && git commit -m "refactor: route task execution via orchestrator"`

### Task 6: Add Channel Adapter Contract (Feishu As First Adapter)

**Files:**
- Create: `src/core/channel-adapter.js`
- Create: `src/providers/channel/feishu/adapter.js`
- Modify: `src/index.js`
- Modify: `test/feishu-ws-client.test.js`

**Step 1: Write failing test**

增加契约测试：adapter 需实现 `start()`、`sendText()`、`sendCard()`、`updateCard()`、`getMetrics()`。

**Step 2: Run test to verify it fails**

Run: `node --test test/feishu-ws-client.test.js`
Expected: FAIL

**Step 3: Write minimal implementation**

实现 Feishu adapter 薄封装，`index.js` 改为通过 adapter 启动，而不是直接绑 `FeishuWsClient`。

**Step 4: Run test to verify it passes**

Run: `node --test test/feishu-ws-client.test.js`
Expected: PASS

**Step 5: Commit**

Run: `git add src/core/channel-adapter.js src/providers/channel/feishu/adapter.js src/index.js test/feishu-ws-client.test.js && git commit -m "refactor: introduce channel adapter contract"`

### Task 7: Preserve Backward Compatibility And Health Output

**Files:**
- Modify: `src/index.js`
- Modify: `test/bridge-service.test.js`

**Step 1: Write failing test**

校验 `/healthz` 返回结构保持兼容（`transport`、任务计数、ws/reconnect 指标仍存在）。

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL（健康结构变化未适配）

**Step 3: Write minimal implementation**

在新装配层补齐兼容字段，避免前端或运维脚本回归。

**Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

**Step 5: Commit**

Run: `git add src/index.js test/bridge-service.test.js && git commit -m "fix: keep health payload backward compatible"`

### Task 8: Docs And Migration Notes

**Files:**
- Modify: `README.md`
- Create: `docs/plans/2026-03-17-cli-channel-plugin-v1-migration.md`

**Step 1: Update docs**

补充：
- 新配置 `CLI_PROVIDER`
- 架构分层图（core/providers）
- V1 限制：全局单选 CLI

**Step 2: Verify docs readability**

Run: `node -e "console.log('docs check')"`
Expected: `docs check`

**Step 3: Commit**

Run: `git add README.md docs/plans/2026-03-17-cli-channel-plugin-v1-migration.md && git commit -m "docs: document plugin architecture and migration"`

### Task 9: Final Verification

**Files:**
- Modify: none

**Step 1: Run full tests**

Run: `npm test`
Expected: PASS

**Step 2: Run service boot smoke test**

Run: `npm start`
Expected: 进程正常启动，可访问 `http://127.0.0.1:3000/healthz`（或 `.env` 配置端口）

**Step 3: Manual message flow check**

在飞书私聊发送一条任务，确认能收到开始、进度、完成消息。

**Step 4: Commit release note**

Run: `git add -A && git commit -m "chore: finalize plugin architecture v1"`
