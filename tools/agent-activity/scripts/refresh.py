#!/usr/bin/env python3
"""Publish native Herdr Agent activity metadata for sidebar layouts."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import py_compile
import shutil
import subprocess
import sys
import time
import unicodedata
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parent.parent
SOURCE_ID = "local.agent-icons"  # Stable installed plugin/source identity.
REFRESH_SECONDS = 15
STATE_VERSION = 4
PRUNE_GRACE_MS = 2 * 60_000
MAX_CONSECUTIVE_REFRESH_FAILURES = 4
AGENT_STATES = ("working", "idle", "blocked", "done", "unknown")
ROW_SEPARATOR = " · "
CLEAR_TOKENS = (
    "agent_name",
    "agent_task",
    "agent_subject",
    "agent_activity",
    "agent_badge",
    "agent_elapsed",
    "agent_icon",
    "agent_divider",
    "tab_badge",
    "task_badge",
)


def character_width(character: str) -> int:
    if not character or unicodedata.combining(character):
        return 0
    codepoint = ord(character)
    if codepoint in (0x200D, 0xFE0E, 0xFE0F) or 0x1F3FB <= codepoint <= 0x1F3FF:
        return 0
    if unicodedata.category(character) in {"Cc", "Cf", "Cs"}:
        return 0
    return 2 if unicodedata.east_asian_width(character) in {"W", "F"} else 1


def display_clusters(text: str) -> list[str]:
    clusters: list[str] = []
    index = 0
    while index < len(text):
        cluster = text[index]
        first = ord(text[index])
        index += 1
        if 0x1F1E6 <= first <= 0x1F1FF and index < len(text):
            following = ord(text[index])
            if 0x1F1E6 <= following <= 0x1F1FF:
                cluster += text[index]
                index += 1
        while index < len(text):
            codepoint = ord(text[index])
            if (
                unicodedata.combining(text[index])
                or codepoint in (0xFE0E, 0xFE0F)
                or 0x1F3FB <= codepoint <= 0x1F3FF
            ):
                cluster += text[index]
                index += 1
                continue
            if codepoint == 0x200D and index + 1 < len(text):
                cluster += text[index:index + 2]
                index += 2
                continue
            break
        clusters.append(cluster)
    return clusters


def cluster_width(cluster: str) -> int:
    widths = [character_width(character) for character in cluster]
    emoji_sequence = (
        "\u200d" in cluster
        or "\ufe0f" in cluster
        or any(0x1F1E6 <= ord(character) <= 0x1F1FF for character in cluster)
        or any(0x1F3FB <= ord(character) <= 0x1F3FF for character in cluster)
    )
    return max(2, max(widths, default=0)) if emoji_sequence else sum(widths)


def display_width(text: str) -> int:
    return sum(cluster_width(cluster) for cluster in display_clusters(text))


def truncate_display(text: str, width: int) -> str:
    if width <= 0:
        return ""
    if display_width(text) <= width:
        return text
    if width == 1:
        return "…"
    budget = width - 1
    result: list[str] = []
    used = 0
    for cluster in display_clusters(text):
        columns = cluster_width(cluster)
        if used + columns > budget:
            break
        result.append(cluster)
        used += columns
    return "".join(result) + "…"


def compose_path(parents: list[str], leaf: str, width: int | None) -> str | None:
    components = [component.strip() for component in (*parents, leaf) if component.strip()]
    if not components:
        return None
    if width is None:
        return ROW_SEPARATOR.join(components)
    if width <= 0:
        return None
    while len(components) > 1 and display_width(ROW_SEPARATOR.join(components)) > width:
        components.pop(0)
    rendered = ROW_SEPARATOR.join(components)
    return rendered if display_width(rendered) <= width else truncate_display(components[-1], width)


def sidebar_width(payload: dict[str, Any], workspace_id: str) -> int | None:
    result = payload.get("result")
    snapshot = result.get("snapshot") if isinstance(result, dict) else None
    layouts = snapshot.get("layouts") if isinstance(snapshot, dict) else None
    if not isinstance(layouts, list):
        return None
    widths: set[int] = set()
    matched = False
    for layout in layouts:
        if not isinstance(layout, dict) or layout.get("workspace_id") != workspace_id:
            continue
        matched = True
        area = layout.get("area")
        if (
            not isinstance(area, dict)
            or not isinstance(area.get("x"), int)
            or isinstance(area.get("x"), bool)
        ):
            return None
        widths.add(area["x"])
    if not matched or len(widths) != 1:
        return None
    outer = next(iter(widths))
    return outer - 3 if outer > 5 else None


def herdr_bin() -> str:
    return os.environ.get("HERDR_BIN_PATH") or shutil.which("herdr") or "herdr"


def state_dir() -> Path:
    configured = os.environ.get("HERDR_PLUGIN_STATE_DIR")
    if configured:
        return Path(configured)
    base = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
    return base / "herdr/plugins/local.agent-icons"


def state_path() -> Path:
    return state_dir() / "activity-state.json"


def run_json(*args: str) -> dict[str, Any]:
    completed = subprocess.run(
        [herdr_bin(), *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(f"herdr {' '.join(args)} failed: {message}")
    try:
        value = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"herdr {' '.join(args)} returned invalid JSON") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"herdr {' '.join(args)} returned a non-object response")
    return value


def labels_config() -> dict[str, str]:
    default_path = ROOT / "default-icons.json"
    config_dir = os.environ.get("HERDR_PLUGIN_CONFIG_DIR")
    custom_path = Path(config_dir) / "icons.json" if config_dir else None
    paths = [default_path]
    if custom_path is not None and custom_path.exists() and custom_path != default_path:
        paths.append(custom_path)

    labels: dict[str, str] = {}
    for path in paths:
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError(f"{path}: expected a JSON object")
        for key, entry in value.items():
            if not isinstance(key, str) or not key or not isinstance(entry, dict):
                raise ValueError(f"{path}: every Agent entry must be a named object")
            label = entry.get("label")
            if not isinstance(label, str) or not label.strip():
                raise ValueError(f"{path}: {key}.label must be a non-empty string")
            label = label.strip()
            if len(label) > 40 or any(ord(point) < 32 or ord(point) == 127 for point in label):
                raise ValueError(f"{path}: {key}.label is invalid")
            labels[key] = label
    return labels


def panes(_all_panes: bool = False) -> list[dict[str, Any]]:
    """Read every visible Agent; non-Agent panes intentionally stay out of scope."""
    payload = run_json("agent", "list")
    agents = payload.get("result", {}).get("agents", [])
    if not isinstance(agents, list):
        raise RuntimeError("herdr agent list returned invalid data")
    return [pane for pane in agents if isinstance(pane, dict)]


def pane_key(pane: dict[str, Any]) -> str | None:
    terminal_id = pane.get("terminal_id")
    pane_id = pane.get("pane_id")
    if isinstance(terminal_id, str) and terminal_id:
        return f"terminal:{terminal_id}"
    if isinstance(pane_id, str) and pane_id:
        return f"pane:{pane_id}"
    return None


def workspace_context() -> tuple[dict[str, str], dict[str, str]]:
    try:
        payload = run_json("workspace", "list")
    except (OSError, RuntimeError):
        return {}, {}
    rows = payload.get("result", {}).get("workspaces")
    if not isinstance(rows, list):
        return {}, {}
    labels: dict[str, str] = {}
    worktrees: dict[str, str] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        workspace_id = row.get("workspace_id")
        label = _clean_label(row.get("label"))
        if not isinstance(workspace_id, str) or not workspace_id:
            continue
        if label:
            labels[workspace_id] = label
        worktree = row.get("worktree")
        if not isinstance(worktree, dict) or worktree.get("is_linked_worktree") is not True:
            continue
        checkout = worktree.get("checkout_path")
        if isinstance(checkout, str) and (name := Path(checkout).name):
            worktrees[workspace_id] = name
    return labels, worktrees


def tab_context(workspace_ids: set[str]) -> dict[str, dict[str, Any]]:
    tabs: dict[str, dict[str, Any]] = {}
    for workspace_id in workspace_ids:
        try:
            payload = run_json("tab", "list", "--workspace", workspace_id)
        except (OSError, RuntimeError):
            continue
        rows = payload.get("result", {}).get("tabs")
        if not isinstance(rows, list):
            continue
        for index, row in enumerate(row for row in rows if isinstance(row, dict)):
            tab_id = row.get("tab_id")
            label = _clean_label(row.get("label"))
            if isinstance(tab_id, str) and label:
                tabs[tab_id] = {"label": label, "auto": label == str(index + 1)}
    return tabs


def pane_context(workspace_ids: set[str]) -> tuple[dict[str, str], dict[str, int]]:
    labels: dict[str, str] = {}
    order: dict[str, int] = {}
    position = 0
    for workspace_id in workspace_ids:
        try:
            payload = run_json("pane", "list", "--workspace", workspace_id)
        except (OSError, RuntimeError):
            continue
        rows = payload.get("result", {}).get("panes")
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("pane_id"), str):
                continue
            pane_id = row["pane_id"]
            order[pane_id] = position
            position += 1
            if label := _clean_label(row.get("label")):
                labels[pane_id] = label
    return labels, order


def sidebar_widths(current_panes: list[dict[str, Any]]) -> dict[str, int | None]:
    workspace_ids = {
        workspace_id
        for pane in current_panes
        if isinstance((workspace_id := pane.get("workspace_id")), str) and workspace_id
    }
    try:
        payload = run_json("api", "snapshot")
    except (OSError, RuntimeError):
        return {workspace_id: None for workspace_id in workspace_ids}
    return {workspace_id: sidebar_width(payload, workspace_id) for workspace_id in workspace_ids}


def _clean_label(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or any(ord(point) < 32 or ord(point) == 127 for point in value):
        return None
    return value


def agent_type_label(pane: dict[str, Any], labels: dict[str, str]) -> str | None:
    agent = pane.get("agent")
    if not isinstance(agent, str) or not agent:
        return _clean_label(pane.get("display_agent")) or _clean_label(pane.get("name"))
    key = agent.lower().replace("-", "_").replace(" ", "_")
    return labels.get(key) or _clean_label(pane.get("display_agent")) or agent


def identity_leaf(
    pane: dict[str, Any],
    pane_labels: dict[str, str],
    labels: dict[str, str],
) -> str | None:
    pane_id = pane.get("pane_id")
    manual_pane = pane_labels.get(pane_id) if isinstance(pane_id, str) else None
    return manual_pane or _clean_label(pane.get("name")) or agent_type_label(pane, labels)


def agent_locations(
    current_panes: list[dict[str, Any]],
    labels: dict[str, str],
    workspace_labels: dict[str, str],
    tabs: dict[str, dict[str, Any]],
    pane_labels: dict[str, str],
    pane_order: dict[str, int],
    widths: dict[str, int | None],
) -> dict[str, tuple[str, str]]:
    visible_workspaces = {
        workspace_id
        for pane in current_panes
        if isinstance((workspace_id := pane.get("workspace_id")), str)
    }
    visible_tabs: dict[str, set[str]] = {}
    leaves: dict[str, str] = {}
    for pane in current_panes:
        key = pane_key(pane)
        workspace_id = pane.get("workspace_id")
        tab_id = pane.get("tab_id")
        leaf = identity_leaf(pane, pane_labels, labels)
        if key is None or not isinstance(workspace_id, str) or not isinstance(tab_id, str) or leaf is None:
            continue
        leaves[key] = leaf
        visible_tabs.setdefault(workspace_id, set()).add(tab_id)

    parents_by_key: dict[str, list[str]] = {}
    groups: dict[tuple[str, ...], list[dict[str, Any]]] = {}
    for pane in current_panes:
        key = pane_key(pane)
        workspace_id = pane.get("workspace_id")
        tab_id = pane.get("tab_id")
        if key is None or key not in leaves or not isinstance(workspace_id, str) or not isinstance(tab_id, str):
            continue
        parents: list[str] = []
        if len(visible_workspaces) > 1 and (workspace := workspace_labels.get(workspace_id)):
            parents.append(workspace)
        tab = tabs.get(tab_id)
        if not parents and tab and (tab.get("auto") is False or len(visible_tabs.get(workspace_id, set())) > 1):
            if isinstance(tab.get("label"), str):
                parents.append(tab["label"])
        parents_by_key[key] = parents
        rendered_path = (*[parent.casefold() for parent in parents], leaves[key].casefold())
        groups.setdefault(rendered_path, []).append(pane)

    ordinals: dict[str, int] = {}
    for group in groups.values():
        if len(group) < 2:
            continue
        group.sort(key=lambda pane: (
            str(pane.get("workspace_id", "")),
            str(pane.get("tab_id", "")),
            pane_order.get(str(pane.get("pane_id")), sys.maxsize),
        ))
        for ordinal, pane in enumerate(group, 1):
            if key := pane_key(pane):
                ordinals[key] = ordinal

    locations: dict[str, tuple[str, str]] = {}
    for pane in current_panes:
        key = pane_key(pane)
        workspace_id = pane.get("workspace_id")
        tab_id = pane.get("tab_id")
        if key is None or key not in leaves or not isinstance(workspace_id, str) or not isinstance(tab_id, str):
            continue
        leaf = leaves[key]
        display_leaf = f"{leaf} {ordinals[key]}" if key in ordinals else leaf
        location = compose_path(parents_by_key.get(key, []), display_leaf, widths.get(workspace_id))
        if location:
            locations[key] = (location, leaf)
    return locations


def parse_worktree_roots(listing: str) -> list[Path]:
    roots: list[Path] = []
    for line in listing.splitlines():
        if not line.startswith("worktree "):
            continue
        path = Path(line.removeprefix("worktree "))
        if not path.is_absolute():
            return []
        roots.append(path.resolve())
    return roots


def root_for_cwd(cwd: Path, roots: list[Path]) -> Path | None:
    matches = [root for root in roots if cwd == root or root in cwd.parents]
    return max(matches, key=lambda path: len(path.parts)) if matches else None


def linked_worktree_basenames(
    current_panes: list[dict[str, Any]],
    workspace_worktrees: dict[str, str] | None = None,
) -> dict[str, str]:
    """Resolve Pane cwd first, then fall back to the Workspace's linked worktree."""
    catalogs: list[list[Path]] = []
    resolved: dict[str, str] = {}
    for pane in current_panes:
        key = pane_key(pane)
        workspace_id = pane.get("workspace_id")
        cwd_raw = pane.get("foreground_cwd") or pane.get("cwd")
        if key is None:
            continue
        if isinstance(cwd_raw, str) and Path(cwd_raw).is_absolute():
            cwd = Path(cwd_raw).resolve()
            roots = next((roots for roots in catalogs if root_for_cwd(cwd, roots)), None)
            if roots is None:
                try:
                    completed = subprocess.run(
                        ["git", "-C", str(cwd), "worktree", "list", "--porcelain"],
                        text=True,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL,
                        check=False,
                    )
                except OSError:
                    completed = None
                roots = (
                    parse_worktree_roots(completed.stdout)
                    if completed is not None and completed.returncode == 0
                    else []
                )
                if roots:
                    catalogs.append(roots)
            selected = root_for_cwd(cwd, roots)
            if selected is not None and roots and selected != roots[0] and selected.name:
                resolved[key] = selected.name
        if key not in resolved and isinstance(workspace_id, str) and workspace_worktrees:
            if fallback := workspace_worktrees.get(workspace_id):
                resolved[key] = fallback
    return resolved


