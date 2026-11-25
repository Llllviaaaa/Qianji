import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { Context, Service } from "@deepseek-ai/cordis";
import { AgentLoop } from "@qianji/agent-loop";
import { Permissions } from "@qianji/permissions";
import type { RpcHandler, RpcService } from "@qianji/rpc";
import { textOutput, type ToolEnv } from "@qianji/tools";
import { corePlugins } from "../packages/host/src/agent-plugins.ts";
import { createHost } from "../packages/host/src/host.ts";
import { PluginManager } from "../packages/host/src/plugin-manager.ts";
import {
  QIANJI_PERMISSION_PLACEHOLDER,
  QIANJI_QUESTION_PLACEHOLDER,
  headlineForUiRequest,
} from "../src/lib/batchAsk.ts";
import { ClientStylesService } from "../src/lib/clientContributions.ts";
import { uiRequestNotification } from "../src/lib/eventNotifications.ts";
import { ClientSlotsService, SessionArea, SlotHost, SlotRegistry } from "../src/kernel/slots";
import questionClient, { QuestionApprovalCard, QuestionToolCallCard } from "../plugins/question/client.tsx";
import {
  QUESTION_PLACEHOLDER,
  normalizeQuestionnaireInput,
  parseQuestionEnvelopeFromRequest,
  serializeQuestionEnvelope,
  serializeQuestionResponse,
} from "../plugins/question/shared.ts";
import permissionClient, { PermissionApprovalCard, PermissionToolCallCard } from "../plugins/permission/client.tsx";
import {
  PERMISSION_PLACEHOLDER,
  deriveCommandPrefix,
  matchesGrantRules,
  parsePermissionEnvelopeFromRequest,
  serializePermissionEnvelope,
  serializePermissionResponse,
} from "../plugins/permission/shared.ts";

const REPO_ROOT = resolve(__dirname, "..");
const PLUGINS_ROOT = resolve(REPO_ROOT, "plugins");

function installMockDom() {
  const headChildren: Array<{
    tagName: string;
    textContent: string;
    isConnected: boolean;
    attributes: Map<string, string>;
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    remove(): void;
  }> = [];
  const head = {
    children: headChildren,
    appendChild(node: (typeof headChildren)[number]) {
      if (!headChildren.includes(node)) headChildren.push(node);
      node.isConnected = true;
      return node;
    },
    querySelector(selector: string) {
      const m = /^style\[data-qj-plugin-style="([^"]+)"\]$/.exec(selector);
      if (!m) return null;
      return headChildren.find((item) => item.attributes.get("data-qj-plugin-style") === m[1]) ?? null;
    },
  };
  const mockDoc = {
    head,
    createElement(tag: string) {
      const attrs = new Map<string, string>();
      const node = {
        tagName: tag.toUpperCase(),
        textContent: "",
        isConnected: false,
        attributes: attrs,
        setAttribute(k: string, v: string) {
          attrs.set(k, v);
        },
        getAttribute(k: string) {
          return attrs.get(k) ?? null;
        },
        remove() {
          node.isConnected = false;
          const idx = headChildren.indexOf(node);
          if (idx >= 0) headChildren.splice(idx, 1);
        },
      };
      return node;
    },
  };

  const prevDoc = (globalThis as Record<string, unknown>).document;
  (globalThis as Record<string, unknown>).document = mockDoc;
  return () => {
    if (prevDoc === undefined) delete (globalThis as Record<string, unknown>).document;
    else (globalThis as Record<string, unknown>).document = prevDoc;
  };
}

