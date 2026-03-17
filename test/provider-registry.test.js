import test from "node:test";
import assert from "node:assert/strict";
import {
  createBuiltinCliProviderRegistry,
  SUPPORTED_CLI_PROVIDERS
} from "../src/providers/cli/index.js";

test("builtin CLI provider registry contains all configured providers", () => {
  const registry = createBuiltinCliProviderRegistry(
    { codexWorkspaceDir: "/tmp/workspace", claudeCodeCommand: ["claude"] },
    {
      runCodexTask() {
        return {
          cancel() {},
          result: Promise.resolve({ finalMessage: "ok", sessionId: "thread" })
        };
      },
      runGenericCliTask() {
        return {
          cancel() {},
          result: Promise.resolve({ finalMessage: "ok", sessionId: "" })
        };
      }
    }
  );

  assert.deepEqual(registry.list().sort(), [...SUPPORTED_CLI_PROVIDERS].sort());
});

test("stub CLI providers fail with explicit not implemented message", () => {
  const registry = createBuiltinCliProviderRegistry(
    { codexWorkspaceDir: "/tmp/workspace", claudeCodeCommand: ["claude"] },
    {
      runCodexTask() {
        return {
          cancel() {},
          result: Promise.resolve({ finalMessage: "ok", sessionId: "thread" })
        };
      },
      runGenericCliTask() {
        return {
          cancel() {},
          result: Promise.resolve({ finalMessage: "ok", sessionId: "" })
        };
      }
    }
  );

  for (const name of ["opencode", "kimi-cli"]) {
    const provider = registry.get(name);
    assert.throws(() => provider.runTask({ prompt: "hi" }), /pending|unavailable/);
  }
});