def load_state() -> dict[str, dict[str, Any]]:
    try:
        value = json.loads(state_path().read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}
    panes_state = value.get("panes") if isinstance(value, dict) and value.get("version") == STATE_VERSION else None
    return {
        key: entry
        for key, entry in panes_state.items()
        if isinstance(key, str) and isinstance(entry, dict)
    } if isinstance(panes_state, dict) else {}


def save_state(entries: dict[str, dict[str, Any]]) -> None:
    directory = state_dir()
    directory.mkdir(parents=True, exist_ok=True)
    temporary = state_path().with_suffix(f".tmp.{os.getpid()}")
    try:
        temporary.write_text(
            json.dumps({"version": STATE_VERSION, "panes": entries}, separators=(",", ":")),
            encoding="utf-8",
        )
        temporary.replace(state_path())
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def update_activity_state(entries: dict[str, dict[str, Any]], pane: dict[str, Any], now_ms: int) -> int:
    key = pane_key(pane)
    status = pane.get("agent_status")
    if key is None or not isinstance(status, str) or not status:
        return now_ms
    previous = entries.get(key)
    since_ms = previous.get("since_ms") if isinstance(previous, dict) else None
    if (
        previous is None
        or previous.get("status") != status
        or not isinstance(since_ms, int)
        or since_ms < 0
        or since_ms > now_ms
    ):
        entries[key] = {
            **(previous if isinstance(previous, dict) else {}),
            "status": status,
            "since_ms": now_ms,
        }
        return now_ms
    return since_ms


