import test from "node:test";
import assert from "node:assert/strict";
import { FeishuClient } from "../src/feishu-client.js";

function createConfig(overrides = {}) {
  return {
    feishuAppId: "cli_test",
    feishuAppSecret: "secret",
    feishuBaseUrl: "https://open.feishu.test",
    feishuRequestRetries: 1,
    feishuRequestRetryDelayMs: 0,
    feishuRequestTimeoutMs: 1000,
    ...overrides
  };
}

test("FeishuClient retries transient message send failures and updates cards", async () => {
  const calls = [];
  let messageAttempts = 0;

  const fetchImpl = async (url, options) => {
    calls.push({ options, url });

    if (url.endsWith("/tenant_access_token/internal")) {
      return new Response(
        JSON.stringify({
          code: 0,
          expire: 7200,
          tenant_access_token: "tenant_token"
        }),
        { status: 200 }
      );
    }

    if (url.includes("/open-apis/im/v1/messages?receive_id_type=chat_id")) {
      messageAttempts += 1;
      if (messageAttempts === 1) {
        return new Response(JSON.stringify({ code: 99991400, msg: "busy" }), {
          status: 503
        });
      }

      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            message_id: "om_created"
          }
        }),
        { status: 200 }
      );
    }

    if (url.endsWith("/open-apis/im/v1/messages/om_created")) {
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        status: 200
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  const client = new FeishuClient(createConfig(), { fetchImpl });
  const sendPayload = await client.sendText("chat_1", "hello");
  await client.updateCard("om_created", {
    config: {
      update_multi: true
    }
  });

  assert.equal(sendPayload.data.message_id, "om_created");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[2].options.method, "POST");
  assert.equal(calls[3].options.method, "PATCH");

  const metrics = client.getMetrics();
  assert.equal(metrics.messageCreateCount, 1);
  assert.equal(metrics.messageUpdateCount, 1);
  assert.equal(metrics.retryCount, 1);
  assert.equal(metrics.tokenRefreshCount, 1);
});
