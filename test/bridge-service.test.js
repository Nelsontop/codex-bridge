import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { BridgeService } from "../src/bridge-service.js";

const FIXTURE_DIR = path.join(process.cwd(), "test", "fixtures");

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

function createConfig(overrides = {}) {
  return {
    chatWorkspaceMappings: new Map(),
    codexWorkspaceDir: "/tmp/codex-workspace",
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
  assert.equal(bridge.queue[0].id, "T0002");

  const actionPayload = loadFixture("card.action.trigger.json");
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
