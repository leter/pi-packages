# Dispatch Interaction Plan

## Purpose

Make dispatch IDs an internal correlation detail rather than something users must type, copy, or remember. A user should be able to inspect, reply to, cancel, or manually resolve a dispatch by selecting a human-readable task.

This plan preserves the package's confirmed-dispatch contract:

- every state-changing action remains TUI-only and confirmed;
- no action guesses an ambiguous target;
- delivery ambiguity is never automatically resent;
- current Workspace Scope, Origin Session, Target Occupancy, Worktree Write Lease, and first-wins settlement rules remain authoritative;
- canonical dispatch IDs remain unchanged in the Registry, protocol, audit records, and Result Envelopes.

## Product Direction

The interface is a restrained terminal operations surface: precise, calm, keyboard-first, and status-oriented.

- Use the active Pi theme. Do not hard-code ANSI colors.
- Use color, a glyph, and text together for every state.
- Use compact grouped rows, not cards or a dashboard.
- Prefer Agent name, task summary, problem, and timing over infrastructure identifiers.
- Keep technical data available behind an explicit detail action.
- Treat `targetAgentLabel` as untrusted Herdr metadata wherever it is shown. Pass it through `sanitizeLine` with a surface-specific length cap; do the same for task summaries before they enter a terminal row, notification, or result card.

References for interaction quality: Raycast command selection, Linear status hierarchy, and lazygit's keyboard-oriented terminal workflows.

## User-Facing Contract

### Main entry point

`/herdr-dispatches` becomes the unified interactive Dispatch Manager. It lists current-workspace unsettled dispatches, including records from another Origin Session that may require emergency resolution, and lets the user inspect a task or choose an allowed follow-up action.

This deliberately widens the current `/herdr-dispatches` behavior, which lists only the exact Origin Session. The manager's current-workspace query is read-only discovery; reply and cancellation still require the exact Origin Session, while a foreign-Origin record exposes only the explicitly labelled emergency-resolution path.

### Evolve the existing dispatch view

Do not add a parallel `dispatch-manager.ts` panel. The shipped `src/pi/dispatch-view.ts` and `src/pi/dispatch-view-model.ts` already provide the correct foundation: a `ctx.ui.custom()` list/detail panel, stable-ID selection through refreshes, bounded one-shot output reads, a settled fold, an `onStateChanged()` subscription, and a relative-time refresh tick.

The implementation must evolve those modules into the Dispatch Manager:

- refit their rows into the grouped, ID-less, two-line layout defined here;
- keep the existing list/detail and bounded-output interaction model;
- open the evolved panel from `/herdr-dispatches`;
- remove the duplicate `/herdr-dispatch-view` command;
- retain `alt+h`, but rename and repoint it to the Dispatch Manager;
- update the widget hint from `alt+h view` to the manager wording.

There must be one panel and one interaction vocabulary, not separate read-only and management panels.

### Shortcut commands

These commands remain available, but their ID argument becomes optional:

- `/herdr-dispatch-reply [id-or-prefix]`
- `/herdr-dispatch-cancel [id-or-prefix]`
- `/herdr-dispatch-resolve [id-or-prefix]`

With no argument, each command opens a filtered selection list. This is the ordinary workflow.

With an argument, the command supports exact ID matching and a unique prefix for advanced users. Pi argument completion supplies canonical full IDs. IDs remain an optional escape hatch, never the primary interaction.

## Dispatch Manager

### Default screen

```text
Herdr Dispatches             1 running · 1 delivering · 2 need attention

NEEDS ATTENTION

> ▲ Claude   Fix login state loss
    Target lost · 8m overdue

  ▲ Pi       Investigate build failure
    Delivery unverified · just now

RUNNING

  ● Codex    Check database migration
    Working · 12m remaining

DELIVERING

  ◌ OpenCode Prepare release notes
    Sending task · just now

↑↓ Navigate   Enter Open   Esc Close
```

The default list intentionally excludes Dispatch ID, terminal ID, pane ID, workspace ID, session ID, nonce, and full path.

### Row information hierarchy

Each row contains only information needed to decide what to do:

1. state glyph and semantic color;
2. target Agent name;
3. first-line task summary;
4. highest-priority attention reason, if any;
5. relative deadline or age.

