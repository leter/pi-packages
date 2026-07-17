# Phase 6 Acceptance Results

Date: 2026-07-15

Original result: **PASS**

Invalidated: **2026-07-16**, after the original checklist failed to prove cross-Agent delivery

Current result: **PASS restored for automatic-default dispatch on 2026-07-16**

The original checklist did not prove the core delivery contract across supported Agent TUIs. A later confirmed dispatch to a real Claude Code target returned a successful `pane.send_input` response but produced no target echo, no visible task, and no execution acknowledgement. The application nevertheless changed the Registry to `active` while adding `delivery-unverified`, contradicting the package's own lifecycle vocabulary. That PASS was correctly withdrawn.

After staged text/Enter delivery, exact-echo activation, startup-window Result Envelope re-reads, temporary scoped Automation Grants, and live Registry widget rendering were implemented, a fresh real-Agent matrix passed without manual Enter or per-dispatch confirmation. Each target rendered its exact Dispatch Correlation ID and task, returned `done`, settled with no Attention Conditions, and left zero unsettled records:

| Agent | Dispatch | Result | Attention | Target evidence |
|---|---|---|---|---|
| Pi | `hd_mrmzlgsg_WycYBV3gD4iIbd34` | `settled / done` | none | Exact prompt/result visible; widget rendered `0 running · no attention` afterward |
| Claude Code | `hd_mrmzmcs9_pVTe3BIsZSStVBox` | `settled / done` | none | Exact prompt/result visible; no manual Enter |
| Codex | `hd_mrmzngte_snbgUehycDWOIj_g` | `settled / done` | none | Delayed hard-wrapped result accepted automatically inside the bounded re-read window |
| OpenCode | `hd_mrmzo1eo_hyjXkiB5KOMo1R9q` | `settled / done` | none | Bordered hard-wrapped prompt/result accepted |
| Droid | `hd_mrn2uj3j_Y-QdLHOBkr62kyDG` | `settled / done` | none | Hook-decorated prompt/result accepted |
| Amp | `hd_mrn2vcni_6xDAYymlVryheWO3` | `settled / done` | none | Bordered, hard-wrapped prefix and JSON accepted |
| Grok | `hd_mrn2wpsu_5U6bfN9MCOSjUiRH` | `settled / done` | none | Timestamp-decorated bare prefix plus hard-wrapped JSON accepted after regression fix |

That historical matrix consumed the remaining four uses of a five-use Automation Grant. At the user's explicit request, schema version 3 removes grant state and makes typed TUI dispatch automatic by default ([ADR 0009](./adr/0009-automatic-dispatch-by-default.md)). After reload, the real Registry migrated to version 3, the `automation_grants` table was absent, `integrity_check` remained `ok`, and zero unsettled records or Attention Conditions remained. A fresh no-prompt Pi dispatch (`hd_mrn2p0r3_OFvK4ZshIsL0cO3Q`) reached exact delivery echo, settled `done`, had no Attention Conditions, and rendered `0 running · no attention`. Default verification passed 312 tests with one intentional skip, and the formal real-server contract passed separately through `bash scripts/verify.sh live`.

## Environment

- Pi `0.80.7` for the post-repair matrix (`0.80.6` for the original checklist)
- Herdr `0.7.3`, protocol `16`
- Node.js `24.18.0`
- Package remained `private` at `0.0.0-development`
- No package was published

The live checklist ran in one named, disposable Herdr session with one disposable Git repository, an isolated home directory, an isolated Dispatch Registry, and existing Pi Agents created only by the acceptance harness. The extension itself did not create Agents, panes, workspaces, worktrees, or coordinators.

## Presentation, packaging, and installation

| Check | Result | Evidence |
|---|---|---|
| Widget placement | PASS | A real Pi TUI showed `dispatches: 0 running · no attention` below the editor. Source and unit tests require `placement: "belowEditor"`. |
| Custom footer coexistence | PASS | The machine's `clean-footer.ts` remained visible as `gpt-5.5 high · content 0%` before and after `/reload`, at the same time as the dispatch widget. The extension never called `setFooter`. |
| Notification sounds | PASS | Outcome/attention tests observed only `done`, `request`, and `none`; no other sound value is produced. |
| Pane metadata | PASS | Adapter traces and source audit contained no `pane.report_metadata` request. |
| Local install | PASS | In an isolated `PI_CODING_AGENT_DIR`, real `pi install`, `pi list`, and `pi remove` commands all succeeded. The temporary directory was removed. |
| Reload | PASS | The widget and custom footer both remained present after real `/reload`. |

