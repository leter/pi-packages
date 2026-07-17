# pi-herdr-dispatch

A Pi extension under staged development for automatically dispatching work through a typed, Registry-backed path to coding Agents in one local Herdr workspace, including an explicit TUI path that can create one new Agent before dispatch.

> **Status:** Experimental, with Phase 6 acceptance restored. The delivery, result, and widget fixes passed a fresh real Pi/Claude Code/Codex/OpenCode/Droid/Amp/Grok matrix, and automatic-default dispatch passed a post-schema-v3 no-prompt live probe. Auto Run (Phase 8, [ADR 0014](./docs/adr/0014-auto-run-settlement-continuation.md)) is implemented; its wake decision, coordinator orchestration (strict one-at-a-time waking, one-wake-in-flight, depth attribution, settle-before-arm gating), Registry access guard, and schema-v5 persistence are unit/integration tested, while the end-to-end DispatchRuntime wiring is left to its live acceptance item (L14), not yet run. The package remains `private` at `0.0.0-development`; no package has been published.

## Requirements

- Node.js 24 or newer (`node:sqlite` is required)
- Pi `0.80.6` or newer (post-repair matrix validated on `0.80.7`)
- Herdr `0.7.3`, socket protocol `16`
- Pi running inside Herdr with `HERDR_SOCKET_PATH`, `HERDR_WORKSPACE_ID`, and `HERDR_PANE_ID`

The extension normally dispatches to Existing Agents in the captured current workspace. `/hd-create` is the sole exception: a user may explicitly create one Agent pane or tab in the current workspace and cwd before dispatch. The extension never creates workspaces, worktrees, or coordinators, and models cannot invoke Agent creation.

## Language

Product copy (UI strings and notifications) is Simplified Chinese, rendered from the typed catalog in `src/pi/ui-copy.ts` using the terminology table in `docs/CONTEXT.md` ([ADR 0011](./docs/adr/0011-chinese-product-copy.md)). Model-facing safety and framing strings intentionally remain English, so bounded-output headers mix Chinese chrome with English trust markers. Documentation and code remain English.

## Development installation

```bash
git clone https://github.com/leter/pi-packages.git
cd pi-packages
npm ci
npm run check
npm test
pi install "$PWD/packages/pi-herdr-dispatch"
```

Restart Pi or run `/reload`, then verify `/hd-agents` and `/hd-manager`. The same package also loads the version-controlled `hd-crew` Skill from `skills/hd-crew/SKILL.md`; ask naturally to delegate work, check progress, or summarize delivered results, or invoke `/skill:hd-crew` explicitly. Remove the development installation with:

```bash
pi remove /absolute/path/to/pi-packages/packages/pi-herdr-dispatch
```

The package intentionally remains private/development through acceptance. These instructions install a local checkout; they do not publish anything.

### Development loop

`pi install ./local/path` records a path reference in `~/.pi/agent/settings.json`; nothing is copied, and Pi loads `src/index.ts` directly with no build step. Install once, then iterate with:

1. Edit source.
2. Run `/reload` in the Pi session (inside its Herdr pane). Reload is safe here: the extension reopens the Registry, restarts monitoring with a bounded catch-up read, and re-attaches the widget, so dispatch state survives.
3. For pure rendering or model logic, `npx vitest run test/unit/dispatch-view.test.ts` is a faster inner loop than a live reload; keep `/reload` for interaction feel and keybindings.

Reinstalling is only needed when the checkout moves, on another machine, or to remove the package.

## Dispatch workflow

The readable `hd-*` aliases are the recommended interactive commands; the original names remain available for compatibility. They are registered in workflow-priority order, with the most frequently used `/hd-new` first in slash-command completion.

