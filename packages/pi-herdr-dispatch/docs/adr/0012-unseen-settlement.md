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
5. **Seen state is presentation metadata, not lifecycle state.** It never affects reservations, settlement, monitoring, or safety decisions. This is the sole view-triggered write in the product and is the deliberate, documented exception to "read-only surfaces stay read-only": the read-only rule protects dispatch state and reservations, which this write cannot touch.

## Consequences

- A settlement can no longer disappear silently: the transient notification is backed by a persistent widget count and Manager group until the user actually looks.
- The unseen query is workspace-scoped, so results from earlier Pi sessions surface too, consistent with the foreign-Origin widget visibility decision (#7).
- A stale registry opened by an older build lacks the column and fails closed at migration versioning, matching existing schema policy.