When several attention conditions coexist, show the most severe one and a count:

```text
Target lost · 2 more conditions
```

Do not assign dynamic row numbers such as `#1`, `latest`, or `last`. Rows change as records settle or appear, so those aliases can safely describe only a stale view.

### Grouping and ordering

The manager groups records in action order:

1. `NEEDS ATTENTION`
2. `RUNNING`
3. `DELIVERING`

Within `NEEDS ATTENTION`, sort by the explicit attention priority table below, then by deadline, then by dispatch ID for a stable final tie-breaker. Within `RUNNING` and `DELIVERING`, sort by deadline, then dispatch ID. Attention conditions always outrank lifecycle presentation: for example, `delivery-unverified` is in `NEEDS ATTENTION`, not `DELIVERING`.

The existing settled fold remains available for a small, current-Origin recent-history view, sourced by `listRecentSettled(originSessionId, limit)`. It stays collapsed by default and is not part of the ordinary action list. It is not reused for ID-prefix resolution: a separate current-workspace retained-record query is required so an exact or prefix lookup can correctly detect both settled and unsettled matches.

## State Vocabulary

Every visual state uses a glyph, a Pi semantic theme color, and a readable label. Color is never the only signal.

| State | Glyph | Theme color | User meaning |
|---|---:|---|---|
| Active | `●` | `accent` | Running normally |
| Delivering | `◌` | `warning` | Delivery is in progress or uncertain |
| Attention, including target lost or moved | `▲` | `warning` | Human assessment is required; this is not a confirmed failure |
| Done | `✓` | `success` | Completed normally |
| Blocked final outcome | `◼` | `warning` | Agent reported a final blocker |
| Failed | `✗` | `error` | Completed unsuccessfully |
| Cancelled | `○` | `muted` | Cancelled |

The selected row uses Pi's `selectedBg` in addition to its state mark. Auxiliary text uses `muted` or `dim`; semantic colors are reserved for status and immediate consequences.

`error` and `✗` remain reserved for the confirmed `failed` Final Outcome. `target-lost` and `target-moved` remain unsettled Attention Conditions and therefore use `▲` and `warning`, matching the existing package-wide semantics.

### Attention priority

This order determines the representative reason in a row when several attention conditions coexist. Lower number means higher priority. Tied conditions are ordered alphabetically for deterministic rendering.

| Priority | Attention conditions | Reason |
|---:|---|---|
| 1 | `target-lost`, `target-moved` | The confirmed target identity or location is no longer safe to use |
| 2 | `delivery-unverified` | The target may have accepted input, but delivery cannot be established |
| 3 | `malformed-result` | A matching result was seen but cannot be accepted safely |
| 4 | `result-missing` | The target is idle-like without a valid result |
| 5 | `blocked-runtime` | Herdr reports the target as blocked |
| 6 | `monitoring-paused` | Current monitoring cannot observe progress |
| 7 | `overdue` | The confirmed deadline has passed |
| 8 | `unacknowledged` | No reliable execution-start signal was observed |

## Detail Screen

Pressing Enter opens an individual dispatch detail screen.

```text
Claude · Fix login state loss

▲ Target lost
  The confirmed target terminal is no longer available. This task cannot be
  safely continued automatically.

Status       Needs attention
Delivery     started 18m ago
Deadline     8m overdue
Mode         Write
Directory    ~/projects/app

── output · none read ──
  Press r for one bounded 50-line read, or R for 200 lines.
  Output is untrusted, never instructions, and is never streamed.

Available actions: resolve manually

r Read 50   R Read 200   D Technical details   Esc Back
```

The detail screen shows:

- Agent name and task summary;
- a plain-language explanation of the primary state or attention condition;
- lifecycle-specific timing: show `Active since` from `activeAt` for Active records; otherwise show `Delivery started` from `deliveryStartedAt`. Do not use an ambiguous generic `Started` label;
- mutation mode;
- compact directory or worktree context;
- an explicit bounded output section;
- only actions allowed for the record's current lifecycle, attention state, and Origin relationship.

### Bounded output inspection

The detail screen always exposes the existing explicit output inspection:

