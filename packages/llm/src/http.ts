import { errorFromPayload, errorFromResponse, extractRequestId, LlmError } from "./errors.ts";
import { parseSse, type SseEvent } from "./sse.ts";

/** Maximum silence while waiting for response headers or the next SSE byte chunk before resetting the connection. */
export const DEFAULT_SSE_IDLE_TIMEOUT_MS = 90_000;

const MAX_NON_SSE_SAMPLE_BYTES = 4_096;

const freshConnectionSignals = new WeakSet<AbortSignal>();

/** Marks requests tied to `signal` to request `Connection: close` rather than reusing stale keep-alive sockets. */
export function markFreshConnectionSignal(signal: AbortSignal): void {
  freshConnectionSignals.add(signal);
}

function hasHeaderCaseInsensitive(headers: Record<string, string>, target: string): boolean {
  const lower = target.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function isJsonErrorEnvelope(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (obj.error !== undefined && obj.error !== null) return true;
  if (obj.status === false || obj.success === false || obj.ok === false) return true;
  if (typeof obj.code === "number" && obj.code >= 400) return true;
  const hasCompletionPayload =
    "choices" in obj || "candidates" in obj || "content" in obj || "output" in obj || "type" in obj;
  if (!hasCompletionPayload) {
    if (
      typeof obj.message === "string"
      || typeof obj.msg === "string"
      || typeof obj.detail === "string"
      || Array.isArray(obj.detail)
      || (Array.isArray(obj.errors) && obj.errors.length > 0)
    ) {
      return true;
    }
  }
  return false;
}

function hasNonCommentBody(text: string): boolean {
  return text
    .split(/\r?\n/)
    .some((line) => {
      const trimmed = line.trim();
      return trimmed !== "" && !trimmed.startsWith(":");
    });
}

async function* withIdleTimeout(
  body: AsyncIterable<Uint8Array>,
  idleTimeoutMs: number,
  onIdleTimeout: () => void,
): AsyncGenerator<Uint8Array> {
  if (idleTimeoutMs <= 0 || !Number.isFinite(idleTimeoutMs)) {
    yield* body;
    return;
  }
  const iterator = body[Symbol.asyncIterator]();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const next = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              onIdleTimeout();
              reject(new Error(`SSE stream timed out after ${Math.round(idleTimeoutMs / 1000)}s of inactivity`));
            }, idleTimeoutMs);
          }),
        ]);
        if (next.done) return;
        yield next.value;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  } finally {
    await iterator.return?.().catch(() => undefined);
  }
}

/** POST JSON and stream the SSE answer; a non-2xx status or non-SSE error payload throws a classified LlmError. */
export async function* postSse(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  provider: string,
  idleTimeoutMs = DEFAULT_SSE_IDLE_TIMEOUT_MS,
): AsyncGenerator<SseEvent> {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", onParentAbort, { once: true });

  let headersTimer: ReturnType<typeof setTimeout> | undefined;
  if (idleTimeoutMs > 0 && Number.isFinite(idleTimeoutMs)) {
    headersTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, idleTimeoutMs);
  }

  try {
    let response: Response;
    try {
      const requestHeaders: Record<string, string> = {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...headers,
      };
      if (freshConnectionSignals.has(signal) && !hasHeaderCaseInsensitive(headers, "connection")) {
        requestHeaders.connection = "close";
      }
      response = await fetch(url, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut && !signal.aborted) {
        throw new LlmError({
          kind: "network",
          provider,
          message: `${provider} timed out after ${Math.round(idleTimeoutMs / 1000)}s waiting for response`,
          retryable: true,
        });
      }
      throw error;
    } finally {
      if (headersTimer !== undefined) clearTimeout(headersTimer);
    }

    if (!response.ok) throw await errorFromResponse(response, provider);
    const requestId = extractRequestId(response.headers);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

    // Many relays/gateways return HTTP 200 with JSON or HTML error bodies instead of SSE.
    if (contentType.includes("text/html")) {
      const text = await response.text().catch(() => "");
      throw errorFromPayload(provider, text, { status: response.status, statusText: response.statusText, requestId, prefixHttp: true });
    }
    if (contentType.includes("json") && !contentType.includes("text/event-stream")) {
      const text = await response.text().catch(() => "");
      if (text.trim() === "") return;
      try {
        const parsed: unknown = JSON.parse(text);
        if (isJsonErrorEnvelope(parsed)) {
          throw errorFromPayload(provider, text, { requestId });
        }
        yield { data: text };
        return;
      } catch (error) {
        if (error instanceof LlmError) throw error;
        throw errorFromPayload(provider, text, { status: response.status, statusText: response.statusText, requestId, prefixHttp: true });
      }
    }

    if (response.body === null) return;

    const timedStream = withIdleTimeout(
      response.body as unknown as AsyncIterable<Uint8Array>,
      idleTimeoutMs,
      () => {
        timedOut = true;
        controller.abort();
      },
    );

    let sawSseEvent = false;
    const sampleChunks: Uint8Array[] = [];
    let sampleBytes = 0;

    async function* observedStream(): AsyncGenerator<Uint8Array> {
      for await (const chunk of timedStream) {
        if (!sawSseEvent && sampleBytes < MAX_NON_SSE_SAMPLE_BYTES) {
          const remaining = MAX_NON_SSE_SAMPLE_BYTES - sampleBytes;
          const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
          sampleChunks.push(new Uint8Array(slice));
          sampleBytes += slice.byteLength;
        }
        yield chunk;
      }
    }

    try {
      for await (const sse of parseSse(observedStream())) {
        sawSseEvent = true;
        sampleChunks.length = 0;
        yield sse;
      }
    } catch (error) {
      if (timedOut && !signal.aborted) {
        throw new LlmError({
          kind: "network",
          provider,
          message: `${provider} SSE stream timed out after ${Math.round(idleTimeoutMs / 1000)}s of inactivity`,
          retryable: true,
        });
      }
      throw error;
    }

    // If a gateway returned plain JSON/text on HTTP 200 without `data:` prefixes, surface it as an error instead of "stream ended".
    if (!sawSseEvent && sampleBytes > 0) {
      const merged = new Uint8Array(sampleBytes);
      let offset = 0;
      for (const part of sampleChunks) {
        merged.set(part, offset);
        offset += part.byteLength;
      }
      const sampleText = new TextDecoder().decode(merged).trim();
      if (hasNonCommentBody(sampleText)) {
        try {
          const parsed: unknown = JSON.parse(sampleText);
          if (isJsonErrorEnvelope(parsed)) {
            throw errorFromPayload(provider, sampleText, { requestId });
          }
        } catch (error) {
          if (error instanceof LlmError) throw error;
        }
        throw errorFromPayload(provider, sampleText, { status: response.status, requestId, prefixHttp: true });
      }
    }
  } finally {
    signal.removeEventListener("abort", onParentAbort);
  }
}

/** GET a JSON document; a non-2xx status or non-JSON/error envelope throws a classified LlmError. */
export async function getJson(url: string, headers: Record<string, string>, provider: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json", ...headers }, signal });
  if (!response.ok) throw await errorFromResponse(response, provider);
  const requestId = extractRequestId(response.headers);
  const text = await response.text();
  if (text.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (isJsonErrorEnvelope(parsed)) {
      throw errorFromPayload(provider, text, { requestId });
    }
    return parsed;
  } catch (error) {
    if (error instanceof LlmError) throw error;
    throw errorFromPayload(provider, text, { status: response.status, statusText: response.statusText, requestId, prefixHttp: true });
  }
}

/** Join a base URL and a path without doubling or dropping the slash. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
