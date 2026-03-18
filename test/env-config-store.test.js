import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildUpdatedEnvText,
  loadEnvConfig,
  parseAdvancedEnvText,
  saveEnvConfig
} from "../src/desktop/env-config-store.js";

test("parseAdvancedEnvText rejects invalid lines and core keys", () => {
  const result = parseAdvancedEnvText(`
FOO=bar
INVALID
PORT=3000
`);
  assert.equal(result.values.FOO, "bar");
  assert.equal(result.errors.length, 2);
});

test("buildUpdatedEnvText updates core and advanced values", () => {
  const existing = `
# Base
FEISHU_APP_ID=old
FOO=1
BAR=2
`.trimStart();
  const text = buildUpdatedEnvText(existing, {
    coreValues: {
      FEISHU_APP_ID: "new-app",
      FEISHU_APP_SECRET: "new-secret"
    },
    advancedValues: {
      FOO: "9",
      BAZ: "3"
    }
  });

  assert.match(text, /FEISHU_APP_ID=new-app/);
  assert.match(text, /FEISHU_APP_SECRET=new-secret/);
  assert.match(text, /FOO=9/);
  assert.match(text, /BAZ=3/);
  assert.doesNotMatch(text, /BAR=2/);
});

test("saveEnvConfig writes and loads env config", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-env-"));
  fs.writeFileSync(
    path.join(rootDir, ".env"),
    [
      "FEISHU_APP_ID=app1",
      "FEISHU_APP_SECRET=secret1",
      "FOO=bar",
      ""
    ].join("\n"),
    "utf8"
  );

  const saved = saveEnvConfig(rootDir, {
    coreValues: {
      FEISHU_APP_ID: "app2",
      FEISHU_APP_SECRET: "secret2",
      PORT: "3001"
    },
    advancedText: "HELLO=WORLD"
  });
  assert.equal(saved.coreValues.FEISHU_APP_ID, "app2");
  assert.equal(saved.coreValues.PORT, "3001");
  assert.match(saved.advancedText, /HELLO=WORLD/);
  assert.doesNotMatch(saved.advancedText, /FOO=bar/);

  const loaded = loadEnvConfig(rootDir);
  assert.equal(loaded.coreValues.FEISHU_APP_SECRET, "secret2");
});
