import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const SYSTEMD_USER_SERVICE_NAME = "agent-bridge.service";

function quoteSystemdValue(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function escapeSystemdPath(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/ /g, "\\x20");
}

function runSystemctl(args) {
  const result = spawnSync("systemctl", ["--user", ...args], {
    encoding: "utf8"
  });

  if (result.status !== 0) {
    const stderr = (result.stderr || result.stdout || "").trim() || "unknown error";
    const error = new Error(`systemctl --user ${args.join(" ")} failed: ${stderr}`);
    error.exitCode = result.status || 1;
    throw error;
  }
}

export function getSystemdUserServicePath() {
  return path.join(
    os.homedir(),
    ".config",
    "systemd",
    "user",
    SYSTEMD_USER_SERVICE_NAME
  );
}

export function buildSystemdUserService({ rootDir, nodePath = process.execPath, pathEnv }) {
  const execPath = path.join(rootDir, "src", "index.js");

  return [
    "[Unit]",
    "Description=Agent Bridge",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${escapeSystemdPath(rootDir)}`,
    `ExecStart=${quoteSystemdValue(nodePath)} ${quoteSystemdValue(execPath)}`,
    `Environment=${quoteSystemdValue(`PATH=${pathEnv || process.env.PATH || ""}`)}`,
    "Restart=always",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n");
}

export function installSystemdUserService({ rootDir, startNow = true } = {}) {
  const servicePath = getSystemdUserServicePath();
  fs.mkdirSync(path.dirname(servicePath), { recursive: true });
  fs.writeFileSync(servicePath, buildSystemdUserService({ rootDir }), "utf8");

  runSystemctl(["daemon-reload"]);
  runSystemctl(["enable", SYSTEMD_USER_SERVICE_NAME]);
  if (startNow) {
    runSystemctl(["restart", SYSTEMD_USER_SERVICE_NAME]);
  }

  return servicePath;
}

export function removeSystemdUserService({ stopNow = true } = {}) {
  const servicePath = getSystemdUserServicePath();

  if (stopNow) {
    try {
      runSystemctl(["disable", "--now", SYSTEMD_USER_SERVICE_NAME]);
    } catch (error) {
      if (!fs.existsSync(servicePath)) {
        return servicePath;
      }
      throw error;
    }
  } else {
    runSystemctl(["disable", SYSTEMD_USER_SERVICE_NAME]);
  }

  if (fs.existsSync(servicePath)) {
    fs.unlinkSync(servicePath);
  }
  runSystemctl(["daemon-reload"]);
  return servicePath;
}
