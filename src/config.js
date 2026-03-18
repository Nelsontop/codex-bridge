import fs from "node:fs";
import path from "node:path";
import { SUPPORTED_CHANNEL_ADAPTERS } from "./providers/channel/index.js";
import { SUPPORTED_CLI_PROVIDERS } from "./providers/cli/index.js";

const DEFAULT_PRELUDE = [
  "你正在通过飞书远程控制 Codex。",
  "目标是尽量直接完成用户请求，而不是停留在分析。",
  "除非操作会删除文件、目录、数据、资源，或具有不可逆清理效果，否则无需再征求用户确认。",
  "任何删除、销毁、清空、drop、rm、truncate、purge 类操作前，必须先向用户明确确认。",
  "如果你需要用户在多个方案之间做选择，不要让用户回复自然语言，也不要自己猜测用户意图。",
  "此时请只输出一个 ```codex_bridge_interaction 代码块，内容为 JSON。",
  "JSON 结构：{\"question\":\"一句明确问题\",\"options\":[{\"id\":\"a\",\"label\":\"按钮名\",\"prompt\":\"用户点击后应继续执行的后续指令\",\"style\":\"primary|default|danger\"}]}。",
  "options 至少 2 个，至多 3 个；label 要短，prompt 必须自包含，能脱离上下文直接继续执行；代码块外不要附加任何其他文字。",
  "完成后请简洁汇报结果、改动和验证情况。"
].join("\n");

const DEFAULTS = {
  autoCommitAfterTaskEnabled: false,
  autoCommitMessagePrefix: "bridge: save",
  channelProvider: "feishu",
  claudeCodeCommand: "claude",
  cliProvider: "codex",
  codexApprovalPolicy: "never",
  codexCommand: "codex",
  codexSandbox: "workspace-write",
  codexSkipGitRepoCheck: true,
  contextCompactEnabled: true,
  contextCompactThreshold: 0.8,
  contextMemoryLoadFraction: 0.1,
  contextWindowFallbackTokens: 128000,
  enableHealthServer: true,
  duplicateTaskWindowMs: 15000,
  feishuInteractiveCardsEnabled: true,
  feishuReplyToMessageEnabled: true,
  feishuRequestRetries: 2,
  feishuRequestRetryDelayMs: 300,
  feishuRequestTimeoutMs: 10000,
  feishuStreamCommandStatusEnabled: true,
  feishuStreamMode: "hybrid",
  feishuStreamOutputEnabled: false,
  feishuStreamUpdateMinIntervalMs: 1200,
  host: "127.0.0.1",
  maxConcurrentTasks: 1,
  maxQueuedTasksPerChat: 5,
  maxQueuedTasksPerUser: 10,
  opencodeCommand: "opencode",
  kimiCliCommand: "kimi",
  maxReplyChars: 1800,
  port: 3000,
  requireMentionInGroup: true
};

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

  return [expandHome(DEFAULTS.codexCommand)];
}

