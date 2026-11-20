/**
 * Core Slot Ownership & Conflict Governance UI (`SlotOwnershipPanel`, ADR 0023 §5.3).
 *
 * Subscribes live to `ctx.slots.registry`, `useSlotOverrides()`, and `useSafeMode()`
 * so users can search/filter every core and custom slot, inspect abdication errors,
 * pin winning plugins, restore defaults, and exit Safe Mode.
 */
import { useCallback, useMemo, useState, useSyncExternalStore, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { AlertTriangle, Layers, Pin, RotateCcw, Search, ShieldAlert, Sparkles } from "lucide-react";
import {
  useClientContext,
  useFrontendService,
  useSafeMode,
  useSlotOverrides,
  type SafeModeReason,
  type SafeModeSnapshot,
} from "@qianji/client";
import { ClientSlotsService, clientSlotsRegistry, type SlotRegistry } from "@qianji/client-slots";
import { Badge, Button, Card, Input } from "@qianji/client-primitives";
import {
  buildSlotOwnershipRows,
  filterSlotOwnershipRows,
  type SlotFilterKind,
} from "./slotCatalogMetadata";
import { SlotCardRow } from "./SlotCardRow";

export interface SafeModeControlLike {
  getSnapshot(): SafeModeSnapshot;
  subscribe(listener: () => void): () => void;
  disable(): void;
  toggle?(reason?: SafeModeReason): boolean;
}

export interface SlotOwnershipPanelProps {
  /** Optional explicit `SlotRegistry` (defaults to `ctx.slots.registry` or singleton `clientSlotsRegistry`). */
  readonly registry?: SlotRegistry;
  /** Optional Cordis context to resolve `slots` and `navigationService`. */
  readonly ctx?: Context;
  /** Optional Safe Mode controller override (defaults to global `useSafeMode()`). */
  readonly safeModeControl?: SafeModeControlLike;
  /** Optional callback to exit Safe Mode directly. */
  readonly onExitSafeMode?: () => void;
}

const NOOP_UNSUB = (): void => undefined;

function describeSafeModeReason(reason: SafeModeReason | null): string {
  switch (reason) {
    case "query":
      return "通过 URL 参数 (?safeMode=1) 启动安全模式，外部用户与工作区插件已暂停。";
    case "window-flag":
      return "通过命令行启动参数 (--safe-mode) 进入安全模式，仅运行内置核心层。";
    case "session-storage":
      return "当前会话已保持安全模式状态，全部外部客户端插件暂未挂载。";
    case "hotkey":
      return "已通过急救快捷键 (Ctrl+Shift+Alt+R) 进入安全模式，外部插件已暂停。";
    case "manual":
    case null:
      return "当前处于安全模式，所有外部客户端插件已暂停，仅保留内置核心槽位。";
  }
}

function resolveRegistryFromContext(ctx: Context | undefined): SlotRegistry | undefined {
  if (ctx === undefined || typeof ctx.get !== "function") return undefined;
  const slots = ctx.get("slots");
  if (slots instanceof ClientSlotsService) return slots.registry;
  if (typeof slots === "object" && slots !== null && "registry" in slots) {
    return (slots as { registry: SlotRegistry }).registry;
  }
  return undefined;
}

function resolveSafeModeControlFromContext(ctx: Context | undefined): SafeModeControlLike | undefined {
  if (ctx === undefined || typeof ctx.get !== "function") return undefined;
  const candidate = ctx.get("safeMode");
  if (
    typeof candidate === "object"
    && candidate !== null
    && "disable" in candidate
    && "getSnapshot" in candidate
    && "subscribe" in candidate
  ) {
    return candidate as SafeModeControlLike;
  }
  return undefined;
}

function dispatchSafeModeExitHotkey(): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  const EventCtor = typeof KeyboardEvent === "function" ? KeyboardEvent : Event;
  const event = new EventCtor("keydown", {
    bubbles: true,
    cancelable: true,
    ...(EventCtor === KeyboardEvent
      ? { key: "r", code: "KeyR", ctrlKey: true, shiftKey: true, altKey: true }
      : {}),
  });
  if (EventCtor !== KeyboardEvent) {
    Object.assign(event, { key: "r", code: "KeyR", ctrlKey: true, shiftKey: true, altKey: true });
  }
  window.dispatchEvent(event);
}

