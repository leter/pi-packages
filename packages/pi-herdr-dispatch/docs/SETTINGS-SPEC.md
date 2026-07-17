# Settings panel implementation spec (ADR 0021)

Contract: [ADR 0021](./adr/0021-settings-panel.md). File-level plan; where silent, follow the ADR and the Dispatch Manager patterns (`dispatch-view.ts` / `dispatch-view-model.ts` are the closest precedent — mirror their pure-view-model + themed-component split and zh-CN copy discipline).

## 1. Config writer (`src/domain/config.ts`)

- `writeDispatchConfig(patch: Partial<DispatchConfig>, path = defaultConfigPath()): Promise<DispatchConfig>`:
  1. Read the existing file if present and `JSON.parse` it into a plain object (missing file = `{}`); keep unknown keys.
  2. Merge `patch` over the parsed object (only the managed keys the panel edits appear in `patch`).
  3. Run the merged object through `parseDispatchConfig` — if it throws, reject without writing (the caller surfaces one notification).
  4. Write atomically: `writeFile(path + ".tmp", JSON.stringify(merged, null, 2))` then `rename`; create the parent dir first (`mkdir recursive`). Return the parsed `DispatchConfig`.
- Preserve every field already in the file; the panel only ever patches `defaultRunQuota`, `defaultLaunchBudget`, `maxAutoRunDepth`, `defaultDeadlineMinutes`.

## 2. Team writer (`src/domain/team.ts`)

- `writeRoleAgent(roleKey: string, agent: SupportedAgentType, path = defaultTeamConfigPath()): Promise<TeamCatalog>`:
  1. Parse the existing file (missing = `{}`), keep `workflows` and any unknown keys untouched.
  2. Resolve the role's **current effective object** from the loaded catalog (built-in default merged with any existing override) and write the complete role — `{ label, mode, brief, agent }` — under `roles.<roleKey>` (wholesale, per ADR 0017). Only the `agent` field changes; the other three are the current effective values so nothing is lost.
  3. Validate the whole merged object through `parseTeamConfig`; reject on failure without writing.
  4. Atomic write as in §1. Return the parsed `TeamCatalog`.
- Add `effectiveRole(catalog, roleKey)` if helpful; the built-in defaults already carry `label`/`mode`/`brief`/`agent`.

## 3. Settings view-model (`src/pi/settings-view-model.ts`, new, pure)

- A flat ordered row list built from the current `DispatchConfig` + `TeamCatalog`:
  - group 运行设置: four numeric rows with `{ key, label, value, min, max, step }` — quota (1–50, step 1), launch budget (0–10, step 1), auto-run depth (1–20, step 1), default deadline (min=`minDeadlineMinutes`, max=`maxDeadlineMinutes`, step 5).
  - group 角色模型: seven role rows with `{ roleKey, roleLabel, agent, agentIndex }` over the fixed `SUPPORTED_AGENT_TYPES` order.
- Pure transitions (unit-tested): `moveCursor(state, delta)`, `stepNumeric(row, dir)` clamping to `[min, max]`, `cycleAgent(row, dir)` wrapping through the catalog. Each adjustment produces a typed `SettingChange` — `{ kind: "config", key, value }` or `{ kind: "role-agent", roleKey, agent }` — for the component to persist. No I/O here.
- Row rendering helpers return `ViewLine[]` in the Manager style (group headings a stronger level than row metadata, display-width aware for CJK, no `hd_`/`hdt_` leakage — no IDs appear here anyway).

## 4. Settings component (`src/pi/settings-view.ts`, new, themed)

- `SettingsViewComponent` like `DispatchViewComponent`: rounded framed panel capped at 96 columns, title `设置` in the top border, key hints in the bottom border (`↑↓ 选择 · ←→ 调整 · esc 关闭`).
- Ports: `getConfig(): DispatchConfig`, `getTeam(): TeamCatalog`, `applyChange(change: SettingChange): Promise<{ ok: true } | { ok: false; reason: string }>`, `onStateChanged`.
- `←`/`→` on a numeric row steps and calls `applyChange`; on a role row cycles the agent and calls `applyChange`. On `applyChange` failure, roll the row back to the port's current value and show the failure copy (one line). Re-read ports after every successful change so the panel reflects the persisted truth. `esc` closes. No editor output, no command prefill — this panel only persists settings.

