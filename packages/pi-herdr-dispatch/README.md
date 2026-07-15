# pi-herdr-dispatch

A Pi extension under staged development for safely dispatching explicitly confirmed work to coding Agents that already exist in one local Herdr workspace.

> **Status:** Phase 6 implementation and disposable-topology acceptance are complete. The package is ready for reviewed local development use, but remains `private` at version `0.0.0-development`; publishing requires a separate user decision.

## Requirements

- Node.js 24 or newer (`node:sqlite` is required)
- Pi `0.80.6`
- Herdr `0.7.3`, socket protocol `16`
- Pi running inside Herdr with `HERDR_SOCKET_PATH`, `HERDR_WORKSPACE_ID`, and `HERDR_PANE_ID`

The extension never creates Agents, panes, workspaces, worktrees, or coordinators during normal operation. It dispatches only to existing Agents in the captured current workspace.

## Development installation

```bash
git clone https://github.com/leter/pi-packages.git
cd pi-packages
npm ci
npm run check
npm test
pi install "$PWD/packages/pi-herdr-dispatch"
```

Restart Pi or run `/reload`, then verify `/herdr-agents` and `/herdr-dispatches`. Remove the development installation with:

```bash
pi remove /absolute/path/to/pi-packages/packages/pi-herdr-dispatch
```

The package intentionally remains private/development through acceptance. These instructions install a local checkout; they do not publish anything.

## Dispatch workflow

- `/herdr-agents` — list current-workspace Eligible Agents.
- `/herdr-dispatch` — create and confirm a manual proposal.
- `/herdr-dispatches` — list unsettled dispatches for this Origin Session.
- `/herdr-dispatch-reply <id>` — preview and confirm a reply when an Active Dispatch has attention.
- `/herdr-dispatch-cancel <id>` — request a normal cancellation; this never sends `Ctrl+C`.
- `/herdr-dispatch-resolve <id>` — manually or emergently settle after evidence and confirmation.
- `/herdr-agent-output <target> [lines]` — perform one explicitly requested bounded output read.
- `/herdr-dispatch-setup` — explicitly install one selected Herdr status integration.

Model tools expose scoped listing, proposal, status, and one-shot inspection. Reply, cancellation, resolution, Agent creation, waits, and force interruption are never model tools.

Every dispatch proposal previews the complete outbound bytes and requires TUI confirmation. Editing creates a new immutable proposal and requires another preview. Non-TUI modes may list and inspect but cannot reserve, send, reply, cancel, resolve, or monitor.

## Configuration

Optional file: `~/.config/pi-herdr-dispatch/config.json`

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
  "inspectionLines": 50,
  "maxInspectionLines": 200,
  "catchUpLines": 200,
  "cwdPollMs": 5000,
  "cwdDriftSamples": 2
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
- exact TUI confirmation, immutable payload hashes, current-workspace scope, terminal identity, close/move observation, and delivery-echo verification;
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

Do **not** resend automatically. The target may have accepted input even when the response or bounded echo was lost. Inspect the target and use `/herdr-dispatch-resolve <id>` only after deciding the final outcome.

### Origin Session closed or Pi reloaded

Reservations remain durable. Resume the exact Origin Session. It performs a bounded catch-up read and never transfers monitoring to another session. A queued sanitized result uses `nextTurn` and does not start a model turn.

### Herdr restarted

Herdr 0.7.3 regenerates terminal IDs. A missing stored terminal becomes `target-lost` even if pane ID, cwd, Agent label, or retained history looks similar. V1 never retargets heuristically; inspect and manually resolve.

### `result-missing`, `target-moved`, or `target-lost`

Reservations remain held. Review the displayed bounded evidence, then use manual resolution. There is no standalone lease-release command.

### Origin Session unavailable

A different local TUI session may use emergency resolution only after personally attesting that the Origin is unavailable and confirming reservation release a second time. No process-liveness check is treated as proof. Emergency resolution does not transfer monitoring or inject context into the resolver.

### Registry unavailable or corrupt

State-changing behavior fails closed and never falls back to an empty or in-memory Registry. Preserve the database and its timestamped migration backups. Restore access or a reviewed backup before retrying. Exhausted transient SQLite busy/locked timeouts fail only the current operation; structural SQL errors disable later mutations in that process.

## UI and notifications

The extension adds one compact widget below the editor and never replaces Pi's footer. Herdr notification sounds are restricted to:

- `done` for a successful `done` outcome;
- `request` for attention, blocked, or failed outcomes;
- `none` for cancellation.

It never calls `pane.report_metadata`.

## Documents

- [Design](./docs/DESIGN.md)
- [Domain language](./docs/CONTEXT.md)
- [Implementation plan](./docs/IMPLEMENTATION-PLAN.md)
- [Compatibility spikes](./docs/SPIKE-RESULTS.md)
- [Live acceptance results](./docs/ACCEPTANCE-RESULTS.md)
- [Review findings](./docs/REVIEW-FINDINGS.md)
- [Architecture decisions](./docs/adr)
