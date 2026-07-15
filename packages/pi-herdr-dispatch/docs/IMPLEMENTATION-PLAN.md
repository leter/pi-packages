# pi-herdr-dispatch implementation plan

Status: approved; Phase 1 complete and awaiting phase review before Phase 2.

## Inputs and non-negotiable constraints

This plan implements [DESIGN.md](./DESIGN.md), uses the domain language in [CONTEXT.md](./CONTEXT.md), follows ADRs 0001–0005, and incorporates the live [Herdr 0.7.3 compatibility spike](./SPIKE-RESULTS.md).

The spike fixes these implementation rules:

- a Herdr restart changes terminal IDs; missing stored identity becomes `target-lost`, never heuristic retargeting;
- pane movement requires route re-resolution; closed pane/tab IDs are never reused;
- output reads request at most 200 lines even though Herdr clamps at 1000;
- delivery uses one `pane.send_input` with `keys: ["enter"]`, never split text/key calls;
- only explicit `screen_detection_skipped: true` is reported integration authority;
- V1 never calls `pane.report_metadata`; the widget and notifications are the only status display paths.

No phase may add coordinator takeover, revision cursors, automatic resend, cross-workspace targeting, Agent/pane creation, model wait tools, or autonomous continuation.

## Proposed module seams and test surfaces

These are the seams to approve before TDD begins. Tests exercise behavior through these interfaces rather than private helpers.

1. **Safety Policy module** — accepts a Pi operation plus current-pane/worktree/lease context and returns `allow` or a structured denial with redirect guidance. Shell tokenization and command tables remain hidden implementation details.
2. **Dispatch Registry module** — opens one configured database and exposes transactional domain operations for proposals, durable delivery intent, reservations, attention, first-wins settlement, context claims, audit, and retention. SQL is not exposed to callers or tests.
3. **Herdr Adapter module** — validates protocol 16 responses and exposes current-workspace discovery, terminal-to-pane resolution, atomic delivery, bounded tail reads, subscriptions, and notifications. Tests swap the real Unix socket for a protocol-faithful fake.
4. **Dispatch Application module** — creates immutable proposals and executes confirmed commands against the Registry and Herdr Adapter. Pi dialogs/tools are adapters at this seam rather than domain logic.
5. **Origin Monitor module** — starts for one exact Origin Session ID, consumes events/polls/catch-up reads, and requests domain transitions/settlement. Clock and timers are injected.
6. **Pi Extension adapter** — registers tools, commands, lifecycle hooks, `tool_call`, `tool_result`, `user_bash`, context delivery, widget, and notifications. It contains minimal policy.

Approval of this document approves these test seams. Any later need to test private SQL, shell-tokenizer internals, or monitor internals should first trigger a seam review rather than implementation-coupled tests.

## Planned package shape

```text
packages/pi-herdr-dispatch/
├── package.json
├── src/
│   ├── index.ts
│   ├── domain/
│   │   ├── model.ts
│   │   ├── result-envelope.ts
│   │   └── config.ts
│   ├── safety/
│   │   ├── policy.ts
│   │   ├── shell-classifier.ts
│   │   └── worktree-effects.ts
│   ├── registry/
│   │   ├── registry.ts
│   │   ├── schema.ts
│   │   └── migrations.ts
│   ├── herdr/
│   │   ├── adapter.ts
│   │   ├── socket-client.ts
│   │   └── protocol.ts
│   ├── dispatch/
│   │   ├── application.ts
│   │   ├── proposal.ts
│   │   ├── delivery.ts
│   │   └── settlement.ts
│   ├── monitor/
│   │   └── origin-monitor.ts
│   └── pi/
│       ├── tools.ts
│       ├── commands.ts
│       ├── lifecycle.ts
│       └── presentation.ts
└── test/
    ├── unit/
    ├── integration/
    ├── fixtures/
    └── support/
```

The exact file split may shrink when two files form one deep module; directories are ownership guidance, not a mandate for shallow pass-through files.

