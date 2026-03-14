import { runCodexTask as defaultRunCodexTask } from "./codex-runner.js";
import { autoCommitWorkspace as defaultAutoCommitWorkspace } from "./git-commit.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chatKeyFor(event) {
  return `${event.message.chat_type}:${event.message.chat_id}`;
}

function parseContent(event) {
  if (event.message.message_type !== "text") {
    return {
      parseError: false,
      text: null
    };
  }

  try {
    const payload = JSON.parse(event.message.content || "{}");
    return {
      parseError: false,
      text: typeof payload.text === "string" ? payload.text : null
    };
  } catch (error) {
    console.warn("[bridge] failed to parse message content:", error.message);
    return {
      parseError: true,
      text: null
    };
  }
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
  let rest = String(text || "").trim();
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
    "/status 查看当前会话、工作目录与任务状态",
    "/reset 清空当前聊天绑定的 Codex 会话",
    "/abort <任务号> 终止运行中的任务，或取消排队中的任务",
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

function buildReplyTarget(config, event) {
  return {
    chatId: event.message.chat_id,
    replyToMessageId: config.feishuReplyToMessageEnabled
      ? event.message.message_id
      : ""
  };
}

function buildCardButton(text, type, value) {
  return {
    tag: "button",
    text: {
      content: text,
      tag: "plain_text"
    },
    type,
    value
  };
}

function extractEventType(eventEnvelope) {
  return eventEnvelope?.header?.event_type || eventEnvelope?.event?.type || "";
}

function extractCardAction(eventEnvelope) {
  const event = eventEnvelope?.event || {};
  const action = event.action || eventEnvelope?.action;
  const value = action?.value || {};
  if (!action || !value.action) {
    return null;
  }

  return {
    chatId: value.chatId || value.chat_id || "",
    chatKey: value.chatKey || value.chat_key || "",
    name: value.action,
    replyToMessageId:
      value.replyToMessageId ||
      value.reply_to_message_id ||
      value.sourceMessageId ||
      "",
    senderOpenId:
      event.operator?.operator_id?.open_id ||
      eventEnvelope?.operator?.operator_id?.open_id ||
      "",
    taskId: value.taskId || value.task_id || ""
  };
}

function taskStatusLabel(status) {
  if (status === "queued") {
    return "排队中";
  }
  if (status === "running") {
    return "执行中";
  }
  if (status === "completed") {
    return "已完成";
  }
  if (status === "failed") {
    return "执行失败";
  }
  if (status === "cancelled") {
    return "已取消";
  }
  if (status === "interrupted") {
    return "已中断";
  }
  return status || "未知";
}

function sanitizeTaskSnapshot(task) {
  return {
    autoCommitSummary: task.autoCommitSummary || "",
    cardMessageId: task.cardMessageId || "",
    chatKey: task.chatKey,
    enqueuedAt: task.enqueuedAt,
    finalMessage: task.finalMessage || "",
    id: task.id,
    lastErrorMessage: task.lastErrorMessage || "",
    lastProgressText: task.lastProgressText || "",
    prompt: task.prompt,
    recovered: Boolean(task.recovered),
    senderOpenId: task.senderOpenId || "",
    sessionId: task.sessionId || "",
    startedAt: task.startedAt || "",
    status: task.status,
    target: {
      chatId: task.target?.chatId || "",
      replyToMessageId: task.target?.replyToMessageId || ""
    },
    workspaceDir: task.workspaceDir
  };
}

function restoreTask(snapshot) {
  return {
    ...sanitizeTaskSnapshot(snapshot),
    abortRequested: false,
    completedCommandIds: new Set(),
    lastStreamSentAt: 0,
    startedCommandIds: new Set(),
    status: snapshot.status || "queued",
    streamChain: Promise.resolve()
  };
}

export class BridgeService {
  constructor(config, store, feishuClient, dependencies = {}) {
    this.config = config;
    this.store = store;
    this.feishuClient = feishuClient;
    this.runCodexTask = dependencies.runCodexTask || defaultRunCodexTask;
    this.autoCommitWorkspace =
      dependencies.autoCommitWorkspace || defaultAutoCommitWorkspace;
    this.metrics = {
      queuedCancelCount: 0,
      recoveredInterruptedCount: 0,
      recoveredQueuedCount: 0,
      rejectedByChatLimit: 0,
      rejectedByUserLimit: 0
    };
    this.running = new Map();
    this.hasResumedRecoveredTasks = false;

    const runtime = this.store.getRuntimeSnapshot();
    this.nextTaskNumber = runtime.nextTaskNumber || 1;
    this.queue = (runtime.queue || []).map((task) => restoreTask(task));
    this.interruptedTasks = (runtime.interrupted || []).map((task) => restoreTask(task));
    this.metrics.recoveredQueuedCount = this.queue.length;
    this.metrics.recoveredInterruptedCount = this.interruptedTasks.length;
    this.persistRuntime();
  }

  resolveWorkspaceDir(chatKey, chatId) {
    return (
      this.config.chatWorkspaceMappings.get(chatKey) ||
      this.config.chatWorkspaceMappings.get(chatId) ||
      this.config.codexWorkspaceDir
    );
  }

  persistRuntime() {
    this.store.saveRuntimeSnapshot({
      interrupted: this.interruptedTasks.map((task) => sanitizeTaskSnapshot(task)),
      nextTaskNumber: this.nextTaskNumber,
      queue: this.queue.map((task) => sanitizeTaskSnapshot(task)),
      running: [...this.running.values()].map((task) => sanitizeTaskSnapshot(task))
    });
  }

  countPendingTasksForChat(chatKey) {
    const queuedCount = this.queue.filter((task) => task.chatKey === chatKey).length;
    const runningCount = [...this.running.values()].filter(
      (task) => task.chatKey === chatKey
    ).length;
    return queuedCount + runningCount;
  }

  countPendingTasksForUser(senderOpenId) {
    if (!senderOpenId) {
      return 0;
    }

    const queuedCount = this.queue.filter(
      (task) => task.senderOpenId === senderOpenId
    ).length;
    const runningCount = [...this.running.values()].filter(
      (task) => task.senderOpenId === senderOpenId
    ).length;
    return queuedCount + runningCount;
  }

  async resumeRecoveredTasks() {
    if (this.hasResumedRecoveredTasks) {
      return;
    }
    this.hasResumedRecoveredTasks = true;

    for (const task of this.interruptedTasks) {
      await this.syncTaskCard(task);
    }

    await this.refreshQueuedTaskCards();
    this.pumpQueue();
  }

  async dispatchEvent(eventEnvelope) {
    const eventType = extractEventType(eventEnvelope);
    if (eventType === "card.action.trigger") {
      await this.handleCardAction(eventEnvelope);
      return null;
    }

    const event = eventEnvelope.event;
    if (!event || event.message?.message_type === undefined) {
      return null;
    }
    if (event.sender?.sender_type && event.sender.sender_type !== "user") {
      return null;
    }

    const senderOpenId = event.sender?.sender_id?.open_id || "";
    if (
      this.config.feishuAllowedOpenIds.size > 0 &&
      !this.config.feishuAllowedOpenIds.has(senderOpenId)
    ) {
      await this.safeSend(
        buildReplyTarget(this.config, event),
        "当前用户未被授权使用这个 Codex 桥接器。"
      );
      return null;
    }

    const parsedContent = parseContent(event);
    if (!parsedContent.text) {
      await this.safeSend(
        buildReplyTarget(this.config, event),
        parsedContent.parseError
          ? "消息内容解析失败，暂不支持该消息格式。"
          : "当前仅支持文本消息。"
      );
      return null;
    }

    const mentions = event.message.mentions || [];
    if (
      event.message.chat_type !== "p2p" &&
      this.config.requireMentionInGroup &&
      !this.isBotMentioned(mentions)
    ) {
      return null;
    }

    const text = stripMentions(parsedContent.text, mentions);
    const chatKey = chatKeyFor(event);
    const target = buildReplyTarget(this.config, event);
    if (!text) {
      await this.safeSend(target, helpText());
      return null;
    }

    if (text.startsWith("/")) {
      await this.handleCommand({
        chatId: event.message.chat_id,
        chatKey,
        commandText: text,
        senderOpenId,
        target
      });
      return null;
    }

    const pendingForChat = this.countPendingTasksForChat(chatKey);
    if (pendingForChat >= this.config.maxQueuedTasksPerChat) {
      this.metrics.rejectedByChatLimit += 1;
      await this.safeSend(
        target,
        `当前聊天待处理任务已达上限（${this.config.maxQueuedTasksPerChat}）。请等待已有任务完成，或用 /abort <任务号> 取消排队任务。`
      );
      return null;
    }

    const pendingForUser = this.countPendingTasksForUser(senderOpenId);
    if (pendingForUser >= this.config.maxQueuedTasksPerUser) {
      this.metrics.rejectedByUserLimit += 1;
      await this.safeSend(
        target,
        `当前用户待处理任务已达上限（${this.config.maxQueuedTasksPerUser}）。请等待已有任务完成，或取消排队中的任务。`
      );
      return null;
    }

    const task = this.enqueueTask(event, text, senderOpenId, target);
    if (this.config.taskAckEnabled) {
      await this.sendTaskAck(task);
    }
    await this.refreshQueuedTaskCards();
    this.pumpQueue();
    return null;
  }

  async handleCardAction(eventEnvelope) {
    const action = extractCardAction(eventEnvelope);
    if (!action) {
      return;
    }

    if (
      this.config.feishuAllowedOpenIds.size > 0 &&
      !this.config.feishuAllowedOpenIds.has(action.senderOpenId)
    ) {
      await this.safeSend(
        {
          chatId: action.chatId,
          replyToMessageId: action.replyToMessageId
        },
        "当前用户未被授权使用这个 Codex 桥接器。"
      );
      return;
    }

    if (action.name === "abort") {
      await this.handleCommand({
        chatId: action.chatId,
        chatKey: action.chatKey,
        commandText: `/abort ${action.taskId}`.trim(),
        senderOpenId: action.senderOpenId,
        silentSuccess: true,
        target: {
          chatId: action.chatId,
          replyToMessageId: action.replyToMessageId
        }
      });
      return;
    }

    if (action.name === "reset") {
      await this.handleCommand({
        chatId: action.chatId,
        chatKey: action.chatKey,
        commandText: "/reset",
        senderOpenId: action.senderOpenId,
        silentSuccess: true,
        target: {
          chatId: action.chatId,
          replyToMessageId: action.replyToMessageId
        }
      });
    }
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

  createTask(event, prompt, senderOpenId, target) {
    const chatKey = chatKeyFor(event);
    return {
      autoCommitSummary: "",
      abortRequested: false,
      cardMessageId: "",
      chatKey,
      completedCommandIds: new Set(),
      enqueuedAt: new Date().toISOString(),
      finalMessage: "",
      id: formatTaskId(this.nextTaskNumber++),
      lastErrorMessage: "",
      lastProgressText: "",
      lastStreamSentAt: 0,
      prompt,
      recovered: false,
      senderOpenId,
      sessionId: "",
      startedAt: "",
      startedCommandIds: new Set(),
      status: "queued",
      streamChain: Promise.resolve(),
      target,
      workspaceDir: this.resolveWorkspaceDir(chatKey, event.message.chat_id)
    };
  }

  enqueueTask(event, prompt, senderOpenId, target) {
    const task = this.createTask(event, prompt, senderOpenId, target);
    this.queue.push(task);
    this.persistRuntime();
    return task;
  }

  buildTaskCard(task) {
    const actions = [];
    if (task.status === "queued" || task.status === "running") {
      actions.push(
        buildCardButton("Abort", "danger", {
          action: "abort",
          chatId: task.target.chatId,
          chatKey: task.chatKey,
          replyToMessageId: task.target.replyToMessageId,
          taskId: task.id
        })
      );
    }
    actions.push(
      buildCardButton("Reset Session", "default", {
        action: "reset",
        chatId: task.target.chatId,
        chatKey: task.chatKey,
        replyToMessageId: task.target.replyToMessageId
      })
    );

    const bodyLines = [
      `**任务**：\`${task.id}\``,
      `**状态**：${taskStatusLabel(task.status)}`,
      `**工作目录**：\`${task.workspaceDir}\``
    ];

    const queueIndex = this.queue.findIndex((item) => item.id === task.id);
    if (task.status === "queued" && queueIndex >= 0) {
      bodyLines.push(`**队列位置**：${queueIndex + 1}`);
    }
    if (task.sessionId) {
      bodyLines.push(`**Session**：\`${task.sessionId}\``);
    }
    if (task.recovered) {
      bodyLines.push("**恢复状态**：服务重启后已恢复该任务快照");
    }
    if (task.startedAt) {
      bodyLines.push(`**开始时间**：${task.startedAt}`);
    }
    if (task.lastProgressText) {
      bodyLines.push(
        `**最近更新**：\n${truncateText(task.lastProgressText, this.config.maxReplyChars)}`
      );
    }
    if (task.finalMessage) {
      bodyLines.push(
        `**结果摘要**：\n${truncateText(task.finalMessage, this.config.maxReplyChars)}`
      );
    }
    if (task.lastErrorMessage) {
      bodyLines.push(
        `**错误信息**：\n${truncateText(task.lastErrorMessage, this.config.maxReplyChars)}`
      );
    }
    if (task.autoCommitSummary) {
      bodyLines.push(`**自动提交**：${task.autoCommitSummary}`);
    }

    return {
      config: {
        update_multi: true,
        wide_screen_mode: true
      },
      elements: [
        {
          tag: "div",
          text: {
            content: bodyLines.join("\n"),
            tag: "lark_md"
          }
        },
        {
          actions,
          tag: "action"
        }
      ],
      header: {
        template:
          task.status === "failed" || task.status === "interrupted"
            ? "red"
            : task.status === "completed"
              ? "green"
              : task.status === "queued"
                ? "blue"
                : "orange",
        title: {
          content: `Codex Task ${task.id}`,
          tag: "plain_text"
        }
      }
    };
  }

  async sendTaskAck(task) {
    if (this.config.feishuInteractiveCardsEnabled) {
      const payload = await this.safeSendCard(task.target, this.buildTaskCard(task));
      const messageId = payload?.data?.message_id || payload?.data?.message?.message_id || "";
      if (messageId) {
        task.cardMessageId = messageId;
        this.persistRuntime();
      }
      return;
    }

    await this.safeSend(
      task.target,
      `已接收任务 ${task.id}，队列位置 ${this.queue.findIndex((item) => item.id === task.id) + 1}。工作目录：${task.workspaceDir}`
    );
  }

  async syncTaskCard(task) {
    if (!this.config.feishuInteractiveCardsEnabled) {
      return;
    }
    if (!task.target?.chatId) {
      return;
    }

    const card = this.buildTaskCard(task);
    if (task.cardMessageId) {
      try {
        await this.feishuClient.updateCard(task.cardMessageId, card);
        return;
      } catch (error) {
        console.error(`[task:${task.id}] update card failed:`, error);
      }
    }

    try {
      const payload = await this.feishuClient.sendCard(task.target.chatId, card, {
        replyToMessageId: task.target.replyToMessageId
      });
      const messageId = payload?.data?.message_id || payload?.data?.message?.message_id || "";
      if (messageId) {
        task.cardMessageId = messageId;
        this.persistRuntime();
      }
    } catch (error) {
      console.error(`[task:${task.id}] send card failed:`, error);
    }
  }

  async refreshQueuedTaskCards() {
    if (!this.config.feishuInteractiveCardsEnabled) {
      return;
    }

    for (const task of this.queue) {
      await this.syncTaskCard(task);
    }
  }

  async handleCommand({
    commandText,
    chatId,
    chatKey,
    target,
    silentSuccess = false
  }) {
    const [command, ...rest] = commandText.trim().split(/\s+/);

    if (command === "/help") {
      await this.safeSend(target, helpText());
      return;
    }

    if (command === "/reset") {
      this.store.clearConversation(chatKey);
      if (!silentSuccess) {
        await this.safeSend(target, "已清空当前聊天绑定的 Codex 会话。");
      }
      return;
    }

    if (command === "/status") {
      const conversation = this.store.getConversation(chatKey);
      const runningTask = [...this.running.values()].find(
        (task) => task.chatKey === chatKey
      );
      const queuedTasks = this.queue.filter((task) => task.chatKey === chatKey);
      const interruptedCount = this.interruptedTasks.filter(
        (task) => task.chatKey === chatKey
      ).length;
      const workspaceDir = this.resolveWorkspaceDir(chatKey, chatId);
      const lines = [
        `chatKey: ${chatKey}`,
        `workspace: ${workspaceDir}`,
        `sessionId: ${conversation?.sessionId || "无"}`,
        `running: ${runningTask ? `${runningTask.id} (${runningTask.startedAt})` : "无"}`,
        `queued: ${queuedTasks.map((task) => task.id).join(", ") || "无"}`,
        `interrupted: ${interruptedCount}`
      ];

      if (this.config.feishuInteractiveCardsEnabled) {
        await this.safeSendCard(target, {
          config: {
            wide_screen_mode: true
          },
          elements: [
            {
              tag: "div",
              text: {
                content: lines.join("\n"),
                tag: "lark_md"
              }
            }
          ],
          header: {
            template: "blue",
            title: {
              content: "Codex Status",
              tag: "plain_text"
            }
          }
        });
        return;
      }

      await this.safeSend(target, lines.join("\n"));
      return;
    }

    if (command === "/abort") {
      const taskId = rest[0];
      if (!taskId) {
        await this.safeSend(target, "用法：/abort T0001");
        return;
      }

      const runningTask = this.running.get(taskId);
      if (runningTask) {
        if (runningTask.chatKey !== chatKey) {
          await this.safeSend(target, `当前聊天没有运行中的任务 ${taskId}。`);
          return;
        }

        runningTask.abortRequested = true;
        runningTask.runner.cancel();
        runningTask.lastErrorMessage = "收到终止请求，正在结束任务。";
        await this.syncTaskCard(runningTask);
        if (!silentSuccess) {
          await this.safeSend(target, `已请求终止任务 ${taskId}。`);
        }
        return;
      }

      const queuedIndex = this.queue.findIndex(
        (task) => task.id === taskId && task.chatKey === chatKey
      );
      if (queuedIndex >= 0) {
        const [queuedTask] = this.queue.splice(queuedIndex, 1);
        queuedTask.status = "cancelled";
        queuedTask.lastErrorMessage = "任务在排队阶段被取消。";
        this.metrics.queuedCancelCount += 1;
        await this.syncTaskCard(queuedTask);
        this.persistRuntime();
        await this.refreshQueuedTaskCards();
        if (!silentSuccess) {
          await this.safeSend(target, `已取消排队中的任务 ${taskId}。`);
        }
        return;
      }

      await this.safeSend(target, `未找到任务 ${taskId}。`);
      return;
    }

    await this.safeSend(target, `未知命令：${command}\n\n${helpText()}`);
  }

  hasRunningTaskForChat(chatKey) {
    return [...this.running.values()].some((task) => task.chatKey === chatKey);
  }

  pumpQueue() {
    while (
      this.running.size < this.config.maxConcurrentTasks &&
      this.queue.length > 0
    ) {
      const nextTaskIndex = this.queue.findIndex(
        (task) => !this.hasRunningTaskForChat(task.chatKey)
      );
      if (nextTaskIndex < 0) {
        return;
      }

      const [task] = this.queue.splice(nextTaskIndex, 1);
      this.runTask(task).catch((error) => {
        console.error(`[task:${task.id}] unexpected error`, error);
      });
    }
  }

  queueStreamText(task, text) {
    const normalized = String(text || "").trim();
    if (!normalized) {
      return;
    }

    task.lastProgressText = normalized;
    task.streamChain = task.streamChain
      .then(async () => {
        const now = Date.now();
        const elapsed = now - task.lastStreamSentAt;
        const waitMs = this.config.feishuStreamUpdateMinIntervalMs - elapsed;
        if (waitMs > 0) {
          await sleep(waitMs);
        }

        if (this.config.feishuInteractiveCardsEnabled) {
          await this.syncTaskCard(task);
        } else {
          const chunks = splitText(normalized, this.config.maxReplyChars);
          for (const chunk of chunks) {
            await this.safeSend(task.target, chunk);
          }
        }
        task.lastStreamSentAt = Date.now();
        this.persistRuntime();
      })
      .catch((error) => {
        console.error(`[task:${task.id}] stream send failed`, error);
      });
  }

  handleRunnerEvent(task, event) {
    if (!this.config.feishuStreamOutputEnabled || !event?.item) {
      return;
    }

    const { item } = event;
    if (item.type === "agent_message" && event.type === "item.completed") {
      const text = String(item.text || "").trim();
      if (!text || text === task.lastProgressText) {
        return;
      }

      this.queueStreamText(task, `任务 ${task.id} 进度更新：\n\n${text}`);
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

      this.queueStreamText(task, lines.join("\n"));
    }
  }

  formatAutoCommitResult(result) {
    if (!this.config.gitAutoCommitEnabled) {
      return "";
    }
    if (result.status === "disabled") {
      return "";
    }
    if (result.status === "committed") {
      return `已创建提交 ${result.commitId || "(unknown)"}`;
    }
    if (result.status === "skipped" && result.reason === "no-changes") {
      return "没有检测到变更";
    }
    if (result.status === "skipped" && result.reason === "not-git-repo") {
      return "当前工作目录不是 Git 仓库";
    }
    return `失败：${result.detail || result.reason || "unknown error"}`;
  }

  async finalizeTask(task) {
    this.running.delete(task.id);
    this.persistRuntime();
    await this.refreshQueuedTaskCards();
    this.pumpQueue();
  }

  async runTask(task) {
    task.status = "running";
    task.startedAt = new Date().toISOString();
    task.streamChain = Promise.resolve();
    task.lastStreamSentAt = 0;
    task.lastProgressText = task.recovered
      ? "服务重启后恢复排队，任务已继续执行。"
      : "任务已开始执行。";
    task.startedCommandIds = new Set();
    task.completedCommandIds = new Set();

    const conversation = this.store.getConversation(task.chatKey);
    const sessionId =
      conversation?.workspaceDir === task.workspaceDir ? conversation?.sessionId || null : null;
    const runner = this.runCodexTask(this.config, {
      onEvent: (event) => {
        this.handleRunnerEvent(task, event);
      },
      prompt: task.prompt,
      sessionId,
      workspaceDir: task.workspaceDir
    });

    task.runner = runner;
    this.running.set(task.id, task);
    task.recovered = false;
    this.persistRuntime();
    await this.syncTaskCard(task);

    try {
      const result = await runner.result;
      await task.streamChain;
      task.status = "completed";
      task.sessionId = result.sessionId || "";
      task.finalMessage = result.finalMessage;
      task.lastErrorMessage = "";
      this.store.upsertConversation(task.chatKey, {
        lastSenderOpenId: task.senderOpenId,
        lastTaskId: task.id,
        sessionId: result.sessionId,
        workspaceDir: task.workspaceDir
      });

      const autoCommitResult = await this.autoCommitWorkspace(this.config, task);
      task.autoCommitSummary = this.formatAutoCommitResult(autoCommitResult);
      await this.syncTaskCard(task);

      if (!this.config.feishuInteractiveCardsEnabled) {
        const finalText = [
          `任务 ${task.id} 已完成。`,
          task.sessionId ? `session: ${task.sessionId}` : "",
          `workspace: ${task.workspaceDir}`,
          task.autoCommitSummary ? `自动提交：${task.autoCommitSummary}` : "",
          "",
          task.finalMessage
        ]
          .filter(Boolean)
          .join("\n");
        for (const chunk of splitText(finalText, this.config.maxReplyChars)) {
          await this.safeSend(task.target, chunk);
        }
      }
    } catch (error) {
      await task.streamChain;
      task.status = task.abortRequested ? "cancelled" : "failed";
      task.lastErrorMessage = error.message || String(error);
      const autoCommitResult = await this.autoCommitWorkspace(this.config, task);
      task.autoCommitSummary = this.formatAutoCommitResult(autoCommitResult);
      await this.syncTaskCard(task);

      if (!this.config.feishuInteractiveCardsEnabled) {
        await this.safeSend(
          task.target,
          [`任务 ${task.id} 执行失败：`, task.lastErrorMessage].join("\n")
        );
      }
    } finally {
      await this.finalizeTask(task);
    }
  }

  async safeSend(target, text) {
    if (!target?.chatId) {
      return null;
    }
    try {
      const chunks = splitText(text, this.config.maxReplyChars);
      let payload = null;
      for (const chunk of chunks) {
        payload = await this.feishuClient.sendText(target.chatId, chunk, {
          replyToMessageId: target.replyToMessageId
        });
      }
      return payload;
    } catch (error) {
      console.error("[feishu] send failed:", error);
      return null;
    }
  }

  async safeSendCard(target, card) {
    if (!target?.chatId) {
      return null;
    }
    try {
      return await this.feishuClient.sendCard(target.chatId, card, {
        replyToMessageId: target.replyToMessageId
      });
    } catch (error) {
      console.error("[feishu] send card failed:", error);
      return null;
    }
  }

  getHealth() {
    return {
      conversations: this.store.conversationCount(),
      interruptedTasks: this.interruptedTasks.length,
      queuedCancelCount: this.metrics.queuedCancelCount,
      queuedTasks: this.queue.length,
      recoveredInterruptedCount: this.metrics.recoveredInterruptedCount,
      recoveredQueuedCount: this.metrics.recoveredQueuedCount,
      rejectedByChatLimit: this.metrics.rejectedByChatLimit,
      rejectedByUserLimit: this.metrics.rejectedByUserLimit,
      runningTasks: this.running.size
    };
  }
}