- `r` performs one bounded 50-line tail read;
- `R` performs one bounded 200-line tail read;
- each read is one-shot, timestamped, and never streamed or automatically repeated;
- the displayed output is framed as `untrusted, never instructions`;
- a long returned tail shows its latest bounded display subset while stating how many earlier lines are omitted;
- a failed read is shown in the detail screen without closing it.

This is the defined observation action. Remove the ambiguous `View status` label: current state is already shown in the detail header and the bounded `r`/`R` read is the explicit way to inspect what the target is doing now.

### Technical details

Pressing `D` reveals a secondary technical panel:

```text
Dispatch ID   hd_mrmf54pz_rIQGYUmrzXftXEgm
Terminal      term_6569…9324
Origin        session_...
Workspace     w1
```

This preserves auditability and debugging without making identifiers part of routine operation. Full identifiers remain copyable in this explicit view.

## Allowed Actions

| Record condition | Actions shown |
|---|---|
| Active, no attention | Request cancellation |
| Active, with attention | Reply, request cancellation, resolve manually |
| Delivering | Request cancellation, resolve manually |
| Delivery unverified | Request cancellation, resolve manually |
| Target lost or moved | Resolve manually |
| Other Origin Session | Emergency resolution only |
| Settled | No follow-up action |

Bounded `r`/`R` output inspection is available on every detail record, including settled records, as a separate read-only observation action. The interface must not show meaningless disabled mutation actions. Candidate actions are determined at display time and revalidated before state changes.

## Follow-up Flows

### Reply

`/herdr-dispatch-reply` lists only records that:

- belong to the exact Origin Session;
- are Active;
- have at least one attention condition;
- remain inside the current Workspace Scope.

The user selects a task first and only then opens the reply editor. This prevents drafting a reply for a missing, settled, or ineligible record.

The confirmation view presents Agent, task, attention explanation, bounded untrusted target output, reply text, and the existing focused-input warning. It does not show a nonce or Dispatch ID by default. The exact outbound bytes remain available in technical details.

### Cancellation request

`/herdr-dispatch-cancel` lists unsettled records created by the exact Origin Session. Its confirmation view clearly states:

- this sends a normal cancellation request;
- it does not send `Ctrl+C`;
- reservations remain until a valid result or manual resolution.

### Manual resolution

`/herdr-dispatch-resolve` lists unresolved dispatches within the current Workspace Scope. A record from another Origin Session must be visibly labelled:

```text
▲ Emergency resolution required
```

The existing emergency-attestation confirmation and final reservation-release confirmation remain mandatory. No liveness check is introduced.

## ID Matching And Completion

Arguments are optional and are not the primary UX. When present:

1. an exact canonical ID match wins;
2. otherwise, search both unsettled and retained settled records for a prefix match within current Workspace Scope;
3. zero matches: show a concise no-match message and direct the user to `/herdr-dispatches`;
4. one match: select the canonical record and apply the normal eligibility rules;
5. multiple matches: show a human-readable picker; never choose newest, oldest, or first;
6. a settled exact or unique-prefix match: show its recorded outcome and do not reopen a follow-up flow;
7. a mixed settled/unsettled prefix result is still ambiguous and requires selection.

Pi's `getArgumentCompletions` should return full canonical IDs but label each option with sanitized Agent name, sanitized task summary, lifecycle, and principal attention state. Selecting completion is convenience only; the action still reads and validates the record before delivery or settlement.

## Stale Selection And Fail-Closed Rules

Selecting a dispatch does not reserve its old state. Immediately before an action is confirmed or sent, reread the Registry and verify:

- record remains in current Workspace Scope;
- record is unsettled;
- lifecycle still permits the action;
- attention still permits a reply;
- the initiating session is the exact Origin Session for reply and cancellation;
- emergency resolution remains explicitly marked when the resolver is not the Origin.

If a record settles while open, close the action path and report its recorded outcome. If eligibility changes, explain that it changed and perform no mutation. Existing delivery verification, no-resend, terminal identity, and transactional first-wins settlement mechanisms remain unchanged.

## Live Refresh And Scroll Window

The evolved panel must subscribe to the existing `DispatchRuntime.onStateChanged()` funnel and call `requestRender()` when Registry-backed state changes. It must also retain a 30-second relative-time tick so deadlines and ages do not become stale while the panel is open.

