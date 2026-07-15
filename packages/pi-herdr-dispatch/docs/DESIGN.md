# pi-herdr-dispatch Design

Status: revised after architecture review; awaiting follow-up review before implementation planning.

## Purpose

`pi-herdr-dispatch` is a global Pi package for dispatching confirmed work to coding agents that already exist in the Origin Pi's current workspace on one local Herdr server. It may inspect Agent metadata, propose work for an idle-like Agent, and monitor work confirmed by its Origin Session. It cannot create panes, Agents, workspaces, or worktrees.

## V1 boundaries

- Local Herdr server/socket only; no SSH remote sessions.
- Current Herdr workspace only; no cross-workspace dispatch.
- Existing Agents only; the Origin Pi cannot dispatch to itself.
- One dispatch per proposal and confirmation.
- Every target-side safety instruction is advisory in V1.
- No model wait tool and no autonomous continuation when a result arrives.
- Raw Herdr tasking, pane-control, Agent-start, and blocking-wait commands issued through this Pi's `bash` or `user_bash` paths are gated; Agent inspection remains available.
- No recursive delegation by a Dispatch Target.
- Dispatch, reply, cancellation, and manual resolution are TUI-only. Print, JSON, and RPC modes are read-only.
- Only the TUI Origin Session monitors and settles the dispatches it confirmed. There is no coordinator election or takeover.
- Default limits: four Active Dispatches per target workspace and eight globally.

## Explicit V1 scope cuts

The following are intentionally deferred:

- coordinator lease, fencing, and monitoring takeover;
- revision-cursor Recovery Scan;
- cross-workspace dispatch and model access to foreign Agent metadata;
- automatic forced cancellation (`Ctrl+C` must be performed by the user in the target pane);
- target-side `guarded` enforcement claims;
- Mutation Violation attribution;
- model-callable reply and cancellation tools;
- a custom interactive dispatch dashboard (V1 uses a text list plus commands).

These cuts preserve the core confirmed-dispatch workflow while removing the least verifiable distributed-state behavior.

## Components

1. **Pi extension** — commands, model proposal tools, confirmation UI, status widget, Origin Session monitoring, result delivery, a best-effort Pi-side lease guard, and a raw Herdr CLI gate shared by `tool_call` and `user_bash`.
2. **Herdr adapter** — one local Unix-socket connection per monitoring Origin Session. It bootstraps from `session.snapshot`, subscribes to supported events, reads bounded pane tails, posts notifications/metadata, and delivers input with `pane.send_input`.
3. **Dispatch Registry** — global SQLite storage in WAL mode, with transactions and unique constraints for target occupancy and worktree write leases.
4. **Origin Monitor** — a TUI Pi session monitors only records whose persisted Origin Session ID equals its own session ID. Monitoring stops when that session is not running and resumes when the exact session resumes.
5. **Origin-side Safety Gate** — every Pi process loading the package reads global leases, guards covered Pi mutation paths, and prevents recognized raw Herdr commands from bypassing confirmed dispatch, regardless of whether that process is an Origin Monitor.

## Identity and workspace scope

The Origin Session is identified by Pi's stable session ID (`ctx.sessionManager.getSessionId()`), with the session file stored only as diagnostic metadata. A fork or clone has a different session ID and is not the Origin Session, even when its history contains the original confirmation.

The extension identifies its Herdr location from `HERDR_PANE_ID` / `HERDR_WORKSPACE_ID`, then resolves the pane through Herdr to obtain its terminal ID. A Dispatch Target is selected only from that workspace.

A proposal displays the target's Agent label, terminal ID, pane ID, status, status evidence, workspace, and cwd/worktree. The terminal ID is the dispatch identity. A pane ID is a stable handle while that pane remains in place, but moving the pane assigns a new pane ID; the route must therefore be re-resolved and revalidated immediately before use. Herdr officially guarantees that closed pane and tab IDs are not reused, so a closed route cannot later retarget a different resource ([Herdr agent skill](https://herdr.dev/docs/agent-skill/)).