function resolveCustomCommand(value, fallback) {
  const configuredCommand = value || "";
  const parsedCommand = splitCommand(configuredCommand);
  if (parsedCommand.length > 0) {
    parsedCommand[0] = expandHome(parsedCommand[0]);
    return parsedCommand;
  }
  return [expandHome(fallback)];
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
    process.env.STATE_DIR || ".agent-bridge"
  );
  const gitAutoCommitEnabled = asBoolean(
    process.env.AUTO_COMMIT_AFTER_TASK_ENABLED,
    DEFAULTS.autoCommitAfterTaskEnabled
  );
  const configuredMaxConcurrentTasks = Math.max(
    1,
    asNumber(process.env.MAX_CONCURRENT_TASKS, DEFAULTS.maxConcurrentTasks)
  );
  const channelProvider = (
    process.env.CHANNEL_PROVIDER ||
    DEFAULTS.channelProvider
  ).trim().toLowerCase();
  if (!SUPPORTED_CHANNEL_ADAPTERS.includes(channelProvider)) {
    throw new Error(
      `Unsupported CHANNEL_PROVIDER: ${channelProvider}. Supported values: ${SUPPORTED_CHANNEL_ADAPTERS.join(", ")}`
    );
  }
  const cliProvider = (process.env.CLI_PROVIDER || DEFAULTS.cliProvider).trim().toLowerCase();
  if (!SUPPORTED_CLI_PROVIDERS.includes(cliProvider)) {
    throw new Error(
      `Unsupported CLI_PROVIDER: ${cliProvider}. Supported values: ${SUPPORTED_CLI_PROVIDERS.join(", ")}`
    );
  }
  const feishuStreamMode = (
    process.env.FEISHU_STREAM_MODE ||
    DEFAULTS.feishuStreamMode
  ).trim().toLowerCase();
  if (!["card", "text", "hybrid"].includes(feishuStreamMode)) {
    throw new Error(
      `Unsupported FEISHU_STREAM_MODE: ${feishuStreamMode}. Supported values: card, text, hybrid`
    );
  }

  return {
    rootDir,
    host: process.env.HOST || DEFAULTS.host,
    port: asNumber(process.env.PORT, DEFAULTS.port),
    enableHealthServer: asBoolean(
      process.env.ENABLE_HEALTH_SERVER,
      DEFAULTS.enableHealthServer
    ),
    duplicateTaskWindowMs: Math.max(
      0,
      asNumber(process.env.DUPLICATE_TASK_WINDOW_MS, DEFAULTS.duplicateTaskWindowMs)
    ),
    stateDir,
    stateFile: path.join(stateDir, "state.json"),
    contextMemoryDir: path.join(stateDir, "memory"),
    contextCompactEnabled: asBoolean(
      process.env.CONTEXT_COMPACT_ENABLED,
      DEFAULTS.contextCompactEnabled
    ),
    contextCompactThreshold: Math.min(
      0.95,
      Math.max(
        0.5,
        asNumber(process.env.CONTEXT_COMPACT_THRESHOLD, DEFAULTS.contextCompactThreshold)
      )
    ),
    contextMemoryLoadFraction: Math.min(
      0.2,
      Math.max(
        0.02,
        asNumber(
          process.env.CONTEXT_MEMORY_LOAD_FRACTION,
          DEFAULTS.contextMemoryLoadFraction
        )
      )
    ),
    contextWindowFallbackTokens: Math.max(
      8192,
      asNumber(
        process.env.CONTEXT_WINDOW_FALLBACK_TOKENS,
        DEFAULTS.contextWindowFallbackTokens
      )
    ),
    feishuBaseUrl: process.env.FEISHU_BASE_URL || "https://open.feishu.cn",
    feishuRequestTimeoutMs: Math.max(
      1000,
      asNumber(process.env.FEISHU_REQUEST_TIMEOUT_MS, DEFAULTS.feishuRequestTimeoutMs)
    ),
    feishuRequestRetries: Math.max(
      0,
      asNumber(process.env.FEISHU_REQUEST_RETRIES, DEFAULTS.feishuRequestRetries)
    ),
    feishuRequestRetryDelayMs: Math.max(
      0,
      asNumber(
        process.env.FEISHU_REQUEST_RETRY_DELAY_MS,
        DEFAULTS.feishuRequestRetryDelayMs
      )
    ),
    feishuAppId: requireEnv("FEISHU_APP_ID"),
    feishuAppSecret: requireEnv("FEISHU_APP_SECRET"),
    feishuBotOpenId: process.env.FEISHU_BOT_OPEN_ID || "",
    feishuAllowedOpenIds: new Set(asList(process.env.FEISHU_ALLOWED_OPEN_IDS)),
    requireMentionInGroup: asBoolean(
      process.env.FEISHU_REQUIRE_MENTION_IN_GROUP,
      DEFAULTS.requireMentionInGroup
    ),
    feishuReplyToMessageEnabled: asBoolean(
      process.env.FEISHU_REPLY_TO_MESSAGE_ENABLED,
      DEFAULTS.feishuReplyToMessageEnabled
    ),
    feishuInteractiveCardsEnabled: asBoolean(
      process.env.FEISHU_INTERACTIVE_CARDS_ENABLED,
      DEFAULTS.feishuInteractiveCardsEnabled
    ),
    githubRepoOwner: process.env.GITHUB_REPO_OWNER || "",
    channelProvider,
    cliProvider,
    claudeCodeCommand: [
      ...resolveCustomCommand(process.env.CLAUDE_CODE_COMMAND, DEFAULTS.claudeCodeCommand),
      ...asArgs(process.env.CLAUDE_CODE_ADDITIONAL_ARGS)
    ],
    opencodeCommand: [
      ...resolveCustomCommand(process.env.OPENCODE_COMMAND, DEFAULTS.opencodeCommand),
      ...asArgs(process.env.OPENCODE_ADDITIONAL_ARGS)
    ],
    kimiCliCommand: [
      ...resolveCustomCommand(process.env.KIMI_CLI_COMMAND, DEFAULTS.kimiCliCommand),
      ...asArgs(process.env.KIMI_CLI_ADDITIONAL_ARGS)
    ],
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
    codexSandbox: process.env.CODEX_SANDBOX || DEFAULTS.codexSandbox,
    codexApprovalPolicy:
      process.env.CODEX_APPROVAL_POLICY || DEFAULTS.codexApprovalPolicy,
    codexAdditionalArgs: asArgs(process.env.CODEX_ADDITIONAL_ARGS),
    codexSkipGitRepoCheck: asBoolean(
      process.env.CODEX_SKIP_GIT_REPO_CHECK,
      DEFAULTS.codexSkipGitRepoCheck
    ),
    codexPrelude: process.env.CODEX_PRELUDE || DEFAULT_PRELUDE,
    maxConcurrentTasks: gitAutoCommitEnabled ? 1 : configuredMaxConcurrentTasks,
    maxReplyChars: Math.max(500, asNumber(process.env.MAX_REPLY_CHARS, DEFAULTS.maxReplyChars)),
    taskAckEnabled: asBoolean(process.env.TASK_ACK_ENABLED, true),
    feishuStreamOutputEnabled: asBoolean(
      process.env.FEISHU_STREAM_OUTPUT_ENABLED,
      DEFAULTS.feishuStreamOutputEnabled
    ),
    feishuStreamCommandStatusEnabled: asBoolean(
      process.env.FEISHU_STREAM_COMMAND_STATUS_ENABLED,
      DEFAULTS.feishuStreamCommandStatusEnabled
    ),
    feishuStreamMode,
    feishuStreamUpdateMinIntervalMs: Math.max(
      0,
      asNumber(
        process.env.FEISHU_STREAM_UPDATE_MIN_INTERVAL_MS,
        DEFAULTS.feishuStreamUpdateMinIntervalMs
      )
    ),
    maxQueuedTasksPerChat: Math.max(
      1,
      asNumber(process.env.MAX_QUEUED_TASKS_PER_CHAT, DEFAULTS.maxQueuedTasksPerChat)
    ),
    maxQueuedTasksPerUser: Math.max(
      1,
      asNumber(process.env.MAX_QUEUED_TASKS_PER_USER, DEFAULTS.maxQueuedTasksPerUser)
    ),
    gitAutoCommitEnabled,
    gitAutoCommitMessagePrefix:
      process.env.AUTO_COMMIT_MESSAGE_PREFIX || DEFAULTS.autoCommitMessagePrefix
  };
}
