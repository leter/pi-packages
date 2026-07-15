# Review: pi-herdr-dispatch V1

Reviewed against REVIEW.md by Claude (Fable 5) on 2026-07-15. All claims verified against installed Herdr 0.7.3 (protocol 16, `herdr api schema` + live `session.snapshot`) and `@earendil-works/pi-coding-agent@0.80.6` on Node v24.18.0.

## Findings

### Critical

**C1. Crash during `delivering` has no recovery protocol** (DESIGN.md "Lifecycle", "Recovery and result delivery"; CONTEXT.md "Dispatch Lifecycle")
- **Observation**: The lifecycle contains `delivering`, and the design forbids automatic resend, but no rule states what happens to a dispatch found in `delivering` after a crash — neither "delivery succeeds but the process crashes before Registry state changes" nor "Registry commits delivery but Herdr never receives it" is answered anywhere.
- **Failure scenario**: Origin Pi marks the dispatch `delivering` (occupancy + worktree lease acquired), calls `pane.send_input`, and is killed before recording `active`. On recovery no coordinator can tell whether the target received the task. Resending risks double execution; not resending leaves a confirmed dispatch that silently never ran while permanently holding the target occupancy and write lease.
- **Impact**: Correctness and safety of the single most important transition; the Registry transaction cannot cover the external Herdr side effect (the outbox problem).
- **Recommendation**: Define a `delivery-unverified` attention condition: on recovery, scan the target's recent pane lines for the echoed `[HERDR DISPATCH]` / `ID: hd_…` header (the delivered text is visible in the pane). Echo found → `active`; not found → require manual resolution like `result-missing`. Record `active` in the Registry only after `pane.send_input` returns success.

**C2. Recovery Scan and result acceptance rely on pane-revision semantics the installed API does not have** (DESIGN.md "Recovery and result delivery", "Result protocol"; CONTEXT.md "Recovery Scan")
- **Observation**: The design stores "the pane revision captured at delivery", starts the Recovery Scan "there", and requires "pane revision" to "match" for acceptance. Verified against protocol 16: `pane.read` takes only `source` (`visible|recent|recent_unwrapped|detection`), `lines`, and `strip_ansi` — there is **no read-from-revision parameter**. A read returns only the *current* revision, so the revision at which a given line was printed is unknowable. The live snapshot additionally reports `revision: 0` for panes with thousands of lines of scrollback, so the counter's durability (and behavior across Herdr restarts) is doubtful.
- **Failure scenario**: After coordinator takeover, the implementation cannot "start at the delivery revision"; it can only re-read the last N lines. The "revision must match" acceptance criterion cannot be implemented as written, so it will silently degrade to something weaker than specified, and any revision comparison breaks after a Herdr restart resets counters.
- **Impact**: The core recovery and acceptance mechanism is specified against a nonexistent API; whatever gets implemented will not be what was reviewed.
- **Recommendation**: Acceptance = unique correlation ID + source pane/terminal match + schema (the correlation ID is random and unique, so pre-delivery matches are impossible). Define Recovery Scan as a bounded read of the last N `recent_unwrapped` lines; use revision numbers (from read results / `pane_output_changed` via `events.wait` `min_revision`) only as an "output advanced since delivery" signal, never as a cursor. Note: the unused `pane.output_matched` subscription (regex match per pane) is a better live result-detection primitive than polling and is fully supported.

### High

**H1. No fencing between an expired-but-alive coordinator and its successor** (DESIGN.md "Components #4", "Coordinator and Herdr UI"; CONTEXT.md "Coordinator Lease")
- **Observation**: Takeover is allowed after the 30 s lease expires, but nothing requires the old coordinator's subsequent Registry writes to re-verify lease ownership.
- **Failure scenario**: Coordinator Pi is SIGSTOPped / the laptop sleeps / a modal blocks the event loop for >30 s. A second Pi takes over. The first resumes and — believing its in-memory lease valid — settles dispatches, runs forced-cancellation audits, publishes metadata, and emits notifications concurrently with the new coordinator. Manual resolutions and audits can interleave and disagree.
- **Impact**: Correctness of settlement and audit results; duplicate notifications.
- **Recommendation**: Add a monotonic coordinator epoch incremented at takeover; every coordinator-initiated write transaction must include a `WHERE epoch = ?` compare-and-set. Worth a sentence in ADR 0001.

