import test from "node:test";
import assert from "node:assert/strict";
import { runTaskExecution } from "../src/application/task-execution.js";

test("runTaskExecution keeps session empty for non-resume providers", async () => {
  const events = [];
  const conversationPatches = [];
  const task = {
    id: "T001",
    chatKey: "p2p:oc_test",
    prompt: "hello",
    sessionId: "legacy_session",
    workspaceDir: "/tmp/workspace",
    target: { chatId: "oc_test", replyToMessageId: "" },
    senderOpenId: "ou_test",
    streamChain: Promise.resolve(),
    recovered: false,
    abortRequested: false
  };
  const ctx = {
    autoCommitWorkspace: async () => ({ status: "disabled" }),
    buildFinalText: () => "",
    buildInteractionText: () => "",
    buildPromptWithMemory: (prompt) => prompt,
    compactConversationContext: async () => ({ performed: false }),
    config: {
      contextCompactEnabled: true,
      feishuInteractiveCardsEnabled: true,
      maxReplyChars: 200
    },
    ensureTaskNotAborted() {},
    finalizeTask: async () => {},
    formatAutoCommitResult: () => "",
    formatAutoCommitRollbackResult: () => "",
    handleRunnerEvent() {},
    markTaskCompleted(targetTask, result) {
      targetTask.finalMessage = result.finalMessage;
      targetTask.sessionId = result.sessionId || "";
      targetTask.status = "completed";
    },
    markTaskFailed(targetTask, error) {
      targetTask.status = "failed";
      targetTask.lastErrorMessage = String(error?.message || error);
    },
    markTaskRunning(targetTask) {
      targetTask.status = "running";
      targetTask.startedAt = "2026-03-18T00:00:00.000Z";
    },
    metrics: {},
    parseInteractionRequest: () => null,
    registerPendingInteraction: async () => {
      throw new Error("not expected");
    },
    resolveTaskProvider: () => ({ name: "opencode", supportsResume: false }),
    resolveCliProviderName: () => "opencode",
    rollbackAutoCommitWorkspace: async () => ({ status: "skipped" }),
    runtime: {
      start() {},
      finish() {}
    },
    safeSend: async (_target, text) => {
      events.push(text);
    },
    store: {
      getConversation: () => ({ sessionId: "old", workspaceDir: "/tmp/workspace" }),
      upsertConversation(_chatKey, patch) {
        conversationPatches.push(patch);
      }
    },
    syncTaskCard: async () => {},
    taskOrchestrator: {
      runTask({ taskOptions }) {
        assert.equal(taskOptions.sessionId, "");
        return {
          cancel() {},
          result: Promise.resolve({
            finalMessage: "done",
            sessionId: "provider_session"
          })
        };
      }
    }
  };

  await runTaskExecution(ctx, task);
  assert.equal(task.status, "completed");
  assert.equal(conversationPatches.at(-1)?.sessionId || "", "");
  assert.equal(events.length, 0);
});
