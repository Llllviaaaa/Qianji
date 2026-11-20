/**
 * Canonical metadata & live inspection row builder for the Core Slot Ownership
 * & Conflict Governance UI (`SlotOwnershipPanel`, ADR 0023 §5.3).
 */
import { CORE_SLOT_CATALOG, type CoreSlotMetadata } from "@qianji/protocol";
import {
  CORE_SLOT_SPECS,
  type AbdicationRecord,
  type ChildSlotDecl,
  type CoreSlotKey,
  type PluginTier,
  type SlotCandidateSummary,
  type SlotKind,
  type SlotRegistry,
  type SlotScope,
} from "@qianji/client-slots";

export interface CoreSlotDescriptorMeta {
  readonly defaultOwner: string;
  readonly description: string;
}

export const CORE_SLOT_METADATA_MAP: Readonly<Record<CoreSlotKey, CoreSlotDescriptorMeta>> = {
  root: { defaultOwner: "core-shell", description: "应用微内核唯一根槽位，承载桌面外壳、侧边栏、主舞台、工作台与设置中心" },
  "shell.menubar": { defaultOwner: "core-shell", description: "顶部窗口标题栏与文件/编辑/视图/帮助/工具菜单栏" },
  "shell.sidebar": { defaultOwner: "core-sidebar", description: "左侧主导航、工作区分组与会话列表侧边栏" },
  "shell.topbar": { defaultOwner: "core-shell", description: "主舞台顶部会话标题、导航历史与操作栏" },
  "shell.stage": { defaultOwner: "core-shell", description: "主舞台路由选择器链（首页 / 对话流 / 内置中心页 / 插件全屏页）" },
  "shell.workbench.right": { defaultOwner: "core-workbench", description: "右侧分屏工作台容器（平铺网格、编辑器、审查、预览与扩展面板）" },
  "shell.workbench.bottom": { defaultOwner: "core-workbench", description: "底部集成终端与输出抽屉容器" },
  "shell.statusbar": { defaultOwner: "core-shell", description: "窗口底部全局状态栏扩展微件列表（支持左右对齐）" },
  "shell.overlays": { defaultOwner: "core-shell", description: "全局浮层/桌宠容器（根层默认 pointer-events: none）" },
  "shell.modals": { defaultOwner: "core-shell", description: "全局模态弹窗栈（含设置中心与扩展模态框）" },
  "sidebar.header": { defaultOwner: "core-sidebar", description: "左侧栏顶部新建任务按钮与工作区快捷操作区" },
  "sidebar.nav": { defaultOwner: "core-sidebar", description: "左侧栏主导航入口列表（定时任务、插件中心与插件全屏页）" },
  "sidebar.threads": { defaultOwner: "core-sidebar", description: "左侧栏工作区分组会话列表区域" },
  "sidebar.sessionRow": { defaultOwner: "core-sidebar", description: "单条会话记录行渲染器选择器链" },
  "sidebar.sections": { defaultOwner: "core-sidebar", description: "左侧栏会话列表下方常驻扩展卡片分区列表" },
  "sidebar.footer": { defaultOwner: "core-sidebar", description: "左侧栏底部设置入口与账户/状态栏" },
  "home.hero": { defaultOwner: "core-home", description: "新任务欢迎页顶部视觉主标题与工作区选择器" },
  "home.quickActions": { defaultOwner: "core-home", description: "新任务首页快捷启动指令胶囊列表" },
  "home.sections": { defaultOwner: "core-home", description: "新任务首页底部扩展内容分区列表" },
  "conversation.header": { defaultOwner: "core-conversation", description: "对话流顶部会话状态横幅与上下文提示条列表" },
  "conversation.transcript": { defaultOwner: "core-conversation", description: "绑定会话的消息流容器与自动滚动区域" },
  "conversation.turn": { defaultOwner: "core-conversation", description: "单个问答轮次分组容器选择器链" },
  "conversation.message": { defaultOwner: "core-conversation", description: "单条用户/助手消息气泡渲染器选择器链" },
  "conversation.message.actions": { defaultOwner: "core-conversation", description: "单条消息底部悬浮操作按钮扩展列表" },
  "conversation.thinking": { defaultOwner: "core-conversation", description: "推理思考链与工作步骤折叠块渲染器链" },
  "conversation.toolCall": { defaultOwner: "core-conversation", description: "按工具名或前缀通配路由的自定义工具调用卡片" },
  "conversation.markdown.codeBlock": { defaultOwner: "core-conversation", description: "按围栏语言路由的 Markdown 代码块渲染器" },
  "conversation.turnFooter": { defaultOwner: "core-conversation", description: "轮次底部耗时、用量与扩展注脚列表" },
  "conversation.composerDock": { defaultOwner: "core-conversation", description: "对话流底部输入栏停靠容器" },
  "conversation.approvalDialog": { defaultOwner: "core-conversation", description: "工具权限与扩展交互审批弹窗选择器链" },
  "composer.main": { defaultOwner: "core-composer", description: "消息输入栏主控制器链（支持 overlay 无卸载临时接管）" },
  "composer.banners": { defaultOwner: "core-composer", description: "输入栏上方上下文/排队消息提示条列表" },
  "composer.attachments": { defaultOwner: "core-composer", description: "输入栏待发送图片与文件附件预览条" },
  "composer.input": { defaultOwner: "core-composer", description: "富文本/多行输入框与斜杠命令补全控件" },
  "composer.toolbar": { defaultOwner: "core-composer", description: "输入栏左下角工具按钮与快捷能力列表" },
  "composer.status": { defaultOwner: "core-composer", description: "输入栏右下角模型选择器两侧状态微件列表" },
  "workbench.topbarControls": { defaultOwner: "core-workbench", description: "窗口顶部菜单栏右侧的工作台面板开关与扩展按钮列表" },
  "workbench.tilingGrid": { defaultOwner: "core-workbench", description: "右侧工作台可拆分拖拽平铺布局网格" },
  "workbench.panes": { defaultOwner: "core-workbench", description: "按 paneId 路由的右侧工作台功能面板集合" },
  "workbench.fileViewer": { defaultOwner: "core-workbench", description: "按文件扩展名或 MIME 类型路由的文件预览器" },
  "workbench.inspector.sections": { defaultOwner: "core-workbench", description: "工作台检查器侧栏扩展分区列表" },
  "workbench.bottom.tabs": { defaultOwner: "core-workbench", description: "按 tabId 路由的底部终端/输出抽屉标签页" },
  "settings.shell": { defaultOwner: "core-settings", description: "设置中心弹窗/独立页框架与左侧分类导航" },
  "settings.pages": { defaultOwner: "core-settings", description: "设置中心按键路由的内置与扩展独立设置页" },
  "settings.sections": { defaultOwner: "core-settings", description: "追加至内置或扩展设置页底部的卡片分区列表" },
  "hub.pages": { defaultOwner: "core-hubs", description: "主舞台全屏中心页与插件独立功能页路由槽位" },
};