- `/hd-new` (`/herdr-dispatch`) — select an Existing Agent, complete the dispatch wizard, and send immediately without a final confirmation prompt.
- `/hd-create` (`/herdr-dispatch-create`) — complete the wizard, create a supported integrated Agent in the current cwd, wait until it is eligible, then send through the same automatic dispatch path.
- `/hd-agents` (`/herdr-agents`) — list current-workspace Eligible Agents.
- `/hd-manager` (`/herdr-dispatches`, or `alt+h`) — open the current-workspace Dispatch Manager, browse human-readable tasks, and perform explicit bounded output reads (`r` for 50 lines, `R` for 200).
- `/hd-auto [on|off]` (`/herdr-dispatch-auto`) — report or toggle Auto Run (自动运行): when armed, settled results wake the model automatically instead of waiting for your next message. TUI-only for `on`/`off`.
- `/hd-reply [id-or-prefix]` (`/herdr-dispatch-reply`) — choose, preview, and confirm a reply when an Active Dispatch has attention.
- `/hd-cancel [id-or-prefix]` (`/herdr-dispatch-cancel`) — choose and confirm a normal cancellation request; this never sends `Ctrl+C`.
- `/hd-resolve [id-or-prefix]` (`/herdr-dispatch-resolve`) — choose and manually or emergently settle as `blocked`, `failed`, or `cancelled` after evidence and confirmation; manual resolution never claims `done`.
- `/hd-output <target> [lines]` (`/herdr-agent-output`) — perform one explicitly requested bounded output read.
- `/hd-setup` (`/herdr-dispatch-setup`) — explicitly install one selected Herdr status integration.

`/hd-create` supports `pi`, `claude`, `codex`, `opencode`, `amp`, `droid`, and `grok`. Every type requires its standard executable; `pi`/`claude`/`codex`/`opencode` also require a current Herdr integration, while `amp`/`droid`/`grok` may use Herdr screen detection. Its layout menu is ordered as current-tab adaptive, current-tab left/right, current-tab top/bottom, then a separate tab. Splits are 50/50; adaptive chooses left/right when the Origin pane width/height ratio is at least 2, otherwise top/bottom. The command inherits the current cwd, never steals focus, waits up to `agentStartupTimeoutMs` for the permitted reported or screen-detected provenance, and allows Esc to stop waiting. Created windows are deliberately retained after cancellation, failure, dispatch races, and settlement; cancellation/failure notifications disclose the retained pane and tab when creation was confirmed. The fixed one-word Agent executable and Enter are submitted in one typed Herdr request, avoiding a half-staged launch command.

Model tools expose scoped listing, proposal, status, and one-shot inspection. Reply, cancellation, resolution, Agent Launch, waits, and force interruption are never model tools.

## Using the Dispatch Manager

`/hd-manager` (or `alt+h`; long form `/herdr-dispatches`) opens the Dispatch Manager as a rounded framed panel: `任务派发` and live counts sit in the top border, the key hints in the bottom border, and `→` marks the selection. Rows are grouped in action order — `待处理` (needs attention), then `运行中` (running), then `投递中` (delivering) — and show the target Agent, task summary, principal attention reason, and relative deadline. The panel is capped at 96 terminal columns, uses one blank row between sections and before the bottom keybar, promotes section headings above dim metadata, and keeps the `S` teaching only in the keybar. The empty body stays compact and carries no instructional placeholder. Dispatch IDs never appear in default rows; press `D` on a detail screen when you need the full identifiers.

State glyphs pair a symbol, a theme color, and a label, so no state relies on color alone: `●` active, `◌` delivering, `▲` needs attention, `✓` done, `◼` blocked, `✗` failed, `○` cancelled.

### List screen

| Key | Action |
|---|---|
| `↑`/`↓` (or `ctrl+p`/`ctrl+n`) | Move selection |
| `PageUp`/`PageDown` | Move by page (10-row window) |
| `Home`/`End` | Jump to first/last record |
| `Enter` or `→` | Open the selected dispatch |
| `c` | Clear all unread completions from the workspace view by marking them seen; retained history is not deleted |
| `s` | Show or hide recently settled workspace records |
| `Esc`, `←`, or `Ctrl+C` | Close without changing anything |

