import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { WorkspaceBindingPolicy } from "../../domain/workspace-policy.js";

const TEMPLATE_ROOT_API_URL =
  "https://api.github.com/repos/Nelsontop/workflow-templates/contents/vibe-coding-standard?ref=main";

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

function listVisibleEntries(workspaceDir) {
  return fs.readdirSync(workspaceDir).filter((entry) => entry !== ".git");
}

function isWorkspaceEffectivelyEmpty(workspaceDir) {
  return listVisibleEntries(workspaceDir).length === 0;
}

async function fetchTemplateJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "codex-feishu-bridge"
    }
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`拉取模板目录失败（${response.status}）：${detail || url}`);
  }
  return response.json();
}

async function fetchTemplateText(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "text/plain",
      "User-Agent": "codex-feishu-bridge"
    }
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`下载模板文件失败（${response.status}）：${detail || url}`);
  }
  return response.text();
}

async function downloadTemplateDirectory(fetchImpl, apiUrl, targetDir) {
  const entries = await fetchTemplateJson(fetchImpl, apiUrl);
  if (!Array.isArray(entries)) {
    throw new Error("模板目录响应格式不正确。");
  }

  for (const entry of entries) {
    const entryPath = path.join(targetDir, entry.name);
    if (entry.type === "dir") {
      fs.mkdirSync(entryPath, { recursive: true });
      await downloadTemplateDirectory(fetchImpl, entry.url, entryPath);
      continue;
    }

    if (entry.type === "file") {
      if (!entry.download_url) {
        throw new Error(`模板文件缺少下载地址：${entry.name}`);
      }
      const text = await fetchTemplateText(fetchImpl, entry.download_url);
      fs.mkdirSync(path.dirname(entryPath), { recursive: true });
      fs.writeFileSync(entryPath, text, "utf8");
    }
  }
}

async function applyTemplateIfNeeded(workspaceDir, fetchImpl) {
  if (!isWorkspaceEffectivelyEmpty(workspaceDir)) {
    return { templateApplied: false };
  }

  try {
    await downloadTemplateDirectory(fetchImpl, TEMPLATE_ROOT_API_URL, workspaceDir);
  } catch (error) {
    throw new Error(`初始化模板失败：${error.message || String(error)}`);
  }

  return { templateApplied: true };
}

async function ensureGitRepository(workspaceDir, repoName, runCommand) {
  const repoCheck = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], workspaceDir);
  let gitInitialized = false;

  if (repoCheck.code !== 0 || repoCheck.stdout !== "true") {
    let init = await runCommand("git", ["init", "-b", "main"], workspaceDir);
    if (init.code !== 0) {
      init = await runCommand("git", ["init"], workspaceDir);
    }
    if (init.code !== 0) {
      throw new Error(init.stderr || init.stdout || "git init 失败");
    }
    gitInitialized = true;
  }

  let branch = await runCommand("git", ["branch", "--show-current"], workspaceDir);
  if (branch.code === 0 && branch.stdout && branch.stdout !== "main") {
    const rename = await runCommand("git", ["branch", "-M", "main"], workspaceDir);
    if (rename.code !== 0) {
      throw new Error(rename.stderr || rename.stdout || "git branch -M main 失败");
    }
    branch = { code: 0, stdout: "main", stderr: "" };
  }

  const headCheck = await runCommand("git", ["rev-parse", "--verify", "HEAD"], workspaceDir);
  let initialCommitCreated = false;
  let readmeCreated = false;

  if (headCheck.code !== 0) {
    const visibleEntries = listVisibleEntries(workspaceDir);
    const readmePath = path.join(workspaceDir, "README.md");

    if (visibleEntries.length === 0 && !fs.existsSync(readmePath)) {
      fs.writeFileSync(readmePath, `# ${repoName}\n`, "utf8");
      readmeCreated = true;
    }

    const add = await runCommand("git", ["add", "-A"], workspaceDir);
    if (add.code !== 0) {
      throw new Error(add.stderr || add.stdout || "git add -A 失败");
    }

    const cached = await runCommand("git", ["diff", "--cached", "--quiet"], workspaceDir);
    if (cached.code === 0 && !fs.existsSync(readmePath)) {
      fs.writeFileSync(readmePath, `# ${repoName}\n`, "utf8");
      readmeCreated = true;

      const addReadme = await runCommand("git", ["add", "README.md"], workspaceDir);
      if (addReadme.code !== 0) {
        throw new Error(addReadme.stderr || addReadme.stdout || "git add README.md 失败");
      }
    }

    const commit = await runCommand("git", ["commit", "-m", "chore: initial commit"], workspaceDir);
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

async function getOriginRemoteUrl(workspaceDir, runCommand) {
  const remote = await runCommand("git", ["remote", "get-url", "origin"], workspaceDir);
  if (remote.code !== 0 || !remote.stdout) {
    return "";
  }
  return remote.stdout;
}

async function createGitHubRepo(config, workspaceDir, repoName, runCommand) {
  const existingRemoteUrl = await getOriginRemoteUrl(workspaceDir, runCommand);
  if (existingRemoteUrl) {
    return {
      remoteStatus: "existing",
      remoteUrl: existingRemoteUrl
    };
  }

  const authStatus = await runCommand("gh", ["auth", "status"], workspaceDir).catch((error) => ({
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
  const create = await runCommand(
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
    remoteUrl: await getOriginRemoteUrl(workspaceDir, runCommand)
  };
}

export async function prepareWorkspaceBinding(
  config,
  { repoName, workspaceInput },
  dependencies = {}
) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch?.bind(globalThis);
  const runCommand = dependencies.runCommand || run;
  const workspaceDir = new WorkspaceBindingPolicy(config).resolveAuthorizedWorkspace(
    workspaceInput
  );
  const resolvedRepoName = resolveRepoName(workspaceDir, repoName);

  ensureWorkspaceDirectory(workspaceDir);
  let template = { templateApplied: false };
  if (!fetchImpl) {
    throw new Error("当前 Node 环境不支持 fetch，无法在线拉取项目模板。");
  }
  template = await applyTemplateIfNeeded(workspaceDir, fetchImpl);
  const local = await ensureGitRepository(workspaceDir, resolvedRepoName, runCommand);
  const remote = await createGitHubRepo(config, workspaceDir, resolvedRepoName, runCommand);

  return {
    ...template,
    ...local,
    ...remote,
    repoName: resolvedRepoName,
    workspaceDir
  };
}
