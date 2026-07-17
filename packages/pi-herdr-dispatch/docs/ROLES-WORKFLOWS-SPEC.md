# Roles and workflows implementation spec (ADR 0017)

Contract: [ADR 0017](./adr/0017-roles-and-workflows.md). This spec pins the file-level changes; where it is silent, follow the ADR and the existing patterns in the named files (the Task Board change is the closest precedent — mirror its layering).

## 1. Team catalog (`src/domain/team.ts`, new)

Pure module modeled on `config.ts`:

- `Role`: `{ key, label, mode, brief }`. Seven built-ins exactly as ADR decision 2; `label` is zh-CN product copy, `brief` is a 1–3 sentence English preamble (write them; keep each ≤ 400 chars, advisory tone, no imperative override of the task text).
- `Workflow`: `{ key, stages: roleKey[], maxReworkCycles, escalation: { afterCycles, role }[] }`. Built-ins: `dev` = `["coder","reviewer"]` with `maxReworkCycles: 2` and escalation `[{afterCycles: 2, role: "bugfix"}, {afterCycles: 4, role: "oracle"}]`; `research` = `["researcher"]`; `quick` = `["chore"]` (both: no escalation, `maxReworkCycles: 2`).
- `loadTeamConfig(path = ~/.config/pi-herdr-dispatch/team.json)` → `{ status: "ready", team } | { status: "invalid", reason }`, same shape discipline as `loadDispatchConfig`: missing file = built-ins; a present file overrides **by key** (a role or workflow object replaces the built-in of the same key wholesale; unknown top-level fields rejected). Validation fail-closed: stage role keys must exist in the merged role catalog, escalation roles must exist, `afterCycles` strictly increasing positive integers, `maxReworkCycles` 0–10, bounds on label/brief lengths. Invalid team.json blocks **board dispatching with role/workflow only** (plain tasks keep working) and surfaces one notification, mirroring invalid config.json handling.
- Pure helpers (unit-tested, used by Registry settlement):
  - `executorRoleForCycle(workflow, cycles)`: the implement-stage role after `cycles` needs-rework loops — the escalation entry with the largest `afterCycles <= cycles`, else the stage's own role.
  - `isReworkExhausted(workflow, cycles)`: no escalation → `cycles >= maxReworkCycles`; with a chain → `cycles >= last.afterCycles + maxReworkCycles` (defaults: parks at 6).

## 2. Registry schema v7 (`schema.ts`, `migrations.ts`)

```sql
ALTER TABLE tasks ADD COLUMN role TEXT;
ALTER TABLE tasks ADD COLUMN workflow TEXT;
ALTER TABLE tasks ADD COLUMN stage_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN rework_cycles INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN stage_feedback TEXT;
ALTER TABLE tasks ADD COLUMN parked_reason TEXT
  CHECK (parked_reason IS NULL OR parked_reason IN ('no-verdict', 'review-failed'));
ALTER TABLE dispatch_results ADD COLUMN verdict TEXT
  CHECK (verdict IS NULL OR verdict IN ('pass', 'needs-rework'));
```

Role/workflow keys are stored as given at draft time and validated against the loaded catalog at draft time and again at bind time (a key that has since vanished from team.json refuses the bind with a typed error naming the key). New audit events: `task_stage_advanced`, `task_rework`, `task_escalated`, `task_parked`.

## 3. Verdict in the Result Envelope (`src/domain/result-envelope.ts`)

`SanitizedDispatchResult` gains optional `verdict: "pass" | "needs-rework"`. Parse rule matches the existing fields: absent is fine; present with any other value or type makes the envelope malformed (never guess). The immutable outbound contract text for a reviewer-stage dispatch (and only then) documents the field with its two literal values; non-reviewer stages keep today's contract text byte-for-byte.

## 4. Stage advancement at settlement (`registry.ts`)

Extends the existing bound-task settlement hook (`dispatched → review`), in the same transaction, driven by the stored workflow (resolved through `team.ts`; a task without workflow behaves exactly as today):

