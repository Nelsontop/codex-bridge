import test from "node:test";
import assert from "node:assert/strict";
import {
  TASK_STATUS,
  markTaskCompleted,
  markTaskFailed,
  markTaskQueuedForRetry,
  markTaskRunning
} from "../src/task-lifecycle.js";

function createTask(overrides = {}) {
  return {
    abortRequested: false,
    autoCommitSummary: "old summary",
    completedCommandIds: new Set(["done"]),
    contextUsageRatio: 0.5,
    enqueuedAt: "2026-03-16T00:00:00.000Z",
    finalMessage: "old final",
    lastErrorMessage: "old error",
    lastProgressText: "old progress",
    lastStreamSentAt: 123,
    modelContextWindow: 32000,
    recovered: false,
    sessionId: "thread_old",
    startedAt: "2026-03-16T00:01:00.000Z",
    startedCommandIds: new Set(["cmd"]),
    status: TASK_STATUS.QUEUED,
    streamChain: Promise.resolve("done"),
    workspaceDir: "",
    ...overrides
  };
}

test("markTaskQueuedForRetry resets execution state and keeps workspace fallback", () => {
  const task = createTask({ recovered: false });

  markTaskQueuedForRetry(task, "/tmp/retry-workspace");

  assert.equal(task.status, TASK_STATUS.QUEUED);
  assert.equal(task.recovered, true);
  assert.equal(task.workspaceDir, "/tmp/retry-workspace");
  assert.equal(task.lastProgressText, "任务已从中断状态重新入队。");
  assert.equal(task.sessionId, "thread_old");
  assert.equal(task.autoCommitSummary, "");
  assert.deepEqual([...task.startedCommandIds], []);
  assert.deepEqual([...task.completedCommandIds], []);
});

test("markTaskRunning sets task to running with progress text", () => {
  const freshTask = createTask({ recovered: false });
  markTaskRunning(freshTask);
  assert.equal(freshTask.status, TASK_STATUS.RUNNING);
  assert.equal(freshTask.lastProgressText, "任务已开始执行。");
  assert.ok(freshTask.startedAt);

  const recoveredTask = createTask({ recovered: true });
  markTaskRunning(recoveredTask);
  assert.equal(recoveredTask.lastProgressText, "服务重启后恢复排队，任务已继续执行。");
});

test("markTaskCompleted stores final result", () => {
  const task = createTask();

  markTaskCompleted(task, {
    finalMessage: "任务完成",
    sessionId: "thread_new"
  });

  assert.equal(task.status, TASK_STATUS.COMPLETED);
  assert.equal(task.finalMessage, "任务完成");
  assert.equal(task.sessionId, "thread_new");
  assert.equal(task.lastErrorMessage, "");
});

test("markTaskFailed distinguishes cancelled and failed states", () => {
  const failedTask = createTask({ abortRequested: false });
  markTaskFailed(failedTask, new Error("boom"));
  assert.equal(failedTask.status, TASK_STATUS.FAILED);
  assert.equal(failedTask.lastErrorMessage, "boom");
  assert.equal(failedTask.autoCommitSummary, "");

  const cancelledTask = createTask({
    abortRequested: true,
    lastErrorMessage: "收到终止请求，正在结束任务。"
  });
  markTaskFailed(cancelledTask, new Error("ignored"));
  assert.equal(cancelledTask.status, TASK_STATUS.CANCELLED);
  assert.equal(cancelledTask.lastErrorMessage, "收到终止请求，正在结束任务。");
});
