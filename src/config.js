import fs from "node:fs";
import path from "node:path";

const DEFAULT_PRELUDE = [
  "你正在通过飞书远程控制 Codex。",
  "目标是尽量直接完成用户请求，而不是停留在分析。",
  "除非操作会删除文件、目录、数据、资源，或具有不可逆清理效果，否则无需再征求用户确认。",
  "任何删除、销毁、清空、drop、rm、truncate、purge 类操作前，必须先向用户明确确认。",
  "完成后请简洁汇报结果、改动和验证情况。"
].join("\n");

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const index = line.indexOf("=");
    if (index <= 0) {
      continue;
    }

    const key = line.slice(0, index).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBoolean(value, fallback = false) {
  if (value === undefined || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function asList(value) {
  return String(value || "")
    .split(/[,\n;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function asArgs(value) {
  return String(value || "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitCommand(value) {
  const input = String(value || "").trim();
  if (!input) {
    return [];
  }

  const tokens = [];
  let current = "";
  let quote = "";
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }
  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function expandHome(token) {
  if (!token) {
    return token;
  }
  if (token === "~") {
    return process.env.HOME || token;
  }
  if (token.startsWith("~/")) {
    return path.join(process.env.HOME || "~", token.slice(2));
  }
  return token;
}

function parseWorkspaceMappings(value, rootDir) {
  const mappings = new Map();
  for (const entry of String(value || "").split(/[;\n]/)) {
    const item = entry.trim();
    if (!item) {
      continue;
    }

    const separatorIndex = item.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const rawKey = item.slice(0, separatorIndex).trim();
    const rawPath = item.slice(separatorIndex + 1).trim();
    if (!rawKey || !rawPath) {
      continue;
    }

    mappings.set(rawKey, path.resolve(rootDir, expandHome(rawPath)));
  }
  return mappings;
}

function resolveCodexCommand() {
  const configuredCommand = process.env.CODEX_COMMAND || "";
  const parsedCommand = splitCommand(configuredCommand);
  if (parsedCommand.length > 0) {
    parsedCommand[0] = expandHome(parsedCommand[0]);
    return parsedCommand;
  }

  return [expandHome(process.env.CODEX_BIN || "codex")];
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(rootDir = process.cwd()) {
  readEnvFile(path.join(rootDir, ".env"));

  const workspaceDir = path.resolve(
    rootDir,
    process.env.CODEX_WORKSPACE_DIR || rootDir
  );
  const workspaceAllowedRoots = asList(process.env.WORKSPACE_ALLOWED_ROOTS).map((item) =>
    path.resolve(rootDir, expandHome(item))
  );
  const stateDir = path.resolve(
    rootDir,
    process.env.STATE_DIR || ".codex-feishu-bridge"
  );
  const gitAutoCommitEnabled = asBoolean(
    process.env.AUTO_COMMIT_AFTER_TASK_ENABLED,
    false
  );
  const configuredMaxConcurrentTasks = Math.max(
    1,
    asNumber(process.env.MAX_CONCURRENT_TASKS, 1)
  );

  return {
    rootDir,
    host: process.env.HOST || "127.0.0.1",
    port: asNumber(process.env.PORT, 3000),
    enableHealthServer: asBoolean(process.env.ENABLE_HEALTH_SERVER, true),
    stateDir,
    stateFile: path.join(stateDir, "state.json"),
    contextMemoryDir: path.join(stateDir, "memory"),
    contextCompactEnabled: asBoolean(
      process.env.CONTEXT_COMPACT_ENABLED,
      true
    ),
    contextCompactThreshold: Math.min(
      0.95,
      Math.max(0.5, asNumber(process.env.CONTEXT_COMPACT_THRESHOLD, 0.8))
    ),
    contextMemoryLoadFraction: Math.min(
      0.2,
      Math.max(0.02, asNumber(process.env.CONTEXT_MEMORY_LOAD_FRACTION, 0.1))
    ),
    contextWindowFallbackTokens: Math.max(
      8192,
      asNumber(process.env.CONTEXT_WINDOW_FALLBACK_TOKENS, 128000)
    ),
    feishuBaseUrl: process.env.FEISHU_BASE_URL || "https://open.feishu.cn",
    feishuRequestTimeoutMs: Math.max(
      1000,
      asNumber(process.env.FEISHU_REQUEST_TIMEOUT_MS, 10000)
    ),
    feishuRequestRetries: Math.max(
      0,
      asNumber(process.env.FEISHU_REQUEST_RETRIES, 2)
    ),
    feishuRequestRetryDelayMs: Math.max(
      0,
      asNumber(process.env.FEISHU_REQUEST_RETRY_DELAY_MS, 300)
    ),
    feishuAppId: requireEnv("FEISHU_APP_ID"),
    feishuAppSecret: requireEnv("FEISHU_APP_SECRET"),
    feishuBotOpenId: process.env.FEISHU_BOT_OPEN_ID || "",
    feishuAllowedOpenIds: new Set(asList(process.env.FEISHU_ALLOWED_OPEN_IDS)),
    requireMentionInGroup: asBoolean(
      process.env.FEISHU_REQUIRE_MENTION_IN_GROUP,
      true
    ),
    feishuReplyToMessageEnabled: asBoolean(
      process.env.FEISHU_REPLY_TO_MESSAGE_ENABLED,
      true
    ),
    feishuInteractiveCardsEnabled: asBoolean(
      process.env.FEISHU_INTERACTIVE_CARDS_ENABLED,
      true
    ),
    githubRepoOwner: process.env.GITHUB_REPO_OWNER || "",
    codexBin: process.env.CODEX_BIN || "codex",
    codexCommand: resolveCodexCommand(),
    codexWorkspaceDir: workspaceDir,
    workspaceAllowedRoots:
      workspaceAllowedRoots.length > 0 ? workspaceAllowedRoots : [workspaceDir],
    chatWorkspaceMappings: parseWorkspaceMappings(
      process.env.CHAT_WORKSPACE_MAPPINGS,
      rootDir
    ),
    codexModel: process.env.CODEX_MODEL || "",
    codexProfile: process.env.CODEX_PROFILE || "",
    codexSandbox: process.env.CODEX_SANDBOX || "workspace-write",
    codexApprovalPolicy: process.env.CODEX_APPROVAL_POLICY || "never",
    codexAdditionalArgs: asArgs(process.env.CODEX_ADDITIONAL_ARGS),
    codexSkipGitRepoCheck: asBoolean(
      process.env.CODEX_SKIP_GIT_REPO_CHECK,
      true
    ),
    codexPrelude: process.env.CODEX_PRELUDE || DEFAULT_PRELUDE,
    maxConcurrentTasks: gitAutoCommitEnabled ? 1 : configuredMaxConcurrentTasks,
    maxReplyChars: Math.max(500, asNumber(process.env.MAX_REPLY_CHARS, 1800)),
    taskAckEnabled: asBoolean(process.env.TASK_ACK_ENABLED, true),
    feishuStreamOutputEnabled: asBoolean(
      process.env.FEISHU_STREAM_OUTPUT_ENABLED,
      false
    ),
    feishuStreamCommandStatusEnabled: asBoolean(
      process.env.FEISHU_STREAM_COMMAND_STATUS_ENABLED,
      true
    ),
    feishuStreamUpdateMinIntervalMs: Math.max(
      0,
      asNumber(process.env.FEISHU_STREAM_UPDATE_MIN_INTERVAL_MS, 1200)
    ),
    maxQueuedTasksPerChat: Math.max(
      1,
      asNumber(process.env.MAX_QUEUED_TASKS_PER_CHAT, 5)
    ),
    maxQueuedTasksPerUser: Math.max(
      1,
      asNumber(process.env.MAX_QUEUED_TASKS_PER_USER, 10)
    ),
    gitAutoCommitEnabled,
    gitAutoCommitMessagePrefix:
      process.env.AUTO_COMMIT_MESSAGE_PREFIX || "bridge: save"
  };
}