A Git worktree is identified by the real path of `git rev-parse --show-toplevel`. Separate Git worktrees are separate lease subjects. Write dispatch is rejected outside a Git worktree.

## Status semantics

Herdr statuses are interpreted as follows:

- `idle` and `done`: **idle-like** — both mean the Agent is no longer working. Officially, `idle` means waiting with its result considered seen, while `done` means completed with its result unseen ([Herdr agent skill](https://herdr.dev/docs/agent-skill/)). Either is eligible for a new dispatch when no Target Occupancy exists; after work either triggers result lookup and, without a valid result, `result-missing`.
- `working`: execution acknowledgement/progress.
- `blocked`: runtime attention only; it is not the final `blocked` Dispatch Outcome.
- `unknown`: ineligible and never interpreted as completion.

Status provenance is not assumed to be a direct `AgentInfo` field. Until a live compatibility probe proves integration authority semantics for the installed Herdr version, proposals label status as **screen-detected (best effort)**. A future reported status may be displayed only when the adapter can positively establish authority; absence of evidence never becomes `reported`.

Screen-detected Agents remain supported because they are the normal case on the current machine. Ambiguous transitions add attention and never settle a dispatch.

## Proposal and confirmation

A proposal is an immutable preview containing:

- target identity and status evidence;
- mode: `non-mutating` or `write`;
- an explicit advisory-safety warning;
- confirmed directory/worktree;
- deadline (default 30 minutes, allowed 1 minute–24 hours);
- exact task and constraints;
- project dependency-install permission, if any;
- correlation ID;
- exact Result Envelope contract.

The confirmation UI offers **Approve**, **Edit**, and **Cancel**. Editing creates a new immutable proposal and requires another preview. Immediately before delivery, the extension re-resolves terminal ID to pane ID and revalidates on the same Herdr socket connection:

- `pane.get` still returns the confirmed terminal ID and Agent;
- target status is idle-like;
- target workspace and `PaneInfo.cwd` still match;
- Target Occupancy and Worktree Write Lease are available;
- per-target-workspace and global concurrency limits allow the dispatch.

Any mismatch invalidates the proposal. `foreground_cwd` is not used for worktree identity because transient child-shell `cd` operations would create false drift.

Both `/herdr-dispatch` and `herdr_dispatch_propose` use this path. No entry point bypasses confirmation.

## Outbound message

The complete outbound message is visible in confirmation and delivered byte-for-byte:

```text
[HERDR DISPATCH]
ID: hd_<sortable-random-id>
Mode: non-mutating | write
Target directory: <path>
Deadline: <timestamp>
Safety: advisory

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

Project dependency installation is allowed only for a write proposal that explicitly lists it; resulting project and lockfile changes remain visible. The extension never authorizes global/system installation.

## Delivery protocol and crash recovery

Delivery crosses SQLite and Herdr and therefore cannot be atomic. V1 makes the ambiguity explicit instead of pretending a database transaction covers the socket side effect.

### Durable intent

On confirmation, one SQLite transaction:

1. stores the immutable payload and its hash;
2. changes lifecycle to `delivering`;
3. acquires Target Occupancy;
4. acquires a Worktree Write Lease when mode is write;
5. appends the confirmation/delivery-intent audit events.

The extension then performs final target revalidation and sends one socket request:

```json
{
  "method": "pane.send_input",
  "params": { "pane_id": "...", "text": "<full message>", "keys": ["enter"] }
}
```

`pane.send_input` makes text plus Enter one Herdr operation; it does **not** make target resolution plus send atomic. A pane may still close or move between final `pane.get` and input handling. Herdr guarantees that closed resource IDs are not reused, so a stale closed pane ID cannot retarget a later pane; a move still changes the pane ID and can make the route stale. The residual stale-route/ambiguous-response race is disclosed in the confirmation's advisory warning ([Herdr agent skill](https://herdr.dev/docs/agent-skill/)).

The adapter listens for `pane.closed` and `pane.moved` during the confirmation/delivery window and aborts before send when either event is observed. After send, it re-resolves the target terminal and performs Delivery Echo Verification against `recent_unwrapped` output. Echo verification distinguishes many successful deliveries from stale-route failures, but absence of an echo still cannot prove that no input was accepted.

### Normal completion of delivery

The Registry changes `delivering → active` only after `pane.send_input` returns success. Echo verification then searches a bounded tail for both `[HERDR DISPATCH]` and the unique `ID: hd_...`. If the expected echo does not appear within the startup window, `delivery-unverified` attention is added; the message is never resent automatically.

### Origin crash while delivering

When the exact Origin Session resumes, every record still in `delivering` is resolved conservatively with a 200-line `recent_unwrapped` Catch-Up Read from the confirmed target:

1. a valid matching Result Envelope proves delivery and settles normally;
2. the exact dispatch header plus correlation ID proves delivery and moves the record to `active`;
3. neither signal adds `delivery-unverified` and leaves lifecycle at `delivering`, retaining occupancy and any write lease.

The user must inspect and manually resolve a delivery-unverified record. V1 never automatically resends because absence from the bounded tail cannot prove non-delivery.

A socket error after request submission is also treated as ambiguous and leaves `delivering` plus `delivery-unverified`. Only an error proven to occur before any input could be accepted may settle as failed and release reservations.

## Origin Session monitoring

There is no global coordinator. A TUI session starts an Origin Monitor only for unsettled records with its exact Origin Session ID.

While running, the monitor:

- subscribes to `pane.output_matched` for the escaped correlation ID and then reads/parses a bounded pane tail;
- consumes `agent_status_changed`, `pane.closed`, and `pane.moved` events;
- uses revision values only as an optional “output advanced” optimization, never as a line cursor or acceptance condition;
- polls `PaneInfo.cwd` every five seconds and requires two consecutive mismatches before adding `target-moved`;
- renews its own Herdr display metadata;
- evaluates startup windows and deadlines.

When the Origin Session is closed, no other Pi takes over. Results, notifications, and lease release are delayed; Target Occupancy and Worktree Write Leases remain durable. This is an explicit V1 trade-off.

On `/resume`, `/reload`, or Herdr socket reconnect, the Origin Monitor obtains a fresh snapshot, resolves the stored terminal ID, and performs a bounded 200-line `recent_unwrapped` Catch-Up Read. This is tail catch-up, not a revision-based Recovery Scan. If the terminal ID no longer exists, the record becomes `target-lost`. V1 does not assume terminal IDs or history survive a Herdr restart and never retargets by Agent name.

If the same terminal ID is attached to a new pane ID with the same workspace and cwd, the route may be updated after revalidation. A changed terminal ID is never accepted as continuity.

## Eligibility and acknowledgement

Only an idle-like Existing Agent is eligible. Working, blocked, unknown, self, already occupied, or stale targets are rejected.

After delivery, the target should transition from idle-like to working within a startup window (default 30 seconds; configurable 5 seconds–5 minutes). Otherwise `unacknowledged` is added. For a screen-detected target this means only “no reliable start signal was observed”; it does not prove non-delivery. The dispatch and reservations remain, and the message is never automatically resent.

The optional setup command may offer detected Herdr status integrations one by one. Runtime never modifies another Agent's config.

## Mutation and side-effect policy

### All target constraints are advisory

V1 does not claim target-side enforcement. An Existing Agent may ignore instructions, and Herdr cannot dynamically remove its tools. Every proposal states this clearly, especially for commit, push, deploy, publish, remote mutation, and destructive cleanup.

### Non-mutating

Non-mutating requests investigation and reporting without file changes. For Git targets the Origin Monitor records before/after worktree snapshots and reports **observed changes during the dispatch** without attributing them to the target. For non-Git targets the mode is instruction-only.

If a write dispatch overlaps the same worktree, the audit is `inconclusive`. The design has no Mutation Violation state because manual shells and user edits prevent sound process attribution.

### Write and Pi-side lease guard

Write mode acquires a globally unique Worktree Write Lease. Every Pi process loading the package consults the Registry and guards only the paths it can identify:

- built-in `edit` and `write` tool calls;
- built-in `bash` tool calls through a best-effort mutation classifier;
- `!` and `!!` commands through the separate `user_bash` event and the same classifier.

The lease guard does not cover unknown third-party mutating tools, external manual shells, non-Pi agents, or commands the classifier cannot recognize. Documentation and UI must call it best-effort rather than an OS-level lock. Read-only built-in commands remain available.

### Raw Herdr CLI gate

The globally installed official Herdr skill teaches Pi to use Herdr through ordinary `bash`. Without a gate, skill-guided commands can send tasks, create Agents/panes, or block waiting for completion without any Dispatch Proposal, Target Occupancy, Worktree Write Lease, or Result Envelope. The extension therefore applies one classifier to both:

- `tool_call` events for the built-in `bash` tool;
- `user_bash` events for `!` and `!!` commands.

The extension's own typed Herdr socket adapter does not pass through this shell gate.

Commands proven read-only are allowed, including:

- `herdr status`, `herdr api snapshot`, `herdr api schema`;
- `herdr pane list|get|read|current|layout|process-info|neighbor|edges`;
- `herdr agent list|get|read|explain`;
- `herdr workspace list|get`, `herdr tab list|get`, `herdr worktree list`;
- `herdr integration status`.

Allowed pane/Agent read output is still untrusted. When it will enter model context, the corresponding tool result is wrapped in `<untrusted-herdr-cli-output>` framing just like Agent Output Inspection.

Commands that task, create, control, close, or block on another pane are denied and direct the user/model to `/herdr-dispatch` or `herdr_dispatch_propose`. The deny set includes at minimum:

- `herdr pane run|send-text|send-keys|close` when the target resolves to another pane;
- `herdr pane split` (it creates another pane) and `herdr agent start`;
- `herdr agent send` when it resolves to another Agent;
- `herdr wait agent-status|output` for foreign targets;
- any non-allowlisted Herdr command whose effect on a foreign pane/resource cannot be proven read-only.

An omitted, focused, name-based, or otherwise ambiguous target is treated as foreign. A compound shell command is allowed only when every Herdr invocation in it is classified read-only. A literal Herdr invocation that cannot be parsed is denied rather than guessed safe.

This gate preserves the skill's inspection value while preventing its documented tasking workflow from becoming the normal bypass. It is not a shell sandbox: indirection through generated scripts, aliases, alternate binaries, custom tools, direct socket code, or an external terminal may evade classification.

A conflicting write proposal is rejected. There is no preemption or downgrade.

## Threat model and residual bypasses

The Origin Pi itself is a bypass-capable actor: the globally installed Herdr skill can guide its model to invoke raw Herdr CLI through `bash`, so “this Pi has the extension” does not by itself imply that tasking went through the Registry. The raw Herdr CLI gate and prompt guidelines specifically address that in-process, skill-guided path.

The remaining safety boundary is explicitly best-effort. The package cannot fully control:

- a manual shell outside Pi;
- a target Agent that ignores advisory constraints;
- an obfuscated shell invocation the classifier cannot recognize;
- another extension's custom mutating tool;
- code that opens the Herdr socket directly;
- processes that mutate the worktree without consulting the Registry.

Accordingly, Target Occupancy and Worktree Write Leases are coordination records for cooperating/covered paths, not universal locks. Any UI claim about exclusivity or non-mutation must retain that qualification.

## Lifecycle, attention, and final outcomes

Lifecycle is orthogonal to attention:

```text
proposed -> delivering -> active -> settled
```

`delivering` is durable and means the Registry holds dispatch intent/reservations while Herdr acceptance is not yet durably established.

Attention Conditions may coexist:

- `delivery-unverified`
- `unacknowledged`
- `overdue`
- `blocked-runtime`
- `monitoring-paused`
- `malformed-result`
- `result-missing`
- `target-lost`
- `target-moved`

Final Outcomes are `done`, `blocked`, `failed`, and `cancelled`. Every Final Outcome settles the dispatch and releases Target Occupancy and any Worktree Write Lease. Continuing after `blocked` requires a new proposal and confirmation.

A deadline expiration adds `overdue`; it does not cancel, stop monitoring, or release reservations.

If Herdr reports runtime `blocked` without a Result Envelope, the record becomes a Blocked-Runtime Dispatch. The monitor captures 50 recent lines for human display as untrusted output and notifies the user while retaining reservations. `/herdr-dispatch-reply` is allowed for any Active Dispatch with an Attention Condition, not only blocked-runtime.

Before a reply is sent, confirmation displays the captured untrusted tail and warns that `pane.send_input` writes to whatever prompt or dialog currently has focus. Reply text may be consumed as dialog keystrokes. There is no safe compare-and-send primitive.

If the target becomes idle-like (`idle` or `done`) without a valid result, `result-missing` is added. The extension does not nudge or infer completion.

If the terminal ID disappears, `target-lost` is added. If two consecutive five-second polls show `PaneInfo.cwd` outside the confirmed directory/worktree, `target-moved` is added. These pausing Attention Conditions stop normal settlement and retain reservations until manual resolution.

If the local Herdr socket is unavailable while the Origin Session is active, `monitoring-paused` is added, one notification is emitted, and reconnect uses exponential backoff. No outcome is inferred and no reservation is released.

## Cancellation and manual resolution

A normal cancellation is previewed and confirmed through `/herdr-dispatch-cancel`. It asks the target to stop and emit a `cancelled` Result Envelope. Reservations remain until a valid result or manual resolution.

V1 does not send `Ctrl+C`. If normal cancellation does not settle, the UI instructs the user to focus the target pane, interrupt it manually, verify that it is idle-like, then run `/herdr-dispatch-resolve`.

`delivery-unverified`, `result-missing`, `target-lost`, and `target-moved` have no standalone lease-release operation. Manual resolution:

1. shows current target/worktree status and bounded untrusted output;
2. requires `failed` or `cancelled` plus a summary;
3. asks for a second confirmation;
4. records the resolver session ID;
5. atomically settles and releases reservations.

The Origin Session normally resolves its own records. A different local TUI session may perform an explicitly labelled **emergency resolution** when the Origin Session is unavailable; it cannot adopt monitoring or inject a result into its own model context.

Reply and cancellation are slash-command actions only in V1. They are not model tools.

## Result protocol

A result is a single line from the confirmed terminal's pane output:

```text
DISPATCH_RESULT {"id":"hd_...","outcome":"done","summary":"Implemented X","tests":["pnpm test"],"changedFiles":["src/x.ts"],"artifacts":[]}
```

Required fields are `id`, `outcome`, and bounded `summary`. Accepted optional fields are `tests`, `changedFiles`, `artifacts`, and `blocker`. Types, counts, and lengths are bounded. Unknown fields remain only in the raw Registry envelope.

Acceptance requires:

- the globally unique correlation ID to match an unsettled dispatch;
- output to come from the currently resolved terminal ID for that dispatch;
- lifecycle to be `delivering` or `active`;
- schema validation to succeed.

Pane revision is not an acceptance criterion. Correlation IDs are random and created immediately before confirmation, so a valid pre-delivery match is not expected. The residual risk that a compromised target emits an early false Result Envelope is accepted and tested explicitly.

A matching malformed line adds `malformed-result`, stores a bounded raw line, and notifies; it never settles or triggers an automatic retry. The first valid accepted result wins transactionally. Later duplicates or conflicts are audit events and cannot settle twice.

Settlement independently computes Git status, changed files, and diff statistics; it does not run tests. Agent-reported tests remain untrusted.

## Untrusted output and model context

Raw pane output never enters parent model context **through settlement**. The Origin Session receives only a bounded Sanitized Dispatch Result marked as untrusted data.

An explicit Agent Output Inspection is a separate, user-authorized path that does return up to 200 ANSI-stripped lines to the model. Its tool result is wrapped as data:

```text
<untrusted-agent-output terminal="...">
...
</untrusted-agent-output>
```

The wrapper instructs the model to treat the body as data, not instructions. Allowed raw Herdr read commands invoked through `bash` use equivalent `<untrusted-herdr-cli-output>` framing before their output enters context. Blocked-runtime captures shown only in TUI/notifications do not enter model context unless the user explicitly invokes inspection.

## Origin Session result delivery

Settlement records the result, final outcome, audit data, and reservation release in one SQLite transaction and emits a Herdr notification.

The Origin Session then appends one custom result message without triggering a model turn. Exactly-once delivery is checked against the **active branch**:

1. identify the Origin Session by session ID;
2. scan the active branch for a custom result message with the dispatch ID;
3. append only when absent;
4. verify that the entry is present on the still-active branch before marking context delivery complete;
5. if the branch changed during the operation, leave delivery pending and retry against the new active branch.

A later user-initiated branch navigation does not cause reinjection. Forks and clones have different session IDs and never claim the result.

## Dispatch Registry

Default path:

```text
~/.local/state/pi-herdr-dispatch/registry.sqlite
```

The directory is mode `0700` and the database mode `0600`. SQLite uses WAL, foreign keys, migrations, and transactional compare-and-set operations.

Conceptual records:

- dispatch current state and immutable confirmed payload/hash;
- Origin Session ID and diagnostic session path;
- target terminal identity and current pane route;
- Attention Conditions;
- globally unique Target Occupancy;
- globally unique Worktree Write Lease;
- raw and sanitized results;
- Origin Session active-branch context-delivery state;
- append-only lightweight audit events.

There is no Coordinator Lease and no revision cursor. Current state is stored directly; events are for audit, not full event sourcing. Settled records and events are retained 30 days by default, configurable 1–365 days. Unsettled records are never automatically purged.

Migration creates a timestamped database backup and runs transactionally. Corruption, migration failure, or unavailable transactional access fails closed: no new dispatch, reply, cancellation, settlement, or reservation mutation. The package never creates an empty replacement or falls back to memory.

Per-workspace concurrency is counted by **target workspace**. V1 target and origin workspaces are the same, but the resource definition remains explicit.

## Herdr UI and metadata

The active Origin Monitor reports an expiring metadata token with a dedicated source such as `pi-herdr-dispatch:<origin-session-id>` and monotonically increasing `seq`. It does not overwrite pane title, displayed Agent, integration state labels, or another source's custom status. If the installed Herdr UI cannot display a dedicated `dispatch` token without conflicting configuration, V1 omits pane metadata and relies on the Pi widget plus notifications.

Herdr notifications occur only for Final Outcomes and Attention Conditions:

- `done`: sound `done`;
- blocked, failed, overdue, malformed, result-missing, target-lost, target-moved, monitoring-paused, unacknowledged, delivery-unverified: sound `request`;
- cancelled: sound `none`.

Pi shows a one-line widget below the editor while records are active, for example `dispatches: 2 active · 1 attention`. It does not modify the existing custom footer.

## User interface

### Commands

- `/herdr-agents` — Agent metadata from the current Workspace Scope only.
- `/herdr-dispatch` — manual proposal wizard.
- `/herdr-dispatches` — text list of current-workspace records and valid follow-up command hints; an explicit global view is for lease diagnosis only.
- `/herdr-dispatch-reply <id>` — previewed reply for an Active Dispatch with attention.
- `/herdr-dispatch-cancel <id>` — previewed normal cancellation.
- `/herdr-dispatch-resolve <id>` — double-confirmed manual/emergency resolution.
- `/herdr-agent-output <target> [lines]` — one bounded, untrusted-framed output inspection.
- `/herdr-dispatch-setup` — optional, per-integration installation prompts.

There is no automatic force-cancel command in V1.

### Model tools

- `herdr_agents_list` — always restricted to the current Workspace Scope; no all-workspaces parameter.
- `herdr_dispatch_propose`
- `herdr_dispatch_status`
- `herdr_agent_output_inspect`

`herdr_dispatch_propose` registers an explicit prompt guideline: **Use `herdr_dispatch_propose` for every request to task another Herdr Agent. Do not use `bash`, `user_bash`, or raw `herdr pane` / `herdr agent` / `herdr wait` commands to send work or wait for it.** The other dispatch tools reinforce the same rule when active.

There is no model wait, reply, cancel, force-cancel, resolve, Agent-start, pane-create, workspace-create, or worktree-create tool.

Agent output inspection is authorized by an explicit user request. A user request itself is sufficient; no redundant confirmation appears. Default output is the 50 most recent `recent_unwrapped` plain-text lines, with ANSI removed; the configured maximum is 200. One request authorizes one bounded read, not continuing surveillance.

### Run-mode rules

Proposal, reply, cancellation, resolution, Origin Monitoring, and context delivery require `ctx.mode === "tui"`; checking `ctx.hasUI` is insufficient because RPC reports UI capability. Non-TUI modes may list current state and perform an explicitly requested bounded inspection only. The lease guard and raw Herdr CLI gate remain active in every mode because they prevent non-Origin Pi processes and skill-guided shell calls from bypassing reservations and confirmation.

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
  "maxActivePerTargetWorkspace": 4,
  "maxActiveGlobal": 8,
  "retentionDays": 30,
  "inspectionLines": 50,
  "maxInspectionLines": 200,
  "catchUpLines": 200,
  "cwdPollMs": 5000,
  "cwdDriftSamples": 2,
  "metadataTtlMs": 30000
}
```

Invalid configuration disables state-changing functionality. `catchUpLines` and inspection bounds are requests to Herdr, not guarantees about retained history; a shorter returned tail is accepted and absence never proves non-delivery.

## Authoritative Herdr semantics

The official [Herdr agent skill](https://herdr.dev/docs/agent-skill/) is an implementation reference alongside the installed CLI/schema. It explicitly guarantees that closed pane/tab IDs are not reused and defines `done` as completed with an unseen result, while `idle` is waiting with the result considered seen. On this machine the same skill is globally available to Pi at `~/.agents/skills/herdr/SKILL.md`.

## Required compatibility checks before implementation planning

The design no longer depends on the answers, but a live spike must record installed Herdr 0.7.3 behavior for:

- terminal ID continuity across server restart/update;
- pane-ID changes after move (closed-ID non-reuse is an official contract, not an open assumption);
- `recent_unwrapped` depth and requested line-count behavior with pane history enabled;
- exact accepted `pane.send_input.keys` spelling for `enter`;
- whether `screen_detection_skipped` positively identifies integration authority;
- dedicated metadata token coexistence.

Any failure tightens behavior to attention/fail-closed; it must not introduce heuristic retargeting, revision cursors, or split delivery.

## Test strategy

### Unit

- lifecycle, durable `delivering`, and orthogonal Attention Conditions;
- Result Envelope parsing, sanitization, bounds, first-valid-wins, and conflicting duplicates;
- proposal immutability and stale-target detection;
- current-workspace target resolution;
- idle/done equivalence;
- Git worktree identity and observed-change audits;
- outbound message and delivery echo matching;
- built-in tool plus `user_bash` lease-guard classification;
- Herdr CLI allow/deny classification for direct, quoted, piped, compound, ambiguous-target, and unparseable invocations;
- prompt guideline presence and precedence over skill-guided tasking;
- untrusted output framing for inspection and allowed raw Herdr reads;
- Origin Session ID and active-branch delivery rules;
- retention and notification policy.

### Integration

Use a fake Herdr Unix socket and temporary SQLite database to test:

- atomic `pane.send_input` payload and fail-closed protocol mismatch;
- crash before send, during send, after Herdr success, and before `active` commit;
- resume of `delivering` with result present, echo present, or neither present;
- pane close/move between final revalidation and send, including conformance with the official closed-ID non-reuse guarantee;
- globally unique Target Occupancy and Worktree Write Leases across Pi processes;
- raw `bash` and `user_bash` attempts to run `pane run`, `agent send/start`, `pane split`, and blocking waits;
- read-only Herdr CLI commands remaining usable with untrusted output framing;
- two Origins racing to acquire the same target/worktree;
- result settlement racing an emergency manual resolution;
- active-branch result append crash/retry and branch change during append;
- Herdr disconnect/reconnect with bounded Catch-Up Read;
- target ending in `done` without a result;
- terminal ID missing or changed after Herdr restart;
- malformed and conflicting Result Envelopes;
- migration backup and rollback;
- corrupt/locked database fail-closed behavior;
- non-TUI processes never starting monitors or state-changing operations.

### Live acceptance

1. Dispatch a non-mutating review to an idle and to a done screen-detected Agent.
2. Dispatch write work and verify covered Pi mutation paths (`edit`, `write`, `bash`, `!`, `!!`) are blocked for non-holders.
3. Attempt a second dispatch to the same target and a second write dispatch to the same worktree.
4. Kill the Origin during `delivering`; resume with echo present and with no detectable echo.
5. Close the Origin while the target finishes; resume and settle from the bounded tail.
6. Exercise blocked-runtime → confirmed reply → valid result, with the focused-input warning visible.
7. Exercise overdue, normal cancellation, manual interrupt guidance, result-missing, target-lost, and target-moved.
8. Restart Herdr during active work and record identity/history behavior without assuming continuity.
9. Verify no result triggers a model turn and forks/clones do not claim Origin results.
10. Verify settlement injects only sanitized results while explicit inspection returns untrusted-framed output.
11. Ask Pi naturally to “use Herdr to task the adjacent Agent” and verify the official skill cannot bypass proposal/confirmation through `bash`, `!`, or `!!`; verify read-only inspection still works.
12. Verify Registry failure preserves reservations and disables state changes.

## Review findings addressed

- **C1:** durable delivery intent plus Delivery Echo Verification and `delivery-unverified`; no automatic resend.
- **C2:** removed revision cursors and revision-based acceptance; bounded tail catch-up plus correlation/source/schema matching.
- **H1:** removed coordinator takeover entirely.
- **H2:** removed `guarded` from V1; all target constraints are advisory.
- **H3:** immediate same-connection route revalidation, close/move observation, post-send echo verification, and a narrowed residual race; Herdr's official closed-ID non-reuse guarantee removes the pane-ID-retargeting worst case.
- **H4:** `done` is idle-like for eligibility, result-missing, and manual cancellation guidance, matching Herdr's official “completed, result unseen” semantics.
- **H5:** raw output exclusion is settlement-specific; explicit inspection and allowed raw Herdr reads use untrusted framing.
- **H6:** the same origin-side classifier gates `bash` and `user_bash`, dispatch-sensitive raw Herdr commands are denied, read-only Herdr inspection remains available, and dispatch tools explicitly instruct the model to use `herdr_dispatch_propose`.

## Decisions recorded separately

- [ADR 0001: Use SQLite for the global Dispatch Registry](./adr/0001-sqlite-dispatch-registry.md)
- [ADR 0002: Deliver dispatches through atomic Herdr pane input](./adr/0002-atomic-herdr-input-delivery.md)
- [ADR 0003: Model lifecycle, attention, and outcome separately](./adr/0003-orthogonal-dispatch-state.md)
- [ADR 0004: Use per-origin monitoring in V1](./adr/0004-per-origin-monitoring.md)
- [ADR 0005: Gate raw Herdr tasking inside Pi](./adr/0005-gate-raw-herdr-tasking.md)