def prune_state(entries: dict[str, dict[str, Any]], current_panes: list[dict[str, Any]], now_ms: int) -> None:
    live = {key for pane in current_panes if (key := pane_key(pane)) is not None}
    for key, entry in list(entries.items()):
        if key in live:
            entry.pop("missing_since_ms", None)
            continue
        missing_since = entry.get("missing_since_ms")
        if not isinstance(missing_since, int) or missing_since > now_ms:
            entry["missing_since_ms"] = now_ms
        elif now_ms - missing_since >= PRUNE_GRACE_MS:
            del entries[key]


def format_elapsed(milliseconds: int) -> str:
    seconds = max(0, milliseconds // 1_000)
    if seconds < 60:
        return "<1m"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes}m"
    hours, minutes = divmod(minutes, 60)
    if hours < 24:
        return f"{hours}h {minutes:02d}m"
    days, hours = divmod(hours, 24)
    return f"{days}d {hours:02d}h"


def terminal_title(pane: dict[str, Any]) -> str | None:
    return _clean_label(pane.get("terminal_title_stripped")) or _clean_label(pane.get("terminal_title"))


def agent_session_key(pane: dict[str, Any]) -> str | None:
    session = pane.get("agent_session")
    if not isinstance(session, dict):
        return None
    identity = {
        key: session.get(key)
        for key in ("source", "agent", "kind", "value")
        if isinstance(session.get(key), str) and session.get(key)
    }
    return json.dumps(identity, sort_keys=True, separators=(",", ":")) if identity else None


