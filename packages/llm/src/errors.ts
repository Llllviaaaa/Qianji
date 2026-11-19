import type { LlmErrorInfo, LlmErrorKind } from "./types.ts";

const MAX_RAW_JSON_CHARS = 4_000;
const MAX_RAW_TEXT_CHARS = 2_000;

const REQUEST_ID_HEADERS = [
  "x-request-id",
  "request-id",
  "openai-request-id",
  "anthropic-request-id",
  "x-amzn-requestid",
  "x-trace-id",
  "trace-id",
  "cf-ray",
] as const;

const QUOTA_OR_BILLING_RE =
  /\b(?:insufficient_quota|credit_balance_exhausted|billing_hard_limit_reached|quota_exceeded|account_deactivated|insufficient_balance|balance_insufficient)\b|quota\s+exceeded|exceeded\s+your\s+current\s+quota|credit\s+balance\s+is\s+too\s+low|余额不足|额度不足|配额不足|已欠费|账户欠费/i;

const CONTEXT_LENGTH_RE =
  /\b(?:context_length_exceeded|max_tokens_exceeded)\b|context.{0,20}(?:length|window)|too many tokens|prompt is too long|maximum context length|input is too long/i;

const AUTH_CODE_RE =
  /\b(?:invalid_api_key|authentication_error|permission_error|unauthorized|forbidden|invalid_auth|api_key_invalid)\b/i;

const OVERLOADED_CODE_RE =
  /\b(?:overloaded_error|server_is_overloaded|service_unavailable|service_unavailable_error|engine_overloaded)\b/i;

const RATE_LIMIT_CODE_RE =
  /\b(?:rate_limit_exceeded|rate_limit_error|too_many_requests|slow_down|resource_exhausted)\b/i;

const INVALID_REQUEST_CODE_RE =
  /\b(?:invalid_request_error|invalid_argument|bad_request|model_not_found|unsupported_parameter|invalid_value)\b/i;

export class LlmError extends Error implements LlmErrorInfo {
  readonly kind: LlmErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  /** Seconds the provider asked us to wait, from Retry-After. */
  readonly retryAfter?: number;
  readonly provider?: string;
  readonly code?: string;
  readonly errorType?: string;
  readonly requestId?: string;
  readonly rawBody?: string;

  constructor(info: LlmErrorInfo & { retryAfter?: number }) {
    super(info.message);
    this.name = "LlmError";
    this.kind = info.kind;
    this.status = info.status;
    this.retryable = info.retryable;
    this.retryAfter = info.retryAfter;
    this.provider = info.provider;
    this.code = info.code;
    this.errorType = info.errorType;
    this.requestId = info.requestId;
    this.rawBody = info.rawBody;
  }

  toInfo(): LlmErrorInfo {
    return {
      kind: this.kind,
      message: this.message,
      ...(this.status === undefined ? {} : { status: this.status }),
      retryable: this.retryable,
      ...(this.provider === undefined ? {} : { provider: this.provider }),
      ...(this.code === undefined ? {} : { code: this.code }),
      ...(this.errorType === undefined ? {} : { errorType: this.errorType }),
      ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
      ...(this.rawBody === undefined ? {} : { rawBody: this.rawBody }),
    };
  }
}

function redactErrorText(text: string): string {
  return text
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]")
    .replace(/\b(sk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{12,})\b/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|authorization)\s*[:=]\s*["']?)[^\s"',;]{8,}/gi, "$1[REDACTED]");
}

function retryAfterSeconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, (date - Date.now()) / 1000);
}

/** Extract an upstream request / trace identifier from HTTP headers when present. */
export function extractRequestId(headers: Headers | undefined): string | undefined {
  if (headers === undefined) return undefined;
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers.get(name)?.trim();
    if (value !== undefined && value !== "") return value.slice(0, 128);
  }
  return undefined;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function isHtmlBody(trimmed: string): boolean {
  return /^(?:<!doctype\s+html|<html\b|<head\b|<!--)/i.test(trimmed)
    || /<title[^>]*>[\s\S]*?<\/title>/i.test(trimmed);
}

function extractHtmlSummary(trimmed: string): string {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(trimmed);
  const title = titleMatch?.[1] ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, " ")) : "";
  if (title !== "") return title.slice(0, 240);
  const h1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(trimmed);
  const heading = h1Match?.[1] ? decodeHtmlEntities(h1Match[1].replace(/<[^>]+>/g, " ")) : "";
  if (heading !== "") return heading.slice(0, 240);
  const stripped = decodeHtmlEntities(
    trimmed
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(?:script|style)[^>]*>[\s\S]*?<\/(?:script|style)>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
  return stripped.slice(0, 240);
}

