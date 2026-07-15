# Herdr 0.7.3 compatibility spike

Date: 2026-07-15

## Environment and isolation

- Herdr: `0.7.3`, socket protocol `16`
- Pi runtime environment: Node.js `24.18.0`
- Herdr experimental pane history: enabled
- Test topology: one isolated named Herdr session with temporary workspaces and panes under `/tmp`
- The default Herdr session was not stopped or mutated.

All temporary panes and workspaces were closed after the checks. The named test session was stopped and deleted, its session directory was removed, and the temporary working directory and captured files were deleted. A final `herdr session list --json` showed only the pre-existing default session.

## Summary

| Check | Result | Design consequence |
|---|---|---|
| Terminal ID continuity across server restart | **Not continuous** | Treat the stored terminal as lost; no heuristic retargeting |
| Pane ID after move and closed-ID reuse | **Move changes ID; no reuse observed and official contract confirms non-reuse** | Re-resolve by terminal ID before delivery; never reuse stale routes |
| `recent_unwrapped` depth and `lines` behavior | **Default 80; request cap 1000; larger values silently clamp** | Keep bounded 50/200 reads; missing content proves nothing |
| `pane.send_input.keys` Enter spelling | **`"enter"` accepted** | Keep one atomic request with `keys: ["enter"]` |
| `screen_detection_skipped` authority signal | **Explicit `true` positively identifies recognized full-lifecycle authority** | Only `true` is reported provenance; missing/false is screen-detected |
| Dedicated metadata-token coexistence | **Unavailable in protocol 16** | Omit pane metadata in V1 |
| Socket request lifecycle | **Unary connections accept one request; `events.subscribe` owns a long-lived stream** | Use fresh connections for consecutive unary requests and one reconnecting subscription stream |
| Real Pi TUI delivery echo | **Visible on the first post-send bounded read; rendered ID line had leading TUI whitespace** | Boundedly re-read through the startup window and match the uniquely bounded `ID: hd_...` marker inside a rendered line |
| Pi idle `nextTurn` result injection | **Queued while idle with zero `agent_start` events and no immediate branch entry** | Use `deliverAs: "nextTurn"`, `triggerTurn: false`, and complete the branch claim after the next user-started turn persists it |

## 1. Terminal ID continuity across service restart

### Verification method

1. Started a named Herdr 0.7.3 server, created one workspace, and captured its root pane, workspace, tab, and terminal identities from `api snapshot`.
2. Cleanly stopped the named session with `herdr session stop`.
3. Restarted a headless server under the same session name and captured a second snapshot.
4. Compared the restored identities and retained pane state.

### Observed result

The workspace ID, tab ID, and pane ID were restored, and pane history was retained, but the terminal ID changed. Therefore terminal identity is not continuous across a clean Herdr 0.7.3 server restart.

### Impact on the design

This is a negative compatibility result and tightens behavior:

- an unsettled dispatch whose stored terminal ID disappears after restart becomes `target-lost`;
- matching pane ID, cwd, Agent label, or retained history must not establish continuity;
- release remains a manually confirmed resolution; there is no automatic retargeting;
- no revision cursor is introduced.

## 2. Pane movement and closed-ID non-reuse

### Verification method

1. Split a temporary pane and captured its pane ID and terminal ID.
2. Moved it into a newly created workspace with `pane move --new-workspace`.
3. Examined the move response and a fresh snapshot.
4. Closed the moved pane, then created and closed several additional panes.
5. Restarted the named server and created one more pane to check that allocation continued past previously closed IDs.

### Observed result

The cross-workspace move returned a different pane ID plus `previous_pane_id`, while the terminal ID remained unchanged. Subsequent panes received new monotonically advancing opaque IDs; neither the pre-move route nor any closed route was reused, including after restart. This empirical result agrees with the official Herdr guarantee that closed pane/tab IDs are not reused.

### Impact on the design

- Terminal ID remains the dispatch identity; pane ID remains a re-resolved delivery route.
- Final terminal-to-pane re-resolution through tightly adjacent unary requests and close/move event observation remain required.
- A stale closed pane ID cannot retarget a later resource, but a move can stale the route.
- No route is constructed or guessed from display order or ID shape.

## 3. `recent_unwrapped` depth and requested line counts

### Verification method

1. With experimental pane history enabled, printed 5,000 uniquely numbered lines followed by a completion marker in a temporary pane.
2. Called socket-level `pane.read` with source `recent_unwrapped` and `lines` values `0`, `1`, `2`, `24`, `200`, `999`, `1000`, `1001`, `5000`, and `20000`, plus one request with `lines` omitted.
3. Recorded returned logical-line count, first/last line, `truncated`, and `revision`.

