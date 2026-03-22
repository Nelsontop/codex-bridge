import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { prepareWorkspaceBinding } from "../src/infrastructure/workspace/workspace-binding.js";

const TEST_TMP_DIR = path.join(process.cwd(), ".tmp-test");

function makeTempDir(prefix) {
  fs.mkdirSync(TEST_TMP_DIR, { recursive: true });
  return fs.mkdtempSync(path.join(TEST_TMP_DIR, prefix));
}

function createConfig(rootDir) {
  return {
    codexWorkspaceDir: rootDir,
    githubRepoOwner: "",
    workspaceAllowedRoots: [rootDir]
  };
}

function createResponse(body, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    }
  };
}

function createRunStub() {
  let gitInitialized = false;
  let hasCommit = false;
  let remoteUrl = "";
  const addedFiles = new Set();

  return async function runCommand(command, args, cwd) {
    if (command === "git") {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return {
          code: gitInitialized ? 0 : 1,
          stdout: gitInitialized ? "true" : "",
          stderr: ""
        };
      }
      if (args[0] === "init") {
        gitInitialized = true;
        return { code: 0, stdout: "initialized", stderr: "" };
      }
      if (args[0] === "branch" && args[1] === "--show-current") {
        return { code: 0, stdout: "main", stderr: "" };
      }
      if (args[0] === "branch" && args[1] === "-M") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        return { code: hasCommit ? 0 : 1, stdout: hasCommit ? "HEAD" : "", stderr: "" };
      }
      if (args[0] === "add") {
        if (args[1] === "-A") {
          for (const entry of fs.readdirSync(cwd)) {
            if (entry !== ".git") {
              addedFiles.add(entry);
            }
          }
        } else if (args[1]) {
          addedFiles.add(args[1]);
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
        return { code: addedFiles.size === 0 ? 0 : 1, stdout: "", stderr: "" };
      }
      if (args[0] === "commit") {
        hasCommit = true;
        return { code: 0, stdout: "committed", stderr: "" };
      }
      if (args[0] === "remote" && args[1] === "get-url") {
        return {
          code: remoteUrl ? 0 : 1,
          stdout: remoteUrl,
          stderr: remoteUrl ? "" : "missing"
        };
      }
    }

    if (command === "gh") {
      if (args[0] === "auth" && args[1] === "status") {
        return { code: 1, stdout: "", stderr: "not logged in" };
      }
    }

    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };
}

test("prepareWorkspaceBinding populates vibe template for empty directories", async () => {
  const rootDir = makeTempDir("workspace-binding-root-");
  const workspaceDir = path.join(rootDir, "project-a");
  const config = createConfig(rootDir);
  const fetchedUrls = [];

  const fetchImpl = async (url) => {
    fetchedUrls.push(url);
    if (url.endsWith("/contents/vibe-coding-standard?ref=main")) {
      return createResponse([
        { name: "AGENTS.md", type: "file", download_url: "https://example.test/AGENTS.md" },
        { name: "reference", type: "dir", url: "https://api.example.test/reference" }
      ]);
    }
    if (url === "https://api.example.test/reference") {
      return createResponse([
        { name: "theme.ts", type: "file", download_url: "https://example.test/reference/theme.ts" }
      ]);
    }
    if (url === "https://example.test/AGENTS.md") {
      return createResponse("# Template\n");
    }
    if (url === "https://example.test/reference/theme.ts") {
      return createResponse("export const theme = {};\n");
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const result = await prepareWorkspaceBinding(
    config,
    { workspaceInput: workspaceDir, repoName: "project-a" },
    { fetchImpl, runCommand: createRunStub() }
  );

  assert.equal(result.gitInitialized, true);
  assert.equal(result.initialCommitCreated, true);
  assert.equal(result.templateApplied, true);
  assert.equal(result.remoteStatus, "failed");
  assert.equal(fs.readFileSync(path.join(workspaceDir, "AGENTS.md"), "utf8"), "# Template\n");
  assert.equal(
    fs.readFileSync(path.join(workspaceDir, "reference", "theme.ts"), "utf8"),
    "export const theme = {};\n"
  );
  assert.equal(
    fetchedUrls.includes("https://api.github.com/repos/Nelsontop/workflow-templates/contents/vibe-coding-standard?ref=main"),
    true
  );
});

test("prepareWorkspaceBinding skips template download for non-empty directories", async () => {
  const rootDir = makeTempDir("workspace-binding-root-");
  const workspaceDir = path.join(rootDir, "project-b");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "notes.txt"), "keep me\n", "utf8");

  let fetchCount = 0;
  const result = await prepareWorkspaceBinding(
    createConfig(rootDir),
    { workspaceInput: workspaceDir, repoName: "project-b" },
    {
      fetchImpl: async () => {
        fetchCount += 1;
        throw new Error("should not fetch template");
      },
      runCommand: createRunStub()
    }
  );

  assert.equal(result.templateApplied, false);
  assert.equal(fetchCount, 0);
  assert.equal(fs.readFileSync(path.join(workspaceDir, "notes.txt"), "utf8"), "keep me\n");
});

test("prepareWorkspaceBinding surfaces template download failures for empty directories", async () => {
  const rootDir = makeTempDir("workspace-binding-root-");
  const workspaceDir = path.join(rootDir, "project-c");

  await assert.rejects(
    prepareWorkspaceBinding(
      createConfig(rootDir),
      { workspaceInput: workspaceDir, repoName: "project-c" },
      {
        fetchImpl: async () => createResponse({ message: "boom" }, false, 500),
        runCommand: createRunStub()
      }
    ),
    /模板/
  );
});
