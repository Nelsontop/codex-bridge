import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceBindingPolicy } from "../src/workspace-policy.js";

function createConfig(overrides = {}) {
  return {
    codexWorkspaceDir: "/srv/workspaces",
    workspaceAllowedRoots: ["/srv/workspaces", "/tmp/sandboxes"],
    ...overrides
  };
}

test("workspace binding policy resolves relative paths inside default workspace root", () => {
  const policy = new WorkspaceBindingPolicy(createConfig());

  const resolved = policy.resolveAuthorizedWorkspace("project-a");

  assert.equal(resolved, "/srv/workspaces/project-a");
});

test("workspace binding policy rejects paths outside allowed roots", () => {
  const policy = new WorkspaceBindingPolicy(createConfig());

  assert.throws(
    () => policy.resolveAuthorizedWorkspace("/etc"),
    /工作目录不在允许范围内/
  );
});

test("workspace binding policy allows absolute paths under configured roots", () => {
  const policy = new WorkspaceBindingPolicy(createConfig());

  const resolved = policy.resolveAuthorizedWorkspace("/tmp/sandboxes/demo");

  assert.equal(resolved, "/tmp/sandboxes/demo");
});