**H2. "Guarded" enforcement has no defined mechanism — and non-mutating mode is never enforced by anything** (DESIGN.md "Mutation and side-effect policy"; CONTEXT.md "Enforcement Level", "Dispatch Mode")
- **Observation**: `guarded` means "the target harness actively enforces available controls", but the design never says how the origin determines this, nor what the target-side control for a *non-mutating* dispatch would be — the Worktree Write Lease guard only blocks *other* Pi instances in *leased* worktrees, and non-mutating dispatches take no lease.
- **Failure scenario**: A proposal shows `guarded` based on the pane's Agent label (`pi`), the user trusts the label, and the target — whose extension has no mechanism to know it is executing a non-mutating dispatch — freely edits files.
- **Impact**: Safety-boundary overstatement.
- **Recommendation**: In V1, display `advisory` unless the target's extension has provably registered its terminal_id in the Registry *and* the design specifies what that extension enforces on receipt of a `[HERDR DISPATCH]` message (e.g., parse the header and block write tools for non-mutating tasks). Otherwise delete `guarded` from V1.

**H3. Revalidate→deliver is not atomic, and pane IDs are unstable delivery addresses** (DESIGN.md "Identity and scope", "Outbound message"; ADR 0002)
- **Observation**: Delivery addresses `pane_id`. Verified live: pane IDs are short workspace-scoped tokens (`w8:p5`) while terminal IDs are long and unique (`term_656911a1…`); the `pane_moved` event carries `previous_pane_id`, i.e. pane IDs change when panes move, and reuse after close is plausible and unverified. There is no compare-and-send API.
- **Failure scenario**: Revalidation passes; the target pane closes; a new pane (different agent, or a bare shell) receives the same short ID; `pane.send_input` types the full task + Enter into the wrong terminal.
- **Impact**: Task injection into an arbitrary local process; ADR 0002's atomicity argument fixes split text/Enter but not this.
- **Recommendation**: Re-resolve terminal_id→pane_id with a single `pane.get` immediately before `pane.send_input`; subscribe to `pane.closed`/`pane.moved` for the target during the confirmation window; verify the delivery echo afterward (shares machinery with C1); document the residual race in ADR 0002. The later compatibility spike established that Herdr unary sockets accept one request, so the approved implementation uses tightly adjacent fresh unary connections plus one exclusive subscription stream.

**H4. The `done` agent status is unhandled everywhere** (DESIGN.md "Eligibility", "Lifecycle"; CONTEXT.md "Result-Missing Dispatch", "Forced Cancellation")
- **Observation**: Protocol 16's `AgentStatus` is `idle|working|blocked|done|unknown`. The design keys result-missing on "target becomes idle", forced-cancel completion on "target reports idle", and eligibility rejection lists working/blocked/unknown — `done` appears nowhere.
- **Failure scenario**: A target finishes and its status lands on `done` without a Result Envelope. `result-missing` never triggers; a forced cancellation waits for `idle` forever; the dispatch sits until `overdue` with the lease held.
- **Impact**: Correctness of settlement and cancellation for a status value the installed server actually emits.
- **Recommendation**: Explicitly map `done` as idle-equivalent for result-missing, forced-cancel completion, and eligibility.

**H5. "Raw pane output does not enter parent model context" contradicts the inspection tool** (DESIGN.md "Result protocol" vs "Model tools" / `herdr_agent_output_inspect`; CONTEXT.md "Agent Output Inspection")
- **Observation**: The Result protocol states raw pane output never enters parent model context, while `herdr_agent_output_inspect` exists precisely to return up to 200 raw (ANSI-stripped) pane lines into model context, and blocked-runtime handling reads 50 lines.
- **Failure scenario**: A dispatched agent (or repo content it echoes) prints injected instructions; the user asks "how is the agent doing?", the model inspects, and the injected text sits in context as unmarked pane output steering the next proposal.
- **Impact**: Security-model overstatement; the inspection path is the primary injection channel into the Origin model.
- **Recommendation**: Reword the invariant to "raw output never enters context *via settlement*"; require inspection output to be wrapped in the same explicit untrusted-data framing as Sanitized Dispatch Results.