Package setup will add an explicit Pi manifest pointing to `./src/index.ts`, peer dependencies for Pi's bundled packages, development-only type/test dependencies, strict type checking, and repeatable unit/integration scripts. Runtime dependencies must remain in `dependencies`; test/build tools remain in `devDependencies`.

## Test traceability key

The identifiers below name the existing `DESIGN.md` checklist entries.

### Unit checklist

- **U1** lifecycle, durable `delivering`, orthogonal Attention Conditions
- **U2** Result Envelope parsing/sanitization/bounds/first-valid-wins/conflicts
- **U3** proposal immutability and stale-target detection
- **U4** current-workspace target resolution
- **U5** idle/`done` equivalence
- **U6** Git worktree identity and observed-change audits
- **U7** outbound message and delivery-echo matching
- **U8** built-in tools plus `user_bash` lease classification
- **U9** Herdr CLI classification: direct, quoted, piped, compound, ambiguous, unparseable
- **U10** prompt guideline presence and skill-guided precedence
- **U11** untrusted framing for typed inspection/current-pane reads
- **U12** Origin Session ID and active-branch delivery
- **U13** emergency-resolution eligibility/attestation/double confirmation
- **U14** stored disconnect versus derived Origin-closed monitoring pause
- **U15** retention and notification policy
- **U16** omission of `pane.report_metadata`

### Integration checklist

- **I1** atomic `pane.send_input` and fail-closed protocol mismatch
- **I2** crashes before/during/after send and before `active` commit
- **I3** resume `delivering`: result present, echo present, or neither
- **I4** pane close/move during final delivery window and closed-ID non-reuse
- **I5** globally unique Target Occupancy and Worktree Write Leases
- **I6** raw `bash`/`user_bash` tasking, Agent-start, split, and waits are blocked
- **I7** harmless metadata/current-pane reads work; foreign reads and snapshot are denied
- **I8** two Origins race for one target/worktree
- **I9** result settlement races emergency resolution; first wins
- **I10** emergency resolution requires non-Origin TUI and user attestation
- **I11** active-branch append crash/retry and branch change
- **I12** Herdr disconnect/reconnect with bounded catch-up
- **I13** target ends in `done` without a result
- **I14** terminal ID changes after restart and follows `target-lost`
- **I15** no pane/cwd/Agent-label heuristic retargeting
- **I16** malformed/conflicting Result Envelopes
- **I17** migration backup and rollback
- **I18** corrupt/locked database fails closed
- **I19** non-TUI modes never monitor or mutate

### Live acceptance checklist

- **L1** non-mutating dispatch to idle and `done` screen-detected Agents
- **L2** write lease blocks `edit`, `write`, `bash`, `!`, `!!` for non-holders
- **L3** duplicate target/worktree dispatch rejection
- **L4** kill Origin during delivery; resume with/without echo
- **L5** close Origin while target finishes; resume tail catch-up
- **L6** blocked-runtime → confirmed reply → result, with focus warning
- **L7** overdue/cancel/manual interrupt/result-missing/target-lost/target-moved
- **L8** restart Herdr during active work without assuming continuity
- **L9** no result starts a model turn; forks/clones do not claim results
- **L10** settlement is sanitized; explicit inspection is untrusted-framed
- **L11** natural-language Herdr task request cannot bypass through `bash`, `!`, `!!`
- **L12** Registry failure preserves reservations and disables state changes

## Phase 1 — Safety layer first

### Scope

Implement pure policy before any socket, SQLite, or UI work:

- conservative shell segmentation/tokenization for direct, quoted, piped, and compound commands;
- Herdr read allowlist and dispatch-sensitive deny policy;
- current-pane proof using resolved `HERDR_PANE_ID`; omitted/focused/name-based targets remain foreign;
- denial of foreign `pane/agent read`, `api snapshot`, tasking, creation, control, and blocking waits;
- best-effort worktree mutation classification for built-in `bash`, plus path normalization for `edit`/`write`;
- one policy result shape used by both `tool_call` and `user_bash` adapters;
- event adapters accept an injected lease snapshot provider so policy tests stay pure; Phase 2 supplies the real Registry-backed provider, while unavailable lease state fails closed for covered mutations;
- unparseable literal Herdr invocations fail closed; documented shell-sandbox limitations remain explicit;
- untrusted wrapping marker for allowed current-pane read results;
- exact `herdr_dispatch_propose` prompt guideline.