def current_activity_title(
    pane: dict[str, Any],
    entry: dict[str, Any],
    identity: str,
) -> str | None:
    title = terminal_title(pane)
    session_key = agent_session_key(pane)
    previous_session = entry.get("agent_session_key")
    previous_title = entry.get("last_terminal_title")
    if session_key and isinstance(previous_session, str) and previous_session != session_key:
        baseline = previous_title if isinstance(previous_title, str) and previous_title else title
        if baseline:
            entry["title_baseline"] = baseline
        else:
            entry.pop("title_baseline", None)
    if session_key:
        entry["agent_session_key"] = session_key
    baseline = entry.get("title_baseline")
    if isinstance(baseline, str):
        if title is None or title == baseline:
            if title:
                entry["last_terminal_title"] = title
            return None
        entry.pop("title_baseline", None)
    if title:
        entry["last_terminal_title"] = title
    if not title or title.casefold() == identity.casefold():
        return None
    cwd = pane.get("foreground_cwd") or pane.get("cwd")
    project = Path(cwd).name if isinstance(cwd, str) else ""
    if project and session_key is None and project.casefold() == title.casefold():
        return None
    agent = pane.get("agent")
    if (
        project
        and isinstance(agent, str)
        and agent.casefold() == "pi"
        and title.casefold() == f"π - {project}".casefold()
    ):
        return None
    return title


