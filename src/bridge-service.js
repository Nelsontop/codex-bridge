import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { runCodexTask as defaultRunCodexTask } from "./codex-runner.js";
import { prepareWorkspaceBinding as defaultPrepareWorkspaceBinding } from "./workspace-binding.js";
import { BridgeCommandRouter } from "./bridge-command-router.js";
import { markTaskCompleted, markTaskFailed, markTaskRunning } from "./task-lifecycle.js";
import { TaskRuntime } from "./task-runtime.js";
import {
  autoCommitWorkspace as defaultAutoCommitWorkspace,
  rollbackAutoCommitWorkspace as defaultRollbackAutoCommitWorkspace
} from "./git-commit.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RECENT_EVENT_TTL_MS = 5 * 60 * 1000;
const MAX_RECENT_EVENTS = 500;
const MAX_INTERACTION_OPTIONS = 3;
const INTERACTION_BLOCK_PATTERN = /```codex_bridge_interaction\s*([\s\S]*?)```/i;

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
  return `${task.id}-${task.nameSummary || summarizeTaskPrompt(task.prompt)}`;
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
    "/bind <目录> [仓库名] 绑定当前群组工作目录并初始化 GitHub 公共仓库",
    "/status 查看当前会话、工作目录与任务状态",
    "/reset 清空当前聊天绑定的 Codex 会话，不影响工作目录绑定",
    "/choose <选项ID> 选择当前等待确认的卡片选项",
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

function extractRunnerSessionId(event) {
  if (event?.type === "thread.started" && typeof event.thread_id === "string") {
    return event.thread_id;
  }
  if (event?.type === "session.configured" && typeof event.session_id === "string") {
    return event.session_id;
  }
  return "";
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

function normalizeInteractionOptionId(value, index) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
  return normalized || `option-${index + 1}`;
}