**H6. The installed herdr agent skill is a raw-CLI bypass around every dispatch safety gate** (added 2026-07-15 after installing the official skill; DESIGN.md "Mutation and side-effect policy", "Model tools"; CONTEXT.md "Worktree Write Lease")
- **Observation**: The official herdr agent skill (`~/.agents/skills/herdr/SKILL.md`, now installed globally and visible to Pi) teaches the model to drive Herdr directly through the bash tool: `pane split`, `pane run <pane-id> "<task>"` (including launching new agents: `codex`, `claude`, `pi`, `opencode`, `omp`), `pane send-text`/`send-keys`, and **blocking waits** (`herdr wait agent-status --status done`). All of these run as ordinary bash from inside the same Pi process that hosts this extension. The design's threat model only lists "manual shells and processes without the extension" as bypass channels — it does not anticipate the origin Pi itself bypassing its own gates via skill-guided bash.
- **Failure scenario**: The user says "用 herdr 派个活给旁边的 agent"; the skill trigger fires and the model runs `herdr pane run w8:p5 "…"` directly — no proposal, no confirmation, no occupancy/lease, no Result Envelope, plus a blocking wait the design explicitly forbids. Every V1 boundary is silently voided while the extension believes no dispatch exists.
- **Impact**: Safety — the entire confirmation/lease/settlement model becomes advisory whenever the skill is more salient than the extension tools; also state divergence (Registry knows nothing about skill-initiated work, so audits and conflicts are blind to it).
- **Recommendation**: In the extension's `tool_call` bash classifier (same code as M10), block mutating herdr CLI invocations targeting *other* panes — `pane run`, `pane send-text`, `pane send-keys`, `pane split`, `pane close`, `agent send`, `agent start`, `wait agent-status`/`wait output` against foreign panes — with a message directing to `/herdr-dispatch`; allow read-only commands (`pane list/get/read/current`, `workspace list`, `tab list`) so the skill remains useful for inspection. Add `promptGuidelines` on the dispatch tools stating that tasking other agents must go through `herdr_dispatch_propose`. Apply the same classifier to the `user_bash` event (M10).

Two official-documentation facts from the same skill page also adjust earlier findings:
- Herdr docs state "Closed resources don't reuse IDs" — the worst-case pane-ID-reuse misdelivery in **H3** can be downgraded on the strength of that guarantee (cite it in ADR 0002); the pane-ID-changes-on-move race remains.
- The docs define `done` as "completed, result unseen" — confirming **H4**: `done` is a real post-completion status and must be handled as idle-equivalent.

### Medium

**M1. Status provenance is not directly exposed by the API** (DESIGN.md "Eligibility"). No status-source field exists on `AgentInfo`/`PaneInfo`; only `screen_detection_skipped` and the write-side `pane.report_agent`/`pane.clear_agent_authority` imply an authority model. On this machine no integrations are installed, so **every** target is screen-detected today. Verify that `screen_detection_skipped` ⇔ integration authority with a live test, and design the UX for the all-screen-detected reality.

**M2. `target-moved` detection has no event and no defined cwd source** (DESIGN.md "Lifecycle"). There is no cwd-change subscription; `PaneInfo` offers both `cwd` and `foreground_cwd`, and the design doesn't pick one or define polling. An agent running `cd /tmp && make` flips `foreground_cwd` transiently → spurious `target-moved`. Define drift on pane `cwd`, polled at a stated interval, debounced.

**M3. Replies typed into a blocked TUI can be consumed as dialog keystrokes** (DESIGN.md reply flow). `blocked-runtime` typically means the target shows a permission dialog or menu; `pane.send_input` types text + Enter into whatever widget is focused — the first characters may select a dialog option the user never intended. The reply confirmation must display the 50 recent lines already read for blocked-runtime and warn that delivery lands in the currently focused prompt.

**M4. Origin Session identity, forks, and branch-local claims are undefined** (DESIGN.md "Recovery and result delivery"; CONTEXT.md "Origin Session"). The Registry records claims but the design never says how the origin is identified (session file? session ID?); Pi sessions fork/clone and branch. A claim entry can land on an abandoned branch — Registry says claimed, model context never saw it; a forked session containing the confirmation looks like the origin. Record origin by session ID; check claim idempotency against the active branch; state that forks are not the origin.

