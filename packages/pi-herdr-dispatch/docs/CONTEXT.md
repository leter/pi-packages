# Agent Workspace Orchestration

This context coordinates automatically dispatched work sent to coding agents in one local Herdr workspace. A user may launch one new Agent as part of a typed TUI dispatch; the context does not create workspaces and creates a worktree only as a user-selected Agent Launch step.

## Actors and scope

**Existing Agent**:
A coding agent already running in a Herdr pane, whether it predated the Origin Session or became available through a completed Agent Launch.
_Avoid_: worker, subagent

**Agent Launch**:
A user-initiated TUI operation that optionally creates one user-selected Task Worktree for write mode, creates one Agent pane or tab in the Workspace Scope and selected directory, starts one supported Agent with either current Herdr integration provenance or an explicitly reviewed screen-detection fallback, waits until it is eligible, and then submits a fresh Automatic Dispatch. The created Agent and any Task Worktree remain after failure or settlement; launch never implies automatic cleanup or ownership.
_Avoid_: model-created Agent, temporary worker, autonomous scaling, model-created worktree

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
An immutable complete outbound message binding the Dispatch Target, mutation contract, target location, deadline, constraints, correlation ID, and result contract. The typed TUI path automatically delivers it after revalidation without authorization state or a confirmation prompt.
_Avoid_: mutable task, hidden wrapper, authorization request

**Automatic Dispatch**:
The default delivery of one immutable Dispatch Proposal through the typed TUI path without per-dispatch confirmation, grant setup, count limit, or expiry. Target identity, workspace, cwd/worktree, occupancy, leases, concurrency, durable intent, delivery echo, and result validation remain enforced.
_Avoid_: raw Herdr bypass, best-effort retargeting, skipped revalidation

**Stale Proposal**:
A Dispatch Proposal invalidated because its target, location, availability, occupancy, or lease state changed before delivery.
_Avoid_: best-effort delivery

**Dispatch Correlation ID**:
A unique machine identifier binding an immutable outbound message, delivery evidence, Registry record, follow-up, and Result Envelope to one dispatch. It is an internal correlation detail in ordinary human interaction; users select dispatches by sanitized Agent/task context, while full IDs remain available in explicit technical details and command completion.
_Avoid_: human task label, required manual input, pane status

**Delivery Evidence**:
Target output containing either the uniquely bounded correlation marker `ID: hd_...` or a valid matching Result Envelope, demonstrating that the dispatch reached the target.
_Avoid_: send attempt, status transition

## Lifecycle and attention

**Dispatch Lifecycle**:
The primary progression of one dispatch: proposed, delivering, active, then settled. Operational problems are represented separately as Attention Conditions.
_Avoid_: combinatorial state enum

**Delivering Dispatch**:
An automatically created dispatch whose Target Occupancy and any Worktree Write Lease are held while delivery remains incomplete or uncertain.
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

**Task Worktree**:
A Git worktree and `task/<slug>` branch created by the user inside one Agent Launch to isolate one write-mode dispatch stream.
_Avoid_: temporary checkout, model-created worktree, automatic cleanup

**Write-Lease Conflict**:
A proposed write dispatch targeting a worktree with an existing Worktree Write Lease.
_Avoid_: automatic preemption, automatic downgrade

**Advisory Safety**:
The explicit disclosure that target constraints depend on Agent compliance and observable audits rather than enforced removal of target tools.
_Avoid_: guarded target, sandbox guarantee

**Dispatch Bypass**:
Any path that tasks or waits on another Agent outside a typed Registry-backed dispatch, leaving the Dispatch Registry unaware. This includes skill-guided raw Herdr commands from the Origin Pi as well as external shells and uncovered tools.
_Avoid_: manual shell only, harmless command

**Herdr Command Gate**:
The best-effort Origin-side rule that allows scoped metadata inspection and reads of the current Pi pane while denying foreign output reads, cross-workspace snapshots, raw tasking, raw Agent creation, foreign-pane control, and blocking waits that would bypass typed policies. It does not block the typed, user-initiated Agent Launch path.
_Avoid_: shell sandbox, target-side enforcement

## Results and resolution

**Final Outcome**:
The result status that settles a dispatch: done, blocked, failed, or cancelled. Continuing after blocked requires a new automatic dispatch.
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

**Dispatch Manager**:
The single current-workspace TUI surface opened by `/hd-manager` (long form `/herdr-dispatches`) or `alt+h`. It groups unsettled dispatches by attention and lifecycle, exposes explicit one-shot bounded output reads, and routes selected follow-ups through the existing confirmation gates. It may display foreign-Origin records for emergency discovery but never grants reply, cancellation, monitoring takeover, or automatic retargeting.
_Avoid_: ID table, second dispatch panel, autonomous coordinator, global workspace browser

