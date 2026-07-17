# Model-initiated read-only launch implementation spec (ADR 0018)

Contract: [ADR 0018](./adr/0018-model-initiated-readonly-launch.md). This spec pins the file-level changes; where it is silent, follow the ADR and the existing patterns (the `/hd-create` launch machinery of ADR 0013 and the Run Quota plumbing of ADR 0016 are the precedents to mirror).

## 1. Config (`src/domain/config.ts`)

`defaultLaunchBudget: 2`, validated range 0–10 (0 disables the capability entirely). Existing pattern; note this is the one config field whose minimum is 0.

## 2. Registry schema v8 (`schema.ts`, `migrations.ts`)

```sql
ALTER TABLE auto_run_sessions ADD COLUMN launch_budget INTEGER;
ALTER TABLE auto_run_sessions ADD COLUMN launch_budget_used INTEGER NOT NULL DEFAULT 0;
```

`armAutoRun` gains a `launchBudget` argument stored on arm (config default plumbed by the caller), resetting `launch_budget_used` — same reset-on-rearm rule as Run Quota. A NULL `launch_budget` (legacy armed row) is treated as the config default at consume time, mirroring the Run Quota NULL rule.

## 3. Registry API (`registry.ts`)

- `consumeLaunchBudget(originSessionId, consumedAt)`: requires an armed row (throw the same typed way quota does when disarmed — the tool surfaces it as a refusal, not an error card); throws a typed exhaustion error at `used >= budget` (budget 0 is therefore always exhausted); increments and returns remaining. Audit event `readonly_launch` (dispatch_id NULL) with role, agent type, pane/terminal IDs recorded by the caller after the launch succeeds.
- `getLaunchBudgetState(originSessionId)`: `{ armed, remaining? }` for status/preamble reporting.
- Budget consumption happens **after** the launch succeeds, in the same turn (a failed launch does not burn budget; the model may retry). Record the audit event with the consumption.

## 4. Launch path (`src/dispatch/application.ts` + `agent-launch.ts`)

New application method `launchReadonlyAgent({ role, agentType })`, reusing the existing `AgentLaunchService` unchanged:

- **Role gate:** the role must exist in the loaded team catalog and its `mode` must be `non-mutating`. Anything else — write role, unknown role, invalid team config — is a typed refusal naming the reason. The built-in read-only set is `reviewer`/`researcher`/`advisor`/`oracle`; the gate is by catalog mode so team.json overrides stay consistent.
- **Agent type** must be in the fixed `SUPPORTED_AGENT_TYPES` catalog (same launchable filtering `/hd-create` uses).
- **Reuse-first is enforced, not advisory:** if any current Eligible Agent's `displayName` contains the role key, refuse with a typed message naming that pane — the model must dispatch to it instead.
- **Fixed ground:** cwd is always the Origin cwd; layout `adaptive`; never a worktree, never a new workspace; pane label `<role>-auto-<n>` where `<n>` is 1 + the count of current-workspace panes whose label starts with `<role>-auto-`.
- Launch waits for readiness exactly like `/hd-create` (same provenance rules, incl. ADR 0019 agent-session evidence) and returns the launched pane's `terminalId`, `paneId`, `agentLabel`, `statusProvenance`. Created panes are retained on failure exactly like ADR 0013 (disclosed, never auto-closed).

## 5. Tool (`src/pi/tools.ts`)

One new tool `herdr_agent_launch_readonly` — params `{ role, agentType }`, TUI-gated like the other dispatch tools. Order of checks: TUI gate → armed (disarmed → refusal telling the model daytime capacity is the user's `/hd-create`) → role gate → reuse-first → budget precheck (exhausted → refusal + the one parked-capacity notification, notify-once per armed session like quota exhaustion) → launch → consume budget + audit → one notification (ui-copy, Simplified Chinese, role label + agent type + pane name) → result includes remaining budget. The tool description states: read-only roles only, reuse first, user-set budget, panes are retained for reuse.

## 6. Surfaces

- `/hd-auto on` report and the Auto Run wake preamble line gain launch budget remaining (extend the existing `Task board: … run quota remaining: …` line with `; launch budget remaining: <k>`; keep it absent while disarmed).
- `herdr_dispatch_status`: no change beyond the preamble/report above (eligible listing already shows the new pane after launch).
- ui-copy: notification copy 已创建只读角色窗格 with role label and pane name; budget-exhausted notification 创建额度已用完.

## 7. Skill (`skills/hd-crew/SKILL.md`)

In the "When a role has no Eligible Agent" section: while Auto Run is armed with launch budget remaining and the missing role is read-only, call `herdr_agent_launch_readonly` once and route the stage to the returned pane; write roles and worktrees remain `/hd-create` suggestions to the user. Never launch when an eligible role-named pane exists (the tool refuses anyway). Disclose every launch in the report line.

## 8. Docs (same change)

README (Launch Budget flow, tool, retention/reuse), DESIGN.md (amend the ADR 0013 boundary statement with this narrow exception; new Launch Budget section stating decisions 2–5; schema v8 note), CONTEXT.md (Launch Budget / 创建额度 term per ADR Terminology; amend the Agent Launch entry).

## 9. Tests

Unit: config validation incl. 0; pane-name generation (first, nth, collision with user panes named `reviewer-auto-1`); role gate matrix (read-only ok, write refused, unknown refused, invalid team config refused); ui-copy entries.

Integration: v7→v8 migration with backup; arm stores budget and rearm resets `used`; consume-after-launch ordering (failed launch burns nothing); exhaustion refusal + notify-once; disarmed refusal; reuse-first refusal when an eligible pane matches the role; launched-pane audit event fields; preamble line with both quota and budget; legacy NULL budget row uses the config default.

Do not run live tests. Run `bash scripts/verify.sh` from the repo root; it must pass. **Do not commit** — the reviewing session handles commits.
