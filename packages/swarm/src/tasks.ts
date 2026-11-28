/**
 * Shared multi-active CAS Task Board with `expectedRevision` optimistic concurrency
 * and `dependsOn` prerequisite auto-unblocking (`@qianji/swarm`).
 */
import type {
  SwarmTaskItem,
  SwarmTasksMutateParams,
  SwarmTaskStatus,
} from "@qianji/protocol";

export interface TaskMutateOutcome {
  task?: SwarmTaskItem;
  tasks: SwarmTaskItem[];
  unblockedTasks: SwarmTaskItem[];
}

function cloneTask(item: SwarmTaskItem): SwarmTaskItem {
  return {
    ...item,
    dependsOn: [...item.dependsOn],
    ownedFiles: [...item.ownedFiles],
  };
}

function normalizeStringList(values?: string[]): string[] {
  if (values === undefined) return [];
  const seen = new Set<string>();
  for (const raw of values) {
    const trimmed = String(raw).trim();
    if (trimmed !== "") seen.add(trimmed);
  }
  return [...seen];
}

export class SwarmTaskEngine {
  readonly swarmId: string;
  private readonly items = new Map<string, SwarmTaskItem>();
  private nextNum = 1;

  constructor(swarmId: string, initial: SwarmTaskItem[] = []) {
    this.swarmId = swarmId;
    for (const item of initial) {
      this.items.set(item.id, cloneTask(item));
      const match = /^task-(\d+)$/.exec(item.id);
      if (match?.[1] !== undefined) {
        const parsed = Number.parseInt(match[1], 10);
        if (Number.isFinite(parsed) && parsed >= this.nextNum) {
          this.nextNum = parsed + 1;
        }
      }
    }
  }

  list(): SwarmTaskItem[] {
    return [...this.items.values()]
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map(cloneTask);
  }

  get(taskId: string): SwarmTaskItem | undefined {
    const found = this.items.get(taskId);
    return found === undefined ? undefined : cloneTask(found);
  }

  hasIncompleteTasks(): boolean {
    for (const item of this.items.values()) {
      if (item.status !== "completed") return true;
    }
    return false;
  }

  private unmetDependencies(dependsOn: readonly string[]): string[] {
    const unmet: string[] = [];
    for (const depId of dependsOn) {
      const dep = this.items.get(depId);
      if (dep === undefined || dep.status !== "completed") {
        unmet.push(depId);
      }
    }
    return unmet;
  }

  private reconcileDependencies(now: number): SwarmTaskItem[] {
    const unblocked: SwarmTaskItem[] = [];
    for (const item of this.items.values()) {
      if (item.status !== "blocked" || item.dependsOn.length === 0) continue;
      if (this.unmetDependencies(item.dependsOn).length === 0) {
        item.status = "pending";
        item.revision += 1;
        item.updatedAt = now;
        unblocked.push(cloneTask(item));
      }
    }
    return unblocked;
  }

