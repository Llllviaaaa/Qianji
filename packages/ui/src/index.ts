/**
 * The `ui` service (ADR 0002, 0009): plugins ask the user to confirm, pick or
 * type something, or tell them something, without knowing who answers. A
 * transport (the RPC gateway's `ui/request`, P4) delivers each request; with
 * none attached, as in a headless run, questions resolve at once with no
 * answer and callers fall back to their safe default.
 */
import { Context, Service } from "@deepseek-ai/cordis";

declare module "@deepseek-ai/cordis" {
  interface Context {
    ui: Ui;
  }
}

export type UiRequest =
  | { kind: "confirm"; title: string; message: string }
  | { kind: "select"; title: string; options: string[] }
  | { kind: "input"; title: string; placeholder?: string };

export type NotifyLevel = "info" | "warning" | "error";

export interface PendingUiRequest {
  requestId: string;
  sessionId?: string;
  request: UiRequest;
}

export interface UiTransport {
  /** Show a question; the answer comes back through `Ui.respond`. */
  request(pending: PendingUiRequest): void;
  /** The question no longer needs an answer (answered elsewhere, aborted, or the transport left). */
  cancel(requestId: string): void;
  notify(sessionId: string | undefined, message: string, level: NotifyLevel): void;
}

interface Waiting extends PendingUiRequest {
  resolve(value: unknown): void;
}

export class Ui extends Service {
  private readonly transports = new Set<UiTransport>();
  private readonly waiting = new Map<string, Waiting>();
  /** Sessions nobody is watching (scheduled runs): questions get no answer. */
  private readonly unattendedSessions = new Set<string>();
  private nextId = 0;

  constructor(ctx: Context) {
    super(ctx, "ui");
    ctx.effect(() => () => this.cancelAll(), "ui: cancel pending requests");
  }

  /** Whether anyone can answer questions. */
  get available(): boolean {
    return this.transports.size > 0;
  }

  /** Whether a question about `sessionId` can reach someone. */
  canAsk(sessionId: string | undefined): boolean {
    return this.transports.size > 0 && (sessionId === undefined || !this.unattendedSessions.has(sessionId));
  }

  /** Answer every question about `sessionId` with nothing, as for a run nobody watches. Returns the disposer. */
  markUnattended(sessionId: string): () => void {
    this.unattendedSessions.add(sessionId);
    return () => void this.unattendedSessions.delete(sessionId);
  }

  /** Deliver requests through `transport`. Multiple transports may attach; first response wins and cancels the rest. */
  attach(transport: UiTransport): () => void {
    this.transports.add(transport);
    let disposed = false;
    const detach = (): void => {
      if (disposed || !this.transports.has(transport)) return;
      disposed = true;
      if (this.transports.size === 1) {
        this.cancelAll();
        this.transports.delete(transport);
        return;
      }
      this.transports.delete(transport);
      for (const requestId of this.waiting.keys()) {
        try {
          transport.cancel(requestId);
        } catch (error) {
          this.ctx.logger("ui").warn("transport.cancel(%s) failed on detach: %s", requestId, error);
        }
      }
    };
    if (this.ctx?.fiber?.uid != null && this.ctx.fiber.state !== 5) {
      try {
        return this.ctx.effect(() => detach, "ui.attach") as unknown as () => void;
      } catch {
        return detach;
      }
    }
    return detach;
  }

  /** Ask, resolving to the answer, or undefined when nobody can answer or `signal` aborts. */
  ask(sessionId: string | undefined, request: UiRequest, signal?: AbortSignal): Promise<unknown> {
    if (this.transports.size === 0 || !this.canAsk(sessionId) || signal?.aborted) return Promise.resolve(undefined);
    this.nextId += 1;
    const requestId = `ui-${this.nextId}`;
    return new Promise((resolve) => {
      const onAbort = () => this.settle(requestId, undefined);
      const entry: Waiting = {
        requestId,
        ...(sessionId === undefined ? {} : { sessionId }),
        request,
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
      };
      this.waiting.set(requestId, entry);
      signal?.addEventListener("abort", onAbort, { once: true });
      const pending: PendingUiRequest = { requestId, ...(sessionId === undefined ? {} : { sessionId }), request };
      for (const transport of [...this.transports]) {
        try {
          transport.request(pending);
        } catch (error) {
          this.ctx.logger("ui").warn("transport.request(%s) failed: %s", requestId, error);
        }
      }
    });
  }

  async confirm(sessionId: string | undefined, title: string, message: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.ask(sessionId, { kind: "confirm", title, message }, signal)) === true;
  }

  async select(sessionId: string | undefined, title: string, options: string[], signal?: AbortSignal): Promise<string | undefined> {
    const answer = await this.ask(sessionId, { kind: "select", title, options }, signal);
    return typeof answer === "string" && options.includes(answer) ? answer : undefined;
  }

  async input(sessionId: string | undefined, title: string, placeholder?: string, signal?: AbortSignal): Promise<string | undefined> {
    const answer = await this.ask(sessionId, { kind: "input", title, ...(placeholder === undefined ? {} : { placeholder }) }, signal);
    return typeof answer === "string" ? answer : undefined;
  }

  notify(sessionId: string | undefined, message: string, level: NotifyLevel = "info"): void {
    for (const transport of [...this.transports]) {
      try {
        transport.notify(sessionId, message, level);
      } catch (error) {
        this.ctx.logger("ui").warn("transport.notify failed: %s", error);
      }
    }
  }

  /** Answer a pending request; false when it is unknown or already settled. */
  respond(requestId: string, value: unknown): boolean {
    return this.settle(requestId, value);
  }

  /** Questions still waiting, for a client that reconnects. */
  pending(): PendingUiRequest[] {
    return [...this.waiting.values()].map(({ requestId, sessionId, request }) => ({ requestId, ...(sessionId === undefined ? {} : { sessionId }), request }));
  }

  private settle(requestId: string, value: unknown): boolean {
    const entry = this.waiting.get(requestId);
    if (entry === undefined) return false;
    this.waiting.delete(requestId);
    for (const transport of [...this.transports]) {
      try {
        transport.cancel(requestId);
      } catch (error) {
        this.ctx.logger("ui").warn("transport.cancel(%s) failed: %s", requestId, error);
      }
    }
    entry.resolve(value);
    return true;
  }

  private cancelAll(): void {
    for (const requestId of [...this.waiting.keys()]) this.settle(requestId, undefined);
  }
}
