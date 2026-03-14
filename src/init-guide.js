import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

const MANAGED_ENV_SECTIONS = [
  {
    title: "# Feishu",
    entries: [
      ["FEISHU_APP_ID", ""],
      ["FEISHU_APP_SECRET", ""],
      ["FEISHU_BOT_OPEN_ID", ""],
      ["FEISHU_ALLOWED_OPEN_IDS", ""],
      ["FEISHU_REPLY_TO_MESSAGE_ENABLED", "true"],
      ["FEISHU_INTERACTIVE_CARDS_ENABLED", "true"]
    ]
  },
  {
    title: "# Server",
    entries: [
      ["HOST", "127.0.0.1"],
      ["PORT", "3000"],
      ["ENABLE_HEALTH_SERVER", "true"]
    ]
  },
  {
    title: "# Codex",
    entries: [
      ["CODEX_WORKSPACE_DIR", ""],
      ["CODEX_BIN", "codex"],
      ["CODEX_COMMAND", ""],
      ["CODEX_SANDBOX", "workspace-write"],
      ["CODEX_APPROVAL_POLICY", "never"],
      ["CODEX_SKIP_GIT_REPO_CHECK", "true"]
    ]
  },
  {
    title: "# Bridge",
    entries: [
      ["MAX_CONCURRENT_TASKS", "1"],
      ["MAX_QUEUED_TASKS_PER_CHAT", "5"],
      ["MAX_QUEUED_TASKS_PER_USER", "10"],
      ["FEISHU_STREAM_OUTPUT_ENABLED", "true"],
      ["FEISHU_STREAM_COMMAND_STATUS_ENABLED", "true"],
      ["FEISHU_STREAM_UPDATE_MIN_INTERVAL_MS", "1200"],
      ["CONTEXT_COMPACT_ENABLED", "true"],
      ["CONTEXT_COMPACT_THRESHOLD", "0.8"],
      ["CONTEXT_MEMORY_LOAD_FRACTION", "0.1"],
      ["CONTEXT_WINDOW_FALLBACK_TOKENS", "128000"]
    ]
  }
];

const MANAGED_KEYS = new Set(
  MANAGED_ENV_SECTIONS.flatMap((section) => section.entries.map(([key]) => key))
);

function escapeEnvValue(value) {
  const normalized = String(value ?? "");
  if (!normalized) {
    return "";
  }
  if (/^[A-Za-z0-9_./:@+-]+$/.test(normalized)) {
    return normalized;
  }
  return JSON.stringify(normalized);
}

export function parseEnvText(text) {
  const env = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const index = line.indexOf("=");
    if (index <= 0) {
      continue;
    }

    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function buildEnvFileText(existingText, values) {
  const existingLines = String(existingText || "").split(/\r?\n/);
  const usedKeys = new Set();
  const outputLines = existingLines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return line;
    }

    const index = line.indexOf("=");
    if (index <= 0) {
      return line;
    }

    const key = line.slice(0, index).trim();
    if (!MANAGED_KEYS.has(key) || !(key in values)) {
      return line;
    }

    usedKeys.add(key);
    return `${key}=${escapeEnvValue(values[key])}`;
  });

  const hasContent = outputLines.some((line) => line.trim());
  const sectionLines = [];
  for (const section of MANAGED_ENV_SECTIONS) {
    const pendingEntries = section.entries.filter(([key]) => !usedKeys.has(key));
    if (pendingEntries.length === 0) {
      continue;
    }

    if (hasContent || sectionLines.length > 0) {
      sectionLines.push("");
    }
    sectionLines.push(section.title);
    for (const [key] of pendingEntries) {
      sectionLines.push(`${key}=${escapeEnvValue(values[key] || "")}`);
    }
  }

  const merged = [...outputLines, ...sectionLines].join("\n").replace(/\n{3,}/g, "\n\n");
  return `${merged.trimEnd()}\n`;
}

export function buildSetupChecklist({ envFilePath }) {
  return [
    "",
    "下一步：",
    `1. 检查并补全 ${envFilePath} 里的配置值。`,
    "2. 在飞书开放平台创建企业自建应用，并开启机器人能力。",
    "3. 订阅事件 `im.message.receive_v1` 和卡片按钮回调事件。",
    "4. 在飞书后台把订阅方式切到“使用长连接接收事件/回调”。",
    "5. 把应用安装到企业，并确保机器人可以被私聊或被群聊 @。",
    "6. 运行 `npm start` 启动桥接服务。",
    "7. 用 `curl http://127.0.0.1:3000/healthz` 验证健康检查。"
  ].join("\n");
}

export function buildMissingConfigGuide({ command = "npm run setup", missingKey }) {
  return [
    `缺少必要配置：${missingKey}`,
    `先运行 \`${command}\` 生成或补全 .env，再重新启动服务。`,
    "如果你已经有 .env，请确认 FEISHU_APP_ID 和 FEISHU_APP_SECRET 已正确填写。"
  ].join("\n");
}

