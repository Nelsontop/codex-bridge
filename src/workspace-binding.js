import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { WorkspaceBindingPolicy } from "./workspace-policy.js";

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
}

function normalizeRepoName(rawValue) {
  return String(rawValue || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolveRepoName(workspaceDir, repoName) {
  const explicitName = String(repoName || "").trim();
  if (explicitName) {
    if (!/^[A-Za-z0-9._-]+$/.test(explicitName)) {
      throw new Error("仓库名只能包含字母、数字、点、下划线和中划线。");
    }
    return explicitName;
  }

  const fallback = normalizeRepoName(path.basename(workspaceDir));
  if (!fallback) {
    throw new Error("无法从工作目录推导仓库名，请显式提供 `/bind <目录> <仓库名>`。");
  }
  return fallback;
}

function ensureWorkspaceDirectory(workspaceDir) {
  if (fs.existsSync(workspaceDir)) {
    const stat = fs.statSync(workspaceDir);
    if (!stat.isDirectory()) {
      throw new Error(`目标路径不是目录：${workspaceDir}`);
    }
    return;
  }

  fs.mkdirSync(workspaceDir, { recursive: true });
}

async function ensureGitRepository(workspaceDir, repoName) {
  const repoCheck = await run("git", ["rev-parse", "--is-inside-work-tree"], workspaceDir);
  let gitInitialized = false;

  if (repoCheck.code !== 0 || repoCheck.stdout !== "true") {
    let init = await run("git", ["init", "-b", "main"], workspaceDir);
    if (init.code !== 0) {
      init = await run("git", ["init"], workspaceDir);
    }
    if (init.code !== 0) {
      throw new Error(init.stderr || init.stdout || "git init 失败");
    }
    gitInitialized = true;
  }

  let branch = await run("git", ["branch", "--show-current"], workspaceDir);
  if (branch.code === 0 && branch.stdout && branch.stdout !== "main") {
    const rename = await run("git", ["branch", "-M", "main"], workspaceDir);
    if (rename.code !== 0) {
      throw new Error(rename.stderr || rename.stdout || "git branch -M main 失败");
    }
    branch = { code: 0, stdout: "main", stderr: "" };
  }

  const headCheck = await run("git", ["rev-parse", "--verify", "HEAD"], workspaceDir);
  let initialCommitCreated = false;
  let readmeCreated = false;

  if (headCheck.code !== 0) {
    const visibleEntries = fs
      .readdirSync(workspaceDir)
      .filter((entry) => entry !== ".git");
    const readmePath = path.join(workspaceDir, "README.md");

    if (visibleEntries.length === 0 && !fs.existsSync(readmePath)) {
      fs.writeFileSync(readmePath, `# ${repoName}\n`, "utf8");
      readmeCreated = true;
    }

    const add = await run("git", ["add", "-A"], workspaceDir);
    if (add.code !== 0) {
      throw new Error(add.stderr || add.stdout || "git add -A 失败");
    }

    const cached = await run("git", ["diff", "--cached", "--quiet"], workspaceDir);
    if (cached.code === 0 && !fs.existsSync(readmePath)) {
      fs.writeFileSync(readmePath, `# ${repoName}\n`, "utf8");
      readmeCreated = true;

      const addReadme = await run("git", ["add", "README.md"], workspaceDir);
      if (addReadme.code !== 0) {
        throw new Error(addReadme.stderr || addReadme.stdout || "git add README.md 失败");
      }
    }

    const commit = await run("git", ["commit", "-m", "chore: initial commit"], workspaceDir);
    if (commit.code !== 0) {
      throw new Error(
        commit.stderr ||
          commit.stdout ||
          "git commit 失败，请先配置全局或本地的 user.name / user.email"
      );
    }
    initialCommitCreated = true;
  }

  return {
    gitInitialized,
    initialCommitCreated,
    readmeCreated
  };
}

async function getOriginRemoteUrl(workspaceDir) {
  const remote = await run("git", ["remote", "get-url", "origin"], workspaceDir);
  if (remote.code !== 0 || !remote.stdout) {
    return "";
  }
  return remote.stdout;
}

async function createGitHubRepo(config, workspaceDir, repoName) {
  const existingRemoteUrl = await getOriginRemoteUrl(workspaceDir);
  if (existingRemoteUrl) {
    return {
      remoteStatus: "existing",
      remoteUrl: existingRemoteUrl
    };
  }

  const authStatus = await run("gh", ["auth", "status"], workspaceDir).catch((error) => ({
    code: 1,
    stderr: error.message || String(error),
    stdout: ""
  }));
  if (authStatus.code !== 0) {
    return {
      remoteStatus: "failed",
      remoteError: "gh CLI 未登录，请先执行 `gh auth login`。"
    };
  }

  const repoTarget = config.githubRepoOwner
    ? `${config.githubRepoOwner}/${repoName}`
    : repoName;
  const create = await run(
    "gh",
    ["repo", "create", repoTarget, "--public", "--source", workspaceDir, "--remote", "origin", "--push"],
    workspaceDir
  ).catch((error) => ({
    code: 1,
    stderr: error.message || String(error),
    stdout: ""
  }));

  if (create.code !== 0) {
    return {
      remoteStatus: "failed",
      remoteError: create.stderr || create.stdout || "gh repo create 失败"
    };
  }

  return {
    remoteStatus: "created",
    remoteUrl: await getOriginRemoteUrl(workspaceDir)
  };
}

export async function prepareWorkspaceBinding(config, { repoName, workspaceInput }) {
  const workspaceDir = new WorkspaceBindingPolicy(config).resolveAuthorizedWorkspace(
    workspaceInput
  );
  const resolvedRepoName = resolveRepoName(workspaceDir, repoName);

  ensureWorkspaceDirectory(workspaceDir);
  const local = await ensureGitRepository(workspaceDir, resolvedRepoName);
  const remote = await createGitHubRepo(config, workspaceDir, resolvedRepoName);

  return {
    ...local,
    ...remote,
    repoName: resolvedRepoName,
    workspaceDir
  };
}
