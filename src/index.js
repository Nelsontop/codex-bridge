import http from "node:http";
import { loadConfig } from "./config.js";
import { StateStore } from "./state-store.js";
import { FeishuClient } from "./feishu-client.js";
import { BridgeService } from "./bridge-service.js";
import { FeishuWsClient } from "./feishu-ws-client.js";

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(payload)}\n`);
}

const config = loadConfig(process.cwd());
const store = new StateStore(config.stateFile);
const feishuClient = new FeishuClient(config);
const bridge = new BridgeService(config, store, feishuClient);
const wsClient = new FeishuWsClient(config, bridge);

async function main() {
  if (config.enableHealthServer) {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/healthz") {
        sendJson(res, 200, {
          ok: true,
          transport: "feishu-ws",
          ...bridge.getHealth(),
          feishu: feishuClient.getMetrics(),
          reconnect: wsClient.getReconnectInfo(),
          ws: wsClient.getMetrics()
        });
        return;
      }

      sendJson(res, 404, { code: 404, msg: "Not found" });
    });

    server.listen(config.port, config.host, () => {
      console.log(`[health] listening on http://${config.host}:${config.port}/healthz`);
    });
  }

  await wsClient.start();
  await bridge.resumeRecoveredTasks();
  console.log(
    `[ws] feishu persistent connection started, working in ${config.codexWorkspaceDir}`
  );
}

main().catch((error) => {
  console.error("[boot] failed:", error);
  process.exitCode = 1;
});
