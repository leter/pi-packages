# pi-herdr-dispatch Design

Status: draft, awaiting final confirmation. This document describes the V1 design only; it is not an implementation plan approval.

## Purpose

`pi-herdr-dispatch` is a global Pi package for safely coordinating coding agents that already exist on one local Herdr server. Pi may inspect agent metadata, propose a task for an idle agent, and monitor confirmed work, but it cannot create panes, agents, workspaces, or worktrees.

## V1 boundaries

- Local Herdr server/socket only; no SSH remote sessions.
- Existing agents only; the Origin Pi cannot dispatch to itself.
- One dispatch per proposal and confirmation.
- No model wait tool and no autonomous continuation when a result arrives.
- No recursive delegation by a Dispatch Target.
- State-changing operations are TUI-only. Print, JSON, and RPC modes are read-only.
- Default limits: four Active Dispatches per workspace and eight globally.

## Components

1. **Pi extension** — commands, model tools, confirmation UI, dashboard, widget, result delivery, and local lease guard.
2. **Herdr client** — connects to the local Unix socket, bootstraps from `session.snapshot`, subscribes to events, reads pane history, posts metadata/notifications, and sends messages atomically with `pane.send_input`.
3. **Dispatch Registry** — SQLite in WAL mode, with transactions and unique constraints for coordinator and worktree leases.
4. **Coordinator** — one Pi instance holds a 30-second lease renewed every 10 seconds. It monitors all local Active Dispatches; another Pi takes over after expiration.
5. **Origin Session delivery** — settlement is global, but only the Origin Session claims the Sanitized Dispatch Result into model context. Claiming is idempotent and never starts a model turn.

## Identity and scope

A proposal displays the target's Agent label, status, status source, workspace, cwd/worktree, and Enforcement Level. Delivery uses the target `terminal_id`; the pane ID is retained for Herdr socket operations.

The default Workspace Scope is the Origin Pi's current Herdr workspace. Cross-workspace model proposals are accepted only when the latest user message contains a uniquely resolvable Agent name, terminal ID, or cwd. They still require full confirmation. The dashboard defaults to the current workspace and exposes an explicit `All workspaces` tab.

A Git worktree is identified by the real path of `git rev-parse --show-toplevel`. Separate Git worktrees are separate lease subjects. Write dispatch is rejected outside a Git worktree.

## Proposal and confirmation

A proposal is an immutable preview containing:

- target identity and status provenance;
- mode: `non-mutating` or `write`;
- Enforcement Level: `guarded` or `advisory`;
- confirmed directory/worktree;
- deadline (default 30 minutes, allowed 1 minute–24 hours);
- exact task and constraints;
- dependency-install permission, if any;
- correlation ID;
- exact Result Envelope contract.

The confirmation UI offers **Approve**, **Edit**, and **Cancel**. Editing creates a new immutable proposal and requires another preview. Immediately before delivery, the extension revalidates terminal identity, workspace, status, cwd/worktree, concurrency limits, target occupancy, and worktree lease. Any drift invalidates the proposal.

Both `/herdr-dispatch` and `herdr_dispatch_propose` use this same path. No entry point has privileged confirmation bypass.

## Outbound message

The complete outbound message is visible in confirmation and then delivered byte-for-byte. Its shape is:

```text
[HERDR DISPATCH]
ID: hd_<sortable-random-id>
Mode: non-mutating | write
Target directory: <path>
Deadline: <timestamp>
Enforcement: guarded | advisory

Task:
<self-contained task>

Constraints:
- Do not delegate or spawn another agent.
- Stay in the confirmed directory/worktree.
- Follow the declared mutation mode.
- Do not commit, push, deploy, publish, mutate remote systems, or perform destructive cleanup.
- Global and system installs are forbidden.
- Project dependency installation is forbidden unless explicitly authorized above.

Finish by printing exactly one single-line Result Envelope, not fenced in Markdown:
DISPATCH_RESULT {"id":"...","outcome":"done|blocked|failed|cancelled","summary":"..."}
```

