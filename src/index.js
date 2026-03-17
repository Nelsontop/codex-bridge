import http from "node:http";
import { loadConfig } from "./config.js";
import { StateStore } from "./state-store.js";
import { BridgeService } from "./bridge-service.js";
import { buildMissingConfigGuide, runSetupWizard } from "./init-guide.js";
import { createFeishuChannelAdapter } from "./providers/channel/feishu/adapter.js";
import {
  buildSystemdUserService,
  getSystemdUserServicePath,
  installSystemdUserService,
  removeSystemdUserService
} from "./systemd-user-service.js";

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(payload)}\n`);
}

async function main() {
  const command = process.argv[2] || "";
  if (command === "setup" || command === "init") {
    await runSetupWizard({ rootDir: process.cwd() });
    return;
  }
  if (command === "service-print") {
    process.stdout.write(buildSystemdUserService({ rootDir: process.cwd() }));
    return;
  }
  if (command === "service-install") {
    const servicePath = installSystemdUserService({ rootDir: process.cwd() });
    console.log(`[service] installed user service: ${servicePath}`);
    console.log("[service] started with systemctl --user restart codex-feishu-bridge.service");
    console.log(
      `[service] health check: curl http://127.0.0.1:${process.env.PORT || 3000}/healthz`
    );
    return;
  }
  if (command === "service-remove") {
    const servicePath = removeSystemdUserService();
    console.log(`[service] removed user service: ${servicePath}`);
    return;
  }
  if (command === "service-path") {
    console.log(getSystemdUserServicePath());
    return;
  }

  let config;
  try {
    config = loadConfig(process.cwd());
  } catch (error) {
    if (String(error.message || "").startsWith("Missing required environment variable:")) {
      const missingKey = String(error.message).split(":").pop()?.trim() || "unknown";
      console.error(buildMissingConfigGuide({ missingKey }));
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const store = new StateStore(config.stateFile);
  const channelAdapter = createFeishuChannelAdapter(config);
  const bridge = new BridgeService(config, store, channelAdapter);
  channelAdapter.attachBridge(bridge);

  if (config.enableHealthServer) {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/healthz") {
        const channelMetrics = channelAdapter.getMetrics();
        sendJson(res, 200, {
          ok: true,
          transport: "feishu-ws",
          ...bridge.getHealth(),
          feishu: channelMetrics.feishu || null,
          reconnect: channelMetrics.reconnect || null,
          ws: channelMetrics.ws || null
        });
        return;
      }

      sendJson(res, 404, { code: 404, msg: "Not found" });
    });

    server.listen(config.port, config.host, () => {
      console.log(`[health] listening on http://${config.host}:${config.port}/healthz`);
    });
  }

  await channelAdapter.start();
  await bridge.resumeRecoveredTasks();
  console.log(
    `[ws] feishu persistent connection started, working in ${config.codexWorkspaceDir}`
  );
}

main().catch((error) => {
  console.error("[boot] failed:", error);
  process.exitCode = 1;
});