async function promptValue(rl, output, { defaultValue = "", label, optional = false }) {
  const suffix = defaultValue ? ` [${defaultValue}]` : optional ? " [可留空]" : "";
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  if (answer) {
    return answer;
  }
  return defaultValue;
}

export async function runSetupWizard({
  rootDir = process.cwd(),
  input = process.stdin,
  output = process.stdout
} = {}) {
  const envFilePath = path.join(rootDir, ".env");
  const existingText = fs.existsSync(envFilePath)
    ? fs.readFileSync(envFilePath, "utf8")
    : "";
  const existingEnv = parseEnvText(existingText);
  const rl = readline.createInterface({ input, output });

  try {
    output.write("Codex Feishu Bridge 初始化向导\n\n");

    const values = {
      FEISHU_APP_ID: await promptValue(rl, output, {
        defaultValue: existingEnv.FEISHU_APP_ID || "",
        label: "Feishu App ID"
      }),
      FEISHU_APP_SECRET: await promptValue(rl, output, {
        defaultValue: existingEnv.FEISHU_APP_SECRET || "",
        label: "Feishu App Secret"
      }),
      FEISHU_BOT_OPEN_ID: await promptValue(rl, output, {
        defaultValue: existingEnv.FEISHU_BOT_OPEN_ID || "",
        label: "Feishu Bot Open ID",
        optional: true
      }),
      FEISHU_ALLOWED_OPEN_IDS: await promptValue(rl, output, {
        defaultValue: existingEnv.FEISHU_ALLOWED_OPEN_IDS || "",
        label: "Allowed Open IDs（逗号分隔）",
        optional: true
      }),
      HOST: existingEnv.HOST || "127.0.0.1",
      PORT: existingEnv.PORT || "3000",
      ENABLE_HEALTH_SERVER: existingEnv.ENABLE_HEALTH_SERVER || "true",
      CODEX_WORKSPACE_DIR: await promptValue(rl, output, {
        defaultValue: existingEnv.CODEX_WORKSPACE_DIR || rootDir,
        label: "Codex 工作目录"
      }),
      CODEX_BIN: await promptValue(rl, output, {
        defaultValue: existingEnv.CODEX_BIN || "codex",
        label: "Codex 可执行文件"
      }),
      CODEX_COMMAND: await promptValue(rl, output, {
        defaultValue: existingEnv.CODEX_COMMAND || "",
        label: "Codex 启动命令覆盖（可留空）",
        optional: true
      }),
      CODEX_SANDBOX: existingEnv.CODEX_SANDBOX || "workspace-write",
      CODEX_APPROVAL_POLICY: existingEnv.CODEX_APPROVAL_POLICY || "never",
      CODEX_SKIP_GIT_REPO_CHECK: existingEnv.CODEX_SKIP_GIT_REPO_CHECK || "true",
      FEISHU_REPLY_TO_MESSAGE_ENABLED:
        existingEnv.FEISHU_REPLY_TO_MESSAGE_ENABLED || "true",
      FEISHU_INTERACTIVE_CARDS_ENABLED:
        existingEnv.FEISHU_INTERACTIVE_CARDS_ENABLED || "true",
      MAX_CONCURRENT_TASKS: existingEnv.MAX_CONCURRENT_TASKS || "1",
      MAX_QUEUED_TASKS_PER_CHAT: existingEnv.MAX_QUEUED_TASKS_PER_CHAT || "5",
      MAX_QUEUED_TASKS_PER_USER: existingEnv.MAX_QUEUED_TASKS_PER_USER || "10",
      FEISHU_STREAM_OUTPUT_ENABLED: existingEnv.FEISHU_STREAM_OUTPUT_ENABLED || "true",
      FEISHU_STREAM_COMMAND_STATUS_ENABLED:
        existingEnv.FEISHU_STREAM_COMMAND_STATUS_ENABLED || "true",
      FEISHU_STREAM_UPDATE_MIN_INTERVAL_MS:
        existingEnv.FEISHU_STREAM_UPDATE_MIN_INTERVAL_MS || "1200",
      CONTEXT_COMPACT_ENABLED: existingEnv.CONTEXT_COMPACT_ENABLED || "true",
      CONTEXT_COMPACT_THRESHOLD: existingEnv.CONTEXT_COMPACT_THRESHOLD || "0.8",
      CONTEXT_MEMORY_LOAD_FRACTION:
        existingEnv.CONTEXT_MEMORY_LOAD_FRACTION || "0.1",
      CONTEXT_WINDOW_FALLBACK_TOKENS:
        existingEnv.CONTEXT_WINDOW_FALLBACK_TOKENS || "128000"
    };

    const finalText = buildEnvFileText(existingText, values);
    fs.writeFileSync(envFilePath, finalText, "utf8");

    output.write(`\n已写入 ${envFilePath}\n`);
    output.write(buildSetupChecklist({ envFilePath }));
    output.write("\n");
  } finally {
    rl.close();
  }
}
