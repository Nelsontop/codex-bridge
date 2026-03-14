function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(status);
}

function normalizeBody(body) {
  if (body === undefined || body === null) {
    return undefined;
  }
  return typeof body === "string" ? body : JSON.stringify(body);
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    const parseError = new Error("Failed to parse JSON response");
    parseError.cause = error;
    parseError.retryable = false;
    throw parseError;
  }
}

export async function fetchJsonWithRetry({
  body,
  fetchImpl = fetch,
  headers,
  label = "request",
  method = "GET",
  onFailure,
  onRetry,
  onSuccess,
  timeoutMs = 10000,
  retries = 2,
  retryDelayMs = 300,
  url,
  validate
}) {
  let attempt = 0;

  while (attempt <= retries) {
    attempt += 1;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        body: normalizeBody(body),
        signal: controller.signal
      });
      const payload = await parseJsonResponse(response);
      const validationError = validate?.({ payload, response }) || null;

      if (!response.ok || validationError) {
        const error = validationError || new Error(payload?.msg || response.statusText);
        error.status = response.status;
        error.payload = payload;
        error.retryable =
          error.retryable !== undefined
            ? error.retryable
            : isRetryableStatus(response.status);
        throw error;
      }

      onSuccess?.({ attempt, payload, response });
      return {
        attempt,
        payload,
        response
      };
    } catch (error) {
      const isTimeout = error.name === "AbortError";
      if (isTimeout) {
        error.retryable = true;
      }

      const shouldRetry =
        attempt <= retries &&
        (error.retryable === true || (error.status && isRetryableStatus(error.status)));

      if (shouldRetry) {
        onRetry?.({ attempt, error, isTimeout, label });
        await sleep(retryDelayMs * attempt);
        continue;
      }

      onFailure?.({ attempt, error, isTimeout, label });
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error(`Failed to complete ${label}`);
}
