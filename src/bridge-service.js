import { runCodexTask } from "./codex-runner.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chatKeyFor(event) {
  return `${event.message.chat_type}:${event.message.chat_id}`;
}

function parseContent(event) {
  if (event.message.message_type !== "text") {
    return null;
  }

  const payload = JSON.parse(event.message.content || "{}");
  return typeof payload.text === "string" ? payload.text : null;
}

function stripMentions(text, mentions) {
  let output = text;
  for (const mention of mentions || []) {
    if (mention.name) {
      output = output.replaceAll(`@${mention.name}`, " ");
    }
    if (mention.key) {
      output = output.replaceAll(mention.key, " ");
    }
  }
  return output.replace(/\s+/g, " ").trim();
}

function splitText(text, maxChars) {
  const chunks = [];
  let rest = text.trim();
  while (rest.length > maxChars) {
    let index = rest.lastIndexOf("\n", maxChars);
    if (index < maxChars * 0.5) {
      index = rest.lastIndexOf(" ", maxChars);
    }
    if (index < maxChars * 0.5) {
      index = maxChars;
    }
    chunks.push(rest.slice(0, index).trim());
    rest = rest.slice(index).trim();
  }
  if (rest) {
    chunks.push(rest);
  }
  return chunks.length > 0 ? chunks : [""];
}

function formatTaskId(number) {
  return `T${String(number).padStart(4, "0")}`;
}

function helpText() {
  return [
    "Codex Feishu Bridge 命令：",
    "/help 查看帮助",
    "/status 查看当前会话与任务状态",
    "/reset 清空当前聊天绑定的 Codex 会话",
    "/abort <任务号> 终止当前运行中的任务",
    "",
    "其余文本会直接发送给 Codex 执行。"
  ].join("\n");
}

