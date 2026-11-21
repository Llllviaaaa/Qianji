/**
 * Host-owned shell & conversation auxiliary UI factories
 * (`src/kernel/primitives/hostShellFactories.tsx`, ADR 0023).
 *
 * Bridges production `<GitActionButton>` + `<CommitDialog>`,
 * `<SessionChangeCard>` (session-scoped diff stats, confirm restore, AI review),
 * `<ExtensionDialog>` (autoFocus + BatchAskDialog), and `<LivePlanBar>`
 * into built-in core plugins via `renderFactory(...)`.
 */
import { createElement, useCallback, useMemo, useState, type ReactElement } from "react";
import type {
  ClientSlotsService,
  SlotComponentProps,
  SlotFactorySpec,
  SlotRegistry,
} from "@qianji/client-slots";
import { CommitDialog, type CommitOutcome } from "../../components/CommitDialog";
import { ExtensionDialog } from "../../components/ExtensionDialog";
import { GitActionButton } from "../../components/GitActionButton";
import { LivePlanBar } from "../../components/LivePlanBar";
import { SessionChangeCard } from "../../components/SessionChangeCard";
import { agent } from "../../lib/agent";
import { describeError } from "../../lib/errors";
import { perFileDiffStats } from "../../lib/gitDiffStats";
import { changesEditedBy, sessionEditedPaths } from "../../lib/sessionEdits";
import { useAppStore } from "../../store";
import { useWorkbenchStore } from "../../stores/workbenchStore";
import type { ExtensionUIRequest } from "../../types";
import { useWorkbenchPaneAvailable } from "../runtime/featureSlotQueries";

const HOST_FACTORIES_PLUGIN_ID = "core-host-factories";

export interface HostGitActionFactoryProps {
  readonly cwd?: string;
}

export interface HostSessionChangeCardFactoryProps {
  readonly cwd?: string;
}

export interface HostApprovalDialogFactoryProps {
  readonly request: ExtensionUIRequest;
  readonly onAnswer: (requestId: string, value: unknown) => void;
}

declare module "@qianji/client-slots" {
  interface SlotFactoryMap {
    "host.shell.gitAction": SlotFactorySpec<HostGitActionFactoryProps, "root">;
    "host.conversation.sessionChangeCard": SlotFactorySpec<HostSessionChangeCardFactoryProps, "root">;
    "host.conversation.approvalDialog": SlotFactorySpec<HostApprovalDialogFactoryProps, "root">;
    "host.conversation.livePlanBar": SlotFactorySpec<Record<string, never>, "root">;
  }
}

function HostGitActionFactory({
  cwd: ownerCwd,
  ctx,
}: SlotComponentProps<HostGitActionFactoryProps, "root">): ReactElement | null {
  const storeCwd = useAppStore((s) => s.cwd);
  const git = useAppStore((s) => s.git);
  const model = useAppStore((s) => s.model);
  const isStreaming = useAppStore((s) => s.isStreaming);
  const workspaceCwd = (ownerCwd && ownerCwd.trim() !== "" ? ownerCwd : storeCwd).trim();

  const [commitDialog, setCommitDialog] = useState<{ push: boolean } | null>(null);
  const [pushing, setPushing] = useState(false);

  const refreshGit = useCallback(async () => {
    const ws = ctx?.get("workspaceService");
    if (ws !== undefined) {
      await ws.refreshGit(workspaceCwd || undefined).catch(() => undefined);
    } else {
      await useAppStore.getState().refreshGit().catch(() => undefined);
    }
  }, [ctx, workspaceCwd]);

  const handleFinishCommit = useCallback(
    (outcome: CommitOutcome) => {
      setCommitDialog(null);
      const committed = `已提交 ${outcome.commit.shortSha}：${outcome.commit.subject}`;
      const push = outcome.push;
      if (push && "error" in push) {
        useAppStore.getState().showToast(`${committed}。推送失败：${push.error}`, "error");
      } else if (push) {
        useAppStore.getState().showToast(
          `${committed}，已推送到 ${push.result.remote}/${push.result.branch}`,
          "info",
        );
      } else {
        useAppStore.getState().showToast(committed, "info");
      }
      void refreshGit();
    },
    [refreshGit],
  );

  const handlePush = useCallback(async () => {
    if (workspaceCwd === "" || pushing) return;
    setPushing(true);
    try {
      const result = await agent.gitPush(workspaceCwd);
      useAppStore.getState().showToast(
        result.setUpstream
          ? `已发布 ${result.branch} 到 ${result.remote}`
          : `已推送到 ${result.remote}/${result.branch}`,
        "info",
      );
    } catch (error) {
      useAppStore.getState().showToast(`推送失败：${describeError(error)}`, "error");
    } finally {
      setPushing(false);
      void refreshGit();
    }
  }, [pushing, refreshGit, workspaceCwd]);

  if (workspaceCwd === "" || git === null) return null;

  return (
    <>
      <GitActionButton
        git={git}
        pushing={pushing}
        onCommit={(push) => setCommitDialog({ push })}
        onPush={() => void handlePush()}
      />
      {commitDialog !== null && (
        <CommitDialog
          cwd={workspaceCwd}
          git={git}
          initialPush={commitDialog.push}
          model={model ? { provider: model.provider, id: model.id } : null}
          agentRunning={isStreaming}
          onClose={() => setCommitDialog(null)}
          onDone={handleFinishCommit}
        />
      )}
    </>
  );
}