export interface ParsedErrorPayload {
  message: string;
  code?: string;
  errorType?: string;
  status?: number;
  requestId?: string;
  rawBody?: string;
}

function detailArrayMessage(detail: unknown): string | undefined {
  if (!Array.isArray(detail) || detail.length === 0) return undefined;
  const parts = detail
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (!isRecord(item)) return "";
      const msg = nonEmptyString(item.msg) ?? nonEmptyString(item.message);
      const loc = Array.isArray(item.loc) ? item.loc.map(String).join(".") : undefined;
      if (msg && loc) return `${loc}: ${msg}`;
      return msg ?? "";
    })
    .filter((part) => part !== "");
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function numericHttpStatus(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599) return value;
  if (typeof value === "string" && /^[45]\d{2}$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

/** Pull structured diagnostics and a readable summary out of a provider's JSON, HTML, or text error body. */
export function parseErrorPayload(body: string): ParsedErrorPayload {
  const trimmed = body.trim();
  if (trimmed === "") return { message: "" };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      const nestedErr = isRecord(parsed.error)
        ? parsed.error
        : isRecord(parsed.response) && isRecord(parsed.response.error)
          ? parsed.response.error
          : undefined;
      const firstErrorsItem = Array.isArray(parsed.errors) && isRecord(parsed.errors[0]) ? parsed.errors[0] : undefined;
      const message =
        (typeof parsed.error === "string" ? nonEmptyString(parsed.error) : undefined)
        ?? nonEmptyString(nestedErr?.message)
        ?? nonEmptyString(nestedErr?.msg)
        ?? nonEmptyString(nestedErr?.detail)
        ?? nonEmptyString(parsed.message)
        ?? nonEmptyString(parsed.error_description)
        ?? nonEmptyString(parsed.msg)
        ?? (typeof parsed.detail === "string" ? nonEmptyString(parsed.detail) : detailArrayMessage(parsed.detail))
        ?? nonEmptyString(firstErrorsItem?.message)
        ?? nonEmptyString(nestedErr?.status)
        ?? nonEmptyString(nestedErr?.type)
        ?? nonEmptyString(nestedErr?.code)
        ?? "";
      const code =
        nonEmptyString(nestedErr?.code)
        ?? nonEmptyString(parsed.code)
        ?? nonEmptyString(firstErrorsItem?.code);
      const errorType =
        nonEmptyString(nestedErr?.type)
        ?? (typeof nestedErr?.status === "string" ? nonEmptyString(nestedErr.status) : undefined)
        ?? nonEmptyString(parsed.type);
      const status = numericHttpStatus(nestedErr?.code) ?? numericHttpStatus(nestedErr?.status) ?? numericHttpStatus(parsed.status) ?? numericHttpStatus(parsed.code);
      const requestId =
        nonEmptyString(parsed.request_id)
        ?? nonEmptyString(parsed.requestId)
        ?? nonEmptyString(parsed.trace_id)
        ?? nonEmptyString(nestedErr?.request_id)
        ?? nonEmptyString(nestedErr?.requestId);
      const pretty = redactErrorText(JSON.stringify(parsed, null, 2));
      const rawBody = pretty.length > MAX_RAW_JSON_CHARS ? `${pretty.slice(0, MAX_RAW_JSON_CHARS)}\n…(truncated)` : pretty;
      return {
        message: redactErrorText(message),
        ...(code === undefined ? {} : { code }),
        ...(errorType === undefined ? {} : { errorType }),
        ...(status === undefined ? {} : { status }),
        ...(requestId === undefined ? {} : { requestId }),
        ...(rawBody === "{}" ? {} : { rawBody }),
      };
    }
  } catch {
    // not JSON
  }

  if (isHtmlBody(trimmed)) {
    const summary = redactErrorText(extractHtmlSummary(trimmed));
    return { message: summary };
  }
  const redacted = redactErrorText(trimmed);
  const rawBody = redacted.length > MAX_RAW_TEXT_CHARS ? `${redacted.slice(0, MAX_RAW_TEXT_CHARS)}\n…(truncated)` : redacted;
  return {
    message: redacted.slice(0, 500),
    ...(rawBody !== "" ? { rawBody } : {}),
  };
}

/** Pull a readable message out of a provider's JSON or HTML error body, or fall back to raw text. */
export function messageFromBody(body: string): string {
  return parseErrorPayload(body).message;
}

