import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEnvFileText,
  buildMissingConfigGuide,
  buildSetupChecklist,
  parseEnvText
} from "../src/init-guide.js";

test("parseEnvText reads quoted and plain env values", () => {
  const parsed = parseEnvText(`
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET="secret value"
# comment
PORT=3000
`);

  assert.deepEqual(parsed, {
    FEISHU_APP_ID: "cli_xxx",
    FEISHU_APP_SECRET: "secret value",
    PORT: "3000"
  });
});

test("buildEnvFileText preserves unknown keys and updates managed ones", () => {
  const text = buildEnvFileText(
    "FEISHU_APP_ID=old\nCUSTOM_FLAG=1\n",
    {
      FEISHU_APP_ID: "cli_new",
      FEISHU_APP_SECRET: "secret value",
      CODEX_WORKSPACE_DIR: "/tmp/project",
      WORKSPACE_ALLOWED_ROOTS: "/tmp/project,/tmp/sandboxes"
    }
  );

  assert.equal(text.includes("FEISHU_APP_ID=cli_new"), true);
  assert.equal(text.includes("FEISHU_APP_SECRET=\"secret value\""), true);
  assert.equal(text.includes("CODEX_WORKSPACE_DIR=/tmp/project"), true);
  assert.equal(text.includes("WORKSPACE_ALLOWED_ROOTS=\"/tmp/project,/tmp/sandboxes\""), true);
  assert.equal(text.includes("CUSTOM_FLAG=1"), true);
});

test("setup checklist and missing config guide include actionable next steps", () => {
  const checklist = buildSetupChecklist({ envFilePath: "/tmp/project/.env" });
  const guide = buildMissingConfigGuide({
    command: "npm run setup",
    missingKey: "FEISHU_APP_ID"
  });

  assert.equal(checklist.includes("/tmp/project/.env"), true);
  assert.equal(checklist.includes("npm start"), true);
  assert.equal(guide.includes("FEISHU_APP_ID"), true);
  assert.equal(guide.includes("npm run setup"), true);
});
