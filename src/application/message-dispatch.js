const RECENT_EVENT_TTL_MS = 5 * 60 * 1000;
const MAX_RECENT_EVENTS = 500;
const MAX_RECENT_TASK_REQUESTS = 500;

export class MessageDispatchService {
  constructor(bridge, helpers) {
    this.bridge = bridge;
    this.helpers = helpers;
  }

  pruneRecentEvents(now = Date.now()) {
    for (const [key, expiresAt] of this.bridge.recentEvents) {
      if (expiresAt > now) {
        continue;
      }
      this.bridge.recentEvents.delete(key);
    }

    while (this.bridge.recentEvents.size > MAX_RECENT_EVENTS) {
      const oldestKey = this.bridge.recentEvents.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.bridge.recentEvents.delete(oldestKey);
    }
  }

  pruneRecentTaskRequests(now = Date.now()) {
    for (const [key, expiresAt] of this.bridge.recentTaskRequests) {
      if (expiresAt > now) {
        continue;
      }
      this.bridge.recentTaskRequests.delete(key);
    }

    while (this.bridge.recentTaskRequests.size > MAX_RECENT_TASK_REQUESTS) {
      const oldestKey = this.bridge.recentTaskRequests.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.bridge.recentTaskRequests.delete(oldestKey);
    }
  }

  rememberRecentEvent(eventKey, now = Date.now()) {
    if (!eventKey) {
      return false;
    }

    this.pruneRecentEvents(now);
    const expiresAt = this.bridge.recentEvents.get(eventKey);
    if (expiresAt && expiresAt > now) {
      this.bridge.metrics.duplicateEventCount += 1;
      return true;
    }

    this.bridge.recentEvents.delete(eventKey);
    this.bridge.recentEvents.set(eventKey, now + RECENT_EVENT_TTL_MS);
    this.pruneRecentEvents(now);
    return false;
  }

  buildTaskRequestKey(chatKey, senderOpenId, prompt) {
    const normalizedPrompt = this.helpers.normalizeTaskRequestText(prompt);
    if (!chatKey || !senderOpenId || !normalizedPrompt) {
      return "";
    }
    return `${chatKey}:${senderOpenId}:${normalizedPrompt}`;
  }

  hasEquivalentPendingTask(chatKey, senderOpenId, prompt) {
    const normalizedPrompt = this.helpers.normalizeTaskRequestText(prompt);
    if (!normalizedPrompt) {
      return false;
    }

    return (
      this.bridge.queue.some(
        (task) =>
          task.chatKey === chatKey &&
          task.senderOpenId === senderOpenId &&
          this.helpers.normalizeTaskRequestText(task.prompt) === normalizedPrompt
      ) ||
      [...this.bridge.running.values()].some(
        (task) =>
          task.chatKey === chatKey &&
          task.senderOpenId === senderOpenId &&
          this.helpers.normalizeTaskRequestText(task.prompt) === normalizedPrompt
      )
    );
  }

  rememberRecentTaskRequest(chatKey, senderOpenId, prompt, now = Date.now()) {
    if (this.bridge.config.duplicateTaskWindowMs <= 0) {
      return false;
    }

    const taskRequestKey = this.buildTaskRequestKey(chatKey, senderOpenId, prompt);
    if (!taskRequestKey) {
      return false;
    }

    this.pruneRecentTaskRequests(now);
    const expiresAt = this.bridge.recentTaskRequests.get(taskRequestKey);
    if (expiresAt && expiresAt > now) {
      this.bridge.metrics.duplicateTaskCount += 1;
      return true;
    }

    this.bridge.recentTaskRequests.delete(taskRequestKey);
    this.bridge.recentTaskRequests.set(
      taskRequestKey,
      now + this.bridge.config.duplicateTaskWindowMs
    );
    this.pruneRecentTaskRequests(now);
    return false;
  }

