/**
 * Model capability discovery and reasoning effort helpers for the
 * OpenAI-compatible Chat Completions adapter.
 */
import type { Effort, ModelInfo, SecretRef } from "@qianji/llm";

export interface ProviderConfig {
  id: string;
  name?: string;
  /** Up to and including the version path, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  apiKey?: SecretRef;
  /** Extra request headers, e.g. OpenRouter's `HTTP-Referer`. */
  headers?: Record<string, string>;
  /** Send `reasoning_effort` when a request asks for an effort. */
  reasoningEffort?: boolean;
  /** Configured models; their metadata wins over what `/models` reports. */
  models?: ModelInfo[];
}

export function effortValue(effort: Effort | undefined): string | undefined {
  const trimmed = effort?.trim();
  return trimmed === undefined || trimmed === "" || trimmed === "off" ? undefined : trimmed;
}

export function clampFallbackEffort(effort: string): "low" | "medium" | "high" | undefined {
  const normalized = effort.toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") return undefined;
  if (normalized === "minimal") return "low";
  if (normalized === "xhigh" || normalized === "max") return "high";
  return "medium";
}

function parseEffortList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const list: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.trim().toLowerCase();
    if (!/^[a-z0-9._:-]{1,64}$/.test(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    list.push(normalized);
  }
  if (list.length === 0) return undefined;
  if (!seen.has("off") && !seen.has("none")) {
    return ["off", ...list];
  }
  return list;
}

const KNOWN_REASONING_EFFORT_MODEL_RE = /^(?:o1|o3|o4|gpt-5|grok-(?:3-mini|4))(?:$|[-._/])/i;

/**
 * Whether `reasoning_effort` should be sent for `modelId`.
 * Explicit `provider.reasoningEffort` (`true` / `false`) always wins; otherwise
 * auto-enable for configured reasoning models and known OpenAI/xAI reasoning families
 * while avoiding DeepSeek's native endpoint where `deepseek-reasoner` omits it.
 */
export function supportsReasoningEffort(
  modelId: string,
  provider: ProviderConfig,
  unsupportedModels?: ReadonlySet<string>,
): boolean {
  if (provider.reasoningEffort === true) return true;
  if (provider.reasoningEffort === false) return false;
  if (unsupportedModels?.has(modelId)) return false;
  if (/^deepseek-reasoner$/i.test(modelId) || /api\.deepseek\.com/i.test(provider.baseUrl)) return false;
  const configured = provider.models?.find((item) => item.id === modelId);
  if (configured?.reasoning === false) return false;
  if (
    configured?.reasoning === true
    || (configured?.thinkingLevel !== undefined && configured.thinkingLevel !== "off")
    || Boolean(configured?.thinkingLevels?.some((lvl) => lvl !== "off"))
  ) {
    return true;
  }
  return KNOWN_REASONING_EFFORT_MODEL_RE.test(modelId);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

function parsePerMillionPrice(perToken: unknown): number | undefined {
  const num = typeof perToken === "number" ? perToken : typeof perToken === "string" ? Number(perToken) : NaN;
  if (!Number.isFinite(num) || num < 0) return undefined;
  return Math.round(num * 1_000_000 * 10_000) / 10_000;
}

export function parseDiscoveredModel(raw: Record<string, unknown>): ModelInfo[] {
  if (typeof raw.id !== "string" || raw.id.trim() === "") return [];
  const id = raw.id;
  const info: ModelInfo = { id };

  const displayName = typeof raw.name === "string" ? raw.name.trim() : typeof raw.display_name === "string" ? raw.display_name.trim() : "";
  if (displayName !== "" && displayName !== id) info.name = displayName;

  const topProvider = typeof raw.top_provider === "object" && raw.top_provider !== null ? (raw.top_provider as Record<string, unknown>) : undefined;
  const contextWindow =
    positiveInt(raw.context_length)
    ?? positiveInt(raw.context_window)
    ?? positiveInt(raw.max_model_len)
    ?? positiveInt(raw.max_input_tokens)
    ?? positiveInt(topProvider?.context_length);
  if (contextWindow !== undefined) info.contextWindow = contextWindow;

  const maxOutputTokens =
    positiveInt(raw.max_completion_tokens)
    ?? positiveInt(raw.max_output_tokens)
    ?? positiveInt(topProvider?.max_completion_tokens);
  if (maxOutputTokens !== undefined) info.maxOutputTokens = maxOutputTokens;

  const capabilities = typeof raw.capabilities === "object" && raw.capabilities !== null ? (raw.capabilities as Record<string, unknown>) : undefined;
  const capReasoning = typeof capabilities?.reasoning === "object" && capabilities.reasoning !== null
    ? (capabilities.reasoning as Record<string, unknown>)
    : undefined;
  const supportedParams = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : undefined;
  const discoveredLevels =
    parseEffortList(raw.thinking_levels)
    ?? parseEffortList(raw.supported_thinking_levels)
    ?? parseEffortList(raw.reasoning_efforts)
    ?? parseEffortList(raw.supported_reasoning_efforts)
    ?? parseEffortList(raw.efforts)
    ?? parseEffortList(capabilities?.thinking_levels)
    ?? parseEffortList(capabilities?.reasoning_efforts)
    ?? parseEffortList(capReasoning?.efforts)
    ?? parseEffortList(capReasoning?.levels);
  if (discoveredLevels !== undefined) {
    info.thinkingLevels = discoveredLevels;
  }

  if (
    raw.reasoning === true
    || raw.thinking === true
    || raw.supports_reasoning === true
    || capabilities?.reasoning === true
    || capReasoning?.enabled === true
    || capabilities?.thinking === true
    || Boolean(discoveredLevels?.some((lvl) => lvl !== "off" && lvl !== "none"))
    || (supportedParams !== undefined && supportedParams.some((p) => p === "reasoning" || p === "include_reasoning" || p === "reasoning_effort"))
  ) {
    info.reasoning = true;
  }

  const rawEffort = typeof raw.thinking_level === "string"
    ? raw.thinking_level.trim().toLowerCase()
    : typeof raw.reasoning_effort === "string"
      ? raw.reasoning_effort.trim().toLowerCase()
      : typeof raw.default_reasoning_effort === "string"
        ? raw.default_reasoning_effort.trim().toLowerCase()
        : "";
  if (rawEffort !== "" && /^[a-z0-9._:-]{1,64}$/.test(rawEffort)) {
    info.thinkingLevel = rawEffort;
    if (rawEffort !== "off" && rawEffort !== "none") info.reasoning = true;
  }

  const arch = typeof raw.architecture === "object" && raw.architecture !== null ? (raw.architecture as Record<string, unknown>) : undefined;
  const inputModalities = Array.isArray(arch?.input_modalities) ? arch.input_modalities : undefined;
  const modality = typeof arch?.modality === "string" ? arch.modality : "";
  if (
    raw.vision === true
    || raw.supports_vision === true
    || raw.multimodal === true
    || capabilities?.vision === true
    || (inputModalities !== undefined && inputModalities.includes("image"))
    || modality.includes("image")
  ) {
    info.input = ["text", "image"];
  }

  const pricing = typeof raw.pricing === "object" && raw.pricing !== null ? (raw.pricing as Record<string, unknown>) : undefined;
  if (pricing !== undefined) {
    const inputPrice = parsePerMillionPrice(pricing.prompt);
    const outputPrice = parsePerMillionPrice(pricing.completion);
    if (inputPrice !== undefined && outputPrice !== undefined && (inputPrice > 0 || outputPrice > 0)) {
      info.cost = { input: inputPrice, output: outputPrice };
    }
  }

  return [info];
}
