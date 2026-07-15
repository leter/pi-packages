# Phase 6 Acceptance Results

Date: 2026-07-15  
Result: **PASS**

## Environment

- Pi `0.80.6`
- Herdr `0.7.3`, protocol `16`
- Node.js `24.18.0`
- Package remained `private` at `0.0.0-development`
- No package was published

The live checklist ran in one named, disposable Herdr session with one disposable Git repository, an isolated home directory, an isolated Dispatch Registry, and existing Pi Agents created only by the acceptance harness. The extension itself did not create Agents, panes, workspaces, worktrees, or coordinators.

## Presentation, packaging, and installation

| Check | Result | Evidence |
|---|---|---|
| Widget placement | PASS | A real Pi TUI showed `dispatches: 0 active · 0 attention` below the editor. Source and unit tests require `placement: "belowEditor"`. |
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

**PASS.** In a real model turn, asking Pi naturally to use Herdr caused it to read the official Herdr skill, call `herdr_agents_list`, and call `herdr_dispatch_propose`. The TUI displayed Approve/Edit/Cancel; selecting Cancel created no dispatch. An adversarial natural-language request to bypass confirmation with raw `herdr pane run` was refused without a tool call.

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