def presentation_tokens(
    location: str | None,
    activity_title: str | None,
    worktree: str | None,
    width: int | None,
    active: bool = False,
) -> dict[str, str]:
    context_width = max(0, width - 2) if width is not None else None
    display_title = f"▸ {activity_title}" if activity_title else None
    display_context = f"⎇ {worktree}" if worktree else None
    location_token = "agent_location_active" if active else "agent_location"
    title_token = "agent_title_active" if active else "agent_title"
    context_token = "agent_context_active" if active else "agent_context"
    return {
        **({location_token: location} if location else {}),
        **({title_token: truncate_display(display_title, context_width) if context_width is not None else display_title} if display_title else {}),
        **({context_token: truncate_display(display_context, context_width) if context_width is not None else display_context} if display_context else {}),
    }


def state_labels(agent_label: str, status: str, elapsed: str) -> dict[str, str]:
    return {
        state: f"{agent_label} · {state} {elapsed if state == status else '<1m'}"
        for state in dict.fromkeys((*AGENT_STATES, status))
    }


def report(
    pane: dict[str, Any],
    labels: dict[str, str],
    location: str | None,
    identity: str | None,
    worktree: str | None,
    width: int | None,
    state: dict[str, dict[str, Any]],
    now_ms: int,
) -> bool:
    pane_id = pane.get("pane_id")
    status = pane.get("agent_status")
    agent_label = agent_type_label(pane, labels)
    key = pane_key(pane)
    if not isinstance(pane_id, str) or not isinstance(status, str) or agent_label is None or key is None:
        return False
    since_ms = update_activity_state(state, pane, now_ms)
    entry = state[key]
    activity_title = current_activity_title(pane, entry, identity or agent_label)
    elapsed = format_elapsed(now_ms - since_ms)
    rendered = presentation_tokens(location, activity_title, worktree, width, pane.get("focused") is True)
    rendered_states = state_labels(agent_label, status, elapsed)
    fingerprint = json.dumps({"tokens": rendered, "states": rendered_states}, sort_keys=True, ensure_ascii=False)
    if entry.get("fingerprint") == fingerprint:
        return False

    command = [herdr_bin(), "pane", "report-metadata", pane_id, "--source", SOURCE_ID]
    for state_name, value in rendered_states.items():
        command.extend(("--state-label", f"{state_name}={value}"))
    for token in (
        "agent_location",
        "agent_location_active",
        "agent_title",
        "agent_title_active",
        "agent_context",
        "agent_context_active",
    ):
        value = rendered.get(token)
        command.extend(("--token", f"{token}={value}")) if value else command.extend(("--clear-token", token))
    for token in CLEAR_TOKENS:
        command.extend(("--clear-token", token))
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    entry["fingerprint"] = fingerprint
    return True