describe("Built-in question & permission full-stack plugins", () => {
  const disposers: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (disposers.length > 0) {
      await disposers.pop()?.();
    }
  });

  async function setupHostWithPlugins() {
    const dataDir = mkdtempSync(join(tmpdir(), "qj-qp-data-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "qj-qp-ws-"));
    disposers.push(() => {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    });

    const rpcHandlers = new Map<string, RpcHandler>();
    class TestRpcService extends Service implements RpcService {
      static provide = "rpc";
      constructor(ctx: Context) {
        super(ctx, "rpc");
      }
      method(name: string, handler: RpcHandler): () => void {
        rpcHandlers.set(name, handler);
        return () => void rpcHandlers.delete(name);
      }
      methods(): string[] {
        return ["initialize", ...rpcHandlers.keys()];
      }
      broadcast(): void {}
    }

    const host = createHost({
      version: "0.0.0-test",
      dataDir,
      plugins: [...corePlugins(), [AgentLoop], [Permissions, {}], [TestRpcService]],
    });
    await host.start();

    for (const toolName of ["read", "write", "edit", "bash"]) {
      host.ctx.tools.register({
        name: toolName,
        description: toolName,
        readOnly: toolName === "read",
        parameters: { type: "object" },
        execute: () => textOutput(`${toolName} executed`),
      });
    }

    const manager = new PluginManager(host.ctx, {
      dataDir,
      version: "0.0.0-test",
      bundledPluginsDirs: [PLUGINS_ROOT],
    });
    disposers.push(async () => {
      await manager.dispose();
      await host.stop();
    });

    await manager.sync();
    return { host, manager, rpcHandlers, dataDir, workspaceDir };
  }

  it("executes question tool end-to-end (single-select, multi-select, recommended strip, history & rewind)", async () => {
    const { host, rpcHandlers, workspaceDir } = await setupHostWithPlugins();
    const session = host.ctx.sessions.create({ cwd: workspaceDir });
    const env = (): ToolEnv => ({
      sessionId: session.id,
      cwd: workspaceDir,
      signal: new AbortController().signal,
    });

    // 1. Verify system prompt guidance is injected when question tool is active
    const sysPrompt = await host.ctx.systemPrompt.build({
      sessionId: session.id,
      cwd: workspaceDir,
      model: { provider: "p", model: "m" },
      tools: host.ctx.tools.schemas(session.id),
    });
    expect(sysPrompt).toContain("Structured User Questions (`question`)");

    // 2. Attach simulated client UI answering multi-question (single + multi-select)
    let capturedEnvelopeRaw = "";
    const detachUi = host.ctx.ui.attach({
      request: ({ requestId, request }) => {
        if (request.kind === "input" && request.placeholder === QUESTION_PLACEHOLDER) {
          capturedEnvelopeRaw = request.title;
          const parsed = parseQuestionEnvelopeFromRequest({
            method: "input",
            title: request.title,
            placeholder: request.placeholder,
          });
          expect(parsed?.questions).toHaveLength(2);
          expect(parsed?.questions[0]?.options?.[0]).toMatchObject({
            label: "SQLite FTS5",
            recommended: true,
          });
          expect(parsed?.questions[1]?.multiple).toBe(true);

          queueMicrotask(() => {
            host.ctx.ui.respond(
              requestId,
              serializeQuestionResponse([
                {
                  id: "storage",
                  type: "select",
                  value: "SQLite FTS5",
                  label: "SQLite FTS5",
                },
                {
                  id: "platforms",
                  type: "select",
                  value: ["win", "mac"],
                  values: ["win", "mac"],
                  labels: ["Windows", "macOS"],
                },
              ]),
            );
          });
        }
      },
      cancel: () => {},
      notify: () => {},
    });
    disposers.push(detachUi);

    // Works even in Plan / read-only mode because question is readOnly: true!
    host.ctx.permissions.set(session, { agentMode: "plan" });

    const preRewindSeq = session.lastSeq;
    const output = await host.ctx.tools.execute(
      {
        id: "q-call-1",
        name: "question",
        args: {
          title: "技术栈确认",
          questions: [
            {
              id: "storage",
              header: "存储方案",
              question: "索引数据库使用哪种方案？",
              options: ["(Recommended) SQLite FTS5", "内存索引"],
            },
            {
              id: "platforms",
              header: "目标平台",
              question: "需要支持哪些桌面平台？",
              multiple: true,
              options: [
                { label: "Windows", value: "win", recommended: true },
                { label: "macOS", value: "mac" },
                { label: "Linux", value: "linux" },
              ],
            },
          ],
        },
      },
      env(),
    );

    expect(output.isError).not.toBe(true);
    expect(capturedEnvelopeRaw).toContain("__qianjiQuestion");
    const resultJson = JSON.parse((output.content[0] as { text: string }).text) as {
      status: string;
      answers: Array<{ id: string; answer: unknown; display: string }>;
    };
    expect(resultJson.status).toBe("answered");
    expect(resultJson.answers[0]).toMatchObject({ id: "storage", answer: "SQLite FTS5", display: "SQLite FTS5" });
    expect(resultJson.answers[1]).toMatchObject({
      id: "platforms",
      answer: ["win", "mac"],
      display: "Windows、macOS",
    });

    // 3. Verify `question.history` RPC & `/question` command, then rewind branch isolation
    const rpcCtx = { signal: new AbortController().signal, notify: () => {} };
    const histRes = (await rpcHandlers.get("question.history")?.({ sessionId: session.id }, rpcCtx)) as {
      records: Array<{ title?: string; status: string }>;
    };
    expect(histRes.records).toHaveLength(1);
    expect(histRes.records[0]?.title).toBe("技术栈确认");

    const cmdOut = await host.ctx.commands.run("question", "history", env());
    expect(cmdOut?.output).toContain("技术栈确认");
    expect(cmdOut?.output).toContain("Windows、macOS");

    session.append("rewind", { toSeq: preRewindSeq });
    const afterRewindHist = (await rpcHandlers.get("question.history")?.({ sessionId: session.id }, rpcCtx)) as {
      records: unknown[];
    };
    expect(afterRewindHist.records).toHaveLength(0);
  });

  it("enforces 4-way permission approvals, compound shell safety, hard caps, and request_permission mode elevation", async () => {
    const { host, manager, rpcHandlers, workspaceDir } = await setupHostWithPlugins();
    const session = host.ctx.sessions.create({ cwd: workspaceDir });
    const env = (): ToolEnv => ({
      sessionId: session.id,
      cwd: workspaceDir,
      signal: new AbortController().signal,
    });

    const promptsSeen: string[] = [];
    let nextDecision = serializePermissionResponse({ decision: "allow_once" });

    const detachUi = host.ctx.ui.attach({
      request: ({ requestId, request }) => {
        if (request.kind === "input" && request.placeholder === PERMISSION_PLACEHOLDER) {
          const envParsed = parsePermissionEnvelopeFromRequest({
            method: "input",
            title: request.title,
            placeholder: request.placeholder,
          });
          promptsSeen.push(envParsed?.title ?? "unknown");
          queueMicrotask(() => host.ctx.ui.respond(requestId, nextDecision));
        } else if (request.kind === "confirm") {
          promptsSeen.push(`fallback:${request.title}`);
          queueMicrotask(() => host.ctx.ui.respond(requestId, true));
        }
      },
      cancel: () => {},
      notify: () => {},
    });
    disposers.push(detachUi);

    // 1. Deny with custom user feedback -> returned directly in Denied message!
    nextDecision = serializePermissionResponse({
      decision: "deny",
      feedback: "不要运行全量构建，请只运行 npm test",
    });
    const deniedBash = await host.ctx.tools.execute(
      { id: "p1", name: "bash", args: { command: "npm run build" } },
      env(),
    );
    expect(deniedBash.isError).toBe(true);
    expect((deniedBash.content[0] as { text: string }).text).toContain("不要运行全量构建，请只运行 npm test");
    expect(promptsSeen).toEqual(["允许执行命令？"]);

    // 2. Allow for session (`allow_session`) on `npm run test`
    promptsSeen.length = 0;
    nextDecision = serializePermissionResponse({ decision: "allow_session" });
    const testRun1 = await host.ctx.tools.execute(
      { id: "p2", name: "bash", args: { command: "npm run test -- --run" } },
      env(),
    );
    expect(testRun1.isError).not.toBe(true);
    expect(promptsSeen).toHaveLength(1);

    // Subsequent `npm run test` in the same session skips prompt automatically!
    promptsSeen.length = 0;
    const testRun2 = await host.ctx.tools.execute(
      { id: "p3", name: "bash", args: { command: "npm run test packages/permissions" } },
      env(),
    );
    expect(testRun2.isError).not.toBe(true);
    expect(promptsSeen).toHaveLength(0);

    // Different npm script (`npm run deploy`) is NOT auto-approved by `npm run test`!
    nextDecision = serializePermissionResponse({ decision: "deny" });
    const deployRun = await host.ctx.tools.execute(
      { id: "p4", name: "bash", args: { command: "npm run deploy" } },
      env(),
    );
    expect(deployRun.isError).toBe(true);
    expect(promptsSeen).toHaveLength(1);

    // Compound command injection (`npm run test && rm -rf dist`) is NOT auto-approved!
    promptsSeen.length = 0;
    const compoundHazard = await host.ctx.tools.execute(
      { id: "p5", name: "bash", args: { command: "npm run test && rm -rf dist" } },
      env(),
    );
    expect(compoundHazard.isError).toBe(true);
    expect(promptsSeen).toHaveLength(1);

    // Hard caps (self-kill & force-push) STILL hard-block ahead of everything!
    promptsSeen.length = 0;
    const selfKill = await host.ctx.tools.execute(
      { id: "p6", name: "bash", args: { command: "taskkill /F /IM qianji.exe" } },
      env(),
    );
    expect(selfKill.isError).toBe(true);
    expect(promptsSeen).toHaveLength(0);

    // 3. Proactive `request_permission` from Plan mode -> elevates session to agent + workspace-write!
    host.ctx.permissions.set(session, { agentMode: "plan", permission: "ask" });
    expect(host.ctx.permissions.modes(session).effective).toBe("read-only");

    nextDecision = serializePermissionResponse({ decision: "allow_once" });
    const elevateRes = await host.ctx.tools.execute(
      {
        id: "p7",
        name: "request_permission",
        args: {
          scope: "mode",
          requestedAgentMode: "agent",
          requestedPermission: "workspace-write",
          reason: "方案已对齐，申请切入执行模式修改代码",
        },
      },
      env(),
    );
    expect(elevateRes.isError).not.toBe(true);
    expect(host.ctx.permissions.modes(session)).toEqual({
      agentMode: "agent",
      permission: "workspace-write",
      effective: "workspace-write",
    });

    // 4. Inspect & revoke grants via RPC and `/permission` command
    const rpcCtx = { signal: new AbortController().signal, notify: () => {} };
    const inspect1 = (await rpcHandlers.get("permissionPlugin.inspect")?.(
      { sessionId: session.id },
      rpcCtx,
    )) as { sessionGrants: Array<{ id: string; label: string }> };
    expect(inspect1.sessionGrants).toHaveLength(1);
    expect(inspect1.sessionGrants[0]?.label).toContain("npm run test");

    const statusCmd = await host.ctx.commands.run("permission", "status", env());
    expect(statusCmd?.output).toContain("workspace-write");
    expect(statusCmd?.output).toContain("npm run test");

    await host.ctx.commands.run("permission", "clear", env());
    const inspect2 = (await rpcHandlers.get("permissionPlugin.inspect")?.(
      { sessionId: session.id },
      rpcCtx,
    )) as { sessionGrants: unknown[] };
    expect(inspect2.sessionGrants).toHaveLength(0);

    // 5. Disabling `permission` plugin cleanly restores default `ctx.ui.confirm` fallback
    await manager.setEnabled("permission", false);
    promptsSeen.length = 0;
    const fallbackBash = await host.ctx.tools.execute(
      { id: "p8", name: "bash", args: { command: "echo hi" } },
      env(),
    );
    expect(fallbackBash.isError).not.toBe(true);
    expect(promptsSeen).toEqual(["fallback:允许执行命令？"]);
  });

  it("validates command prefix & compound rule matchers and notification envelope headlines", () => {
    expect(deriveCommandPrefix("npm run lint --fix")).toBe("npm run lint");
    expect(deriveCommandPrefix("git -C packages/host diff --stat")).toBe("git -C packages/host diff");
    expect(deriveCommandPrefix("npm test && rm -rf /")).toBeNull();
    expect(deriveCommandPrefix("echo secret > out.txt")).toBeNull();

    const grants = [
      { toolPattern: "bash|powershell", commandPrefix: "git status", label: "git status" },
      { toolPattern: "bash|powershell", commandPrefix: "git diff", label: "git diff" },
    ];
    expect(matchesGrantRules(grants, "bash", { command: "git status && git diff HEAD" }, "/repo")).toBeDefined();
    expect(matchesGrantRules(grants, "bash", { command: "git status && git clean -fd" }, "/repo")).toBeUndefined();
    expect(matchesGrantRules(grants, "bash", { command: "git diff > patch.diff" }, "/repo")).toBeUndefined();

    // Notification headlines & kinds
    const qEnv = normalizeQuestionnaireInput({ question: "选择目标环境？", options: ["Staging", "Prod"] });
    expect(qEnv).not.toBeNull();
    if (qEnv) {
      const qSerialized = serializeQuestionEnvelope(qEnv);
      expect(headlineForUiRequest("input", qSerialized, QIANJI_QUESTION_PLACEHOLDER)).toBe("选择目标环境？");
      const qPlan = uiRequestNotification(
        "rt-1",
        { type: "extension_ui_request", id: "r1", method: "input", title: qSerialized, placeholder: QIANJI_QUESTION_PLACEHOLDER },
        { cwd: "/repo", sessionFile: "harness:s1" },
        false,
      );
      expect(qPlan?.draft.kind).toBe("question");
      expect(qPlan?.draft.title).toBe("选择目标环境？");
    }

    const pSerialized = serializePermissionEnvelope({
      source: "tool_guard",
      title: "允许执行命令？",
      message: "npm test",
      riskLevel: "low",
      riskLabel: "低风险",
      showRiskBadge: true,
      allowSessionOption: true,
      allowAlwaysOption: true,
      allowDenyFeedback: true,
    });
    expect(headlineForUiRequest("input", pSerialized, QIANJI_PERMISSION_PLACEHOLDER)).toBe("允许执行命令？");
    const pPlan = uiRequestNotification(
      "rt-1",
      { type: "extension_ui_request", id: "r2", method: "input", title: pSerialized, placeholder: QIANJI_PERMISSION_PLACEHOLDER },
      { cwd: "/repo", sessionFile: "harness:s1" },
      true,
    );
    expect(pPlan?.draft.kind).toBe("approval");
    expect(pPlan?.draft.title).toBe("允许执行命令？");
  });

  it("mounts question & permission client plugins into SlotRegistry and renders approval & toolCall cards cleanly", async () => {
    const restoreDom = installMockDom();
    disposers.push(restoreDom);

    const slotRegistry = new SlotRegistry();
    const clientRoot = new Context();
    await clientRoot.plugin(ClientSlotsService, slotRegistry);
    await clientRoot.plugin(ClientStylesService);
    disposers.push(() => void clientRoot.fiber.dispose());
    disposers.push(() => slotRegistry.dispose());

    await clientRoot.plugin(questionClient);
    await clientRoot.plugin(permissionClient);

    // Verify chain election on conversation.approvalDialog
    const qEnvelope = normalizeQuestionnaireInput({
      title: "架构偏好",
      questions: [
        {
          id: "q1",
          header: "数据库",
          question: "使用哪种本地数据库？",
          multiple: true,
          options: [{ label: "SQLite", value: "sqlite", recommended: true }, { label: "DuckDB", value: "duckdb" }],
        },
      ],
    });
    expect(qEnvelope).not.toBeNull();
    if (!qEnvelope) throw new Error("expected normalized question envelope");
    const qReq = {
      type: "extension_ui_request" as const,
      id: "req-q-1",
      method: "input" as const,
      title: serializeQuestionEnvelope(qEnvelope),
      placeholder: QUESTION_PLACEHOLDER,
    };

    const qApprovalHtml = renderToStaticMarkup(
      createElement(
        SessionArea,
        { sessionId: "sess-ui-1" },
        createElement(SlotHost, {
          slotKey: "conversation.approvalDialog",
          kind: "chain",
          scope: "session",
          registry: slotRegistry,
          props: {
            cwd: "/demo",
            sessionFile: "harness:sess-ui-1",
            request: qReq,
            onAnswer: () => {},
          },
        }),
      ),
    );
    expect(qApprovalHtml).toContain("架构偏好");
    expect(qApprovalHtml).toContain("使用哪种本地数据库？");
    expect(qApprovalHtml).toContain("可多选");
    expect(qApprovalHtml).toContain("推荐");

    const pReq = {
      type: "extension_ui_request" as const,
      id: "req-p-1",
      method: "input" as const,
      title: serializePermissionEnvelope({
        source: "tool_guard",
        title: "允许修改文件？",
        message: "edit: src/app.ts\n```diff\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n```",
        toolName: "edit",
        targetPath: "src/app.ts",
        riskLevel: "medium",
        riskLabel: "常规变更 · 文件写入",
        showRiskBadge: true,
        suggestedGrant: { toolPattern: "write|edit", pathPrefix: "src", label: "src/ 目录文件编辑" },
        allowSessionOption: true,
        allowAlwaysOption: true,
        allowDenyFeedback: true,
      }),
      placeholder: PERMISSION_PLACEHOLDER,
    };

    const pApprovalHtml = renderToStaticMarkup(
      createElement(
        SessionArea,
        { sessionId: "sess-ui-1" },
        createElement(SlotHost, {
          slotKey: "conversation.approvalDialog",
          kind: "chain",
          scope: "session",
          registry: slotRegistry,
          props: {
            cwd: "/demo",
            sessionFile: "harness:sess-ui-1",
            request: pReq,
            onAnswer: () => {},
          },
        }),
      ),
    );
    expect(pApprovalHtml).toContain("允许修改文件？");
    expect(pApprovalHtml).toContain("本会话允许");
    expect(pApprovalHtml).toContain("始终允许");
    expect(pApprovalHtml).toContain("附言说明");
    expect(pApprovalHtml).toContain("+const a = 2;");

    // Verify keyed conversation.toolCall cards
    const qToolHtml = renderToStaticMarkup(
      createElement(
        SessionArea,
        { sessionId: "sess-ui-1" },
        createElement(SlotHost, {
          slotKey: "conversation.toolCall",
          kind: "keyed",
          scope: "session",
          routeKey: "question",
          registry: slotRegistry,
          props: {
            call: {
              id: "tc-1",
              name: "question",
              args: { question: "部署区域？" },
              result: JSON.stringify({
                status: "answered",
                answers: [{ id: "q1", question: "部署区域？", answer: "ap-east", display: "亚太东部" }],
              }),
            },
            state: "ok",
          },
        }),
      ),
    );
    expect(qToolHtml).toContain("部署区域？");
    expect(qToolHtml).toContain("亚太东部");
    expect(QuestionApprovalCard).toBeDefined();
    expect(QuestionToolCallCard).toBeDefined();
    expect(PermissionApprovalCard).toBeDefined();
    expect(PermissionToolCallCard).toBeDefined();
  });
});
