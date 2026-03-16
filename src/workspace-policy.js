import path from "node:path";

function isWithinRoot(candidate, root) {
  if (candidate === root) {
    return true;
  }
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function resolveWorkspaceDir(config, workspaceInput) {
  const normalized = String(workspaceInput || "").trim();
  if (!normalized) {
    throw new Error("缺少工作目录。用法：/bind <工作目录> [仓库名]");
  }

  if (path.isAbsolute(normalized)) {
    return path.resolve(normalized);
  }
  return path.resolve(config.codexWorkspaceDir, normalized);
}

export function ensureWorkspaceAllowed(config, workspaceDir) {
  const roots = config.workspaceAllowedRoots || [];
  if (roots.length === 0) {
    return workspaceDir;
  }

  const allowed = roots.some((root) => isWithinRoot(workspaceDir, root));
  if (allowed) {
    return workspaceDir;
  }

  throw new Error(
    `工作目录不在允许范围内：${workspaceDir}。允许范围：${roots.join(", ")}`
  );
}

export class WorkspaceBindingPolicy {
  constructor(config) {
    this.config = config;
  }

  resolveAuthorizedWorkspace(workspaceInput) {
    const workspaceDir = resolveWorkspaceDir(this.config, workspaceInput);
    return ensureWorkspaceAllowed(this.config, workspaceDir);
  }
}