Project dependency installation is allowed only for a write proposal that explicitly lists it; resulting project and lockfile changes remain visible. The extension never permits global/system installation.

Delivery uses one socket request:

```json
{
  "method": "pane.send_input",
  "params": { "pane_id": "...", "text": "<full message>", "keys": ["enter"] }
}
```

Protocol or method incompatibility fails closed. There is no fallback to separate text and Enter operations.

## Eligibility and acknowledgement

Only an idle Existing Agent is eligible. Working, blocked, unknown, self, already occupied, or stale targets are rejected.

Proposals disclose whether status comes from a reported Agent integration or screen detection. Both are allowed; ambiguous screen-detected transitions produce attention rather than inferred settlement.

After delivery, the target must transition from idle to working within a startup window (default 30 seconds; configurable 5 seconds–5 minutes). Otherwise `unacknowledged` attention is added. The dispatch and any lease remain; it is never automatically resent.

The setup wizard offers detected Herdr status integrations individually. Runtime never modifies another Agent's config. Amp remains screen-detected unless Herdr gains an integration.

## Mutation and side-effect policy

### Non-mutating

Non-mutating is a contract, not a universal OS sandbox. For Git targets the coordinator records a before/after worktree snapshot and computes a Mutation Audit. For non-Git targets it is advisory only.

If a write dispatch overlaps the same worktree, the non-mutating audit is `inconclusive`, not a violation, because process attribution is unavailable.

### Write

Write mode acquires a globally unique Worktree Write Lease. Every Pi instance loading this package blocks its own `edit`/`write` and clearly mutating `bash` calls in that worktree unless its terminal is the lease-holding target. Read-only operations remain available. Manual shells and processes without the package are outside this guard.

Write mode permits local files and local verification only. Commit, push, deploy, publish, remote mutation, and destructive cleanup remain prohibited. `guarded` means the target harness actively enforces available controls; `advisory` means the outbound protocol and observable audit are the only controls. Advisory write proposals prominently warn that remote side effects cannot be audited.

A conflicting write proposal is rejected. There is no automatic preemption or downgrade.

## Lifecycle, attention, and outcomes

Lifecycle is orthogonal to attention:

```text
proposed -> delivering -> active -> settled
```

Attention is a set, so conditions can coexist:

- `unacknowledged`
- `overdue`
- `blocked-runtime`
- `monitoring-paused`
- `malformed-result`
- `result-missing`
- `target-lost`
- `target-moved`

Terminal outcomes are `done`, `blocked`, `failed`, and `cancelled`. Every outcome settles the dispatch and releases its Worktree Write Lease. Continuing after `blocked` requires a new proposal and confirmation.

A deadline expiration adds `overdue`; it does not cancel, stop monitoring, or release a lease.

If Herdr reports runtime `blocked` without a Result Envelope, the coordinator adds `blocked-runtime`, reads 50 recent lines, and notifies the user. `/herdr-dispatch-reply` may send a fully previewed and confirmed reply under the same correlation ID. It does not extend the deadline unless explicitly changed.

If the target becomes idle without a valid result, `result-missing` is added. The coordinator does not nudge or infer completion.

If the target terminal disappears, `target-lost` is added. If it leaves the confirmed directory/worktree, `target-moved` is added. Normal automatic settlement pauses, and the original lease remains. No retargeting or lease transfer occurs.

If the Herdr socket is unavailable, `monitoring-paused` is added, one notification is emitted, and reconnection uses exponential backoff. Recovery revalidates targets and scans history; no task is failed and no lease is released merely because Herdr restarted.

## Cancellation and manual resolution

A normal cancellation is itself previewed and confirmed. It asks the target to stop and return a `cancelled` Result Envelope. Occupancy and lease remain until that result arrives.

If cancellation does not settle, the user may initiate forced cancellation only through the dashboard or slash command. After a second confirmation, the extension sends `Ctrl+C`, waits for idle, and completes the Mutation Audit. Only then does it settle as `cancelled` and release the lease. Failure to reach idle retains the lease.

