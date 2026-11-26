export interface UiLlmError {
  kind?: string;
  message: string;
  status?: number;
  retryable?: boolean;
  provider?: string;
  code?: string;
  errorType?: string;
  requestId?: string;
  rawBody?: string;
}

const QUOTA_OR_BILLING_RE =
  /\b(?:insufficient_quota|credit_balance_exhausted|billing_hard_limit_reached|quota_exceeded|account_deactivated|insufficient_balance|balance_insufficient)\b|quota\s+exceeded|exceeded\s+your\s+current\s+quota|credit\s+balance\s+is\s+too\s+low|余额不足|额度不足|配额不足|已欠费|账户欠费/i;

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseUiLlmError(raw: unknown, fallbackProvider?: string): UiLlmError | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const message = str(obj.message) ?? str(obj.errorType) ?? str(obj.code);
  if (message === undefined) return undefined;
  const provider = str(obj.provider) ?? str(fallbackProvider);
  const kind = str(obj.kind);
  const status = num(obj.status);
  const retryable = typeof obj.retryable === "boolean" ? obj.retryable : undefined;
  const code = str(obj.code);
  const errorType = str(obj.errorType);
  const requestId = str(obj.requestId);
  const rawBody = str(obj.rawBody);
  return {
    message,
    ...(kind === undefined ? {} : { kind }),
    ...(status === undefined ? {} : { status }),
    ...(retryable === undefined ? {} : { retryable }),
    ...(provider === undefined ? {} : { provider }),
    ...(code === undefined ? {} : { code }),
    ...(errorType === undefined ? {} : { errorType }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(rawBody === undefined ? {} : { rawBody }),
  };
}

export function isQuotaOrBillingError(error: UiLlmError): boolean {
  const combined = [error.code ?? "", error.errorType ?? "", error.message].join(" ");
  return QUOTA_OR_BILLING_RE.test(combined);
}

/** Infer structured metadata even for older persisted error messages that stored only a string. */
export function inferLlmErrorFromMessage(message: {
  content: string;
  isError?: boolean;
  error?: UiLlmError;
}): UiLlmError | null {
  if (message.error !== undefined) {
    if (message.error.message.trim() !== "") return message.error;
    const fallbackText = message.content.trim();
    return { ...message.error, message: fallbackText || "提供商接口返回未知错误" };
  }
  if (message.isError !== true) return null;
  const text = message.content.trim();
  if (text === "") return { kind: "unknown", message: "本轮执行失败，提供商未返回具体错误信息" };

  const httpMatch = /^([A-Za-z0-9._-]+)\s+returned\s+HTTP\s+(\d{3})(?::\s*([\s\S]*))?$/i.exec(text);
  const status = httpMatch?.[2] ? Number(httpMatch[2]) : undefined;
  const provider = httpMatch?.[1];
  let kind: string | undefined;
  if (status === 401 || status === 403) kind = "auth";
  else if (status === 429) kind = "rate-limit";
  else if (status === 503 || status === 529) kind = "overloaded";
  else if (status === 413) kind = "context-length";
  else if (status !== undefined && status >= 500) kind = "server";
  else if (status !== undefined && status >= 400) kind = "invalid-request";
  else if (/timeout|timed out|ECONNRESET|ECONNREFUSED|network|fetch failed/i.test(text)) kind = "network";
  return {
    message: text,
    ...(kind === undefined ? {} : { kind }),
    ...(status === undefined ? {} : { status }),
    ...(provider === undefined ? {} : { provider }),
  };
}

export function describeLlmErrorTitle(error: UiLlmError): string {
  if (error.code === "empty_response_exhausted") return "模型未返回可见正文";
  if (isQuotaOrBillingError(error)) return "余额或配额不足";
  switch (error.kind) {
    case "auth":
      return "认证失败";
    case "context-length":
      return "上下文超出限制";
    case "rate-limit":
      return "请求触发限流";
    case "overloaded":
      return "模型服务过载";
    case "invalid-request":
      return "请求参数被拒绝";
    case "network":
      return "网络连接异常";
    case "server":
      return "上游服务异常";
    default:
      if (error.status === 401 || error.status === 403) return "认证失败";
      if (error.status === 429) return "请求触发限流";
      if (error.status === 503 || error.status === 529) return "模型服务过载";
      if (error.status !== undefined && error.status >= 500) return "上游服务异常";
      if (error.status !== undefined && error.status >= 400) return "请求参数被拒绝";
      return "提供商接口异常";
  }
}