const PROTOCOL_CATALOG_BY_ID = new Map<string, CoreSlotMetadata>(
  CORE_SLOT_CATALOG.map((entry) => [entry.id, entry]),
);

const CORE_SLOT_KEYS = Object.keys(CORE_SLOT_SPECS) as CoreSlotKey[];
const CORE_SLOT_SPEC_LOOKUP = CORE_SLOT_SPECS as Readonly<Record<string, ChildSlotDecl | undefined>>;
const CORE_SLOT_META_LOOKUP = CORE_SLOT_METADATA_MAP as Readonly<Record<string, CoreSlotDescriptorMeta | undefined>>;

export interface EnrichedSlotCandidate extends SlotCandidateSummary {
  readonly abdicationRecord?: AbdicationRecord;
}

export interface SlotOwnershipRow {
  readonly slotKey: string;
  readonly kind: SlotKind;
  readonly scope: SlotScope;
  readonly isCore: boolean;
  readonly defaultOwner: string;
  readonly description: string;
  readonly override?: string;
  readonly winner?: EnrichedSlotCandidate;
  readonly candidates: readonly EnrichedSlotCandidate[];
  readonly wrapperIds: readonly string[];
  readonly isTakeoverCapable: boolean;
  readonly isExternallyOwned: boolean;
  readonly hasAbdication: boolean;
}

export type SlotFilterKind = "all" | "takeover" | "external" | "abdicated";

export function formatTierLabel(tier: PluginTier): string {
  if (tier === "workspace") return "工作区";
  if (tier === "user") return "用户";
  return "内置";
}

export function formatSlotKindLabel(kind: SlotKind): string {
  switch (kind) {
    case "single":
      return "single";
    case "chain":
      return "chain";
    case "keyed":
      return "keyed";
    case "list":
      return "list";
  }
}

