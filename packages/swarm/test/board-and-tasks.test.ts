import { describe, expect, it } from "vitest";
import {
  deriveGroupPrefix,
  parseBoardMentions,
  SwarmBoardEngine,
  validateWorkerName,
} from "../src/board.ts";
import { SwarmTaskEngine } from "../src/tasks.ts";

describe("SwarmBoardEngine & code-safe @mention parser", () => {
  it("strips fenced code blocks and inline backticks before extracting @mentions", () => {
    const sample = [
      "Please review `@coordinator` and ``@worker-1`` in README.",
      "Scoped npm packages in prose: @qianji/protocol and @deepseek-ai/cordis must not match.",
      "Email contact: subagent@qianji.local",
      "```ts",
      "// @all [done] inside fenced block must be ignored",
      "const msg = '@verifier wake up';",
      "```",
      "Actual wakeup: @Impl-Verifier and @#Backend [done] ready for check!",
    ].join("\n");

    const parsed = parseBoardMentions(sample);
    expect(parsed.mentionAll).toBe(false);
    expect(parsed.mentions).toEqual(["impl-verifier"]);
    expect(parsed.channelMentions).toEqual(["backend"]);
    expect(parsed.isDone).toBe(true);
    expect(parsed.isStall).toBe(false);
  });

  it("never parses scoped npm package names (@scope/pkg) as swarm @mentions or channel mentions", () => {
    const parsed = parseBoardMentions(
      "梳理 @qianji/protocol 与 @deepseek-ai/cordis 导出契约，完成后通知 @schema-explorer",
    );
    expect(parsed.mentions).toEqual(["schema-explorer"]);
    expect(parsed.channelMentions).toEqual([]);
  });

  it("derives group prefixes for numbered workers and validates reserved names", () => {
    expect(deriveGroupPrefix("shard-1")).toBe("shard");
    expect(deriveGroupPrefix("api-worker-12")).toBe("api-worker");
    expect(deriveGroupPrefix("verifier")).toBeUndefined();
    expect(() => validateWorkerName("coordinator")).toThrow(/reserved/i);
    expect(() => validateWorkerName("coordinator-2")).toThrow(/reserved/i);
    expect(() => validateWorkerName("all")).toThrow(/reserved/i);
    expect(validateWorkerName("Worker-A")).toBe("worker-a");
  });

  it("implements zero-race waitFor(since): returns immediately if matching message already arrived", async () => {
    const board = new SwarmBoardEngine("swarm-test", 1_000);
    board.append({ sender: "coordinator", text: "@worker-1 initial brief", now: 1_001 });
    board.append({ sender: "verifier", text: "@worker-1 found edge case in line 42", now: 1_002 });

    let parked = false;
    const res = await board.waitFor({
      member: { name: "worker-1", groupPrefix: "worker", channels: ["main"] },
      since: 1,
      onPark: () => {
        parked = true;
      },
    });

    expect(parked).toBe(false);
    expect(res.headSeq).toBe(2);
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0]?.seq).toBe(2);
  });

  it("parks when caught up, ignores backticked mentions & self-posts, and wakes on group or direct @mention", async () => {
    const board = new SwarmBoardEngine("swarm-test", 1_000);
    board.append({ sender: "coordinator", text: "@worker-1 start", now: 1_000 });

    let parkedAt: number | undefined;
    const waitPromise = board.waitFor({
      member: { name: "worker-1", groupPrefix: "worker", channels: ["main"] },
      since: 1,
      onPark: (seq) => {
        parkedAt = seq;
      },
    });

    expect(parkedAt).toBe(1);

    // 1) Self-post does not wake worker-1
    board.append({ sender: "worker-1", text: "@worker-1 note to self", now: 1_005 });
    // 2) Inline code `@worker-1` does not wake worker-1
    board.append({ sender: "coordinator", text: "Do not wake `@worker-1` yet", now: 1_006 });
    // 3) Group prefix `@worker` wakes worker-1 and delivers all messages since seq 1
    board.append({ sender: "coordinator", text: "@worker new schema landed!", now: 1_007 });

    const res = await waitPromise;
    expect(res.aborted).toBe(false);
    expect(res.timedOut).toBe(false);
    expect(res.headSeq).toBe(4);
    expect(res.messages.map((m) => m.seq)).toEqual([2, 3, 4]);
  });
});

describe("SwarmTaskEngine CAS & dependsOn auto-unblocking", () => {
  it("blocks dependent tasks until prerequisites complete and enforces CAS expectedRevision", () => {
    const engine = new SwarmTaskEngine("swarm-1");
    const t1 = engine.mutate({
      swarmId: "swarm-1",
      action: "create",
      title: "Define protocol types",
      ownedFiles: ["packages/protocol/src/swarm-methods.ts"],
    }, 100).task;
    expect(t1?.status).toBe("pending");
    expect(t1?.revision).toBe(1);

    const t2 = engine.mutate({
      swarmId: "swarm-1",
      action: "create",
      title: "Wire host RPC",
      dependsOn: [t1?.id ?? ""],
      ownedFiles: ["packages/host/src/swarm-rpc.ts"],
    }, 101).task;
    expect(t2?.status).toBe("blocked");

    // Premature claim on blocked task fails
    expect(() =>
      engine.mutate({
        swarmId: "swarm-1",
        action: "claim",
        taskId: t2?.id,
        assignee: "host-wiring",
      }),
    ).toThrow(/incomplete prerequisites/i);

    // First worker claims t1 with CAS expectedRevision: 1
    const claimed = engine.mutate({
      swarmId: "swarm-1",
      action: "claim",
      taskId: t1?.id,
      assignee: "swarm-engine",
      expectedRevision: 1,
    }, 102).task;
    expect(claimed?.status).toBe("claimed");
    expect(claimed?.revision).toBe(2);
    expect(claimed?.attemptCount).toBe(1);

    // Concurrent stale CAS claim fails
    expect(() =>
      engine.mutate({
        swarmId: "swarm-1",
        action: "claim",
        taskId: t1?.id,
        assignee: "other-worker",
        expectedRevision: 1,
      }),
    ).toThrow(/CAS revision conflict/i);

    // Completing t1 automatically unblocks t2 -> pending!
    const completed = engine.mutate({
      swarmId: "swarm-1",
      action: "complete",
      taskId: t1?.id,
      expectedRevision: 2,
      verificationNotes: "All types exported",
    }, 103);
    expect(completed.unblockedTasks.map((t) => t.id)).toEqual([t2?.id]);
    const refreshedT2 = engine.get(t2?.id ?? "");
    expect(refreshedT2?.status).toBe("pending");

    // Now host-wiring can claim and start t2
    const claimedT2 = engine.mutate({
      swarmId: "swarm-1",
      action: "claim",
      taskId: t2?.id,
      assignee: "host-wiring",
      expectedRevision: refreshedT2?.revision,
    }, 104).task;
    expect(claimedT2?.status).toBe("claimed");
    expect(claimedT2?.assignee).toBe("host-wiring");
  });
});
