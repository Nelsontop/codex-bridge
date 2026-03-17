import { assertCliProvider } from "../../core/cli-provider.js";
import { runGenericCliTask } from "../../generic-cli-runner.js";

export function createClaudeCodeProvider(config, dependencies = {}) {
  const runTaskImpl = dependencies.runGenericCliTask || runGenericCliTask;

  return assertCliProvider({
    name: "claude-code",
    supportsResume: false,
    runTask(taskOptions) {
      return runTaskImpl(config.claudeCodeCommand, {
        ...taskOptions,
        supportsResume: false
      });
    }
  });
}
