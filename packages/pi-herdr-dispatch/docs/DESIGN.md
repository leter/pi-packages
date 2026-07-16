# pi-herdr-dispatch Design

Status: implementation plan approved; Phase 5 Origin monitoring and settlement complete and awaiting review before Phase 6.

## Purpose

`pi-herdr-dispatch` is a global Pi package for automatically dispatching work through a typed, Registry-backed path to coding agents that already exist in the Origin Pi's current workspace on one local Herdr server. It may inspect Agent metadata, dispatch work to an idle-like Agent, and monitor work from its Origin Session. It cannot create panes, Agents, workspaces, or worktrees.

## V1 boundaries

- Local Herdr server/socket only; no SSH remote sessions.
- Current Herdr workspace only; no cross-workspace dispatch.
- Existing Agents only; the Origin Pi cannot dispatch to itself.
- One automatic dispatch per immutable proposal; no authorization setup or proposal confirmation.
- Every target-side safety instruction is advisory in V1.
- No model wait tool and no autonomous continuation when a result arrives.
- Raw Herdr tasking, pane-control, Agent-start, and blocking-wait commands issued through this Pi's `bash` or `user_bash` paths are gated; Agent inspection remains available.
- No recursive delegation by a Dispatch Target.
- Dispatch, reply, cancellation, and manual resolution are TUI-only. Print, JSON, and RPC modes are read-only.
- Only the TUI Origin Session monitors and settles the dispatches it created. There is no coordinator election or takeover.
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

These cuts preserve the core typed-dispatch workflow while removing the least verifiable distributed-state behavior.

## Components

1. **Pi extension** — commands, automatic model dispatch tools, status widget, Origin Session monitoring, result delivery, a best-effort Pi-side lease guard, and a raw Herdr CLI gate shared by `tool_call` and `user_bash`.
2. **Herdr adapter** — one exclusive, reconnecting Unix-socket subscription stream per monitoring Origin Session, plus a fresh connection for every unary request because Herdr 0.7.3 closes unary sockets after one response. It bootstraps from `session.snapshot`, subscribes to supported events, reads bounded pane tails, posts notifications, and delivers input with `pane.send_input`.
3. **Dispatch Registry** — global SQLite storage in WAL mode, with transactions and unique constraints for target occupancy and worktree write leases. Schema version 3 removes the obsolete Automation Grant table.
4. **Origin Monitor** — a TUI Pi session monitors only records whose persisted Origin Session ID equals its own session ID. Monitoring stops when that session is not running and resumes when the exact session resumes.
5. **Origin-side Safety Gate** — every Pi process loading the package reads global leases, guards covered Pi mutation paths, and prevents recognized raw Herdr commands from bypassing the typed dispatch path, regardless of whether that process is an Origin Monitor.

## Identity and workspace scope

The Origin Session is identified by Pi's stable session ID (`ctx.sessionManager.getSessionId()`), with the session file stored only as diagnostic metadata. A fork or clone has a different session ID and is not the Origin Session, even when its history contains the original automatic dispatch.

The extension identifies its Herdr location from `HERDR_PANE_ID` / `HERDR_WORKSPACE_ID`, then resolves the pane through Herdr to obtain its terminal ID. A Dispatch Target is selected only from that workspace.

An immutable proposal records the target's Agent label, terminal ID, pane ID, status, status evidence, workspace, and cwd/worktree. The terminal ID is the dispatch identity. A pane ID is a stable handle while that pane remains in place, but moving the pane assigns a new pane ID; the route must therefore be re-resolved and revalidated immediately before use. Herdr officially guarantees that closed pane and tab IDs are not reused, so a closed route cannot later retarget a different resource ([Herdr agent skill](https://herdr.dev/docs/agent-skill/)).

A Git worktree is identified by the real path of `git rev-parse --show-toplevel`. Separate Git worktrees are separate lease subjects. Write dispatch is rejected outside a Git worktree.

## Status semantics

Herdr statuses are interpreted as follows:

