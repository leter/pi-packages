# Agent Workspace Orchestration

This context coordinates existing coding agents on one local Herdr server without creating agents, panes, worktrees, or workspaces. Remote Herdr sessions are outside V1.

## Language

**Existing Agent**:
A coding agent already running in a Herdr pane.
_Avoid_: worker, subagent

**Eligible Agent**:
An Existing Agent currently reported as idle, distinct from the Origin Session's own terminal ID, and not otherwise excluded by dispatch safety rules. A proposal identifies whether status came from an Agent integration or screen detection; screen-detected targets are allowed but ambiguous transitions require attention rather than inferred settlement.
_Avoid_: self-dispatch, working agent, blocked agent, unknown pane, hidden status provenance

**Dispatch Proposal**:
An immutable preview of the complete outbound message, target, Dispatch Mode, target directory or worktree, deadline, constraints, Dispatch Correlation ID, and Result Envelope contract that has not yet been sent. V1 constraints prohibit the Dispatch Target from delegating the work to another agent. Project dependency installation is allowed only when shown explicitly in a write proposal and must remain project-scoped with lockfile changes; global and system installation are forbidden.
_Avoid_: task, command, hidden wrapper, recursive delegation, implicit dependency installation

**Dispatch Confirmation**:
The user's approval of one current Dispatch Proposal, authorizing its delivery exactly as shown after target and lease revalidation; both manual commands and model-authored proposals require it.
_Avoid_: automatic dispatch, stale approval, privileged entry point

**Revised Proposal**:
A new immutable Dispatch Proposal produced after the user edits a target, mode, deadline, constraint, or message; it must be previewed and confirmed again.
_Avoid_: edit-and-send

**Stale Proposal**:
A Dispatch Proposal invalidated because its target identity, workspace, directory or worktree, availability, or lease state changed before delivery; it must be regenerated and reconfirmed.
_Avoid_: best-effort delivery

**Workspace Scope**:
The Herdr workspace containing the Pi session that creates a Dispatch Proposal.
_Avoid_: all panes, global workspace

**Cross-Workspace Dispatch**:
A Dispatch Proposal targeting an Existing Agent outside the Workspace Scope; it requires the user's latest message to contain a uniquely resolvable Agent name, terminal ID, or working directory, followed by normal full confirmation.
_Avoid_: implicit cross-project dispatch, model-selected foreign target

**Dispatch Target**:
The Existing Agent selected for a Dispatch Proposal, displayed with its label, working directory, and status and identified for delivery by its Herdr terminal ID.
_Avoid_: agent name alone, pane name

**Agent Output Inspection**:
A single read of an Existing Agent's 50 most recent plain-text lines, configurable up to 200 lines, for progress or result reporting; it is authorized by an explicit user request or performed for an Active Dispatch, and the explicit request itself is sufficient authorization.
_Avoid_: ANSI capture, unrestricted transcript scraping, repeated implicit reads

**Dispatch Lifecycle**:
The primary progression of one dispatch: proposed, delivering, active, then settled. Operational problems are separate Attention Conditions rather than additional lifecycle states.
_Avoid_: combinatorial state enum

**Attention Condition**:
A concurrent condition requiring visibility or user action, such as overdue, unacknowledged, blocked-runtime, monitoring-paused, malformed-result, result-missing, target-lost, or target-moved; multiple conditions may coexist.
_Avoid_: primary lifecycle, single overwritten error state

**Malformed Result**:
A bounded `DISPATCH_RESULT` line with a matching correlation ID that fails JSON or schema validation; it is retained for audit and triggers attention but never settles a dispatch or causes an automatic retry.
_Avoid_: guessed result, silent result-missing

**Active Dispatch**:
A confirmed Dispatch Proposal that has been delivered, exclusively occupies its Dispatch Target, remains visible through renewable Herdr pane metadata without renaming the pane or Agent, and stays under automatic monitoring until it reaches a terminal outcome.
_Avoid_: passive agent observation, concurrent assignment, pane rename

**Unacknowledged Dispatch**:
An Active Dispatch whose target did not transition from idle to working within the startup window after delivery; the window defaults to 30 seconds and is configurable from 5 seconds through 5 minutes. It retains its target occupancy and any Worktree Write Lease and is not automatically resent.
_Avoid_: delivery success, automatic retry

