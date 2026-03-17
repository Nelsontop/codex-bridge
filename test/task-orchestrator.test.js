import test from "node:test";
import assert from "node:assert/strict";
import { createCliProviderRegistry } from "../src/core/cli-provider.js";
import { TaskOrchestrator } from "../src/core/task-orchestrator.js";

test("TaskOrchestrator resolves provider and runs task", async () => {
  const registry = createCliProviderRegistry([
    {
      name: "codex",
      supportsResume: true,
      runTask(taskOptions) {
        return {
          cancel() {},
          result: Promise.resolve(taskOptions)
        };
      }
    }
  ]);

  const orchestrator = new TaskOrchestrator({
    providerRegistry: registry,
    resolveProviderName: () => "codex"
  });

  const execution = orchestrator.runTask({
    chatKey: "group:1",
    taskOptions: { prompt: "hi" }
  });

  assert.deepEqual(await execution.result, { prompt: "hi" });
});

test("TaskOrchestrator throws on unknown provider", () => {
  const orchestrator = new TaskOrchestrator({
    providerRegistry: createCliProviderRegistry(),
    resolveProviderName: () => "missing"
  });

  assert.throws(
    () => orchestrator.runTask({ taskOptions: {} }),
    /CLI provider not found/
  );
});
