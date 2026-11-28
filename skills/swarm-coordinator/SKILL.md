---
name: swarm-coordinator
description: Orchestrate multi-agent swarms in Qianji using the Minimalist 4-Tool Kernel (`swarm`, `post_message`, `read_board`, `swarm_wait`) and Outcome-Thread Overview (`action: "plan"`). Use when decomposing parallel research, architecture, coding, and verification work across named swarm agents.
---

# Swarm Coordinator Playbook

Coordinate named specialist agents on Qianji's shared message board using **only 4 tools** — `swarm`, `post_message`, `read_board`, and `swarm_wait` — without file collisions, polling loops, or separate task-CRUD overhead.

## 1. Spawn Named Role-Typed Workers & Publish Outcome Threads

1. **Add role-typed workers with exclusive file ownership (`swarm` `action: "add"`)**:
   - Call `swarm(action: "add", name, role, brief)` with a clear lowercase role name (`parser`, `api-worker`, `verifier`, `monitor`).
   - Always pass the accurate `role` (`"planner" | "explorer" | "worker" | "verifier" | "monitor"`) and **omit `model` / `provider`** unless the user explicitly requested an override, so each specialist automatically inherits its configured role model and reasoning effort.
   - Workspace isolation defaults by role:
     - `explorer` / `planner` / `verifier` / `monitor` -> `workspace: "inherit"` (read-only inspection and verification on the main checkout; zero worktree overhead).
     - `worker` -> `workspace: "share"` (isolated Git worktree per author so parallel edits and builds never collide; falls back to `"inherit"` outside Git repos) or `workspace: "branch"` for multi-commit feature branches.
   - Write self-contained briefs: fresh workers (`fork` omitted) do **not** see your conversation history. State exact goal/context (citing `#<seq>`), exclusive owned files, forbidden files, verification commands, and who to `@mention` next (e.g., `@verifier [done] ...`).
2. **Publish 1–6 Outcome Threads (`swarm` `action: "plan"`)**:
   - Call `swarm(action: "plan", goalTitle, goalLine, memberTasks, threads)` right after spawning workers (or when re-planning):
     - `memberTasks`: concise 1-line task label per worker (e.g., `{ "parser": "Fix lexer edge cases", "verifier": "Run parser & boundary suite" }`).
     - `threads`: **1 to 6 outcome-oriented deliverable groups** (`{ id, title, goal, members }`). Group contributors by shared outcome (e.g., author + verifier on one feature slice) — **never** create 1 thread per agent unless there is only a single piece of work.

## 2. Board Hygiene, Zero-Polling Doorbells & Peer State Signals

- **Sleep with `swarm_wait(since: lastReadSeq)`**:
  - Always pass the highest `seq` you have actually read (`lastReadSeq`), never an unread `headSeq`, so messages posted mid-turn wake you immediately instead of being slept through. Never poll `read_board` or `swarm(action: "status")` in a loop.
- **Refer by `#seq`, never re-quote**:
  - Cite `#4` or `#12` instead of pasting prior messages; every board message costs tokens across waking readers.
- **`@name` is a wakeup doorbell, never a CC**:
  - `@worker` wakes only that member; `@all` wakes the entire swarm (reserve for contract changes or global rules).
  - Route authors directly to `@verifier` (`@verifier [done] <summary>`) so `@coordinator` wakes only when verification passes or a decision is blocked.
- **Board-derived progress, questions, and screenshots**:
  - Asking `@peer ...?` on the board automatically marks the sender as `waitingOn: "peer"` until `@peer` posts back.
  - Posting `[done]` (`@verifier [done] ...` or `@coordinator [done] ...`) records `completedAt` on that member; a subsequent `@mention` for fixes clears `completedAt` until its next `[done]`.
  - Include `Screenshot: <path> | <caption>` on its own line in board posts to populate the Swarm Screenshot Reel.

## 3. Verification, Worktree Merge & Closeout

1. **Independent `@verifier` gate**:
   - Spawn a read-only `verifier` (`role: "verifier"`, `workspace: "inherit"`). A verifier **reports** file/line failures back to `@<author>` and never edits implementation files itself.
2. **Merge isolated worktrees before `kill`**:
   - Land validated `share` / `branch` worker patches via `swarm(action: "merge", name)` before calling `swarm(action: "kill", name)`. `kill` permanently removes the worktree and refuses unmerged changes unless `forceKillUnmerged: true`.
3. **Quota / capacity recovery & `[done]` closeout**:
   - On rate-limit or capacity errors, hot-swap in place via `swarm(action: "model", name, model)` to preserve session history.
   - Once all outcome threads are verified and merged, post a final `[done]` summary and present the synthesized result to the user.

## Companion Reference

- Stall watchdog recovery rules: [swarm-monitor](../swarm-monitor/SKILL.md)
