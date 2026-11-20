/**
 * Individual slot row card for `SlotOwnershipPanel` (`src/builtin-plugins/core-settings/SlotCardRow.tsx`).
 */
import { useMemo, type ReactElement } from "react";
import { AlertTriangle, Pin, RotateCcw } from "lucide-react";
import type { PluginTier, SlotKind } from "@qianji/client-slots";
import { Badge, Button, Card, Select, type BadgeVariant, type SelectOption } from "@qianji/client-primitives";
import {
  formatScopeLabel,
  formatSlotKindLabel,
  formatTierLabel,
  type EnrichedSlotCandidate,
  type SlotOwnershipRow,
} from "./slotCatalogMetadata";

function kindBadgeVariant(kind: SlotKind): BadgeVariant {
  if (kind === "single") return "brand";
  if (kind === "chain") return "warning";
  if (kind === "keyed") return "success";
  return "neutral";
}

function tierBadgeVariant(tier: PluginTier): BadgeVariant {
  if (tier === "workspace") return "warning";
  if (tier === "user") return "brand";
  return "neutral";
}

function uniquePluginCandidates(candidates: readonly EnrichedSlotCandidate[]): EnrichedSlotCandidate[] {
  const seen = new Set<string>();
  const unique: EnrichedSlotCandidate[] = [];
  for (const cand of candidates) {
    if (seen.has(cand.pluginId)) continue;
    seen.add(cand.pluginId);
    unique.push(cand);
  }
  return unique;
}

export interface SlotCardRowProps {
  readonly row: SlotOwnershipRow;
  readonly onSetOverride: (slotKey: string, pluginId: string) => void;
  readonly onClearOverride: (slotKey: string) => void;
}

