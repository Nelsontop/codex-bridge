import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runCodexTask } from "../src/codex-runner.js";

async function waitFor(check, timeoutMs = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("Timed out while waiting for condition");
}

test("runCodexTask cancel terminates the whole process group", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-runner-"));
  const parentScript = path.join(tempDir, "parent.mjs");
  const childScript = path.join(tempDir, "child.mjs");
  const childPidFile = path.join(tempDir, "child.pid");
  const heartbeatFile = path.join(tempDir, "heartbeat.txt");

  fs.writeFileSync(
    childScript,
    [
      "import fs from \"node:fs\";",
      "const heartbeatFile = process.env.TEST_HEARTBEAT_FILE;",
      "fs.writeFileSync(heartbeatFile, String(Date.now()));",
      "setInterval(() => {",
      "  fs.writeFileSync(heartbeatFile, String(Date.now()));",
      "}, 100);"
    ].join("\n"),
    "utf8"
  );

  fs.writeFileSync(
    parentScript,
    [
      "import { spawn } from \"node:child_process\";",
      "import fs from \"node:fs\";",
      "const child = spawn(process.execPath, [process.env.TEST_CHILD_SCRIPT], {",
      "  stdio: \"ignore\"",
      "});",
      "fs.writeFileSync(process.env.TEST_CHILD_PID_FILE, String(child.pid));",
      "console.log(JSON.stringify({ type: \"thread.started\", thread_id: \"thread_test\" }));",
      "setInterval(() => {}, 1000);"
    ].join("\n"),
    "utf8"
  );

  const originalEnv = {
    TEST_CHILD_PID_FILE: process.env.TEST_CHILD_PID_FILE,
    TEST_CHILD_SCRIPT: process.env.TEST_CHILD_SCRIPT,
    TEST_HEARTBEAT_FILE: process.env.TEST_HEARTBEAT_FILE
  };
  process.env.TEST_CHILD_PID_FILE = childPidFile;
  process.env.TEST_CHILD_SCRIPT = childScript;
  process.env.TEST_HEARTBEAT_FILE = heartbeatFile;

  const runner = runCodexTask(
    {
      codexAdditionalArgs: [],
      codexApprovalPolicy: "",
      codexCommand: [process.execPath, parentScript],
      codexModel: "",
      codexPrelude: "",
      codexProfile: "",
      codexSandbox: "",
      codexSkipGitRepoCheck: false,
      codexWorkspaceDir: tempDir
    },
    {
      prompt: "cancel me",
      sessionId: null,
      workspaceDir: tempDir
    }
  );

  let childPid = 0;
  try {
    await waitFor(() => fs.existsSync(childPidFile) && fs.existsSync(heartbeatFile));
    childPid = Number(fs.readFileSync(childPidFile, "utf8"));
    assert.equal(Number.isFinite(childPid) && childPid > 0, true);

    runner.cancel();
    await assert.rejects(runner.result);

    await waitFor(() => {
      try {
        process.kill(childPid, 0);
        return false;
      } catch (error) {
        return error.code === "ESRCH";
      }
    });
  } finally {
    runner.cancel();
    if (childPid > 0) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") {
          throw error;
        }
      }
    }

    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
