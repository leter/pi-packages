# Agent Workspace Orchestration

This context coordinates confirmed work sent to existing coding agents in one local Herdr workspace. It does not create agents, panes, workspaces, or worktrees.

## Actors and scope

**Existing Agent**:
A coding agent already running in a Herdr pane.
_Avoid_: worker, subagent

**Workspace Scope**:
The local Herdr workspace containing the Origin Session and every Agent eligible for its dispatches.
_Avoid_: all workspaces, remote workspace

**Origin Session**:
The specific Pi session that confirms a dispatch, monitors it while running, and receives its sanitized result. Forks and clones are different sessions.
_Avoid_: current Pi, any Pi, coordinator

**Eligible Agent**:
An Existing Agent in the Workspace Scope whose runtime status is idle-like and which has no Target Occupancy. Herdr `idle` means waiting with the result considered seen; `done` means completed with the result unseen, so both are idle-like.
_Avoid_: self, working Agent, blocked Agent, unknown pane

**Dispatch Target**:
The Eligible Agent selected to receive one dispatch, identified by its Herdr terminal identity rather than a mutable name or pane route.
_Avoid_: Agent name alone, pane name

**Target Occupancy**:
The exclusive assignment of one unsettled dispatch to one Dispatch Target. An occupied target cannot receive another dispatch.
_Avoid_: concurrent assignment

## Proposal and delivery

**Dispatch Proposal**:
An immutable preview of the complete outbound message, Dispatch Target, mutation contract, confirmed location, deadline, constraints, correlation ID, and result contract.
_Avoid_: task, hidden wrapper, batch

**Dispatch Confirmation**:
The user's approval of one current Dispatch Proposal, authorizing delivery exactly as previewed after revalidation.
_Avoid_: automatic dispatch, stale approval

**Revised Proposal**:
A new Dispatch Proposal produced after any confirmed field is edited; it requires another complete preview and confirmation.
_Avoid_: edit-and-send

**Stale Proposal**:
A Dispatch Proposal invalidated because its target, location, availability, occupancy, or lease state changed before delivery.
_Avoid_: best-effort delivery

**Dispatch Correlation ID**:
A unique identifier binding a confirmed outbound message, delivery evidence, and Result Envelope to one dispatch.
_Avoid_: task name, pane status

**Delivery Evidence**:
Target output containing either the uniquely bounded correlation marker `ID: hd_...` or a valid matching Result Envelope, demonstrating that the dispatch reached the target.
_Avoid_: send attempt, status transition

## Lifecycle and attention

**Dispatch Lifecycle**:
The primary progression of one dispatch: proposed, delivering, active, then settled. Operational problems are represented separately as Attention Conditions.
_Avoid_: combinatorial state enum

**Delivering Dispatch**:
A confirmed dispatch whose Target Occupancy and any Worktree Write Lease are held while delivery remains incomplete or uncertain.
_Avoid_: active dispatch, safe-to-resend dispatch

**Active Dispatch**:
A delivered dispatch that retains Target Occupancy and remains eligible for Origin Session monitoring until settlement, except while a pausing Attention Condition applies.
_Avoid_: passive observation, concurrent assignment

**Attention Condition**:
A concurrent fact requiring visibility or user action without replacing the Dispatch Lifecycle. Multiple Attention Conditions may coexist.
_Avoid_: lifecycle state, overwritten error

**Delivery-Unverified Dispatch**:
A Delivering Dispatch for which delivery success cannot be established. It retains all reservations and is never automatically resent.
_Avoid_: undelivered dispatch, retryable dispatch

**Unacknowledged Dispatch**:
An Active Dispatch for which no reliable execution-start signal was observed after delivery.
_Avoid_: undelivered dispatch, automatic retry

**Blocked-Runtime Dispatch**:
An Active Dispatch whose Agent reports Herdr's blocked runtime state without issuing a Final Outcome.
_Avoid_: blocked Final Outcome, Attention-Required Dispatch

**Overdue Dispatch**:
An unsettled dispatch that has exceeded its confirmed deadline while retaining its reservations.
_Avoid_: cancelled dispatch, released lease

**Malformed Result**:
A matching result attempt that fails JSON or schema validation. It never settles the dispatch or causes an automatic retry.
_Avoid_: guessed result, silent failure

**Result-Missing Dispatch**:
An Active Dispatch whose target became idle-like without issuing a valid Result Envelope.
_Avoid_: completed dispatch, inferred success

**Target-Lost Dispatch**:
An unsettled dispatch whose confirmed terminal identity disappeared before settlement.
_Avoid_: automatic retargeting, automatic release

**Target-Moved Dispatch**:
An unsettled dispatch whose target persistently left its confirmed directory or worktree.
_Avoid_: transient child-shell directory, automatic lease transfer

