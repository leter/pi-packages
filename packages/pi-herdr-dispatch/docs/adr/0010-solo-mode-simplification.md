# 0010 — Solo-mode simplification

## Status

Accepted (2026-07-16).

## Context

The product has exactly one user, who operates every Origin Session and every Target Agent on one machine. An audit found machinery whose cost (code, tests, docs, cognitive load) was justified only by multi-user or fleet scenarios, plus configuration that could not legally vary. Separately, the wrapper-unwrapping precision in the raw Herdr CLI gate had grown per-tool option tables (GNU parallel, xargs, sudo, …) to reduce false positives that a solo user can cheaply tolerate.

The user explicitly decided to simplify. The correctness core — delivery echo verification, Worktree Write Leases, fail-closed uncertainty, untrusted-output framing — is intentionally untouched: those mechanisms caught real failures (an unverified Codex delivery, a shared-worktree write conflict) on the same day this decision was made.

## Decision

1. **Raw Herdr CLI gate: launchers fail closed instead of being unwrapped.** The shell classifier no longer models wrapper option grammars or recursively evaluates `bash -c`/`eval` bodies. Any command-launcher invocation (`bash`, `eval`, `xargs`, `sudo`, `env`, `timeout`, …) that mentions `herdr` is denied outright and redirected to the typed dispatch path. Direct `herdr` invocations are classified against the read-only allowlist exactly as before; non-launcher commands that merely mention herdr as data (e.g. `grep herdr`) remain allowed. Net effect is stricter: wrapped invocations that previously classified as read-only now deny.
2. **`target-moved` is removed from the Attention vocabulary.** The five-second poll remains as a pure liveness probe that adds `target-lost` when the stored terminal cannot be resolved. Cwd-drift sampling, its two-sample threshold, and the `cwdDriftSamples`/`cwdPollMs` configuration are gone (`livenessPollMs` replaces the interval).
3. **Configuration that could not vary is now constants.** `inspectionLines`, `maxInspectionLines`, and `catchUpLines` (all frozen by V1 validation) left the config schema; the 200-line adapter hard limit is the `MAX_INSPECTION_LINES` constant.
4. **The bilingual README contract is dropped.** `README.zh-CN.md` is deleted; the documentation contract requires only the English README.

## Explicitly retained

- Foreign-Origin emergency resolution with double confirmation: `originSessionId` is a Pi session ID, so every new Pi session is foreign to older unsettled dispatches. This path is the solo user's own crash/restart recovery, not multi-user machinery.
- Target liveness polling (`target-lost`), delivery echo verification, leases, fail-closed uncertainty handling, untrusted framing, occupancy/concurrency validation on automatic send.

## Consequences

- ~500 lines of source and matching tests removed; the classifier is auditable at a glance.
- A wrapped-but-harmless command mentioning herdr (e.g. `xargs grep herdr src/`) now denies with a redirect; run the unwrapped form instead.
- A stale user config containing removed fields fails closed with an unknown-field error naming the field.
- A target agent that changes directory without losing its terminal no longer raises attention; worktree safety still holds through leases and result validation.
