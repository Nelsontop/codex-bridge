import test from "node:test";
import assert from "node:assert/strict";
import { buildTaskName, summarizeTaskPrompt } from "../src/application/task-summary.js";

test("summarizeTaskPrompt keeps action + topic for natural language requests", () => {
  const summary = summarizeTaskPrompt(
    "请修复 src/application/bridge-service.js 的会话复用问题",
    64
  );
  assert.match(summary, /^修复src\/application\/bridge-service/);
});

test("buildTaskName falls back to summarized prompt", () => {
  const name = buildTaskName({
    id: "T001",
    nameSummary: "",
    prompt: "请检查 health payload 的 transport 字段"
  });
  assert.equal(name, "T001-检查healthpayload的tr");
});