- `idle` and `done`: **idle-like** — both mean the Agent is no longer working. Officially, `idle` means waiting with its result considered seen, while `done` means completed with its result unseen ([Herdr agent skill](https://herdr.dev/docs/agent-skill/)). Either is eligible for a new dispatch when no Target Occupancy exists; after work either triggers result lookup and, without a valid result, `result-missing`.
- `working`: execution acknowledgement/progress.
- `blocked`: runtime attention only; it is not the `blocked` Final Outcome.
- `unknown`: ineligible and never interpreted as completion.

Herdr 0.7.3 exposes `screen_detection_skipped: true` only when recognized full-lifecycle integration authority is active; `agent explain` reports the reason as `full_lifecycle_hook_authority`. Proposals may label status as **reported** only when that value is explicitly `true`. A missing or `false` value is labelled **screen-detected (best effort)**; absence of evidence never becomes `reported`.

Screen-detected Agents remain supported because they are the normal case on the current machine. Ambiguous transitions add attention and never settle a dispatch.

## Proposal and automatic delivery

A proposal is an immutable complete outbound message containing:

- target identity and status evidence;
- mode: `non-mutating` or `write`;
- an explicit advisory-safety warning;
- confirmed directory/worktree;
- deadline (default 30 minutes, allowed 1 minute–24 hours);
- exact task and constraints;
- project dependency-install permission, if any;
- correlation ID;
- exact Result Envelope contract.

The typed TUI path delivers the proposal automatically without Approve/Edit/Cancel, grant setup, count limits, expiry, or renewal. Immediately before delivery, the extension re-resolves terminal ID to pane ID and revalidates through tightly adjacent unary requests. Herdr 0.7.3 accepts only one unary request per connection, so each request uses a fresh socket while the event subscription remains on its own long-lived connection ([compatibility spike](./SPIKE-RESULTS.md#7-unary-and-subscription-socket-lifecycles)):

- `pane.get` still returns the confirmed terminal ID and Agent;
- target status is idle-like;
- target workspace and `PaneInfo.cwd` still match;
- Target Occupancy and Worktree Write Lease are available;
- per-target-workspace and global concurrency limits allow the dispatch.

Any mismatch invalidates the proposal. `foreground_cwd` is not used for worktree identity because transient child-shell `cd` operations would create false drift.

Both `/herdr-dispatch` and `herdr_dispatch_propose` use this automatic path. Raw Herdr tasking remains denied because it would bypass proposal immutability, Registry reservations, monitoring, and result correlation ([ADR 0009](./adr/0009-automatic-dispatch-by-default.md)).

## Outbound message

The immutable message is stored and delivered byte-for-byte without a proposal confirmation prompt:

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

On automatic dispatch, one SQLite transaction:

1. stores the immutable payload and its hash;
2. changes lifecycle to `delivering`;
3. acquires Target Occupancy;
4. acquires a Worktree Write Lease when mode is write;
5. appends the automatic-default delivery-intent audit events.

The extension then performs final target revalidation and starts staged delivery.

Delivery stages the complete immutable text with `pane.send_input`, waits briefly for the Agent TUI to consume a multiline paste, re-resolves and revalidates the same terminal-to-pane route, then submits `keys: ["Enter"]` in a second `pane.send_input` request. This split is required because a real Claude Code TUI accepted combined text-plus-Enter but left the paste unsubmitted. If the route changes or Enter cannot be verified after staging, delivery is ambiguous and never resent. Closed pane IDs are not reused, and final route revalidation bounds—but cannot eliminate—the residual text/Enter race ([ADR 0006](./adr/0006-stage-multiline-input-before-submit.md)).

The adapter listens for `pane.closed` and `pane.moved` during the proposal/delivery window and aborts before send when either event is observed. After send, it re-resolves the target terminal and performs Delivery Echo Verification against `recent_unwrapped` output. Echo verification distinguishes many successful deliveries from stale-route failures, but absence of an echo still cannot prove that no input was accepted.

### Normal completion of delivery

The Registry changes `delivering → active` only after bounded echo verification finds the uniquely bounded `ID: hd_...` marker in target output. A successful `pane.send_input` response alone never activates a dispatch because it does not prove that the target TUI consumed or rendered the input. Verification performs bounded 200-line re-reads through the startup window and tolerates TUI whitespace, borders, and prompt prefixes. If the marker does not appear, the dispatch remains `delivering`, `delivery-unverified` attention is added, and the message is never resent automatically.

Phase 4/5 must treat `markActive` losing its compare-and-set because the dispatch already settled as a benign race: a valid result may settle before echo verification, or emergency resolution may settle first. The delivery path reports the recorded Final Outcome and must not reinterpret this `RegistryStateError` as delivery failure.

### Origin crash while delivering

When the exact Origin Session resumes, every record still in `delivering` is resolved conservatively with a 200-line `recent_unwrapped` Catch-Up Read from the confirmed target:

1. a valid matching Result Envelope proves delivery and settles normally;
2. a rendered line containing the uniquely bounded correlation marker `ID: hd_...` proves delivery and moves the record to `active`;
3. neither signal adds `delivery-unverified` and leaves lifecycle at `delivering`, retaining occupancy and any write lease.

The user must inspect and manually resolve a delivery-unverified record. V1 never automatically resends because absence from the bounded tail cannot prove non-delivery.

A socket error after request submission is also treated as ambiguous and leaves `delivering` plus `delivery-unverified`. Only an error proven to occur before any input could be accepted may settle as failed and release reservations.

## Origin Session monitoring

There is no global coordinator. A TUI session starts an Origin Monitor only for unsettled records with its exact Origin Session ID.

While running, the monitor:

- subscribes to `pane.output_matched` for the escaped correlation ID and then reads/parses a bounded pane tail;
- consumes `agent_status_changed`, `pane.closed`, and `pane.moved` events;
- uses revision values only as an optional “output advanced” optimization, never as a line cursor or acceptance condition;
- polls target liveness every five seconds and adds `target-lost` when the stored terminal can no longer be resolved;
- evaluates startup windows and deadlines.

When the Origin Session is closed, no other Pi takes over. Results, notifications, and lease release are delayed; Target Occupancy and Worktree Write Leases remain durable. This is an explicit V1 trade-off.

On `/resume`, `/reload`, or Herdr socket reconnect, the Origin Monitor obtains a fresh snapshot, resolves the stored terminal ID, and performs a bounded 200-line `recent_unwrapped` Catch-Up Read **before** installing target-specific subscriptions. This is tail catch-up, not a revision-based Recovery Scan. If the terminal ID no longer exists, the record becomes `target-lost` and is excluded from target-specific subscriptions while settlement is paused, so a stale pane route cannot disable the Adapter or its manual-resolution path. Herdr may report a failed child-subscription probe with a response ID derived as `<parent>:sub:<index>:probe`; the socket client attributes that bounded form to the pending `events.subscribe` request as an API error while continuing to reject unrelated response IDs as protocol failures.

Herdr 0.7.3 regenerates terminal IDs across a clean server restart even when workspace and pane IDs are restored. Therefore every unsettled record whose pre-restart terminal ID disappears follows `target-lost`; V1 never claims continuity from a matching pane ID, cwd, Agent label, or retained history.

**V2 backlog — human successor evidence:** a Herdr restart or upgrade can make every in-progress dispatch `target-lost` even while its Agent process survives. V1 accepts the resulting per-dispatch manual resolution as the conservative behavior. A future manual-resolution UI may show a same-pane-ID plus same-cwd pane as explicitly non-authoritative evidence for human judgment, but must never automatically retarget, transfer reservations, or treat that evidence as terminal continuity.

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

Commands proven read-only and not capable of bypassing typed inspection scope are allowed, including:

- `herdr status`, `herdr api schema`;
- `herdr pane list|get|current|layout|process-info|neighbor|edges`;
- `herdr agent list|get|explain`;
- `herdr workspace list|get`, `herdr tab list|get`, `herdr worktree list`;
- `herdr integration status`;
- `herdr pane read` only when the target is proven to be this Pi's own pane.

Allowed Herdr output is still untrusted. When it will enter model context, the corresponding tool result is wrapped in `<untrusted-herdr-cli-output>` framing.

Commands that task, create, control, close, or block on another pane are denied and direct the user/model to `/hd-new` (long form `/herdr-dispatch`) or `herdr_dispatch_propose`. The deny set includes at minimum:

- `herdr pane run|send-text|send-keys|close` when the target resolves to another pane;
- `herdr pane split` (it creates another pane) and `herdr agent start`;
- `herdr agent send` when it resolves to another Agent;
- `herdr wait agent-status|output` for foreign targets;
- `herdr pane read` for a foreign or ambiguous pane and every `herdr agent read`, redirected to one explicitly user-authorized `herdr_agent_output_inspect` call;
- `herdr api snapshot`, redirected to typed, current-Workspace-Scope tools such as `herdr_agents_list`;
- any non-allowlisted Herdr command whose effect on a foreign pane/resource cannot be proven read-only.

An omitted, focused, name-based, or otherwise ambiguous target is treated as foreign. The current-pane exception is accepted only when the classifier proves the resolved pane ID equals `HERDR_PANE_ID`; it is never inferred from focus. A compound shell command is allowed only when every Herdr invocation in it is classified read-only. Command launchers (`bash -c`, `eval`, `xargs`, `sudo`, `env`, and similar wrappers) are never unwrapped: any launcher invocation that mentions `herdr` is denied outright, trading occasional false positives for a simpler fail-closed classifier. A literal Herdr invocation that cannot be parsed is denied rather than guessed safe.

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

Final Outcomes are `done`, `blocked`, `failed`, and `cancelled`. Every Final Outcome settles the dispatch and releases Target Occupancy and any Worktree Write Lease. Continuing after `blocked` requires a new automatic dispatch proposal.

A deadline expiration adds `overdue`; it does not cancel, stop monitoring, or release reservations.

If Herdr reports runtime `blocked` without a Result Envelope, the record becomes a Blocked-Runtime Dispatch. The monitor captures 50 recent lines for human display as untrusted output and notifies the user while retaining reservations. `/herdr-dispatch-reply` is allowed for any Active Dispatch with an Attention Condition, not only blocked-runtime.

Before a reply is sent, confirmation displays the captured untrusted tail and warns that `pane.send_input` writes to whatever prompt or dialog currently has focus. Reply text may be consumed as dialog keystrokes. There is no safe compare-and-send primitive.

If the target becomes idle-like (`idle` or `done`) without a valid result, `result-missing` is added. The extension does not nudge or infer completion.

If the terminal ID disappears, `target-lost` is added. This pausing Attention Condition stops normal settlement and retains reservations until manual resolution.

If the local Herdr socket is unavailable while the Origin Session is active, the stored `monitoring-paused` Attention Condition is added, one notification is emitted, and reconnect uses exponential backoff. No outcome is inferred and no reservation is released.

If the Origin Session is closed, no monitor exists to write that condition. The resulting monitoring gap is a derived fact recognized when the exact Origin Session resumes; emergency resolution relies on explicit user attestation of Origin unavailability rather than a stored `monitoring-paused` record.

## Cancellation and manual resolution

A normal cancellation is previewed and confirmed through `/herdr-dispatch-cancel`. It asks the target to stop and emit a `cancelled` Result Envelope. Reservations remain until a valid result or manual resolution.

V1 does not send `Ctrl+C`. If normal cancellation does not settle, the UI instructs the user to focus the target pane, interrupt it manually, verify that it is idle-like, then run `/herdr-dispatch-resolve`.

`delivery-unverified`, `result-missing`, and `target-lost` have no standalone lease-release operation. Manual resolution:

1. shows current target/worktree status and bounded untrusted output;
2. requires `blocked`, `failed`, or `cancelled` plus a summary; manual resolution never claims `done`;
3. asks for a second confirmation;
4. records the resolver session ID;
5. atomically settles and releases reservations.

The Origin Session normally resolves its own records. A different local TUI session may perform an explicitly labelled **emergency resolution** only when the user judges the Origin Session unavailable. The UI shows the Origin Session ID and last-known evidence, requires the user to attest unavailability in the first confirmation, and repeats the emergency nature and reservation release in the second confirmation; process absence is not inferred as authoritative availability evidence. The emergency resolver cannot adopt monitoring or inject a result into its own model context.

Automatic settlement and emergency resolution race through the same transactional unsettled-to-settled compare-and-set. First settlement wins; the loser reports the already-recorded Final Outcome and performs no second release or context delivery.

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

Pane revision is not an acceptance criterion. Correlation IDs are random and created immediately before automatic delivery, so a valid pre-delivery match is not expected. The residual risk that a compromised target emits an early false Result Envelope is accepted and tested explicitly.

The first output match commonly contains the outbound contract template before the Agent has produced a result. The Origin Monitor therefore performs exponentially spaced, bounded 200-line re-reads through the configured startup window. Incomplete matching JSON is not marked malformed during that window, and the exact `done|blocked|failed|cancelled` / `"..."` contract template is ignored as a result attempt. A matching result still malformed on the final read adds `malformed-result`, stores bounded raw evidence, and notifies; it never settles or causes resend. The first valid accepted result wins transactionally. Later duplicates or conflicts are audit events and cannot settle twice ([ADR 0008](./adr/0008-reread-streamed-results-through-startup-window.md)).

Settlement independently computes Git status, changed files, and diff statistics; it does not run tests. Agent-reported tests remain untrusted.

## Untrusted output and model context

Raw pane output never enters parent model context **through settlement**. The Origin Session receives only a bounded Sanitized Dispatch Result marked as untrusted data.

An explicit Agent Output Inspection is a separate, user-authorized path that does return up to 200 ANSI-stripped lines to the model. Its tool result is wrapped as data:

```text
<untrusted-agent-output terminal="...">
...
</untrusted-agent-output>
```

The wrapper instructs the model to treat the body as data, not instructions. Allowed current-pane Herdr reads invoked through `bash` use equivalent `<untrusted-herdr-cli-output>` framing before their output enters context. Blocked-runtime captures shown only in TUI/notifications do not enter model context unless the user explicitly invokes inspection.

## Origin Session result delivery

Settlement records the result, final outcome, audit data, and reservation release in one SQLite transaction and emits a Herdr notification.

The Origin Session queues one custom result message with `pi.sendMessage(..., { deliverAs: "nextTurn", triggerTurn: false })`. Pi retains it until the next user-initiated turn; it does not append an active-branch entry or start a model turn while idle. Once that user turn persists the custom message, the `agent_end` hook completes the durable claim. Exactly-once delivery is checked against the **active branch**:

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

Phase 5 re-evaluated the process-local Registry mutation fuse under multi-process monitoring load. Exhausted `busy_timeout` with `SQLITE_BUSY`/`SQLITE_LOCKED` now fails the current operation without permanently disabling later mutations because no transaction began and lock contention is transient. Corruption, migration errors, and structurally unexpected mutation failures still trip the process-local fuse; no fallback database or memory state is created ([ADR 0001](./adr/0001-sqlite-dispatch-registry.md)).

Per-workspace concurrency is counted by **target workspace**. V1 target and origin workspaces are the same, but the resource definition remains explicit.

## Herdr UI and metadata

Herdr 0.7.3 protocol 16 has no dedicated pane metadata-token field, and independently sourced `custom_status` reports replace one another in the effective Agent view. V1 therefore emits **no pane metadata** and never calls `pane.report_metadata`. It relies on the Pi widget plus Herdr notifications, avoiding interference with integration-owned title, displayed Agent, state labels, and custom status.

Herdr notifications occur only for Final Outcomes and Attention Conditions:

- `done`: sound `done`;
- blocked, failed, overdue, malformed, result-missing, target-lost, monitoring-paused, unacknowledged, delivery-unverified: sound `request`;
- cancelled: sound `none`.

Pi shows a one-line widget below the editor while records are active, for example `dispatches: 2 running · 1 attention · alt+h manager`. The widget reads current Registry counts on every render rather than capturing a state snapshot, so an ordinary TUI repaint repairs any missed change notification. Its groups match the Manager: `running` counts only Active Dispatches with no Attention Conditions, `delivering` counts only clean Delivering Dispatches, and `attention` counts affected dispatches rather than summing concurrent conditions. It does not modify the existing custom footer. Human-facing rows, notifications, confirmations, and result cards lead with sanitized Agent/task display data rather than correlation IDs; canonical IDs remain in protocol, Registry, audit, model data, completion values, and explicit technical details.

All human-facing product copy is built by the typed pure catalog in `src/pi/ui-copy.ts`; presentation modules supply typed state, counts, timing, and sanitized display data, then apply layout and theme colors without defining English prose inline. Contractual model-facing and target-facing safety/framing strings remain owned by their protocol boundaries (`presentation.ts`, `safety-gate.ts`, context delivery, proposals, and follow-ups) and are not catalog entries. This separation allows human copy to change without changing model instructions, untrusted-data wrappers, or outbound protocol bytes.

## User interface

### Commands

Every command keeps its descriptive long name for compatibility and registers a compact, readable `hd-*` interactive alias:

- `/hd-agents` (`/herdr-agents`) — Agent metadata from the current Workspace Scope only.
- `/hd-new` (`/herdr-dispatch`) — manual dispatch wizard; completion sends immediately without a final confirmation prompt.
- `/hd-manager` (`/herdr-dispatches`) — interactive current-workspace Dispatch Manager; `alt+h` opens the same panel. It groups attention, running, and delivering records, keeps a small current-Origin settled fold, and offers one-shot `r`/`R` output reads framed as untrusted.
- `/hd-reply [id-or-prefix]` (`/herdr-dispatch-reply`) — filtered task selection followed by a previewed reply for an Active Dispatch with attention.
- `/hd-cancel [id-or-prefix]` (`/herdr-dispatch-cancel`) — filtered task selection followed by a previewed normal cancellation.
- `/hd-resolve [id-or-prefix]` (`/herdr-dispatch-resolve`) — current-workspace task selection followed by manual or double-confirmed emergency resolution.
- `/hd-output <target> [lines]` (`/herdr-agent-output`) — one bounded, untrusted-framed output inspection.
- `/hd-setup` (`/herdr-dispatch-setup`) — optional, per-integration installation prompts.

There is no automatic force-cancel command in V1.

The optional selector is an advanced escape hatch. Exact IDs win; otherwise a prefix must resolve unambiguously across retained current-workspace records. Zero matches fail closed, multiple matches require explicit human selection, and a settled match reports its recorded outcome. No `latest`, `last`, or ordinal alias is accepted. Reply and cancellation candidates remain exact-Origin only; foreign-Origin records expose only emergency resolution.

The manager is live: `DispatchRuntime.onStateChanged()` requests a render after Registry-backed changes and a 30-second tick refreshes relative time. Selection is retained by canonical ID internally. Output inspection is never automatic or streamed: `r` performs one 50-line read and `R` one 200-line read, each timestamped and bounded.

### Model tools

- `herdr_agents_list` — always restricted to the current Workspace Scope; no all-workspaces parameter.
- `herdr_dispatch_propose`
- `herdr_dispatch_status`
- `herdr_agent_output_inspect`

`herdr_dispatch_propose` registers an explicit prompt guideline: **Use `herdr_dispatch_propose` for every request to task another Herdr Agent. Do not use `bash`, `user_bash`, or raw `herdr pane` / `herdr agent` / `herdr wait` commands to send work or wait for it.** It sends automatically through the typed path without a confirmation prompt. The other dispatch tools reinforce the same raw-command rule when active.

There is no model wait, reply, cancel, force-cancel, resolve, Agent-start, pane-create, workspace-create, or worktree-create tool.

Agent output inspection is authorized by an explicit user request. A user request itself is sufficient; no redundant confirmation appears. Default output is the 50 most recent `recent_unwrapped` plain-text lines, with ANSI removed; the configured maximum is 200. One request authorizes one bounded read, not continuing surveillance.

### Run-mode rules

Automatic proposal delivery, reply, cancellation, resolution, Origin Monitoring, and context delivery require `ctx.mode === "tui"`; checking `ctx.hasUI` is insufficient because RPC reports UI capability. Automatic proposal delivery does not open a confirmation prompt. Non-TUI modes may list current state and perform an explicitly requested bounded inspection only. The lease guard and raw Herdr CLI gate remain active in every mode because they prevent non-Origin Pi processes and skill-guided shell calls from bypassing the typed dispatch path.

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
  "livenessPollMs": 5000
}
```

The inspection bounds (50-line default, 200-line hard limit) and the 200-line catch-up read are fixed constants, not configuration. Invalid configuration disables state-changing functionality. Line bounds are requests to Herdr, not guarantees about retained history; a shorter returned tail is accepted and absence never proves non-delivery.

## Authoritative Herdr semantics

The official [Herdr agent skill](https://herdr.dev/docs/agent-skill/) is an implementation reference alongside the installed CLI/schema. It explicitly guarantees that closed pane/tab IDs are not reused and defines `done` as completed with an unseen result, while `idle` is waiting with the result considered seen. On this machine the same skill is globally available to Pi at `~/.agents/skills/herdr/SKILL.md`.

## Required compatibility checks before implementation planning

The live Herdr 0.7.3 spike is complete; methods and evidence are recorded in [SPIKE-RESULTS.md](./SPIKE-RESULTS.md). It established:

- terminal IDs change across a clean server restart, so missing stored identity becomes `target-lost`;
- moving a pane across workspaces changes pane ID while retaining terminal ID, and closed IDs were not reused;
- `recent_unwrapped` defaults to 80 logical lines, honors requests through 1000, and silently clamps larger requests to 1000; V1 requests only 50 or 200 and never interprets missing tail content as proof;
- `pane.send_input.keys: ["Enter"]` matches the installed `herdr pane run` CLI exactly; lowercase aliases observed in a disposable shell are not treated as cross-TUI compatibility evidence;
- explicit `screen_detection_skipped: true` positively identifies recognized full-lifecycle integration authority; missing/false remains screen-detected;
- dedicated metadata-token coexistence is unavailable, so V1 omits pane metadata;
- unary sockets accept one request while `events.subscribe` owns a separate long-lived stream;
- a real Pi TUI probe rendered the random ID with leading whitespace and exposed it on the first post-send bounded read, so V1 still performs bounded startup-window re-reads and matches the uniquely bounded marker within a rendered line.

These results tighten behavior to attention/fail-closed. They do not introduce heuristic retargeting, revision cursors, or split delivery.

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
- untrusted output framing for typed inspection and allowed current-pane Herdr reads;
- Origin Session ID and active-branch delivery rules;
- emergency-resolution eligibility, user attestation, and double confirmation;
- stored socket-disconnect versus derived Origin-closed monitoring pauses;
- retention and notification policy;
- omission of `pane.report_metadata` on Herdr 0.7.3.

### Integration

Use a fake Herdr Unix socket and temporary SQLite database to test:

- staged multiline text, route revalidation, separate Enter submission, exact echo activation, and fail-closed protocol mismatch;
- crash before send, during send, after Herdr success, and before `active` commit;
- resume of `delivering` with result present, echo present, or neither present;
- pane close/move between final revalidation and send, including conformance with the official closed-ID non-reuse guarantee;
- globally unique Target Occupancy and Worktree Write Leases across Pi processes;
- raw `bash` and `user_bash` attempts to run `pane run`, `agent send/start`, `pane split`, and blocking waits;
- harmless Herdr metadata commands and current-pane reads remaining usable with untrusted output framing while foreign reads and `api snapshot` are denied;
- two Origins racing to acquire the same target/worktree;
- result settlement racing an emergency manual resolution, with transactional first-wins behavior;
- emergency resolution rejecting automatic liveness inference and requiring a non-Origin TUI plus user attestation;
- active-branch result append crash/retry and branch change during append;
- Herdr disconnect/reconnect with bounded Catch-Up Read;
- target ending in `done` without a result;
- terminal ID changing after Herdr restart, adding `target-lost`, and requiring manual resolution before settlement;
- no pane-ID/cwd/Agent-label heuristic retargeting after restart;
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
7. Exercise overdue, normal cancellation, manual interrupt guidance, result-missing, and target-lost.
8. Restart Herdr during active work and record identity/history behavior without assuming continuity.
9. Verify no result triggers a model turn and forks/clones do not claim Origin results.
10. Verify settlement injects only sanitized results while explicit inspection returns untrusted-framed output.
11. Ask Pi naturally to “use Herdr to task the adjacent Agent” and verify the official skill cannot bypass the typed dispatch path through `bash`, `!`, or `!!`; verify current-pane reads still work, while repeated foreign reads and `api snapshot` redirect to typed tools.
12. Verify Registry failure preserves reservations and disables state changes.

## Review findings addressed

- **C1:** durable delivery intent plus Delivery Echo Verification and `delivery-unverified`; no automatic resend.
- **C2:** removed revision cursors and revision-based acceptance; bounded tail catch-up plus correlation/source/schema matching.
- **H1:** removed coordinator takeover entirely.
- **H2:** removed `guarded` from V1; all target constraints are advisory.
- **H3:** immediate route revalidation through tightly adjacent one-request unary connections, close/move observation on the exclusive subscription stream, post-send echo verification, and a narrowed residual race; Herdr's official closed-ID non-reuse guarantee removes the pane-ID-retargeting worst case.
- **H4:** `done` is idle-like for eligibility, result-missing, and manual cancellation guidance, matching Herdr's official “completed, result unseen” semantics.
- **H5:** raw output exclusion is settlement-specific; explicit inspection and allowed current-pane reads use untrusted framing.
- **H6:** the same origin-side classifier gates `bash` and `user_bash`, dispatch-sensitive raw Herdr commands are denied, scoped metadata inspection and current-pane reads remain available, and dispatch tools explicitly instruct the model to use `herdr_dispatch_propose`.
- **N1:** foreign pane/Agent reads and `api snapshot` are denied so raw CLI cannot bypass one-shot inspection authorization or Workspace Scope.
- **N2–N4:** emergency availability is user-attested with transactional first-wins settlement; Final Outcome terminology is consistent; stored and derived monitoring-paused semantics are distinct.

## Decisions recorded separately

- [ADR 0001: Use SQLite for the global Dispatch Registry](./adr/0001-sqlite-dispatch-registry.md)
- [ADR 0002: Deliver dispatches through atomic Herdr pane input](./adr/0002-atomic-herdr-input-delivery.md)
- [ADR 0006: Stage multiline input before submitting Enter](./adr/0006-stage-multiline-input-before-submit.md)
- [ADR 0007: Author unattended dispatch with scoped Automation Grants (superseded)](./adr/0007-scoped-automation-grants.md)
- [ADR 0008: Re-read streamed results through the startup window](./adr/0008-reread-streamed-results-through-startup-window.md)
- [ADR 0009: Dispatch automatically by default](./adr/0009-automatic-dispatch-by-default.md)
- [ADR 0003: Model lifecycle, attention, and outcome separately](./adr/0003-orthogonal-dispatch-state.md)
- [ADR 0004: Use per-origin monitoring in V1](./adr/0004-per-origin-monitoring.md)
- [ADR 0005: Gate raw Herdr tasking inside Pi](./adr/0005-gate-raw-herdr-tasking.md)
