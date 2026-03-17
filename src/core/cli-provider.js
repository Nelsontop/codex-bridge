function normalizeName(value) {
  return String(value || "").trim();
}

export function assertCliProvider(provider) {
  if (!provider || typeof provider !== "object") {
    throw new Error("Invalid CLI provider: provider must be an object");
  }

  const name = normalizeName(provider.name);
  if (!name) {
    throw new Error("Invalid CLI provider: name is required");
  }

  if (typeof provider.runTask !== "function") {
    throw new Error(`Invalid CLI provider '${name}': runTask() is required`);
  }

  if (typeof provider.supportsResume !== "boolean") {
    throw new Error(`Invalid CLI provider '${name}': supportsResume must be boolean`);
  }

  return provider;
}

export function createCliProviderRegistry(providers = []) {
  const byName = new Map();
  for (const provider of providers) {
    const validated = assertCliProvider(provider);
    byName.set(validated.name, validated);
  }

  return {
    get(name) {
      const normalized = normalizeName(name);
      return byName.get(normalized) || null;
    },
    list() {
      return [...byName.keys()];
    },
    register(provider) {
      const validated = assertCliProvider(provider);
      byName.set(validated.name, validated);
      return validated;
    },
    resolveForChat(name, _chatKey = "") {
      return this.get(name);
    }
  };
}
