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

function createGroupMessageEvent({
  chatId = "group-chat-1",
  messageId = "group-msg-1",
  text = "请处理这个任务"
} = {}) {
  return {
    event: {
      message: {
        chat_id: chatId,
        chat_type: "group",
        content: JSON.stringify({ text }),
        mentions: [],
        message_id: messageId,
        message_type: "text"
      },
      sender: {
        sender_id: {
          open_id: "ou_group_user"
        },
        sender_type: "user"
      }
    }
  };
}

function createInteractionMessage({
  options = [
    {
      id: "a",
      label: "方案A",
      prompt: "继续按方案 A 执行",
      style: "primary"
    },
    {
      id: "b",
      label: "方案B",
      prompt: "继续按方案 B 执行",
      style: "default"
    }
  ],
  question = "请选择后续方案"
} = {}) {
  return [
    "```codex_bridge_interaction",
    JSON.stringify({
      options,
      question
    }),
    "```"
  ].join("\n");
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
    githubRepoOwner: "",
    gitAutoCommitEnabled: false,
    maxConcurrentTasks: 2,
    maxQueuedTasksPerChat: 5,
    maxQueuedTasksPerUser: 10,
    maxReplyChars: 200,
    requireMentionInGroup: true,
    taskAckEnabled: true,
    workspaceAllowedRoots: ["/tmp"],
    ...overrides
  };
}

