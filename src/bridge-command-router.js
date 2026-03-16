import { parseCommandText } from "./command-parser.js";
import { markTaskQueuedForRetry } from "./task-lifecycle.js";

export class BridgeCommandRouter {
  constructor(bridge, helpers) {
    this.bridge = bridge;
    this.helpers = helpers;
  }

  async bindWorkspace({ chatId, chatKey, repoName, target, workspaceInput }) {
    if (!workspaceInput) {
      await this.bridge.safeSend(target, "用法：/bind <工作目录> [仓库名]");
      return;
    }

    if (this.bridge.countPendingTasksForChat(chatKey) > 0) {
      await this.bridge.safeSend(
        target,
        "当前聊天还有运行中或排队中的任务，暂时不能切换工作目录。请等待任务完成后再绑定。"
      );
      return;
    }

    let result;
    try {
      result = await this.bridge.prepareWorkspaceBinding(this.bridge.config, {
        repoName,
        workspaceInput
      });
    } catch (error) {
      await this.bridge.safeSend(
        target,
        `工作目录绑定失败：${error.message || String(error)}`
      );
      return;
    }
    this.bridge.store.upsertConversation(chatKey, {
      bindingPromptedAt: "",
      bindingStatus: "bound",
      lastContextUsageRatio: 0,
      lastModelContextWindow: 0,
      memoryFilePath: "",
      pendingInteraction: null,
      repoName: result.repoName,
      repoRemoteStatus: result.remoteStatus,
      repoRemoteUrl: result.remoteUrl || "",
      sessionId: "",
      workspaceDir: result.workspaceDir
    });

    const lines = [
      `已绑定工作目录：${result.workspaceDir}`,
      `GitHub 仓库：${result.repoName}`,
      result.gitInitialized ? "本地仓库：已初始化 Git 仓库" : "本地仓库：沿用现有 Git 仓库",
      result.initialCommitCreated ? "初始化提交：已创建" : "初始化提交：已存在",
      result.remoteStatus === "created"
        ? `远端仓库：已创建 ${result.remoteUrl || "(origin 已配置)"}`
        : result.remoteStatus === "existing"
          ? `远端仓库：沿用现有 origin ${result.remoteUrl || ""}`.trim()
          : `远端仓库：创建失败，${result.remoteError || "请检查 gh 配置后重试"}`,
      "后续在当前群里启动的 Codex session 都会使用这个目录。"
    ];
    await this.bridge.safeSend(target, lines.join("\n"));
  }

  async retryInterruptedTask({ chatId, chatKey, taskReference = "", target, silentSuccess }) {
    const pendingForChat = this.bridge.countPendingTasksForChat(chatKey);
    if (pendingForChat >= this.bridge.config.maxQueuedTasksPerChat) {
      this.bridge.metrics.rejectedByChatLimit += 1;
      await this.bridge.safeSend(
        target,
        `当前聊天待处理任务已达上限（${this.bridge.config.maxQueuedTasksPerChat}）。请等待已有任务完成，或用 /abort <任务号> 取消排队任务。`
      );
      return;
    }

    const { index, task } = this.bridge.findInterruptedTask(chatKey, taskReference);
    if (!task) {
      await this.bridge.safeSend(
        target,
        taskReference
          ? `当前聊天没有中断任务 ${taskReference}。`
          : "当前聊天没有可重试的中断任务。"
      );
      return;
    }

    const pendingForUser = this.bridge.countPendingTasksForUser(task.senderOpenId, chatKey);
    if (pendingForUser >= this.bridge.config.maxQueuedTasksPerUser) {
      this.bridge.metrics.rejectedByUserLimit += 1;
      await this.bridge.safeSend(
        target,
        `当前聊天内该用户待处理任务已达上限（${this.bridge.config.maxQueuedTasksPerUser}）。请等待已有任务完成，或取消排队中的任务。`
      );
      return;
    }

    this.bridge.runtime.takeInterruptedTask(index);
    markTaskQueuedForRetry(
      task,
      this.bridge.resolveWorkspaceDir(chatKey, chatId)
    );
    this.bridge.runtime.enqueue(task);
    const queuePosition = this.bridge.findQueuePositionForTask(task);
    await this.bridge.syncTaskCard(task);
    await this.bridge.refreshQueuedTaskCards();
    this.bridge.pumpQueue();

    if (!silentSuccess) {
      await this.bridge.safeSend(
        target,
        `已重试任务 ${this.helpers.buildTaskName(task)}，队列位置 ${queuePosition}。`
      );
    }
  }