`result-missing` and `target-lost` have no standalone lease-release operation. `/herdr-dispatch-resolve` shows current worktree state, requires `failed` or `cancelled` plus a summary, then asks for a second confirmation. Settlement and lease release occur atomically.

Model tools may propose ordinary replies and cancellation. They cannot propose forced cancellation or manual resolution.

## Result protocol

A result must be a single line from the confirmed target pane after the delivery revision:

```text
DISPATCH_RESULT {"id":"hd_...","outcome":"done","summary":"Implemented X","tests":["pnpm test"],"changedFiles":["src/x.ts"],"artifacts":[]}
```

Required fields are `id`, `outcome`, and bounded `summary`. Accepted optional fields are `tests`, `changedFiles`, `artifacts`, and `blocker`. Types, counts, and lengths are bounded. Unknown fields remain only in the raw Registry envelope and never enter parent model context.

Acceptance requires correlation ID, source terminal, pane revision, and schema to match. A matching but malformed line adds `malformed-result`, stores a bounded raw line, and notifies; it never settles or triggers an automatic retry. Duplicate results are audit events and cannot settle twice.

The Sanitized Dispatch Result is explicitly marked as untrusted data. Raw pane output and the raw envelope do not enter parent model context. Settlement independently computes Git status, changed files, and diff statistics; it does not run tests. Agent-reported tests remain untrusted.

## Recovery and result delivery

The Registry stores the pane revision captured at delivery. After coordinator takeover or reconnect, a bounded Recovery Scan starts there and searches for an exact result. Missing or cleared history becomes `result-missing`, never inferred success.

Settlement records the result, outcome, audit data, and lease release in one transaction. It also emits a Herdr notification. The Origin Session claims its sanitized result while active or next resumed. The custom session entry includes the dispatch ID, making claim recovery idempotent if a process crashes between session append and Registry acknowledgement. Claiming never triggers a model turn.

## Registry

Default path:

```text
~/.local/state/pi-herdr-dispatch/registry.sqlite
```

The directory is mode `0700` and the database mode `0600`. SQLite uses WAL, foreign keys, migrations, and transactional compare-and-set operations.

Conceptual records:

- dispatch current state and immutable confirmed payload;
- attention conditions;
- globally unique target occupancy;
- globally unique worktree write lease;
- coordinator lease;
- raw and sanitized results;
- Origin Session delivery claims;
- append-only lightweight audit events.

Current state is stored directly; events are for audit, not full event sourcing. Settled dispatches and their events are retained 30 days by default, configurable 1–365 days. Unsettled records are never automatically purged.

Migration creates a timestamped database backup and runs transactionally. Corruption, migration failure, or unavailable transactional access fails closed: no new dispatch, reply, cancellation, settlement, or lease mutation. The package never creates an empty replacement or falls back to memory.

## Coordinator and Herdr UI

Only the Coordinator Lease holder monitors and settles. All Pi instances may display Registry state and enforce worktree leases.

The coordinator publishes expiring pane metadata such as:

```text
dispatch hd_ab12 · active
```

It renews TTL without changing pane name or Agent label. Herdr notifications occur only for terminal outcomes and attention conditions. Suggested sound policy:

- `done`: `done`
- blocked, failed, overdue, malformed, result-missing, target-lost, target-moved, monitoring-paused, unacknowledged: `request`
- cancelled: `none`

Pi shows a one-line widget below the editor while records are active, for example `dispatches: 2 active · 1 attention`. It does not modify the existing custom footer.

## User interface

### Commands

