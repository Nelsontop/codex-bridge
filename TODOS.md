# TODOS

## Application

### 拆分 Message Dispatch 流程

**What:** 从 `BridgeService` 提取消息解析、鉴权、去重、命令/任务分流逻辑到独立模块。

**Why:** 降低 `bridge-service.js` 超大文件带来的修改风险，缩小变更 blast radius。

**Context:** 当前 `BridgeService` 同时承担事件入口和任务执行编排，导致职责混杂；本项是最小收敛重构的第一步。

**Effort:** M
**Priority:** P1
**Depends on:** None

### 提取 Task Execution 纯函数流程

**What:** 将 provider 解析、session 策略、interaction 持久化、finalize 逻辑提取为纯函数并显式注入依赖。

**Why:** 提高可测试性，避免新增“持有全局上下文”的 God service。

**Context:** 你已确认采用纯函数形态（explicit dependencies）作为本轮重构基线。

**Effort:** M
**Priority:** P1
**Depends on:** 拆分 Message Dispatch 流程

### 合并任务摘要为单一实现

**What:** 统一 `summarizeTaskPrompt` 实现，消除 `bridge-service.js` 与 `task-runtime.js` 的重复与行为漂移。

**Why:** 保证任务命名一致性并减少后续维护成本。

**Context:** 当前存在两份不一致实现；重构过程中应抽到单一模块并复用。

**Effort:** S
**Priority:** P1
**Depends on:** None

### 优化队列调度扫描复杂度

**What:** 将 `dequeueNextRunnable` 从重复计数扫描改为基于一次性 `chatKey -> runningCount` map 的线性调度。

**Why:** 避免队列增长时潜在 O(n²) 扫描放大。

**Context:** 目前规模可运行，但这是低成本可逆优化，适合在本轮收敛重构中一起落地。

**Effort:** S
**Priority:** P2
**Depends on:** None

### 补齐行为一致性契约测试

**What:** 增加 dispatch/execution 层的黑盒契约测试，验证拆分前后行为等价。

**Why:** 在结构重排中防止功能回归，是“重构可交付”的底线。

**Context:** 重点覆盖 non-resume provider、interaction `/choose`、abort/rollback、限流与重复抑制。

**Effort:** M
**Priority:** P1
**Depends on:** 拆分 Message Dispatch 流程, 提取 Task Execution 纯函数流程

## Completed