def refresh(all_panes: bool = False, *, now_ms: int | None = None) -> int:
    failures: list[str] = []
    try:
        labels = labels_config()
        current_panes = panes(all_panes)
        visible_workspace_ids = {
            workspace_id
            for pane in current_panes
            if isinstance((workspace_id := pane.get("workspace_id")), str)
        }
        workspace_labels, workspace_worktrees = workspace_context()
        tabs = tab_context(visible_workspace_ids)
        pane_labels, pane_order = pane_context(visible_workspace_ids)
        widths = sidebar_widths(current_panes)
        locations = agent_locations(
            current_panes,
            labels,
            workspace_labels,
            tabs,
            pane_labels,
            pane_order,
            widths,
        )
        worktrees = linked_worktree_basenames(current_panes, workspace_worktrees)
        directory = state_dir()
        directory.mkdir(parents=True, exist_ok=True)
        with (directory / "state.lock").open("w", encoding="utf-8") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            state = load_state()
            before = json.dumps(state, sort_keys=True)
            current_time = now_ms if now_ms is not None else time.time_ns() // 1_000_000
            prune_state(state, current_panes, current_time)
            updated = 0
            for pane in current_panes:
                try:
                    key = pane_key(pane)
                    workspace_id = pane.get("workspace_id")
                    location, identity = locations.get(key, (None, None)) if key else (None, None)
                    updated += int(report(
                        pane,
                        labels,
                        location,
                        identity,
                        worktrees.get(key) if key else None,
                        widths.get(workspace_id) if isinstance(workspace_id, str) else None,
                        state,
                        current_time,
                    ))
                except (OSError, subprocess.CalledProcessError) as error:
                    pane_id = pane.get("pane_id", "unknown")
                    detail = error.stderr.strip() if isinstance(error, subprocess.CalledProcessError) and error.stderr else str(error)
                    failures.append(f"pane {pane_id}: {detail}")
            if json.dumps(state, sort_keys=True) != before:
                save_state(state)
        if failures:
            print("agent activity: " + "; ".join(failures), file=sys.stderr)
            return 1
        print(f"agent activity refreshed {updated} pane(s)")
        return 0
    except (OSError, ValueError, RuntimeError) as error:
        print(f"agent activity: {error}", file=sys.stderr)
        return 1