### Detail screen

| Key | Action |
|---|---|
| `r` / `R` | One bounded output read (50 / 200 lines) — timestamped, framed as untrusted, never streamed |
| `y` | Reply (shown only for an Active Dispatch with attention from this Origin Session) |
| `c` | Request cancellation (never sends `Ctrl+C` to the target) |
| `v` | Resolve manually; foreign-Origin records show the emergency-resolution label |
| `f` | Follow-up dispatch (settled records only): start a fresh automatic dispatch to the same target through the full typed path |
| `D` | Toggle technical details (full dispatch ID, terminal, origin, workspace) |
| `Esc` or `←` | Back to the list |

Action keys only appear when the record's lifecycle, attention state, and Origin relationship allow them, and every action re-validates the record and passes through the existing preview and confirmation gates before anything is sent. Closing the manager with `Esc` or `Ctrl+C` can never mutate dispatch state.

Typical flow: dispatch work to an Existing Agent with `/hd-new`, or use `/hd-create` when a new Agent window is needed. Watch the widget counts below the editor, press `alt+h` when something needs attention, open the record, read its recent output with `r`, then choose reply, cancel, or resolve from the detail screen.

A settled result is not silently done: besides the one-shot notification, it counts as `✓ N 已完成` in the widget and sits in the `已完成 · 未读` Manager group until you open its detail, which marks it seen and folds it into the workspace settled history. When unread completions accumulate, press `c` on the list screen to atomically mark all of them seen; this only clears the unread presentation state, never deletes Registry history, and `s` can still reveal the retained records. The detail formats the sanitized result as a card — summary, blocker, and file/test counts, always labelled untrusted — instead of raw envelope JSON, and every outbound dispatch instructs the target to write its summary and blocker text in Simplified Chinese. From that detail, `f` seeds a follow-up dispatch to the same Agent — a brand-new dispatch (settlement is never reopened) that rides on the target pane's surviving conversation context, re-validated for eligibility, occupancy, and leases like any other.

The shared `/hd-new` and `/hd-create` deadline prompt shows the configured default (30 minutes by default); submitting an empty value uses that default.

Dispatch is automatic by default in TUI mode. `herdr_dispatch_propose` and a completed `/hd-new` wizard build one immutable outbound message and send it without a proposal confirmation, grant setup, count limit, expiry, or renewal. The typed path still revalidates current-workspace target identity, status provenance, cwd/canonical worktree, occupancy, leases, and concurrency before durable intent and delivery. Non-TUI modes cannot reserve, send, reply, cancel, resolve, or monitor.

## Auto Run (自动运行)

> **Verified live (2026-07-17): single-settlement L14 cases pass; a burst gap remains.** Against a real Pi + codex: an armed settlement fires exactly one wake turn, the exactly-once delivery claim completes and never re-fires (no ghost-wake loop), a two-hop chain provably terminates at the depth limit, and settle-then-arm, `/hd-auto off`, and resume all behave correctly. **Known bug:** when two or more dispatches settle near-simultaneously, only the first gets an auto-wake turn — the rest strand (not lost, delivered on the next user turn) because concurrent delivery calls race the coordinator's single-in-flight state ([details](./docs/ACCEPTANCE-RESULTS.md)). Off by default; not fully accepted until the burst gap is fixed.

By default a settled result only queues quietly and enters the model's context on your next message. `/hd-auto on` arms **Auto Run** for the current session: every settlement (done, blocked, failed, or cancelled) that occurs after you arm it then wakes the model automatically. Only one Auto Run turn ever runs at a time — results that settle while a turn is in flight are held and woken one after another as each turn finishes, never piling up into concurrent turns. The woken model receives the sanitized result in its usual untrusted framing plus a fixed preamble stating the remaining chain budget and its job: aggregate, verify, and decide whether one follow-up dispatch is warranted.