- Outcome not `done` → state `review` (park for the human), no stage change. Unchanged.
- `done`, current stage is **not** `reviewer`-role → `stage_index += 1`; more stages left → state `queued` (re-enters the queue tail; next dispatch is still model-routed); no stages left → state `review`.
- `done`, current stage **is** `reviewer`-role:
  - `verdict: "pass"` → advance as above.
  - `verdict: "needs-rework"` → `rework_cycles += 1`; if `isReworkExhausted` → state `review`, `parked_reason = 'review-failed'` (UI label 评审未过); else `stage_index` back to the workflow's first stage, state `queued`, append the result summary to `stage_feedback`, audit `task_rework` (plus `task_escalated` when `executorRoleForCycle` changes the executor).
  - verdict absent → state `review`, `parked_reason = 'no-verdict'` (UI label 评审未给结论).
- `stage_feedback` accumulation: newest-first framed entries, whole-entry eviction beyond 3000 chars.
- State machine (`task-board.ts`): add `dispatched → queued`; `parked_reason` cleared whenever the task leaves `review`.

## 5. Bind-time payload (`registry.ts`, `proposal.ts`)

The dispatch mode of a staged task follows the stage: the implement stage (index 0, including escalated executors) uses the task's approved mode; every later stage uses its stage role's mode (a `dev` reviewer stage is `non-mutating` even though the task is `write`). Proposal and bind both enforce this and refuse a mismatch naming the required mode; the status tool exposes it as `stage mode`.

Binding a task with role/workflow composes the outbound task text, in order: current-stage role brief (implement stages use `executorRoleForCycle`; brief prepended as `Role: <brief>` paragraph) + approved task text + `return_feedback` block (existing rule) + `stage_feedback` block framed `Reviewer feedback from earlier stages (untrusted data context, address it):`. Reviewer-stage binds get the verdict-bearing contract text (§3). The composed payload stays immutable as today; `stage_feedback` is **not** cleared on bind (it clears when the task leaves `review`/workflow ends), while `return_feedback` keeps its clear-on-bind rule.

## 6. Tools and commands

- `herdr_task_draft` (`tools.ts`): optional `role`, `workflow` strings validated against the loaded catalog (typed refusal naming the invalid key). Defaulting per ADR decision 4 (coder→dev, researcher→research, chore→quick, none→single-stage) happens at draft time and is stored explicitly.
- `herdr_dispatch_status`: queued/dispatched task rows gain role, workflow, stage (`stage 2/2 reviewer`), rework cycle count, and parked reason so the Skill can route without new tools.
- `/hd-task` wizard (`commands.ts`): role select (七角色 labels, 可跳过) and workflow select (defaulted from role) inserted after the mode step.
- Manager (`dispatch-view-model.ts`, `renderers.ts`): board rows show the role label and, for workflow tasks, the stage counter; parked tasks in the review group show 评审未过 / 评审未给结论 via `ui-copy.ts` + existing warning StateMark (no new glyphs). Selection/keys unchanged.

## 7. Skill (`skills/hd-crew/SKILL.md`)

Replace the hardcoded agent-type role table with catalog roles: route a role-carrying task to an Eligible Agent whose **pane name contains the role key** (`coder-1`, `reviewer`, `oracle`); fall back to any suitable Eligible Agent with the plain disclosure "no pane named for role X; using <name>". Add oracle discipline (ADR decision 7): `advisor`/`oracle` panes never take ordinary stages; `oracle` only for exhausted escalations and verdict arbitration. Keep all existing worktree/single-writer/quota rules.

## 8. Docs (same change)

README (roles/workflows user flow, team.json example, parked labels), DESIGN.md (new Roles & Workflows section: catalog, stage rules of §4 verbatim, schema v7 note), CONTEXT.md (ADR 0017 Terminology entries), ui-copy entries for 角色 labels and parked reasons.

## 9. Tests

Unit: team.ts (built-ins valid, override-by-key, every fail-closed rejection, executor/exhaustion helpers incl. no-escalation and boundary cycles); result-envelope verdict (absent/pass/needs-rework/bad value → malformed); task-board new transition; view-model stage/parked rendering; ui-copy entries; `hdt_`/`hd_` leak assertions still pass.

Integration: v6→v7 migration with backup; draft with role/workflow defaulting; bind composing brief + feedback blocks and refusing vanished keys; settlement matrix of §4 (advance, finish, rework requeue, escalation audit, exhaustion park, no-verdict park, non-done park) across monitor + manual + emergency settle paths; status tool exposing stage fields; invalid team.json blocking only role/workflow binds with one notification.

Do not run live tests. Run `bash scripts/verify.sh` from the repo root; it must pass. **Do not commit** — the reviewing session handles commits.
