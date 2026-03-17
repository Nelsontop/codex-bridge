import test from "node:test";
import assert from "node:assert/strict";
import { assertCliProvider, createCliProviderRegistry } from "../src/core/cli-provider.js";

test("assertCliProvider validates provider contract", () => {
  const provider = {
    name: "codex",
    runTask() {
      return { cancel() {}, result: Promise.resolve({}) };
    },
    supportsResume: true
  };

  assert.equal(assertCliProvider(provider), provider);
  assert.throws(() => assertCliProvider({}), /name is required/);
  assert.throws(
    () => assertCliProvider({ name: "x", supportsResume: true }),
    /runTask\(\) is required/
  );
  assert.throws(
    () => assertCliProvider({ name: "x", runTask() {} }),
    /supportsResume must be boolean/
  );
});

test("createCliProviderRegistry registers and resolves providers", () => {
  const registry = createCliProviderRegistry();
  const provider = {
    name: "codex",
    runTask() {
      return { cancel() {}, result: Promise.resolve({}) };
    },
    supportsResume: true
  };

  registry.register(provider);
  assert.equal(registry.get("codex"), provider);
  assert.deepEqual(registry.list(), ["codex"]);
  assert.equal(registry.resolveForChat("codex", "group:chat-1"), provider);
});
