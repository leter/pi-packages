# 0019 — Accept agent-session records as reported-provenance evidence

## Status

Accepted (2026-07-17); approach confirmed by the user (adapt to Herdr 0.7.4 rather than pin 0.7.3). Not yet implemented.

## Context

DESIGN.md's provenance rule says a target's status may be labelled **reported** only on positive evidence of integration authority, which on Herdr 0.7.3 was exactly `screen_detection_skipped: true`. Herdr 0.7.4 stopped setting that flag for `claude`/`codex`/`opencode` panes even with current integrations installed (only `pi` panes still carry it). Consequences observed in L15: `/hd-create` for those three types waits for reported provenance that never arrives and times out at `agentStartupTimeoutMs`, and a launched-then-silent target never triggers a result read. `/hd-new` to existing Agents is unaffected because screen-detected provenance is acceptable there.

Herdr 0.7.4 does expose a different positive signal: integrations write an `agent_session` record onto the pane (`source: "herdr:<agent>"`, plus a session `kind`/`value`), visible in `session.snapshot` and `pane.get`. That record exists only when the integration for that agent type is actually running — it is evidence of presence, not absence-as-default.

Pinning Herdr to 0.7.3 was rejected: it would freeze the environment against all future Herdr fixes to protect one label.

## Decision

1. **The evidence catalog for `reported` provenance widens to two positive signals:** `screen_detection_skipped === true` (unchanged), or an `agent_session` record whose `source` is `herdr:<agent>` for the exact agent type of that pane. Either satisfies the launch eligibility wait in `agent-launch.ts` and yields `statusProvenance: "reported"` everywhere provenance is labelled (launch result, eligible-agent listing, proposal status evidence).
2. **The fail-closed default is unchanged.** A pane with neither signal remains **screen-detected (best effort)**; absence of evidence still never becomes `reported`. A malformed `agent_session` (missing source, mismatched agent) is ignored as evidence, not treated as an error.
3. **The snapshot/pane protocol parser learns the optional `agent_session` field** with the same strict-optional style as existing fields: present-but-wrong-type is a protocol error; absent is normal.

## Consequences

- `/hd-create` works again for `claude`/`codex`/`opencode` on Herdr 0.7.4, and their launched panes count as reported, so status transitions drive result reads and the L15 "silent target never settles" edge disappears for integrated types.
- DESIGN.md's status-semantics section is updated to name both signals; README's provenance note follows. CONTEXT.md's provenance term is unchanged (reported / screen-detected vocabulary stays).
- The rule remains verifiable live: `herdr pane get` on an integrated pane shows the `agent_session` record this decision keys on. A targeted live check (launch one `codex` via `/hd-create` on 0.7.4) is required before this ADR is marked verified.
- If a future Herdr version changes the `agent_session` shape, the strict-optional parser fails closed to screen-detected labelling rather than misreporting authority.
