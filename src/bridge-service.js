import fs from "node:fs";
import path from "node:path";
import { runCodexTask as defaultRunCodexTask } from "./codex-runner.js";
import {
  autoCommitWorkspace as defaultAutoCommitWorkspace,
  rollbackAutoCommitWorkspace as defaultRollbackAutoCommitWorkspace
} from "./git-commit.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RECENT_EVENT_TTL_MS = 5 * 60 * 1000;
const MAX_RECENT_EVENTS = 500;

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
  return `T${String(number).padStart(3, "0")}`;
}

const SUMMARY_ACTION_RULES = [
  [/^(请)?(优化|改进|改良)/, "优化"],
  [/^(请)?(修复|解决|排查|处理)/, "修复"],
  [/^(请)?(新增|增加|添加|支持|实现)/, "新增"],
  [/^(请)?(安装|集成)/, "安装"],
  [/^(请)?(测试|验证)/, "测试"],
  [/^(请)?(检查|查看|审查|review|review当前)/i, "检查"],
  [/^(请)?(分析|解释|说明)/, "分析"],
  [/^(请)?(重构)/, "重构"],
  [/^(请)?(整理|汇总|总结)/, "整理"]
];

function normalizeSummaryText(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[[^\]]+\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, (match) => {
      const gitSkill = match.match(/skills\/(?:\.curated|\.experimental)\/([^/?#]+)/);
      if (gitSkill) {
        return `${gitSkill[1]} 技能`;
      }
      const githubTree = match.match(/github\.com\/[^/]+\/[^/]+\/tree\/[^/]+\/(.+)$/);
      if (githubTree) {
        const last = githubTree[1].split("/").filter(Boolean).pop();
        return last || "链接";
      }
      return "链接";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function detectSummaryAction(text) {
  const normalized = normalizeSummaryText(text);
  for (const [pattern, label] of SUMMARY_ACTION_RULES) {
    if (pattern.test(normalized)) {
      return label;
    }
  }
  return "";
}

function extractSummaryTopic(text, action) {
  const normalized = normalizeSummaryText(text)
    .replace(/^(请|帮我|麻烦你|需要你)\s*/, "")
    .replace(/^(看下|看看)\s*/, "");
  if (!normalized) {
    return "";
  }

  if (action) {
    const actionPattern = new RegExp(`^${action}`);
    const withoutAction = normalized.replace(actionPattern, "").trim();
    const directTopic = withoutAction
      .split(/[，。；！？,.!?\n]/, 1)[0]
      .replace(/^(一下|下|一下子|一下这个|一下这条|一下当前)\s*/, "")
      .replace(/^(任务|技能|功能|按钮)\s*/, (match) => match)
      .trim();
    if (directTopic) {
      return directTopic;
    }
  }

  const codeMatch = normalized.match(/([A-Za-z0-9._/-]+\.(js|ts|md|json|yaml|yml))/i);
  if (codeMatch) {
    return codeMatch[1];
  }

  return normalized.split(/[，。；！？,.!?\n]/, 1)[0].trim();
}

function summarizeTaskPrompt(prompt, maxChars = 18) {
  const normalized = normalizeSummaryText(
    String(prompt || "")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, 3)
      .join(" ")
  );
  if (!normalized) {
    return "task";
  }

  const action = detectSummaryAction(normalized);
  let topic = extractSummaryTopic(normalized, action);
  topic = topic
    .replace(/^(当前|这个|这次)\s*/, "")
    .replace(/(，|。|；|！|？).*$/, "")
    .replace(/\s+/g, "")
    .replace(/^请/, "")
    .trim();

  let summary = action
    ? `${action}${topic && !topic.startsWith(action) ? topic : topic.replace(new RegExp(`^${action}`), "")}`
    : topic || normalized;
  summary = summary
    .replace(/^(检查当前)/, "检查")
    .replace(/^(查看当前)/, "查看")
    .replace(/^(review)/i, "审查")
    .trim();

  if (!summary) {
    summary = "task";
  }
  if (summary.length > maxChars) {
    summary = summary.slice(0, maxChars).replace(/[，。；！？,.!?\s_-]+$/g, "");
  }
  return summary || "task";
}

function buildTaskName(task) {
  return task.id;
}

function matchesTaskReference(task, reference) {
  const normalized = String(reference || "").trim();
  if (!normalized) {
    return false;
  }
  return normalized === task.id || normalized === buildTaskName(task);
}

function createTaskAbortError() {
  const error = new Error("收到终止请求，任务在收尾阶段已取消。");
  error.code = "TASK_ABORTED";
  return error;
}

function helpText() {
  return [
    "Codex Feishu Bridge 命令：",
    "/help 查看帮助",
    "/status 查看当前会话、工作目录与任务状态",
    "/reset 清空当前聊天绑定的 Codex 会话",
    "/retry [任务号] 重试当前聊天中最近的中断任务，或指定中断任务",
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

function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

function extractTokenUsage(event) {
  const payload =
    event?.type === "event_msg"
      ? event.payload
      : event?.type === "token_count"
        ? event
        : null;
  if (payload?.type !== "token_count") {
    return null;
  }

  const totalTokens = Number(payload.info?.total_token_usage?.total_tokens);
  const modelContextWindow = Number(payload.info?.model_context_window);
  if (!Number.isFinite(totalTokens) || !Number.isFinite(modelContextWindow) || modelContextWindow <= 0) {
    return null;
  }

  return {
    modelContextWindow,
    ratio: totalTokens / modelContextWindow,
    totalTokens
  };
}

function memoryFileNameForChat(chatKey) {
  return `${Buffer.from(chatKey).toString("base64url")}.md`;
}

function estimateTokenCount(text) {
  const normalized = String(text || "").replace(/\s+/g, "");
  return Math.max(
    Math.ceil(normalized.length / 4),
    normalized.length
  );
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
  return (
    eventEnvelope?.event_type ||
    eventEnvelope?.header?.event_type ||
    eventEnvelope?.event?.type ||
    ""
  );
}

function extractMessageEvent(eventEnvelope) {
  if (eventEnvelope?.event?.message?.message_type !== undefined) {
    return eventEnvelope.event;
  }

  if (eventEnvelope?.message?.message_type !== undefined) {
    return {
      message: eventEnvelope.message,
      sender: eventEnvelope.sender
    };
  }

  return null;
}

function extractEnvelopeEventId(eventEnvelope) {
  return eventEnvelope?.header?.event_id || eventEnvelope?.event_id || "";
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
    contextUsageRatio: task.contextUsageRatio || 0,
    enqueuedAt: task.enqueuedAt,
    finalMessage: task.finalMessage || "",
    id: task.id,
    lastErrorMessage: task.lastErrorMessage || "",
    lastProgressText: task.lastProgressText || "",
    nameSummary: task.nameSummary || summarizeTaskPrompt(task.prompt),
    prompt: task.prompt,
    recovered: Boolean(task.recovered),
    modelContextWindow: task.modelContextWindow || 0,
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
    this.rollbackAutoCommitWorkspace =
      dependencies.rollbackAutoCommitWorkspace || defaultRollbackAutoCommitWorkspace;
    this.metrics = {
      contextCompactionCount: 0,
      duplicateEventCount: 0,
      queuedCancelCount: 0,
      recoveredInterruptedCount: 0,
      recoveredQueuedCount: 0,
      rejectedByChatLimit: 0,
      rejectedByUserLimit: 0
    };
    this.recentEvents = new Map();
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

  getMemoryFilePath(chatKey) {
    return path.join(this.config.contextMemoryDir, memoryFileNameForChat(chatKey));
  }

  readConversationMemory(conversation) {
    const memoryFilePath = conversation?.memoryFilePath;
    if (!memoryFilePath || !fs.existsSync(memoryFilePath)) {
      return "";
    }

    try {
      return fs.readFileSync(memoryFilePath, "utf8").trim();
    } catch (error) {
      console.warn("[memory] failed to read memory file:", error.message);
      return "";
    }
  }

  getMemoryTokenBudget(contextWindow) {
    const resolvedWindow =
      Number(contextWindow) > 0
        ? Number(contextWindow)
        : this.config.contextWindowFallbackTokens;
    return Math.max(
      64,
      Math.floor(resolvedWindow * this.config.contextMemoryLoadFraction)
    );
  }

  trimMemoryToBudget(memoryText, contextWindow) {
    const budgetTokens = this.getMemoryTokenBudget(contextWindow);
    const normalized = String(memoryText || "").trim();
    if (!normalized) {
      return {
        text: "",
        truncated: false
      };
    }

    if (estimateTokenCount(normalized) <= budgetTokens) {
      return {
        text: normalized,
        truncated: false
      };
    }

    let sliceLength = Math.max(
      64,
      Math.floor(normalized.length * (budgetTokens / estimateTokenCount(normalized)))
    );
    let candidate = normalized.slice(0, sliceLength).trim();

    while (candidate && estimateTokenCount(candidate) > budgetTokens) {
      sliceLength = Math.max(0, sliceLength - Math.ceil(sliceLength * 0.1));
      candidate = normalized.slice(0, sliceLength).trim();
    }

    return {
      text: `${candidate}\n\n[记忆内容已按上下文预算截断]`.trim(),
      truncated: true
    };
  }

  buildPromptWithMemory(prompt, conversation, workspaceDir) {
    if (conversation?.sessionId) {
      return prompt;
    }
    if (conversation?.workspaceDir && conversation.workspaceDir !== workspaceDir) {
      return prompt;
    }

    const memoryText = this.readConversationMemory(conversation);
    if (!memoryText) {
      return prompt;
    }
    const trimmedMemory = this.trimMemoryToBudget(
      memoryText,
      conversation?.lastModelContextWindow
    );

    return [
      `以下是从之前会话压缩得到的记忆，请先阅读并继承这些上下文。已限制为上下文窗口的 ${formatPercent(this.config.contextMemoryLoadFraction)} 以内：`,
      trimmedMemory.text,
      "",
      "请基于这些记忆继续处理下面的新请求。",
      "",
      prompt
    ].join("\n");
  }

  async compactConversationContext(task, sessionId) {
    if (!this.config.contextCompactEnabled || !sessionId) {
      return {
        performed: false
      };
    }
    if (task.contextUsageRatio < this.config.contextCompactThreshold) {
      return {
        performed: false
      };
    }

    const summaryPrompt = [
      "当前会话上下文占用已经接近上限。",
      "请把到目前为止的上下文压缩成一份供后续新会话继续工作的记忆。",
      "要求：",
      "1. 概括用户目标、已完成事项、仍待处理事项。",
      "2. 列出关键文件、配置、约束、已知风险。",
      "3. 如果有未完成任务，给出下一步建议。",
      `4. 控制长度在约 ${this.getMemoryTokenBudget(task.modelContextWindow)} tokens 以内。`,
      "5. 只输出记忆正文，不要寒暄，不要解释。"
    ].join("\n");
    const summaryRunner = this.runCodexTask(this.config, {
      prompt: summaryPrompt,
      sessionId,
      workspaceDir: task.workspaceDir
    });
    const summaryResult = await summaryRunner.result;
    const memoryText = this.trimMemoryToBudget(
      summaryResult.finalMessage,
      task.modelContextWindow
    ).text;
    const memoryFilePath = this.getMemoryFilePath(task.chatKey);

    fs.mkdirSync(path.dirname(memoryFilePath), { recursive: true });
    fs.writeFileSync(memoryFilePath, `${memoryText}\n`, "utf8");

    this.store.upsertConversation(task.chatKey, {
      lastCompactedAt: new Date().toISOString(),
      lastModelContextWindow: task.modelContextWindow || 0,
      lastContextUsageRatio: task.contextUsageRatio,
      memoryFilePath,
      sessionId: ""
    });

    task.lastProgressText = `上下文已压缩归档到 ${memoryFilePath}，后续任务会从记忆继续。`;
    this.metrics.contextCompactionCount += 1;
    return {
      memoryFilePath,
      performed: true
    };
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

  pruneRecentEvents(now = Date.now()) {
    for (const [key, expiresAt] of this.recentEvents) {
      if (expiresAt > now) {
        continue;
      }
      this.recentEvents.delete(key);
    }

    while (this.recentEvents.size > MAX_RECENT_EVENTS) {
      const oldestKey = this.recentEvents.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.recentEvents.delete(oldestKey);
    }
  }

  rememberRecentEvent(eventKey, now = Date.now()) {
    if (!eventKey) {
      return false;
    }

    this.pruneRecentEvents(now);
    const expiresAt = this.recentEvents.get(eventKey);
    if (expiresAt && expiresAt > now) {
      this.metrics.duplicateEventCount += 1;
      return true;
    }

    this.recentEvents.delete(eventKey);
    this.recentEvents.set(eventKey, now + RECENT_EVENT_TTL_MS);
    this.pruneRecentEvents(now);
    return false;
  }

  buildMessageEventKey(eventEnvelope, event) {
    const eventId = extractEnvelopeEventId(eventEnvelope);
    if (eventId) {
      return `event:${extractEventType(eventEnvelope) || "message"}:${eventId}`;
    }
    const messageId = event?.message?.message_id || "";
    return messageId ? `message:${messageId}` : "";
  }

  buildCardActionEventKey(eventEnvelope, action) {
    const eventId = extractEnvelopeEventId(eventEnvelope);
    if (eventId) {
      return `event:${extractEventType(eventEnvelope) || "card"}:${eventId}`;
    }
    if (!action) {
      return "";
    }
    return [
      "card",
      action.name || "",
      action.taskId || "",
      action.replyToMessageId || "",
      action.senderOpenId || ""
    ].join(":");
  }

  async dispatchEvent(eventEnvelope) {
    const eventType = extractEventType(eventEnvelope);
    if (eventType === "card.action.trigger") {
      await this.handleCardAction(eventEnvelope);
      return null;
    }

    const event = extractMessageEvent(eventEnvelope);
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

    if (this.rememberRecentEvent(this.buildCardActionEventKey(eventEnvelope, action))) {
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

    if (action.name === "retry") {
      await this.handleCommand({
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
      contextUsageRatio: 0,
      enqueuedAt: new Date().toISOString(),
      finalMessage: "",
      id: formatTaskId(this.nextTaskNumber++),
      lastErrorMessage: "",
      lastProgressText: "",
      lastStreamSentAt: 0,
      modelContextWindow: 0,
      nameSummary: summarizeTaskPrompt(prompt),
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

  findInterruptedTask(chatKey, taskReference = "") {
    const normalized = String(taskReference || "").trim();
    if (!normalized) {
      for (let index = this.interruptedTasks.length - 1; index >= 0; index -= 1) {
        const task = this.interruptedTasks[index];
        if (task.chatKey === chatKey) {
          return { index, task };
        }
      }
      return { index: -1, task: null };
    }

    const index = this.interruptedTasks.findIndex(
      (task) => task.chatKey === chatKey && matchesTaskReference(task, normalized)
    );
    return {
      index,
      task: index >= 0 ? this.interruptedTasks[index] : null
    };
  }

  async retryInterruptedTask({ chatId, chatKey, taskReference = "", target, silentSuccess }) {
    const pendingForChat = this.countPendingTasksForChat(chatKey);
    if (pendingForChat >= this.config.maxQueuedTasksPerChat) {
      this.metrics.rejectedByChatLimit += 1;
      await this.safeSend(
        target,
        `当前聊天待处理任务已达上限（${this.config.maxQueuedTasksPerChat}）。请等待已有任务完成，或用 /abort <任务号> 取消排队任务。`
      );
      return;
    }

    const { index, task } = this.findInterruptedTask(chatKey, taskReference);
    if (!task) {
      await this.safeSend(
        target,
        taskReference
          ? `当前聊天没有中断任务 ${taskReference}。`
          : "当前聊天没有可重试的中断任务。"
      );
      return;
    }

    const pendingForUser = this.countPendingTasksForUser(task.senderOpenId);
    if (pendingForUser >= this.config.maxQueuedTasksPerUser) {
      this.metrics.rejectedByUserLimit += 1;
      await this.safeSend(
        target,
        `当前用户待处理任务已达上限（${this.config.maxQueuedTasksPerUser}）。请等待已有任务完成，或取消排队中的任务。`
      );
      return;
    }

    this.interruptedTasks.splice(index, 1);
    task.status = "queued";
    task.recovered = true;
    task.abortRequested = false;
    task.autoCommitSummary = "";
    task.contextUsageRatio = 0;
    task.enqueuedAt = new Date().toISOString();
    task.finalMessage = "";
    task.lastErrorMessage = "";
    task.lastProgressText = "任务已从中断状态重新入队。";
    task.lastStreamSentAt = 0;
    task.modelContextWindow = 0;
    task.sessionId = "";
    task.startedAt = "";
    task.startedCommandIds = new Set();
    task.completedCommandIds = new Set();
    task.streamChain = Promise.resolve();
    task.workspaceDir = task.workspaceDir || this.resolveWorkspaceDir(chatKey, chatId);
    this.queue.push(task);
    const queuePosition = this.queue.findIndex((item) => item.id === task.id) + 1;
    this.persistRuntime();
    await this.syncTaskCard(task);
    await this.refreshQueuedTaskCards();
    this.pumpQueue();

    if (!silentSuccess) {
      await this.safeSend(
        target,
        `已重试任务 ${buildTaskName(task)}，队列位置 ${queuePosition}。`
      );
    }
  }

  buildTaskCard(task) {
    const taskName = buildTaskName(task);
    const actions = [];
    if (task.status === "queued" || task.status === "running") {
      actions.push(
        buildCardButton("终止任务", "danger", {
          action: "abort",
          chatId: task.target.chatId,
          chatKey: task.chatKey,
          replyToMessageId: task.target.replyToMessageId,
          taskId: task.id
        })
      );
    }
    if (task.status === "interrupted") {
      actions.push(
        buildCardButton("重试任务", "primary", {
          action: "retry",
          chatId: task.target.chatId,
          chatKey: task.chatKey,
          replyToMessageId: task.target.replyToMessageId,
          taskId: task.id
        })
      );
    }
    actions.push(
      buildCardButton("重置会话", "default", {
        action: "reset",
        chatId: task.target.chatId,
        chatKey: task.chatKey,
        replyToMessageId: task.target.replyToMessageId
      })
    );

    const bodyLines = [
      `**任务**：\`${taskName}\``,
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
    if (task.contextUsageRatio > 0) {
      bodyLines.push(`**上下文占用**：${formatPercent(task.contextUsageRatio)}`);
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
          content: taskName,
          tag: "plain_text"
        }
      }
    };
  }

  async sendTaskAck(task) {
    const taskName = buildTaskName(task);
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
      `已接收任务 ${taskName}，队列位置 ${this.queue.findIndex((item) => item.id === task.id) + 1}。工作目录：${task.workspaceDir}`
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
        `memoryFile: ${conversation?.memoryFilePath || "无"}`,
        `running: ${runningTask ? `${buildTaskName(runningTask)} (${runningTask.startedAt})` : "无"}`,
        `queued: ${queuedTasks.map((task) => buildTaskName(task)).join(", ") || "无"}`,
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
              content: "当前状态",
              tag: "plain_text"
            }
          }
        });
        return;
      }

      await this.safeSend(target, lines.join("\n"));
      return;
    }

    if (command === "/retry") {
      const taskReference = rest[0] || "";
      await this.retryInterruptedTask({
        chatId,
        chatKey,
        silentSuccess,
        target,
        taskReference
      });
      return;
    }

    if (command === "/abort") {
      const taskReference = rest[0];
      if (!taskReference) {
        await this.safeSend(target, "用法：/abort T001");
        return;
      }

      const runningTask =
        this.running.get(taskReference) ||
        [...this.running.values()].find((task) => matchesTaskReference(task, taskReference));
      if (runningTask) {
        if (runningTask.chatKey !== chatKey) {
          await this.safeSend(target, `当前聊天没有运行中的任务 ${taskReference}。`);
          return;
        }

        runningTask.abortRequested = true;
        console.log(`[task:${runningTask.id}] abort requested`);
        runningTask.runner.cancel();
        runningTask.lastErrorMessage = "收到终止请求，正在结束任务。";
        await this.syncTaskCard(runningTask);
        if (!silentSuccess) {
          await this.safeSend(target, `已请求终止任务 ${buildTaskName(runningTask)}。`);
        }
        return;
      }

      const queuedIndex = this.queue.findIndex(
        (task) => task.chatKey === chatKey && matchesTaskReference(task, taskReference)
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
          await this.safeSend(target, `已取消排队中的任务 ${buildTaskName(queuedTask)}。`);
        }
        return;
      }

      await this.safeSend(target, `未找到任务 ${taskReference}。`);
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
    const tokenUsage = extractTokenUsage(event);
    if (tokenUsage) {
      task.contextUsageRatio = Math.max(task.contextUsageRatio, tokenUsage.ratio);
      task.modelContextWindow = Math.max(
        task.modelContextWindow || 0,
        tokenUsage.modelContextWindow
      );
      this.persistRuntime();
    }

    if (!this.config.feishuStreamOutputEnabled || !event?.item) {
      return;
    }

    const { item } = event;
    if (item.type === "agent_message" && event.type === "item.completed") {
      const text = String(item.text || "").trim();
      if (!text || text === task.lastProgressText) {
        return;
      }

      this.queueStreamText(task, `任务 ${buildTaskName(task)} 进度更新：\n\n${text}`);
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
        `任务 ${buildTaskName(task)} 正在执行命令：\n${truncateText(item.command, this.config.maxReplyChars)}`
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
        `任务 ${buildTaskName(task)} 命令${item.exit_code === 0 ? "已完成" : "结束"}：`,
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
      return "";
    }
    if (result.status === "skipped" && result.reason === "not-git-repo") {
      return "当前工作目录不是 Git 仓库";
    }
    return `失败：${result.detail || result.reason || "unknown error"}`;
  }

  formatAutoCommitRollbackResult(result) {
    if (!this.config.gitAutoCommitEnabled || !result) {
      return "";
    }
    if (result.status === "rolled-back") {
      return `已回滚自动提交 ${result.commitId || "(unknown)"}`;
    }
    if (result.status === "skipped") {
      if (result.reason === "head-moved") {
        return "自动提交未回滚：HEAD 已变化";
      }
      if (result.reason === "message-mismatch") {
        return "自动提交未回滚：最新提交不属于当前任务";
      }
      return "";
    }
    return `自动提交回滚失败：${result.detail || result.reason || "unknown error"}`;
  }

  ensureTaskNotAborted(task) {
    if (task.abortRequested) {
      throw createTaskAbortError();
    }
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
      prompt: this.buildPromptWithMemory(task.prompt, conversation, task.workspaceDir),
      sessionId,
      workspaceDir: task.workspaceDir
    });

    task.runner = runner;
    this.running.set(task.id, task);
    task.recovered = false;
    this.persistRuntime();
    await this.syncTaskCard(task);

    let autoCommitResult = null;
    try {
      const result = await runner.result;
      await task.streamChain;
      this.ensureTaskNotAborted(task);
      task.status = "completed";
      task.sessionId = result.sessionId || "";
      task.finalMessage = result.finalMessage;
      task.lastErrorMessage = "";
      this.store.upsertConversation(task.chatKey, {
        lastContextUsageRatio: task.contextUsageRatio,
        lastModelContextWindow: task.modelContextWindow || 0,
        memoryFilePath: conversation?.memoryFilePath || "",
        lastSenderOpenId: task.senderOpenId,
        lastTaskId: task.id,
        sessionId: result.sessionId,
        workspaceDir: task.workspaceDir
      });

      this.ensureTaskNotAborted(task);
      autoCommitResult = await this.autoCommitWorkspace(this.config, task);
      task.autoCommitSummary = this.formatAutoCommitResult(autoCommitResult);
      let compacted = false;
      if (result.sessionId) {
        try {
          this.ensureTaskNotAborted(task);
          const compactResult = await this.compactConversationContext(task, result.sessionId);
          compacted = compactResult.performed;
        } catch (error) {
          console.error(`[task:${task.id}] context compaction failed:`, error);
          task.lastProgressText = `上下文压缩失败，将继续沿用当前会话：${error.message || String(error)}`;
        }
      }
      if (compacted) {
        task.sessionId = "";
      }
      this.ensureTaskNotAborted(task);
      await this.syncTaskCard(task);

      if (!this.config.feishuInteractiveCardsEnabled) {
        const finalText = [
          `任务 ${buildTaskName(task)} 已完成。`,
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
      task.lastErrorMessage =
        task.abortRequested && task.lastErrorMessage
          ? task.lastErrorMessage
          : error.message || String(error);
      task.finalMessage = "";
      task.autoCommitSummary = "";
      if (task.abortRequested && autoCommitResult?.status === "committed") {
        const rollbackResult = await this.rollbackAutoCommitWorkspace(
          this.config,
          task,
          autoCommitResult.commitId
        );
        task.autoCommitSummary = this.formatAutoCommitRollbackResult(rollbackResult);
        console.log(
          `[task:${task.id}] auto commit rollback result: ${rollbackResult.status}${rollbackResult.reason ? ` (${rollbackResult.reason})` : ""}`
        );
      }
      await this.syncTaskCard(task);

      if (!this.config.feishuInteractiveCardsEnabled) {
        await this.safeSend(
          task.target,
          task.abortRequested
            ? `任务 ${buildTaskName(task)} 已取消。\n${task.lastErrorMessage}`
            : [`任务 ${buildTaskName(task)} 执行失败：`, task.lastErrorMessage].join("\n")
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
      contextCompactionCount: this.metrics.contextCompactionCount,
      duplicateEventCount: this.metrics.duplicateEventCount,
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
