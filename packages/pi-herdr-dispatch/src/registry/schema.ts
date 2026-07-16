export const REGISTRY_SCHEMA_VERSION = 4;

export const REGISTRY_SCHEMA_V1 = `
CREATE TABLE dispatches (
  id TEXT PRIMARY KEY,
  origin_session_id TEXT NOT NULL,
  origin_session_file TEXT,
  origin_workspace_id TEXT NOT NULL,
  target_workspace_id TEXT NOT NULL,
  target_terminal_id TEXT NOT NULL,
  target_pane_id TEXT NOT NULL,
  target_agent_label TEXT NOT NULL,
  target_cwd TEXT NOT NULL,
  worktree_path TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('non-mutating', 'write')),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('delivering', 'active', 'settled')),
  final_outcome TEXT CHECK (final_outcome IS NULL OR final_outcome IN ('done', 'blocked', 'failed', 'cancelled')),
  task TEXT NOT NULL,
  constraints_json TEXT NOT NULL CHECK (json_valid(constraints_json)),
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  deadline_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER NOT NULL,
  delivery_started_at INTEGER NOT NULL,
  active_at INTEGER,
  settled_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK (mode != 'write' OR worktree_path IS NOT NULL),
  CHECK ((lifecycle = 'settled') = (final_outcome IS NOT NULL AND settled_at IS NOT NULL))
) STRICT;

CREATE TABLE dispatch_attention (
  dispatch_id TEXT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  condition TEXT NOT NULL,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (dispatch_id, condition)
) STRICT;

CREATE TABLE target_occupancy (
  target_terminal_id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL UNIQUE REFERENCES dispatches(id) ON DELETE CASCADE,
  acquired_at INTEGER NOT NULL
) STRICT;

CREATE TABLE worktree_write_leases (
  worktree_path TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL UNIQUE REFERENCES dispatches(id) ON DELETE CASCADE,
  target_terminal_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL
) STRICT;

CREATE TABLE dispatch_results (
  dispatch_id TEXT PRIMARY KEY REFERENCES dispatches(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('done', 'blocked', 'failed', 'cancelled')),
  source_terminal_id TEXT,
  raw_envelope TEXT,
  sanitized_json TEXT NOT NULL CHECK (json_valid(sanitized_json)),
  accepted_at INTEGER NOT NULL
) STRICT;

CREATE TABLE context_delivery_claims (
  dispatch_id TEXT PRIMARY KEY REFERENCES dispatches(id) ON DELETE CASCADE,
  origin_session_id TEXT NOT NULL,
  branch_leaf_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  delivered_entry_id TEXT,
  delivered_at INTEGER
) STRICT;

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_id TEXT REFERENCES dispatches(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX dispatches_unsettled_origin_idx
  ON dispatches(origin_session_id, lifecycle)
  WHERE lifecycle != 'settled';
CREATE INDEX dispatches_target_workspace_idx
  ON dispatches(target_workspace_id, lifecycle);
CREATE INDEX dispatches_settled_at_idx
  ON dispatches(settled_at)
  WHERE lifecycle = 'settled';
CREATE INDEX audit_events_dispatch_idx
  ON audit_events(dispatch_id, id);

CREATE TRIGGER dispatch_confirmed_payload_immutable
BEFORE UPDATE OF
  origin_session_id,
  origin_workspace_id,
  target_workspace_id,
  target_terminal_id,
  target_agent_label,
  target_cwd,
  worktree_path,
  mode,
  task,
  constraints_json,
  payload,
  payload_hash,
  deadline_at,
  confirmed_at
ON dispatches
BEGIN
  SELECT RAISE(ABORT, 'confirmed dispatch payload is immutable');
END;
`;

export const REGISTRY_SCHEMA_V2 = `
CREATE TABLE automation_grants (
  id TEXT PRIMARY KEY,
  origin_session_id TEXT NOT NULL,
  origin_workspace_id TEXT NOT NULL,
  targets_json TEXT NOT NULL CHECK (json_valid(targets_json)),
  allow_write INTEGER NOT NULL CHECK (allow_write IN (0, 1)),
  max_dispatches INTEGER NOT NULL CHECK (max_dispatches > 0),
  used_dispatches INTEGER NOT NULL DEFAULT 0 CHECK (
    used_dispatches >= 0 AND used_dispatches <= max_dispatches
  ),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
) STRICT;

CREATE UNIQUE INDEX automation_grants_active_origin_idx
  ON automation_grants(origin_session_id)
  WHERE revoked_at IS NULL;
`;

export const REGISTRY_SCHEMA_V3 = `
DROP TABLE IF EXISTS automation_grants;
`;

export const REGISTRY_SCHEMA_V4 = `
ALTER TABLE dispatches ADD COLUMN result_seen_at INTEGER;
UPDATE dispatches SET result_seen_at = settled_at WHERE lifecycle = 'settled';
`;
