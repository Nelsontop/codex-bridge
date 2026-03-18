const FIELD_SECTIONS = [
  {
    title: "Feishu",
    advanced: false,
    fields: [
      { key: "FEISHU_APP_ID", label: "Feishu App ID", required: true },
      { key: "FEISHU_APP_SECRET", label: "Feishu App Secret", required: true, secret: true },
      { key: "FEISHU_BOT_OPEN_ID", label: "Feishu Bot Open ID" },
      { key: "FEISHU_ALLOWED_OPEN_IDS", label: "Allowed Open IDs (comma separated)" },
      { key: "FEISHU_BASE_URL", label: "Feishu Base URL" },
      { key: "FEISHU_REQUEST_TIMEOUT_MS", label: "Request Timeout (ms)", type: "number" },
      { key: "FEISHU_REQUEST_RETRIES", label: "Request Retries", type: "number" },
      { key: "FEISHU_REQUEST_RETRY_DELAY_MS", label: "Retry Delay (ms)", type: "number" },
      { key: "FEISHU_REQUIRE_MENTION_IN_GROUP", label: "Require Mention In Group", type: "boolean" }
    ]
  },
  {
    title: "Feishu (Advanced)",
    advanced: true,
    fields: [
      { key: "FEISHU_REPLY_TO_MESSAGE_ENABLED", label: "Reply To Message", type: "boolean" },
      { key: "FEISHU_INTERACTIVE_CARDS_ENABLED", label: "Interactive Cards", type: "boolean" },
      { key: "FEISHU_STREAM_OUTPUT_ENABLED", label: "Stream Output", type: "boolean" },
      { key: "FEISHU_STREAM_COMMAND_STATUS_ENABLED", label: "Stream Command Status", type: "boolean" },
      { key: "FEISHU_STREAM_MODE", label: "Stream Mode", options: ["hybrid", "card", "text"] },
      { key: "FEISHU_STREAM_UPDATE_MIN_INTERVAL_MS", label: "Stream Update Min Interval (ms)", type: "number" }
    ]
  },
  {
    title: "Workspace & Provider",
    advanced: false,
    fields: [
      { key: "HOST", label: "Health Host" },
      { key: "PORT", label: "Health Port", type: "number" },
      { key: "ENABLE_HEALTH_SERVER", label: "Enable Health Server", type: "boolean" },
      { key: "STATE_DIR", label: "State Directory" },
      { key: "CODEX_WORKSPACE_DIR", label: "Default Workspace Directory", required: true },
      { key: "WORKSPACE_ALLOWED_ROOTS", label: "Allowed Workspace Roots" },
      { key: "CHANNEL_PROVIDER", label: "Channel Provider", options: ["feishu"] },
      { key: "CLI_PROVIDER", label: "CLI Provider", options: ["codex", "claude-code", "opencode", "kimi-cli"] },
      { key: "TASK_ACK_ENABLED", label: "Task Ack Enabled", type: "boolean" }
    ]
  },
  {
    title: "Workspace & Provider (Advanced)",
    advanced: true,
    fields: [
      { key: "CHAT_WORKSPACE_MAPPINGS", label: "Chat Workspace Mappings" },
      { key: "GITHUB_REPO_OWNER", label: "GitHub Repo Owner" }
    ]
  },
  {
    title: "Codex",
    advanced: false,
    fields: [
      { key: "CODEX_COMMAND", label: "Codex Command" },
      { key: "CODEX_ADDITIONAL_ARGS", label: "Codex Additional Args" },
      { key: "CODEX_MODEL", label: "Codex Model" },
      { key: "CODEX_PROFILE", label: "Codex Profile" },
      { key: "CODEX_SANDBOX", label: "Codex Sandbox", options: ["workspace-write", "read-only", "danger-full-access"] },
      { key: "CODEX_APPROVAL_POLICY", label: "Codex Approval Policy", options: ["never", "on-request", "on-failure", "untrusted"] },
      { key: "CODEX_SKIP_GIT_REPO_CHECK", label: "Skip Git Repo Check", type: "boolean" },
      { key: "CODEX_PRELUDE", label: "Codex Prelude" }
    ]
  },
  {
    title: "Provider Commands",
    advanced: true,
    fields: [
      { key: "CLAUDE_CODE_COMMAND", label: "Claude Command" },
      { key: "CLAUDE_CODE_ADDITIONAL_ARGS", label: "Claude Additional Args" },
      { key: "OPENCODE_COMMAND", label: "Opencode Command" },
      { key: "OPENCODE_ADDITIONAL_ARGS", label: "Opencode Additional Args" },
      { key: "KIMI_CLI_COMMAND", label: "Kimi Command" },
      { key: "KIMI_CLI_ADDITIONAL_ARGS", label: "Kimi Additional Args" }
    ]
  },
  {
    title: "Queue & Context",
    advanced: true,
    fields: [
      { key: "DUPLICATE_TASK_WINDOW_MS", label: "Duplicate Task Window (ms)", type: "number" },
      { key: "MAX_CONCURRENT_TASKS", label: "Max Concurrent Tasks", type: "number" },
      { key: "MAX_QUEUED_TASKS_PER_CHAT", label: "Max Queued Tasks Per Chat", type: "number" },
      { key: "MAX_QUEUED_TASKS_PER_USER", label: "Max Queued Tasks Per User", type: "number" },
      { key: "MAX_REPLY_CHARS", label: "Max Reply Chars", type: "number" },
      { key: "CONTEXT_COMPACT_ENABLED", label: "Context Compact Enabled", type: "boolean" },
      { key: "CONTEXT_COMPACT_THRESHOLD", label: "Context Compact Threshold", type: "number" },
      { key: "CONTEXT_MEMORY_LOAD_FRACTION", label: "Context Memory Load Fraction", type: "number" },
      { key: "CONTEXT_WINDOW_FALLBACK_TOKENS", label: "Context Window Fallback Tokens", type: "number" },
      { key: "AUTO_COMMIT_AFTER_TASK_ENABLED", label: "Auto Commit After Task", type: "boolean" },
      { key: "AUTO_COMMIT_MESSAGE_PREFIX", label: "Auto Commit Message Prefix" }
    ]
  }
];

