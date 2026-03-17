import test from "node:test";
import assert from "node:assert/strict";
import { buildSystemdUserService } from "../src/systemd-user-service.js";

test("buildSystemdUserService renders a restartable user service", () => {
  const service = buildSystemdUserService({
    rootDir: "/tmp/codex-bridge",
    nodePath: "/usr/bin/node",
    pathEnv: "/usr/local/bin:/usr/bin"
  });

  assert.equal(service.includes("Description=Codex Feishu Bridge"), true);
  assert.equal(service.includes("WorkingDirectory=/tmp/codex-bridge"), true);
  assert.equal(
    service.includes('ExecStart="/usr/bin/node" "/tmp/codex-bridge/src/index.js"'),
    true
  );
  assert.equal(
    service.includes('Environment="PATH=/usr/local/bin:/usr/bin"'),
    true
  );
  assert.equal(service.includes("Restart=always"), true);
  assert.equal(service.includes("WantedBy=default.target"), true);
});