## 5. Runtime wiring (`src/pi/dispatch-runtime.ts`)

- Hold the active `DispatchConfig` (already does via `#config`) and expose `applySettingChange(change): Promise<...>`:
  - config change → `writeDispatchConfig(patch)`; on success set `this.#config` to the returned config so quota/budget/depth/deadline take effect live.
  - role-agent change → `writeRoleAgent(...)`; on success `registry.setTeamConfigState({ status: "ready", team })`.
  - any writer rejection → return `{ ok: false, reason }` (do not mutate in-memory state); the component notifies.
- Provide `settingsPorts()` returning the current config/team and `applySettingChange`.

## 6. Command + shortcut (`src/pi/commands.ts`)

- `registerCommandWithAlias(pi, "herdr-settings", "hd-settings", { … })` opening the Settings component, and `pi.registerShortcut("alt+s", …)` doing the same — mirror the `alt+h` / `hd-manager` registration exactly. TUI-only.

## 7. Blemish fixes

- `src/pi/visual.ts`: `taskStateMark("review")` returns a **distinct** mark (own glyph + non-warning color; keep `✓` reserved for `accepted`/success and `✗` for `failed`) — pick a glyph not already used for another task state and not `▲`. Add `parkedTaskMark()` (or route in the view-model) so a task with a `parkedReason` renders with `ATTENTION_GLYPH`/`warning` — parked review genuinely needs attention, plain review does not. Keep "one state = one glyph + one color" discipline; add the new mapping to `visual-presentation.test.ts`.
- `src/pi/dispatch-view-model.ts`: where a task row's mark is chosen, use the parked mark when `task.parkedReason` is set, else `taskStateMark(task.state)`.
- Manager keybar (`dispatch-view.ts` / its chrome builder): stop showing `enter 详情` and `enter 提交` simultaneously. Show `enter 提交` only when the focused row is a Task Board selection row that submits; otherwise `enter 详情`. Assert the deduped hint in the view test.

## 8. Docs (same change)

README (new `/hd-settings` + `alt+s`, what V1 edits, that changes persist and apply without `/reload`), DESIGN.md (Settings panel section: V1 scope, the validate-before-write / preserve-unmanaged / atomic / roll-back-on-failure rules, the write authority as a user-only TUI surface, the review-mark change), CONTEXT.md (term 设置 / Settings if a new term is warranted; otherwise none). ui-copy: panel title, group headings 运行设置 / 角色模型, row labels (本次额度 / 创建额度 / 自动接力深度 / 默认截止分钟 + the seven role labels reuse `UI_COPY.state.role`), key hints, save-failure copy.

## 9. Tests

Unit: config writer round-trip preserving an unmanaged advanced field + an unknown key; config writer rejecting an out-of-range patch without writing; team writer materializing the full role object, preserving other roles/workflows/unknown keys, and changing only `agent`; settings view-model cursor/step/cycle/clamp + emitted `SettingChange`; visual review-mark distinct from warning and parked→warning; keybar dedupe; ui-copy entries.

Integration: runtime `applySettingChange` writing config.json and updating live `#config`; writing team.json and updating `registry.setTeamConfigState`; a writer failure leaving files and in-memory state unchanged and returning `{ ok:false }`.

Red lines unchanged: zh-CN product copy via `ui-copy.ts` with CONTEXT.md terms; English contractual strings byte-for-byte; pure layers (`settings-view-model.ts`, `visual.ts`, `ui-copy.ts`) stay pure; `hd_`/`hdt_` never in default rows. Do not run live tests. Run `bash scripts/verify.sh` from the repo root; it must pass. **Do not commit** — the reviewing session handles commits.
