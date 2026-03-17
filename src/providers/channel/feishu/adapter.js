import { assertChannelAdapter } from "../../../core/channel-adapter.js";
import { FeishuClient } from "../../../feishu-client.js";
import { FeishuWsClient } from "../../../feishu-ws-client.js";

export class FeishuChannelAdapter {
  constructor(config, options = {}) {
    this.name = "feishu";
    this.config = config;
    this.feishuClient = options.feishuClient || new FeishuClient(config, options);
    this.wsClient = options.wsClient || null;
  }

  attachBridge(bridgeService) {
    if (!this.wsClient) {
      this.wsClient = new FeishuWsClient(this.config, bridgeService);
    }
  }

  async start() {
    if (!this.wsClient) {
      throw new Error("Feishu channel adapter requires attachBridge() before start()");
    }
    await this.wsClient.start();
  }

  close({ force = false } = {}) {
    this.wsClient?.close({ force });
  }

  async sendText(chatId, text, options = {}) {
    return this.feishuClient.sendText(chatId, text, options);
  }

  async sendCard(chatId, card, options = {}) {
    return this.feishuClient.sendCard(chatId, card, options);
  }

  async updateCard(messageId, card) {
    return this.feishuClient.updateCard(messageId, card);
  }

  getMetrics() {
    return {
      feishu: this.feishuClient.getMetrics(),
      reconnect: this.wsClient?.getReconnectInfo?.() || null,
      ws: this.wsClient?.getMetrics?.() || null
    };
  }
}

export function createFeishuChannelAdapter(config, options = {}) {
  return assertChannelAdapter(new FeishuChannelAdapter(config, options));
}
