import { fileURLToPath } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { Sessions } from "@qianji/session";
import { Tools, type ToolOutput } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import { Mcp, type Config, type McpServerConfig } from "../src/index.ts";

const fixture = fileURLToPath(new URL("./fake-server.mjs", import.meta.url));
let ctx: Context | undefined;

afterEach(async () => {
  await ctx?.fiber.dispose();
  ctx = undefined;
});

const server = (overrides: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: "fixture", name: "Fixture", enabled: true, transport: "stdio", command: process.execPath, args: [fixture],
  cwd: "", env: {}, inheritEnvironment: false, url: "", headers: {}, trustedReadOnly: false, ...overrides,
});

async function setup(config: Config, options: { answer?: boolean; mode?: string } = {}) {
  ctx = new Context();
  await ctx.plugin(Sessions);
  await ctx.plugin(Ui);
  await ctx.plugin(Tools);
  const mode = options.mode;
  if (mode !== undefined) ctx.provide("permissions", { modes: () => ({ effective: mode }) });
  const asked: string[] = [];
  const notes: string[] = [];
  const answer = options.answer;
  const local = ctx;
  if (answer !== undefined) {
    local.ui.attach({
      request: ({ requestId, request }) => {
        asked.push(request.kind === "confirm" ? request.title : request.kind);
        queueMicrotask(() => local.ui.respond(requestId, answer));
      },
      cancel: () => {},
      notify: (_session, message) => void notes.push(message),
    });
  }
  await local.plugin(Mcp, config);
  await local.mcp.ready;
  const session = local.sessions.create({ cwd: "." });
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolOutput> =>
    local.tools.execute({ id: "1", name, args }, { sessionId: session.id, cwd: ".", signal: new AbortController().signal });
  const text = (output: ToolOutput) => output.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  return { ctx: local, session, call, text, asked, notes };
}

