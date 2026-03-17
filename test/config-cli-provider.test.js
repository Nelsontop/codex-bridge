import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

const TEST_TMP_DIR = path.join(process.cwd(), ".tmp-test");

function makeRoot(prefix) {
  fs.mkdirSync(TEST_TMP_DIR, { recursive: true });
  return fs.mkdtempSync(path.join(TEST_TMP_DIR, prefix));
}

function withEnv(nextEnv, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(nextEnv)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function baseEnv(rootDir) {
  return {
    FEISHU_APP_ID: "cli_test",
    FEISHU_APP_SECRET: "secret_test",
    CODEX_WORKSPACE_DIR: rootDir,
    CLI_PROVIDER: undefined
  };
}

test("loadConfig defaults cliProvider to codex", () => {
  const rootDir = makeRoot("config-cli-default-");

  withEnv(baseEnv(rootDir), () => {
    const config = loadConfig(rootDir);
    assert.equal(config.cliProvider, "codex");
  });
});

test("loadConfig respects CLI_PROVIDER=codex", () => {
  const rootDir = makeRoot("config-cli-codex-");

  withEnv({
    ...baseEnv(rootDir),
    CLI_PROVIDER: "codex"
  }, () => {
    const config = loadConfig(rootDir);
    assert.equal(config.cliProvider, "codex");
  });
});

test("loadConfig rejects unsupported CLI_PROVIDER", () => {
  const rootDir = makeRoot("config-cli-invalid-");

  withEnv({
    ...baseEnv(rootDir),
    CLI_PROVIDER: "kimi"
  }, () => {
    assert.throws(
      () => loadConfig(rootDir),
      /Unsupported CLI_PROVIDER/
    );
  });
});