Work vertically: one failing behavior test, minimal policy behavior, then the next. Do not separately unit-test private tokenizer functions.

### DESIGN.md tests

U6, U8–U11; I6–I7; prepares L2, L10–L11.

### Acceptance criteria

- The policy is deterministic and side-effect free.
- `tool_call` can block unsafe built-in operations with a structured reason using injected lease context; Phase 2 later connects durable lease lookup without changing the policy interface.
- `user_bash` uses the same policy and returns a synthetic non-zero result when denied.
- Foreign output reads redirect to `herdr_agent_output_inspect`; cross-workspace snapshot redirects to typed listing; tasking redirects to `herdr_dispatch_propose` or `/herdr-dispatch`.
- Current-pane read output can be marked for `<untrusted-herdr-cli-output>` wrapping.
- Unknown third-party tools remain outside the claim; UI wording says best-effort.

### Approximate commits

1. `chore(pi-herdr-dispatch): add manifest, strict typecheck, and test harness`
2. `feat(safety): classify raw Herdr shell operations`
3. `feat(safety): classify covered worktree mutations`
4. `feat(safety): gate tool_call and user_bash through one policy`
5. `feat(safety): frame allowed Herdr read output and register prompt guidance`

## Phase 2 — Dispatch Registry

### Scope

Implement the durable source of truth with `node:sqlite`:

- versioned schema for dispatches, Target Occupancy, Worktree Write Leases, results, context-delivery claims, and audit events;
- WAL mode, foreign keys, busy timeout, integrity checks, and explicit transaction helpers;
- unique constraints for one occupancy per terminal and one write lease per canonical worktree;
- immutable proposal/payload hash and durable `delivering` transaction;
- compare-and-set lifecycle/attention/final-outcome transitions;
- first-wins settlement that stores result, releases both reservation types, and records audit atomically;
- active-branch context claim idempotency;
- timestamped pre-migration backup, transactional migration, rollback, and no empty/in-memory fallback;
- retention purge for settled data only; unsettled records are never purged;
- read-only query path retained when safe after state-changing functionality fails closed.

Use temporary real SQLite databases at the Registry seam. Do not mock SQL calls or assert table implementation details except migration compatibility fixtures.

### DESIGN.md tests

U1–U2, U6, U12–U15; I5, I8–I10, I17–I18; prepares L2–L3, L7, L9, L12.

### Acceptance criteria

- Two processes racing for one terminal/worktree produce one winner.
- Confirmation intent and reservations are committed before any Herdr side effect can occur.
- Settlement cannot partially store a result or partially release reservations.
- Duplicate/conflicting settlements cannot win twice.
- Migration failure restores/retains the previous database and disables mutations.
- Lock/corruption errors never create a replacement database or forget reservations.

### Approximate commits

1. `feat(registry): create versioned sqlite schema and migration runner`
2. `feat(registry): fail closed with backups and integrity checks`
3. `feat(registry): reserve targets and worktrees atomically`
4. `feat(registry): persist delivery lifecycle, attention, and audit`
5. `feat(registry): settle first-wins and claim active-branch delivery`
6. `feat(registry): retain settled history without purging active records`

## Phase 3 — Herdr Adapter

### Scope

Implement one session-scoped Unix-socket adapter:

- newline-delimited JSON request/response correlation and protocol-16 schema validation;
- connection/reconnection lifecycle with abortable reads and idempotent close;
- `session.snapshot` bootstrap restricted to current Workspace Scope;
- terminal-ID lookup and immediate same-connection route revalidation;
- status provenance mapping (`screen_detection_skipped === true` only), idle/`done` equivalence, and `PaneInfo.cwd` use;
- one atomic `pane.send_input` request with `keys: ["enter"]`;
- close/move/status/output-matched subscriptions;
- bounded 50/200-line `recent_unwrapped` reads, accepting shorter/clamped history and ignoring revision as a cursor;
- delivery echo verification and typed ambiguous-delivery result;
- Herdr notifications only; no pane metadata method in the interface or implementation.

