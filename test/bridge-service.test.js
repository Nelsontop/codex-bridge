import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { BridgeService } from "../src/bridge-service.js";

const FIXTURE_DIR = path.join(process.cwd(), "test", "fixtures");

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

function flattenEventEnvelope(payload) {
  return {
    ...(payload.header?.event_type
      ? { event_type: payload.header.event_type }
      : {}),
    ...(payload.event || {})
  };
}

function createConfig(overrides = {}) {
  return {
    chatWorkspaceMappings: new Map(),
    codexWorkspaceDir: "/tmp/codex-workspace",
    contextCompactEnabled: false,
    contextCompactThreshold: 0.8,
    contextMemoryLoadFraction: 0.1,
    contextMemoryDir: path.join(os.tmpdir(), "codex-bridge-memory-default"),
    contextWindowFallbackTokens: 128000,
    feishuAllowedOpenIds: new Set(),
    feishuBotOpenId: "",
    feishuInteractiveCardsEnabled: true,
    feishuReplyToMessageEnabled: true,
    feishuStreamCommandStatusEnabled: true,
    feishuStreamOutputEnabled: true,
    feishuStreamUpdateMinIntervalMs: 0,
    gitAutoCommitEnabled: false,
    maxConcurrentTasks: 2,
    maxQueuedTasksPerChat: 5,
    maxQueuedTasksPerUser: 10,
    maxReplyChars: 200,
    requireMentionInGroup: true,
    taskAckEnabled: true,
    ...overrides
  };
}

function createStore({ conversations = {}, runtime } = {}) {
  const state = {
    conversations: structuredClone(conversations),
    runtime: structuredClone(
      runtime || {
        interrupted: [],
        nextTaskNumber: 1,
        queue: [],
        running: []
      }
    )
  };

  return {
    clearConversation(chatKey) {
      delete state.conversations[chatKey];
    },
    conversationCount() {
      return Object.keys(state.conversations).length;
    },
    getConversation(chatKey) {
      return state.conversations[chatKey] || null;
    },
    getRuntimeSnapshot() {
      return structuredClone(state.runtime);
    },
    saveRuntimeSnapshot(runtimeSnapshot) {
      state.runtime = structuredClone(runtimeSnapshot);
      return this.getRuntimeSnapshot();
    },
    upsertConversation(chatKey, patch) {
      state.conversations[chatKey] = {
        ...(state.conversations[chatKey] || {}),
        ...patch
      };
      return state.conversations[chatKey];
    }
  };
}

function createClient() {
  let nextCardId = 1;

  return {
    cardUpdates: [],
    cards: [],
    texts: [],
    async sendCard(chatId, card, options = {}) {
      const payload = {
        data: {
          message_id: `om_card_${nextCardId++}`
        }
      };
      this.cards.push({ card, chatId, options, payload });
      return payload;
    },
    async sendText(chatId, text, options = {}) {
      const payload = {
        data: {
          message_id: `om_text_${this.texts.length + 1}`
        }
      };
      this.texts.push({ chatId, options, payload, text });
      return payload;
    },
    async updateCard(messageId, card) {
      this.cardUpdates.push({ card, messageId });
      return { data: {} };
    }
  };
}

function createRunnerController() {
  const calls = [];
  const pending = [];

  return {
    calls,
    pending,
    runCodexTask(_config, args) {
      let rejectResult;
      let resolveResult;
      const result = new Promise((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });

      const task = {
        args,
        cancel() {
          rejectResult(new Error("cancelled by test"));
        },
        reject: rejectResult,
        resolve: resolveResult
      };

      calls.push(args);
      pending.push(task);
      return {
        cancel() {
          task.cancel();
        },
        result
      };
    }
  };
}

async function waitFor(check, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Timed out while waiting for condition");
}

