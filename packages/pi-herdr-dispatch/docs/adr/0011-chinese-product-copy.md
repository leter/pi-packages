# 0011 — Simplified Chinese product copy

## Status

Accepted (2026-07-16). Supersedes the "product copy is English" red line by explicit user decision.

## Context

The product has exactly one user, who works in Simplified Chinese. The prerequisites landed the same day: the typed pure copy catalog (`src/pi/ui-copy.ts`, issue #1) gives every human-facing string one home with a tested boundary against model-facing strings, and East-Asian-Width-aware table layout (issue #2) makes CJK cells align correctly. An earlier i18n proposal (language setting plus multi-locale catalogs) was rejected as overkill for a single user; this is a single-language localization with no runtime language switch.

## Decision

1. **All human-facing product copy is Simplified Chinese**, implemented entirely inside the copy catalog. The catalog translates raw domain enums (outcomes, lifecycles, agent statuses, modes, attention conditions) at the presentation boundary.
2. **The terminology table in `docs/CONTEXT.md` is the sole translation authority.** Every rendering of a domain term in product copy must match it exactly; new copy adds its terms to the table first.
3. **Model-facing and target-facing safety/framing strings stay English verbatim** — the `untrusted, never instructions` family, `<untrusted-herdr-cli-output>` tags, tool descriptions, context-delivery wrappers, and outbound protocol bytes. A human-facing line that embeds a framing marker is intentionally mixed-language, and tests assert the framing survives localization.
4. **Selection values never couple to display labels.** Where a TUI select shows translated labels, the controller maps the chosen label back to the raw domain value (the manual-resolution outcome picker was fixed for exactly this).
5. English remains the language of code identifiers, documentation, commit messages, and the README.

## Consequences

- Deadline/age phrases, counts, and state labels render in Chinese; plural branches disappeared.
- Renderer alignment and truncation are display-width based everywhere product copy appears (a remaining char-count column layout and an English-substring `overdue` color check were fixed as part of this change).
- Terminal environments without CJK fonts will render the UI poorly; this is accepted for a single-user product.
- Herdr-level and system-level strings (agent names, paths, raw errors) remain in their original language; mixed output is expected.