**Dispatch Correlation ID**:
A unique identifier embedded in a Dispatch Proposal and its required result marker, binding a reported outcome to one Active Dispatch.
_Avoid_: pane status, task name

**Dispatch Result**:
A machine-readable terminal outcome emitted by the Dispatch Target for one Dispatch Correlation ID.
_Avoid_: idle status, inferred completion

**Attention-Required Dispatch**:
An Active Dispatch whose target reports Herdr's blocked runtime state without a Result Envelope; the coordinator reads 50 recent lines and notifies the user while retaining target occupancy and any Worktree Write Lease.
_Avoid_: blocked Dispatch Outcome, autonomous reply

**Result-Missing Dispatch**:
An Active Dispatch whose target is idle without emitting its required Dispatch Result; it requires user action and must not be automatically nudged.
_Avoid_: completed dispatch

**Target-Lost Dispatch**:
An Active Dispatch whose terminal ID disappeared before settlement; monitoring pauses, the user is notified, and any Worktree Write Lease remains until the user inspects and resolves it.
_Avoid_: automatic retargeting, automatic lease release

**Target-Moved Dispatch**:
An Active Dispatch whose target leaves its confirmed directory or worktree; normal settlement pauses, the original Worktree Write Lease remains, no lease is automatically acquired for the new location, and the user must inspect and resolve it.
_Avoid_: automatic lease transfer, ignored directory drift

**Dispatch Mode**:
The declared mutation contract of a Dispatch Proposal: non-mutating requests investigation and reporting without file changes, while write is permitted only in a Git worktree and reserves that worktree for one Active Dispatch. Non-mutating is technically enforced only where the target harness provides such controls; otherwise it is audited for Git targets and advisory for non-Git targets. V1 write dispatches are limited to local file changes and local validation and may not commit, push, deploy, publish, mutate remote systems, or perform destructive cleanup.
_Avoid_: read-only guarantee, implied write access, non-Git write dispatch, external side effects

**Enforcement Level**:
The proposal's disclosure of whether dispatch constraints are actively guarded by the target harness or are advisory instructions backed only by observable audits. Both levels may receive write dispatches after confirmation; advisory proposals explicitly warn that remote side effects cannot be audited.
_Avoid_: hidden advisory enforcement, universal safety claim

**Mutation Audit**:
A before-and-after comparison of a Git worktree around a non-mutating Active Dispatch, used to detect observed changes without claiming process-level attribution; it is inconclusive when a write dispatch overlaps the same worktree. Settlement computes worktree status, changed files, and diff statistics but does not automatically execute tests or other project commands; tests reported by the Agent remain untrusted data.
_Avoid_: sandbox, proof of authorship, automatic test execution

**Mutation Violation**:
A non-mutating Dispatch Result accompanied by an attributable worktree change; for changes that cannot be attributed, report an inconclusive audit instead.
_Avoid_: silent mutation, inferred authorship

**Worktree Write Lease**:
The exclusive reservation created by a write-mode Active Dispatch for its target worktree. Every Pi instance using the extension blocks its own edit/write calls and clearly mutating shell calls in that worktree unless it is the lease-holding Dispatch Target; read-only operations remain available. Manual shells and processes without the extension remain outside this guard.
_Avoid_: shared editing, unrestricted origin editing, claimed OS-level lock

**Write-Lease Conflict**:
A proposed write dispatch targeting a worktree with an existing Worktree Write Lease anywhere in the Dispatch Registry; the proposal is rejected until the user waits for or cancels the lease holder.
_Avoid_: automatic preemption, shared editing, workspace-local conflict detection

**Dispatch Outcome**:
The terminal status of a Dispatch Result: done, blocked, failed, or cancelled. Every outcome settles the dispatch and releases any Worktree Write Lease; continuing after blocked requires a newly confirmed Dispatch Proposal.
_Avoid_: free-form status, paused blocked state