Keep the selected record by canonical ID across refreshes. If it disappears from the current list, retain the nearest row position; if an open record settles, display its final state and remove mutation actions rather than acting on stale assumptions.

The list uses a scroll window of 10 dispatch rows. Group headings and keybars do not count toward that window. Up/Down moves one dispatch; PageUp/PageDown moves 8 dispatches; Home/End jumps to the first/last selectable record. The selected row must always remain within the visible window.

## Notifications, Widget, And Results

Desktop notifications should identify a task by Agent and summary, not a Dispatch ID:

```text
Claude needs attention
Fix login state loss · Target lost
```

The compact widget continues to show only counts:

```text
dispatches  ● 2 running  ·  ▲ 1 needs attention
```

Result cards should lead with Agent and task summary rather than a correlation ID:

```text
✓ Claude completed
  Fix login state loss
  Restored the login state and ran the related tests.
```

Result rendering cannot depend on a later Registry lookup: retention may have purged the settled record before a persisted message is rendered. At context-delivery time, while the dispatch record is still available, embed sanitized and length-capped `targetAgentLabel` and task summary alongside `dispatchId` and outcome in the custom message `details`. Result cards and notifications render those embedded display fields; the canonical ID remains in details for matching and technical disclosure.

An expanded technical section may show the full Dispatch ID. Registry, model-visible data, Result Envelopes, protocol payloads, and audit records continue to retain canonical IDs.

## Keyboard And Responsive Behaviour

### Keys

| Key | Action |
|---|---|
| Up/Down | Move selection |
| PageUp/PageDown | Scroll list |
| Home/End | Jump to first/last record |
| Enter | Open selected item or choose action |
| Escape | Return or close without mutation |
| Ctrl+C | Safely close the current UI without affecting a target Agent |
| D | Toggle technical details |

No one-key destructive action is added. Every cancellation, reply, or resolution retains its existing confirmation path. While the manager owns focus, Ctrl+C intentionally closes the panel and therefore shadows Pi's normal double-Ctrl+C exit habit; this is safe because it cannot signal or mutate a target Agent.

### Width policy

| Terminal width | Layout |
|---|---|
| 80 columns or more | Two-line row; relative time may align right |
| 50–79 columns | Two-line row; time moves into state line |
| Below 50 columns | Agent, task, and state wrap to separate lines |

Use `visibleWidth()` and `truncateToWidth()` for every rendered line. Preserve state labels; truncate task summaries first. Test wide Unicode characters and theme changes. Do not cache themed ANSI strings across a theme refresh.

## Empty And Error States

| Situation | Required message |
|---|---|
| No unsettled dispatches | `No active dispatches. Start one with /herdr-dispatch.` |
| No reply candidates | `No dispatch currently needs a reply.` |
| No cancellation candidates | `No unsettled dispatch from this session.` |
| No resolution candidates | `No dispatch currently requires manual resolution.` |
| Record settled while open | `This dispatch settled while it was open.` |
| Registry unavailable | State that dispatch state cannot be read or changed; never pretend the list is empty |
| No ID match | Direct the user to `/herdr-dispatches` without dumping unrelated IDs |
| Ambiguous prefix | Present the readable selection list |

## Implementation Plan

### 1. Add scoped dispatch and retained-ID queries

Likely files:

- `src/registry/registry.ts`
- `src/dispatch/application.ts`
- `src/pi/dispatch-runtime.ts`

Add a current-workspace unsettled query that includes foreign-Origin records for emergency discovery, plus clear Origin relationship information. Add safe exact/prefix lookup over retained current-workspace records, including settled records. Keep `listRecentSettled(originSessionId, limit)` for the collapsed current-Origin history fold; do not repurpose it as prefix lookup. Do not change the canonical ID format or database schema.

### 2. Evolve the existing pure dispatch presentation model

Likely files:

- `src/pi/visual.ts`
- `src/pi/dispatch-view-model.ts`

Refit the existing model to map `StoredDispatch` plus attention into display-ready data: explicit attention priority, grouping, state mark, concise task summary, sanitized Agent label, attention explanation, lifecycle-specific timing, and technical details. The default model must not expose IDs. Retain its output-read state and result formatting.