  private requireTask(taskId: string | undefined, expectedRevision?: number): SwarmTaskItem {
    const id = (taskId ?? "").trim();
    if (id === "") throw new Error("taskId is required for this task mutation.");
    const existing = this.items.get(id);
    if (existing === undefined) throw new Error(`Swarm task "${id}" does not exist.`);
    if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
      throw new Error(
        `CAS revision conflict on task "${id}": expected revision ${expectedRevision}, actual revision ${existing.revision} (status=${existing.status}, assignee=${existing.assignee ?? "none"}).`,
      );
    }
    return existing;
  }

  mutate(params: SwarmTasksMutateParams, now = Date.now()): TaskMutateOutcome {
    if (params.action === "create") {
      const title = (params.title ?? "").trim();
      if (title === "") throw new Error("Task title is required when action is 'create'.");
      const id = params.taskId?.trim() || `task-${this.nextNum++}`;
      if (this.items.has(id)) throw new Error(`Swarm task "${id}" already exists.`);
      const dependsOn = normalizeStringList(params.dependsOn);
      const ownedFiles = normalizeStringList(params.ownedFiles);
      const unmet = this.unmetDependencies(dependsOn);
      const initialStatus: SwarmTaskStatus =
        params.status !== undefined
          ? params.status
          : unmet.length > 0
            ? "blocked"
            : params.assignee !== undefined && params.assignee.trim() !== ""
              ? "claimed"
              : "pending";
      const created: SwarmTaskItem = {
        id,
        swarmId: this.swarmId,
        title,
        description: (params.description ?? "").trim(),
        status: initialStatus,
        ...(params.assignee !== undefined && params.assignee.trim() !== "" ? { assignee: params.assignee.trim() } : {}),
        dependsOn,
        ownedFiles,
        attemptCount: initialStatus === "claimed" || initialStatus === "in_progress" ? 1 : 0,
        ...(params.verificationNotes === undefined ? {} : { verificationNotes: params.verificationNotes }),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.items.set(id, created);
      return { task: cloneTask(created), tasks: this.list(), unblockedTasks: [] };
    }

    if (params.action === "delete") {
      const existing = this.requireTask(params.taskId, params.expectedRevision);
      this.items.delete(existing.id);
      const unblockedTasks = this.reconcileDependencies(now);
      return { task: cloneTask(existing), tasks: this.list(), unblockedTasks };
    }

    const existing = this.requireTask(params.taskId, params.expectedRevision);
    const actor = params.assignee?.trim() || params.actor?.trim();

    switch (params.action) {
      case "claim": {
        const unmet = this.unmetDependencies(existing.dependsOn);
        if (unmet.length > 0) {
          throw new Error(`Task "${existing.id}" is blocked by incomplete prerequisites: ${unmet.join(", ")}.`);
        }
        if (existing.status !== "pending" && existing.status !== "failed") {
          if (existing.status === "claimed" && actor !== undefined && existing.assignee === actor) {
            return { task: cloneTask(existing), tasks: this.list(), unblockedTasks: [] };
          }
          throw new Error(
            `Task "${existing.id}" cannot be claimed because its status is "${existing.status}" (assignee=${existing.assignee ?? "none"}).`,
          );
        }
        existing.status = "claimed";
        if (actor !== undefined && actor !== "") existing.assignee = actor;
        existing.attemptCount += 1;
        break;
      }
      case "start": {
        const unmet = this.unmetDependencies(existing.dependsOn);
        if (unmet.length > 0) {
          throw new Error(`Task "${existing.id}" cannot start while prerequisites are incomplete: ${unmet.join(", ")}.`);
        }
        if (existing.status === "pending" || existing.status === "failed" || existing.attemptCount === 0) {
          existing.attemptCount += 1;
        }
        existing.status = "in_progress";
        if (actor !== undefined && actor !== "") existing.assignee = actor;
        break;
      }
      case "verify": {
        existing.status = "verifying";
        if (params.verificationNotes !== undefined) existing.verificationNotes = params.verificationNotes;
        break;
      }
      case "complete": {
        existing.status = "completed";
        if (params.verificationNotes !== undefined) existing.verificationNotes = params.verificationNotes;
        break;
      }
      case "block": {
        existing.status = "blocked";
        if (params.verificationNotes !== undefined) existing.verificationNotes = params.verificationNotes;
        break;
      }
      case "fail": {
        existing.status = "failed";
        if (params.verificationNotes !== undefined) existing.verificationNotes = params.verificationNotes;
        break;
      }
      case "update": {
        if (params.title !== undefined && params.title.trim() !== "") existing.title = params.title.trim();
        if (params.description !== undefined) existing.description = params.description.trim();
        if (params.assignee !== undefined) {
          const nextAssignee = params.assignee.trim();
          if (nextAssignee === "") delete existing.assignee;
          else existing.assignee = nextAssignee;
        }
        if (params.dependsOn !== undefined) existing.dependsOn = normalizeStringList(params.dependsOn);
        if (params.ownedFiles !== undefined) existing.ownedFiles = normalizeStringList(params.ownedFiles);
        if (params.verificationNotes !== undefined) existing.verificationNotes = params.verificationNotes;
        if (params.status !== undefined) {
          if (
            (params.status === "claimed" || params.status === "in_progress")
            && (existing.status === "pending" || existing.status === "failed")
          ) {
            existing.attemptCount += 1;
          }
          existing.status = params.status;
        }
        break;
      }
    }

    existing.revision += 1;
    existing.updatedAt = now;
    const unblockedTasks = existing.status === "completed" || params.action === "update"
      ? this.reconcileDependencies(now)
      : [];
    return {
      task: cloneTask(existing),
      tasks: this.list(),
      unblockedTasks,
    };
  }
}