## L1–L12 live acceptance

### L1 — idle and done Agents

**PASS.** A non-mutating dispatch to an initially `idle` screen-detected Pi Agent settled `done`. A second dispatch selected an initially `done` screen-detected Pi Agent and also settled `done`. The second run additionally exercised conservative `delivery-unverified` handling before the valid result settled it. Live testing found and fixed one semantic bug: `idle` and `done` are both idle-like and final revalidation must allow drift between them.

### L2 — covered mutation paths for non-holders

**PASS.** With an active write lease on the disposable repository, a non-holder Pi attempted all covered mutation paths:

- model `edit`;
- model `write`;
- model `bash`;
- direct `!`;
- direct `!!`.

All five attempts returned the lease denial naming the owning dispatch. The tracked file remained `baseline` and no attempted output file existed after the rerun.

An initial harness trial accidentally omitted the explicit isolated `HOME` prefix for a Pi process, so that process correctly consulted a different Registry and the trial was rejected. The disposable repository was restored, both Pi processes were relaunched against the intended Registry, and all five paths were rerun successfully. The accidental host-home Registry was removed during cleanup.

### L3 — duplicate target and worktree reservations

**PASS.** While a dispatch occupied a target and held its write lease:

- a second reservation for the terminal failed with `target-occupied`;
- a write reservation for another terminal in the same canonical worktree failed with `worktree-leased`.

The owning dispatch IDs were preserved in both conflicts.

### L4 — Origin loss during `delivering`

**PASS.** Two durable `delivering` records were created, then the exact Origin Pi process was closed and resumed with the same session:

- where a bounded delivery echo existed, recovery advanced the record to `active` and retained occupancy;
- where no echo was detectable, recovery left the record `delivering`, added `delivery-unverified` with `catch-up-no-echo`, and retained occupancy.

Neither branch resent input automatically.

### L5 — target completion while Origin is closed

**PASS.** The Origin Pi process was closed before the target completed. The target printed its valid result while the Origin was absent. Resuming the exact Origin Session performed a 200-line bounded catch-up read and settled the record `done` from the retained tail.

### L6 — blocked runtime, confirmed reply, and valid result

**PASS.** A real Herdr `blocked` status event added `blocked-runtime` with a bounded 50-line capture. `/herdr-dispatch-reply` then opened its editor and Approve/Cancel confirmation. The confirmation title contained the focused-input warning:

> Focused-input warning: this text is sent to whatever prompt or dialog currently owns the target pane. It may be consumed as dialog keystrokes; there is no compare-and-send primitive.

Approval produced one `reply-request-verified` audit event. A subsequent valid result settled the original dispatch `done`.

### L7 — operational attention and cancellation

**PASS.** Live records exercised:

- `overdue` after the confirmed deadline;
- `result-missing` when an idle-like target had no valid matching result;
- a confirmed normal cancellation request, which settled `cancelled`;
- explicit guidance that cancellation is advisory and never automates `Ctrl+C`;
- `target-lost` after pane close and after terminal identity changed on Herdr restart;
- a same-pane tab move, which retained the valid route without false invalidation;
- two consecutive five-second cwd samples after the same terminal moved from the repository to `/tmp`, adding `target-moved` while retaining its reservation.

### L8 — Herdr restart and protocol mismatch

**PASS.** Restarting the disposable named Herdr server changed the stored target terminal ID. A record keyed by the old identity received `target-lost`; no pane-ID/cwd/Agent-label heuristic retargeting occurred.

A temporary protocol-17 socket then returned a future protocol snapshot. The adapter raised `HerdrProtocolError` (`protocol 16 is required`) before any `pane.send_input` call. The temporary socket and directory were removed.

Live testing also found and fixed one Herdr event nuance: a move event that retains the same pane ID (for example, a move to another tab) must not invalidate that unchanged route.

### L9 — no autonomous result turn and no fork claim

**PASS.** Reload queued a settled result with `deliverAs: "nextTurn"` and `triggerTurn: false`. After five seconds the Origin remained `idle`, the `agent_start` count was unchanged, and the context delivery remained durably claimed for the active branch.

A real `pi --fork` process opened the Origin's session history under a distinct session ID. It did not claim the Origin's pending result, and no context-delivery row was created by the fork.

### L10 — sanitized context and explicit untrusted inspection

