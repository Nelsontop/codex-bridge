import fs from "node:fs";
import path from "node:path";

export const CORE_ENV_FIELDS = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_BOT_OPEN_ID",
  "FEISHU_ALLOWED_OPEN_IDS",
  "HOST",
  "PORT",
  "STATE_DIR",
  "CODEX_WORKSPACE_DIR",
  "WORKSPACE_ALLOWED_ROOTS",
  "CLI_PROVIDER",
  "CHANNEL_PROVIDER",
  "CODEX_COMMAND",
  "CODEX_MODEL",
  "CODEX_PROFILE",
  "CODEX_SANDBOX",
  "CODEX_APPROVAL_POLICY"
];

export const CORE_ENV_FIELD_SET = new Set(CORE_ENV_FIELDS);

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
    if (CORE_ENV_FIELD_SET.has(entry.key)) {
      errors.push(`Line ${index + 1}: ${entry.key} must be edited in Core Settings`);
      continue;
    }
    values[entry.key] = entry.value;
  }
  return {
    values,
    errors
  };
}

export function buildUpdatedEnvText(existingText, { coreValues = {}, advancedValues = {} }) {
  const existingMap = parseEnvText(existingText);
  const existingAdvancedKeys = new Set(
    Object.keys(existingMap).filter((key) => !CORE_ENV_FIELD_SET.has(key))
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
    if (CORE_ENV_FIELD_SET.has(key)) {
      const nextValue = key in coreValues ? coreValues[key] : "";
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

  const missingCoreKeys = CORE_ENV_FIELDS.filter((key) => !processedKeys.has(key));
  const missingAdvancedKeys = Object.keys(advancedValues).filter((key) => !processedKeys.has(key));
  if (output.length > 0 && output[output.length - 1].trim() !== "") {
    output.push("");
  }

  if (missingCoreKeys.length > 0) {
    output.push("# Core Settings");
    for (const key of missingCoreKeys) {
      output.push(`${key}=${escapeEnvValue(coreValues[key] || "")}`);
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

  const coreValues = {};
  for (const key of CORE_ENV_FIELDS) {
    coreValues[key] = parsed[key] || "";
  }

  const advancedLines = Object.keys(parsed)
    .filter((key) => !CORE_ENV_FIELD_SET.has(key))
    .sort()
    .map((key) => `${key}=${parsed[key]}`);

  return {
    envPath,
    coreValues,
    advancedText: advancedLines.join("\n"),
    exists
  };
}

export function saveEnvConfig(rootDir, { coreValues = {}, advancedText = "" }) {
  const envPath = path.join(rootDir, ".env");
  const existingText = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const parsedAdvanced = parseAdvancedEnvText(advancedText);
  if (parsedAdvanced.errors.length > 0) {
    const error = new Error(parsedAdvanced.errors.join("\n"));
    error.code = "INVALID_ADVANCED_ENV";
    throw error;
  }

  const nextText = buildUpdatedEnvText(existingText, {
    coreValues,
    advancedValues: parsedAdvanced.values
  });
  fs.writeFileSync(envPath, nextText, "utf8");
  return loadEnvConfig(rootDir);
}