  buildMessageEventKey(eventEnvelope, event) {
    const eventId = this.helpers.extractEnvelopeEventId(eventEnvelope);
    if (eventId) {
      return `event:${this.helpers.extractEventType(eventEnvelope) || "message"}:${eventId}`;
    }
    const messageId = event?.message?.message_id || "";
    return messageId ? `message:${messageId}` : "";
  }

  buildCardActionEventKey(eventEnvelope, action) {
    const eventId = this.helpers.extractEnvelopeEventId(eventEnvelope);
    if (eventId) {
      return `event:${this.helpers.extractEventType(eventEnvelope) || "card"}:${eventId}`;
    }
    if (!action) {
      return "";
    }
    return [
      "card",
      action.name || "",
      action.taskId || "",
      action.interactionId || "",
      action.optionId || "",
      action.replyToMessageId || "",
      action.senderOpenId || ""
    ].join(":");
  }

  async handleBotAddedEvent(eventEnvelope) {
    if (this.rememberRecentEvent(this.helpers.extractEnvelopeEventId(eventEnvelope))) {
      return;
    }

    const event = this.helpers.extractBotAddedEvent(eventEnvelope);
    const chatId = event?.chat_id || "";
    const chatKey = chatId ? `group:${chatId}` : "";
    if (!chatId || !chatKey || this.bridge.hasBoundWorkspace(chatKey, chatId)) {
      return;
    }

    await this.bridge.sendWorkspaceBindingPrompt(
      {
        chatId,
        replyToMessageId: ""
      },
      chatKey,
      chatId
    );
  }

