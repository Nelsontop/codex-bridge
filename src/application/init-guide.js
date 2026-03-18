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
      ["FEISHU_ALLOWED_OPEN_IDS", ""]
    ]
  },
  {
    title: "# Server",
    entries: [["PORT", "3000"]]
  },
  {
    title: "# Codex",
    entries: [
      ["CODEX_WORKSPACE_DIR", ""],
      ["WORKSPACE_ALLOWED_ROOTS", ""],
      ["GITHUB_REPO_OWNER", ""],
      ["CODEX_COMMAND", ""],
      ["CODEX_MODEL", ""],
      ["CODEX_PROFILE", ""],
      ["CHAT_WORKSPACE_MAPPINGS", ""]
    ]
  },
  {
    title: "# Bridge",
    entries: [
      ["AUTO_COMMIT_AFTER_TASK_ENABLED", "false"],
      ["AUTO_COMMIT_MESSAGE_PREFIX", "bridge: save"]
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
    "3. 订阅事件 `im.message.receive_v1`、`im.chat.member.bot.added_v1` 和卡片按钮回调事件。",
    "4. 在飞书后台把订阅方式切到“使用长连接接收事件/回调”。",
    "5. 把应用安装到企业，并确保机器人可以被私聊或被群聊 @。",
    "6. 先执行 `gh auth login`，确保本机已登录 GitHub。",
    "7. 开发调试时运行 `npm start`，长期常驻建议运行 `npm run service:install`。",
    "8. 用 `curl http://127.0.0.1:3000/healthz` 验证健康检查。"
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
    output.write("Agent Bridge 初始化向导\n\n");

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
      PORT: existingEnv.PORT || "3000",
      CODEX_WORKSPACE_DIR: await promptValue(rl, output, {
        defaultValue: existingEnv.CODEX_WORKSPACE_DIR || rootDir,
        label: "Codex 工作目录"
      }),
      WORKSPACE_ALLOWED_ROOTS: await promptValue(rl, output, {
        defaultValue:
          existingEnv.WORKSPACE_ALLOWED_ROOTS ||
          existingEnv.CODEX_WORKSPACE_DIR ||
          rootDir,
        label: "允许绑定的工作目录根路径（逗号分隔）"
      }),
      GITHUB_REPO_OWNER: await promptValue(rl, output, {
        defaultValue: existingEnv.GITHUB_REPO_OWNER || "",
        label: "GitHub Owner（可留空，默认当前 gh 登录用户）",
        optional: true
      }),
      CODEX_COMMAND: await promptValue(rl, output, {
        defaultValue: existingEnv.CODEX_COMMAND || "",
        label: "Codex 启动命令覆盖（可留空）",
        optional: true
      }),
      CODEX_MODEL: await promptValue(rl, output, {
        defaultValue: existingEnv.CODEX_MODEL || "",
        label: "Codex 模型（可留空）",
        optional: true
      }),
      CODEX_PROFILE: await promptValue(rl, output, {
        defaultValue: existingEnv.CODEX_PROFILE || "",
        label: "Codex Profile（可留空）",
        optional: true
      }),
      CHAT_WORKSPACE_MAPPINGS: await promptValue(rl, output, {
        defaultValue: existingEnv.CHAT_WORKSPACE_MAPPINGS || "",
        label: "静态聊天目录映射（可留空）",
        optional: true
      }),
      AUTO_COMMIT_AFTER_TASK_ENABLED:
        existingEnv.AUTO_COMMIT_AFTER_TASK_ENABLED || "false",
      AUTO_COMMIT_MESSAGE_PREFIX:
        existingEnv.AUTO_COMMIT_MESSAGE_PREFIX || "bridge: save"
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
