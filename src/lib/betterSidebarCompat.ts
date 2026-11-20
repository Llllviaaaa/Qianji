/**
 * Lightweight compatibility shim for external client-only plugins declaring
 * `inject: ["betterSidebar"]` or importing `"dsh-better-sidebar"`. Maps tab
 * and file viewer contributions directly into `ClientContributionRegistry`
 * with zero legacy DSH bundle weight.
 */
import type { ReactNode } from "react";
import { Context, Service } from "@deepseek-ai/cordis";
import {
  ClientContributionRegistry,
  clientContributions,
} from "./clientContributions";
import { resolveContextPluginId } from "./clientPluginRuntime";
import { HARNESS_SESSION_PREFIX, isHarnessSessionFile } from "./harnessRuntime";
import { useAppStore } from "../store";
import { useWorkbenchStore } from "../stores/workbenchStore";

declare module "@deepseek-ai/cordis" {
  interface Context {
    betterSidebar: BetterSidebarCompatService;
  }
}

export interface LegacySidebarTabDescriptor {
  id: string;
  title?: string | (() => string);
  label?: string;
  icon?: ReactNode | ((size: number) => ReactNode);
  order?: number;
  bottomOnly?: boolean;
  component?: (props: Record<string, unknown>) => ReactNode;
  render?: (props: Record<string, unknown>) => ReactNode;
}

export interface LegacyFileViewerDescriptor {
  id: string;
  title?: string | (() => string);
  label?: string;
  extensions?: readonly string[];
  mimeTypes?: readonly string[];
  order?: number;
  component?: (props: Record<string, unknown>) => ReactNode;
  render?: (props: Record<string, unknown>) => ReactNode;
}

export class BetterSidebarCompatService extends Service {
  static provide = "betterSidebar";
  readonly version = "0.26.0";
  readonly features = ["openFile", "targetedOpen", "fileViewer"] as const;
  private readonly registry: ClientContributionRegistry;

  constructor(ctx: Context, registry: ClientContributionRegistry = clientContributions) {
    super(ctx, "betterSidebar");
    this.registry = registry;
  }

  registerTab(descriptor: LegacySidebarTabDescriptor): () => void {
    const callerCtx = this.ctx;
    const pluginId = resolveContextPluginId(callerCtx);
    const resolveLabel = (): string => {
      if (typeof descriptor.title === "function") return descriptor.title();
      if (typeof descriptor.title === "string" && descriptor.title !== "") return descriptor.title;
      return descriptor.label || descriptor.id;
    };
    const icon = typeof descriptor.icon === "function" ? descriptor.icon(14) : descriptor.icon;
    const contribution = {
      id: descriptor.id,
      ...(pluginId === undefined ? {} : { pluginId }),
      label: resolveLabel(),
      ...(icon === undefined ? {} : { icon }),
      ...(descriptor.order === undefined ? {} : { order: descriptor.order }),
      render: ({ cwd, sessionFile }: { cwd: string; sessionFile: string | null }): ReactNode => {
        const sessionId = sessionFile && isHarnessSessionFile(sessionFile)
          ? sessionFile.slice(HARNESS_SESSION_PREFIX.length)
          : "";
        const props = {
          ctx: callerCtx,
          cwd,
          sessionFile,
          scope: { sessionId, cwd },
          tab: { id: descriptor.id, type: descriptor.id, title: resolveLabel() },
          visible: true,
          onOpenFile: (path: string) => {
            void useWorkbenchStore.getState().openFile(cwd, path);
          },
        };
        if (typeof descriptor.component === "function") return descriptor.component(props);
        if (typeof descriptor.render === "function") return descriptor.render(props);
        return null;
      },
    };
    const rawDispose = descriptor.bottomOnly
      ? this.registry.registerBottomPanelTab(contribution)
      : this.registry.registerRightWorkbenchTab(contribution);
    let disposed = false;
    const once = () => {
      if (disposed) return;
      disposed = true;
      rawDispose();
    };
    return callerCtx.effect(() => once);
  }

  registerFileViewer(descriptor: LegacyFileViewerDescriptor): () => void {
    if (typeof descriptor !== "object" || descriptor === null || typeof descriptor.id !== "string") {
      return () => undefined;
    }
    const callerCtx = this.ctx;
    const pluginId = resolveContextPluginId(callerCtx);
    const resolveLabel = (): string => {
      if (typeof descriptor.title === "function") return descriptor.title();
      if (typeof descriptor.title === "string" && descriptor.title !== "") return descriptor.title;
      return descriptor.label || descriptor.id;
    };
    const rawDispose = this.registry.registerFileViewer({
      id: descriptor.id,
      ...(pluginId === undefined ? {} : { pluginId }),
      label: resolveLabel(),
      ...(descriptor.extensions === undefined ? {} : { extensions: descriptor.extensions }),
      ...(descriptor.mimeTypes === undefined ? {} : { mimeTypes: descriptor.mimeTypes }),
      ...(descriptor.order === undefined ? {} : { order: descriptor.order }),
      render: (fileCtx) => {
        const props = {
          ctx: callerCtx,
          ...fileCtx,
        };
        if (typeof descriptor.component === "function") return descriptor.component(props);
        if (typeof descriptor.render === "function") return descriptor.render(props);
        return null;
      },
    });
    let disposed = false;
    const once = () => {
      if (disposed) return;
      disposed = true;
      rawDispose();
    };
    return callerCtx.effect(() => once);
  }

  registerFileIcon(_descriptor: unknown): () => void {
    return () => {};
  }

  openFile(scope: { cwd?: string } | undefined, path: string): void {
    const cwd = scope?.cwd || useAppStore.getState().cwd;
    void useWorkbenchStore.getState().openFile(cwd, path);
  }

  openTab(seed: { type?: string; id?: string; path?: string }, scope?: { cwd?: string }): void {
    if (typeof seed.path === "string" && seed.path !== "") {
      const cwd = scope?.cwd || useAppStore.getState().cwd;
      void useWorkbenchStore.getState().openFile(cwd, seed.path);
      return;
    }
    const target = seed.type ?? seed.id;
    if (typeof target === "string" && target !== "") {
      useWorkbenchStore.getState().openTab(target);
    }
  }

  closeTab(_tabId: string): void {}
  activateTab(tabId: string): void {
    useWorkbenchStore.getState().openTab(tabId);
  }
  subscribe(_listener: () => void): () => void {
    return () => {};
  }
  subscribeState(_listener: () => void): () => void {
    return () => {};
  }
  getSnapshot(): Record<string, unknown> {
    return {};
  }
}

export const betterSidebarCompatModule = {
  BetterSidebarCompatService,
  SIDEBAR_SERVICE_VERSION: "0.26.0",
};