**Result Envelope**:
A single `DISPATCH_RESULT` line containing schema-validated JSON with a Dispatch Correlation ID, Dispatch Outcome, and bounded summary; accepted optional fields are tests, changed files, artifacts, and blocker, while unknown or oversized fields are excluded from parent context.
_Avoid_: prose-only completion marker, unbounded result

**Sanitized Dispatch Result**:
A bounded, schema-valid subset of a Result Envelope marked as untrusted data before it enters the parent Pi session; the raw envelope remains in the Dispatch Registry only.
_Avoid_: raw pane output, trusted instructions

**Dispatch Settlement**:
The atomic recording of a terminal result in the Dispatch Registry, release of an Active Dispatch's Worktree Write Lease, and a Herdr notification; notifications are emitted only for terminal outcomes and attention states, not normal acknowledgements or progress. The origin Pi session claims its Sanitized Dispatch Result while active or when next resumed, without triggering a model turn. Result-Missing and Target-Lost dispatches may settle only through a secondarily confirmed manual resolution that records failed or cancelled plus a summary after showing current worktree state; no standalone lease release exists.
_Avoid_: autonomous continuation, cross-process session-file mutation, coordinator-session delivery, progress notification spam, orphaned manual lease release

**Origin Session**:
The Pi session that confirmed a Dispatch Proposal and is the sole destination for its Sanitized Dispatch Result in model context.
_Avoid_: current coordinator session, any Pi session

**Overdue Dispatch**:
An Active Dispatch that has exceeded its confirmed deadline, defaulting to 30 minutes and constrained to 1 minute through 24 hours, while still being monitored and retaining any Worktree Write Lease; it requires the user to wait or cancel.
_Avoid_: automatic cancellation, released lease

**Dispatch Reply**:
A user-confirmed follow-up message sent to an Attention-Required Dispatch under the same Dispatch Correlation ID, target occupancy, and Worktree Write Lease; it does not extend the deadline unless the confirmation explicitly changes it.
_Avoid_: new dispatch, autonomous reply, implicit deadline extension

**Cancellation Request**:
A user-confirmed message asking the Dispatch Target to stop one Active Dispatch and return a cancelled Result Envelope; monitoring and any Worktree Write Lease continue until that result arrives.
_Avoid_: immediate lease release, implicit interrupt

**Forced Cancellation**:
A secondarily confirmed interrupt sent after a Cancellation Request fails to settle; it becomes a cancelled Dispatch Outcome and releases any Worktree Write Lease only after the target reports idle and the Mutation Audit completes.
_Avoid_: immediate lease release, unconfirmed interrupt

**Dispatch Registry**:
The global durable record of proposals, Active Dispatches, deadlines, outcomes, pane revisions, Worktree Write Leases, and append-only audit events across local Herdr workspaces, recoverable by Pi after Pi or Herdr restarts. Current state is stored directly rather than rebuilt through event sourcing. Settled records and their events are retained for 30 days by default, configurable from 1 through 365 days; unsettled records are never automatically purged. V1 proposals contain exactly one dispatch; independently confirmed dispatches are limited by default to four active per workspace and eight globally, with configurable limits. Registry corruption, failed migration, or unavailable transactional access fails closed and never falls back to an empty or in-memory registry.
_Avoid_: chat-local state, pane-local state, per-workspace lease silo, permanent settled history, batch confirmation, unbounded fan-out, state-loss fallback, full event sourcing

**Recovery Scan**:
A bounded scan of a Dispatch Target's pane history from the revision captured at delivery, used after coordinator takeover to recover an exact matching Result Envelope; missing history produces a Result-Missing Dispatch rather than an inferred outcome.
_Avoid_: live-output-only recovery, inferred completion

**Coordinator Lease**:
The renewable, exclusive right held by one Pi instance to monitor and settle Active Dispatches; it lasts 30 seconds and is renewed every 10 seconds, and another Pi may take over only after it expires.
_Avoid_: duplicate coordinators, permanent ownership

**Monitoring-Paused Dispatch**:
An Active Dispatch temporarily unobservable because the local Herdr server or socket is unavailable; target occupancy and leases remain, one notification is emitted, reconnection uses exponential backoff, and recovery revalidates the target and scans pane history.
_Avoid_: failure settlement, lease release, retry spam