function truncateText(text, maxChars) {
  const normalized = String(text || "").trim();
  if (!normalized || normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export class BridgeService {
  constructor(config, store, feishuClient) {
    this.config = config;
    this.store = store;
    this.feishuClient = feishuClient;
    this.nextTaskNumber = 1;
    this.queue = [];
    this.running = new Map();
  }

  async dispatchEvent(eventEnvelope) {
    const event = eventEnvelope.event;
    if (!event || event.message?.message_type === undefined) {
      return;
    }
    if (event.sender?.sender_type && event.sender.sender_type !== "user") {
      return;
    }

    const senderOpenId = event.sender?.sender_id?.open_id || "";
    if (
      this.config.feishuAllowedOpenIds.size > 0 &&
      !this.config.feishuAllowedOpenIds.has(senderOpenId)
    ) {
      await this.safeSend(event.message.chat_id, "当前用户未被授权使用这个 Codex 桥接器。");
      return;
    }

    const rawText = parseContent(event);
    if (!rawText) {
      await this.safeSend(event.message.chat_id, "当前仅支持文本消息。");
      return;
    }

    const mentions = event.message.mentions || [];
    if (
      event.message.chat_type !== "p2p" &&
      this.config.requireMentionInGroup &&
      !this.isBotMentioned(mentions)
    ) {
      return;
    }

    const text = stripMentions(rawText, mentions);
    if (!text) {
      await this.safeSend(event.message.chat_id, helpText());
      return;
    }

    if (text.startsWith("/")) {
      await this.handleCommand(event, text);
      return;
    }

    const task = this.enqueueTask(event, text, senderOpenId);
    if (this.config.taskAckEnabled) {
      const queueIndex = this.queue.findIndex((item) => item.id === task.id);
      const position = queueIndex >= 0 ? `，队列位置 ${queueIndex + 1}` : "";
      await this.safeSend(
        event.message.chat_id,
        `已接收任务 ${task.id}${position}。任务完成后会自动回传结果。`
      );
    }
    this.pumpQueue();
  }

  isBotMentioned(mentions) {
    if (!mentions || mentions.length === 0) {
      return false;
    }
    if (!this.config.feishuBotOpenId) {
      return true;
    }
    return mentions.some(
      (mention) => mention.id?.open_id === this.config.feishuBotOpenId
    );
  }

  enqueueTask(event, prompt, senderOpenId) {
    const id = formatTaskId(this.nextTaskNumber++);
    const task = {
      id,
      prompt,
      senderOpenId,
      event,
      chatKey: chatKeyFor(event),
      enqueuedAt: new Date().toISOString(),
      status: "queued"
    };
    this.queue.push(task);
    return task;
  }

  async handleCommand(event, text) {
    const chatId = event.message.chat_id;
    const chatKey = chatKeyFor(event);
    const [command, ...rest] = text.trim().split(/\s+/);

    if (command === "/help") {
      await this.safeSend(chatId, helpText());
      return;
    }

    if (command === "/reset") {
      this.store.clearConversation(chatKey);
      await this.safeSend(chatId, "已清空当前聊天绑定的 Codex 会话。");
      return;
    }

    if (command === "/status") {
      const conversation = this.store.getConversation(chatKey);
      const runningTask = [...this.running.values()].find((task) => task.chatKey === chatKey);
      const queuedCount = this.queue.filter((task) => task.chatKey === chatKey).length;
      const lines = [
        `chatKey: ${chatKey}`,
        `sessionId: ${conversation?.sessionId || "无"}`,
        `running: ${runningTask ? `${runningTask.id} (${runningTask.startedAt})` : "无"}`,
        `queued: ${queuedCount}`
      ];
      await this.safeSend(chatId, lines.join("\n"));
      return;
    }

    if (command === "/abort") {
      const taskId = rest[0];
      if (!taskId) {
        await this.safeSend(chatId, "用法：/abort T0001");
        return;
      }

      const runningTask = this.running.get(taskId);
      if (!runningTask) {
        await this.safeSend(chatId, `未找到运行中的任务 ${taskId}。`);
        return;
      }

      runningTask.runner.cancel();
      await this.safeSend(chatId, `已请求终止任务 ${taskId}。`);
      return;
    }

    await this.safeSend(chatId, `未知命令：${command}\n\n${helpText()}`);
  }

  pumpQueue() {
    while (
      this.running.size < this.config.maxConcurrentTasks &&
      this.queue.length > 0
    ) {
      const task = this.queue.shift();
      this.runTask(task).catch((error) => {
        console.error(`[task:${task.id}] unexpected error`, error);
      });
    }
  }

  queueStreamText(task, chatId, text) {
    const normalized = String(text || "").trim();
    if (!normalized) {
      return;
    }

    task.streamChain = task.streamChain
      .then(async () => {
        const now = Date.now();
        const elapsed = now - task.lastStreamSentAt;
        const waitMs = this.config.feishuStreamUpdateMinIntervalMs - elapsed;
        if (waitMs > 0) {
          await sleep(waitMs);
        }

        const chunks = splitText(normalized, this.config.maxReplyChars);
        for (const chunk of chunks) {
          await this.safeSend(chatId, chunk);
        }
        task.lastStreamSentAt = Date.now();
      })
      .catch((error) => {
        console.error(`[task:${task.id}] stream send failed`, error);
      });
  }

  handleRunnerEvent(task, chatId, event) {
    if (!this.config.feishuStreamOutputEnabled || !event?.item) {
      return;
    }

    const { item } = event;
    if (item.type === "agent_message" && event.type === "item.completed") {
      const text = String(item.text || "").trim();
      if (!text || text === task.lastStreamedAgentMessage) {
        return;
      }

      task.lastStreamedAgentMessage = text;
      this.queueStreamText(
        task,
        chatId,
        `任务 ${task.id} 进度更新：\n\n${text}`
      );
      return;
    }

    if (!this.config.feishuStreamCommandStatusEnabled || item.type !== "command_execution") {
      return;
    }

    if (event.type === "item.started") {
      if (task.startedCommandIds.has(item.id)) {
        return;
      }
      task.startedCommandIds.add(item.id);
      this.queueStreamText(
        task,
        chatId,
        `任务 ${task.id} 正在执行命令：\n${truncateText(item.command, this.config.maxReplyChars)}`
      );
      return;
    }

    if (event.type === "item.completed") {
      if (task.completedCommandIds.has(item.id)) {
        return;
      }
      task.completedCommandIds.add(item.id);

      const output = truncateText(
        item.aggregated_output,
        Math.max(200, this.config.maxReplyChars - 120)
      );
      const lines = [
        `任务 ${task.id} 命令${item.exit_code === 0 ? "已完成" : "结束"}：`,
        truncateText(item.command, this.config.maxReplyChars)
      ];
      if (item.exit_code !== null && item.exit_code !== undefined) {
        lines.push(`exit: ${item.exit_code}`);
      }
      if (output) {
        lines.push("", output);
      }

      this.queueStreamText(task, chatId, lines.join("\n"));
    }
  }

  async runTask(task) {
    task.status = "running";
    task.startedAt = new Date().toISOString();
    task.streamChain = Promise.resolve();
    task.lastStreamSentAt = 0;
    task.lastStreamedAgentMessage = "";
    task.startedCommandIds = new Set();
    task.completedCommandIds = new Set();

    const chatId = task.event.message.chat_id;
    const conversation = this.store.getConversation(task.chatKey);
    const runner = runCodexTask(this.config, {
      prompt: task.prompt,
      sessionId: conversation?.sessionId || null,
      onEvent: (event) => {
        this.handleRunnerEvent(task, chatId, event);
      }
    });

    task.runner = runner;
    this.running.set(task.id, task);

    try {
      const result = await runner.result;
      await task.streamChain;
      this.store.upsertConversation(task.chatKey, {
        sessionId: result.sessionId,
        lastTaskId: task.id,
        lastSenderOpenId: task.senderOpenId
      });

      const headerLines = [`任务 ${task.id} 已完成。`];
      if (result.sessionId) {
        headerLines.push(`session: ${result.sessionId}`);
      }

      const alreadyStreamedFinalMessage =
        this.config.feishuStreamOutputEnabled &&
        result.finalMessage.trim() &&
        result.finalMessage.trim() === task.lastStreamedAgentMessage;
      const finalText = alreadyStreamedFinalMessage
        ? headerLines.join("\n")
        : `${headerLines.join("\n")}\n\n${result.finalMessage}`;
      const chunks = splitText(finalText, this.config.maxReplyChars);
      for (const chunk of chunks) {
        await this.safeSend(chatId, chunk);
      }
    } catch (error) {
      await task.streamChain;
      await this.safeSend(
        chatId,
        `任务 ${task.id} 执行失败：\n${error.message || String(error)}`
      );
    } finally {
      this.running.delete(task.id);
      this.pumpQueue();
    }
  }

  async safeSend(chatId, text) {
    try {
      await this.feishuClient.sendText(chatId, text);
    } catch (error) {
      console.error("[feishu] send failed:", error);
    }
  }

  getHealth() {
    return {
      runningTasks: this.running.size,
      queuedTasks: this.queue.length,
      conversations: this.store.conversationCount()
    };
  }
}
