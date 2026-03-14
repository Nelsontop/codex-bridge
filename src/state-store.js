import fs from "node:fs";
import path from "node:path";

const MAX_INTERRUPTED_TASKS = 50;

const EMPTY_STATE = {
  version: 2,
  conversations: {},
  runtime: {
    interrupted: [],
    nextTaskNumber: 1,
    queue: [],
    running: []
  }
};

function normalizeTaskList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((task) => task && typeof task === "object")
    .map((task) => ({
      ...task
    }));
}

function normalizeRuntime(runtime, recoveredAt) {
  const nextTaskNumber = Math.max(1, Number(runtime?.nextTaskNumber) || 1);
  const queue = normalizeTaskList(runtime?.queue);
  const running = normalizeTaskList(runtime?.running);
  const interrupted = [
    ...normalizeTaskList(runtime?.interrupted),
    ...running.map((task) => ({
      ...task,
      interruptedAt: recoveredAt,
      lastErrorMessage:
        task.lastErrorMessage || "服务重启时任务被中断，未自动继续执行。",
      status: "interrupted"
    }))
  ].slice(-MAX_INTERRUPTED_TASKS);

  return {
    interrupted,
    nextTaskNumber,
    queue,
    running: []
  };
}

export class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = structuredClone(EMPTY_STATE);
    this.load();
  }

  load() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      this.save();
      return;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      const recoveredAt = new Date().toISOString();
      this.state = {
        version: 2,
        conversations: parsed.conversations || {},
        runtime: normalizeRuntime(parsed.runtime, recoveredAt)
      };
      if (parsed.version !== 2 || normalizeTaskList(parsed.runtime?.running).length > 0) {
        this.save();
      }
    } catch (error) {
      console.warn("[state] failed to load state file, recreating:", error.message);
      this.state = structuredClone(EMPTY_STATE);
      this.save();
    }
  }

  save() {
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, this.filePath);
  }

  getConversation(chatKey) {
    return this.state.conversations[chatKey] || null;
  }

  upsertConversation(chatKey, patch) {
    const current = this.getConversation(chatKey) || {};
    this.state.conversations[chatKey] = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    this.save();
    return this.state.conversations[chatKey];
  }

  clearConversation(chatKey) {
    delete this.state.conversations[chatKey];
    this.save();
  }

  conversationCount() {
    return Object.keys(this.state.conversations).length;
  }

  getRuntimeSnapshot() {
    return structuredClone(this.state.runtime);
  }

  saveRuntimeSnapshot(runtime) {
    this.state.runtime = normalizeRuntime(runtime, new Date().toISOString());
    this.save();
    return this.getRuntimeSnapshot();
  }
}
