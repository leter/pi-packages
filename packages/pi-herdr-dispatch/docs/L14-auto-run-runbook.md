# L14 — Auto Run live acceptance runbook

Live acceptance for Auto Run (ADR 0014, Phase 8). This is a **manual** procedure: it needs a real Pi TUI, a real Herdr server, and a real target Agent, because `DispatchRuntime.start` requires a live Herdr socket. The unit/integration suites cover the coordinator seam but cannot exercise Pi's real turn timing or the exactly-once behavior of a triggered wake.

The load-bearing check is **Case B (ghost-wake)**: it decides whether Auto Run is safe to arm at all. Run it first.

## Preconditions

- A Herdr pane running Pi with this extension loaded. After any source edit, run `/reload` in that pane. `HERDR_SOCKET_PATH`, `HERDR_WORKSPACE_ID`, `HERDR_PANE_ID` must be set (they are, inside a Herdr pane).
- One **target Agent** idle in a sibling pane in the same workspace and cwd — e.g. a `codex` or `claude` pane. Confirm it with `/hd-agents`; it must appear as an Eligible Agent (status idle or done).
- A separate plain terminal (not inside Pi) for reading the Registry database. Reads from Pi's own `bash` are intentionally blocked by the Registry access guard, so inspect from an outside shell:

  ```bash
  DB=~/.local/state/pi-herdr-dispatch/registry.sqlite
  ```

- Note the config file `~/.config/pi-herdr-dispatch/config.json`. Some cases set `maxAutoRunDepth`; after editing it, `/reload` Pi.

## Case B — ghost-wake (must pass before arming for real)

**Goal:** confirm that one settlement produces exactly one Auto Run turn and its context-delivery claim completes, rather than the same result re-triggering turns forever.

1. In the Pi pane: `/hd-auto on`. Confirm the widget shows `⚡自动`, the soundless notification fires, and `/hd-manager` shows the armed state in its top border.
2. Dispatch one short non-mutating task to the target with `/hd-new`. Make it settle quickly and need **no** follow-up, e.g. task text:

   > Reply with a one-line summary only, then finish by printing exactly one line: `DISPATCH_RESULT {"id":"<the ID from this dispatch>","outcome":"done","summary":"ok"}`. Do not do anything else.

   (Use the `hd_…` ID shown by the dispatch; the target must emit that exact single-line envelope so the dispatch settles.)
3. Wait for the target to finish and the dispatch to settle. Observe the Pi session: **exactly one** turn should start automatically, and its injected message must begin with `[HERDR AUTO RUN]` followed by the untrusted result envelope.
4. Let that auto turn finish. If the model, reading the trivial result, ends the turn without dispatching anything, good; if it does dispatch a follow-up, that is a legitimate depth-1 dispatch (a *different* `hd_…` id), not a ghost-wake — cancel it (`/hd-cancel`) to keep the case clean.
5. **Authoritative verdict** — from the outside shell, read the claim for the settled dispatch:

   ```bash
   sqlite3 "$DB" "SELECT dispatch_id, delivered_at FROM context_delivery_claims ORDER BY claimed_at DESC LIMIT 5;"
   ```

   - **PASS:** the settled dispatch's `delivered_at` is a non-null timestamp, and no further auto turns fire for it. Exactly-once delivery works.
   - **FAIL (ghost-wake confirmed):** `delivered_at` stays `NULL` while the same result keeps triggering new turns (watch the Pi session for ~60s with nothing new settled). This is the known risk. If it fails, the fix is to mark context delivery complete on a successful wake instead of relying on the branch-entry claim, then re-run this case.

6. Disarm: `/hd-auto off`.

## Case A — two-hop chain and termination

**Goal:** a real settle→wake→follow-up→settle chain terminates at the depth limit.

1. Set a low limit to make termination observable: in `config.json` set `"maxAutoRunDepth": 1`, then `/reload`.
2. `/hd-auto on`.
3. Dispatch a non-mutating task that will plausibly make the Origin want one follow-up (e.g. "review file X and suggest the single next check to run"). It settles at depth 0.
4. Observe: the settlement wakes the Origin (depth-1 turn). If the woken Origin issues a follow-up dispatch, that dispatch is recorded at Auto Run Depth 1.
5. When the depth-1 dispatch settles, it is at the limit: **no wake**. Instead expect the quiet queue plus one review notification ("自动运行深度已达上限"). Confirm the Origin does **not** start another automatic turn.
6. Verify the depth was recorded, from the outside shell:

   ```bash
   sqlite3 "$DB" "SELECT id, auto_run_depth, lifecycle FROM dispatches ORDER BY created_at DESC LIMIT 5;"
   ```

   The user-turn dispatch is `auto_run_depth = 0`; the follow-up made during the auto turn is `1`.
7. Restore `maxAutoRunDepth` to its normal value afterward and `/reload`.

## Case C — off mid-flight and Esc

1. `/hd-auto on`, dispatch two tasks that settle close together.
2. While the first Auto Run turn is running, `/hd-auto off`. Confirm the `⚡自动` widget segment disappears.
3. Confirm **no new** Auto Run turn ignites for the second result — it falls back to the quiet queue (it appears on your next manual turn, still counted as `✓ … 未读`).
4. The turn already running continues; press **Esc** to interrupt it if desired. Nothing is lost.

## Case D — settle-before-arm and visibility on resume

1. With Auto Run **off**, dispatch a task and let it settle (it queues quietly).
2. Now `/hd-auto on`. Confirm the already-settled result does **not** retroactively trigger a turn (it settled before arming).
3. Dispatch another task; confirm this one (settled after arming) does wake.
4. `/reload` (or resume the exact session). Confirm the armed state is restored: the resume notification fires and the `⚡自动` segment reappears before any wake.

## Recording results

Log outcomes in [ACCEPTANCE-RESULTS.md](./ACCEPTANCE-RESULTS.md) with the date, Pi/Herdr versions, and the Case B `delivered_at` evidence. Until Case B passes, ADR 0014 and the README keep Auto Run flagged as not-for-unattended-use.