export function SlotOwnershipPanel({
  registry: explicitRegistry,
  ctx: explicitCtx,
  safeModeControl: explicitSafeModeControl,
  onExitSafeMode,
}: SlotOwnershipPanelProps = {}): ReactElement {
  const ambientCtx = useClientContext(explicitCtx);
  const resolvedCtx = explicitCtx ?? ambientCtx;
  const navigationService = useFrontendService("navigationService", resolvedCtx);
  const registry = useMemo(
    () => explicitRegistry ?? resolveRegistryFromContext(resolvedCtx) ?? clientSlotsRegistry,
    [explicitRegistry, resolvedCtx],
  );

  const registryVersion = useSyncExternalStore(
    registry.subscribe,
    registry.getVersion,
    registry.getVersion,
  );
  const slotOverrides = useSlotOverrides(registry.overrides);

  const safeModeControl = useMemo(
    () => explicitSafeModeControl ?? resolveSafeModeControlFromContext(resolvedCtx),
    [explicitSafeModeControl, resolvedCtx],
  );
  const globalSafeMode = useSafeMode();
  const subscribeSafeMode = useCallback(
    (listener: () => void) => (safeModeControl === undefined ? NOOP_UNSUB : safeModeControl.subscribe(listener)),
    [safeModeControl],
  );
  const getSafeModeSnap = useCallback(
    () => (safeModeControl === undefined ? undefined : safeModeControl.getSnapshot()),
    [safeModeControl],
  );
  const customSafeMode = useSyncExternalStore(subscribeSafeMode, getSafeModeSnap, getSafeModeSnap);
  const safeMode = customSafeMode ?? globalSafeMode;

  const [searchQuery, setSearchQuery] = useState("");
  const [filterKind, setFilterKind] = useState<SlotFilterKind>("all");

  const allRows = useMemo(() => {
    void registryVersion;
    return buildSlotOwnershipRows(registry, slotOverrides);
  }, [registry, registryVersion, slotOverrides]);

  const filteredRows = useMemo(
    () => filterSlotOwnershipRows(allRows, filterKind, searchQuery),
    [allRows, filterKind, searchQuery],
  );

  const stats = useMemo(() => {
    let takeoverCount = 0;
    let externalCount = 0;
    let abdicatedCount = 0;
    for (const row of allRows) {
      if (row.isTakeoverCapable) takeoverCount += 1;
      if (row.isExternallyOwned) externalCount += 1;
      if (row.hasAbdication) abdicatedCount += 1;
    }
    return {
      total: allRows.length,
      takeoverCount,
      externalCount,
      abdicatedCount,
      overrideCount: Object.keys(slotOverrides).length,
    };
  }, [allRows, slotOverrides]);

  const handleSetOverride = useCallback(
    (slotKey: string, pluginId: string): void => {
      registry.overrides.set(slotKey, pluginId);
      navigationService?.showToast(`已锁定槽位 ${slotKey} 由 ${pluginId} 接管`, "info");
    },
    [registry, navigationService],
  );

  const handleClearOverride = useCallback(
    (slotKey: string): void => {
      registry.overrides.clear(slotKey);
      navigationService?.showToast(`已恢复槽位 ${slotKey} 默认选举规则`, "info");
    },
    [registry, navigationService],
  );

  const handleClearAllOverrides = useCallback((): void => {
    registry.overrides.resetAll();
    navigationService?.showToast("已全部恢复核心槽位默认接管", "info");
  }, [registry, navigationService]);

  const handleExitSafeMode = useCallback((): void => {
    if (onExitSafeMode !== undefined) {
      onExitSafeMode();
      return;
    }
    if (safeModeControl !== undefined) {
      safeModeControl.disable();
      return;
    }
    if (safeMode.active) {
      dispatchSafeModeExitHotkey();
    }
  }, [onExitSafeMode, safeModeControl, safeMode.active]);

  const filterPills: ReadonlyArray<{ readonly id: SlotFilterKind; readonly label: string; readonly count: number }> = [
    { id: "all", label: "全部", count: stats.total },
    { id: "takeover", label: "可接管单槽位 (single/chain)", count: stats.takeoverCount },
    { id: "external", label: "已被外部接管", count: stats.externalCount },
    { id: "abdicated", label: "存在异常退让", count: stats.abdicatedCount },
  ];

  return (
    <div data-testid="slot-ownership-panel" style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {safeMode.active && (
        <div
          role="alert"
          data-testid="slots-safe-mode-banner"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "10px",
            padding: "12px 14px",
            borderRadius: "var(--qj-radius-md)",
            background: "color-mix(in srgb, var(--qj-status-warning) 14%, var(--qj-bg-surface))",
            border: "1px solid color-mix(in srgb, var(--qj-status-warning) 42%, transparent)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0, flex: "1 1 260px" }}>
            <ShieldAlert size={18} style={{ color: "var(--qj-status-warning)", flexShrink: 0 }} />
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              <strong style={{ fontSize: "13px", color: "var(--qj-text-primary)" }}>安全模式已启用</strong>
              <span style={{ fontSize: "12px", color: "var(--qj-text-secondary)" }}>
                {describeSafeModeReason(safeMode.reason)}
              </span>
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="primary"
            data-testid="slots-exit-safe-mode"
            onClick={handleExitSafeMode}
          >
            退出安全模式
          </Button>
        </div>
      )}

      <Card variant="subtle" padding="md">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <Badge variant="neutral">
              <Layers size={11} />
              已声明槽位 {stats.total}
            </Badge>
            <Badge variant={stats.externalCount > 0 ? "brand" : "neutral"}>
              <Sparkles size={11} />
              外部接管 {stats.externalCount}
            </Badge>
            <Badge variant={stats.overrideCount > 0 ? "brand" : "neutral"}>
              <Pin size={11} />
              手动锁定 {stats.overrideCount}
            </Badge>
            <Badge variant={stats.abdicatedCount > 0 ? "danger" : "neutral"}>
              <AlertTriangle size={11} />
              异常退让 {stats.abdicatedCount}
            </Badge>
          </div>

          {stats.overrideCount > 0 && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              data-testid="slots-reset-all-overrides"
              onClick={handleClearAllOverrides}
            >
              <RotateCcw size={12} />
              <span>全部恢复默认接管</span>
            </Button>
          )}
        </div>
      </Card>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
          <Search
            size={14}
            aria-hidden="true"
            style={{ position: "absolute", left: "11px", color: "var(--qj-text-muted)", pointerEvents: "none" }}
          />
          <Input
            type="search"
            data-testid="slots-search-input"
            aria-label="搜索槽位键、插件 ID 或描述"
            placeholder="搜索槽位键、插件 ID 或描述…"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            style={{ paddingLeft: "32px" }}
          />
        </div>

        <div role="group" aria-label="槽位筛选条件" style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
          {filterPills.map((pill) => {
            const active = filterKind === pill.id;
            return (
              <Button
                key={pill.id}
                type="button"
                size="sm"
                variant={active ? "primary" : "secondary"}
                data-testid={`slots-filter-${pill.id}`}
                aria-pressed={active}
                onClick={() => setFilterKind(pill.id)}
              >
                <span>{pill.label}</span>
                <span style={{ opacity: 0.78, fontVariantNumeric: "tabular-nums" }}>({pill.count})</span>
              </Button>
            );
          })}
        </div>
      </div>

      {filteredRows.length === 0 ? (
        <Card variant="subtle" padding="lg" data-testid="slots-empty-state">
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "8px", textAlign: "center", color: "var(--qj-text-secondary)" }}>
            <span style={{ fontSize: "13px" }}>没有匹配当前筛选条件的槽位</span>
            {(searchQuery !== "" || filterKind !== "all") && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                data-testid="slots-reset-filters"
                onClick={() => {
                  setSearchQuery("");
                  setFilterKind("all");
                }}
              >
                重置筛选条件
              </Button>
            )}
          </div>
        </Card>
      ) : (
        <div data-testid="slots-list" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {filteredRows.map((row) => (
            <SlotCardRow
              key={row.slotKey}
              row={row}
              onSetOverride={handleSetOverride}
              onClearOverride={handleClearOverride}
            />
          ))}
        </div>
      )}
    </div>
  );
}