### Observed result

- Omitting `lines` returned 80 logical lines.
- Requests from 1 through 1000 returned the requested number of logical lines; `0` returned empty text.
- Requests above 1000 returned exactly the newest 1000 logical lines.
- Oversized requests were silently clamped: `truncated` remained `false`.
- `revision` remained `0` despite thousands of lines of output.
- `recent_unwrapped` joined soft-wrapped terminal output into logical lines as expected.

### Impact on the design

- The configured 50-line inspection and 200-line Catch-Up Read are inside the observed limit.
- The adapter must accept shorter tails and must not trust `truncated: false` as proof that all history was returned.
- Absence of an echo or Result Envelope in the bounded tail never proves non-delivery or non-completion.
- Revision remains only an optional output-advanced hint, never a cursor or acceptance criterion.

## 4. `pane.send_input.keys` spelling for Enter

### Verification method

1. Created disposable shell panes and waited for each shell prompt to be visible.
2. Sent a socket-level `pane.send_input` request containing a marker command and `keys: ["enter"]`.
3. Read the pane and confirmed the marker command executed.
4. Repeated with `"Enter"` and `"return"` to identify alias behavior.

### Observed result

Lowercase `"enter"` was accepted and executed the text plus Enter in one request. Herdr 0.7.3 also accepted `"Enter"` and `"return"`; spelling is not uniquely constrained by the protocol schema.

### Impact on the design

V1 uses the already reviewed lowercase canonical form `keys: ["enter"]`. Delivery remains one `pane.send_input` request. Alias support is not relied upon, and there is no split `send-text` / `send-keys` fallback.

## 5. `screen_detection_skipped` and integration authority

### Verification method

1. Confirmed that no built-in Agent status integration was installed on the machine.
2. Started a real Pi process in a temporary pane and allowed Herdr screen detection to identify it.
3. Inspected `api snapshot` and `agent explain`.
4. In a separate temporary pane, reported Pi state through the recognized full-lifecycle source `herdr:pi`, then inspected the same outputs.
5. Released the reported authority and closed both temporary panes.

### Observed result

- The screen-detected Pi reported `screen_detection_skipped: false` in `agent explain`; the false field was omitted from the compact snapshot.
- The recognized full-lifecycle report produced `screen_detection_skipped: true` in the snapshot.
- `agent explain` gave `screen_detection_skip_reason: "full_lifecycle_hook_authority"`.
- An arbitrary non-integration source did not produce `true`.

### Impact on the design

- Explicit boolean `true` is sufficient positive evidence for reported integration authority.
- Missing or `false` is treated as screen-detected best effort.
- The adapter never infers reported provenance from Agent label, source naming guesses, or installed-file presence.

## 6. Dedicated metadata-token coexistence

### Verification method

1. Inspected the installed protocol-16 schema for `PaneReportMetadataParams` and `AgentInfo`.
2. Established recognized `herdr:pi` authority in a disposable pane.
3. Reported integration-owned `custom_status` metadata.
4. Reported a second expiring `custom_status` from a dedicated dispatch source with matching guards.
5. Refreshed the integration source while the dispatch metadata was alive, then observed behavior after dispatch TTL expiry.

### Observed result

Protocol 16 exposes no named metadata-token map for pane reports or Agent output. It exposes a single effective `custom_status`. The second source replaced the first effective value; refreshing the integration source replaced the dispatch value. TTL expiry correctly removed the expiring contribution, but the two statuses were not simultaneously representable as independent UI tokens.

### Impact on the design

This is a negative compatibility result. V1 must omit pane metadata entirely:

- do not call `pane.report_metadata` for dispatch display;
- do not overwrite or compete with integration-owned `custom_status`, title, display Agent, or state labels;
- use the Pi below-editor widget and Herdr notifications only;
- fail closed to omission rather than inventing a source-precedence heuristic.

## 7. Unary and subscription socket lifecycles

### Verification method

1. Opened a raw Unix-socket connection to the installed Herdr 0.7.3 server and sent a valid protocol-16 `ping` envelope.
2. After receiving the complete first response, attempted to send a second valid `ping` envelope on that same socket.
3. Repeated both requests using a fresh connection for each request.
4. Compared this with an `events.subscribe` request, which returns `subscription_started` and then retains its connection for pushed events.

### Observed result