export function SlotCardRow({ row, onSetOverride, onClearOverride }: SlotCardRowProps): ReactElement {
  const distinctCandidates = useMemo(() => uniquePluginCandidates(row.candidates), [row.candidates]);
  const abdicatedCandidates = useMemo(
    () => row.candidates.filter((cand) => cand.abdicated),
    [row.candidates],
  );
  const canOverride =
    row.kind === "single"
    || row.kind === "chain"
    || (row.kind === "keyed" && distinctCandidates.length > 1)
    || row.override !== undefined;

  const selectOptions = useMemo<SelectOption[]>(
    () => [
      { value: "", label: "自动选举（默认优先级）" },
      ...distinctCandidates.map((cand) => ({
        value: cand.pluginId,
        label: `${cand.pluginId} (${formatTierLabel(cand.tier)} · P${cand.priority})${cand.abdicated ? " [已退让]" : ""}`,
      })),
      ...(row.override !== undefined && !distinctCandidates.some((c) => c.pluginId === row.override)
        ? [{ value: row.override, label: `${row.override}（已锁定 · 当前未挂载）` }]
        : []),
    ],
    [distinctCandidates, row.override],
  );

  return (
    <Card
      variant="default"
      padding="md"
      data-testid={`slot-row-${row.slotKey}`}
      data-slot-key={row.slotKey}
      data-slot-kind={row.kind}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        borderColor: row.hasAbdication
          ? "color-mix(in srgb, var(--qj-status-danger) 42%, var(--qj-border-default))"
          : row.override !== undefined
            ? "color-mix(in srgb, var(--qj-brand-primary) 42%, var(--qj-border-default))"
            : undefined,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "10px",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "4px", minWidth: 0, flex: "1 1 280px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
            <code
              style={{
                fontFamily: "var(--qj-font-mono)",
                fontSize: "12.5px",
                fontWeight: 600,
                color: "var(--qj-text-primary)",
                background: "var(--qj-bg-subtle)",
                padding: "2px 7px",
                borderRadius: "var(--qj-radius-sm)",
              }}
            >
              {row.slotKey}
            </code>
            <Badge variant={kindBadgeVariant(row.kind)}>{formatSlotKindLabel(row.kind)}</Badge>
            <Badge variant="neutral">{formatScopeLabel(row.scope)}</Badge>
            {!row.isCore && <Badge variant="brand">自定义槽位</Badge>}
            {row.override !== undefined && (
              <Badge variant="brand" data-testid={`slot-override-badge-${row.slotKey}`}>
                <Pin size={10} />
                已锁定: {row.override}
              </Badge>
            )}
            {row.hasAbdication && (
              <Badge variant="danger" data-testid={`slot-abdication-badge-${row.slotKey}`}>
                <AlertTriangle size={10} />
                异常退让 ({abdicatedCandidates.length})
              </Badge>
            )}
          </div>
          <p style={{ margin: 0, fontSize: "12.5px", color: "var(--qj-text-secondary)", lineHeight: 1.45 }}>
            {row.description}
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0, flexWrap: "wrap" }}>
          {row.winner !== undefined ? (
            <>
              <span style={{ fontSize: "12px", color: "var(--qj-text-muted)" }}>当前接管:</span>
              <strong
                data-testid={`slot-winner-${row.slotKey}`}
                style={{ fontSize: "12.5px", fontFamily: "var(--qj-font-mono)", color: "var(--qj-text-primary)" }}
              >
                {row.winner.pluginId}
              </strong>
              <Badge variant={tierBadgeVariant(row.winner.tier)} data-testid={`slot-winner-tier-${row.slotKey}`}>
                {row.winner.tier}
              </Badge>
            </>
          ) : row.kind === "list" ? (
            <span style={{ fontSize: "12px", color: "var(--qj-text-secondary)" }}>
              已注册 {row.candidates.length} 项贡献
            </span>
          ) : (
            <span style={{ fontSize: "12px", color: "var(--qj-text-muted)" }}>
              默认归属: {row.defaultOwner}（待挂载）
            </span>
          )}
          {row.wrapperIds.length > 0 && <Badge variant="neutral">包裹器 ×{row.wrapperIds.length}</Badge>}
        </div>
      </div>

      {abdicatedCandidates.length > 0 && (
        <div
          role="alert"
          data-testid={`slot-abdication-detail-${row.slotKey}`}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "4px",
            padding: "8px 10px",
            borderRadius: "var(--qj-radius-sm)",
            background: "color-mix(in srgb, var(--qj-status-danger) 10%, transparent)",
            border: "1px solid color-mix(in srgb, var(--qj-status-danger) 28%, transparent)",
            fontSize: "12px",
            color: "var(--qj-status-danger)",
          }}
        >
          {abdicatedCandidates.map((cand) => {
            const reason = cand.abdicationRecord?.reason || cand.abdicationRecord?.error?.message || "渲染异常已自动退让";
            const fallbackNote = cand.abdicationRecord?.fallbackPluginId
              ? `（已回退至 ${cand.abdicationRecord.fallbackPluginId}）`
              : "";
            return (
              <div key={cand.id} style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                <AlertTriangle size={12} />
                <strong>{cand.pluginId}</strong>
                <span>退让原因: {reason}{fallbackNote}</span>
              </div>
            );
          })}
        </div>
      )}

      {canOverride && (distinctCandidates.length > 0 || row.override !== undefined) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            flexWrap: "wrap",
            paddingTop: "8px",
            borderTop: "1px solid var(--qj-border-subtle)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", flex: "1 1 260px" }}>
            <span style={{ fontSize: "11.5px", color: "var(--qj-text-muted)" }}>候选插件:</span>
            {distinctCandidates.map((cand) => {
              const isWinner = row.winner?.pluginId === cand.pluginId;
              const isPinned = row.override === cand.pluginId;
              return (
                <Button
                  key={cand.pluginId}
                  type="button"
                  size="sm"
                  variant={isPinned ? "primary" : isWinner ? "secondary" : "ghost"}
                  data-testid={`slot-pin-${row.slotKey}-${cand.pluginId}`}
                  aria-pressed={isPinned}
                  disabled={cand.abdicated}
                  onClick={() => onSetOverride(row.slotKey, cand.pluginId)}
                  title={
                    cand.abdicated
                      ? `${cand.pluginId} 当前已因异常退让`
                      : `锁定 ${cand.pluginId} 为 ${row.slotKey} 胜出插件`
                  }
                >
                  <span>{cand.pluginId}</span>
                  <Badge variant={tierBadgeVariant(cand.tier)}>{cand.tier}</Badge>
                </Button>
              );
            })}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
            <div style={{ minWidth: "188px" }}>
              <Select
                aria-label={`指定 ${row.slotKey} 胜出插件`}
                data-testid={`slot-override-select-${row.slotKey}`}
                value={row.override ?? ""}
                options={selectOptions}
                onValueChange={(next) => {
                  if (next === "") {
                    onClearOverride(row.slotKey);
                  } else {
                    onSetOverride(row.slotKey, next);
                  }
                }}
              />
            </div>
            {row.override !== undefined && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                data-testid={`slot-clear-override-${row.slotKey}`}
                onClick={() => onClearOverride(row.slotKey)}
              >
                <RotateCcw size={12} />
                <span>恢复默认</span>
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
