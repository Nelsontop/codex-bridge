import test from "node:test";
import assert from "node:assert/strict";
import { buildSystemdUserService } from "../src/infrastructure/system/systemd-user-service.js";

test("buildSystemdUserService renders a restartable user service", () => {
  const service = buildSystemdUserService({
    rootDir: "/workspace/codex-bridge",
    nodePath: "/usr/bin/node",
    pathEnv: "/usr/local/bin:/usr/bin"
  });

  assert.equal(service.includes("Description=Agent Bridge"), true);
  assert.equal(service.includes("WorkingDirectory=/workspace/codex-bridge"), true);
  assert.equal(
    service.includes('ExecStart="/usr/bin/node" "/workspace/codex-bridge/src/index.js"'),
    true
  );
  assert.equal(
    service.includes('Environment="PATH=/usr/local/bin:/usr/bin"'),
    true
  );
  assert.equal(service.includes("Restart=always"), true);
  assert.equal(service.includes("WantedBy=default.target"), true);
});
