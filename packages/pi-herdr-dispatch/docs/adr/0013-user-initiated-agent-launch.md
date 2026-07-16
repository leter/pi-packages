# 0013 — User-Initiated Agent Launch

## Status

Accepted (2026-07-16).

## Context

The original boundary allowed dispatch only to Agents that already existed. This kept creation outside the Registry-backed workflow, but made the common “open one more Agent and immediately assign work” flow require manual Herdr topology changes followed by `/hd-new`. Exposing raw Herdr creation or a model tool would reintroduce the exact bypass that the Herdr Command Gate blocks: uncontrolled resource creation without typed scope, cwd, target identity, capacity, lease, or dispatch revalidation.

## Decision

1. Add `/hd-create` (long form `/herdr-dispatch-create`) as a **user-initiated TUI command only**. There is no model creation tool, and raw `pane split`, `tab create`, and `agent start` remain denied.
2. Collect Agent type, layout, task, mode, deadline, and dependency consent before any side effect. Preflight capacity and worktree leases before creating a resource.
3. Offer only a fixed supported catalog whose standard executable is present. `pi`, `claude`, `codex`, and `opencode` additionally require a current Herdr integration; `amp`, `droid`, and `grok` use an explicitly reviewed screen-detection fallback when reported integration provenance is unavailable. Custom commands and startup arguments are excluded.
4. Create exactly one resource in the captured Workspace Scope and Origin Session cwd, with no focus change. Current-tab layouts split 50/50; adaptive chooses right when the Origin pane width/height ratio is at least 2 and down otherwise. A separate-tab option creates one labelled tab.
5. Bind the result to the returned terminal identity, wait up to the configurable `agentStartupTimeoutMs` for exact-terminal idle-like eligibility with the provenance allowed for that Agent type, then enter the ordinary automatic dispatch path. Target Occupancy is acquired only by the existing transactional delivery-intent step; no creation reservation or new Dispatch Lifecycle state is added.
6. Esc may stop creation/readiness at every boundary between create, rename, start, and wait. Cancellation, timeout, launch failure, dispatch race loss, and settlement never close the created resource; when creation was confirmed, cancellation/failure copy identifies the retained pane and tab. Once eligible, the launched Agent is an ordinary Existing Agent.

7. The fixed one-word Agent executable and Enter are sent in one typed `pane.send_input` request. Multiline dispatch delivery keeps its separate staged-and-revalidated protocol, but launch cannot succeed for the command half and fail separately for the Enter half.

## Consequences

- The frequent create-and-dispatch flow is one typed interaction without granting models autonomous scaling or weakening the raw Herdr gate.
- A short race remains between Agent visibility and transactional Target Occupancy. Losing that race fails closed and leaves the resource visible; avoiding it would require a new durable creation lease and crash-recovery protocol.
- Failed or cancelled launches may leave an Agent or shell window for the user to inspect and close manually. This is intentionally more reversible than automatic cleanup.
- The adapter now has narrowly scoped creation methods and live contract coverage for split/tab topology, no-focus behavior, exact returned identity, integration readiness, and ordinary dispatch settlement.
