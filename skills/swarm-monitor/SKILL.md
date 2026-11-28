---
name: swarm-monitor
description: Diagnose and unstick stalled multi-agent swarms as the dedicated `@monitor` watchdog agent. Use ONLY when assigned the `monitor` role in an active Qianji swarm to resolve deadlocks, silent worker hangs, or missed `@mention` handoffs.
---

# Swarm Monitor Watchdog Guide

> **Role Scope**: Activate this playbook **only** when your swarm brief assigns you as `monitor` (`role: "monitor"`). Coordinators and implementation workers should follow [swarm-coordinator](../swarm-coordinator/SKILL.md) instead.

## 1. Operating Loop

1. Inspect live state with `read_board(since: lastReadSeq)` and `swarm_tasks(action: "list")` (plus `swarm(action: "status")`).
2. Check whether the swarm is making forward progress:
   - At least one member is actively `working` with recent activity, **or**
   - Unread `@mention` doorbells are already queued to wake the next assignee, **or**
   - All tasks are `completed` and `@coordinator` has posted `[done]`.
3. If healthy, stay silent—post **nothing**—and park via `swarm_wait(since: lastReadSeq, mentionsOnly: true)` (or return cleanly if woken by the Host stall watchdog).

## 2. Diagnosing True Stalls

Act **only** when progress has genuinely halted:

| Stall Pattern | Symptoms | Single-Target Action |
| :--- | :--- | :--- |
| **Dropped Handoff** | Author posted `[done]` without an `@mention`, leaving `@verifier` or `@coordinator` asleep in `waiting`. | Post `@<next-owner> [stall] #<seq> is ready for your review/integration.` |
| **Unclaimed Ready Work** | Tasks sit in `pending` with all `dependsOn` `completed`, while eligible workers sit in `waiting`. | `@mention` **one** idle worker (`@<worker>`) to claim the next unblocked task ID. |
| **Blocked Dependency Cycle / Failure** | Tasks are `blocked`/`failed` or circularly waiting, and no worker is running. | Post `@coordinator [stall] Tasks <ids> are blocked (<reason>); need re-scoping or reassignment.` |
| **Stalled / Errored Member** | Host watchdog flagged `stalled` / `member-error` on `@<worker>` with unfinished `claimed`/`in_progress` tasks. | First ping `@<worker>` once to resume or report status; if unresponsive or errored out, alert `@coordinator` to switch model or reassign. |

## 3. Strict Monitor Guardrails

- **Never edit code or claim implementation tasks**: You are a read-only traffic controller, not a backup coder.
- **Wake the single agent who can act**: Never broadcast `@all` for a single stalled handoff; wake only the specific `@<member>` (or `@coordinator` when escalation is required).
- **Keep nudges terse**: One or two sentences citing `#<seq>` and task IDs (`T-2`) so context burn stays near zero.
