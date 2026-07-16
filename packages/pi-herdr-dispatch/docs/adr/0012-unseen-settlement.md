# 0012 — Unseen Settlement

## Status

Accepted (2026-07-16).

## Context

Settlement emitted one transient Herdr notification and nothing else. A user who was not looking at the moment of settlement had no persistent trace: the widget only counted unsettled records, and settled records hid behind the Manager's fold. The user asked for a mechanism where a completed result stays visible until seen, then folds away — the same semantic Herdr itself uses for agent status (`done` = completed with result unseen, `idle` = seen).

## Decision

1. **Registry schema v4** adds `result_seen_at` to dispatches. Settlement leaves it NULL (unseen). The migration backfills pre-existing settled records as seen so history does not flood the UI.
2. **The widget counts Unseen Settlements** as a `✓ N 已完成` segment (workspace-scoped, like the other counts) and stays alive while any exist — the quiet state requires zero unseen as well.
3. **The Manager shows Unseen Settlements in their own group** (`已完成 · 未读`) above the settled fold, selectable without pressing `s`.
4. **Opening the record's detail marks it seen** (`markResultSeen`, first-wins, idempotent) and the record drops into the ordinary settled fold.
5. **The list-screen `c 清空未读` shortcut atomically marks every current-workspace Unseen Settlement seen.** It appears only while unread completions exist, performs no deletion, and keeps those records available through the workspace settled fold (`s`) until ordinary retention purges them.
6. **Seen state is presentation metadata, not lifecycle state.** It never affects reservations, settlement, monitoring, or safety decisions. Individual and bulk seen-state updates are the sole view-triggered writes in the product and are the deliberate, documented exception to "read-only surfaces stay read-only": the read-only rule protects dispatch state and reservations, which these writes cannot touch.

## Consequences

- A settlement can no longer disappear silently: the transient notification is backed by a persistent widget count and Manager group until the user actually looks.
- The unseen query, bulk seen update, and recent settled fold are workspace-scoped, so results from earlier Pi sessions surface and remain reviewable after bulk clearing, consistent with the foreign-Origin widget visibility decision (#7).
- Bulk clearing is intentionally immediate because it is non-destructive presentation cleanup; the retained record remains reachable with `s` and normal retention remains the only deletion path.
- A stale registry opened by an older build lacks the column and fails closed at migration versioning, matching existing schema policy.