const ALL_FIELDS = FIELD_SECTIONS.flatMap((section) => section.fields);
const formEl = document.querySelector("#settings-form");
const advancedTextEl = document.querySelector("#advanced-text");
const statusEl = document.querySelector("#service-status");
const logsEl = document.querySelector("#service-logs");
const toggleAdvancedEl = document.querySelector("#toggle-advanced");
let showAdvanced = false;
let currentSettingsValues = {};

function inputIdForKey(key) {
  return `setting-${key.toLowerCase()}`;
}

function boolValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function createFieldControl(field, value = "") {
  const row = document.createElement("label");
  row.className = "field";
  row.setAttribute("for", inputIdForKey(field.key));

  const caption = document.createElement("span");
  caption.textContent = field.label;
  row.appendChild(caption);

  if (field.type === "boolean") {
    const checkbox = document.createElement("input");
    checkbox.id = inputIdForKey(field.key);
    checkbox.type = "checkbox";
    checkbox.checked = boolValue(value);
    row.appendChild(checkbox);
    return row;
  }

  if (field.options) {
    const select = document.createElement("select");
    select.id = inputIdForKey(field.key);
    for (const option of field.options) {
      const optionEl = document.createElement("option");
      optionEl.value = option;
      optionEl.textContent = option;
      select.appendChild(optionEl);
    }
    select.value = value || field.options[0];
    row.appendChild(select);
    return row;
  }

  const input = document.createElement("input");
  input.id = inputIdForKey(field.key);
  input.type = field.secret ? "password" : field.type || "text";
  input.value = value || "";
  if (field.required) {
    input.required = true;
  }
  row.appendChild(input);
  return row;
}

function renderForm(values = {}) {
  formEl.innerHTML = "";
  for (const section of FIELD_SECTIONS) {
    if (section.advanced && !showAdvanced) {
      continue;
    }
    const block = document.createElement("section");
    block.className = "sub-section";
    const title = document.createElement("h3");
    title.className = "section-title";
    title.textContent = section.title;
    block.appendChild(title);

    const grid = document.createElement("div");
    grid.className = "form-grid";
    for (const field of section.fields) {
      grid.appendChild(createFieldControl(field, values[field.key] || ""));
    }
    block.appendChild(grid);
    formEl.appendChild(block);
  }
}

function collectSettingsValues() {
  const values = {};
  for (const field of ALL_FIELDS) {
    const element = document.querySelector(`#${inputIdForKey(field.key)}`);
    if (field.type === "boolean") {
      values[field.key] = element?.checked ? "true" : "false";
      continue;
    }
    values[field.key] = String(element?.value || "").trim();
  }
  return values;
}

function validateSettingsValues(values) {
  if (!values.FEISHU_APP_ID) {
    throw new Error("FEISHU_APP_ID is required.");
  }
  if (!values.FEISHU_APP_SECRET) {
    throw new Error("FEISHU_APP_SECRET is required.");
  }
  if (!values.CODEX_WORKSPACE_DIR) {
    throw new Error("CODEX_WORKSPACE_DIR is required.");
  }
}

function renderStatus(payload) {
  statusEl.textContent = JSON.stringify(
    {
      running: payload.running,
      pid: payload.pid,
      lastError: payload.lastError || ""
    },
    null,
    2
  );
  logsEl.textContent = payload.logs || "";
}

async function loadConfig() {
  const data = await window.desktopBridge.loadConfig();
  currentSettingsValues = data.settingsValues || data.coreValues || {};
  renderForm(currentSettingsValues);
  advancedTextEl.value = data.advancedText || "";
}

async function refreshStatus() {
  const status = await window.desktopBridge.getServiceStatus();
  renderStatus(status);
}

document.querySelector("#save-btn").addEventListener("click", async () => {
  try {
    const settingsValues = {
      ...currentSettingsValues,
      ...collectSettingsValues()
    };
    validateSettingsValues(settingsValues);
    await window.desktopBridge.saveConfig({
      settingsValues,
      advancedText: advancedTextEl.value
    });
    await loadConfig();
    alert("配置已保存");
  } catch (error) {
    alert(error.message || String(error));
  }
});

document.querySelector("#start-btn").addEventListener("click", async () => {
  const status = await window.desktopBridge.startService();
  renderStatus(status);
});

document.querySelector("#stop-btn").addEventListener("click", async () => {
  const status = await window.desktopBridge.stopService();
  renderStatus(status);
});

document.querySelector("#refresh-btn").addEventListener("click", refreshStatus);
toggleAdvancedEl.addEventListener("click", () => {
  showAdvanced = !showAdvanced;
  toggleAdvancedEl.textContent = showAdvanced ? "隐藏高级配置" : "显示高级配置";
  currentSettingsValues = {
    ...currentSettingsValues,
    ...collectSettingsValues()
  };
  renderForm(currentSettingsValues);
});

setInterval(refreshStatus, 2000);
await loadConfig();
await refreshStatus();
