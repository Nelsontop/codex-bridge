const CORE_FIELDS = [
  { key: "FEISHU_APP_ID", label: "Feishu App ID", required: true },
  { key: "FEISHU_APP_SECRET", label: "Feishu App Secret", required: true, secret: true },
  { key: "FEISHU_BOT_OPEN_ID", label: "Feishu Bot Open ID" },
  { key: "FEISHU_ALLOWED_OPEN_IDS", label: "Allowed Open IDs" },
  { key: "HOST", label: "Host" },
  { key: "PORT", label: "Port", type: "number" },
  { key: "STATE_DIR", label: "State Directory" },
  { key: "CODEX_WORKSPACE_DIR", label: "Workspace Directory" },
  { key: "WORKSPACE_ALLOWED_ROOTS", label: "Allowed Roots" },
  {
    key: "CLI_PROVIDER",
    label: "CLI Provider",
    options: ["codex", "claude-code", "opencode", "kimi-cli"]
  },
  { key: "CHANNEL_PROVIDER", label: "Channel Provider", options: ["feishu"] },
  { key: "CODEX_COMMAND", label: "Codex Command" },
  { key: "CODEX_MODEL", label: "Codex Model" },
  { key: "CODEX_PROFILE", label: "Codex Profile" },
  {
    key: "CODEX_SANDBOX",
    label: "Codex Sandbox",
    options: ["workspace-write", "read-only", "danger-full-access"]
  },
  {
    key: "CODEX_APPROVAL_POLICY",
    label: "Codex Approval Policy",
    options: ["never", "on-request", "on-failure", "untrusted"]
  }
];

const formEl = document.querySelector("#core-form");
const advancedTextEl = document.querySelector("#advanced-text");
const statusEl = document.querySelector("#service-status");
const logsEl = document.querySelector("#service-logs");

function inputIdForKey(key) {
  return `core-${key.toLowerCase()}`;
}

function createFieldControl(field, value = "") {
  const row = document.createElement("label");
  row.className = "field";
  row.setAttribute("for", inputIdForKey(field.key));

  const caption = document.createElement("span");
  caption.textContent = field.label;
  row.appendChild(caption);

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

function collectCoreValues() {
  const values = {};
  for (const field of CORE_FIELDS) {
    const element = document.querySelector(`#${inputIdForKey(field.key)}`);
    values[field.key] = String(element?.value || "").trim();
  }
  return values;
}

function validateCoreValues(values) {
  if (!values.FEISHU_APP_ID) {
    throw new Error("FEISHU_APP_ID is required.");
  }
  if (!values.FEISHU_APP_SECRET) {
    throw new Error("FEISHU_APP_SECRET is required.");
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
  formEl.innerHTML = "";
  for (const field of CORE_FIELDS) {
    formEl.appendChild(createFieldControl(field, data.coreValues[field.key] || ""));
  }
  advancedTextEl.value = data.advancedText || "";
}

async function refreshStatus() {
  const status = await window.desktopBridge.getServiceStatus();
  renderStatus(status);
}

document.querySelector("#save-btn").addEventListener("click", async () => {
  try {
    const coreValues = collectCoreValues();
    validateCoreValues(coreValues);
    await window.desktopBridge.saveConfig({
      coreValues,
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

setInterval(refreshStatus, 2000);
await loadConfig();
await refreshStatus();