function HostSessionChangeCardFactory({
  cwd: ownerCwd,
  ctx,
}: SlotComponentProps<HostSessionChangeCardFactoryProps, "root">): ReactElement | null {
  const storeCwd = useAppStore((s) => s.cwd);
  const git = useAppStore((s) => s.git);
  const messages = useAppStore((s) => s.messages);
  const settings = useAppStore((s) => s.settings);
  const codeReviewEnabled = useWorkbenchPaneAvailable("review");

  const workspaceCwd = (ownerCwd && ownerCwd.trim() !== "" ? ownerCwd : storeCwd).trim();
  const sessionFiles = useMemo(() => {
    if (git === null || git.files.length === 0) return [];
    const edited = sessionEditedPaths(messages);
    return changesEditedBy(git.files, edited);
  }, [git, messages]);
  const stats = useMemo(() => perFileDiffStats(git?.diff), [git?.diff]);

  const handleOpenFile = useCallback(
    (path: string) => {
      if (workspaceCwd === "") return;
      void useWorkbenchStore.getState().openFile(workspaceCwd, path);
    },
    [workspaceCwd],
  );

  const handleRestore = useCallback(async () => {
    if (workspaceCwd === "" || sessionFiles.length === 0) return;
    const paths = sessionFiles.map((file) => file.path);
    const label = paths.length === 1 ? paths[0] : `${paths.length} 个文件`;
    if (typeof window !== "undefined" && !window.confirm(`撤销对 ${label} 的本地更改？未提交的改动将丢失。`)) {
      return;
    }
    try {
      await agent.gitRestoreFiles(workspaceCwd, paths);
      await useAppStore.getState().refreshGit();
      useAppStore.getState().showToast("已撤销本地更改", "info");
    } catch (error) {
      useAppStore.getState().showToast(describeError(error), "error");
    }
  }, [sessionFiles, workspaceCwd]);

  const handleRequestReview = useCallback(async () => {
    if (settings?.reviewDelivery === "detached") {
      const current = useAppStore.getState();
      const targetWs = current.cwd || workspaceCwd;
      current.prepareNewTask();
      if (targetWs !== "") await useAppStore.getState().connect(targetWs);
    }
    const prompt = [
      "审查当前未提交的代码更改，包括已暂存、未暂存和未跟踪文件。",
      "只报告由这些更改引入、作者明确会修复的离散问题，重点检查正确性、回归风险、安全性和缺失测试；按严重程度列出发现。没有可操作问题时请直接说明。",
      "需要定位到具体改动行的意见，请另起一行输出 ::code-comment{title=\"[P1] 简短标题\" body=\"问题、触发场景和修复方向\" file=\"相对或绝对文件路径\" start=行号 end=行号 priority=1}。正文保持普通 Markdown，不要输出 JSON。",
    ].join("\n\n");
    const sent = await useAppStore.getState().sendMessage(prompt);
    if (sent) {
      ctx?.get("navigationService")?.setDraftMode(false);
    }
  }, [ctx, settings?.reviewDelivery, workspaceCwd]);

  if (sessionFiles.length === 0) return null;

  return (
    <SessionChangeCard
      files={sessionFiles}
      stats={stats}
      onOpenFile={handleOpenFile}
      onRestore={() => void handleRestore()}
      onReview={codeReviewEnabled ? () => void handleRequestReview() : undefined}
    />
  );
}

function HostApprovalDialogFactory({
  request,
  onAnswer,
}: SlotComponentProps<HostApprovalDialogFactoryProps, "root">): ReactElement {
  return createElement(ExtensionDialog, {
    request,
    onAnswer: (response) => {
      onAnswer(request.id, response);
    },
  });
}

function HostLivePlanBarFactory(): ReactElement {
  return createElement(LivePlanBar);
}

export function registerHostShellFactories(
  target: Pick<SlotRegistry, "registerFactory"> | Pick<ClientSlotsService, "registerFactory">,
): Array<() => void> {
  return [
    target.registerFactory("host.shell.gitAction", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:shell-git-action`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostGitActionFactory,
    }),
    target.registerFactory("host.conversation.sessionChangeCard", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:conversation-session-change-card`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostSessionChangeCardFactory,
    }),
    target.registerFactory("host.conversation.approvalDialog", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:conversation-approval-dialog`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostApprovalDialogFactory,
    }),
    target.registerFactory("host.conversation.livePlanBar", {
      id: `${HOST_FACTORIES_PLUGIN_ID}:conversation-live-plan-bar`,
      pluginId: HOST_FACTORIES_PLUGIN_ID,
      tier: "builtin",
      priority: 0,
      scope: "root",
      component: HostLivePlanBarFactory,
    }),
  ];
}
