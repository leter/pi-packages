# 0020 — Role default Agent types with dynamic override

## Status

Accepted (2026-07-17); mapping specified by the user. Builds on ADR 0017 (roles) and ADR 0018 (read-only launch). No schema change.

## Context

Roles bind briefs and modes but stay silent about *which* Agent type should serve them; routing rests entirely on pane naming, and the read-only launch tool demands an explicit `agentType` every call. The user wants opencode-style ergonomics: a configurable default Agent type per role, with dynamic switching still available.

## Decision

1. **`Role` gains an optional `agent` field**, validated against the fixed launch catalog (`SUPPORTED_AGENT_TYPES`). Built-in defaults: `coder: codex`, `reviewer: claude`, `bugfix: amp`, `chore: pi`, `researcher: grok`, `advisor: opencode`, `oracle: droid`. The wholesale-replace override rule of ADR 0017 is unchanged — a team.json role override without `agent` simply has no default.
2. **Routing precedence** (hd-crew judgment, advisory as ever): ① an Eligible Agent whose pane name contains the role key always wins — renaming a pane is the dynamic switch; ② otherwise prefer an Eligible Agent whose `agentLabel` equals the role's default agent; ③ otherwise any suitable Eligible Agent with the existing plain disclosure.
3. **`herdr_agent_launch_readonly.agentType` becomes optional**, defaulting to the role's `agent`; an explicit argument still overrides. A read-only role with no default and no argument is a typed refusal naming the gap. Every other ADR 0018 rule (budget, reuse-first, fixed ground) is untouched.
4. **No new surfaces.** Changing a default is editing team.json plus `/reload`; the status tool's task routing line adds `· agent <type>` so the model can apply precedence ② without new tools.

## Consequences

- The default mapping is routing preference only; a pane must still exist (or be launchable within the read-only rules) — write-role capacity remains the user's `/hd-create`.
- Implementation: `team.ts` (field + validation + built-ins), `tools.ts` (optional param, resolution, routing-status line), `application.ts` launch-plan resolution, SKILL.md precedence rewrite, README/DESIGN/CONTEXT updates, tests at the same layers. Registry schema and Manager UI are unchanged.
- L20 live check (bundled into the next overnight run): a queued coder task preferring an idle codex pane over another idle type without any pane naming, and one read-only launch omitting `agentType`.
