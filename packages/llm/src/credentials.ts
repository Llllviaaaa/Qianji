import { Context, Service } from "@deepseek-ai/cordis";

declare module "@deepseek-ai/cordis" {
  interface Context {
    credentials: Credentials;
  }
}

/**
 * Where a secret comes from (ADR 0007). Configuration files hold one of these,
 * never a key written out unless the user chose `value`:
 * - `env`: an environment variable of the host process;
 * - `secret`: an id a registered store resolves (the desktop app's
 *   DPAPI-protected store, once it is bridged in P5);
 * - `value`: the key itself.
 */
export type SecretRef = { env: string } | { secret: string } | { value: string };

export type SecretResolver = (id: string) => Promise<string | undefined>;

export interface SecretStore {
  resolve: SecretResolver;
  set?(id: string, value: string): Promise<void> | void;
  delete?(id: string): Promise<boolean> | boolean;
}

export function isSecretRef(value: unknown): value is SecretRef {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const [key] = keys;
  return (key === "env" || key === "secret" || key === "value") && typeof (value as Record<string, unknown>)[key] === "string";
}

function normalizeSecretId(id: string): string {
  const trimmed = id.trim();
  if (trimmed === "") throw new Error("Secret id must be non-empty");
  return trimmed;
}

/** Resolves, stores, and deletes secrets; stores register themselves for `{ secret }` refs and plugin secrets. */
export class Credentials extends Service {
  private store: SecretStore | undefined;

  constructor(ctx: Context) {
    super(ctx, "credentials");
  }

  /** Whether a registered store supports `set` and `delete`. */
  get writable(): boolean {
    return typeof this.store?.set === "function" && typeof this.store?.delete === "function";
  }

  /** Install the store or resolver for `{ secret }` refs. Automatically cleans up with the caller's Cordis fiber. */
  registerStore(store: SecretResolver | SecretStore): () => void {
    if (this.store !== undefined) throw new Error("A secret store is already registered");
    const entry: SecretStore = typeof store === "function" ? { resolve: store } : store;
    this.store = entry;
    let disposed = false;
    const once = (): void => {
      if (disposed) return;
      disposed = true;
      if (this.store === entry) this.store = undefined;
    };
    if (this.ctx?.fiber?.uid != null && this.ctx.fiber.state !== 5) {
      try {
        return this.ctx.effect(() => once, "credentials.registerStore") as unknown as () => void;
      } catch {
        return once;
      }
    }
    return once;
  }

  async resolve(ref: SecretRef | undefined): Promise<string | undefined> {
    if (ref === undefined) return undefined;
    if ("value" in ref) return ref.value;
    if ("env" in ref) {
      const value = process.env[ref.env];
      return value === undefined || value === "" ? undefined : value;
    }
    if (this.store === undefined) throw new Error(`No secret store is available for "${ref.secret}"`);
    return this.store.resolve(ref.secret);
  }

  async get(id: string): Promise<string | undefined> {
    const trimmed = normalizeSecretId(id);
    return this.resolve({ secret: trimmed });
  }

  async set(id: string, value: string): Promise<void> {
    const trimmed = normalizeSecretId(id);
    if (value === "") throw new Error("Secret value must be non-empty");
    if (this.store?.set === undefined) throw new Error(`No writable secret store is available for "${trimmed}"`);
    await this.store.set(trimmed, value);
  }

  async delete(id: string): Promise<boolean> {
    const trimmed = normalizeSecretId(id);
    if (this.store?.delete === undefined) throw new Error(`No writable secret store is available for "${trimmed}"`);
    return Boolean(await this.store.delete(trimmed));
  }

  /** How a ref is described to the UI, without the secret. */
  describe(ref: SecretRef | undefined): string {
    if (ref === undefined) return "none";
    if ("value" in ref) return "stored in config";
    if ("env" in ref) return `environment variable ${ref.env}`;
    return "secret store";
  }
}