function parseInteractionRequest(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return null;
  }

  const match = raw.match(INTERACTION_BLOCK_PATTERN);
  if (!match) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch (error) {
    return {
      error: `交互 JSON 解析失败：${error.message || String(error)}`
    };
  }

  const question = String(parsed?.question || "").trim();
  const rawOptions = Array.isArray(parsed?.options) ? parsed.options.slice(0, MAX_INTERACTION_OPTIONS) : [];
  const options = rawOptions
    .map((option, index) => ({
      id: normalizeInteractionOptionId(option?.id, index),
      label: truncateText(option?.label || option?.title || `选项${index + 1}`, 20),
      prompt: String(option?.prompt || "").trim(),
      style: ["primary", "default", "danger"].includes(option?.style)
        ? option.style
        : index === 0
          ? "primary"
          : "default"
    }))
    .filter((option) => option.label && option.prompt);

  if (!question) {
    return {
      error: "交互请求缺少 question。"
    };
  }
  if (options.length < 2) {
    return {
      error: "交互请求至少需要两个有效选项。"
    };
  }

  return {
    cleanedText: raw.replace(INTERACTION_BLOCK_PATTERN, "").trim(),
    question,
    options
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

function extractBotAddedEvent(eventEnvelope) {
  if (eventEnvelope?.event?.chat_id) {
    return eventEnvelope.event;
  }

  if (eventEnvelope?.chat_id) {
    return eventEnvelope;
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
    interactionId: value.interactionId || value.interaction_id || "",
    name: value.action,
    optionId: value.optionId || value.option_id || "",
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

export class BridgeService {
  constructor(config, store, feishuClient, dependencies = {}) {
    this.config = config;
    this.store = store;
    this.feishuClient = feishuClient;
    this.runCodexTask = dependencies.runCodexTask || defaultRunCodexTask;
    this.prepareWorkspaceBinding =
      dependencies.prepareWorkspaceBinding || defaultPrepareWorkspaceBinding;
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
    this.runtime = new TaskRuntime(this.store);
    this.running = this.runtime.running;
    this.commandRouter = new BridgeCommandRouter(this, {
      buildTaskName,
      helpText,
      matchesTaskReference
    });
    this.hasResumedRecoveredTasks = false;
    this.queue = this.runtime.queue;
    this.interruptedTasks = this.runtime.interruptedTasks;
    this.metrics.recoveredQueuedCount = this.queue.length;
    this.metrics.recoveredInterruptedCount = this.interruptedTasks.length;
  }

  resolveWorkspaceDir(chatKey, chatId) {
    const conversation = this.store.getConversation(chatKey);
    return (
      conversation?.workspaceDir ||
      this.config.chatWorkspaceMappings.get(chatKey) ||
      this.config.chatWorkspaceMappings.get(chatId) ||
      this.config.codexWorkspaceDir
    );
  }

  hasBoundWorkspace(chatKey, chatId) {
    const conversation = this.store.getConversation(chatKey);
    return Boolean(
      conversation?.workspaceDir ||
        this.config.chatWorkspaceMappings.get(chatKey) ||
        this.config.chatWorkspaceMappings.get(chatId)
    );
  }

  requiresWorkspaceBinding(chatKey, chatId) {
    return chatKey.startsWith("group:") && !this.hasBoundWorkspace(chatKey, chatId);
  }

  workspaceBindingHelpText() {
    return [
      "当前群组还没有绑定工作目录，暂不执行任务。",
      "请 @机器人 发送：`/bind <工作目录> [仓库名]`",
      "例如：`/bind /vol3/1000/workspace/project-a project-a`",
      "绑定时会在本地初始化 Git 仓库，并尝试通过已登录的 `gh` CLI 创建 GitHub 公共仓库；若已存在 `origin` 远端则跳过远端创建。",
      "可先发送 `/status` 查看当前状态。"
    ].join("\n");
  }

  getPendingInteraction(chatKey) {
    return this.store.getConversation(chatKey)?.pendingInteraction || null;
  }

  clearPendingInteraction(chatKey) {
    const conversation = this.store.getConversation(chatKey);
    if (!conversation?.pendingInteraction) {
      return;
    }
    this.store.upsertConversation(chatKey, {
      pendingInteraction: null
    });
  }

  buildInteractionText(interaction, taskName = "") {
    return [
      taskName ? `任务 ${taskName} 需要你做选择：` : "当前任务需要你做选择：",
      interaction.question,
      "",
      ...interaction.options.map(
        (option) => `- ${option.id}: ${option.label}\n  /choose ${option.id}`
      )
    ].join("\n");
  }

  async registerPendingInteraction(task, result, interactionRequest) {
    const interaction = {
      id: crypto.randomUUID(),
      chatId: task.target.chatId,
      chatKey: task.chatKey,
      createdAt: new Date().toISOString(),
      options: interactionRequest.options,
      question: interactionRequest.question,
      replyToMessageId: task.target.replyToMessageId || "",
      senderOpenId: task.senderOpenId,
      selectedOptionId: "",
      sessionId: result.sessionId || task.sessionId || "",
      sourceTaskId: task.id,
      sourceTaskName: buildTaskName(task),
      workspaceDir: task.workspaceDir
    };

    this.store.upsertConversation(task.chatKey, {
      lastContextUsageRatio: task.contextUsageRatio,
      lastModelContextWindow: task.modelContextWindow || 0,
      lastSenderOpenId: task.senderOpenId,
      lastTaskId: task.id,
      pendingInteraction: interaction,
      sessionId: result.sessionId || "",
      workspaceDir: task.workspaceDir
    });

    return interaction;
  }

  createTaskForChat({
    chatId,
    chatKey,
    nameSummary = "",
    prompt,
    senderOpenId = "",
    sessionId = "",
    target,
    workspaceDir
  }) {
    return {
      autoCommitSummary: "",
      abortRequested: false,
      cardMessageId: "",
      chatKey,
      completedCommandIds: new Set(),
      contextUsageRatio: 0,
      enqueuedAt: new Date().toISOString(),
      finalMessage: "",
      id: this.runtime.createTaskId(),
      lastErrorMessage: "",
      lastProgressText: "",
      lastStreamSentAt: 0,
      modelContextWindow: 0,
      nameSummary: nameSummary || summarizeTaskPrompt(prompt),
      prompt,
      recovered: false,
      senderOpenId,
      sessionId,
      startedAt: "",
      startedCommandIds: new Set(),
      status: "queued",
      streamChain: Promise.resolve(),
      target,
      workspaceDir
    };
  }

  async sendWorkspaceBindingPrompt(target, chatKey, chatId) {
    const conversation = this.store.upsertConversation(chatKey, {
      bindingPromptedAt: new Date().toISOString(),
      bindingStatus: "pending",
      workspaceDir: this.store.getConversation(chatKey)?.workspaceDir || ""
    });

    const lines = [
      this.workspaceBindingHelpText(),
      conversation?.workspaceDir ? `当前绑定：${conversation.workspaceDir}` : ""
    ]
      .filter(Boolean)
      .join("\n\n");

    await this.safeSend(
      target || {
        chatId,
        replyToMessageId: ""
      },
      lines
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
    this.runtime.persist();
  }

  countPendingTasksForChat(chatKey) {
    return this.runtime.countPendingTasksForChat(chatKey);
  }

  countRunningTasksForChat(chatKey) {
    return this.runtime.countRunningTasksForChat(chatKey);
  }

  countPendingTasksForUser(senderOpenId, chatKey = "") {
    return this.runtime.countPendingTasksForUser(senderOpenId, chatKey);
  }

  findQueuePositionForTask(task) {
    return this.runtime.findQueuePositionForTask(task);
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
      action.interactionId || "",
      action.optionId || "",
      action.replyToMessageId || "",
      action.senderOpenId || ""
    ].join(":");
  }

  async handleBotAddedEvent(eventEnvelope) {
    if (this.rememberRecentEvent(extractEnvelopeEventId(eventEnvelope))) {
      return;
    }

    const event = extractBotAddedEvent(eventEnvelope);
    const chatId = event?.chat_id || "";
    const chatKey = chatId ? `group:${chatId}` : "";
    if (!chatId || !chatKey || this.hasBoundWorkspace(chatKey, chatId)) {
      return;
    }

    await this.sendWorkspaceBindingPrompt(
      {
        chatId,
        replyToMessageId: ""
      },
      chatKey,
      chatId
    );
  }

  async dispatchEvent(eventEnvelope) {
    const eventType = extractEventType(eventEnvelope);
    if (eventType === "card.action.trigger") {
      await this.handleCardAction(eventEnvelope);
      return null;
    }
    if (eventType === "im.chat.member.bot.added_v1") {
      await this.handleBotAddedEvent(eventEnvelope);
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

    if (
      event.message.chat_type !== "p2p" &&
      !text.startsWith("/") &&
      this.requiresWorkspaceBinding(chatKey, event.message.chat_id)
    ) {
      await this.sendWorkspaceBindingPrompt(target, chatKey, event.message.chat_id);
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

    const pendingForUser = this.countPendingTasksForUser(senderOpenId, chatKey);
    if (pendingForUser >= this.config.maxQueuedTasksPerUser) {
      this.metrics.rejectedByUserLimit += 1;
      await this.safeSend(
        target,
        `当前聊天内该用户待处理任务已达上限（${this.config.maxQueuedTasksPerUser}）。请等待已有任务完成，或取消排队中的任务。`
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

    if (action.name === "choose") {
      const interaction = this.getPendingInteraction(action.chatKey);
      if (!interaction || interaction.id !== action.interactionId) {
        await this.safeSend(
          {
            chatId: action.chatId,
            replyToMessageId: action.replyToMessageId
          },
          "这个选择卡片已失效，请让 Codex 重新发起一次选择。"
        );
        return;
      }
      await this.choosePendingInteraction({
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
    return this.createTaskForChat({
      chatId: event.message.chat_id,
      chatKey,
      prompt,
      senderOpenId,
      target,
      workspaceDir: this.resolveWorkspaceDir(chatKey, event.message.chat_id)
    });
  }

  enqueueTask(event, prompt, senderOpenId, target) {
    this.clearPendingInteraction(chatKeyFor(event));
    const task = this.createTask(event, prompt, senderOpenId, target);
    return this.runtime.enqueue(task);
  }

  findInterruptedTask(chatKey, taskReference = "") {
    const normalized = String(taskReference || "").trim();
    if (!normalized) {
      return this.runtime.findInterruptedTask(chatKey);
    }

    return this.runtime.findInterruptedTask(
      chatKey,
      (task) => matchesTaskReference(task, normalized)
    );
  }

  async retryInterruptedTask({ chatId, chatKey, taskReference = "", target, silentSuccess }) {
    await this.commandRouter.retryInterruptedTask({
      chatId,
      chatKey,
      taskReference,
      target,
      silentSuccess
    });
  }

  async choosePendingInteraction({
    chatId,
    chatKey,
    optionId,
    target,
    silentSuccess = false
  }) {
    const normalizedOptionId = String(optionId || "").trim().toLowerCase();
    const interaction = this.getPendingInteraction(chatKey);
    if (!interaction) {
      await this.safeSend(target, "当前聊天没有等待选择的交互。");
      return;
    }
    if (!normalizedOptionId) {
      await this.safeSend(
        target,
        `用法：/choose <选项ID>\n可选项：${interaction.options.map((option) => option.id).join(", ")}`
      );
      return;
    }

    const option = interaction.options.find((item) => item.id === normalizedOptionId);
    if (!option) {
      await this.safeSend(
        target,
        `无效选项 ${normalizedOptionId}。可选项：${interaction.options.map((item) => item.id).join(", ")}`
      );
      return;
    }

    const pendingForChat = this.countPendingTasksForChat(chatKey);
    if (pendingForChat >= this.config.maxQueuedTasksPerChat) {
      this.metrics.rejectedByChatLimit += 1;
      await this.safeSend(
        target,
        `当前聊天待处理任务已达上限（${this.config.maxQueuedTasksPerChat}）。请等待已有任务完成，或用 /abort <任务号> 取消排队任务。`
      );
      return;
    }

    const pendingForUser = this.countPendingTasksForUser(interaction.senderOpenId, chatKey);
    if (pendingForUser >= this.config.maxQueuedTasksPerUser) {
      this.metrics.rejectedByUserLimit += 1;
      await this.safeSend(
        target,
        `当前聊天内该用户待处理任务已达上限（${this.config.maxQueuedTasksPerUser}）。请等待已有任务完成，或取消排队中的任务。`
      );
      return;
    }

    const resolvedWorkspaceDir = interaction.workspaceDir || this.resolveWorkspaceDir(chatKey, chatId);
    const followUpTask = this.createTaskForChat({
      chatId,
      chatKey,
      nameSummary: `继续${option.label}`,
      prompt: option.prompt,
      senderOpenId: interaction.senderOpenId || "",
      sessionId: interaction.sessionId || "",
      target,
      workspaceDir: resolvedWorkspaceDir
    });
    followUpTask.lastProgressText = `已选择 ${option.label}，等待继续执行。`;

    interaction.selectedOptionId = option.id;
    this.store.upsertConversation(chatKey, {
      pendingInteraction: null
    });

    this.runtime.enqueue(followUpTask);
    if (this.config.taskAckEnabled) {
      await this.sendTaskAck(followUpTask);
    }
    await this.refreshQueuedTaskCards();
    this.pumpQueue();

    if (!silentSuccess) {
      await this.safeSend(
        target,
        `已选择 ${option.label}，继续任务 ${buildTaskName(followUpTask)}。`
      );
    }
  }

  buildTaskCard(task) {
    const taskName = buildTaskName(task);
    const bodyLines = [
      `**任务**：\`${taskName}\``,
      `**状态**：${taskStatusLabel(task.status)}`,
      `**工作目录**：\`${task.workspaceDir}\``
    ];

    const queueIndex = this.findQueuePositionForTask(task) - 1;
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
    if (task.status === "queued" || task.status === "running") {
      bodyLines.push(`**终止命令**：\`/abort ${task.id}\``);
    }
    if (task.status === "interrupted") {
      bodyLines.push(`**重试命令**：\`/retry ${task.id}\``);
    }
    bodyLines.push("**重置命令**：`/reset`");

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
      `已接收任务 ${taskName}，队列位置 ${this.findQueuePositionForTask(task)}。工作目录：${task.workspaceDir}`
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

  async bindWorkspace({ chatId, chatKey, repoName, target, workspaceInput }) {
    await this.commandRouter.bindWorkspace({
      chatId,
      chatKey,
      repoName,
      target,
      workspaceInput
    });
  }

  async handleCommand({
    commandText,
    chatId,
    chatKey,
    target,
    silentSuccess = false
  }) {
    await this.commandRouter.handle({
      commandText,
      chatId,
      chatKey,
      target,
      silentSuccess
    });
  }

  hasRunningTaskForChat(chatKey) {
    return this.runtime.hasRunningTaskForChat(chatKey);
  }

  pumpQueue() {
    while (this.queue.length > 0) {
      const task = this.runtime.dequeueNextRunnable(this.config.maxConcurrentTasks);
      if (!task) {
        return;
      }
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
    const sessionId = extractRunnerSessionId(event);
    if (sessionId && task.sessionId !== sessionId) {
      task.sessionId = sessionId;
      this.persistRuntime();
    }

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
    this.runtime.finish(task.id);
    await this.refreshQueuedTaskCards();
    this.pumpQueue();
  }

  async runTask(task) {
    markTaskRunning(task);

    const conversation = this.store.getConversation(task.chatKey);
    const sessionId =
      task.sessionId ||
      (conversation?.workspaceDir === task.workspaceDir ? conversation?.sessionId || null : null);
    const runner = this.runCodexTask(this.config, {
      onEvent: (event) => {
        this.handleRunnerEvent(task, event);
      },
      prompt: this.buildPromptWithMemory(task.prompt, conversation, task.workspaceDir),
      sessionId,
      workspaceDir: task.workspaceDir
    });

    task.runner = runner;
    this.runtime.start(task);
    task.recovered = false;
    await this.syncTaskCard(task);

    let autoCommitResult = null;
    try {
      const result = await runner.result;
      await task.streamChain;
      this.ensureTaskNotAborted(task);
      const interactionRequest = parseInteractionRequest(result.finalMessage);
      if (interactionRequest?.error) {
        throw new Error(interactionRequest.error);
      }

      const normalizedResult = {
        ...result,
        finalMessage:
          interactionRequest?.cleanedText ||
          (interactionRequest ? `需要用户选择：${interactionRequest.question}` : result.finalMessage)
      };
      markTaskCompleted(task, normalizedResult);

      if (interactionRequest) {
        const interaction = await this.registerPendingInteraction(
          task,
          normalizedResult,
          interactionRequest
        );
        task.finalMessage = `需要用户选择：${interaction.question}`;
        await this.safeSend(
          task.target,
          this.buildInteractionText(interaction, buildTaskName(task))
        );
        return;
      }

      this.store.upsertConversation(task.chatKey, {
        lastContextUsageRatio: task.contextUsageRatio,
        lastModelContextWindow: task.modelContextWindow || 0,
        memoryFilePath: conversation?.memoryFilePath || "",
        lastSenderOpenId: task.senderOpenId,
        lastTaskId: task.id,
        pendingInteraction: null,
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
      markTaskFailed(task, error);
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
