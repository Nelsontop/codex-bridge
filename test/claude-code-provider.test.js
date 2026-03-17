import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeCodeProvider } from "../src/providers/cli/claude-code-provider.js";

test("createClaudeCodeProvider delegates to generic runner", async () => {
  const calls = [];
  const provider = createClaudeCodeProvider(
    {
      claudeCodeCommand: ["claude", "--print"]
    },
    {
      runGenericCliTask(commandParts, options) {
        calls.push({ commandParts, options });
        return {
          cancel() {},
          result: Promise.resolve({ finalMessage: "ok", sessionId: "" })
        };
      }
    }
  );

  assert.equal(provider.name, "claude-code");
  assert.equal(provider.supportsResume, false);

  const execution = provider.runTask({ prompt: "hello", workspaceDir: "/tmp/ws" });
  const result = await execution.result;

  assert.deepEqual(calls[0].commandParts, ["claude", "--print"]);
  assert.equal(calls[0].options.prompt, "hello");
  assert.equal(calls[0].options.workspaceDir, "/tmp/ws");
  assert.equal(result.finalMessage, "ok");
});
