export const TASK_STATUS = {
  CANCELLED: "cancelled",
  COMPLETED: "completed",
  FAILED: "failed",
  INTERRUPTED: "interrupted",
  QUEUED: "queued",
  RUNNING: "running"
};

function resetExecutionState(task) {
  task.abortRequested = false;
  task.autoCommitSummary = "";
  task.contextUsageRatio = 0;
  task.finalMessage = "";
  task.lastErrorMessage = "";
  task.lastStreamSentAt = 0;
  task.modelContextWindow = 0;
  task.startedAt = "";
  task.startedCommandIds = new Set();
  task.completedCommandIds = new Set();
  task.streamChain = Promise.resolve();
}

export function markTaskQueuedForRetry(task, workspaceDir) {
  resetExecutionState(task);
  task.status = TASK_STATUS.QUEUED;
  task.recovered = true;
  task.enqueuedAt = new Date().toISOString();
  task.lastProgressText = "任务已从中断状态重新入队。";
  task.workspaceDir = task.workspaceDir || workspaceDir;
  return task;
}

export function markTaskRunning(task) {
  task.status = TASK_STATUS.RUNNING;
  task.startedAt = new Date().toISOString();
  task.streamChain = Promise.resolve();
  task.lastStreamSentAt = 0;
  task.lastProgressText = task.recovered
    ? "服务重启后恢复排队，任务已继续执行。"
    : "任务已开始执行。";
  task.startedCommandIds = new Set();
  task.completedCommandIds = new Set();
  return task;
}

export function markTaskCompleted(task, result) {
  task.status = TASK_STATUS.COMPLETED;
  task.sessionId = result.sessionId || "";
  task.finalMessage = result.finalMessage;
  task.lastErrorMessage = "";
  return task;
}

export function markTaskFailed(task, error) {
  task.status = task.abortRequested ? TASK_STATUS.CANCELLED : TASK_STATUS.FAILED;
  task.lastErrorMessage =
    task.abortRequested && task.lastErrorMessage
      ? task.lastErrorMessage
      : error.message || String(error);
  task.finalMessage = "";
  task.autoCommitSummary = "";
  return task;
}
