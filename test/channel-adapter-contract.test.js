import test from "node:test";
import assert from "node:assert/strict";
import { assertChannelAdapter } from "../src/core/channel-adapter.js";
import {
  createFeishuChannelAdapter,
  FeishuChannelAdapter
} from "../src/providers/channel/feishu/adapter.js";

test("assertChannelAdapter validates contract", () => {
  const adapter = {
    name: "demo",
    start() {},
    sendText() {},
    sendCard() {},
    updateCard() {},
    getMetrics() {
      return {};
    }
  };

  assert.equal(assertChannelAdapter(adapter), adapter);
  assert.throws(() => assertChannelAdapter({}), /name is required/);
});

test("FeishuChannelAdapter exposes messaging methods and metrics", () => {
  const feishuClient = {
    sendText(chatId, text) {
      return { chatId, text };
    },
    sendCard(chatId, card) {
      return { chatId, card };
    },
    updateCard(messageId, card) {
      return { messageId, card };
    },
    getMetrics() {
      return { requestCount: 1 };
    }
  };
  const wsClient = {
    getReconnectInfo() {
      return { retries: 0 };
    },
    getMetrics() {
      return { dispatchCount: 2 };
    }
  };

  const adapter = new FeishuChannelAdapter(
    { feishuAppId: "x", feishuAppSecret: "y" },
    { feishuClient, wsClient }
  );

  assert.deepEqual(adapter.getMetrics(), {
    feishu: { requestCount: 1 },
    reconnect: { retries: 0 },
    ws: { dispatchCount: 2 }
  });
});

test("createFeishuChannelAdapter returns valid adapter", () => {
  const adapter = createFeishuChannelAdapter(
    { feishuAppId: "x", feishuAppSecret: "y" },
    {
      feishuClient: {
        sendText() {},
        sendCard() {},
        updateCard() {},
        getMetrics() {
          return {};
        }
      },
      wsClient: {
        start() {},
        close() {},
        getReconnectInfo() {
          return {};
        },
        getMetrics() {
          return {};
        }
      }
    }
  );

  assert.equal(adapter.name, "feishu");
});
