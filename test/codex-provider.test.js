import test from "node:test";
import assert from "node:assert/strict";
import { createCodexProvider } from "../src/providers/cli/codex-provider.js";

test("createCodexProvider delegates execution to runCodexTask", async () => {
  const calls = [];
  const expectedResult = { finalMessage: "done", sessionId: "thread_1" };
  const provider = createCodexProvider(
    { codexWorkspaceDir: "/tmp/workspace" },
    {
      runCodexTask(config, options) {
        calls.push({ config, options });
        return {
          cancel() {},
          result: Promise.resolve(expectedResult)
        };
      }
    }
  );

  assert.equal(provider.name, "codex");
  assert.equal(provider.supportsResume, true);

  const execution = provider.runTask({ prompt: "hi" });
  const result = await execution.result;

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, { prompt: "hi" });
  assert.equal(result, expectedResult);
});
