function summarizeTaskPrompt(prompt, maxChars = 18) {
  const normalized = String(prompt || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[[^\]]+\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "task";
  }

  let summary = normalized
    .replace(/^(请|帮我|麻烦你|需要你)\s*/, "")
    .replace(/^(看下|看看)\s*/, "")
    .replace(/(，|。|；|！|？).*$/, "")
    .replace(/\s+/g, "");

  if (!summary) {
    summary = "task";
  }
  if (summary.length > maxChars) {
    summary = summary.slice(0, maxChars).replace(/[，。；！？,.!?\s_-]+$/g, "");
  }
  return summary || "task";
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

function buildRunningTaskKey(taskOrId, chatKey = "") {
  if (typeof taskOrId === "string") {
    return `${String(chatKey || "").trim()}::${taskOrId}`;
  }

  return `${String(taskOrId?.chatKey || "").trim()}::${String(taskOrId?.id || "").trim()}`;
}

export class TaskRuntime {
  constructor(store) {
    this.store = store;
    this.running = new Map();

    const runtime = this.store.getRuntimeSnapshot();
    this.nextTaskNumbers = { ...(runtime.nextTaskNumbers || {}) };
    this.queue = (runtime.queue || []).map((task) => restoreTask(task));
    this.interruptedTasks = (runtime.interrupted || []).map((task) => restoreTask(task));
    this.persist();
  }

  createTaskId(chatKey) {
    const normalizedChatKey = String(chatKey || "").trim();
    const nextNumber = Math.max(1, Number(this.nextTaskNumbers[normalizedChatKey]) || 1);
    const id = `T${String(nextNumber).padStart(3, "0")}`;
    this.nextTaskNumbers[normalizedChatKey] = nextNumber + 1;
    return id;
  }

  persist() {
    this.store.saveRuntimeSnapshot({
      interrupted: this.interruptedTasks.map((task) => sanitizeTaskSnapshot(task)),
      nextTaskNumbers: this.nextTaskNumbers,
      queue: this.queue.map((task) => sanitizeTaskSnapshot(task)),
      running: [...this.running.values()].map((task) => sanitizeTaskSnapshot(task))
    });
  }

  enqueue(task) {
    this.queue.push(task);
    this.persist();
    return task;
  }

  start(task) {
    this.running.set(buildRunningTaskKey(task), task);
    this.persist();
  }

  finish(taskOrId, chatKey = "") {
    this.running.delete(buildRunningTaskKey(taskOrId, chatKey));
    this.persist();
  }

  countRunningTasksForChat(chatKey) {
    return [...this.running.values()].filter((task) => task.chatKey === chatKey).length;
  }

  countPendingTasksForChat(chatKey) {
    const queuedCount = this.queue.filter((task) => task.chatKey === chatKey).length;
    return queuedCount + this.countRunningTasksForChat(chatKey);
  }

  countPendingTasksForUser(senderOpenId, chatKey = "") {
    if (!senderOpenId) {
      return 0;
    }

    const queuedCount = this.queue.filter(
      (task) => task.senderOpenId === senderOpenId && (!chatKey || task.chatKey === chatKey)
    ).length;
    const runningCount = [...this.running.values()].filter(
      (task) => task.senderOpenId === senderOpenId && (!chatKey || task.chatKey === chatKey)
    ).length;
    return queuedCount + runningCount;
  }

  findQueuePositionForTask(task) {
    let position = 0;
    for (const queuedTask of this.queue) {
      if (queuedTask.chatKey !== task.chatKey) {
        continue;
      }
      position += 1;
      if (queuedTask.id === task.id) {
        return position;
      }
    }
    return 0;
  }

  hasRunningTaskForChat(chatKey) {
    return [...this.running.values()].some((task) => task.chatKey === chatKey);
  }

  findInterruptedTask(chatKey, predicate) {
    for (let index = this.interruptedTasks.length - 1; index >= 0; index -= 1) {
      const task = this.interruptedTasks[index];
      if (task.chatKey !== chatKey) {
        continue;
      }
      if (!predicate || predicate(task)) {
        return { index, task };
      }
    }
    return { index: -1, task: null };
  }

  takeInterruptedTask(index) {
    if (index < 0 || index >= this.interruptedTasks.length) {
      return null;
    }
    const [task] = this.interruptedTasks.splice(index, 1);
    this.persist();
    return task || null;
  }

  dequeueQueuedTask(predicate) {
    const index = this.queue.findIndex(predicate);
    if (index < 0) {
      return null;
    }
    const [task] = this.queue.splice(index, 1);
    this.persist();
    return task || null;
  }

  dequeueNextRunnable(maxConcurrentTasks) {
    const nextTaskIndex = this.queue.findIndex(
      (task) => this.countRunningTasksForChat(task.chatKey) < maxConcurrentTasks
    );
    if (nextTaskIndex < 0) {
      return null;
    }
    const [task] = this.queue.splice(nextTaskIndex, 1);
    this.persist();
    return task || null;
  }
}

export { restoreTask, sanitizeTaskSnapshot };
