# 0018 — Model-initiated launch of read-only-role Agents

## Status

Proposed (2026-07-17); direction confirmed by the user in the ADR 0017 design conversation. Depends on ADR 0017 (roles) and on resolving the Herdr 0.7.4 provenance regression that currently blocks `claude`/`codex`/`opencode` launches. Amends the ADR 0013 boundary "Agent Launch is user-only, never model-callable".

## Context

Overnight throughput is capped by the capacity the user prepared before sleeping (ADR 0015: "the model can fill existing Task Worktrees but never add one"). For write work that authority split is right: a write Agent binds a worktree and a lease, and the blast radius of a wrong worktree decision is real file changes. But review, research, and consultation stages only need *an* eligible pane in the Origin cwd, and a missing reviewer at 3 a.m. parks an otherwise-finished pipeline until morning.

One premise must be stated honestly: a "read-only role" is advisory, not enforced (the V1 Advisory Safety rule). A model-launched reviewer wields the same full tool set as any dispatched Existing Agent; what launching changes is not what an Agent *may* do but how many autonomous actors exist and who decided that. The residual mutation risk of dispatching to a model-created pane is therefore identical to today's dispatch-to-existing path; the genuinely new risk is unbounded resource creation (panes, money, runaway width), and that is what this ADR fences.

## Decision

1. **Only read-only roles may be model-launched:** `reviewer`, `researcher`, `advisor`, `oracle`. Write roles (`coder`, `bugfix`, `chore`) and every Task Worktree remain strictly user-created via `/hd-create`. The fixed executable catalog, current Workspace Scope, and no-focus rules of ADR 0013 apply unchanged.
2. **Reuse first; launch is the last resort.** A launch is permitted only when no Eligible Agent matches the required role by pane name. A matching idle pane always wins.
3. **A user-owned Launch Budget bounds creation.** Arming (`/hd-auto on`) carries a per-armed-session budget of model-initiated launches (config `defaultLaunchBudget`, default 2, range 0–10; 0 disables the capability). Exhaustion degrades to today's behavior: the task waits in the queue and one notification asks for capacity. Re-arming resets the budget. While disarmed, the model cannot launch at all — daytime capacity gaps are the user's `/hd-create` decision.
4. **Fixed ground:** model-initiated launches always use the Origin cwd, never create worktrees, tabs stay within the existing adaptive layout rules, and the pane is named `<role>-auto-<n>`.
5. **Full disclosure and retention:** every model-initiated launch writes an audit event, emits one notification, and the created pane is retained exactly like an ADR 0013 launch — cleanup remains a user action. Retained role panes become the reuse pool of decision 2 on later nights, so the budget is consumed mostly on first nights.
6. **Surface:** one new model tool `herdr_agent_launch_readonly` (role, agent type from the catalog), TUI-only, valid only while armed with budget remaining, returning the launched pane's identity for immediate routing. No other launch surface widens; `/hd-create` is untouched.

## Terminology

CONTEXT.md gains: **Launch Budget** / 创建额度 — the user-set number of model-initiated read-only-role Agent launches one armed session may perform. _Avoid_: unlimited scaling, write-role launch. The Agent Launch entry is amended to name this bounded read-only exception.

## Consequences

- The authority split stays "the user sizes the run, the model drives within it": the user sizes worktrees (write capacity), Run Quota (task throughput), and now Launch Budget (read-only capacity); the model routes within all three.
- Unattended actor count gains a hard bound: existing panes + Launch Budget, on top of the unchanged dispatch concurrency caps.
- The ADR 0013 amendment is narrow and explicit; every other "model never creates" boundary (worktrees, workspaces, write Agents) is restated unchanged.
- Registry schema adds launch-budget columns to the armed-session row (bundled with ADR 0017's v7 migration if implemented together).
- Live acceptance (L18) must cover: reuse-first (idle reviewer pane suppresses a launch), a budget-1 launch followed by a parked task and one notification at budget exhaustion, disarmed refusal of the launch tool, write-role refusal, audit/notification evidence, and pane retention plus next-night reuse.
