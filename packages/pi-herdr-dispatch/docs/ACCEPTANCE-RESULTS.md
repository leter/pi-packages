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

**Overall:** Auto Run passes L14. The feared ghost-wake loop does not occur, the wake fires exactly once per eligible settlement, depth attribution and the depth limit provably terminate a chain, settle-then-arm and off both suppress ignition correctly, and arm/disarm/resume visibility all work against a real Pi + codex.
