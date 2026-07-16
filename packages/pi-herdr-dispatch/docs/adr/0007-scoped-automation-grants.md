# Author unattended dispatch with scoped Automation Grants

> Superseded by [ADR 0009](./0009-automatic-dispatch-by-default.md). Grant setup, count, and expiry state were removed at the user's explicit request.

Per-proposal TUI confirmation prevents unattended orchestration: an otherwise authorized Origin Session stops at every send while no user is present. Globally disabling confirmation was rejected because a mistaken or compromised model could task any Eligible Agent with arbitrary mutation permissions. Session-only auto mode was also rejected because reload or resume would unexpectedly halt an unattended run.

A user may instead create one durable Automation Grant for the exact Origin Session through `/hd-autonomy`. The confirmation displays the current workspace, exact target terminal identities, directories and canonical worktrees, permitted modes, maximum dispatch count, expiry, and the fact that covered proposals skip individual confirmation. The current UI offers one or all currently Eligible Agents, non-mutating-only or write-capable scope, limits of 1/5/20 dispatches, and validity of 15 minutes/1 hour/8 hours. The Registry enforces hard ceilings of 100 dispatches and 24 hours.

Every proposal is still immutable and passes normal target, occupancy, lease, concurrency, delivery, and echo checks. A proposal is covered only when its Origin Session, workspace, target terminal, cwd, canonical worktree for write mode, mode, remaining count, and time match exactly. Project dependency installation is never covered. Grant consumption and durable delivery intent are one SQLite transaction, so a concurrent conflict or failed reservation does not spend a grant use. Replacement explicitly revokes the previous grant; revocation affects only future sends. Forks have distinct Origin Session IDs and cannot inherit a grant.

Reply, cancellation, manual/emergency resolution, output inspection, and raw Herdr command policy are unchanged. There is no model-callable grant creation or global no-confirm configuration. This trades individual task-byte review for bounded preauthorization while preserving a durable, auditable authorization source for every send.