The server closed the unary socket after its first response. Writing the second request failed with `EPIPE`/`BrokenPipeError`; opening a fresh socket for each unary request succeeded. Conversely, `events.subscribe` owns its connection after the acknowledgement and uses it as a long-lived event stream rather than accepting later unary requests.

### Impact on the design

- The adapter uses one exclusive, reconnecting subscription connection per Origin Monitor.
- Every snapshot, pane lookup, bounded read, notification, and `pane.send_input` unary request opens a fresh socket and fails closed on transport or envelope errors.
- Final terminal-to-pane resolution, pane validation, and `pane.send_input` remain tightly adjacent consecutive unary requests. Close/move observation is checked immediately before the send socket writes.
- Herdr exposes no batch or compare-and-send primitive, so the already disclosed residual route-validation/input-handling race remains. This finding does not justify split delivery or automatic resend.

## 8. Real Pi TUI delivery-echo timing and shape

### Verification method

1. Created a disposable pane in the current Herdr workspace and launched a real interactive Pi Agent.
2. Waited for Pi to become idle, then delivered a complete dispatch-shaped probe through the protocol-16 Adapter.
3. Timed `deliverAndVerify`, followed it with bounded 200-line `recent_unwrapped` reads, and captured every rendered line containing the random correlation ID.
4. Closed the disposable pane and removed its temporary directory.

### Observed result

The adapter's first post-send verification succeeded. The full resolve/send/re-resolve/read sequence returned `verified` after approximately 529 ms; the immediately following read also contained the ID. The input was rendered as ` ID: hd_echo_probe_...` with leading TUI whitespace, and the Result Envelope later contained the JSON `id` separately.

A single read succeeded in this probe, but that timing is not a protocol guarantee. TUI rendering and Agent startup can vary independently of `pane.send_input` acknowledgement.

A follow-up Phase 4 vertical acceptance used a fresh temporary Registry and a second disposable real Pi pane. The application created an immutable proposal, atomically persisted `delivering` plus Target Occupancy before send, verified the real echo within the startup window, and returned `active`; the Registry independently showed `active` and one occupancy record. The test then settled its temporary record and removed the pane, database, and directory.

### Impact on the design

- Phase 4 performs bounded 200-line re-reads through the configured startup window before adding `delivery-unverified` for a missing echo.
- Delivery evidence matches a uniquely bounded `ID: hd_...` marker anywhere within one rendered line, tolerating whitespace, borders, and prompt prefixes.
- The random correlation ID remains the anti-collision evidence. A missing marker still proves nothing and never triggers automatic resend.
- Result Envelope validation remains separate and stricter than delivery-echo matching.

## 9. Pi idle `nextTurn` result injection

### Verification method

1. Launched a disposable real interactive Pi 0.80.6 pane with a temporary probe extension and no initial prompt.
2. Waited until Pi was idle, then called `pi.sendMessage` with a custom dispatch result and `{ deliverAs: "nextTurn", triggerTurn: false }`.
3. Counted real `agent_start` events, sampled `ctx.isIdle()`, inspected the active branch immediately and 1.5 seconds later, and checked Herdr's Agent status.
4. Closed the pane and removed the probe extension and temporary directory.

### Observed result

The send call completed while Pi was idle. Pi remained idle both immediately and 1.5 seconds later; Herdr still reported `idle`; zero `agent_start` events occurred. The custom result was not yet an active-branch entry, confirming that `nextTurn` queues it for the next user-initiated turn rather than appending it or starting a model turn by itself.

### Impact on the design

- Result injection always sets both `deliverAs: "nextTurn"` and `triggerTurn: false`.
- The Registry context claim remains pending while the message is queued.
- In-process repeated delivery attempts do not enqueue duplicates even while the current turn advances the branch leaf; extension reload preserves the known queued claim because Pi retains the same pending `nextTurn` queue.
- After the next user-initiated turn persists the custom result, `agent_end` scans the active branch and completes the durable claim. A crash before that point leaves the claim pending for safe session-start retry.
- Branch navigation before the next user turn naturally redirects the queued message to the then-active branch; forks and clones still fail the Origin Session ID check.

## Result

The compatibility gate is complete. The negative findings—terminal-ID discontinuity, missing metadata-token coexistence, and one-request unary socket lifecycle—have been incorporated into `DESIGN.md` as `target-lost`/manual-resolution behavior, complete omission of pane metadata, and separate unary/subscription transports. No result required heuristic retargeting, revision cursors, or split delivery.
