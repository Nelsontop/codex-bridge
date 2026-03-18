import { app, BrowserWindow, ipcMain } from "electron";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig, saveEnvConfig } from "../src/desktop/env-config-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class BridgeServiceController {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.child = null;
    this.logs = [];
    this.lastError = "";
  }

  appendLog(line) {
    if (!line) {
      return;
    }
    this.logs.push(`[${new Date().toISOString()}] ${line}`);
    this.logs = this.logs.slice(-600);
  }

  isRunning() {
    return Boolean(this.child && !this.child.killed);
  }

  getStatus() {
    return {
      running: this.isRunning(),
      pid: this.child?.pid || null,
      lastError: this.lastError,
      logs: this.logs.join("\n")
    };
  }

  start() {
    if (this.isRunning()) {
      return this.getStatus();
    }

    const entryScript = path.join(this.rootDir, "src", "index.js");
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1"
    };
    const child = spawn(process.execPath, [entryScript], {
      cwd: this.rootDir,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child = child;
    this.lastError = "";
    this.appendLog("[desktop] bridge service starting...");

    child.stdout.on("data", (chunk) => {
      this.appendLog(chunk.toString("utf8").trim());
    });

    child.stderr.on("data", (chunk) => {
      this.appendLog(chunk.toString("utf8").trim());
    });

    child.on("exit", (code, signal) => {
      this.appendLog(`[desktop] bridge service exited with code=${code}, signal=${signal}`);
      this.child = null;
    });

    child.on("error", (error) => {
      this.lastError = error.message || String(error);
      this.appendLog(`[desktop] failed to start service: ${this.lastError}`);
    });

    return this.getStatus();
  }

  stop() {
    if (!this.isRunning()) {
      return this.getStatus();
    }
    this.child.kill("SIGTERM");
    this.appendLog("[desktop] stop signal sent.");
    return this.getStatus();
  }
}

const rootDir = path.resolve(__dirname, "..");
const controller = new BridgeServiceController(rootDir);

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 840,
    minWidth: 1024,
    minHeight: 760,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

ipcMain.handle("desktop:config:load", async () => {
  return loadEnvConfig(rootDir);
});

ipcMain.handle("desktop:config:save", async (_, payload) => {
  return saveEnvConfig(rootDir, payload || {});
});

ipcMain.handle("desktop:service:start", async () => {
  return controller.start();
});

ipcMain.handle("desktop:service:stop", async () => {
  return controller.stop();
});

ipcMain.handle("desktop:service:status", async () => {
  return controller.getStatus();
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  controller.stop();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