describe("MCP plugin", () => {
  it("registers remote tools and calls them after confirmation", async () => {
    const { ctx: c, call, text, asked } = await setup({ servers: [server()] }, { answer: true });
    expect(c.tools.schemas().map((schema) => schema.name)).toEqual([
      "mcp__fixture__echo", "mcp__fixture__fail", "mcp_get_prompt", "mcp_list_prompts", "mcp_list_resources",
      "mcp_read_resource", "mcp_subscribe_resource", "mcp_unsubscribe_resource",
    ]);
    expect(text(await call("mcp__fixture__echo", { text: "hi" }))).toBe("echo: hi");
    expect(asked).toEqual(["允许 MCP 工具？Fixture"]);
    const failed = await call("mcp__fixture__fail");
    expect([failed.isError, text(failed)]).toEqual([true, "it broke"]);
    expect(c.mcp.statuses()).toMatchObject([{ connected: true, toolCount: 2, protocolVersion: "2025-11-25", hasResources: true, hasPrompts: true }]);
  });

  it("refuses when the user says no or nobody can answer", async () => {
    const declined = await setup({ servers: [server()] }, { answer: false });
    expect(declined.text(await declined.call("mcp__fixture__echo", { text: "hi" }))).toBe("用户拒绝了 MCP 工具调用");
    await ctx?.fiber.dispose();
    const headless = await setup({ servers: [server()] });
    expect(headless.text(await headless.call("mcp_list_resources"))).toBe("用户拒绝了 MCP 资源读取");
  });

  it("reads resources and prompts, and reports subscribed updates", async () => {
    const { call, text, notes } = await setup({ servers: [server()], confirmTools: false }, { answer: true });
    expect(text(await call("mcp_list_resources"))).toContain("URI: `fixture://note`");
    expect(text(await call("mcp_read_resource", { uri: "fixture://note" }))).toBe("资源：fixture://note\n\nnote v1");
    expect(text(await call("mcp_get_prompt", { name: "review", arguments: { path: "a.ts" } }))).toContain("Review a.ts");
    await call("mcp_subscribe_resource", { uri: "fixture://note" });
    await expect.poll(() => notes).toEqual(["MCP 资源已更新 · Fixture\nfixture://note"]);
    expect(text(await call("mcp_unsubscribe_resource", { uri: "fixture://note" }))).toContain("已取消订阅");
  });

  it("keeps read-only sessions to trusted servers", async () => {
    const untrusted = await setup({ servers: [server()] }, { answer: true, mode: "read-only" });
    expect(untrusted.text(await untrusted.call("mcp_list_resources"))).toBe("只读模式只允许访问已标记为受信任只读的 MCP 服务器");
    await ctx?.fiber.dispose();
    const trusted = await setup({ servers: [server({ trustedReadOnly: true })] }, { answer: true, mode: "read-only" });
    expect(trusted.text(await trusted.call("mcp_list_resources"))).toContain("fixture://note");
    expect(trusted.asked).toEqual([]);
  });

  it("records servers that fail to start", async () => {
    const { ctx: c } = await setup({ servers: [server({ id: "broken", command: process.execPath, args: ["-e", "process.exit(3)"] }), server({ id: "off", enabled: false })] });
    expect(c.mcp.statuses()).toMatchObject([{ config: { id: "broken" }, connected: false }]);
    expect(c.tools.schemas()).toEqual([]);
  });

  it("hot-refreshes remote tools on notifications/tools/list_changed without restarting", async () => {
    const { ctx: c, call, text } = await setup({ servers: [server()], confirmTools: false }, { answer: true });
    let changedEvents = 0;
    c.on("mcp/changed", () => {
      changedEvents += 1;
    });

    expect(c.tools.schemas().map((schema) => schema.name)).not.toContain("mcp__fixture__added_live");
    await call("mcp__fixture__echo", { text: "__emit_tools_changed__" });

    await expect.poll(() => c.tools.schemas().map((schema) => schema.name)).toContain("mcp__fixture__added_live");
    expect(c.mcp.statuses()[0]?.toolCount).toBe(3);
    expect(changedEvents).toBeGreaterThan(0);
    expect(text(await call("mcp__fixture__added_live"))).toBe("live-ok");
  });

  it("auto-reconnects after unexpected server exit and supports direct resource/prompt inspection", async () => {
    const { ctx: c, call, text } = await setup(
      { servers: [server()], confirmTools: false, reconnectDelaysMs: [40, 80] },
      { answer: true },
    );

    const resources = await c.mcp.listAllResources("fixture");
    expect(resources).toMatchObject([{ serverId: "fixture", uri: "fixture://note" }]);
    const readRes = await c.mcp.readServerResource("fixture", "fixture://note");
    expect(readRes.serverId).toBe("fixture");
    expect(readRes.uri).toBe("fixture://note");
    expect(readRes.text).toContain("note v1");
    const prompts = await c.mcp.listAllPrompts("fixture");
    expect(prompts).toMatchObject([{ serverId: "fixture", name: "review" }]);
    expect((await c.mcp.getServerPrompt("fixture", "review", { path: "index.ts" })).markdown).toContain("Review index.ts");

    // Trigger unexpected child exit and wait for automatic backoff reconnect.
    await call("mcp__fixture__echo", { text: "__exit_now__" });
    await expect.poll(() => c.mcp.statuses()[0]?.connected, { timeout: 4_000 }).toBe(true);
    expect(text(await call("mcp__fixture__echo", { text: "after-crash" }))).toBe("echo: after-crash");

    // Manual reconnect also succeeds cleanly.
    const reconnected = await c.mcp.reconnect("fixture");
    expect(reconnected[0]?.connected).toBe(true);
    expect(text(await call("mcp__fixture__echo", { text: "after-manual" }))).toBe("echo: after-manual");
  });

  it("defers server tools behind activate_tools when deferTools is enabled", async () => {
    const { ctx: c, session, call, text } = await setup(
      { servers: [server({ deferTools: true })], confirmTools: false },
      { answer: true },
    );

    // Unfiltered introspection (used by host/UI/tests) still exposes every registered tool.
    expect(c.tools.schemas().map((schema) => schema.name)).toContain("mcp__fixture__echo");

    // Session-scoped model view collapses deferred server tools under mcp_fixture group.
    const sessionSchemas = c.tools.schemas(session.id);
    const sessionNames = sessionSchemas.map((schema) => schema.name);
    expect(sessionNames).not.toContain("mcp__fixture__echo");
    expect(sessionNames).not.toContain("mcp__fixture__fail");
    const activator = sessionSchemas.find((schema) => schema.name === "activate_tools");
    expect(activator?.description).toContain('mcp_fixture (2 tools: MCP tools from server "fixture")');

    // Activating the server group exposes its tools in subsequent session schemas and executes cleanly.
    const activated = text(await call("activate_tools", { names: ["mcp_fixture"] }));
    expect(activated).toContain("mcp__fixture__echo");
    expect(c.tools.schemas(session.id).map((schema) => schema.name)).toContain("mcp__fixture__echo");
    expect(text(await call("mcp__fixture__echo", { text: "deferred-ok" }))).toBe("echo: deferred-ok");
  });

  it("auto-defers servers exposing > 8 tools and respects config/server deferTools overrides", async () => {
    const manyToolsScript = [
      'const rl = require("node:readline").createInterface({ input: process.stdin, crlfDelay: Infinity });',
      'const tools = Array.from({ length: 9 }, (_, i) => ({ name: "tool_" + (i + 1), description: "Tool " + (i + 1), inputSchema: { type: "object" } }));',
      'const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");',
      'rl.on("line", (line) => {',
      '  if (!line.trim()) return;',
      '  const msg = JSON.parse(line);',
      '  if (msg.id === undefined) return;',
      '  if (msg.method === "initialize") return reply(msg.id, { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "many", version: "1.0.0" } });',
      '  if (msg.method === "tools/list") return reply(msg.id, { tools });',
      '  if (msg.method === "tools/call") return reply(msg.id, { content: [{ type: "text", text: "ran:" + msg.params.name }] });',
      '  reply(msg.id, {});',
      '});',
    ].join("\n");

    // 1. Default config (deferTools unset): >8 tool server auto-defers while <=8 tool server stays eager.
    const autoOnly = await setup(
      {
        servers: [
          server({ id: "many", name: "Many", args: ["-e", manyToolsScript] }),
          server({ id: "small", name: "Small" }),
        ],
        confirmTools: false,
      },
      { answer: true },
    );

    expect(autoOnly.ctx.tools.schemas().filter((schema) => schema.name.startsWith("mcp__many__"))).toHaveLength(9);
    const autoSessionSchemas = autoOnly.ctx.tools.schemas(autoOnly.session.id);
    const autoNames = autoSessionSchemas.map((schema) => schema.name);
    expect(autoNames).toContain("mcp__small__echo");
    expect(autoNames).not.toContain("mcp__many__tool_1");
    const autoActivator = autoSessionSchemas.find((schema) => schema.name === "activate_tools");
    expect(autoActivator?.description).toContain('mcp_many (9 tools: MCP tools from server "many")');
    expect(autoActivator?.description).not.toContain("mcp_small");
    expect(autoOnly.text(await autoOnly.call("mcp__many__tool_9"))).toBe("ran:tool_9");

    // 2. Explicit server deferTools: false overrides both config.deferTools: true and the >8 tool threshold.
    await ctx?.fiber.dispose();
    const overridden = await setup(
      {
        servers: [
          server({ id: "many_eager", name: "ManyEager", args: ["-e", manyToolsScript], deferTools: false }),
          server({ id: "cfg_deferred", name: "CfgDeferred" }),
        ],
        confirmTools: false,
        deferTools: true,
      },
      { answer: true },
    );
    const overrideSchemas = overridden.ctx.tools.schemas(overridden.session.id);
    const overrideNames = overrideSchemas.map((schema) => schema.name);
    expect(overrideNames).toContain("mcp__many_eager__tool_1");
    expect(overrideNames).toContain("mcp__many_eager__tool_9");
    expect(overrideNames).not.toContain("mcp__cfg_deferred__echo");
    expect(overrideSchemas.find((schema) => schema.name === "activate_tools")?.description).toContain(
      'mcp_cfg_deferred (2 tools: MCP tools from server "cfg_deferred")',
    );
  });
});
