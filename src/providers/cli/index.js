import { createCliProviderRegistry } from "../../core/cli-provider.js";
import { createClaudeCodeProvider } from "./claude-code-provider.js";
import { createCodexProvider } from "./codex-provider.js";
import { createKimiCliProvider } from "./kimi-cli-provider.js";
import { createOpencodeProvider } from "./opencode-provider.js";

export const SUPPORTED_CLI_PROVIDERS = [
  "codex",
  "claude-code",
  "opencode",
  "kimi-cli"
];

export function registerBuiltinCliProviders(registry, config, dependencies = {}) {
  registry.register(
    createCodexProvider(config, {
      runCodexTask: dependencies.runCodexTask
    })
  );
  registry.register(
    createClaudeCodeProvider(config, {
      runGenericCliTask: dependencies.runGenericCliTask
    })
  );
  registry.register(createOpencodeProvider());
  registry.register(createKimiCliProvider());
  return registry;
}

export function createBuiltinCliProviderRegistry(config, dependencies = {}) {
  const registry = createCliProviderRegistry();
  return registerBuiltinCliProviders(registry, config, dependencies);
}