- `/herdr-agents` — current-workspace Agent metadata; explicit all-workspace view.
- `/herdr-dispatch` — manual proposal wizard.
- `/herdr-dispatches` — interactive dashboard; text fallback in read-only modes.
- `/herdr-dispatch-reply <id>` — previewed reply.
- `/herdr-dispatch-cancel <id>` — previewed normal cancellation.
- `/herdr-dispatch-force-cancel <id>` — manual-only, double-confirmed.
- `/herdr-dispatch-resolve <id>` — manual-only, double-confirmed.
- `/herdr-agent-output <target> [lines]` — one bounded output inspection.
- `/herdr-dispatch-setup` — optional, per-integration installation prompts.

The dashboard defaults to current workspace, with explicit active/history and all-workspace views. Actions include inspect, reply, cancel, rescan, force cancel, and resolve when valid for the selected record.

### Model tools

- `herdr_agents_list`
- `herdr_dispatch_propose`
- `herdr_dispatch_status`
- `herdr_agent_output_inspect`
- `herdr_dispatch_reply_propose`
- `herdr_dispatch_cancel_propose`

There is no wait, force-cancel, resolve, agent-start, pane-create, workspace-create, or worktree-create tool.

Agent output inspection is authorized by an explicit user request or Active Dispatch monitoring. A user request itself is sufficient; no redundant confirmation appears. Default output is the 50 most recent plain-text lines, with ANSI removed; the maximum is 200 lines. A single request authorizes one bounded read, not continuing surveillance.

## Configuration

Suggested file:

```text
~/.config/pi-herdr-dispatch/config.json
```

Defaults:

```json
{
  "defaultDeadlineMinutes": 30,
  "minDeadlineMinutes": 1,
  "maxDeadlineMinutes": 1440,
  "startupWindowMs": 30000,
  "minStartupWindowMs": 5000,
  "maxStartupWindowMs": 300000,
  "coordinatorLeaseMs": 30000,
  "coordinatorHeartbeatMs": 10000,
  "maxActivePerWorkspace": 4,
  "maxActiveGlobal": 8,
  "retentionDays": 30,
  "inspectionLines": 50,
  "maxInspectionLines": 200
}
```

Invalid configuration fails validation and leaves state-changing functionality disabled.

## Test strategy

### Unit

- lifecycle and orthogonal attention transitions;
- result parsing, sanitization, bounds, and duplicate handling;
- proposal immutability and stale-target detection;
- target resolution and cross-workspace explicit-target checks;
- Git worktree identity and Mutation Audit comparisons;
- outbound message construction;
- command classification for the Pi-side lease guard;
- retention and notification policy.

### Integration

Use a fake Herdr Unix socket and temporary SQLite database to test:

- atomic `pane.send_input` payload and fail-closed protocol mismatch;
- two Pi processes racing for Coordinator Lease;
- globally unique target occupancy and worktree leases;
- crash points around delivery, settlement, lease release, and Origin Session claim;
- Herdr disconnect/reconnect and Recovery Scan;
- migration backup and rollback;
- corrupt/locked database fail-closed behavior;
- screen-detected ambiguity versus reported status;
- Origin Session offline result delivery.

### Live acceptance

1. Dispatch a non-mutating review to an idle screen-detected Agent.
2. Dispatch write work to a guarded Pi and verify the Origin Pi is blocked from editing that worktree.
3. Attempt a second write dispatch to the same worktree and verify rejection.
4. Restart the Coordinator Pi during work and verify takeover plus result recovery.
5. Exercise blocked-runtime → confirmed reply → result.
6. Exercise overdue, normal cancel, forced cancel, result-missing, target-lost, and target-moved.
7. Verify cross-workspace dispatch rejection without an explicit target and success with one.
8. Verify no result triggers a model turn.
9. Verify raw pane output and unknown result fields never enter model context.
10. Verify Registry failure preserves leases and disables state changes.

## Decisions recorded separately

- [ADR 0001: Use SQLite for the global Dispatch Registry](./adr/0001-sqlite-dispatch-registry.md)
- [ADR 0002: Deliver dispatches through atomic Herdr pane input](./adr/0002-atomic-herdr-input-delivery.md)
- [ADR 0003: Model lifecycle, attention, and outcome separately](./adr/0003-orthogonal-dispatch-state.md)