  async handleCardAction(eventEnvelope) {
    const action = this.helpers.extractCardAction(eventEnvelope);
    if (!action) {
      return;
    }

    if (this.rememberRecentEvent(this.buildCardActionEventKey(eventEnvelope, action))) {
      return;
    }

    if (
      this.bridge.config.feishuAllowedOpenIds.size > 0 &&
      !this.bridge.config.feishuAllowedOpenIds.has(action.senderOpenId)
    ) {
      await this.bridge.safeSend(
        {
          chatId: action.chatId,
          replyToMessageId: action.replyToMessageId
        },
        "当前用户未被授权使用这个 Codex 桥接器。"
      );
      return;
    }

    if (action.name === "abort") {
      await this.bridge.handleCommand({
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

    if (action.name === "retry") {
      await this.bridge.handleCommand({
        chatId: action.chatId,
        chatKey: action.chatKey,
        commandText: `/retry ${action.taskId}`.trim(),
        senderOpenId: action.senderOpenId,
        silentSuccess: true,
        target: {
          chatId: action.chatId,
          replyToMessageId: action.replyToMessageId
        }
      });
      return;
    }

    if (action.name === "choose") {
      const interaction = this.bridge.getPendingInteraction(action.chatKey);
      if (!interaction || interaction.id !== action.interactionId) {
        await this.bridge.safeSend(
          {
            chatId: action.chatId,
            replyToMessageId: action.replyToMessageId
          },
          "这个选择卡片已失效，请让 Codex 重新发起一次选择。"
        );
        return;
      }
      await this.bridge.choosePendingInteraction({
        chatId: action.chatId,
        chatKey: action.chatKey,
        optionId: action.optionId,
        silentSuccess: true,
        target: {
          chatId: action.chatId,
          replyToMessageId: action.replyToMessageId
        }
      });
      return;
    }

    if (action.name === "reset") {
      await this.bridge.handleCommand({
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

  async dispatchEvent(eventEnvelope) {
    const eventType = this.helpers.extractEventType(eventEnvelope);
    if (eventType === "card.action.trigger") {
      await this.handleCardAction(eventEnvelope);
      return null;
    }
    if (eventType === "im.chat.member.bot.added_v1") {
      await this.handleBotAddedEvent(eventEnvelope);
      return null;
    }

    const event = this.helpers.extractMessageEvent(eventEnvelope);
    if (!event || event.message?.message_type === undefined) {
      return null;
    }
    if (event.sender?.sender_type && event.sender.sender_type !== "user") {
      return null;
    }

    if (this.rememberRecentEvent(this.buildMessageEventKey(eventEnvelope, event))) {
      return null;
    }

    const senderOpenId = event.sender?.sender_id?.open_id || "";
    if (
      this.bridge.config.feishuAllowedOpenIds.size > 0 &&
      !this.bridge.config.feishuAllowedOpenIds.has(senderOpenId)
    ) {
      await this.bridge.safeSend(
        this.helpers.buildReplyTarget(this.bridge.config, event),
        "当前用户未被授权使用这个 Codex 桥接器。"
      );
      return null;
    }

    const parsedContent = this.helpers.parseContent(event);
    if (!parsedContent.text) {
      await this.bridge.safeSend(
        this.helpers.buildReplyTarget(this.bridge.config, event),
        parsedContent.parseError
          ? "消息内容解析失败，暂不支持该消息格式。"
          : "当前仅支持文本消息。"
      );
      return null;
    }

    const mentions = event.message.mentions || [];
    if (
      event.message.chat_type !== "p2p" &&
      this.bridge.config.requireMentionInGroup &&
      !this.bridge.isBotMentioned(mentions)
    ) {
      return null;
    }

    const text = this.helpers.stripMentions(parsedContent.text, mentions);
    const chatKey = this.helpers.chatKeyFor(event);
    const target = this.helpers.buildReplyTarget(this.bridge.config, event);
    if (!text) {
      await this.bridge.safeSend(target, this.helpers.helpText());
      return null;
    }

    if (
      event.message.chat_type !== "p2p" &&
      !text.startsWith("/") &&
      this.bridge.requiresWorkspaceBinding(chatKey, event.message.chat_id)
    ) {
      await this.bridge.sendWorkspaceBindingPrompt(target, chatKey, event.message.chat_id);
      return null;
    }

    if (text.startsWith("/")) {
      await this.bridge.handleCommand({
        chatId: event.message.chat_id,
        chatKey,
        commandText: text,
        senderOpenId,
        target
      });
      return null;
    }

    const pendingForChat = this.bridge.countPendingTasksForChat(chatKey);
    if (pendingForChat >= this.bridge.config.maxQueuedTasksPerChat) {
      this.bridge.metrics.rejectedByChatLimit += 1;
      await this.bridge.safeSend(
        target,
        `当前聊天待处理任务已达上限（${this.bridge.config.maxQueuedTasksPerChat}）。请等待已有任务完成，或用 /abort <任务号> 取消排队任务。`
      );
      return null;
    }

    const pendingForUser = this.bridge.countPendingTasksForUser(senderOpenId, chatKey);
    if (pendingForUser >= this.bridge.config.maxQueuedTasksPerUser) {
      this.bridge.metrics.rejectedByUserLimit += 1;
      await this.bridge.safeSend(
        target,
        `当前聊天内该用户待处理任务已达上限（${this.bridge.config.maxQueuedTasksPerUser}）。请等待已有任务完成，或取消排队中的任务。`
      );
      return null;
    }

    if (this.hasEquivalentPendingTask(chatKey, senderOpenId, text)) {
      this.bridge.metrics.duplicateTaskCount += 1;
      await this.bridge.safeSend(target, "检测到相同指令已在执行或排队，已忽略这次重复请求。");
      return null;
    }

    if (this.rememberRecentTaskRequest(chatKey, senderOpenId, text)) {
      await this.bridge.safeSend(target, "检测到短时间内重复发送了相同指令，已忽略。");
      return null;
    }

    const task = this.bridge.enqueueTask(event, text, senderOpenId, target);
    if (this.bridge.config.taskAckEnabled) {
      await this.bridge.sendTaskAck(task);
    }
    await this.bridge.refreshQueuedTaskCards();
    this.bridge.pumpQueue();
    return null;
  }
}
