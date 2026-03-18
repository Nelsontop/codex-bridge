import { buildTaskName } from "./task-summary.js";

function splitText(text, maxChars) {
  const chunks = [];
  let rest = String(text || "").trim();
  while (rest.length > maxChars) {
    let index = rest.lastIndexOf("\n", maxChars);
    if (index < maxChars * 0.5) {
      index = rest.lastIndexOf(" ", maxChars);
    }
    if (index < maxChars * 0.5) {
      index = maxChars;
    }
    chunks.push(rest.slice(0, index).trim());
    rest = rest.slice(index).trim();
  }
  if (rest) {
    chunks.push(rest);
  }
  return chunks.length > 0 ? chunks : [""];
}

export async function runTaskExecution(ctx, task) {
  ctx.markTaskRunning(task);

  const taskProvider = ctx.resolveTaskProvider(task.chatKey);
  const providerSupportsResume =
    typeof taskProvider.supportsResume === "boolean"
      ? taskProvider.supportsResume
      : taskProvider.name === "codex";
  task.providerName = taskProvider.name || ctx.resolveCliProviderName(task.chatKey);
  task.providerSupportsResume = providerSupportsResume;

  const conversation = ctx.store.getConversation(task.chatKey);
  const previousSessionId =
    task.sessionId ||
    (conversation?.workspaceDir === task.workspaceDir ? conversation?.sessionId || null : null);
  const sessionId = providerSupportsResume ? previousSessionId : "";
  const runner = ctx.taskOrchestrator.runTask({
    chatKey: task.chatKey,
    taskOptions: {
      onEvent: (event) => {
        ctx.handleRunnerEvent(task, event);
      },
      prompt: ctx.buildPromptWithMemory(task.prompt, conversation, task.workspaceDir),
      sessionId,
      workspaceDir: task.workspaceDir
    }
  });

  task.runner = runner;
  ctx.runtime.start(task);
  task.recovered = false;
  await ctx.syncTaskCard(task);

  let autoCommitResult = null;
  try {
    const result = await runner.result;
    await task.streamChain;
    ctx.ensureTaskNotAborted(task);
    const interactionRequest = ctx.parseInteractionRequest(result.finalMessage);
    if (interactionRequest?.error) {
      throw new Error(interactionRequest.error);
    }

    const normalizedResult = {
      ...result,
      finalMessage:
        interactionRequest?.cleanedText ||
        (interactionRequest ? `需要用户选择：${interactionRequest.question}` : result.finalMessage)
    };
    ctx.markTaskCompleted(task, normalizedResult);

    if (interactionRequest) {
      const interaction = await ctx.registerPendingInteraction(
        task,
        normalizedResult,
        interactionRequest
      );
      task.finalMessage = `需要用户选择：${interaction.question}`;
      await ctx.safeSend(
        task.target,
        ctx.buildInteractionText(interaction, buildTaskName(task))
      );
      return;
    }

    ctx.store.upsertConversation(task.chatKey, {
      lastContextUsageRatio: task.contextUsageRatio,
      lastModelContextWindow: task.modelContextWindow || 0,
      memoryFilePath: conversation?.memoryFilePath || "",
      lastSenderOpenId: task.senderOpenId,
      lastTaskId: task.id,
      pendingInteraction: null,
      sessionId: providerSupportsResume ? result.sessionId : "",
      workspaceDir: task.workspaceDir
    });

    ctx.ensureTaskNotAborted(task);
    autoCommitResult = await ctx.autoCommitWorkspace(ctx.config, task);
    task.autoCommitSummary = ctx.formatAutoCommitResult(autoCommitResult);
    let compacted = false;
    if (!providerSupportsResume && result.sessionId && ctx.config.contextCompactEnabled) {
      ctx.metrics.lastCompactionDecision = "unsupported-provider";
      ctx.metrics.lastCompactionTaskId = task.id;
      ctx.metrics.lastCompactionUpdatedAt = new Date().toISOString();
    }
    if (providerSupportsResume && result.sessionId) {
      try {
        ctx.ensureTaskNotAborted(task);
        const compactResult = await ctx.compactConversationContext(task, result.sessionId);
        compacted = compactResult.performed;
      } catch (error) {
        console.error(`[task:${task.id}] context compaction failed:`, error);
        task.lastProgressText = `上下文压缩失败，将继续沿用当前会话：${error.message || String(error)}`;
      }
    }
    if (compacted) {
      task.sessionId = "";
    }
    ctx.ensureTaskNotAborted(task);
    await ctx.syncTaskCard(task);

    if (!ctx.config.feishuInteractiveCardsEnabled) {
      const finalText = [
        `任务 ${buildTaskName(task)} 已完成。`,
        task.sessionId ? `session: ${task.sessionId}` : "",
        `workspace: ${task.workspaceDir}`,
        task.autoCommitSummary ? `自动提交：${task.autoCommitSummary}` : "",
        "",
        task.finalMessage
      ]
        .filter(Boolean)
        .join("\n");
      for (const chunk of splitText(finalText, ctx.config.maxReplyChars)) {
        await ctx.safeSend(task.target, chunk);
      }
    }
  } catch (error) {
    await task.streamChain;
    ctx.markTaskFailed(task, error);
    if (task.abortRequested && autoCommitResult?.status === "committed") {
      const rollbackResult = await ctx.rollbackAutoCommitWorkspace(
        ctx.config,
        task,
        autoCommitResult.commitId
      );
      task.autoCommitSummary = ctx.formatAutoCommitRollbackResult(rollbackResult);
      console.log(
        `[task:${task.id}] auto commit rollback result: ${rollbackResult.status}${rollbackResult.reason ? ` (${rollbackResult.reason})` : ""}`
      );
    }
    await ctx.syncTaskCard(task);

    if (!ctx.config.feishuInteractiveCardsEnabled) {
      await ctx.safeSend(
        task.target,
        task.abortRequested
          ? `任务 ${buildTaskName(task)} 已取消。\n${task.lastErrorMessage}`
          : [`任务 ${buildTaskName(task)} 执行失败：`, task.lastErrorMessage].join("\n")
      );
    }
  } finally {
    await ctx.finalizeTask(task);
  }
}
