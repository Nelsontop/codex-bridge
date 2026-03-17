import { createCliProviderRegistry } from "./cli-provider.js";

export class TaskOrchestrator {
  constructor({ providerRegistry, resolveProviderName } = {}) {
    this.providerRegistry = providerRegistry || createCliProviderRegistry();
    this.resolveProviderName =
      resolveProviderName ||
      (() => "codex");
  }

  resolveProvider(chatKey = "", explicitProviderName = "") {
    const providerName = (explicitProviderName || this.resolveProviderName(chatKey) || "").trim();
    const provider = this.providerRegistry.resolveForChat(providerName, chatKey);
    if (!provider) {
      throw new Error(`CLI provider not found: ${providerName || "(empty)"}`);
    }
    return provider;
  }

  runTask({ chatKey = "", providerName = "", taskOptions }) {
    const provider = this.resolveProvider(chatKey, providerName);
    return provider.runTask(taskOptions || {});
  }
}
