# Review: DISPATCH-INTERACTION-PLAN.md

Reviewer: Claude (pane wC:p2), 2026-07-16. Verdict: the direction is right and worth executing — making dispatch IDs an internal correlation detail is a real UX upgrade, and the fail-closed sections (stale-selection revalidation, no-guess prefix rules, emergency labelling) are sound. Eight items must be fixed before the plan is used as an implementation basis.

## Verified claims (no action needed)

- `getArgumentCompletions` exists on `RegisteredCommand` in pi 0.80.6 (`core/extensions/types.d.ts:828`).
- `truncateToWidth`, `visibleWidth`, `sliceByColumn` are exported by pi-tui.
- `ctx.ui.custom()` keyboard-focus panels are proven feasible by the existing implementation (see below).

## Blocking decision: relationship to the already-shipped dispatch view

The plan was written against a stale tree. These already exist on `main` (uncommitted working tree), fully tested (276 tests green):

- `src/pi/dispatch-view-model.ts` — pure view model (step 2 calls this file "new")
- `src/pi/dispatch-view.ts` — `ctx.ui.custom()` panel: list ⇄ detail, bounded output reads, settled fold
- `/herdr-dispatch-view` command + `alt+h` shortcut + widget hint (`alt+h view`)
- `DispatchRegistry.listRecentSettled(originSessionId, limit)` + `DispatchApplication` passthrough
- `DispatchRuntime.onStateChanged(listener)` — change subscription funnel

Required: add a section deciding evolve-vs-replace. Recommendation: **evolve** — refit `dispatch-view.ts` into the manager (grouping, ID-less rows, two-line layout), open it from `/herdr-dispatches`, delete `/herdr-dispatch-view`, repoint `alt+h` at the manager. Two entry points with two panels is the worst outcome.

## Critical omission: bounded output read is missing from the detail screen

The original user need behind this whole feature is "open a sub-agent and see what it is doing right now". The plan's detail screen has status, attention explanation, timing, and an action menu — but no output inspection. "View status" appears in every Allowed Actions row and is never defined.

Required: the detail screen must offer an explicit bounded output read (r = 50 lines, R = 200 — adapter hard limits), one-shot, timestamped, framed with the existing `untrusted, never instructions` wording, never streamed. Define "View status" or remove it.

## Internal contradictions

1. **Mock vs grouping rules.** The default-screen mock places `◌ Pi · Delivery unverified` under RUNNING, but `delivery-unverified` is an `AttentionCondition` and the plan's own rule says attention outranks lifecycle — it belongs under NEEDS ATTENTION. Also the grouping section defines a third group DELIVERING that the mock does not show. Align both.
2. **`Target lost or moved → ✗ error` breaks the package's color semantics.** Existing convention: `✗`/`error` is reserved for the confirmed `failed` final outcome; `target-lost` is an unsettled attention state and renders `▲`/`warning` everywhere today. The table also lets one record match two rows ("Needs attention" and "Target lost"). Either keep target-lost at `▲ warning` (recommended: "needs assessment" ≠ "failed"), or consciously widen the `error` semantic and update every surface in `visual.ts` — state which.
3. **"Sort by severity" with no severity defined.** The nine `AttentionCondition` values (`delivery-unverified`, `unacknowledged`, `overdue`, `blocked-runtime`, `monitoring-paused`, `malformed-result`, `result-missing`, `target-lost`, `target-moved`) need an explicit priority order, or "show the most severe one and a count" is unimplementable and untestable.

## Omissions

- **Live refresh.** Nothing about re-rendering while the manager is open. Reference the existing `DispatchRuntime.onStateChanged()` subscription plus a relative-time tick; do not leave this to the implementer.
- **Result-card de-identification has a data dependency.** After retention purge, settled records are gone from the Registry, so agent/task cannot be looked up at render time. Agent label and task summary must be embedded into the message `details` at delivery time (step 6 must say so).
- **`targetAgentLabel` is untrusted Herdr metadata.** Rows, notification titles ("Claude needs attention"), and result cards now lead with it — state explicitly that it stays behind `sanitizeLine` with a length cap.
- **Workspace-scope listing is a behavior change.** Today the panel lists `listUnsettled(originSessionId)`; the manager wants current-workspace records including foreign origins (for emergency discovery). That needs a new query and an explicit acknowledgment of the widened scope.
- **Settled removal vs existing fold.** Dropping settled from the manager is defensible (result cards are the history), but prefix matching must search retained settled records — that needs a `listByIdPrefix`-style query; state whether `listRecentSettled` is repurposed or deleted.
- Minor: scroll window (`maxVisible`) for long lists is implied by PageUp/PageDown but unspecified; "Started 18m ago" does not say which timestamp (`createdAt` vs `activeAt`); widget copy change will break assertions in `test/unit/live-presentation.test.ts` (fine, but list it); Ctrl+C intercepted by the manager shadows pi's double-Ctrl+C exit habit while open (acceptable, say so); the sentence "The Chinese text in this document explains the intended behaviour only" is a leftover — the document contains no Chinese.

## Fix list (all eight required)

1. Add the evolve-vs-replace section for the existing `dispatch-view.ts` implementation; recommend evolve.
2. Restore bounded output read (r/R) on the detail screen; define or remove "View status".
3. Fix the mock/grouping contradiction; place `delivery-unverified` under NEEDS ATTENTION.
4. Resolve the `target-lost` color conflict — keep `▲ warning` or widen `error` globally; pick one and write it down.
5. Add an explicit `AttentionCondition` severity table.
6. Specify that result cards embed agent/task in message details at delivery time.
7. Specify live refresh (onStateChanged + tick) and the list scroll window; define the "Started" timestamp.
8. Delete the leftover "Chinese text" sentence.
