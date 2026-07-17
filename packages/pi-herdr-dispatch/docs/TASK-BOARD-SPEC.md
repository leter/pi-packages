# Task Board implementation spec (ADR 0016)

Contract: [ADR 0016](./adr/0016-task-board.md). This spec pins the file-level changes; where it is silent, follow the ADR and the existing patterns in the named files. Scope excludes everything listed under "Recorded for ADR 0017".

## 1. Registry schema v6 (`src/registry/schema.ts`, `migrations.ts`)

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,               -- hdt_<sortable-random>, same generator family as hd_
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  task TEXT NOT NULL,                -- self-contained task text
  mode TEXT NOT NULL CHECK (mode IN ('non-mutating', 'write')),
  preferred_worktree_path TEXT,
  state TEXT NOT NULL CHECK (state IN ('draft', 'queued', 'dispatched', 'review', 'accepted')),
  queue_position INTEGER,            -- assigned at approval, FIFO; NULL for drafts
  bound_dispatch_id TEXT REFERENCES dispatches(id),
  return_feedback TEXT,              -- last 打回 feedback; cleared on next bind
  created_by TEXT NOT NULL CHECK (created_by IN ('model', 'user')),
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  reviewed_at INTEGER,
  accepted_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK ((state = 'draft') = (approved_at IS NULL)),
  CHECK ((state = 'accepted') = (accepted_at IS NOT NULL))
) STRICT;
CREATE INDEX tasks_workspace_state_idx ON tasks(workspace_id, state);