**M5. Herdr server restart identity semantics unverified** (DESIGN.md monitoring-paused). Whether `terminal_id` survives a server restart, and what happens to revisions and experimental pane history, is unverified. A routine Herdr upgrade could turn every Active Dispatch into `target-lost`. Test restart behavior once and write the observed rule into the design.

**M6. Coordinator participation by run mode is ambiguous** (DESIGN.md "V1 boundaries" vs "Components #4"). "State-changing operations are TUI-only", yet the coordinator settles dispatches, and global extensions load in every Pi process including `pi -p` one-shots — short-lived processes could grab the Coordinator Lease and exit, causing churn. State that only TUI-mode instances may acquire the Coordinator Lease, and that proposal/reply/cancel tools are disabled when `ctx.mode !== "tui"` (checking mode, not `hasUI`, since `hasUI` is true in RPC).

**M7. "Mutation Violation" requires attribution the same glossary says is unavailable** (CONTEXT.md "Mutation Audit" vs "Mutation Violation"). The audit "does not claim process-level attribution", yet a violation requires "an attributable worktree change"; user edits and manual shells can never be excluded, so no change is ever strictly attributable. Define the finding as "observed change during non-mutating dispatch (unattributed)" with the overlapping-write-lease exclusion, and drop the violation/attribution taxonomy.

**M8. Per-workspace concurrency limit doesn't say which workspace** (DESIGN.md "V1 boundaries"; CONTEXT.md "Dispatch Registry"). With cross-workspace dispatch, "four active per workspace" could count by origin or by target workspace. Define it (target workspace is the resource being consumed).

**M9. Model-tool listing scope can leak cross-workspace metadata** (DESIGN.md "Model tools" vs "User interface"). `/herdr-agents` defaults to current workspace, but `herdr_agents_list`'s scope is unspecified; if it returns all workspaces, other projects' cwds/labels/status enter this session's model context by default. Default the tool to Workspace Scope with an explicit parameter mirroring the cross-workspace naming rule.

**M10. The lease guard's stated coverage is over-broad for its mechanism** (CONTEXT.md "Worktree Write Lease"; DESIGN.md "Mutation and side-effect policy"). `!`/`!!` user-bash commands bypass `tool_call` (interceptable only via the separate `user_bash` event, never mentioned), and third-party extensions' custom mutating tools can't be recognized by name. Intercept `user_bash` with the same classifier, and narrow the glossary claim to built-in edit/write/bash tools.

### Low

**L1.** "Attention-Required Dispatch" names only the blocked-runtime case while eight Attention Conditions all "require attention" — rename to Blocked-Runtime Dispatch. Consequence: Dispatch Reply is defined only against that state, so replying to an `unacknowledged`/`overdue` screen-detected target (which may never report `blocked`) is undefined exactly where it's most needed.

**L2.** "Active Dispatch … stays under automatic monitoring until it reaches a terminal outcome" (CONTEXT.md) contradicts `monitoring-paused`/`target-lost` where monitoring explicitly pauses. Add "except while a pausing Attention Condition applies".

