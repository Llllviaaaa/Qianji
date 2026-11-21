/**
 * Regression test suite for the ADR 0023 frontend parity audit fixes:
 * - ComposerService sessionId / sessionFile / "active" key alias resolution
 * - ThemeService `@layer components` `<style>` injection + `"page"` default display mode
 * - WorkspaceService + NavigationService `draftWorkspace` sync & `hidden` project preservation
 * - SessionService multi-runtime `runningSessionFiles` / `approvalSessionFiles`
 * - diagram-viewer `isStreaming` guard preventing per-token Mermaid/PlantUML flicker
 * - CoreSettingsShell native `settings.pages` routing (no `plugin:` prefix mismatch)
 * - inspectorHelpers `derivePlanSteps` parsing `update_plan` `items` schema
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreSettingsPlugin } from "../src/builtin-plugins/core-settings";
import { derivePlanSteps } from "../src/builtin-plugins/core-workbench/inspectorHelpers";
import { diagramViewerPlugin } from "../src/builtin-plugins/diagram-viewer";
import { registerFrontendServices } from "../src/kernel/services";
import { ClientSlotsService, SlotHost, SlotKernelProvider, SlotRegistry } from "../src/kernel/slots";
import { SlotStoreRegistry } from "../src/kernel/store";
import { useAppStore } from "../src/store";
import type { UiMessage } from "../src/types";

describe("Frontend microkernel parity regressions", () => {
  let root: Context;
  let registry: SlotRegistry;
  let disposeServices: () => Promise<void>;

  beforeEach(async () => {
    useAppStore.setState({
      cwd: "",
      sessionId: null,
      sessionFile: null,
      messages: [],
      isStreaming: false,
      extensionRequest: null,
      runtimes: {},
      managedFollowUpQueue: [],
      steeringQueue: [],
      followUpQueue: [],
      composerPrefill: null,
      settings: null,
    });
    root = new Context();
    registry = new SlotRegistry({ stores: new SlotStoreRegistry() });
    const slotsFiber = root.plugin(ClientSlotsService, registry);
    await slotsFiber;
    await registerFrontendServices(root, { shortcutTarget: null });
    disposeServices = async () => {
      await slotsFiber.dispose();
      registry.dispose();
    };
  });

  afterEach(async () => {
    await disposeServices();
    useAppStore.setState({
      cwd: "",
      sessionId: null,
      sessionFile: null,
      messages: [],
      isStreaming: false,
      extensionRequest: null,
      runtimes: {},
      managedFollowUpQueue: [],
      composerPrefill: null,
    });
  });

  it("resolves ComposerService active session across sessionId, sessionFile, 'active', and omitted keys", () => {
    useAppStore.setState({
      sessionId: "sess-123",
      sessionFile: "harness://sess-123",
      managedFollowUpQueue: [
        { id: "q-1", text: "queued follow-up", attachments: [], createdAt: Date.now() },
      ],
      composerPrefill: "prefilled prompt",
    });

    for (const key of [undefined, "active", "sess-123", "harness://sess-123"]) {
      const snap = root.composerService.getSnapshot(key);
      expect(snap.managedFollowUpQueue).toHaveLength(1);
      expect(snap.managedFollowUpQueue[0]?.text).toBe("queued follow-up");
      expect(snap.prefill).toBe("prefilled prompt");
    }

    root.composerService.setDraft("hello draft", "sess-123");
    expect(root.composerService.getDraft("harness://sess-123")).toBe("hello draft");
    expect(root.composerService.getDraft("active")).toBe("hello draft");

    expect(root.composerService.consumePrefill("sess-123")).toBe("prefilled prompt");
    expect(root.composerService.getSnapshot("harness://sess-123").prefill).toBeNull();
  });

  it("injects ThemeService CSS variables into @layer components <style> when document.head exists and defaults to page mode", () => {
    expect(root.themeService.getSnapshot().settingsDisplayMode).toBe("page");

    const removedProps: string[] = [];
    const appended: Array<{ id: string; textContent: string }> = [];
    const byId = new Map<string, { id: string; textContent: string }>();
    const fakeRoot = {
      dataset: {} as Record<string, string>,
      style: {
        fontFamily: "",
        color: "",
        background: "",
        setProperty() {},
        removeProperty(name: string) {
          removedProps.push(name);
        },
      },
    };
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        documentElement: fakeRoot,
        head: {
          appendChild(el: { id: string; textContent: string }) {
            appended.push(el);
            byId.set(el.id, el);
            return el;
          },
        },
        createElement() {
          return { id: "", textContent: "" };
        },
        getElementById(id: string) {
          return byId.get(id) ?? null;
        },
      },
    });
    try {
      root.themeService.applyToDocument();
      expect(appended).toHaveLength(1);
      expect(appended[0]?.id).toBe("qianji-active-theme-vars");
      expect(appended[0]?.textContent).toContain("@layer components");
      expect(appended[0]?.textContent).toContain("--qj-brand-primary:");
      expect(removedProps).toContain("--qj-brand-primary");
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: originalDocument,
      });
    }
  });

  it("syncs draftWorkspace across WorkspaceService and NavigationService and preserves it across hub dismissal", () => {
    root.workspaceService.selectWorkspace("D:\\work\\alpha");
    expect(root.workspaceService.getSnapshot().draftWorkspace).toBe("D:\\work\\alpha");

    root.navigationService.navigate({ kind: "home", workspace: "D:\\work\\beta" });
    expect(root.workspaceService.getSnapshot().draftWorkspace).toBe("D:\\work\\beta");

    root.navigationService.navigate({ kind: "hub", view: "plugins" });
    root.navigationService.setHubView(null);
    expect(root.workspaceService.getSnapshot().draftWorkspace).toBe("D:\\work\\beta");

    root.workspaceService.clearDraftWorkspace();
    expect(root.workspaceService.getSnapshot().draftWorkspace).toBe("");
  });

  it("exposes multi-runtime runningSessionFiles and approvalSessionFiles on SessionServiceSnapshot", () => {
    useAppStore.setState({
      sessionFile: "harness://s-active",
      isStreaming: true,
      runtimes: {
        "rt-1": {
          runtimeId: "rt-1",
          cwd: "D:\\repo",
          sessionFile: "harness://s-bg-run",
          isStreaming: true,
          status: "running",
          extensionRequest: null,
          updatedAt: Date.now(),
        },
        "rt-2": {
          runtimeId: "rt-2",
          cwd: "D:\\repo",
          sessionFile: "harness://s-bg-approve",
          isStreaming: false,
          status: "running",
          extensionRequest: {
            type: "extension_ui_request",
            id: "req-1",
            method: "confirm",
            title: "Allow tool?",
            message: "Confirm tool run",
          },
          updatedAt: Date.now(),
        },
      },
    });

    const snap = root.sessionService.getSnapshot();
    expect(snap.runningSessionFiles).toContain("harness://s-active");
    expect(snap.runningSessionFiles).toContain("harness://s-bg-run");
    expect(snap.approvalSessionFiles).toContain("harness://s-bg-approve");
  });

  it("guards diagram-viewer code blocks while streaming to prevent per-token flicker", async () => {
    registry.defineSlot("conversation.markdown.codeBlock", { kind: "keyed", scope: "session" });
    const fiber = root.plugin(diagramViewerPlugin, {});
    await fiber;

    try {
      const streamingHtml = renderToStaticMarkup(
        createElement(
          SlotKernelProvider,
          { registry, ctx: root },
          createElement(SlotHost, {
            slotKey: "conversation.markdown.codeBlock",
            kind: "keyed",
            scope: "session",
            routeKey: "mermaid",
            sessionId: "s-1",
            props: { language: "mermaid", code: "graph TD\n  A -->", isStreaming: true },
          }),
        ),
      );
      expect(streamingHtml).toContain("diagram-streaming-fence");
      expect(streamingHtml).not.toContain("diagram-block");
    } finally {
      await fiber.dispose();
    }
  });

  it("routes native settings.pages plugin entries without bouncing back to general", async () => {
    registry.defineSlot("shell.modals", { kind: "list", scope: "root" });
    const fiber = root.plugin(coreSettingsPlugin);
    await fiber;
    const disposePage = registry.register("settings.pages", {
      id: "acme-tool-page",
      pluginId: "acme-plugin",
      tier: "user",
      key: "acme-tool",
      component: () => createElement("div", { "data-testid": "acme-settings-body" }, "ACME Native Settings"),
    });

    try {
      root.navigationService.openSettings("acme-tool");
      const html = renderToStaticMarkup(
        createElement(
          SlotKernelProvider,
          { registry, ctx: root },
          createElement(SlotHost, { slotKey: "shell.modals", kind: "list", scope: "root" }),
        ),
      );
      expect(html).toContain("ACME Native Settings");
      expect(html).toContain('data-active-settings-page="acme-tool"');
      expect(html).toContain('class="settings-center is-page"');
      expect(html).not.toContain("settings-modal ");
    } finally {
      disposePage();
      await fiber.dispose();
    }
  });

  it("parses update_plan items schema in inspectorHelpers.derivePlanSteps", () => {
    const messages: UiMessage[] = [
      {
        id: "m-1",
        role: "assistant",
        content: "",
        timestamp: Date.now(),
        toolCalls: [
          {
            id: "tc-1",
            name: "update_plan",
            running: false,
            args: {
              items: [
                { text: "Audit regressions", status: "completed" },
                { text: "Ship fix PR", status: "in_progress" },
              ],
            },
          },
        ],
      },
    ];
    const steps = derivePlanSteps(messages);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.text).toBe("Audit regressions");
    expect(steps[0]?.status).toBe("completed");
    expect(steps[1]?.text).toBe("Ship fix PR");
    expect(steps[1]?.status).toBe("in_progress");
  });
});
