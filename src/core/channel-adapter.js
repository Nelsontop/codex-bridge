function methodError(name, method) {
  return `Invalid channel adapter '${name}': ${method}() is required`;
}

export function assertChannelAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("Invalid channel adapter: adapter must be an object");
  }

  const name = String(adapter.name || "").trim();
  if (!name) {
    throw new Error("Invalid channel adapter: name is required");
  }

  if (typeof adapter.start !== "function") {
    throw new Error(methodError(name, "start"));
  }
  if (typeof adapter.sendText !== "function") {
    throw new Error(methodError(name, "sendText"));
  }
  if (typeof adapter.sendCard !== "function") {
    throw new Error(methodError(name, "sendCard"));
  }
  if (typeof adapter.updateCard !== "function") {
    throw new Error(methodError(name, "updateCard"));
  }
  if (typeof adapter.getMetrics !== "function") {
    throw new Error(methodError(name, "getMetrics"));
  }

  return adapter;
}