The chain always terminates: dispatches created during an automatic turn carry an **Auto Run Depth** one deeper than the settlement that triggered the turn, and at `maxAutoRunDepth` (default 5) the settlement queues quietly with one review notification instead of waking the model. Speaking to Pi yourself resets the chain — your own proposals are always depth 0.

The switch is per-session, persisted, and restored on resume, so an armed session is kept loudly visible: a persistent `⚡自动` widget segment, the Dispatch Manager top border, a soundless notification on start/resume, and `/hd-auto` for the exact state. Automatic delivery never marks a result as read — the `已完成 · 未读` audit trail works exactly as before.

`/hd-auto off` guarantees no new ignition: an Auto Run turn already running continues (stop it with Esc), but nothing held pending will trigger another — those results fall back to the quiet queue. Disarming never touches Pi's message queue, so no result can be lost. The model cannot arm Auto Run through any tool, and covered `bash`/`edit`/`write` that touch the Registry database are blocked on a best-effort basis (a relative path or an alternate binary can still slip past, like any covered-path rule); the model may only downgrade a single dispatch with `wakeOnSettle: false` so a fire-and-forget task stays quiet.

## Configuration

Optional file: `~/.config/pi-herdr-dispatch/config.json`

```json
{
  "defaultDeadlineMinutes": 30,
  "minDeadlineMinutes": 1,
  "maxDeadlineMinutes": 1440,
  "startupWindowMs": 30000,
  "agentStartupTimeoutMs": 60000,
  "minStartupWindowMs": 5000,
  "maxStartupWindowMs": 300000,
  "maxActivePerTargetWorkspace": 4,
  "maxActiveGlobal": 8,
  "retentionDays": 30,
  "livenessPollMs": 5000,
  "maxAutoRunDepth": 5
}
```

Unknown fields, invalid types, unsafe bounds, or inconsistent minimum/default/maximum values disable state-changing behavior. Safe state reads remain available when their dependencies are healthy.

The Registry defaults to `~/.local/state/pi-herdr-dispatch/registry.sqlite` with directory mode `0700`, database mode `0600`, WAL, foreign keys, backups, transactional migrations, and integrity checks.

## Safety boundary

Safety is **best-effort and advisory**, not a shell sandbox or target-side security boundary.

The extension provides:

- globally unique Target Occupancy and Worktree Write Leases;
- a Pi-side guard for identifiable built-in `edit`, `write`, `bash`, `!`, and `!!` mutations;
- a raw Herdr CLI gate that blocks ordinary tasking, waits, creation, control, foreign reads, and cross-workspace snapshots;
- automatic typed dispatch with immutable payload hashes, current-workspace scope, terminal identity, close/move observation, and delivery-echo verification;
- bounded, explicitly untrusted framing for Agent metadata, output, and results;
- no automatic resend after ambiguous delivery.

It cannot reliably control:

- manual shells or processes outside Pi;
- a target Agent that ignores advisory constraints;
- unknown third-party mutating tools;
- generated scripts, aliases, alternate binaries, direct socket code, or sufficiently obfuscated shell commands;
- external processes that mutate a worktree without consulting the Registry.

The package does not authorize commits, pushes, deployment, publication, destructive cleanup, remote mutation, or global/system installs. Project dependency installation requires an explicitly confirmed write proposal.

## Recovery handbook

### `delivery-unverified`

Do **not** resend automatically. The target may have accepted input even when the response or bounded echo was lost. Inspect the target and use `/hd-resolve` only after deciding the final outcome.

### Origin Session closed or Pi reloaded