**Dispatch Settlement**:
The indivisible recording of a Final Outcome, release of Target Occupancy and any Worktree Write Lease, and queuing of the Sanitized Dispatch Result for the Origin Session's next user-initiated turn without starting a model turn.
_Avoid_: autonomous continuation, partial release

**Follow-up Dispatch**:
A fresh Automatic Dispatch to the same Dispatch Target, seeded from a settled record's detail. It relies on the target pane's own surviving conversation context; the settled dispatch itself is never reopened, and the new dispatch passes every eligibility, occupancy, lease, and delivery check as usual.
_Avoid_: reopened dispatch, settlement rollback, implicit target trust

**Unseen Settlement**:
A settled dispatch whose result has not been marked seen in the Dispatch Manager. It stays ambiently visible (widget count, above-the-fold Manager group) until its detail is opened or the user explicitly clears all unread completions with `c`; either path records seen presentation metadata without deleting retained history or changing lifecycle and safety state ([ADR 0012](./adr/0012-unseen-settlement.md)).
_Avoid_: lifecycle state, reservation holder, automatic expiry

**Auto Run**:
The session-scoped, user-armed, depth-bounded mechanism by which a Dispatch Settlement triggers one Origin Session model turn ([ADR 0014](./adr/0014-auto-run-settlement-continuation.md)). The user arms it with `/hd-auto`; the model may only downgrade a single proposal, never arm. Every non-wake edge degrades to the quiet queued delivery.
_Avoid_: autonomous coordinator, model wait tool, unattended mode

**Auto Run Depth**:
The per-dispatch relay counter that guarantees every Auto Run chain terminates: 0 for user-turn proposals, parent depth + 1 inside an Auto Run turn. At the configured limit a settlement queues quietly and asks for human review instead of waking the model.
_Avoid_: retry count, turn budget

**Dispatch Reply**:
A separately confirmed follow-up sent to an unsettled dispatch with attention, retaining the same correlation ID and reservations.
_Avoid_: new dispatch, autonomous reply

**Cancellation Request**:
A confirmed request asking the Dispatch Target to stop and issue a cancelled Result Envelope. It does not itself settle or release reservations.
_Avoid_: forced interrupt, immediate release

**Manual Resolution**:
A double-confirmed `blocked`, `failed`, or `cancelled` Final Outcome recorded when automatic settlement is unsafe or impossible, after presenting current target and worktree evidence. It never claims `done` and is the only manual way to release reservations.
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

## Chinese product-copy terminology

Product copy (UI strings, notifications) is Simplified Chinese ([ADR 0011](./adr/0011-chinese-product-copy.md)). This table is the single authority for translating the terms above; every human-facing string in `src/pi/ui-copy.ts` must use exactly these renderings. English remains authoritative for code identifiers, docs, commit messages, and all model-facing strings.

| English term | Product copy (zh-CN) |
|---|---|
| Dispatch | 派发 |
| Dispatch Proposal | 派发提议 |
| Origin Session | 源会话 |
| Agent | Agent(不译) |
| Agent Launch | Agent 创建 |
| Eligible Agent | 可用 Agent |
| Dispatch Target | 目标 Agent |
| Target Occupancy | 目标占用 |
| Worktree Write Lease | worktree 写租约 |
| Task Worktree | 任务 worktree |
| Reservation | 预留 |
| Dispatch Manager | 派发管理器 |
| lifecycle `delivering` | 投递中 |
| lifecycle `active` | 运行中 |
| lifecycle `settled` / Settlement | 已结算 / 结算 |
| Attention Condition | 待处理状况 |
| `delivery-unverified` | 投递未验证 |
| `unacknowledged` | 未应答 |
| `blocked-runtime` | 运行时受阻 |
| `overdue` | 已超期 |
| `malformed-result` | 结果格式错误 |
| `result-missing` | 结果缺失 |
| `target-lost` | 目标丢失 |
| `monitoring-paused` | 监控已暂停 |
| Final Outcome | 最终结果 |
| outcome `done` | 完成 |
| outcome `blocked` | 受阻 |
| outcome `failed` | 失败 |
| outcome `cancelled` | 已取消 |
| agent status `idle` | 空闲 |
| agent status `working` | 工作中 |
| agent status `unknown` | 未知 |
| mode `write` | 写入 |
| mode `non-mutating` | 非变更 |
| provenance reported / screen-detected | 已上报 / ~屏测 |
| Result Envelope | 结果信封 |
| Dispatch Reply | 派发回复 |
| Cancellation Request | 取消请求 |
| Manual Resolution | 手动处理 |
| Emergency Resolution | 应急处理 |
| deadline | 截止 |
| Unseen Settlement | 已完成 · 未读 |
| Follow-up Dispatch | 追加派发 |
| Auto Run | 自动运行 |
| Auto Run Depth | 自动运行深度 |