def append_watch_error(message: str) -> None:
    directory = state_dir()
    directory.mkdir(parents=True, exist_ok=True)
    log = directory / "activity-errors.log"
    previous = ""
    try:
        previous = log.read_text(encoding="utf-8")[-16_000:]
    except (FileNotFoundError, OSError):
        pass
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    log.write_text(f"{previous}{stamp} {message}\n", encoding="utf-8")


def script_signature(path: Path) -> tuple[int, int]:
    stat = path.stat()
    return stat.st_mtime_ns, stat.st_size


def script_is_loadable(path: Path) -> bool:
    try:
        py_compile.compile(str(path), doraise=True)
        return True
    except (OSError, py_compile.PyCompileError):
        return False


def watch(*, sleep: Callable[[float], None] = time.sleep) -> int:
    directory = state_dir()
    directory.mkdir(parents=True, exist_ok=True)
    script = Path(__file__).resolve()
    initial_signature = script_signature(script)
    pending_signature: tuple[int, int] | None = None
    consecutive_failures = 0
    with (directory / "activity.lock").open("w", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        while True:
            try:
                result = refresh(all_panes=True)
            except Exception as error:
                result = 1
                try:
                    append_watch_error(f"unexpected refresh failure: {error}")
                except OSError:
                    pass
            consecutive_failures = 0 if result == 0 else consecutive_failures + 1
            if consecutive_failures >= MAX_CONSECUTIVE_REFRESH_FAILURES:
                return 1
            sleep(REFRESH_SECONDS)
            try:
                current = script_signature(script)
                if current == initial_signature:
                    pending_signature = None
                elif current == pending_signature and script_is_loadable(script):
                    os.execv(sys.executable, [sys.executable, str(script), "--watch"])
                else:
                    pending_signature = current
            except OSError as error:
                try:
                    append_watch_error(f"script reload check failed: {error}")
                except OSError:
                    pass


def ensure_watcher() -> None:
    directory = state_dir()
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "activity.lock").open("w", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
    subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "--watch"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--watch", action="store_true")
    parser.add_argument("--no-watch", action="store_true")
    args = parser.parse_args()
    if args.watch:
        return watch()
    result = refresh(all_panes=False)
    if not args.no_watch:
        ensure_watcher()
    return result


if __name__ == "__main__":
    raise SystemExit(main())
