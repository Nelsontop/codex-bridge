import fs from "node:fs";
import path from "node:path";

export const SETTINGS_ENV_FIELDS = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_BOT_OPEN_ID",
  "FEISHU_ALLOWED_OPEN_IDS",
  "HOST",
  "PORT",
  "STATE_DIR",
  "CODEX_WORKSPACE_DIR",
  "WORKSPACE_ALLOWED_ROOTS",
  "CHAT_WORKSPACE_MAPPINGS",
  "GITHUB_REPO_OWNER",
  "CLI_PROVIDER",
  "CHANNEL_PROVIDER",
  "CODEX_ADDITIONAL_ARGS",
  "CODEX_COMMAND",
  "CODEX_MODEL",
  "CODEX_PROFILE",
  "CODEX_PRELUDE",
  "CODEX_SANDBOX",
  "CODEX_APPROVAL_POLICY",
  "CODEX_SKIP_GIT_REPO_CHECK",
  "ENABLE_HEALTH_SERVER",
  "DUPLICATE_TASK_WINDOW_MS",
  "MAX_CONCURRENT_TASKS",
  "MAX_QUEUED_TASKS_PER_CHAT",
  "MAX_QUEUED_TASKS_PER_USER",
  "MAX_REPLY_CHARS",
  "TASK_ACK_ENABLED",
  "CONTEXT_COMPACT_ENABLED",
  "CONTEXT_COMPACT_THRESHOLD",
  "CONTEXT_MEMORY_LOAD_FRACTION",
  "CONTEXT_WINDOW_FALLBACK_TOKENS",
  "FEISHU_BASE_URL",
  "FEISHU_REQUEST_TIMEOUT_MS",
  "FEISHU_REQUEST_RETRIES",
  "FEISHU_REQUEST_RETRY_DELAY_MS",
  "FEISHU_REQUIRE_MENTION_IN_GROUP",
  "FEISHU_REPLY_TO_MESSAGE_ENABLED",
  "FEISHU_INTERACTIVE_CARDS_ENABLED",
  "FEISHU_STREAM_OUTPUT_ENABLED",
  "FEISHU_STREAM_COMMAND_STATUS_ENABLED",
  "FEISHU_STREAM_MODE",
  "FEISHU_STREAM_UPDATE_MIN_INTERVAL_MS",
  "AUTO_COMMIT_AFTER_TASK_ENABLED",
  "AUTO_COMMIT_MESSAGE_PREFIX",
  "CLAUDE_CODE_COMMAND",
  "CLAUDE_CODE_ADDITIONAL_ARGS",
  "OPENCODE_COMMAND",
  "OPENCODE_ADDITIONAL_ARGS",
  "KIMI_CLI_COMMAND",
  "KIMI_CLI_ADDITIONAL_ARGS"
];

export const SETTINGS_ENV_FIELD_SET = new Set(SETTINGS_ENV_FIELDS);

function parseEnvLine(line) {
  const index = line.indexOf("=");
  if (index <= 0) {
    return null;
  }
  const key = line.slice(0, index).trim();
  if (!key) {
    return null;
  }
  let value = line.slice(index + 1).trim();
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

function escapeEnvValue(value) {
  const normalized = String(value ?? "");
  if (!normalized) {
    return "";
  }
  if (/^[A-Za-z0-9_./:@+,\-\\ ]+$/.test(normalized)) {
    return normalized;
  }
  return JSON.stringify(normalized);
}

function parseEnvText(text) {
  const env = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const entry = parseEnvLine(rawLine);
    if (!entry) {
      continue;
    }
    env[entry.key] = entry.value;
  }
  return env;
}

export function parseAdvancedEnvText(text) {
  const values = {};
  const errors = [];
  const lines = String(text || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const entry = parseEnvLine(rawLine);
    if (!entry) {
      errors.push(`Line ${index + 1}: invalid format, expected KEY=VALUE`);
      continue;
    }
    if (SETTINGS_ENV_FIELD_SET.has(entry.key)) {
      errors.push(`Line ${index + 1}: ${entry.key} must be edited in Visual Settings`);
      continue;
    }
    values[entry.key] = entry.value;
  }
  return {
    values,
    errors
  };
}

export function buildUpdatedEnvText(existingText, { settingsValues = {}, advancedValues = {} }) {
  const existingMap = parseEnvText(existingText);
  const existingAdvancedKeys = new Set(
    Object.keys(existingMap).filter((key) => !SETTINGS_ENV_FIELD_SET.has(key))
  );
  const lines = String(existingText || "").split(/\r?\n/);
  const output = [];
  const processedKeys = new Set();

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      output.push(rawLine);
      continue;
    }

    const entry = parseEnvLine(rawLine);
    if (!entry) {
      output.push(rawLine);
      continue;
    }

    const { key } = entry;
    if (SETTINGS_ENV_FIELD_SET.has(key)) {
      const nextValue = key in settingsValues ? settingsValues[key] : "";
      output.push(`${key}=${escapeEnvValue(nextValue)}`);
      processedKeys.add(key);
      continue;
    }

    if (key in advancedValues) {
      output.push(`${key}=${escapeEnvValue(advancedValues[key])}`);
      processedKeys.add(key);
      continue;
    }

    if (existingAdvancedKeys.has(key)) {
      continue;
    }

    output.push(rawLine);
  }

  const missingSettingsKeys = SETTINGS_ENV_FIELDS.filter((key) => !processedKeys.has(key));
  const missingAdvancedKeys = Object.keys(advancedValues).filter((key) => !processedKeys.has(key));
  if (output.length > 0 && output[output.length - 1].trim() !== "") {
    output.push("");
  }

  if (missingSettingsKeys.length > 0) {
    output.push("# Visual Settings");
    for (const key of missingSettingsKeys) {
      output.push(`${key}=${escapeEnvValue(settingsValues[key] || "")}`);
    }
    output.push("");
  }

  if (missingAdvancedKeys.length > 0) {
    output.push("# Advanced Settings");
    for (const key of missingAdvancedKeys.sort()) {
      output.push(`${key}=${escapeEnvValue(advancedValues[key])}`);
    }
    output.push("");
  }

  return `${output.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

export function loadEnvConfig(rootDir) {
  const envPath = path.join(rootDir, ".env");
  const exists = fs.existsSync(envPath);
  const rawText = exists ? fs.readFileSync(envPath, "utf8") : "";
  const parsed = parseEnvText(rawText);

  const settingsValues = {};
  for (const key of SETTINGS_ENV_FIELDS) {
    settingsValues[key] = parsed[key] || "";
  }

  const advancedLines = Object.keys(parsed)
    .filter((key) => !SETTINGS_ENV_FIELD_SET.has(key))
    .sort()
    .map((key) => `${key}=${parsed[key]}`);

  return {
    envPath,
    settingsValues,
    coreValues: settingsValues,
    advancedText: advancedLines.join("\n"),
    exists
  };
}

export function saveEnvConfig(rootDir, payload = {}) {
  const {
    settingsValues = payload.coreValues || {},
    advancedText = ""
  } = payload;
  const envPath = path.join(rootDir, ".env");
  const existingText = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const parsedAdvanced = parseAdvancedEnvText(advancedText);
  if (parsedAdvanced.errors.length > 0) {
    const error = new Error(parsedAdvanced.errors.join("\n"));
    error.code = "INVALID_ADVANCED_ENV";
    throw error;
  }

  const nextText = buildUpdatedEnvText(existingText, {
    settingsValues,
    advancedValues: parsedAdvanced.values
  });
  fs.writeFileSync(envPath, nextText, "utf8");
  return loadEnvConfig(rootDir);
}