test("dispatchEvent tolerates malformed text payloads", async () => {
  const client = createClient();
  const bridge = new BridgeService(
    createConfig({ feishuInteractiveCardsEnabled: false, taskAckEnabled: false }),
    createStore(),
    client
  );

  await bridge.dispatchEvent({
    event: {
      message: {
        chat_id: "chat-1",
        chat_type: "p2p",
        content: "{invalid",
        message_id: "msg-1",
        message_type: "text"
      },
      sender: {
        sender_id: {
          open_id: "ou_123"
        },
        sender_type: "user"
      }
    }
  });

  assert.deepEqual(client.texts, [
    {
      chatId: "chat-1",
      options: {
        replyToMessageId: "msg-1"
      },
      payload: {
        data: {
          message_id: "om_text_1"
        }
      },
      text: "消息内容解析失败，暂不支持该消息格式。"
    }
  ]);
});

test("pumpQueue skips blocked tasks from the same chat", () => {
  const bridge = new BridgeService(createConfig(), createStore(), createClient());
  const startedTaskIds = [];

  bridge.running.set("T0001", {
    chatKey: "p2p:chat-a"
  });
  bridge.queue.push(
    { id: "T0002", chatKey: "p2p:chat-a" },
    { id: "T0003", chatKey: "p2p:chat-b" }
  );
  bridge.runTask = async (task) => {
    startedTaskIds.push(task.id);
    bridge.running.set(task.id, task);
  };

  bridge.pumpQueue();

  assert.deepEqual(startedTaskIds, ["T0003"]);
  assert.deepEqual(
    bridge.queue.map((task) => task.id),
    ["T0002"]
  );
});

test("abort command cannot cancel a task from another chat", async () => {
  const client = createClient();
  const bridge = new BridgeService(
    createConfig({ feishuInteractiveCardsEnabled: false }),
    createStore(),
    client
  );
  let cancelled = false;

  bridge.running.set("T0007", {
    chatKey: "p2p:chat-b",
    runner: {
      cancel() {
        cancelled = true;
      }
    }
  });

  await bridge.handleCommand({
    commandText: "/abort T0007",
    chatId: "chat-a",
    chatKey: "p2p:chat-a",
    target: {
      chatId: "chat-a",
      replyToMessageId: "msg-2"
    }
  });

  assert.equal(cancelled, false);
  assert.equal(client.texts[0].text, "当前聊天没有运行中的任务 T0007。");
});

test("real message event creates a shared card and resumes the existing session", async () => {
  const client = createClient();
  const runner = createRunnerController();
  const store = createStore({
    conversations: {
      "p2p:oc_test_chat": {
        sessionId: "thread_existing",
        workspaceDir: "/tmp/codex-workspace"
      }
    }
  });
  const bridge = new BridgeService(
    createConfig(),
    store,
    client,
    {
      autoCommitWorkspace: async () => ({ status: "disabled" }),
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );

  const payload = loadFixture("message.receive_v1.json");
  await bridge.dispatchEvent(payload);

  assert.equal(client.cards.length, 1);
  assert.equal(client.cards[0].card.header.title.content, "T001-请检查当前项目状态");
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].sessionId, "thread_existing");

  runner.pending[0].resolve({
    finalMessage: "任务已经完成",
    sessionId: "thread_new"
  });
  await waitFor(() => bridge.running.size === 0 && client.cardUpdates.length > 0);

  assert.equal(store.getConversation("p2p:oc_test_chat").sessionId, "thread_new");
  assert.equal(client.cardUpdates.at(-1).messageId, client.cards[0].payload.data.message_id);
});

test("flattened WS message event creates a task and resumes the existing session", async () => {
  const client = createClient();
  const runner = createRunnerController();
  const store = createStore({
    conversations: {
      "p2p:oc_test_chat": {
        sessionId: "thread_existing",
        workspaceDir: "/tmp/codex-workspace"
      }
    }
  });
  const bridge = new BridgeService(
    createConfig(),
    store,
    client,
    {
      autoCommitWorkspace: async () => ({ status: "disabled" }),
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );

  await bridge.dispatchEvent(flattenEventEnvelope(loadFixture("message.receive_v1.json")));

  assert.equal(client.cards.length, 1);
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].sessionId, "thread_existing");

  runner.pending[0].resolve({
    finalMessage: "任务已经完成",
    sessionId: "thread_new"
  });
  await waitFor(() => bridge.running.size === 0 && client.cardUpdates.length > 0);

  assert.equal(store.getConversation("p2p:oc_test_chat").sessionId, "thread_new");
});