export function describeLlmErrorHint(error: UiLlmError): string | null {
  if (error.code === "empty_response_exhausted") {
    return "模型连续仅输出了内部思考或空响应。可点击重试，或调低推理强度后再试。";
  }
  if (isQuotaOrBillingError(error)) {
    return "账户余额或调用配额可能已耗尽，请前往提供商控制台确认后重试。";
  }
  switch (error.kind) {
    case "auth":
      return "请检查「模型设置」中的 API Key、接口地址或该模型的访问权限。";
    case "context-length":
      return "当前会话上下文超出模型上限，可执行 /compact 压缩上下文后继续。";
    case "rate-limit":
      return "触发提供商速率限制，请稍后重试或切换其他模型 / 提供商。";
    case "overloaded":
      return "提供商当前负载过高或临时不可用，请稍后重试。";
    case "network":
      return "连接超时或流传输中断，请检查网络代理与接口连通性后重试。";
    case "server":
      return "提供商服务端返回异常，请稍后重试或查看下方原始返回信息。";
    case "invalid-request":
      return "请求参数或模型标识被接口拒绝，请核对模型协议与配置参数。";
    default:
      return null;
  }
}

export function shouldSuggestModelSettings(error: UiLlmError): boolean {
  if (error.code === "empty_response_exhausted") return false;
  return (
    error.kind === "auth"
    || error.kind === "invalid-request"
    || error.status === 401
    || error.status === 403
    || isQuotaOrBillingError(error)
  );
}

function conciseRetryReason(error: UiLlmError | undefined): string {
  if (error === undefined) return "";
  const raw = error.message.replace(/\s+/g, " ").trim();
  if (raw === "") return error.status !== undefined ? `HTTP ${error.status}` : "";
  const httpPrefix = /^[A-Za-z0-9._-]+\s+returned\s+(HTTP\s+\d{3}(?::\s*[\s\S]*)?)$/i.exec(raw);
  const cleaned = httpPrefix?.[1]
    ? httpPrefix[1]
    : error.status !== undefined && !raw.includes(String(error.status))
      ? `HTTP ${error.status}: ${raw}`
      : raw;
  return cleaned.length > 76 ? `${cleaned.slice(0, 75)}…` : cleaned;
}

/** Format a live `retry` chunk into a concise status label that surfaces the real upstream failure reason. */
export function formatRetryStatusText(chunk: Record<string, unknown>): string {
  const attempt = typeof chunk.attempt === "number" ? chunk.attempt : 1;
  const maxAttempts = typeof chunk.maxAttempts === "number" ? chunk.maxAttempts : attempt + 1;
  const totalRetries = Math.max(1, maxAttempts - 1);
  const delayMs = typeof chunk.delayMs === "number" ? chunk.delayMs : 0;
  const waitHint = delayMs >= 1_500 ? `（${Math.round(delayMs / 1000)}s 后）` : "";
  const parsedError = parseUiLlmError(chunk.error);
  const reason = conciseRetryReason(parsedError);

  if (typeof chunk.effort === "string") {
    const suffix = reason !== "" ? ` · ${reason}` : "";
    return `长流中断，已自动下调思考强度重试 ${attempt}/${totalRetries}${waitHint}${suffix}…`;
  }
  if (reason !== "") {
    return `${reason} · 正在重试 ${attempt}/${totalRetries}${waitHint}…`;
  }
  return `连接波动，正在重试 ${attempt}/${totalRetries}${waitHint}…`;
}

export function formatErrorCopyText(error: UiLlmError, model?: string): string {
  const lines: string[] = [];
  lines.push(`错误类型: ${describeLlmErrorTitle(error)}${error.kind ? ` (${error.kind})` : ""}`);
  if (error.provider || model) {
    lines.push(`提供商/模型: ${[error.provider, model].filter(Boolean).join(" / ")}`);
  }
  if (error.status !== undefined) lines.push(`HTTP 状态: ${error.status}`);
  if (error.code) lines.push(`错误码: ${error.code}`);
  if (error.errorType && error.errorType !== error.code) lines.push(`错误类别: ${error.errorType}`);
  if (error.requestId) lines.push(`Request ID: ${error.requestId}`);
  lines.push(`错误信息: ${error.message}`);
  if (error.rawBody) {
    lines.push("");
    lines.push("原始返回:");
    lines.push(error.rawBody);
  }
  return lines.join("\n");
}