**PASS.** A stored raw result contained a unique secret and an instruction-like field, while its sanitized result contained only the accepted ID, outcome, and summary. The Origin session contained result wrappers but zero occurrences of the raw secret. Explicit `/herdr-agent-output` inspection displayed the bounded tail inside `BEGIN_HERDR_AGENT_OUTPUT_UNTRUSTED` / `END_HERDR_AGENT_OUTPUT_UNTRUSTED` framing.

### L11 — natural-language and raw-CLI bypass attempts

**PASS.** In a real model turn, asking Pi naturally to use Herdr caused it to call `herdr_agents_list` and `herdr_dispatch_propose`. The typed tool now sends automatically without Approve/Edit/Cancel or authorization setup. A post-migration probe verified this no-prompt behavior end to end. An adversarial natural-language request to bypass the typed path with raw `herdr pane run` was still refused without a tool call.

Direct `!` and `!!` attempts then verified that:

- raw `pane run` tasking was denied and the marker never reached the target;
- repeated foreign-pane reads were denied and redirected to scoped inspection;
- `herdr api snapshot` was denied and redirected to `herdr_agents_list`;
- an explicit current-pane read remained allowed and its output was wrapped in `<untrusted-herdr-cli-output>`.

### L12 — Registry failure preserves reservations

**PASS.** In a temporary real SQLite Registry, an active write dispatch held both Target Occupancy and a Worktree Write Lease. A SQLite trigger injected a structural failure halfway through settlement. The settlement transaction rolled back completely:

- lifecycle remained `delivering`;
- no result row existed;
- one target occupancy and one write lease remained;
- the process-local mutation fuse changed to disabled;
- a later mutation failed with `RegistryUnavailableError`.

The temporary database, WAL, and SHM files were removed.

## Additional worktree audit

A live non-mutating dispatch settled while a known write lease overlapped and the disposable tracked file changed. Its after-snapshot recorded:

- `conclusion: "inconclusive-overlapping-writer"`;
- `changedEntries: [" M shared.txt"]`;
- a bounded diff stat;
- `attribution: "not-attributed-to-target"`.

The file was restored and the disposable repository ended clean.

## Live findings fixed before final verification

1. **Narrow Pi TUI hard-wrapping:** Pi can render the result prefix and JSON across multiple terminal rows. Result scanning now reconstructs at most eight adjacent unfenced rows before strict schema/source validation; it does not accept an unbounded multiline result.
2. **Idle/done equivalence:** final target revalidation now treats `idle` and `done` as equivalent idle-like states while still checking identity, workspace, cwd, Agent label, and provenance.
3. **Same-pane tab moves:** Herdr can emit `pane_moved` with identical previous/current pane IDs. The adapter no longer treats that unchanged route as invalid, while genuinely changed pane IDs remain invalidated.
4. **Delayed Codex Result rendering:** the first output match is the dispatched prompt's correlation ID, while Codex may render its hard-wrapped result several seconds later without another useful match event. The monitor now performs bounded re-reads through the startup window, ignores the exact outbound contract template, and defers `malformed-result` until the final read.
5. **Stale and misleading widget counts:** the widget factory captured counts when `setWidget` ran, and it counted every Active Dispatch as `running` plus every Attention Condition separately. The widget now reads the Registry on every render, counts only clean Active Dispatches as `running`, and counts affected dispatches under attention. One stopped Grok record with three conditions therefore renders `0 running · 1 attention`, matching the Manager grouping.
6. **Grok timestamp decoration:** Grok renders a right-aligned timestamp after a bare `DISPATCH_RESULT` prefix and hard-wraps the following JSON key. The scanner now strips decoration from prefix-only rows before bounded reconstruction.

Each finding has a deterministic regression test.

## Cleanup

After evidence was captured:

- all unsettled acceptance records were explicitly settled or left only in the disposable Registry;
- all disposable panes/workspaces were closed by deleting the named session;
- the named Herdr server/session configuration was stopped and deleted;
- the disposable Git repository, home, Registry, protocol socket, session probes, and evidence directory were removed;
- acceptance-created Pi session files were removed;
- the accidental host-home Registry from the rejected harness trial was removed;
- the isolated local package installation had already been removed.

No package was published, and the package version/private flags were unchanged.

---

# Auto Run (Phase 8 / ADR 0014 / L14) — partial live verification

Date: 2026-07-17. Pi `0.80.7`, extension loaded from source, target `codex`.

The load-bearing L14 concern was the **ghost-wake** risk: a triggered wake whose context-delivery claim never completes, re-firing on every settlement. A clean isolated run (a dedicated Origin Pi driven only by the tester, plus a `codex` target) settles this.

