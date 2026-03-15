import { spawn } from "node:child_process";
import readline from "node:readline";

function buildPrompt(prelude, userText) {
  return `${prelude.trim()}\n\n用户消息：\n${userText.trim()}`;
}

function buildArgs(config, prompt, sessionId, workspaceDir) {
  const args = [];
  const bypassSandbox = config.codexCommand.includes(
    "--dangerously-bypass-approvals-and-sandbox"
  );

  if (workspaceDir) {
    args.push("-C", workspaceDir);
  }
  if (config.codexApprovalPolicy && !bypassSandbox) {
    args.push("-a", config.codexApprovalPolicy);
  }
  if (config.codexSandbox && !bypassSandbox) {
    args.push("-s", config.codexSandbox);
  }
  if (config.codexModel) {
    args.push("-m", config.codexModel);
  }
  if (config.codexProfile) {
    args.push("-p", config.codexProfile);
  }
  if (config.codexAdditionalArgs.length > 0) {
    args.push(...config.codexAdditionalArgs);
  }

  args.push("exec");

  if (sessionId) {
    args.push("resume", "--json");
    if (config.codexSkipGitRepoCheck) {
      args.push("--skip-git-repo-check");
    }
    args.push(sessionId, prompt);
    return args;
  }

  args.push("--json");
  if (config.codexSkipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }
  args.push(prompt);
  return args;
}

export function runCodexTask(config, { prompt, sessionId, onEvent, workspaceDir }) {
  const fullPrompt = buildPrompt(config.codexPrelude, prompt);
  const resolvedWorkspaceDir = workspaceDir || config.codexWorkspaceDir;
  const args = buildArgs(config, fullPrompt, sessionId, resolvedWorkspaceDir);
  const [command, ...commandArgs] = config.codexCommand;
  const child = spawn(command, [...commandArgs, ...args], {
    cwd: resolvedWorkspaceDir,
    detached: process.platform !== "win32",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let resolved = false;
  let latestSessionId = sessionId || null;
  let lastAgentMessage = "";
  let stderr = "";
  let escalationTimer = null;
  let killTimer = null;

  function clearCancelTimers() {
    if (escalationTimer) {
      clearTimeout(escalationTimer);
      escalationTimer = null;
    }
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
  }

  function signalChild(signal) {
    if (resolved || !child.pid) {
      return;
    }

    try {
      if (process.platform !== "win32") {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }

  const stdoutReader = readline.createInterface({ input: child.stdout });
  stdoutReader.on("line", (line) => {
    if (!line.trim()) {
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      stderr += `${line}\n`;
      return;
    }

    if (parsed.type === "thread.started" && parsed.thread_id) {
      latestSessionId = parsed.thread_id;
    }
    if (
      parsed.type === "item.completed" &&
      parsed.item?.type === "agent_message" &&
      typeof parsed.item.text === "string"
    ) {
      lastAgentMessage = parsed.item.text;
    }

    onEvent?.(parsed);
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const result = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      clearCancelTimers();
      reject(error);
    });
    child.once("close", (code) => {
      resolved = true;
      clearCancelTimers();
      if (code === 0) {
        resolve({
          sessionId: latestSessionId,
          finalMessage: lastAgentMessage.trim() || "Codex completed without a final message.",
          stderr: stderr.trim()
        });
        return;
      }

      const detail = lastAgentMessage || stderr.trim() || `codex exited with code ${code}`;
      reject(new Error(detail));
    });
  });

  return {
    child,
    result,
    cancel() {
      if (!resolved) {
        signalChild("SIGINT");
        escalationTimer = setTimeout(() => {
          signalChild("SIGTERM");
        }, 1500);
        killTimer = setTimeout(() => {
          signalChild("SIGKILL");
        }, 5000);
      }
    }
  };
}
