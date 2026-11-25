import type { LlmErrorInfo } from "./types.ts";

export const DEFAULT_FALLBACK_COOLDOWN_MS = 120_000;

export interface ModelTarget {
  provider: string;
  model: string;
}

export interface FailoverConfig {
  /** Ordered fallback targets formatted as `"provider/model"`. */
  fallbackModels?: readonly string[];
  /** Cooldown window in ms before re-trying a cooled-down model target (default `120_000`). */
  fallbackCooldownMs?: number;
  /** Clock source in ms for deterministic cooldown testing (default `Date.now`). */
  now?: () => number;
}

const QUOTA_CODE_RE =
  /\b(?:insufficient_quota|quota_exceeded|credit_balance_exhausted|billing_hard_limit_reached|insufficient_balance|balance_insufficient)\b|quota/i;

export function parseModelTarget(spec: string): ModelTarget | undefined {
  const trimmed = spec.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) return undefined;
  const provider = trimmed.slice(0, slash).trim();
  const model = trimmed.slice(slash + 1).trim();
  if (provider === "" || model === "") return undefined;
  return { provider, model };
}

export function formatModelTarget(target: ModelTarget): string {
  return `${target.provider}/${target.model}`;
}

/** Whether an exhausted target failure warrants cooling down and failing over to a fallback model. */
export function isFailoverEligibleError(error: LlmErrorInfo | undefined): boolean {
  if (error === undefined) return false;
  if (error.kind === "overloaded" || error.kind === "rate-limit") return true;
  const signal = `${error.code ?? ""} ${error.errorType ?? ""}`;
  return QUOTA_CODE_RE.test(signal);
}

/**
 * Stateful cooldown-aware model router for `LlmService`.
 * Routes around sustained `529`/`overloaded`, `429`/`rate-limit`, and quota errors,
 * and automatically reverts to the primary model once `fallbackCooldownMs` elapses.
 */
export class FailoverRouter {
  readonly cooldownUntil = new Map<string, number>();
  private fallbacks: ModelTarget[] = [];
  private cooldownMs = DEFAULT_FALLBACK_COOLDOWN_MS;
  private readonly now: () => number;

  constructor(options: FailoverConfig = {}) {
    this.now = options.now ?? (() => Date.now());
    this.configure(options);
  }

  configure(options: { fallbackModels?: readonly string[]; fallbackCooldownMs?: number }): void {
    this.fallbacks = (options.fallbackModels ?? [])
      .map(parseModelTarget)
      .filter((item): item is ModelTarget => item !== undefined);
    const rawCooldown = options.fallbackCooldownMs ?? DEFAULT_FALLBACK_COOLDOWN_MS;
    this.cooldownMs = Number.isFinite(rawCooldown) ? Math.max(0, rawCooldown) : DEFAULT_FALLBACK_COOLDOWN_MS;
  }

  get cooldownDurationMs(): number {
    return this.cooldownMs;
  }

  isInCooldown(target: ModelTarget): boolean {
    const key = formatModelTarget(target);
    const expiry = this.cooldownUntil.get(key);
    if (expiry === undefined) return false;
    if (this.now() >= expiry) {
      this.cooldownUntil.delete(key);
      return false;
    }
    return true;
  }

  markCooldown(target: ModelTarget): void {
    if (this.cooldownMs <= 0) return;
    this.cooldownUntil.set(formatModelTarget(target), this.now() + this.cooldownMs);
  }

  selectInitialTarget(primary: ModelTarget, hasProvider: (provider: string) => boolean): ModelTarget {
    if (!this.isInCooldown(primary)) return primary;
    const primaryKey = formatModelTarget(primary);
    for (const candidate of this.fallbacks) {
      if (formatModelTarget(candidate) === primaryKey) continue;
      if (!this.isInCooldown(candidate) && hasProvider(candidate.provider)) {
        return candidate;
      }
    }
    return primary;
  }

  nextFallback(tried: ReadonlySet<string>, hasProvider: (provider: string) => boolean): ModelTarget | undefined {
    for (const candidate of this.fallbacks) {
      const key = formatModelTarget(candidate);
      if (tried.has(key)) continue;
      if (!this.isInCooldown(candidate) && hasProvider(candidate.provider)) {
        return candidate;
      }
    }
    return undefined;
  }
}