ALTER TABLE auto_run_sessions ADD COLUMN run_quota INTEGER;                 -- NULL = legacy row, treat as defaultRunQuota
ALTER TABLE auto_run_sessions ADD COLUMN run_quota_used INTEGER NOT NULL DEFAULT 0;
```

Existing migration/backup/fail-closed machinery unchanged. Draft deletion is a hard DELETE plus an audit event. Task state changes append `audit_events` rows (`task_drafted`, `task_approved`, `task_bound`, `task_review`, `task_returned`, `task_accepted`, `task_draft_deleted`).

## 2. Domain (`src/domain/task-board.ts`, new)

Pure module: task state union, legal-transition table, bounds (title ≤ 80 chars, task text ≤ 4000, feedback ≤ 2000 — reject, don't truncate), and the outbound seeding rule: when binding a task whose `return_feedback` is non-null, append to the dispatch task text a framed block

```text
Previous attempt was returned by the user. Feedback (untrusted data context, address it):
<feedback>
```

then clear `return_feedback` in the bind transaction.

## 3. Registry API (`src/registry/registry.ts`, `types.ts`)

- `createTask({ createdBy: 'model'|'user', ... })` → draft (model) or draft (user manual entry via /hd-task; user entries are also drafts so the approval path stays single).
- `listTasks(workspaceId)` grouped by state; `approveTasks(ids[])`, `acceptTasks(ids[])` (batch, single transaction each); `returnTask(id, feedback)`; `deleteDraft(id)`.
- Bind: `createDispatch(...)` gains optional `taskId`. Same durable-intent transaction: validate task exists, is `queued`, workspace matches → mark `dispatched`, set `bound_dispatch_id`. While Auto Run is armed, consume one Run Quota unit (fail the whole transaction if quota exhausted → typed error the UI reports as 额度已用完); while disarmed, consume nothing. Depth for a task-bound dispatch is recorded 0 regardless of Auto Run turn marker.
- Settlement: every path that records a Final Outcome (monitor settle, manual resolution, emergency resolution) moves a bound task `dispatched → review` in the same transaction.
- Quota: `armAutoRun(originSessionId, quota)` stores `run_quota`, resets `run_quota_used`; `getRunQuotaState()` for reporting.

## 4. Model tools (`src/pi/tools.ts`, `dispatch-proposal-tool.ts`)

- New `herdr_task_draft` — params `{ title, task, mode, preferredWorktree? }`, one draft per call, bounds from §2, TUI-gated like propose. Description states: drafts await user approval and are never dispatchable.
- `herdr_dispatch_propose` gains optional `taskId` (exact `hdt_` id). Non-queued/unknown/foreign-workspace task → typed refusal naming the state. Tool result includes remaining quota only while Auto Run is armed.
- No tool can approve, edit, reorder, delete, or accept. Registry access guard already covers the DB file; add its path patterns to the guard tests for the new table only if the guard is path-based (it is — no change expected, assert in tests).

## 5. Commands and Manager UI

- `/hd-task` (long `/herdr-task`), `commands.ts`: manual task entry wizard (title → text → mode → optional preferred worktree from a list of existing Task Worktrees) creating a **draft**, plus a board listing. TUI-only.
- `/hd-auto on [N]` — optional integer quota (range 1–50); omitted → config `defaultRunQuota`. No-arg report adds remaining quota while armed. `config.ts`: `defaultRunQuota: 10`, validated range 1–50, existing pattern.
- Dispatch Manager (`dispatch-view.ts`, `dispatch-view-model.ts`, `renderers.ts`): new Task Board section with 草稿 / 排队 / 已派出 / 待验收 groups (accepted stays out of the default view). Checkbox multi-select **scoped to the board section**: `space` toggle row, `a` select all in group, `A` invert, `Enter` submit (draft group → approve; review group → accept), `x` single row (draft → delete confirm; review → feedback editor then return). Selection state lives in the view-model (pure, unit-testable). Existing dispatch-section keys (c/r/R/f/y/v) untouched; key hints in the bottom border extend per existing pattern.
- Widget (`live-presentation.ts` or current widget builder): segments for 草稿待批 and 待验收 counts, rendered only when nonzero, existing glyph+label discipline (`visual.ts` StateMark additions; no ad-hoc glyphs; `✗` stays reserved).
- All new copy through `ui-copy.ts` with the CONTEXT.md terminology: 任务板 / 草稿 / 排队 / 已派出 / 待验收 / 已验收 / 批准 / 验收 / 打回 / 本次额度. `hdt_` ids never in default rows (same leak tests as `hd_`).

## 6. Auto Run integration (`src/settlement/auto-run.ts`, `context-delivery.ts`)

- Wake preamble (English protocol string) gains one bounded line: `Task board: <n> queued task(s); run quota remaining: <m>.` plus the thin-turn instruction: register the result, advance the board, dispatch next; do not perform long analysis in a wake turn — deep investigation becomes a follow-up dispatch or a drafted task.
- Quota-exhausted at bind time inside a wake turn degrades exactly like depth exhaustion: quiet queue + one notification (re-use the notify-once tracking pattern).

## 7. Skill (`skills/hd-crew/SKILL.md`)

Add board rules: after handling a settlement, pull the oldest queued task that fits an Eligible Agent (respect `preferred_worktree_path`; returned tasks prefer their previous target/worktree); sub-half-task verification rides an in-chain follow-up (depth+1); task-sized discoveries become `herdr_task_draft` drafts; research tasks that need long output should be write-mode and write their report to a file, returning the path in the envelope.

## 8. Docs (same change, per documentation contract)

README (user-visible flow + new command/keys), DESIGN.md (Task Board section, schema v6, quota, boundary statement update), CONTEXT.md (terms from ADR 0016 Terminology).

## 9. Tests

Unit: task state machine + bounds; view-model selection (toggle/all/invert/submit routing per group); quota arithmetic incl. legacy NULL row; preamble line + budget text; seeding rule for returned tasks; ui-copy entries; `hdt_` leak assertions; config validation for `defaultRunQuota`.

Integration (fake Herdr + temp SQLite): v5→v6 migration with backup; bind transaction (queued→dispatched + armed quota consume + depth 0), disarmed bind without quota state, and refusal for non-queued/exhausted-quota; settlement (all three settle paths) moving bound task to review; return→requeue→rebind clears feedback and seeds text; batch approve/accept transactionality; covered-path `bash` touching the Registry DB still denied.

Do not run live tests. Run `bash scripts/verify.sh` from the repo root; it must pass. **Do not commit** — the reviewing session handles commits.