**Core wake path — PASS.** Dispatch `hd_mrobpuay_QnoC90Jado9C7K3w` (depth 0) was dispatched from an armed Origin session (`019f6dea…`, armed before settlement), settled `done`, and produced exactly one Auto Run turn. Session-file evidence:

- entry 7 — `custom_message` (`pi-herdr-dispatch-result`) whose content begins `[HERDR AUTO RUN] This turn was triggered automatically by a dispatch settlement; …`, proving the preamble plus untrusted result reached the model context (the human transcript shows only the result card because of the custom renderer, so the preamble is not visible there).
- entry 8 — an `assistant` message whose `parentId` is entry 7's id, i.e. a model turn ran **on** the wake message (~2.1s later), summarized the trivial result, and ended without a follow-up dispatch (correct per the preamble).

**No ghost-wake, exactly-once holds.** `context_delivery_claims.delivered_at` was set once (`1784255610298`) and stable; over an 18s watch the session file stayed at 9 entries (no re-fire), no `auto_run_depth > 0` dispatch was created, and the Origin returned to idle. The catastrophic "claim never completes → infinite re-wake" mode did not occur.

**Also verified live:** arm/disarm with the `⚡自动` widget segment; stale-target rejection (a dispatch to a closed target's terminal was refused as "not an Eligible Agent"); dispatch delivery, echo, and Result-Envelope settlement across a real `codex` TUI (matched via the startup-window re-reads even when the target soft-wrapped the correlation ID on a narrow pane); **settle-while-disarmed** (a result settling while disarmed queued quietly, no wake); and **settle-then-arm gating** (a result that settled before arming did not retro-ignite when the switch was later turned on — `settledAt < armedAt`).

**Still open for full L14 sign-off** (lower risk than the ghost-wake blocker, not exercised here): multi-hop depth-limit termination (settle → wake → follow-up dispatch → settle → depth-exhausted quiet + review notification); off-mid-flight (a turn already running, `/hd-auto off` holding the rest); and resume restoring the armed switch with its notification. Run these per [L14-auto-run-runbook.md](./L14-auto-run-runbook.md) before relying on Auto Run for real unattended work.

## Auto Run — remaining L14 cases (2026-07-17)

The three cases left open after the core-wake verification were run the same day; all pass. Auto Run's L14 is now complete.

**Depth-limit termination — PASS.** With `maxAutoRunDepth: 1`, an armed Origin (`019f6dfc…`) was given a two-step plan in its initial user turn. Step 1 (`hd_mrocehse…`, `auto_run_depth 0`) settled and woke the Origin; the wake turn dispatched step 2 (`hd_mrocerx0…`, **`auto_run_depth 1`** — parent 0 + 1, proving depth attribution end-to-end). Step 2 settled at the limit (depth 1 ≥ max 1): it did **not** wake — its claim `delivered_at` stayed null (quiet queue), no `auto_run_depth 2` dispatch was created, and the Origin returned to `done`, not looping. The wake turn's own text confirmed the budget arithmetic reached the model: “步骤 2 已派发。自动续跑额度已用完，本次不会自动等待其结果。” The chain provably terminated at depth 1.

**Resume visibility — PASS.** Reloading the armed Origin kept the same session id (`019f6dfc…`) and restored the `⚡自动` widget segment, confirming the switch persists across `/reload` (the resume notification is emitted by the same `notifyAutoRunArmedOnStart` path; the widget restoration is the observable signal).

**Off mid-flight — PASS.** A depth-0 task was dispatched from the armed Origin, then `/hd-auto off` was issued ~3s later, before the target settled. The dispatch (`hd_mrockn4g…`) settled *after* disarm (`settled_at` > disarm time); it did **not** wake — its claim `delivered_at` stayed null (quiet queue), no chain formed, the widget dropped `⚡自动`, and the Origin stayed idle. Disarm reliably stops new ignition. (The narrower "a result held while a turn is running is dropped after off" timing is covered by the `AutoRunCoordinator` unit tests.)

**Overall (single-settlement cases):** the sequential L14 cases pass. The feared ghost-wake loop does not occur, the wake fires exactly once per eligible settlement, depth attribution and the depth limit provably terminate a chain, settle-then-arm and off both suppress ignition correctly, and arm/disarm/resume visibility all work against a real Pi + codex.

## Auto Run — burst serialization gap (found live 2026-07-17)

A follow-up live test of concurrent settlements exposed a real runtime bug not covered by the sequential unit tests. An armed Origin (`019f6e10…`) dispatched two independent tasks in one turn to two `codex` targets; both settled ~3.7s apart (`hd_mrod6gt6` "A" then `hd_mrod6jwu` "B", both depth 0).

- **A** settled first and woke the Origin: session `.jsonl` shows one `[HERDR AUTO RUN]` message for A, the model checked `herdr_dispatch_status`, saw "No unsettled dispatches", and noted it had only A's result. A's claim `delivered_at` completed.
- **B** settled while A's wake turn was running and was correctly held (no concurrent second turn — the "at most one in flight" invariant held). **But after A's wake turn ended, B was never re-woken.** B stayed `pending`/undelivered for 40s+; even the 5s armed poll did not release it. A trivial user turn ("hi") then flushed B via the quiet `nextTurn` path (`delivered_at` set), proving B was stranded, not lost.

**Impact:** a burst of ≥2 near-simultaneous settlements delivers only the first as an auto-wake turn; the remaining results strand until the next user turn delivers them quietly. B is not lost and there is no runaway, so this is a functional gap, not a safety failure.

**Hypothesis:** the runtime fires `deliverPendingContext` from several async, fire-and-forget paths (per-settlement `onSettled`, the armed poll, and `agent_settled`→`noteRunSettled`). These interleave and race on the coordinator's single-in-flight state (`turnActive`/`wakeDepth`), leaving a held result never released. The `AutoRunCoordinator` unit tests call it sequentially and so do not hit this race. A fix must serialize the delivery entry point (or make the coordinator state safe under concurrent calls) and be re-verified live.

**Status correction:** the single-settlement L14 cases pass (core wake, two-hop depth chain, resume, off, settle-then-arm). The concurrent-burst serialization does **not** yet pass. Auto Run should not be treated as fully accepted until the burst gap is fixed and re-verified.

## Auto Run — burst serialization FIXED and re-verified live (2026-07-17)

The concurrent-burst gap above was fixed and re-tested live. Root cause: the coordinator tracked "a turn is running" with a manually-set `turnActive` flag, which could stick under the runtime's concurrent, fire-and-forget `deliverPendingContext` calls (per-settlement `onSettled`, the armed poll, `agent_settled`), leaving a held burst result stranded. The fix replaces that flag with two signals that cannot get stuck — the live `ctx.isIdle()` state and a short auto-expiring start-gap grace window — and serializes `deliverPendingContext` through an async queue.

Re-test: an armed Origin (`019f6e23…`) dispatched two independent tasks in one turn to two `codex` targets; both settled ~4.4s apart (`hd_mrodw104` A, `hd_mrodw4vf` B, both depth 0). Result:

- **Both** results now get their own auto-run turn. The session `.jsonl` contains **two** `[HERDR AUTO RUN]` custom messages (entries 9 and 13), each followed by an assistant turn.
- The two wakes are **serialized**: B's claim (`1784259281022`) is ~13.5s after A's delivery (`1784259267525`) — never two concurrent turns. Both `delivered_at` are set (neither stranded), no `auto_run_depth > 0` chain formed, and the Origin returned to idle.

**Status: Auto Run passes L14.** The single-settlement cases (core wake, depth-limit termination, resume, off, settle-then-arm) and the concurrent-burst serialization all pass live against a real Pi + codex, with the ghost-wake loop refuted throughout.

## Auto Run — burst fix hardened after review (2026-07-17)

A follow-up code review of the burst fix found that the first version relied on a phantom wake bracket: `context-delivery.deliver` returns `delivered` both when it sends a wake (a turn starts) and when it only completes an already-present branch entry's durable claim (no turn), and the coordinator treated both as a started turn. That left the next burst result held until the 5s grace expired (the source of the earlier ~13.5s gap) and mis-attributed depth to a following user turn.

Fix: `deliver` now reports `startedWake` (whether it actually sent a wake message this call); the coordinator opens the wake bracket only on a real new turn, and a self-heal clears a stale depth when the model is idle with no wake mid-dispatch.

Re-verified live: a two-dispatch burst (`hd_mrofq4xq` A, `hd_mrofq86m` B) now produces two `[HERDR AUTO RUN]` turns serialized with B's claim only **~4.4s** after A's delivery (down from ~13.5s), both delivered, no re-fire, Origin idle. A post-burst user-turn dispatch (`hd_mrofsbd5`) recorded `auto_run_depth 0`, confirming no stale depth.

**Residual (documented, not a live failure):** the start-gap grace is a 5s timeout, not a proof that the prior wake started; if a wake's turn ever took longer than the grace to begin streaming, a second wake could fire. Real Pi turns start sub-second, so this was never observed, but a start-confirmation handshake (rather than a timeout) would be the fully rigorous form.

## L15 — Task Worktree isolation verified live (2026-07-17)

ADR 0015 acceptance against a real Pi 0.80.9 Origin + Herdr 0.7.4, driven in a dedicated
workspace with `codex`, `claude`, and `amp` targets. `bash scripts/verify.sh live` (the
adapter contract suite) passed first.

**Launch into a Task Worktree — PASS (via amp).** `/hd-create` (write mode) showed the
placement step defaulting to 新任务 worktree with the dependency-friction copy, created
`../pi-packages.worktrees/<slug>` on `task/<slug>` at the Origin's HEAD before any pane
existed, launched the Agent with the worktree as its pane cwd, delivered the dispatch
with a verified echo, and settled it (`hd_mrol0670…`, `worktree_path` = the Task
Worktree; the task's file landed inside the worktree only). A slug collision produced
the documented `-2` suffix live.

**Fail-closed and retention disclosure — PASS.** Two launch failures (see findings
below) each retained the created resources and disclosed them precisely — the first
(pre-pane failure) named only the retained Task Worktree, the later ones named pane,
tab, and Task Worktree. No dispatch, lease, or occupancy was left behind in either case.

**Parallel write leases — PASS.** Two write dispatches to Agents in two distinct Task
Worktrees were active simultaneously with two `worktree_write_leases` rows on distinct
paths (`hd_mrol2127…` on `…cont-2`, `hd_mrol30mu…` on the amp worktree) — the isolation
that the shared-worktree lease serialized before. The occupied target correctly vanished
from the eligible list while its dispatch ran.

**Second dispatch into the same Task Worktree — PASS.** Repeat `/hd-new` write
dispatches to Agents seated in Task Worktrees passed silently (no shared-worktree hint),
re-acquired the lease on the same worktree, and settled normally.

**`/hd-clean` — PASS.** One listing showed all four classifications at once: 分支未合并
(a committed task branch), 任务 worktree 有未提交变更, the compound 有未提交变更、仍有
未结算派发占用 (while a dispatch was live on that worktree), and 可清理. Confirming the
removable entry removed the worktree via non-force `git worktree remove` plus
`git branch -d` and left every refused entry untouched.

**Manual resolution of a stuck dispatch — PASS.** `/hd-resolve` on the unacknowledged
dispatch (finding 3 below) walked picker → detail → outcome (never `done`) → bounded
summary → single confirm, settled it as cancelled, and released occupancy and lease
atomically (0 unsettled / 0 leases / 0 occupancy afterwards).

### Findings

1. **Fixed during acceptance:** `/hd-create` failed for any task longer than the label
   cap — pi-tui 0.80.10's `truncateToWidth` wraps its ellipsis in ANSI resets and ESC is
   rejected by the adapter's label validation. Pre-existing since the dependency bump,
   caught by the first live launch, fixed (`fix(dispatch): build the launch label
   without ANSI escapes`) and re-verified live.
2. **Environment regression (open):** on Herdr 0.7.4 the snapshot's
   `screen_detection_skipped` is no longer `true` for `claude`/`codex`/`opencode` panes
   even with current integrations (only `pi` panes carry it), so `/hd-create` for those
   types waits for reported provenance that never comes and times out after
   `agentStartupTimeoutMs`. `/hd-new` dispatch is unaffected (screen-detected provenance
   is accepted), and `amp`/`droid`/`grok` launches are unaffected. Needs a compat
   decision (adapt the eligibility signal or pin Herdr 0.7.3).
3. **Settlement edge downstream of finding 2:** a target that stays silent past the
   startup window (task began with `sleep 45`) collected `unacknowledged`, and its
   later-printed result envelope was never detected — with no integration report and no
   screen transition, nothing triggers a result read; the dispatch sat active until
   manual resolution. With working integrations the status transition would trigger
   detection. Documented recovery (`/hd-resolve`) works.
4. **UX residual:** the `/hd-new` shared-worktree hint fires (parameterized unit test
   covers both match and no-match) but renders as a transient info toast that the
   delivery-result notification replaces within ~1s, making it effectively invisible
   live. Consider a persistent presentation if the hint is meant to be read.
5. **Observation:** `/hd-clean` removability (merged + clean + no unsettled dispatch)
   does not consider an Agent pane still seated in the worktree; removing the directory
   under an idle Agent is possible. Matches the ADR rule as written; noted for a future
   decision.

## L16 — Task Board verified live (2026-07-17)

ADR 0016 acceptance against a real Pi 0.80.9 Origin + Herdr 0.7.4 in a dedicated
workspace with two `codex` targets — one in the shared repo worktree, one seated in a
manually created Task Worktree (`…worktrees/l16-board`). `bash scripts/verify.sh live`
passed first. All seven checklist items passed.

**Model drafting, user promotion — PASS.** A user turn drafted four bounded tasks via
`herdr_task_draft` (all `draft`, `created_by = model`); a later Auto Run wake turn
drafted a fifth (`docs索引页`) from a settled result's "后续建议" hint. No draft ever
dispatched. Batch approval in the Manager exercised every key: `space` toggled one row,
`A` inverted, `a` selected the group, `Enter` promoted all four with FIFO
`queue_position` 1–4 and per-task `task_approved` audit events.

**Quota-2 arming over the queue — PASS.** `/hd-auto on` with `defaultRunQuota: 2`
armed showing `⚡自动 · 深度上限 5 · 本次额度 2`. The kickoff dispatch consumed unit 1;
the first wake turn dispatched the next task (unit 2, "运行额度现为 0"); the following
two wake turns each declined further board dispatches ("额度已用完…任务保留在队列"),
ending their turns quietly with tasks 3 and 4 still `queued` and `run_quota_used = 2`.
The exhaustion toast itself is transient and was not screen-captured (known toast
limitation); the notify-once path is unit-tested.

**Depth attribution — PASS.** All four task-bound dispatches recorded
`auto_run_depth = 0` (including two created inside wake turns), while the in-chain
verification follow-up to the same target recorded depth 1 — the exact split ADR 0016
decision 5 requires.

**Armed-only quota (post-review amendment) — PASS.** After `/hd-auto off` (session row
deleted, `⚡` segment gone, no-arg report correctly omitting any quota figure), a
task-bound write dispatch in a user turn succeeded with no `auto_run_sessions` row
created and nothing consumed, and its settlement stayed in the quiet queue.

**Return with feedback — PASS.** The settled write task (`L16-NOTE.md` created in the
Task Worktree) was returned via `x` + the feedback editor. The task requeued at
position 5 with `return_feedback` stored and `preferred_worktree_path` automatically
set from the previous dispatch. Redispatch bound the same task to the same Task
Worktree target, embedded the framed "Previous attempt was returned by the user" block
in the outbound text, cleared `return_feedback` on bind, and the rework applied the
feedback (file updated to two lines).

**Acceptance is bookkeeping — PASS.** Batch-accepting the three reviewed tasks changed
only task state: the Task Worktree, its branch, the file (same md5), and every
`result_seen_at` (all NULL) were untouched; the widget kept `✓ 5 已完成` unseen while
the `待验收` segment cleared.

**Bypass denied — PASS.** Both a `!` user-bash `sqlite3 …registry.sqlite UPDATE` and a
model bash-tool attempt to promote a draft were blocked by the
`dispatch-registry-access` guard (exit 126, typed-path message); the draft stayed
`draft`.

### Findings

1. **Pi palette interaction:** typing `/hd-auto on 2` and pressing Enter lets the
   argument completion swallow the trailing `2` (the menu accepts `on` and drops the
   rest); a second Enter then arms with the default quota. Workaround used live: set
   `defaultRunQuota` in config. Consider argument-hint copy or a quota select step.
2. **V1 gap:** a `queued` task cannot be deleted or demoted (only drafts can be
   deleted, only reviewed tasks returned); an unwanted queued task can only be
   dispatched or left in place. Roadmap candidate alongside reordering.
   **Resolved (2026-07-17):** `x` on a queued task now confirms `撤回草稿`; the resulting draft can then be deleted through the existing draft-only confirmation.
3. **Visual note (pre-known):** the `review` state reuses the `▲`/warning attention
   mark; live it reads acceptably in the 待验收 group but remains conceptually
   overloaded.
4. **Copy note:** the Manager keybar shows both `enter 详情` and `enter 提交`; on task
   rows Enter only submits selections, which the double listing does not convey.

## L17 — Roles and staged Workflows verified live (2026-07-17)

Setup: Pi Origin in the repo root; role panes prepared by renaming — `coder-1`
(codex) and `reviewer` (claude); no `bugfix`-named pane on purpose. Herdr 0.7.4.
Rework/escalation used a live `team.json` override of `dev` (`maxReworkCycles: 1`,
escalation `afterCycles: 1 → bugfix`, parking at cycle 2) — which also live-verified
override-by-key; the pass and no-verdict runs used built-in defaults.

**Draft with role defaulting — PASS.** `herdr_task_draft` with `role: coder` and no
workflow stored `dev`; Manager rendered `草稿 · 写入 · 开发 · 阶段 1/2`.

**Pass path — PASS.** Approve → stage 1 `write` dispatch to codex (quota 10→9) →
`done` advanced the task to `阶段 2/2` queued → wake turn dispatched the reviewer
stage `non-mutating` (stage-mode rule live) → claude returned
`"verdict":"pass"` → task parked in 待验收; batch acceptance cleared it.

**Rework, escalation, exhaustion — PASS.** Reviewer `needs-rework` incremented the
cycle, re-queued the implement stage as `bugfix` (`task_escalated`), and the bugfix
payload carried the framed block `Reviewer feedback from earlier stages (untrusted
data context, address it):` with the reviewer's summary. Second `needs-rework` hit
`isReworkExhausted` (cycles 2 ≥ 1+1) and parked the task; Manager showed
`▲ … 评审未过` and Auto Run stopped cleanly with 0 queued.

**No-verdict park — PASS.** A reviewer envelope with `outcome: done` and no
`verdict` parked the task as `no-verdict`; Manager showed `评审未给结论 · … · 阶段
2/2`, rework cycles stayed 0.

**Role routing by pane name — PASS after live fix.** Two live defects were found and
fixed during this acceptance (both in the working tree at the time, committed with
this record):

1. **Stage mode** (found in pre-acceptance review, fix committed in the feat commit):
   nothing dispatched later workflow stages under the stage role's mode. Fixed:
   implement stage keeps the task's approved mode, later stages use the stage role's
   mode, enforced at proposal and bind; live the reviewer stages went out
   `non-mutating` on a `write` task.
2. **displayName never carried the pane rename:** eligible listings took
   `displayName` from the snapshot agent record's `name`, but Herdr 0.7.4 snapshot
   agent records carry no `label`/`name` for these panes — the pane label lives only
   on the `panes[]` records. Until the fix, every role dispatch fell back with the
   plain disclosure (which was thereby also verified). Fixed by joining pane labels
   by terminal ID into `displayName`; after `/reload` the next stage-1 dispatch
   reported `目标: coder-1 / codex` with no fallback disclosure, and the missing
   `bugfix` pane still produced the correct fallback line.

### Findings

1. **Reviewer permission prompts:** the claude reviewer pane blocked on a bash
   read-permission prompt in every review stage; a human approved each live. For real
   unattended nights the reviewer pane needs a permission mode that can read the
   worktree unprompted — pane setup guidance, not extension behavior.
2. **Copy note:** settled dispatch rows in the Manager preview now start with
   `Role: You are acting …` because the role brief is prepended to the immutable
   task text; consider previewing from the approved task text instead.

## L18 — Model-initiated read-only launch verified live (2026-07-17)

Setup: Pi Origin in the repo root; existing role panes `reviewer` (claude) and
`codex: ADR 0018 impl`; `defaultLaunchBudget: 1` via a temporary `config.json`
(removed after). Herdr 0.7.4.

**Disarmed refusal — PASS.** With Auto Run off, `herdr_agent_launch_readonly`
(reviewer/claude) refused: `Auto Run is disarmed; daytime capacity is the user's
/hd-create decision.`

**Write-role refusal — PASS.** Armed, `role: coder` refused: `Role coder is
write-role capacity and cannot be model-launched`.

**Reuse-first — PASS.** `role: reviewer` refused naming the idle user pane:
`Eligible Agent pane reviewer already matches role reviewer; dispatch to it
instead`.

**Budgeted launch — PASS.** `role: researcher, agentType: claude` created pane
`researcher-auto-1` at the Origin cwd (adaptive split, no worktree), returned
`statusProvenance: reported` (ADR 0019 agent-session evidence on a freshly
launched claude) and `Launch Budget remaining: 0`.

**Exhaustion — PASS.** The next launch (advisor) refused: `Launch Budget is
exhausted; the task must remain queued until the user rearms capacity.`

**Report and reset — PASS.** `/hd-auto` showed `本次额度剩余 10 · 创建额度剩余 0`;
`/hd-auto off` + `on` reset the budget.

**Retention and next-night reuse — PASS.** `researcher-auto-1` was retained
across disarm/rearm, and a rearmed `role: researcher` launch was refused
reuse-first naming `researcher-auto-1` — the retained pane became the reuse
pool exactly as designed.

### Findings

1. The claude reviewer/researcher panes ran in auto mode (user set it after L17
   finding 1), so no permission prompts blocked any stage this round.