export function formatScopeLabel(scope: SlotScope): string {
  switch (scope) {
    case "root":
      return "root";
    case "session":
      return "session";
    case "session-maybe":
      return "session-maybe";
  }
}

/**
 * Merge every canonical `CORE_SLOT_SPECS` entry with all live slots reported by
 * `registry.inspectAllSlots()` (including custom third-party slots).
 */
export function buildSlotOwnershipRows(
  registry: SlotRegistry,
  overrides: Readonly<Record<string, string>>,
): SlotOwnershipRow[] {
  const liveInspections = registry.inspectAllSlots();
  const liveByKey = new Map(liveInspections.map((item) => [item.slotKey, item]));

  const orderedKeys: string[] = [...CORE_SLOT_KEYS];
  const seen = new Set<string>(CORE_SLOT_KEYS);
  const dynamicKeys: string[] = [];
  for (const item of liveInspections) {
    if (!seen.has(item.slotKey)) {
      seen.add(item.slotKey);
      dynamicKeys.push(item.slotKey);
    }
  }
  dynamicKeys.sort((a, b) => a.localeCompare(b));
  orderedKeys.push(...dynamicKeys);

  return orderedKeys.map((slotKey): SlotOwnershipRow => {
    const liveSpec = registry.getSlotSpec(slotKey);
    const coreSpec = CORE_SLOT_SPEC_LOOKUP[slotKey];
    const isCore = coreSpec !== undefined;
    const inspection = liveByKey.get(slotKey) ?? registry.inspectSlot(slotKey);
    const kind: SlotKind = liveSpec?.kind ?? coreSpec?.kind ?? inspection.kind;
    const scope: SlotScope = liveSpec?.scope ?? coreSpec?.scope ?? inspection.scope;

    const rawCandidates: readonly SlotCandidateSummary[] =
      kind === "list" && liveSpec === undefined && coreSpec !== undefined
        ? registry.getListEntries(slotKey).map((entry) => ({
            id: entry.id,
            pluginId: entry.pluginId,
            tier: entry.tier,
            priority: entry.priority,
            order: entry.order,
            abdicated: registry.abdication.isAbdicated(slotKey, entry.id, entry.pluginId),
          }))
        : inspection.candidates;

    const candidates: EnrichedSlotCandidate[] = rawCandidates.map((cand) => {
      const record = registry.abdication.getRecord(slotKey, cand.id);
      return record === undefined ? cand : { ...cand, abdicationRecord: record };
    });

    const winner = kind === "list" ? undefined : candidates.find((cand) => !cand.abdicated);
    const override = overrides[slotKey] ?? inspection.override;
    const coreMeta = CORE_SLOT_META_LOOKUP[slotKey];
    const protocolMeta = PROTOCOL_CATALOG_BY_ID.get(slotKey);
    const description =
      liveSpec?.description
      ?? coreMeta?.description
      ?? protocolMeta?.summary
      ?? "第三方插件动态声明的自定义扩展槽位";
    const defaultOwner =
      coreMeta?.defaultOwner
      ?? protocolMeta?.defaultOwner
      ?? (candidates[0]?.pluginId ?? "外部插件");

    const isTakeoverCapable = kind === "single" || kind === "chain";
    const isExternallyOwned = winner !== undefined && winner.tier !== "builtin";
    const hasAbdication = candidates.some((cand) => cand.abdicated);

    return {
      slotKey,
      kind,
      scope,
      isCore,
      defaultOwner,
      description,
      ...(override === undefined ? {} : { override }),
      ...(winner === undefined ? {} : { winner }),
      candidates,
      wrapperIds: inspection.wrapperIds,
      isTakeoverCapable,
      isExternallyOwned,
      hasAbdication,
    };
  });
}

export function filterSlotOwnershipRows(
  rows: readonly SlotOwnershipRow[],
  filter: SlotFilterKind,
  query: string,
): SlotOwnershipRow[] {
  const needle = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter === "takeover" && !row.isTakeoverCapable) return false;
    if (filter === "external" && !row.isExternallyOwned) return false;
    if (filter === "abdicated" && !row.hasAbdication) return false;
    if (needle === "") return true;
    const haystack = [
      row.slotKey,
      row.description,
      row.defaultOwner,
      row.kind,
      row.scope,
      row.override ?? "",
      row.winner?.pluginId ?? "",
      ...row.candidates.flatMap((c) => [c.pluginId, c.id, c.abdicationRecord?.reason ?? ""]),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}
