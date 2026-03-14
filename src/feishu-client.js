import { fetchJsonWithRetry } from "./http-utils.js";

function jsonHeaders(token) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8"
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function buildInteractiveContent(card) {
  return JSON.stringify(card);
}

function createMetrics() {
  return {
    lastErrorAt: "",
    lastErrorMessage: "",
    lastSuccessAt: "",
    messageCreateCount: 0,
    messageUpdateCount: 0,
    requestCount: 0,
    retryCount: 0,
    timeoutCount: 0,
    tokenRefreshCount: 0
  };
}

export class FeishuClient {
  constructor(config, options = {}) {
    this.config = config;
    this.fetchImpl = options.fetchImpl || fetch;
    this.cachedToken = null;
    this.cachedTokenExpiresAt = 0;
    this.metrics = createMetrics();
  }

  trackRetry({ isTimeout }) {
    this.metrics.retryCount += 1;
    if (isTimeout) {
      this.metrics.timeoutCount += 1;
    }
  }

  trackFailure(error) {
    this.metrics.lastErrorAt = new Date().toISOString();
    this.metrics.lastErrorMessage = error.message || String(error);
  }

  trackSuccess() {
    this.metrics.lastSuccessAt = new Date().toISOString();
  }

  async requestJson({ body, headers, label, method, url, validate }) {
    this.metrics.requestCount += 1;
    return fetchJsonWithRetry({
      body,
      fetchImpl: this.fetchImpl,
      headers,
      label,
      method,
      onFailure: ({ error }) => {
        this.trackFailure(error);
      },
      onRetry: ({ isTimeout }) => {
        this.trackRetry({ isTimeout });
      },
      onSuccess: () => {
        this.trackSuccess();
      },
      retries: this.config.feishuRequestRetries,
      retryDelayMs: this.config.feishuRequestRetryDelayMs,
      timeoutMs: this.config.feishuRequestTimeoutMs,
      url,
      validate
    });
  }

  async getTenantAccessToken() {
    const now = Date.now();
    if (this.cachedToken && now < this.cachedTokenExpiresAt) {
      return this.cachedToken;
    }

    const { payload } = await this.requestJson({
      body: {
        app_id: this.config.feishuAppId,
        app_secret: this.config.feishuAppSecret
      },
      headers: jsonHeaders(),
      label: "tenant_access_token",
      method: "POST",
      url: `${this.config.feishuBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
      validate: ({ payload }) => {
        if (payload.code === 0 && payload.tenant_access_token) {
          return null;
        }

        const error = new Error(
          `Failed to fetch tenant_access_token: ${payload.msg || "unknown error"}`
        );
        error.retryable = payload.code === 99991663;
        return error;
      }
    });

    this.cachedToken = payload.tenant_access_token;
    this.cachedTokenExpiresAt = now + Math.max(60, payload.expire - 60) * 1000;
    this.metrics.tokenRefreshCount += 1;
    return this.cachedToken;
  }

  async sendMessage({ chatId, replyToMessageId, text, card }) {
    const token = await this.getTenantAccessToken();
    const data = card
      ? {
          content: buildInteractiveContent(card),
          msg_type: "interactive"
        }
      : {
          content: JSON.stringify({ text }),
          msg_type: "text"
        };
    const url = replyToMessageId
      ? `${this.config.feishuBaseUrl}/open-apis/im/v1/messages/${replyToMessageId}/reply`
      : `${this.config.feishuBaseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`;
    const body = replyToMessageId ? data : { receive_id: chatId, ...data };

    const { payload } = await this.requestJson({
      body,
      headers: jsonHeaders(token),
      label: card ? "send_card" : "send_text",
      method: "POST",
      url,
      validate: ({ payload }) => {
        if (payload.code === 0) {
          return null;
        }

        const error = new Error(
          `Failed to send Feishu message: ${payload.msg || "unknown error"}`
        );
        error.retryable = false;
        return error;
      }
    });

    this.metrics.messageCreateCount += 1;
    return payload;
  }

  async updateCard(messageId, card) {
    const token = await this.getTenantAccessToken();
    const { payload } = await this.requestJson({
      body: {
        content: buildInteractiveContent(card)
      },
      headers: jsonHeaders(token),
      label: "update_card",
      method: "PATCH",
      url: `${this.config.feishuBaseUrl}/open-apis/im/v1/messages/${messageId}`,
      validate: ({ payload }) => {
        if (payload.code === 0) {
          return null;
        }

        const error = new Error(
          `Failed to update Feishu card: ${payload.msg || "unknown error"}`
        );
        error.retryable = false;
        return error;
      }
    });

    this.metrics.messageUpdateCount += 1;
    return payload;
  }

  async sendText(chatId, text, options = {}) {
    return this.sendMessage({
      chatId,
      text,
      replyToMessageId: options.replyToMessageId
    });
  }

  async sendCard(chatId, card, options = {}) {
    return this.sendMessage({
      chatId,
      card,
      replyToMessageId: options.replyToMessageId
    });
  }

  getMetrics() {
    return {
      ...this.metrics
    };
  }
}