  async handle({ commandText, chatId, chatKey, target, silentSuccess = false }) {
    const [command, ...rest] = parseCommandText(commandText);

    if (
      this.bridge.requiresWorkspaceBinding(chatKey, chatId) &&
      !["/bind", "/choose", "/help", "/reset", "/status"].includes(command)
    ) {
      await this.bridge.sendWorkspaceBindingPrompt(target, chatKey, chatId);
      return;
    }

    if (command === "/help") {
      await this.bridge.safeSend(target, this.helpers.helpText());
      return;
    }

    if (command === "/bind") {
      await this.bindWorkspace({
        chatId,
        chatKey,
        repoName: rest[1] || "",
        target,
        workspaceInput: rest[0] || ""
      });
      return;
    }

    if (command === "/reset") {
      const conversation = this.bridge.store.getConversation(chatKey);
      if (conversation?.workspaceDir) {
        this.bridge.store.upsertConversation(chatKey, {
          bindingStatus: "bound",
          lastContextUsageRatio: 0,
          lastModelContextWindow: 0,
          memoryFilePath: "",
          pendingInteraction: null,
          sessionId: ""
        });
      } else {
        this.bridge.store.clearConversation(chatKey);
      }
      if (!silentSuccess) {
        await this.bridge.safeSend(
          target,
          conversation?.workspaceDir
            ? "已清空当前聊天绑定的 Codex 会话，工作目录绑定保留。"
            : "已清空当前聊天绑定的 Codex 会话。"
        );
      }
      return;
    }

    if (command === "/status") {
      const conversation = this.bridge.store.getConversation(chatKey);
      const runningTask = [...this.bridge.running.values()].find(
        (task) => task.chatKey === chatKey
      );
      const queuedTasks = this.bridge.queue.filter((task) => task.chatKey === chatKey);
      const interruptedCount = this.bridge.interruptedTasks.filter(
        (task) => task.chatKey === chatKey
      ).length;
      const workspaceDir = this.bridge.resolveWorkspaceDir(chatKey, chatId);
      const bindingState = chatKey.startsWith("group:")
        ? this.bridge.requiresWorkspaceBinding(chatKey, chatId)
          ? "待绑定"
          : "已绑定"
        : "私聊默认目录";
      const lines = [
        `chatKey: ${chatKey}`,
        `binding: ${bindingState}`,
        `workspace: ${workspaceDir}`,
        `repo: ${conversation?.repoRemoteUrl || "无"}`,
        `sessionId: ${conversation?.sessionId || "无"}`,
        `memoryFile: ${conversation?.memoryFilePath || "无"}`,
        `pendingInteraction: ${conversation?.pendingInteraction?.question || "无"}`,
        `running: ${runningTask ? `${this.helpers.buildTaskName(runningTask)} (${runningTask.startedAt})` : "无"}`,
        `queued: ${queuedTasks.map((task) => this.helpers.buildTaskName(task)).join(", ") || "无"}`,
        `interrupted: ${interruptedCount}`
      ];

      if (this.bridge.config.feishuInteractiveCardsEnabled) {
        await this.bridge.safeSendCard(target, {
          config: {
            wide_screen_mode: true
          },
          elements: [
            {
              tag: "div",
              text: {
                content: lines.join("\n"),
                tag: "lark_md"
              }
            }
          ],
          header: {
            template: "blue",
            title: {
              content: "当前状态",
              tag: "plain_text"
            }
          }
        });
        return;
      }

      await this.bridge.safeSend(target, lines.join("\n"));
      return;
    }

    if (command === "/retry") {
      const taskReference = rest[0] || "";
      await this.retryInterruptedTask({
        chatId,
        chatKey,
        silentSuccess,
        target,
        taskReference
      });
      return;
    }

    if (command === "/choose") {
      const optionId = rest[0] || "";
      await this.bridge.choosePendingInteraction({
        chatId,
        chatKey,
        optionId,
        silentSuccess,
        target
      });
      return;
    }

    if (command === "/abort") {
      const taskReference = rest[0];
      if (!taskReference) {
        await this.bridge.safeSend(target, "用法：/abort T001 或 /abort T001-任务摘要");
        return;
      }

      const matchedRunningEntries = [...this.bridge.running.entries()].filter(([runtimeKey, task]) =>
        taskReference === runtimeKey ||
        this.helpers.matchesTaskReference(task, taskReference) ||
        String(task?.id || "") === taskReference
      );
      const runningTask =
        matchedRunningEntries.find(([, task]) => task.chatKey === chatKey)?.[1] ||
        matchedRunningEntries[0]?.[1] ||
        null;
      if (runningTask) {
        if (runningTask.chatKey !== chatKey) {
          await this.bridge.safeSend(target, `当前聊天没有运行中的任务 ${taskReference}。`);
          return;
        }

        runningTask.abortRequested = true;
        console.log(`[task:${runningTask.id}] abort requested`);
        runningTask.runner.cancel();
        runningTask.lastErrorMessage = "收到终止请求，正在结束任务。";
        await this.bridge.syncTaskCard(runningTask);
        if (!silentSuccess) {
          await this.bridge.safeSend(
            target,
            `已请求终止任务 ${this.helpers.buildTaskName(runningTask)}。`
          );
        }
        return;
      }

      const queuedTask = this.bridge.runtime.dequeueQueuedTask(
        (task) => task.chatKey === chatKey && this.helpers.matchesTaskReference(task, taskReference)
      );
      if (queuedTask) {
        queuedTask.status = "cancelled";
        queuedTask.lastErrorMessage = "任务在排队阶段被取消。";
        this.bridge.metrics.queuedCancelCount += 1;
        await this.bridge.syncTaskCard(queuedTask);
        await this.bridge.refreshQueuedTaskCards();
        if (!silentSuccess) {
          await this.bridge.safeSend(
            target,
            `已取消排队中的任务 ${this.helpers.buildTaskName(queuedTask)}。`
          );
        }
        return;
      }

      await this.bridge.safeSend(target, `未找到任务 ${taskReference}。`);
      return;
    }

    await this.bridge.safeSend(target, `未知命令：${command}\n\n${this.helpers.helpText()}`);
  }
}