function createStore({ conversations = {}, runtime } = {}) {
  const state = {
    conversations: structuredClone(conversations),
    runtime: structuredClone(
      runtime || {
        interrupted: [],
        nextTaskNumbers: {},
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
        emit(event) {
          args.onEvent?.(event);
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

test("bot added event prompts the group to bind a workspace", async () => {
  const client = createClient();
  const store = createStore();
  const bridge = new BridgeService(
    createConfig({ feishuInteractiveCardsEnabled: false, maxReplyChars: 2000 }),
    store,
    client
  );

  await bridge.dispatchEvent({
    chat_id: "oc_group_bind",
    event_id: "evt_bind_1",
    event_type: "im.chat.member.bot.added_v1"
  });

  assert.equal(client.texts.length, 1);
  assert.equal(client.texts[0].chatId, "oc_group_bind");
  assert.equal(client.texts[0].text.includes("/bind <工作目录> [仓库名]"), true);
  assert.equal(
    store.getConversation("group:oc_group_bind").bindingStatus,
    "pending"
  );
});

test("group messages are blocked until a workspace is bound", async () => {
  const client = createClient();
  const runner = createRunnerController();
  const bridge = new BridgeService(
    createConfig({
      feishuInteractiveCardsEnabled: false,
      maxReplyChars: 2000,
      requireMentionInGroup: false
    }),
    createStore(),
    client,
    {
      autoCommitWorkspace: async () => ({ status: "disabled" }),
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );

  await bridge.dispatchEvent(createGroupMessageEvent());

  assert.equal(client.texts.at(-1).text.includes("当前群组还没有绑定工作目录"), true);
  assert.equal(runner.calls.length, 0);
  assert.equal(bridge.queue.length, 0);
  assert.equal(bridge.running.size, 0);
});

test("bind command stores the group workspace and later tasks use it", async () => {
  const client = createClient();
  const runner = createRunnerController();
  const store = createStore();
  const bridge = new BridgeService(
    createConfig({
      feishuInteractiveCardsEnabled: false,
      requireMentionInGroup: false
    }),
    store,
    client,
    {
      autoCommitWorkspace: async () => ({ status: "disabled" }),
      prepareWorkspaceBinding: async () => ({
        gitInitialized: true,
        initialCommitCreated: true,
        remoteStatus: "created",
        remoteUrl: "https://github.com/Nelsontop/group-project",
        repoName: "group-project",
        workspaceDir: "/tmp/group-project"
      }),
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );

  await bridge.handleCommand({
    commandText: "/bind /tmp/group-project group-project",
    chatId: "oc_group_workspace",
    chatKey: "group:oc_group_workspace",
    target: {
      chatId: "oc_group_workspace",
      replyToMessageId: "om_bind"
    }
  });

  assert.equal(
    store.getConversation("group:oc_group_workspace").workspaceDir,
    "/tmp/group-project"
  );
  assert.equal(client.texts.at(-1).text.includes("后续在当前群里启动的 Codex session"), true);

  await bridge.dispatchEvent(
    createGroupMessageEvent({
      chatId: "oc_group_workspace",
      messageId: "group-msg-2",
      text: "继续修复这个群里的任务"
    })
  );

  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].workspaceDir, "/tmp/group-project");

  runner.pending[0].resolve({
    finalMessage: "done",
    sessionId: "thread_group_workspace"
  });
  await waitFor(() => bridge.running.size === 0);
});

test("bind command supports quoted workspace paths", async () => {
  const client = createClient();
  const store = createStore();
  const bridge = new BridgeService(
    createConfig({
      feishuInteractiveCardsEnabled: false,
      requireMentionInGroup: false,
      workspaceAllowedRoots: ["/tmp"]
    }),
    store,
    client,
    {
      prepareWorkspaceBinding: async (_config, args) => ({
        gitInitialized: true,
        initialCommitCreated: true,
        remoteStatus: "existing",
        remoteUrl: "git@github.com:demo/project-a.git",
        repoName: "project-a",
        workspaceDir: args.workspaceInput
      })
    }
  );

  await bridge.handleCommand({
    commandText: '/bind "/tmp/Project A" project-a',
    chatId: "oc_group_workspace_quoted",
    chatKey: "group:oc_group_workspace_quoted",
    target: {
      chatId: "oc_group_workspace_quoted",
      replyToMessageId: "om_bind_quoted"
    }
  });

  assert.equal(
    store.getConversation("group:oc_group_workspace_quoted").workspaceDir,
    "/tmp/Project A"
  );
});

test("bind command rejects workspaces outside allowed roots", async () => {
  const client = createClient();
  const bridge = new BridgeService(
    createConfig({
      feishuInteractiveCardsEnabled: false,
      requireMentionInGroup: false
    }),
    createStore(),
    client,
    {
      prepareWorkspaceBinding: async () => {
        throw new Error("工作目录不在允许范围内：/etc。允许范围：/tmp");
      }
    }
  );

  await bridge.handleCommand({
    commandText: "/bind /etc project-a",
    chatId: "oc_group_workspace_denied",
    chatKey: "group:oc_group_workspace_denied",
    target: {
      chatId: "oc_group_workspace_denied",
      replyToMessageId: "om_bind_denied"
    }
  });

  assert.equal(
    client.texts.at(-1).text,
    "工作目录绑定失败：工作目录不在允许范围内：/etc。允许范围：/tmp"
  );
});

test("reset clears the session but preserves the bound workspace", async () => {
  const client = createClient();
  const store = createStore({
    conversations: {
      "group:oc_group_reset": {
        bindingStatus: "bound",
        memoryFilePath: "/tmp/memory.md",
        repoRemoteUrl: "https://github.com/Nelsontop/group-reset",
        sessionId: "thread_reset",
        workspaceDir: "/tmp/group-reset"
      }
    }
  });
  const bridge = new BridgeService(
    createConfig({ feishuInteractiveCardsEnabled: false }),
    store,
    client
  );

  await bridge.handleCommand({
    commandText: "/reset",
    chatId: "oc_group_reset",
    chatKey: "group:oc_group_reset",
    target: {
      chatId: "oc_group_reset",
      replyToMessageId: "om_reset"
    }
  });

  const conversation = store.getConversation("group:oc_group_reset");
  assert.equal(conversation.workspaceDir, "/tmp/group-reset");
  assert.equal(conversation.sessionId, "");
  assert.equal(conversation.memoryFilePath, "");
  assert.equal(client.texts.at(-1).text.includes("工作目录绑定保留"), true);
});

test("different bound groups run on independent agents even when per-group concurrency is 1", async () => {
  const client = createClient();
  const runner = createRunnerController();
  const bridge = new BridgeService(
    createConfig({ maxConcurrentTasks: 1, requireMentionInGroup: false }),
    createStore({
      conversations: {
        "group:group-a": {
          bindingStatus: "bound",
          sessionId: "",
          workspaceDir: "/tmp/group-a"
        },
        "group:group-b": {
          bindingStatus: "bound",
          sessionId: "",
          workspaceDir: "/tmp/group-b"
        }
      }
    }),
    client,
    {
      autoCommitWorkspace: async () => ({ status: "disabled" }),
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );

  await bridge.dispatchEvent(
    createGroupMessageEvent({
      chatId: "group-a",
      messageId: "group-a-msg-1",
      text: "请处理 A 群任务"
    })
  );
  await bridge.dispatchEvent(
    createGroupMessageEvent({
      chatId: "group-b",
      messageId: "group-b-msg-1",
      text: "请处理 B 群任务"
    })
  );

  assert.equal(runner.calls.length, 2);
  assert.equal(bridge.running.size, 2);
  assert.equal(runner.calls[0].workspaceDir, "/tmp/group-a");
  assert.equal(runner.calls[1].workspaceDir, "/tmp/group-b");

  runner.pending[0].resolve({
    finalMessage: "done a",
    sessionId: "thread_group_a"
  });
  runner.pending[1].resolve({
    finalMessage: "done b",
    sessionId: "thread_group_b"
  });
  await waitFor(() => bridge.running.size === 0);
});

test("same user pending limits are scoped to the current group", async () => {
  const client = createClient();
  const runner = createRunnerController();
  const bridge = new BridgeService(
    createConfig({
      feishuInteractiveCardsEnabled: false,
      maxConcurrentTasks: 1,
      maxQueuedTasksPerUser: 1,
      requireMentionInGroup: false
    }),
    createStore({
      conversations: {
        "group:group-a": {
          bindingStatus: "bound",
          sessionId: "",
          workspaceDir: "/tmp/group-a"
        },
        "group:group-b": {
          bindingStatus: "bound",
          sessionId: "",
          workspaceDir: "/tmp/group-b"
        }
      }
    }),
    client,
    {
      autoCommitWorkspace: async () => ({ status: "disabled" }),
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );

  await bridge.dispatchEvent(
    createGroupMessageEvent({
      chatId: "group-a",
      messageId: "group-a-msg-limit-1",
      text: "请处理 A 群限流任务"
    })
  );
  await bridge.dispatchEvent(
    createGroupMessageEvent({
      chatId: "group-b",
      messageId: "group-b-msg-limit-1",
      text: "请处理 B 群限流任务"
    })
  );

  assert.equal(runner.calls.length, 2);
  assert.equal(client.texts.some((item) => item.text.includes("当前聊天内该用户待处理任务已达上限")), false);

  runner.pending[0].resolve({
    finalMessage: "done a",
    sessionId: "thread_group_limit_a"
  });
  runner.pending[1].resolve({
    finalMessage: "done b",
    sessionId: "thread_group_limit_b"
  });
  await waitFor(() => bridge.running.size === 0);
});

test("queue position is counted independently per group", async () => {
  const client = createClient();
  const runner = createRunnerController();
  const bridge = new BridgeService(
    createConfig({
      feishuInteractiveCardsEnabled: false,
      maxConcurrentTasks: 1,
      requireMentionInGroup: false
    }),
    createStore({
      conversations: {
        "group:group-a": {
          bindingStatus: "bound",
          sessionId: "",
          workspaceDir: "/tmp/group-a"
        },
        "group:group-b": {
          bindingStatus: "bound",
          sessionId: "",
          workspaceDir: "/tmp/group-b"
        }
      }
    }),
    client,
    {
      autoCommitWorkspace: async () => ({ status: "disabled" }),
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );

  await bridge.dispatchEvent(
    createGroupMessageEvent({
      chatId: "group-a",
      messageId: "group-a-msg-queue-1",
      text: "先跑 A 群第一个任务"
    })
  );
  await bridge.dispatchEvent(
    createGroupMessageEvent({
      chatId: "group-b",
      messageId: "group-b-msg-queue-1",
      text: "先跑 B 群第一个任务"
    })
  );
  await bridge.dispatchEvent(
    createGroupMessageEvent({
      chatId: "group-b",
      messageId: "group-b-msg-queue-2",
      text: "B 群第二个任务排队"
    })
  );
  assert.equal(client.texts.at(-1).text.includes("队列位置 1"), true);

  await bridge.dispatchEvent(
    createGroupMessageEvent({
      chatId: "group-a",
      messageId: "group-a-msg-queue-2",
      text: "A 群第二个任务排队"
    })
  );
  assert.equal(client.texts.at(-1).text.includes("队列位置 1"), true);

  runner.pending[0].resolve({
    finalMessage: "done a1",
    sessionId: "thread_group_queue_a1"
  });
  runner.pending[1].resolve({
    finalMessage: "done b1",
    sessionId: "thread_group_queue_b1"
  });
  await waitFor(() => runner.calls.length === 4);
  runner.pending[2].resolve({
    finalMessage: "done b2",
    sessionId: "thread_group_queue_b2"
  });
  runner.pending[3].resolve({
    finalMessage: "done a2",
    sessionId: "thread_group_queue_a2"
  });
  await waitFor(() => bridge.running.size === 0);
});

test("dispatchEvent ignores duplicate message events with the same source message id", async () => {
  const client = createClient();
  const runner = createRunnerController();
  const bridge = new BridgeService(
    createConfig(),
    createStore(),
    client,
    {
      autoCommitWorkspace: async () => ({ status: "disabled" }),
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );

  const payload = loadFixture("message.receive_v1.json");
  await bridge.dispatchEvent(payload);
  await bridge.dispatchEvent(payload);

  assert.equal(client.cards.length, 1);
  assert.equal(runner.calls.length, 1);
  assert.equal(bridge.queue.length, 0);
  assert.equal(bridge.running.size, 1);
  assert.equal(bridge.getHealth().duplicateEventCount, 1);

  runner.pending[0].resolve({
    finalMessage: "done",
    sessionId: "thread_dedup"
  });
  await waitFor(() => bridge.running.size === 0);
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

  assert.deepEqual(startedTaskIds, ["T0002", "T0003"]);
  assert.deepEqual(
    bridge.queue.map((task) => task.id),
    []
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
  assert.equal(client.cards[0].card.header.title.content, "T001-检查项目状态");
  assert.equal(client.cards[0].card.elements[0].text.content.includes("/abort T001"), true);
  assert.equal(client.cards[0].card.elements[0].text.content.includes("/reset"), true);
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

test("streaming agent messages are shown as user-facing progress text", async () => {
  const client = createClient();
  const runner = createRunnerController();
  const bridge = new BridgeService(
    createConfig(),
    createStore(),
    client,
    {
      autoCommitWorkspace: async () => ({ status: "disabled" }),
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );

  await bridge.dispatchEvent(loadFixture("message.receive_v1.json"));
  assert.equal(runner.calls.length, 1);

  runner.pending[0].emit({
    type: "item.completed",
    item: {
      id: "item_agent_progress",
      type: "agent_message",
      text: "正在检查流式配置，并准备给出结论。"
    }
  });

  await waitFor(() =>
    client.cardUpdates.some((update) =>
      update.card.elements[0].text.content.includes("正在检查流式配置，并准备给出结论。")
    )
  );
});

test("streaming command updates are summarized instead of showing raw shell", async () => {
  const client = createClient();
  const runner = createRunnerController();
  const bridge = new BridgeService(
    createConfig(),
    createStore(),
    client,
    {
      autoCommitWorkspace: async () => ({ status: "disabled" }),
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );

  await bridge.dispatchEvent(loadFixture("message.receive_v1.json"));
  assert.equal(runner.calls.length, 1);

  runner.pending[0].emit({
    type: "item.started",
    item: {
      id: "item_command_progress",
      type: "command_execution",
      command: "/bin/bash -lc \"sed -n '1,160p' src/bridge-service.js\""
    }
  });

  await waitFor(() =>
    client.cardUpdates.some((update) =>
      update.card.elements[0].text.content.includes("正在查看文件内容：src/bridge-service.js")
    )
  );
  assert.equal(
    client.cardUpdates.some((update) =>
      update.card.elements[0].text.content.includes("/bin/bash -lc")
    ),
    false
  );
});

test("interaction request persists pending choice and /choose resumes the same session", async () => {
  const client = createClient();
  const runner = createRunnerController();
  const store = createStore();
  const bridge = new BridgeService(
    createConfig(),
    store,
    client,
    {
      autoCommitWorkspace: async () => ({ status: "disabled" }),
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );

  await bridge.dispatchEvent(loadFixture("message.receive_v1.json"));
  assert.equal(runner.calls.length, 1);

  runner.pending[0].resolve({
    finalMessage: createInteractionMessage(),
    sessionId: "thread_interaction"
  });
  await waitFor(
    () =>
      bridge.running.size === 0 &&
      Boolean(store.getConversation("p2p:oc_test_chat")?.pendingInteraction)
  );

  const conversation = store.getConversation("p2p:oc_test_chat");
  const interaction = conversation.pendingInteraction;
  assert.equal(conversation.sessionId, "thread_interaction");
  assert.equal(interaction.question, "请选择后续方案");
  assert.deepEqual(
    interaction.options.map((option) => option.id),
    ["a", "b"]
  );
  assert.equal(
    client.texts.at(-1).text.includes("/choose a"),
    true
  );
  assert.equal(client.texts.at(-1).text.includes("/choose b"), true);

  await bridge.handleCommand({
    commandText: "/choose b",
    chatId: "oc_test_chat",
    chatKey: "p2p:oc_test_chat",
    target: {
      chatId: "oc_test_chat",
      replyToMessageId: "om_source_message_1"
    }
  });

  assert.equal(runner.calls.length, 2);
  assert.equal(runner.calls[1].sessionId, "thread_interaction");
  assert.equal(runner.calls[1].prompt, "继续按方案 B 执行");
  assert.equal(store.getConversation("p2p:oc_test_chat").pendingInteraction, null);

  runner.pending[1].resolve({
    finalMessage: "已按方案 B 完成",
    sessionId: "thread_interaction"
  });
  await waitFor(() => bridge.running.size === 0);
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

test("duplicate card actions are ignored after the first cancel request", async () => {
  const client = createClient();
  const bridge = new BridgeService(
    createConfig({ feishuInteractiveCardsEnabled: false }),
    createStore(),
    client
  );
  let cancelCalls = 0;

  bridge.running.set("T0002", {
    abortRequested: false,
    chatKey: "p2p:oc_test_chat",
    id: "T0002",
    runner: {
      cancel() {
        cancelCalls += 1;
      }
    },
    target: {
      chatId: "oc_test_chat",
      replyToMessageId: "om_source_message_1"
    }
  });

  const payload = loadFixture("card.action.trigger.json");
  payload.event.action.value.taskId = "T0002";

  await bridge.dispatchEvent(payload);
  await bridge.dispatchEvent(payload);

  assert.equal(cancelCalls, 1);
  assert.equal(bridge.getHealth().duplicateEventCount, 1);
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
    commandText: "/abort T002-继续第二个任务",
    chatId: "oc_test_chat",
    chatKey: "p2p:oc_test_chat",
    target: {
      chatId: "oc_test_chat",
      replyToMessageId: "om_source_message_2"
    }
  });

  assert.equal(bridge.queue.length, 0);
  assert.equal(client.texts.at(-1).text, "已取消排队中的任务 T002-继续第二个任务。");

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

test("abort during post-run wait skips auto commit and marks the task cancelled", async () => {
  const client = createClient();
  const runner = createRunnerController();
  let autoCommitCalls = 0;
  let rollbackCalls = 0;
  const bridge = new BridgeService(
    createConfig({ feishuInteractiveCardsEnabled: false }),
    createStore(),
    client,
    {
      autoCommitWorkspace: async () => {
        autoCommitCalls += 1;
        return { status: "committed", commitId: "abc123" };
      },
      rollbackAutoCommitWorkspace: async () => {
        rollbackCalls += 1;
        return { status: "rolled-back", commitId: "abc123" };
      },
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );

  await bridge.dispatchEvent(loadFixture("message.receive_v1.json"));
  await waitFor(() => bridge.running.size === 1);

  runner.pending[0].resolve({
    finalMessage: "任务已经完成",
    sessionId: "thread_new"
  });
  await bridge.handleCommand({
    commandText: "/abort T001",
    chatId: "oc_test_chat",
    chatKey: "p2p:oc_test_chat",
    target: {
      chatId: "oc_test_chat",
      replyToMessageId: "om_source_message_1"
    }
  });

  await waitFor(() => bridge.running.size === 0);

  assert.equal(autoCommitCalls, 0);
  assert.equal(client.texts.at(-1).text.includes("已取消"), true);
  assert.equal(rollbackCalls, 0);
});

test("abort after auto commit rolls back the task commit", async () => {
  const client = createClient();
  const runner = createRunnerController();
  let rollbackCalls = 0;
  const bridge = new BridgeService(
    createConfig({ feishuInteractiveCardsEnabled: false }),
    createStore(),
    client,
    {
      autoCommitWorkspace: async () => ({ status: "committed", commitId: "abc123" }),
      rollbackAutoCommitWorkspace: async () => {
        rollbackCalls += 1;
        return { status: "rolled-back", commitId: "abc123" };
      },
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );
  bridge.compactConversationContext = async () => {
    await bridge.handleCommand({
      commandText: "/abort T001",
      chatId: "oc_test_chat",
      chatKey: "p2p:oc_test_chat",
      target: {
        chatId: "oc_test_chat",
        replyToMessageId: "om_source_message_1"
      }
    });
    return { performed: false };
  };

  await bridge.dispatchEvent(loadFixture("message.receive_v1.json"));
  await waitFor(() => bridge.running.size === 1);

  runner.pending[0].resolve({
    finalMessage: "任务已经完成",
    sessionId: "thread_new"
  });

  await waitFor(() => bridge.running.size === 0);

  assert.equal(rollbackCalls, 1);
  assert.equal(client.texts.at(-1).text.includes("已取消"), true);
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

test("retry command retries the latest interrupted task in the current chat", async () => {
  const client = createClient();
  const runner = createRunnerController();
  const bridge = new BridgeService(
    createConfig({ feishuInteractiveCardsEnabled: false, maxConcurrentTasks: 1 }),
    createStore({
      runtime: {
        interrupted: [
          {
            chatKey: "p2p:oc_test_chat",
            enqueuedAt: "2026-03-15T00:00:00.000Z",
            id: "T0006",
            nameSummary: "恢复数据库索引",
            prompt: "恢复数据库索引",
            senderOpenId: "ou_user_a",
            status: "interrupted",
            target: {
              chatId: "oc_test_chat",
              replyToMessageId: "om_source_message_6"
            },
            workspaceDir: "/tmp/codex-workspace"
          }
        ],
        nextTaskNumber: 7,
        queue: [],
        running: []
      }
    }),
    client,
    {
      autoCommitWorkspace: async () => ({ status: "disabled" }),
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );

  await bridge.handleCommand({
    commandText: "/retry",
    chatId: "oc_test_chat",
    chatKey: "p2p:oc_test_chat",
    target: {
      chatId: "oc_test_chat",
      replyToMessageId: "om_source_message_retry"
    }
  });

  assert.equal(bridge.interruptedTasks.length, 0);
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].prompt, "恢复数据库索引");
  assert.equal(client.texts.at(-1).text, "已重试任务 T0006-恢复数据库索引，队列位置 1。");

  runner.pending[0].resolve({
    finalMessage: "retried done",
    sessionId: "thread_retry"
  });
  await waitFor(() => bridge.running.size === 0);
});

test("running task persists discovered session id and retry resumes it after restart", async () => {
  const client = createClient();
  const runner = createRunnerController();
  const store = createStore();
  const bridge = new BridgeService(
    createConfig({ feishuInteractiveCardsEnabled: false }),
    store,
    client,
    {
      autoCommitWorkspace: async () => ({ status: "disabled" }),
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );

  await bridge.dispatchEvent(loadFixture("message.receive_v1.json"));
  await waitFor(() => bridge.running.size === 1);

  runner.pending[0].emit({
    thread_id: "thread_live_resume",
    type: "thread.started"
  });

  assert.equal([...bridge.running.values()][0].sessionId, "thread_live_resume");
  assert.equal(store.getRuntimeSnapshot().running[0].sessionId, "thread_live_resume");

  const persistedRuntime = store.getRuntimeSnapshot();
  const recoveredStore = createStore({
    runtime: {
      interrupted: persistedRuntime.running.map((task) => ({
        ...task,
        lastErrorMessage: task.lastErrorMessage || "服务重启时任务被中断，未自动继续执行。",
        status: "interrupted"
      })),
      nextTaskNumbers: persistedRuntime.nextTaskNumbers,
      queue: persistedRuntime.queue,
      running: []
    }
  });

  const recoveredBridge = new BridgeService(
    createConfig({ feishuInteractiveCardsEnabled: false }),
    recoveredStore,
    createClient(),
    {
      autoCommitWorkspace: async () => ({ status: "disabled" }),
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );

  assert.equal(recoveredBridge.interruptedTasks.length, 1);
  assert.equal(recoveredBridge.interruptedTasks[0].sessionId, "thread_live_resume");

  await recoveredBridge.handleCommand({
    commandText: "/retry",
    chatId: "oc_test_chat",
    chatKey: "p2p:oc_test_chat",
    target: {
      chatId: "oc_test_chat",
      replyToMessageId: "om_source_message_retry_resume"
    }
  });

  assert.equal(runner.calls.length, 2);
  assert.equal(runner.calls[1].sessionId, "thread_live_resume");

  runner.pending[1].resolve({
    finalMessage: "retried done",
    sessionId: "thread_live_resume"
  });
  await waitFor(() => recoveredBridge.running.size === 0);
});

test("card action can retry an interrupted task", async () => {
  const client = createClient();
  const runner = createRunnerController();
  const bridge = new BridgeService(
    createConfig({ maxConcurrentTasks: 1 }),
    createStore({
      runtime: {
        interrupted: [
          {
            cardMessageId: "om_card_interrupted",
            chatKey: "p2p:oc_test_chat",
            enqueuedAt: "2026-03-15T00:00:00.000Z",
            id: "T0008",
            nameSummary: "修复部署脚本",
            prompt: "修复部署脚本",
            senderOpenId: "ou_user_a",
            status: "interrupted",
            target: {
              chatId: "oc_test_chat",
              replyToMessageId: "om_source_message_8"
            },
            workspaceDir: "/tmp/codex-workspace"
          }
        ],
        nextTaskNumber: 9,
        queue: [],
        running: []
      }
    }),
    client,
    {
      autoCommitWorkspace: async () => ({ status: "disabled" }),
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );

  const actionPayload = loadFixture("card.action.trigger.json");
  actionPayload.event.action.value.action = "retry";
  actionPayload.event.action.value.taskId = "T0008";
  await bridge.dispatchEvent(actionPayload);

  assert.equal(bridge.interruptedTasks.length, 0);
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].prompt, "修复部署脚本");
  assert.equal(client.cardUpdates.some((update) => update.messageId === "om_card_interrupted"), true);

  runner.pending[0].resolve({
    finalMessage: "retried by card",
    sessionId: "thread_retry_card"
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

test("task title summary extracts intent instead of truncating raw text", async () => {
  const client = createClient();
  const runner = createRunnerController();
  const bridge = new BridgeService(
    createConfig(),
    createStore(),
    client,
    {
      autoCommitWorkspace: async () => ({ status: "disabled" }),
      runCodexTask: runner.runCodexTask.bind(runner)
    }
  );

  const payload = loadFixture("message.receive_v1.json");
  payload.event.message.content =
    "{\"text\":\"优化任务标题摘要，不要简单的截断，要理解内容再总结\"}";
  payload.event.message.message_id = "om_source_message_title";

  await bridge.dispatchEvent(payload);

  assert.equal(client.cards[0].card.header.title.content, "T001-优化任务标题摘要");

  runner.pending[0].resolve({
    finalMessage: "done",
    sessionId: "thread_title"
  });
  await waitFor(() => bridge.running.size === 0);
});
