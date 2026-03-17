import { spawn } from "node:child_process";

export function runGenericCliTask(commandParts, {
  prompt,
  sessionId,
  workspaceDir,
  supportsResume = false
} = {}) {
  if (!Array.isArray(commandParts) || commandParts.length === 0) {
    throw new Error("Generic CLI command is empty");
  }

  const [command, ...baseArgs] = commandParts;
  const args = [...baseArgs];
  if (supportsResume && sessionId) {
    args.push("resume", sessionId);
  }
  args.push(String(prompt || ""));

  const child = spawn(command, args, {
    cwd: workspaceDir || process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  let resolved = false;

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const result = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      reject(error);
    });
    child.once("close", (code) => {
      resolved = true;
      if (code === 0) {
        resolve({
          sessionId: supportsResume ? sessionId || "" : "",
          finalMessage: stdout.trim() || stderr.trim() || "Task completed.",
          stderr: stderr.trim()
        });
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `command exited with code ${code}`));
    });
  });

  return {
    cancel() {
      if (resolved) {
        return;
      }
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!resolved) {
          child.kill("SIGKILL");
        }
      }, 2000);
    },
    result
  };
}