### 3. Evolve the existing custom dispatch view into the manager

Likely file:

- `src/pi/dispatch-view.ts`

Evolve the existing `ctx.ui.custom()` component rather than adding another panel. Add grouped ID-less rows, action filtering, technical disclosure, the 10-row scroll window, width-safe rendering, and the defined `r`/`R` output interaction while retaining its state subscription, 30-second tick, and stable selection behavior.

### 4. Wire commands and completion

Likely files:

- `src/pi/commands.ts`
- `src/pi/followup-controller.ts`

Open the evolved manager from `/herdr-dispatches`; delete the redundant `/herdr-dispatch-view` command; repoint `alt+h`; use filtered manager entry points for no-argument reply, cancellation, and resolution; retain exact/prefix matching for supplied arguments; register argument completion; resolve before opening the reply editor; revalidate before every state-changing operation.

### 5. Refine follow-up confirmation views

Likely files:

- `src/pi/followup-controller.ts`
- `src/pi/presentation.ts`

Make Agent, task, current state, risk, and reservation consequences the primary content. Keep full outbound bytes and exact IDs under technical disclosure. Preserve the current focused-input warning and emergency-resolution confirmations.

### 6. Remove IDs from routine human-facing summaries

Likely files:

- `src/pi/live-presentation.ts`
- `src/pi/renderers.ts`
- `src/settlement/context-delivery.ts`

Use sanitized, length-capped Agent/task language in notifications and result cards, while retaining canonical IDs in durable and protocol surfaces. At context delivery, embed the display labels in message details so result rendering survives Registry retention purge.

### 7. Update contract documentation

Likely files:

- `README.md`
- `docs/DESIGN.md`
- `docs/CONTEXT.md`

Document optional command arguments, manager behaviour, exact/prefix ambiguity rules, technical detail disclosure, stale-selection safety, and emergency discovery within Workspace Scope.

## Test Plan

Likely new tests:

- `test/integration/dispatch-command-selection.test.ts`

Likely updated tests:

- `test/unit/visual-presentation.test.ts`
- `test/unit/dispatch-view.test.ts`
- `test/unit/live-presentation.test.ts`
- `test/integration/followup-resolution.test.ts`
- `test/integration/pi-extension-registration.test.ts`

Required coverage:

- zero, one, and multiple selection candidates;
- all nine Attention Conditions' explicit priority, grouping, representative reason, and deterministic tie-breaking;
- exact Origin versus foreign Origin records;
- exact ID, unique prefix, zero match, and ambiguous prefix;
- mixed settled and unsettled prefix matches;
- record settlement or eligibility changes after selection;
- workspace isolation;
- reply eligibility disappearing before confirmation;
- automatic settlement racing manual or emergency resolution;
- live refresh through `onStateChanged`, relative-time ticks, and selection preservation;
- a 10-row scroll window plus Up/Down, PageUp/PageDown, Home/End, Escape, and focused Ctrl+C behavior;
- 40, 60, and 100-column rendering;
- Unicode task summaries and line-width guarantees;
- status colors, glyphs, and selected-row background;
- no default human-facing list, notification, or result card includes `hd_`;
- technical details expose a full canonical ID;
- `r` and `R` perform 50- and 200-line one-shot reads, frame output as untrusted, timestamp it, and never stream it;
- result cards continue to show Agent/task display data after the corresponding Registry row is purged;
- updated widget manager hint and count-copy assertions in `test/unit/live-presentation.test.ts`;
- Escape and Ctrl+C cannot mutate dispatch state;
- non-TUI modes remain read-only.

## Acceptance Criteria

- A user can reply, cancel, or resolve a task without typing or copying a Dispatch ID.
- `/herdr-dispatches` is the unified management entry point.
- Default human-facing UI shows task-relevant information, not infrastructure identifiers.
- Every state is communicated through a glyph, semantic color, and text label.
- Attention records are clearly prioritized above normal running work.
- Every mutation preserves existing confirmation and fail-closed behaviour.
- No prefix ambiguity or stale selection can silently retarget an action.
- Current Workspace Scope is enforced for every manager selection and action.
- Narrow terminals retain all state and navigation information.
- Registry schema, canonical ID generation, Result Envelope matching, and audit semantics remain unchanged.