**Monitoring-Paused Dispatch**:
An unsettled dispatch whose monitoring is temporarily paused. An active Origin Monitor stores this Attention Condition when its local Herdr connection is unavailable. When the Origin Session itself is closed, the monitoring gap is a derived fact recognized on resume, not a condition written while no monitor is running. Reservations remain intact in either case.
_Avoid_: failed dispatch, takeover candidate, necessarily stored condition

## Mutation and safety

**Dispatch Mode**:
The declared mutation contract: non-mutating requests investigation without file changes; write permits local changes only in one confirmed Git worktree. Both are advisory to the Dispatch Target in V1.
_Avoid_: read-only guarantee, external side-effect permission

**Observed Mutation**:
A worktree change seen during a non-mutating dispatch without attributing authorship to the Dispatch Target. Overlapping known writers make the observation inconclusive.
_Avoid_: Mutation Violation, proof of authorship

**Worktree Write Lease**:
The exclusive reservation of one Git worktree for one write-mode Active or Delivering Dispatch. The package reduces conflicts on covered Pi-side file and Herdr-command paths but does not claim an operating-system lock.
_Avoid_: shared editing, universal mutation prevention

**Write-Lease Conflict**:
A proposed write dispatch targeting a worktree with an existing Worktree Write Lease.
_Avoid_: automatic preemption, automatic downgrade

**Advisory Safety**:
The explicit disclosure that target constraints depend on Agent compliance and observable audits rather than enforced removal of target tools.
_Avoid_: guarded target, sandbox guarantee

**Dispatch Bypass**:
Any path that tasks or waits on another Agent outside a confirmed dispatch, leaving the Dispatch Registry unaware. This includes skill-guided raw Herdr commands from the Origin Pi as well as external shells and uncovered tools.
_Avoid_: manual shell only, harmless command

**Herdr Command Gate**:
The best-effort Origin-side rule that allows scoped metadata inspection and reads of the current Pi pane while denying foreign output reads, cross-workspace snapshots, tasking, Agent creation, foreign-pane control, and blocking waits that would bypass typed policies.
_Avoid_: shell sandbox, target-side enforcement

## Results and resolution

**Final Outcome**:
The result status that settles a dispatch: done, blocked, failed, or cancelled. Continuing after blocked requires a new confirmed dispatch.
_Avoid_: terminal status, free-form status, paused blocked state

**Result Envelope**:
A single machine-readable line containing a Dispatch Correlation ID, Final Outcome, and bounded summary, with optional bounded result metadata.
_Avoid_: prose-only completion marker, unbounded result

**Sanitized Dispatch Result**:
The bounded, schema-valid subset of a Result Envelope marked as untrusted data before entering the Origin Session's model context.
_Avoid_: raw pane output, trusted instructions

**Agent Output Inspection**:
A single user-authorized, bounded read of an Existing Agent's output, framed as untrusted data when returned to a model.
_Avoid_: unrestricted transcript scraping, trusted pane text, continuing surveillance

**Dispatch Settlement**:
The indivisible recording of a Final Outcome, release of Target Occupancy and any Worktree Write Lease, and queuing of the Sanitized Dispatch Result for the Origin Session's next user-initiated turn without starting a model turn.
_Avoid_: autonomous continuation, partial release

**Dispatch Reply**:
A separately confirmed follow-up sent to an unsettled dispatch with attention, retaining the same correlation ID and reservations.
_Avoid_: new dispatch, autonomous reply

**Cancellation Request**:
A confirmed request asking the Dispatch Target to stop and issue a cancelled Result Envelope. It does not itself settle or release reservations.
_Avoid_: forced interrupt, immediate release

**Manual Resolution**:
A double-confirmed Final Outcome recorded when automatic settlement is unsafe or impossible, after presenting current target and worktree evidence. It is the only manual way to release reservations.
_Avoid_: standalone lease release, inferred outcome

**Emergency Resolution**:
A Manual Resolution performed by a non-Origin TUI session only after the user judges and twice confirms that the Origin Session is unavailable. It does not transfer monitoring or deliver context to the resolver. If it races automatic settlement, the first transactional settlement wins and the loser only reports the recorded Final Outcome.
_Avoid_: automatic takeover, process-liveness proof, second settlement

## Durable state

**Dispatch Registry**:
The durable source of truth for dispatches, reservations, results, context delivery, and audit history across local Pi processes. It fails closed rather than forgetting unsettled reservations.
_Avoid_: chat-local state, in-memory fallback, full event sourcing

**Origin Monitor**:
The monitoring role performed only by the running TUI Origin Session for dispatches it confirmed. V1 has no takeover by another Pi session.
_Avoid_: global coordinator, foreign-session settlement
