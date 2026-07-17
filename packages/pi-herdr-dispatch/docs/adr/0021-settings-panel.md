# 0021 — Settings panel with persistent config and role-agent editing

## Status

Accepted (2026-07-18); requested by the user. Builds on the config loader (ADR-era `config.json`), the team catalog (ADR 0017), and role default agents (ADR 0020). Introduces the extension's first authority to **write** `config.json` and `team.json`.

## Context

Two operational settings — Run Quota and Launch Budget defaults — are only reachable by editing `config.json`, and the `/hd-auto on N` inline argument is swallowed by Pi's completion menu. Role default agents (ADR 0020) exist in the model but can only be changed by hand-editing `team.json` + `/reload`. The user wants a Settings tab: a visual home for these knobs now and a place to grow. Two Manager blemishes (review state reusing the warning glyph; a duplicated Enter key hint) are swept in the same change.

## Decision

1. **A new interactive Settings panel**, opened by `/hd-settings` (long `/herdr-settings`) and the `alt+s` shortcut, rendered like the Dispatch Manager (rounded framed panel, zh-CN copy through `ui-copy.ts`, pure view-model). Read-only surfaces stay read-only; this panel is the one place that mutates settings.
2. **V1 editable settings, two groups:**
   - **运行设置** (from `config.json`): `defaultRunQuota` (1–50), `defaultLaunchBudget` (0–10), `maxAutoRunDepth` (1–20), `defaultDeadlineMinutes` (clamped to `[minDeadlineMinutes, maxDeadlineMinutes]`).
   - **角色模型** (from `team.json`): each of the seven roles' default `agent`, cycled among the fixed launch catalog (`pi`/`claude`/`codex`/`opencode`/`amp`/`droid`/`grok`).
   Every other `config.json` field and every other role/workflow attribute stays file-only; the panel framework is built so more rows can be added later without a redesign.
3. **Adjustment is stepping, never free typing** — `←`/`→` decrement/increment a numeric setting within its clamped range and cycle a role's agent through the catalog. This sidesteps the completion-menu argument bug entirely; there is no text-entry field to swallow.
4. **Persistence is the new authority, exercised carefully.** A change updates the in-memory setting immediately (so it takes effect without `/reload`) and writes the backing file. Writes: validate the full object through the existing parser (`parseDispatchConfig` / `parseTeamConfig`) before writing and refuse to write anything that would not load; preserve every field the panel does not manage (advanced config params, role `label`/`mode`/`brief`, workflows, unknown keys); write atomically (temp file + rename); create the file and its directory if missing. A failed or invalid write surfaces one clear notification and leaves the file untouched, with the in-memory value rolled back.
5. **Role-agent writes materialize the full role.** Because a `team.json` role override replaces that role wholesale (ADR 0017), changing a built-in role's agent writes the complete effective role object (`label`, `mode`, `brief`, `agent`) under `roles.<key>`, so nothing else about the role is lost. Live application calls `registry.setTeamConfigState` with the reparsed catalog; config changes update the runtime's active `DispatchConfig`.
6. **Two blemish fixes bundled.** The `review` task state gets its own StateMark glyph distinct from the `▲`/warning mark (which stays reserved for genuine attention); parked review reasons (`评审未过`/`评审未给结论`) keep the warning mark because they do need attention. The Manager keybar no longer lists both `enter 详情` and `enter 提交` at once — it shows only the action valid for the focused row.

## Consequences

- The extension now writes two user files. The safety posture is fail-closed: validate-before-write, preserve-unmanaged, atomic, roll back in memory on failure. No new model tool touches settings — the panel is a user TUI surface only, like `/hd-create`.
- Registry schema and dispatch behavior are unchanged. The read-only launch catalog, role modes, and workflows are unchanged; only role default agents become UI-editable.
- Implementation touches `config.ts` (writer), `team.ts` (writer + full-role materialization), a new `settings-view-model.ts` + `settings-view.ts`, `commands.ts` (command + `alt+s`), `dispatch-runtime.ts` (apply live), `ui-copy.ts`, `visual.ts` (review mark), README/DESIGN/CONTEXT, and tests at each layer.
- L21 live check (bundled into the next overnight prep): change Run Quota and a role agent in the panel, confirm the files update and take effect without `/reload`, and confirm an advanced config field and a role brief survive the write.