test("card action can cancel a queued task created from a real event payload", async () => {
  const client = createClient();
  const runner = createRunnerController();
  const bridge = new BridgeService(
    createConfig({ maxConcurrentTasks: 1 }),
    createStore(),
    client,
    {
      autoCommitWorkspace: async () => ({ status: "disabled" }),
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );

  const payload = loadFixture("message.receive_v1.json");
  await bridge.dispatchEvent(payload);

  const secondPayload = loadFixture("message.receive_v1.json");
  secondPayload.event.message.message_id = "om_source_message_2";
  secondPayload.event.message.content = "{\"text\":\"请继续第二个任务\"}";
  await bridge.dispatchEvent(secondPayload);

  assert.equal(bridge.queue.length, 1);
  assert.equal(bridge.queue[0].id, "T002");

  const actionPayload = loadFixture("card.action.trigger.json");
  actionPayload.event.action.value.taskId = "T002";
  await bridge.dispatchEvent(actionPayload);

  assert.equal(bridge.queue.length, 0);
  assert.equal(
    client.cardUpdates.some((update) => update.messageId === client.cards[1].payload.data.message_id),
    true
  );

  runner.pending[0].resolve({
    finalMessage: "first done",
    sessionId: "thread_1"
  });
  await waitFor(() => bridge.running.size === 0);
});

test("abort command accepts the full task name", async () => {
  const client = createClient();
  const runner = createRunnerController();
  const bridge = new BridgeService(
    createConfig({ feishuInteractiveCardsEnabled: false, maxConcurrentTasks: 1 }),
    createStore(),
    client,
    {
      autoCommitWorkspace: async () => ({ status: "disabled" }),
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );

  const firstPayload = loadFixture("message.receive_v1.json");
  await bridge.dispatchEvent(firstPayload);

  const secondPayload = loadFixture("message.receive_v1.json");
  secondPayload.event.message.message_id = "om_source_message_2";
  secondPayload.event.message.content = "{\"text\":\"请继续第二个任务\"}";
  await bridge.dispatchEvent(secondPayload);

  await bridge.handleCommand({
    commandText: "/abort T002-请继续第二个任务",
    chatId: "oc_test_chat",
    chatKey: "p2p:oc_test_chat",
    target: {
      chatId: "oc_test_chat",
      replyToMessageId: "om_source_message_2"
    }
  });

  assert.equal(bridge.queue.length, 0);
  assert.equal(client.texts.at(-1).text, "已取消排队中的任务 T002-请继续第二个任务。");

  runner.pending[0].resolve({
    finalMessage: "first done",
    sessionId: "thread_1"
  });
  await waitFor(() => bridge.running.size === 0);
});

test("card action cancels a running task and skips auto commit", async () => {
  const client = createClient();
  const runner = createRunnerController();
  let autoCommitCalls = 0;
  const bridge = new BridgeService(
    createConfig({ maxConcurrentTasks: 1 }),
    createStore(),
    client,
    {
      autoCommitWorkspace: async () => {
        autoCommitCalls += 1;
        return { status: "committed", commitId: "abc123" };
      },
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );

  await bridge.dispatchEvent(loadFixture("message.receive_v1.json"));
  await waitFor(() => bridge.running.size === 1);

  const actionPayload = loadFixture("card.action.trigger.json");
  actionPayload.event.action.value.taskId = "T001";
  await bridge.dispatchEvent(actionPayload);

  await waitFor(() => bridge.running.size === 0);

  assert.equal(autoCommitCalls, 0);
  assert.equal(
    client.cardUpdates.some((update) => update.card.elements[0].text.content.includes("**状态**：已取消")),
    true
  );
});

test("flattened WS card action can cancel a queued task", async () => {
  const client = createClient();
  const runner = createRunnerController();
  const bridge = new BridgeService(
    createConfig({ maxConcurrentTasks: 1 }),
    createStore(),
    client,
    {
      autoCommitWorkspace: async () => ({ status: "disabled" }),
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );

  const payload = loadFixture("message.receive_v1.json");
  await bridge.dispatchEvent(payload);

  const secondPayload = loadFixture("message.receive_v1.json");
  secondPayload.event.message.message_id = "om_source_message_2";
  secondPayload.event.message.content = "{\"text\":\"请继续第二个任务\"}";
  await bridge.dispatchEvent(secondPayload);

  const actionPayload = loadFixture("card.action.trigger.json");
  actionPayload.event.action.value.taskId = "T002";
  await bridge.dispatchEvent(flattenEventEnvelope(actionPayload));

  assert.equal(bridge.queue.length, 0);
  assert.equal(
    client.cardUpdates.some((update) => update.messageId === client.cards[1].payload.data.message_id),
    true
  );

  runner.pending[0].resolve({
    finalMessage: "first done",
    sessionId: "thread_1"
  });
  await waitFor(() => bridge.running.size === 0);
});

test("successful task with no changes omits auto commit summary", async () => {
  const client = createClient();
  const runner = createRunnerController();
  const bridge = new BridgeService(
    createConfig({ feishuInteractiveCardsEnabled: false }),
    createStore(),
    client,
    {
      autoCommitWorkspace: async () => ({ status: "skipped", reason: "no-changes" }),
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );

  await bridge.dispatchEvent(loadFixture("message.receive_v1.json"));

  runner.pending[0].resolve({
    finalMessage: "任务已经完成",
    sessionId: "thread_new"
  });
  await waitFor(() => bridge.running.size === 0 && client.texts.length >= 2);

  assert.equal(client.texts.at(-1).text.includes("自动提交："), false);
});

test("resumeRecoveredTasks restores queued snapshots and surfaces interrupted tasks", async () => {
  const client = createClient();
  const runner = createRunnerController();
  const bridge = new BridgeService(
    createConfig(),
    createStore({
      runtime: {
        interrupted: [
          {
            cardMessageId: "om_card_interrupted",
            chatKey: "p2p:oc_test_chat",
            enqueuedAt: "2026-03-15T00:00:00.000Z",
            id: "T0004",
            lastErrorMessage: "服务重启前中断",
            prompt: "interrupted task",
            senderOpenId: "ou_user_a",
            status: "interrupted",
            target: {
              chatId: "oc_test_chat",
              replyToMessageId: "om_source_message_4"
            },
            workspaceDir: "/tmp/codex-workspace"
          }
        ],
        nextTaskNumber: 6,
        queue: [
          {
            chatKey: "p2p:oc_test_chat",
            enqueuedAt: "2026-03-15T00:00:00.000Z",
            id: "T0005",
            prompt: "recovered queued task",
            recovered: true,
            senderOpenId: "ou_user_a",
            status: "queued",
            target: {
              chatId: "oc_test_chat",
              replyToMessageId: "om_source_message_5"
            },
            workspaceDir: "/tmp/codex-workspace"
          }
        ],
        running: []
      }
    }),
    client,
    {
      autoCommitWorkspace: async () => ({ status: "disabled" }),
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );

  await bridge.resumeRecoveredTasks();

  assert.equal(client.cardUpdates[0].messageId, "om_card_interrupted");
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].prompt, "recovered queued task");

  runner.pending[0].resolve({
    finalMessage: "recovered done",
    sessionId: "thread_recovered"
  });
  await waitFor(() => bridge.running.size === 0);
});

test("dispatchEvent rejects tasks when the chat queue limit is reached", async () => {
  const client = createClient();
  const runner = createRunnerController();
  const bridge = new BridgeService(
    createConfig({ maxConcurrentTasks: 1, maxQueuedTasksPerChat: 1 }),
    createStore(),
    client,
    {
      autoCommitWorkspace: async () => ({ status: "disabled" }),
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );

  const payload = loadFixture("message.receive_v1.json");
  await bridge.dispatchEvent(payload);

  const secondPayload = loadFixture("message.receive_v1.json");
  secondPayload.event.message.message_id = "om_source_message_3";
  secondPayload.event.message.content = "{\"text\":\"第三个任务\"}";
  await bridge.dispatchEvent(secondPayload);

  assert.equal(client.texts.at(-1).text.includes("当前聊天待处理任务已达上限"), true);

  runner.pending[0].resolve({
    finalMessage: "done",
    sessionId: "thread_done"
  });
  await waitFor(() => bridge.running.size === 0);
});

test("context compaction writes memory to disk and uses it in the next fresh session", async () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-memory-"));
  const client = createClient();
  const calls = [];
  const runCodexTask = (_config, args) => {
    calls.push(args);

    if (calls.length === 1) {
      args.onEvent?.({
        payload: {
          info: {
            model_context_window: 1000,
            total_token_usage: {
              total_tokens: 850
            }
          },
          type: "token_count"
        },
        type: "event_msg"
      });

      return {
        cancel() {},
        result: Promise.resolve({
          finalMessage: "first result",
          sessionId: "thread_compact"
        })
      };
    }

    if (calls.length === 2) {
      return {
        cancel() {},
        result: Promise.resolve({
          finalMessage: "压缩后的记忆内容",
          sessionId: "thread_compact"
        })
      };
    }

    return {
      cancel() {},
      result: Promise.resolve({
        finalMessage: "second result",
        sessionId: "thread_new"
      })
    };
  };

  const store = createStore();
  const bridge = new BridgeService(
    createConfig({
      contextCompactEnabled: true,
      contextCompactThreshold: 0.8,
      contextMemoryDir: memoryDir
    }),
    store,
    client,
    {
      autoCommitWorkspace: async () => ({ status: "disabled" }),
      runCodexTask
    }
  );

  const firstPayload = loadFixture("message.receive_v1.json");
  await bridge.dispatchEvent(firstPayload);
  await waitFor(() => bridge.running.size === 0 && calls.length >= 2);

  const conversationAfterCompaction = store.getConversation("p2p:oc_test_chat");
  assert.equal(conversationAfterCompaction.sessionId, "");
  assert.equal(fs.existsSync(conversationAfterCompaction.memoryFilePath), true);
  assert.equal(
    fs.readFileSync(conversationAfterCompaction.memoryFilePath, "utf8").trim(),
    "压缩后的记忆内容"
  );

  const secondPayload = loadFixture("message.receive_v1.json");
  secondPayload.event.message.message_id = "om_source_message_6";
  secondPayload.event.message.content = "{\"text\":\"基于之前记忆继续\"}";
  await bridge.dispatchEvent(secondPayload);
  await waitFor(() => bridge.running.size === 0 && calls.length >= 3);

  assert.equal(calls[2].sessionId, null);
  assert.equal(calls[2].prompt.includes("压缩后的记忆内容"), true);
});

test("loaded memory is trimmed to at most ten percent of the context budget", async () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-memory-limit-"));
  const memoryFilePath = path.join(memoryDir, "memory.md");
  const largeMemory = "记忆".repeat(300);
  fs.writeFileSync(memoryFilePath, largeMemory, "utf8");

  const calls = [];
  const bridge = new BridgeService(
    createConfig({
      contextCompactEnabled: true,
      contextCompactThreshold: 0.8,
      contextMemoryDir: memoryDir,
      contextMemoryLoadFraction: 0.1
    }),
    createStore({
      conversations: {
        "p2p:oc_test_chat": {
          lastModelContextWindow: 1000,
          memoryFilePath,
          sessionId: "",
          workspaceDir: "/tmp/codex-workspace"
        }
      }
    }),
    createClient(),
    {
      autoCommitWorkspace: async () => ({ status: "disabled" }),
      runCodexTask: (_config, args) => {
        calls.push(args);
        return {
          cancel() {},
          result: Promise.resolve({
            finalMessage: "done",
            sessionId: "thread_memory"
          })
        };
      }
    }
  );

  const payload = loadFixture("message.receive_v1.json");
  await bridge.dispatchEvent(payload);
  await waitFor(() => bridge.running.size === 0 && calls.length === 1);

  assert.equal(calls[0].prompt.includes("[记忆内容已按上下文预算截断]"), true);
  assert.equal(calls[0].prompt.includes(largeMemory), false);
});