The fake socket must speak real protocol envelopes and support disconnection at byte/request boundaries. Keep one small live contract test suite opt-in so normal CI does not depend on a running Herdr server.

### DESIGN.md tests

U4–U5, U7, U11, U16; I1, I4, I7, I12–I15; prepares L1, L4–L8, L10.

### Acceptance criteria

- Unknown version/protocol, malformed frames, duplicate IDs, and socket errors return typed fail-closed results.
- Delivery never falls back to `send-text` plus `send-keys` and never automatically resends.
- A moved pane is accepted only when the same terminal ID is freshly resolved with matching workspace/cwd.
- After restart, a missing terminal ID yields `target-lost`; matching pane/cwd is ignored.
- Reads never exceed design bounds, and `truncated: false` is not treated as complete history.
- No code path calls `pane.report_metadata`.

### Approximate commits

1. `feat(herdr): validate protocol 16 socket envelopes`
2. `feat(herdr): discover current-workspace agents and provenance`
3. `feat(herdr): revalidate routes and deliver atomically`
4. `feat(herdr): subscribe to lifecycle and output events`
5. `feat(herdr): read bounded tails and verify delivery echoes`
6. `feat(herdr): reconnect and notify without pane metadata`

## Phase 4 — Proposal and confirmation flow

### Scope

Implement the first usable confirmed-dispatch vertical slice:

- configuration validation and TUI-only state-changing behavior;
- `/herdr-agents`, `herdr_agents_list`, and bounded explicit output inspection;
- immutable proposal creation with correlation ID, mode, deadline, worktree identity, exact payload, and advisory warning;
- `herdr_dispatch_propose` plus `/herdr-dispatch` sharing one application path;
- Approve/Edit/Cancel UI; Edit produces a new immutable proposal;
- final target/status/workspace/cwd/reservation/concurrency revalidation;
- durable intent transaction followed by atomic Herdr delivery and echo-based outcome;
- `delivery-unverified` on ambiguity and no automatic resend;
- `herdr_dispatch_status` and text dispatch listing;
- sanitize all model-visible metadata and output.

Use Pi's basic `select`, `confirm`, `input`, and `editor` primitives for V1 rather than a custom dashboard.

### DESIGN.md tests

U3–U7, U10–U11; I1, I4–I8, I19; begins L1–L3, L10–L11.

### Acceptance criteria

- Every manual/model proposal shows the exact bytes to be sent and requires TUI confirmation.
- Non-TUI modes can list/inspect only and cannot reserve or deliver.
- Stale proposals cannot be approved after target/worktree/status drift.
- One Registry transaction durably records intent and reservations before send.
- Tool output never claims dispatch success until echo verification establishes it; ambiguity is visible and retained.
- Foreign CLI reads cannot substitute for typed one-shot inspection.

### Approximate commits

1. `feat(dispatch): validate config and build immutable proposals`
2. `feat(dispatch): render outbound payload and advisory confirmation`
3. `feat(dispatch): expose scoped listing and one-shot inspection tools`
4. `feat(dispatch): confirm durable intent and atomic delivery`
5. `feat(dispatch): surface delivery ambiguity and dispatch status`
6. `feat(dispatch): add slash-command proposal flow`

## Phase 5 — Origin monitoring and settlement

### Scope

Implement exact-Origin monitoring and all post-delivery behavior:

- start only during `session_start` in TUI mode for the exact persisted Origin Session ID;
- stop sockets/timers idempotently on `session_shutdown` for reload/new/resume/fork/quit;
- event-driven output/status/close/move handling plus five-second debounced cwd polling;
- startup acknowledgement window, overdue, blocked-runtime, result-missing, target-lost, target-moved, and stored socket-disconnect attention;
- derived Origin-closed monitoring gap on exact-session resume;
- bounded resume/reconnect catch-up for `delivering` and active records;
- strict Result Envelope source/correlation/schema validation and first-valid-wins settlement;
- worktree after-snapshot and observed-mutation/inconclusive audit;
- sanitized result injection with `pi.sendMessage(..., { deliverAs: "nextTurn" })`, never triggering a turn;
- durable active-branch claim through custom entries/Registry idempotency; forks/clones cannot claim Origin results;
- confirmed reply/cancellation slash commands, focused-dialog warning, and no `Ctrl+C` automation;
- Origin manual resolution and user-attested, double-confirmed emergency resolution;
- first-wins race between automatic and emergency settlement.