**L3.** "Terminal" is overloaded three ways (terminal outcome / Herdr terminal ID / target-lost's "terminal disappeared"). Consider "final outcome" in the glossary.

**L4.** ADR 0002's rationale overstates what atomicity buys: it removes the split text/Enter race but not target drift before the single request (see H3).

**L5.** Glossary gaps: no entry for target occupancy (load-bearing in eight other entries), none for the `delivering` state, and C1's recovery condition will need a term.

**L6.** `pane.read`'s `lines` upper bound and the actual depth of `recent`/`recent_unwrapped` history under `[experimental] pane_history` are unverified; the Recovery Scan's "bounded" needs a number the API is known to honor. Also the key-name vocabulary for `keys` (`["enter"]`, and `Ctrl+C` for forced cancellation) is not in the schema — verify accepted key strings.

**L7.** The coordinator's expiring `custom_status` metadata may collide with a future agent integration's own custom status; `pane.report_metadata` has `source`/`applies_to_source` semantics — specify a dedicated source and verify coexistence.

## Unsupported or unverified API assumptions

Unsupported as written:
- Reading pane history from a stored revision cursor — no such parameter on `pane.read` (C2).
- "Pane revision match" as a result-acceptance criterion — line-level revisions are unknowable (C2).
- Handling of agent status `done` — the enum value exists but the design has no path for it (H4).
- Status provenance as a readable field — only inferable via `screen_detection_skipped`/authority semantics (M1).
- cwd/worktree drift events — polling only (M2).

Unverified, must test before planning:
- `terminal_id` stability and revision behavior across Herdr server restart (M5); pane-ID reuse after close (H3); `pane.read` line bounds and history depth (L6); key-name strings for `keys` (L6); `custom_status` coexistence with integrations (L7).

Verified and correct as claimed:
- `pane.send_input {pane_id, text, keys:["enter"]}` exists on protocol 16; `agent.send` is literal-text-only — ADR 0002's core choice is right.
- `pane.report_metadata` supports `ttl_ms`, `seq`, `source`; `notification.show` sounds are exactly `none|done|request` — the design's sound table maps 1:1.
- `events.subscribe` covers `pane.closed/moved/exited/agent_detected/agent_status_changed` and a regex `pane.output_matched` (a better result-detection primitive than anything in DESIGN.md — use it).
- Self-identity via `HERDR_PANE_ID`/`HERDR_WORKSPACE_ID` env plus `pane.get` → `terminal_id` works; verified live.
- Pi side: `pi` runs under Node v24.18.0 (not Bun) and `node:sqlite` loads; `pi.sendMessage(..., {deliverAs:"nextTurn"})` enters model context without triggering a turn; `pi.appendEntry` is durable and context-excluded; `tool_call` can block; `setWidget(..., {placement:"belowEditor"})` leaves the custom footer untouched; `session_shutdown`/`session_start` cover `/reload`, `/new`, `/resume`, fork; `ctx.mode` distinguishes TUI/RPC/JSON/print.

## V1 scope cuts recommended

1. **Coordinator takeover + Recovery Scan** — the largest complexity driver (C1, C2, H1 all cluster here). Since results never trigger autonomous turns and only the Origin Session consumes them, let each Pi monitor only the dispatches it confirmed and recover them when it next resumes. Cost: settlement and lease release are delayed while the origin is closed — acceptable at V1 scale (≤8 dispatches, one human). Keep the global Registry for leases and occupancy only.
2. **Cross-workspace dispatch** — cut; it creates M8/M9.
3. **Forced cancellation** — cut to guidance ("press Ctrl+C in the pane, then `/herdr-dispatch-resolve`").
4. **Mutation Violation taxonomy** — keep the before/after diff, report "observed changes" only (M7).
5. **Model-callable reply/cancel propose tools** — cut; slash commands suffice mid-flight.
6. **Do not cut screen-detected targets** — on this machine no integrations are installed, so screen detection is the only status source.
7. Dashboard can start as a text list + actions; the interactive TUI is polish, not safety.

## Missing decisions

- Recovery rule for a dispatch found in `delivering` (C1) — the biggest gap.
- How `guarded` is determined and what the target-side enforcement actually is (H2).
- Which run modes may hold the Coordinator Lease (M6).
- Origin Session identity representation and fork/branch claim semantics (M4).
- Monitoring architecture: which events are subscribed vs polled, poll cadence for status/cwd, and whether `pane.output_matched` is the result-detection primitive.
- Which workspace the per-workspace limit counts (M8).
- Interplay between `unacknowledged` (time-based) and "ambiguous screen-detected transitions produce attention" — these overlap without a stated precedence.
- Missing adversarial tests: SIGSTOPped coordinator resuming after takeover; pane-ID reuse between revalidate and send; crash in `delivering`; target finishing into `done`; revision reset after Herdr restart; two conflicting Result Envelopes with the same correlation ID (first-wins means repo-injected content can settle a dispatch early and release its lease — worth an explicit test and a documented acceptance of that limit); claim entry on an abandoned session branch.

## What is solid

- ADR 0003's lifecycle/attention/outcome separation is the right model and is applied consistently; the axis-1 consistency pairs (blocked-runtime vs blocked outcome, target-lost/moved lease retention, no standalone lease release, no coordinator-session delivery, non-mutating overlap → inconclusive, batch limits) are coherent.
- Fail-closed Registry posture (ADR 0001) — no empty-DB fallback, no in-memory fallback, unique constraints for leases — is exactly right.
- Human confirmation on every entry point with immutable proposals and pre-delivery revalidation is a sound trust boundary; "results never trigger a model turn" is verified implementable with the installed Pi API.
- The outbound message format (self-contained header, explicit constraints, placeholder envelope that can't false-match) is well designed.
- The notification sound mapping and metadata TTL approach match the installed API exactly; widget-instead-of-footer respects the machine's existing customization.
- CONTEXT-MAP.md is appropriate: the two contexts are genuinely independent, and "no relationship yet" is honest.

---

# Re-review after revision (2026-07-15, second pass)

All 24 original findings (C1–C2, H1–H6, M1–M10, L1–L7) are substantively addressed and all eight scope cuts were adopted (verified against the revised DESIGN.md, CONTEXT.md, and ADRs 0001–0005). The revision introduced one genuine policy contradiction and three wording gaps:

**N1 (Medium). The raw-CLI read allowlist contradicts two of the design's own policies** (DESIGN.md "Raw Herdr CLI gate" allow list vs "Model tools" / "Explicit V1 scope cuts")
- **Observation**: The gate allows `herdr pane read`, `herdr agent read`, and `herdr api snapshot` through bash. The same document states (a) Agent Output Inspection is "one user-authorized bounded read, not continuing surveillance", and (b) V1 cuts "model access to foreign Agent metadata" — `herdr_agents_list` is workspace-restricted with "no all-workspaces parameter".
- **Failure scenario**: Instead of calling `herdr_agent_output_inspect` (which requires an explicit user request), the model repeatedly runs `herdr pane read w8:p5` — the gate allows it (read-only), applies only untrusted framing, and performs **no authorization check**, achieving the prohibited continuous surveillance. Likewise one `herdr api snapshot` puts every workspace's Agents/cwds/status into model context, hollowing out the M9 fix via the bash path.
- **Recommendation (smallest fix)**: Move foreign-pane `pane read`/`agent read` and `api snapshot` from the allow list to the deny list, redirecting to `herdr_agent_output_inspect` / `herdr_agents_list` (reads of the Pi's *own* pane may stay allowed). Alternatively, explicitly retract the one-read-per-authorization and workspace-scoping promises — but do not keep both the allowlist and the promises.

**N2 (Low). Emergency resolution lacks a glossary entry and an availability rule.** DESIGN.md defines the flow for a non-Origin TUI session, but CONTEXT.md's Manual Resolution does not distinguish Origin vs emergency, and "when the Origin Session is unavailable" has no determination mechanism. State that availability is judged by the user (double-confirmed) and that a race with automatic settlement is resolved transactionally first-wins (the integration test already covers this).

**N3 (Low). Terminology drift**: DESIGN.md "Status semantics" still says "final `blocked` Dispatch Outcome"; the glossary renamed the term to "Final Outcome".

**N4 (Low). Monitoring-Paused semantics when the Origin is closed**: CONTEXT.md defines it to include "Origin Session … unavailable", but no process records that Attention Condition while the Origin is closed — it can only be derived at resume/display time. Distinguish stored conditions from derived facts in the wording.

## Re-review verdict

**Ready after specified design corrections** (the previous "requires architectural simplification" is lifted). Fix N1 plus the three wording items and the design is ready for implementation planning. The core dispatch lifecycle, crash consistency, and threat-model wording now hold, and nothing depends on nonexistent API semantics — the "Required compatibility checks" section properly converts all remaining unknowns into a pre-implementation spike list.

---

## Original verdict (first pass)

**Requires architectural simplification before planning.**

The domain model and safety posture are strong, but the two Critical findings and H1 all live in the coordinator-takeover/Recovery-Scan machinery, which is simultaneously the most complex part of the design and the part specified against API semantics that don't exist. Cutting takeover (scope cut #1) and re-specifying recovery around echo verification and correlation-ID-only acceptance collapses C1, C2, and H1 into a much smaller, verifiable design; H2–H5 are then targeted corrections rather than redesign.
