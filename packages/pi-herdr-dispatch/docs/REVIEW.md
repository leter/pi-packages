# Review Brief: pi-herdr-dispatch V1 Design

Please perform a skeptical architecture and safety review of the proposed `pi-herdr-dispatch` V1 design. Do not implement or edit the design during this review. Report findings first, ordered by severity, with exact file/section references and concrete failure scenarios.

## Design under review

Read these files completely:

1. [`DESIGN.md`](./DESIGN.md) — behavioral and technical design
2. [`CONTEXT.md`](./CONTEXT.md) — canonical domain language
3. [`adr/0001-sqlite-dispatch-registry.md`](./adr/0001-sqlite-dispatch-registry.md)
4. [`adr/0002-atomic-herdr-input-delivery.md`](./adr/0002-atomic-herdr-input-delivery.md)
5. [`adr/0003-orthogonal-dispatch-state.md`](./adr/0003-orthogonal-dispatch-state.md)
6. [`../../../CONTEXT-MAP.md`](../../../CONTEXT-MAP.md) — monorepo context placement

## Intended V1

Pi coordinates coding agents that already exist on one local Herdr server. It may propose tasks for idle agents, but every dispatch and ordinary follow-up requires human confirmation. It cannot create agents, panes, workspaces, or worktrees. Dispatches are asynchronous; results never trigger an autonomous parent-model turn.

The design uses:

- a global SQLite Registry;
- one renewable Coordinator Lease;
- globally unique target occupancy and Git worktree write leases;
- atomic Herdr `pane.send_input` delivery;
- pane-history recovery using correlation IDs and Result Envelopes;
- guarded versus advisory enforcement disclosure;
- a Pi TUI dashboard and model-callable proposal tools.

## Review axes

### 1. Internal consistency

Look for contradictions between the glossary, main design, and ADRs, especially around:

- terminal outcomes versus attention conditions;
- when target occupancy and Worktree Write Leases are acquired/released;
- `blocked-runtime` versus the terminal `blocked` outcome;
- result-missing, target-lost, target-moved, forced cancellation, and manual resolution;
- Origin Session result delivery after coordinator takeover;
- current-workspace defaults versus global Registry behavior;
- non-mutating audits overlapping write dispatches;
- TUI-only mutations versus model-callable tools.

### 2. Concurrency and crash safety

Walk through concrete interleavings involving two or more Pi processes:

- simultaneous proposals for the same target or worktree;
- coordinator lease expiry while the old coordinator is paused but not dead;
- delivery succeeds but the process crashes before Registry state changes;
- Registry commits delivery but Herdr never receives it;
- result settlement races coordinator takeover;
- lease release races a new write proposal;
- Origin Session appends a result but crashes before acknowledging the claim;
- Herdr disconnects or restarts during any transition.

Identify where fencing tokens, transaction boundaries, idempotency keys, or an outbox/inbox pattern are required. Do not accept “SQLite transaction” as sufficient unless the transaction can actually cover the external Herdr side effect.

### 3. Herdr feasibility

Verify the design against the installed/official Herdr API rather than assuming it works. Relevant local facts:

- installed Herdr: `0.7.3`, protocol `16`;
- socket: `~/.config/herdr/herdr.sock`;
- `agent.send` writes literal text and does not submit Enter;
- `pane.send_input` accepts `pane_id`, `text`, and `keys`;
- pane history is enabled with `[experimental] pane_history = true`;
- current Agent integrations are not installed, so status currently relies mainly on screen detection;
- Amp has no listed first-party Herdr integration.

Check whether the design can reliably obtain:

- the Origin Pi's own terminal/workspace identity;
- stable `terminal_id` → `pane_id` mapping;
- status provenance (`reported` versus `screen-detected`);
- monotonic pane revision/history cursors suitable for Recovery Scan;
- cwd/worktree drift events;
- event subscriptions and reconnect semantics;
- metadata TTL renewal and cleanup;
- atomic input delivery without focusing the target.

If an API claim is unsupported, identify it explicitly and suggest the smallest V1 correction.

### 4. Pi extension feasibility

Verify against the installed Pi extension API and lifecycle:

- installed Pi package: `@earendil-works/pi-coding-agent`;
- global extensions run in each Pi process;
- tools may display TUI confirmation through `ctx.ui`;
- custom messages can enter model context without triggering a turn;
- custom entries can be durable but excluded from model context;
- extension instances reload and shut down with sessions;
- the machine already has a custom footer, so this design uses a separate widget.

Review whether the package can safely:

- identify its own Herdr terminal;
- run one global coordinator while every Pi instance enforces leases;
- append exactly-once sanitized results to the correct Origin Session;
- prevent state-changing tools outside TUI mode, including RPC edge cases;
- intercept `edit`, `write`, and mutating `bash` without false confidence;
- survive `/reload`, `/new`, `/resume`, process exit, and package update;
- use `node:sqlite` compatibly with the actual Node/Pi runtime.

### 5. Security model

Challenge every claimed safety boundary:

- Target Agents and pane output are untrusted.
- Advisory agents can ignore all outbound constraints.
- A task can be altered through prompt injection from repository content.
- Bash mutation classification is necessarily incomplete.
- Other shells and non-Pi agents can bypass leases.
- Result Envelopes can lie about tests, files, and outcomes.
- A local process may write directly to the Herdr socket or Registry.
- Cross-workspace metadata and result summaries may expose sensitive information.

Distinguish clearly among enforced invariants, best-effort guards, detection, and policy text. Flag any wording that promises more than the implementation can guarantee.

### 6. Domain model quality

Review whether terms in `CONTEXT.md` are:

- precise and non-overlapping;
- domain concepts rather than implementation details;
- used consistently in `DESIGN.md`;
- missing any concept required to explain the lifecycle;
- carrying accidental contradictions such as “terminal” versus “paused.”

Also assess whether the package belongs in the root `CONTEXT-MAP.md` and whether its language is properly isolated from future package contexts.

### 7. Scope discipline

Identify features that should be removed from V1 because they add disproportionate complexity. In particular challenge:

- global multi-workspace Registry;
- coordinator takeover;
- automatic pane-history recovery;
- cross-workspace dispatch;
- screen-detected targets;
- Mutation Audit attribution;
- forced cancellation;
- model-callable reply/cancel tools;
- interactive dashboard versus simpler commands.

Conversely, identify any missing requirement that makes the core dispatch lifecycle unsafe or unusable.

### 8. Testability

Assess whether the proposed unit, integration, and live acceptance tests can prove the important guarantees. Add missing adversarial tests, especially for crash consistency, stale coordinators, malformed output, terminal reuse, history truncation, and concurrent Origin Session claims.

## Required output

Use this structure:

```markdown
# Review: pi-herdr-dispatch V1

## Findings

### Critical
- [Finding with file/section reference, concrete scenario, impact, and recommended correction]

### High
...

### Medium
...

### Low
...

## Unsupported or unverified API assumptions
- ...

## V1 scope cuts recommended
- ...

## Missing decisions
- ...

## What is solid
- ...

## Verdict
Choose exactly one:
- Ready for implementation planning
- Ready after specified design corrections
- Requires architectural simplification before planning
```

For every finding, separate:

1. **Observation** — what the documents currently say.
2. **Failure scenario** — a concrete sequence that breaks or weakens it.
3. **Impact** — safety, correctness, privacy, UX, or complexity.
4. **Recommendation** — the smallest specific design change.

Do not give generic praise, rewrite the whole design, or implement code. If no issue exists on an axis, say what you checked and why it appears sound.