Timers use an injected clock/scheduler at the Origin Monitor seam. Integration tests use fake time; no real sleeps.

### DESIGN.md tests

U1–U2, U5–U7, U12–U14; I2–I4, I9–I16, I19; L4–L10 and L12.

### Acceptance criteria

- Only the exact running TUI Origin monitors its records; no other session takes over.
- Crash/restart paths never resend automatically and never release ambiguous reservations.
- A valid result atomically settles once, releases reservations once, and queues sanitized context once on the active branch.
- Result arrival while Pi is idle does not start an agent turn.
- `done` and `idle` both trigger result lookup/result-missing behavior.
- `target-lost` after Herdr restart requires manual resolution.
- Emergency resolution cannot adopt monitoring or inject into the resolver's context.

### Approximate commits

1. `feat(monitor): bind lifecycle to the exact origin session`
2. `feat(monitor): recover delivering and active dispatches from bounded tails`
3. `feat(monitor): track status, deadlines, cwd drift, and target loss`
4. `feat(settlement): validate envelopes and settle first-wins`
5. `feat(settlement): deliver sanitized results to the active origin branch`
6. `feat(dispatch): add confirmed reply and cancellation commands`
7. `feat(dispatch): add manual and emergency resolution`
8. `feat(audit): report observed worktree changes without attribution`

## Phase 6 — Widget, notifications, packaging, and live acceptance

### Scope

Finish presentation and release readiness:

- one-line below-editor widget: active count plus attention count;
- notification mapping exactly as designed (`done`, `request`, `none`);
- compact TUI-only durable entries for important state changes where useful, excluded from model context;
- optional integration setup prompts, one integration at a time, never automatic config mutation;
- no custom footer and no pane metadata;
- README installation/configuration/security/limitations/recovery guidance;
- local package installation smoke test, `/reload`, session replacement, and uninstall/cleanup instructions;
- execute the full 12-item live acceptance checklist in a disposable Herdr topology and clean every created pane/resource.

### DESIGN.md tests

U15–U16; verifies I19 and all L1–L12 end to end.

### Acceptance criteria

- Widget uses `placement: "belowEditor"` and leaves the existing footer untouched.
- Notifications use only documented Herdr sounds and never imply unverified success.
- No metadata report is emitted in socket traces.
- `npm run check`, unit tests, integration tests, package install smoke test, and live acceptance all pass.
- Temporary Herdr resources, test databases, sessions, and local installation entries are cleaned or explicitly retained only with user approval.
- Version remains development/private until acceptance evidence is reviewed; publishing is a separate user decision.

### Approximate commits

1. `feat(ui): show dispatch widget below the editor`
2. `feat(ui): emit outcome and attention notifications`
3. `feat(setup): add explicit per-integration setup prompts`
4. `docs(pi-herdr-dispatch): document install, safety, and recovery`
5. `test(pi-herdr-dispatch): complete package and live acceptance coverage`

## Cross-phase quality gates

Every commit must keep:

- strict type checking green;
- unit/integration suites deterministic and parallel-safe;
- fixtures free of real pane output, user session data, secrets, and absolute home paths;
- no network dependency in normal CI;
- no implementation-coupled tests beyond migration fixtures;
- no claims stronger than the best-effort/advisory threat model.

At the end of each phase, run `npm run check`, focused tests, the full test suite, and `git diff --check`. Live Herdr tests run only where the phase explicitly calls for them and must use named disposable sessions when server restart or isolation is required.

## Review gate

Stop here. Implementation begins only after the user approves:

1. the six module seams/test surfaces;
2. the phase order and acceptance criteria;
3. the test traceability mapping;
4. the approximate commit sequence.
