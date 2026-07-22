# Herdr Agent Activity

A standalone Herdr sidebar plugin for Agent identity, navigation scope, current title, linked-worktree context, native status, and elapsed time.

It intentionally renders only Agents returned by Herdr's native Agent list. Shell, Neovim, Lazygit, and other non-Agent panes stay out of the list. The plugin does not read a task registry, workflow, role catalog, dispatch contract, or private metadata from another extension.

## Display

Row 1 is a short navigation path. With one visible Agent Workspace and one default Agent Tab, it shows only the leaf identity:

```text
● Pi
  ▸ Discuss title updates
  Pi · working 4m
```

Row 1 contains at most two components. Workspace and Tab are added only when they disambiguate visible Agents, but Workspace wins when both would be shown: use `Workspace · identity` across multiple visible Agent Workspaces, otherwise use `Tab · identity` for a meaningful Tab. The leaf uses the first available value from manual Pane name, manual Agent name, and Agent type:

```text
● pi-packages · API review
  ▸ Check narrow layout
  ⎇ fix-api
  Claude · working 4m
```

Duplicate leaves in one Tab receive display-only ordinals such as `Pi 1` and `Pi 2`. Row 2 prefixes the current native terminal title with `▸ `. When Herdr provides an Agent Session identity, the plugin does not carry a title into a different Session. Agents without that identity, including some Cursor and Codex integrations, display their best-effort native terminal title without a cross-Session guarantee. Row 3 prefixes a linked Worktree basename with `⎇ `; main checkouts and missing Worktrees collapse the row. The plugin never invents a task name, workflow progress, role, or subject.

## Data contract

The plugin reads only:

- Herdr Pane ID and Terminal ID;
- Workspace and Tab IDs and labels;
- manual Pane and Agent names;
- detected Agent type, native terminal title, Agent Session, and native status;
- Pane and foreground cwd;
- Workspace Worktree membership and Git's linked-worktree list.

The Terminal ID keys status duration, so moving a Pane does not reset its timer. `done` remains distinct from `idle` and keeps Herdr's native attention color. Former dispatch, role, task, workflow, progress, and subject tokens are ignored.

## Performance

- Agent, focus, Workspace, Tab, Pane, and Worktree events trigger an immediate scope-aware refresh;
- one background correction runs every 15 seconds for manual-name, title, and elapsed-time updates;
- unchanged visible output is not reported again;
- Git worktrees are queried once per repository per refresh, not once per Pane;
- state is written only when it changes;
- one failing Pane does not discard other Pane updates.

## Width behavior

The plugin uses Herdr's current layout snapshot to derive a conservative sidebar width. It counts CJK, combining marks, flags, and emoji by terminal display columns. When row 1 is too narrow, it removes Workspace first, then Tab, and finally truncates the identity while preserving its beginning. If width evidence is unavailable, the complete short path remains available to Herdr's renderer.

## Files

- `default-icons.json` — Agent display labels.
- `config/sidebar.toml` — adaptive four-row sidebar layout.
- `scripts/refresh.py` — event refresh, duration state, Git context, and watcher.
- `scripts/setup.sh` — initialize label config and refresh.
- `tests/test_refresh.py` — rendering, state, performance, and failure tests.

## Install or update

```bash
bash tools/agent-activity/scripts/install-local.sh
```

The installed plugin ID remains `local.agent-icons` for compatibility. Existing label overrides in `~/.config/herdr/plugins/config/local.agent-icons/icons.json` are preserved.

Merge this layout into `~/.config/herdr/config.toml`:

```toml
[ui.sidebar.agents]
row_gap = 1
rows = [
  ["state_icon", "$agent_location"],
  ["$agent_title"],
  ["$agent_context"],
  ["state_text"],
]
```

Reload the running Herdr server after changing the sidebar rows:

```bash
herdr server reload-config
```

Then run the `local.agent-icons.setup` action once or execute:

```bash
python3 tools/agent-activity/scripts/refresh.py
```
