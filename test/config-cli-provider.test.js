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
    CLAUDE_CODE_COMMAND: undefined,
    CLAUDE_CODE_ADDITIONAL_ARGS: undefined,
    CHANNEL_PROVIDER: undefined,
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

test("loadConfig accepts scaffold CLI providers", () => {
  const rootDir = makeRoot("config-cli-scaffold-");
  for (const provider of ["claude-code", "opencode", "kimi-cli"]) {
    withEnv(
      {
        ...baseEnv(rootDir),
        CLI_PROVIDER: provider
      },
      () => {
        const config = loadConfig(rootDir);
        assert.equal(config.cliProvider, provider);
      }
    );
  }
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

test("loadConfig validates CHANNEL_PROVIDER", () => {
  const rootDir = makeRoot("config-channel-");

  withEnv(
    {
      ...baseEnv(rootDir),
      CHANNEL_PROVIDER: "telegram"
    },
    () => {
      const config = loadConfig(rootDir);
      assert.equal(config.channelProvider, "telegram");
    }
  );

  withEnv(
    {
      ...baseEnv(rootDir),
      CHANNEL_PROVIDER: "unknown"
    },
    () => {
      assert.throws(() => loadConfig(rootDir), /Unsupported CHANNEL_PROVIDER/);
    }
  );
});

test("loadConfig resolves CLAUDE_CODE command and additional args", () => {
  const rootDir = makeRoot("config-claude-command-");

  withEnv(
    {
      ...baseEnv(rootDir),
      CLAUDE_CODE_COMMAND: "claude",
      CLAUDE_CODE_ADDITIONAL_ARGS: "--print --json"
    },
    () => {
      const config = loadConfig(rootDir);
      assert.deepEqual(config.claudeCodeCommand, ["claude", "--print", "--json"]);
    }
  );
});