Reservations remain durable. Resume the exact Origin Session. It resolves stored target identity and performs a bounded catch-up read before installing target-specific subscriptions; missing targets become `target-lost` and remain available for manual resolution instead of disabling the Adapter. When a Target Agent's pane route changes while monitoring is live, the monitor performs the same catch-up before re-anchoring target-specific subscriptions. Monitoring never transfers to another session. A queued sanitized result uses `nextTurn` and does not start a model turn — unless the resumed session has Auto Run armed, which the resume notification and the `⚡自动` widget segment announce before any wake fires.

### Auto Run needs to stop now

`/hd-auto off` stops all future ignition; at most one already-enqueued wake can still fire. Esc interrupts the turn that is currently running. Neither loses a result: everything falls back to the quiet queue, readable on your next message and still counted as unread until you open it.

### Herdr restarted

Herdr 0.7.3 regenerates terminal IDs. A missing stored terminal becomes `target-lost` even if pane ID, cwd, Agent label, or retained history looks similar. V1 never retargets heuristically; inspect and manually resolve.

### `result-missing` or `target-lost`

Reservations remain held. Review the displayed bounded evidence, then use manual resolution. There is no standalone lease-release command.

### Origin Session unavailable

A different local TUI session may use emergency resolution only after personally attesting that the Origin is unavailable and confirming reservation release a second time. No process-liveness check is treated as proof. Emergency resolution does not transfer monitoring or inject context into the resolver.

### Registry unavailable or corrupt

State-changing behavior fails closed and never falls back to an empty or in-memory Registry. Preserve the database and its timestamped migration backups. Restore access or a reviewed backup before retrying. Exhausted transient SQLite busy/locked timeouts fail only the current operation; structural SQL errors disable later mutations in that process.

## UI and notifications

The extension adds one compact widget below the editor and never replaces Pi's footer. `/hd-manager` (long form `/herdr-dispatches`; shortcut `alt+h`, TUI only) opens the Dispatch Manager: a current-workspace, attention-first list with recently settled current-workspace records folded away. Dispatch IDs are internal correlation details and appear only in explicit technical details. Human-facing tables align and truncate by terminal display columns, including double-width CJK text. The widget and manager re-read current-workspace Registry state on every render instead of caching status. The widget requests a lightweight repaint once per second, so changes written by another Pi process appear without `/reload`. `running` excludes dispatches grouped under attention, and the attention count is the number of affected dispatches—not the number of concurrent conditions. Every foreign-Origin unsettled record counts as attention so reservations left by an earlier Origin Session remain visible in the ambient UI. An armed Auto Run adds a persistent `⚡自动` segment next to the widget label and to the Manager top border — it never disappears while armed, even when nothing is running. The manager also refreshes relative times, and performs output reads only as explicit one-shot bounded tails (`r` 50 lines, `R` 200 lines, timestamped and framed as untrusted). Reply, cancellation, and resolution selections still pass through their existing preview, eligibility revalidation, and confirmation gates.

The optional command selector supports exact IDs and unambiguous prefixes for advanced use, with full-ID argument completion. Ambiguous prefixes open a human-readable picker and are never guessed. A foreign-Origin record is discoverable only within the current Workspace Scope and exposes emergency resolution, not reply or cancellation. Herdr notification sounds are restricted to:

- `done` for a successful `done` outcome;
- `request` for attention, blocked, or failed outcomes;
- `none` for cancellation.

It never calls `pane.report_metadata`.

## Documents

- [Design](./docs/DESIGN.md)
- [Domain language](./docs/CONTEXT.md)
- [Implementation plan](./docs/IMPLEMENTATION-PLAN.md)
- [Dispatch interaction plan](./docs/DISPATCH-INTERACTION-PLAN.md)
- [Compatibility spikes](./docs/SPIKE-RESULTS.md)
- [Live acceptance results](./docs/ACCEPTANCE-RESULTS.md)
- [L14 Auto Run runbook](./docs/L14-auto-run-runbook.md) — manual acceptance procedure gating Auto Run
- [Review findings](./docs/REVIEW-FINDINGS.md)
- [Architecture decisions](./docs/adr)