function classifyError(
  status: number | undefined,
  detail: string,
  code: string | undefined,
  errorType: string | undefined,
): { kind: LlmErrorKind; retryable: boolean } {
  const signalText = [code ?? "", errorType ?? "", detail].join(" ");

  if (status === 401 || status === 403 || AUTH_CODE_RE.test(signalText)) {
    return { kind: "auth", retryable: false };
  }
  if (status === 413 || CONTEXT_LENGTH_RE.test(signalText)) {
    return { kind: "context-length", retryable: false };
  }
  if (QUOTA_OR_BILLING_RE.test(signalText)) {
    // Codex pattern: exhausted quota / balance is terminal even on HTTP 429 — never loop retries.
    return { kind: "rate-limit", retryable: false };
  }
  if (status === 429 || RATE_LIMIT_CODE_RE.test(signalText)) {
    return { kind: "rate-limit", retryable: true };
  }
  if (status === 529 || status === 503 || OVERLOADED_CODE_RE.test(signalText)) {
    return { kind: "overloaded", retryable: true };
  }
  // HTTP 524 is Cloudflare's Origin Timeout (~100-125s wait for TTFB); blindly retrying multiplies into an 8-minute freeze.
  if (status === 524) {
    return { kind: "server", retryable: false };
  }
  if (status !== undefined && status >= 500) {
    return { kind: "server", retryable: true };
  }
  if ((status !== undefined && status >= 400) || INVALID_REQUEST_CODE_RE.test(signalText)) {
    return { kind: "invalid-request", retryable: false };
  }
  if (/\b(?:server_error|api_error|internal_error|upstream)\b/i.test(signalText)) {
    return { kind: "server", retryable: true };
  }
  return { kind: "unknown", retryable: false };
}

/** Build a classified LlmError from an inline SSE error event or HTTP 200 error body. */
export function errorFromPayload(
  provider: string,
  body: string,
  options: { status?: number; statusText?: string; retryAfter?: number; requestId?: string; prefixHttp?: boolean } = {},
): LlmError {
  const parsed = parseErrorPayload(body);
  const status = options.status ?? parsed.status;
  const detail = parsed.message || options.statusText || "";
  const message = options.prefixHttp && status !== undefined
    ? `${provider} returned HTTP ${status}${detail ? `: ${detail}` : ""}`
    : `${provider}: ${detail || parsed.errorType || parsed.code || "stream error"}`;
  const classified = classifyError(status, detail, parsed.code, parsed.errorType);
  const requestId = options.requestId ?? parsed.requestId;
  return new LlmError({
    kind: classified.kind,
    message,
    ...(status === undefined ? {} : { status }),
    retryable: classified.retryable,
    ...(options.retryAfter === undefined ? {} : { retryAfter: options.retryAfter }),
    provider,
    ...(parsed.code === undefined ? {} : { code: parsed.code }),
    ...(parsed.errorType === undefined ? {} : { errorType: parsed.errorType }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(parsed.rawBody === undefined ? {} : { rawBody: parsed.rawBody }),
  });
}

/** Classify a non-2xx HTTP response the way every adapter should. */
export async function errorFromResponse(response: Response, provider: string): Promise<LlmError> {
  const body = await response.text().catch(() => "");
  const retryAfter = retryAfterSeconds(response.headers.get("retry-after"));
  const requestId = extractRequestId(response.headers);
  return errorFromPayload(provider, body, {
    status: response.status,
    statusText: response.statusText,
    retryAfter,
    requestId,
    prefixHttp: true,
  });
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "SocketClosed",
  "ConnectionRefused",
]);

const NETWORK_MESSAGE_RE =
  /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|UND_ERR_SOCKET)\b|socket connection was closed|ended the stream|stream ended before|premature close|other side closed|fetch failed|network error|terminated/i;

function cleanFetchMessage(raw: string): string {
  return raw
    .replace(/\s*For more information,\s*pass\s*`?verbose:\s*true`?\s*in the second argument to fetch\(\)\.?/gi, "")
    .trim();
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string" && direct !== "") return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === "object" && cause !== null) {
    const nested = (cause as { code?: unknown }).code;
    if (typeof nested === "string" && nested !== "") return nested;
  }
  return undefined;
}

/** Turn anything thrown while calling a provider into an LlmError. */
export function toLlmError(error: unknown, signal?: AbortSignal): LlmError {
  if (error instanceof LlmError) return error;
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
    return new LlmError({ kind: "aborted", message: "Request aborted", retryable: false });
  }
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = redactErrorText(cleanFetchMessage(rawMessage) || rawMessage);
  const code = errorCodeOf(error);
  // fetch rejects with a TypeError in Node/Bun, or an Error carrying a socket/transport code or stream-drop message.
  if (
    error instanceof TypeError
    || (code !== undefined && NETWORK_ERROR_CODES.has(code))
    || NETWORK_MESSAGE_RE.test(rawMessage)
  ) {
    return new LlmError({
      kind: "network",
      message,
      retryable: true,
      ...(code === undefined ? {} : { code }),
    });
  }
  return new LlmError({
    kind: "unknown",
    message,
    retryable: false,
    ...(code === undefined ? {} : { code }),
  });
}
