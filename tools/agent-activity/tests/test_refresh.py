#!/usr/bin/env python3
import importlib.util
import json
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "refresh.py"
SIDEBAR_CONFIG_PATH = Path(__file__).resolve().parents[1] / "config" / "sidebar.toml"
MANIFEST_PATH = Path(__file__).resolve().parents[1] / "herdr-plugin.toml"
spec = importlib.util.spec_from_file_location("agent_activity_refresh", MODULE_PATH)
assert spec and spec.loader
refresh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refresh)


class FormattingTest(unittest.TestCase):
    def test_formats_elapsed_boundaries(self):
        self.assertEqual(refresh.format_elapsed(0), "<1m")
        self.assertEqual(refresh.format_elapsed(60_000), "1m")
        self.assertEqual(refresh.format_elapsed(3_723_000), "1h 02m")
        self.assertEqual(refresh.format_elapsed(90_000_000), "1d 01h")

    def test_counts_terminal_columns(self):
        self.assertEqual(refresh.display_width("A中🙂e\u0301"), 6)

    def test_path_drops_parents_before_head_truncating_leaf(self):
        self.assertEqual(refresh.compose_path(["workspace", "backend"], "Review API", 20), "backend · Review API")
        self.assertEqual(refresh.compose_path(["workspace", "backend"], "a-very-long-label", 8), "a-very-…")

    def test_sidebar_is_adaptive_four_rows(self):
        sidebar = tomllib.loads(SIDEBAR_CONFIG_PATH.read_text(encoding="utf-8"))
        self.assertEqual(
            sidebar["ui"]["sidebar"]["agents"]["rows"],
            [
                ["state_icon", "$agent_location"],
                ["$agent_title"],
                ["$agent_context"],
                ["state_text"],
            ],
        )


class AgentLocationTest(unittest.TestCase):
    def setUp(self):
        self.labels = {"claude": "Claude", "pi": "Pi"}
        self.tabs = {"t1": {"label": "1", "auto": True}}
        self.widths = {"w1": None, "w2": None}

    @staticmethod
    def pane(terminal: str, pane_id: str, workspace: str = "w1", tab: str = "t1", **extra):
        return {
            "terminal_id": terminal,
            "pane_id": pane_id,
            "workspace_id": workspace,
            "tab_id": tab,
            "agent": "pi",
            **extra,
        }

    def locations(self, panes, *, tabs=None, pane_labels=None, order=None, workspaces=None):
        return refresh.agent_locations(
            panes,
            self.labels,
            workspaces or {"w1": "repo", "w2": "docs"},
            tabs or self.tabs,
            pane_labels or {},
            order or {pane["pane_id"]: index for index, pane in enumerate(panes)},
            self.widths,
        )

    def test_single_visible_workspace_and_default_tab_are_hidden(self):
        pane = self.pane("a", "p1")
        self.assertEqual(self.locations([pane])["terminal:a"], ("Pi", "Pi"))

    def test_manual_pane_name_beats_agent_name_and_type(self):
        pane = self.pane("a", "p1", name="reviewer")
        self.assertEqual(
            self.locations([pane], pane_labels={"p1": "API review"})["terminal:a"],
            ("API review", "API review"),
        )

    def test_agent_name_beats_type_without_pane_name(self):
        pane = self.pane("a", "p1", name="reviewer")
        self.assertEqual(self.locations([pane])["terminal:a"], ("reviewer", "reviewer"))

    def test_custom_tab_is_always_a_prefix(self):
        pane = self.pane("a", "p1")
        tabs = {"t1": {"label": "backend", "auto": False}}
        self.assertEqual(self.locations([pane], tabs=tabs)["terminal:a"], ("backend · Pi", "Pi"))

    def test_default_tab_numbers_show_only_across_visible_agent_tabs(self):
        first = self.pane("a", "p1", tab="t1")
        second = self.pane("b", "p2", tab="t2")
        tabs = {
            "t1": {"label": "1", "auto": True},
            "t2": {"label": "2", "auto": True},
            "t3": {"label": "3", "auto": True},
        }
        locations = self.locations([first, second], tabs=tabs)
        self.assertEqual(locations["terminal:a"][0], "1 · Pi")
        self.assertEqual(locations["terminal:b"][0], "2 · Pi")
        self.assertEqual(self.locations([first], tabs=tabs)["terminal:a"][0], "Pi")

    def test_workspace_prefix_uses_only_visible_agent_workspaces(self):
        first = self.pane("a", "p1", workspace="w1")
        second = self.pane("b", "p2", workspace="w2")
        locations = self.locations([first, second])
        self.assertEqual(locations["terminal:a"][0], "repo · Pi")
        self.assertEqual(locations["terminal:b"][0], "docs · Pi")
        self.assertEqual(self.locations([first])["terminal:a"][0], "Pi")

    def test_workspace_prefix_suppresses_the_middle_tab_component(self):
        first = self.pane("a", "p1", workspace="w1", tab="t1")
        second = self.pane("b", "p2", workspace="w2", tab="t2")
        tabs = {
            "t1": {"label": "backend", "auto": False},
            "t2": {"label": "frontend", "auto": False},
        }
        locations = self.locations([first, second], tabs=tabs)
        self.assertEqual(locations["terminal:a"][0], "repo · Pi")
        self.assertEqual(locations["terminal:b"][0], "docs · Pi")

    def test_same_scope_collisions_get_structural_ordinals(self):
        first = self.pane("a", "p1")
        second = self.pane("b", "p2")
        locations = self.locations([second, first], order={"p1": 0, "p2": 1})
        self.assertEqual(locations["terminal:a"][0], "Pi 1")
        self.assertEqual(locations["terminal:b"][0], "Pi 2")

    def test_duplicate_manual_names_also_get_ordinals(self):
        first = self.pane("a", "p1")
        second = self.pane("b", "p2")
        locations = self.locations([first, second], pane_labels={"p1": "server", "p2": "server"})
        self.assertEqual(locations["terminal:a"][0], "server 1")
        self.assertEqual(locations["terminal:b"][0], "server 2")

    def test_duplicate_rendered_tab_paths_get_ordinals(self):
        first = self.pane("a", "p1", tab="t1")
        second = self.pane("b", "p2", tab="t2")
        tabs = {
            "t1": {"label": "backend", "auto": False},
            "t2": {"label": "backend", "auto": False},
        }
        locations = self.locations([first, second], tabs=tabs)
        self.assertEqual(locations["terminal:a"][0], "backend · Pi 1")
        self.assertEqual(locations["terminal:b"][0], "backend · Pi 2")

    def test_former_dispatch_tokens_do_not_affect_identity(self):
        pane = self.pane("a", "p1", tokens={"pane_role_key": "reviewer", "dispatch_subject": "obsolete"})
        self.assertEqual(self.locations([pane])["terminal:a"], ("Pi", "Pi"))


class TitleAndPresentationTest(unittest.TestCase):
    @staticmethod
    def session(value: str):
        return {"source": "herdr:pi", "agent": "pi", "kind": "path", "value": value}

    def test_native_title_and_worktree_use_optional_rows(self):
        self.assertEqual(
            refresh.presentation_tokens("Pi", "Latest question", "fix-api", 30),
            {"agent_location": "Pi", "agent_title": "▸ Latest question", "agent_context": "⎇ fix-api"},
        )

    def test_same_session_updates_title(self):
        entry = {}
        pane = {"terminal_title_stripped": "First", "agent_session": self.session("s1")}
        self.assertEqual(refresh.current_activity_title(pane, entry, "Pi"), "First")
        pane["terminal_title_stripped"] = "Latest"
        self.assertEqual(refresh.current_activity_title(pane, entry, "Pi"), "Latest")

    def test_new_session_suppresses_inherited_title_until_it_changes(self):
        entry = {}
        old = {"terminal_title_stripped": "Old task", "agent_session": self.session("s1")}
        self.assertEqual(refresh.current_activity_title(old, entry, "Pi"), "Old task")
        new = {"terminal_title_stripped": "Old task", "agent_session": self.session("s2")}
        self.assertIsNone(refresh.current_activity_title(new, entry, "Pi"))
        new["terminal_title_stripped"] = "New task"
        self.assertEqual(refresh.current_activity_title(new, entry, "Pi"), "New task")

    def test_new_session_can_show_a_title_already_changed_by_the_agent(self):
        entry = {}
        old = {"terminal_title_stripped": "Old task", "agent_session": self.session("s1")}
        refresh.current_activity_title(old, entry, "Pi")
        new = {"terminal_title_stripped": "New task", "agent_session": self.session("s2")}
        self.assertEqual(refresh.current_activity_title(new, entry, "Pi"), "New task")

    def test_duplicate_identity_title_is_hidden(self):
        entry = {}
        pane = {"terminal_title_stripped": "Pi"}
        self.assertIsNone(refresh.current_activity_title(pane, entry, "Pi"))

    def test_project_directory_title_is_not_a_session_title(self):
        entry = {}
        pane = {
            "terminal_title_stripped": "pi-packages",
            "cwd": "/home/jack/projects/pi-packages",
        }
        self.assertIsNone(refresh.current_activity_title(pane, entry, "Codex"))

    def test_pi_default_project_title_is_not_a_session_title(self):
        entry = {}
        pane = {
            "agent": "pi",
            "terminal_title_stripped": "π - pi-packages",
            "cwd": "/home/jack/projects/pi-packages",
            "agent_session": self.session("s1"),
        }
        self.assertIsNone(refresh.current_activity_title(pane, entry, "Pi"))

    def test_state_row_always_names_real_agent_type(self):
        labels = refresh.state_labels("Claude", "working", "4m")
        self.assertEqual(labels["working"], "Claude · working 4m")
        self.assertEqual(labels["done"], "Claude · done <1m")

    def test_cursor_uses_title_case_label(self):
        self.assertEqual(refresh.labels_config()["cursor"], "Cursor")

    def test_custom_labels_overlay_defaults_instead_of_hiding_new_agents(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "icons.json").write_text(
                json.dumps({"pi": {"label": "Custom Pi"}}),
                encoding="utf-8",
            )
            with patch.dict(refresh.os.environ, {"HERDR_PLUGIN_CONFIG_DIR": directory}):
                labels = refresh.labels_config()
        self.assertEqual(labels["pi"], "Custom Pi")
        self.assertEqual(labels["cursor"], "Cursor")


class WidthTest(unittest.TestCase):
    def test_reads_one_consistent_sidebar_width(self):
        snapshot = {"result": {"snapshot": {"layouts": [
            {"workspace_id": "w1", "area": {"x": 25}},
            {"workspace_id": "w1", "area": {"x": 25}},
        ]}}}
        self.assertEqual(refresh.sidebar_width(snapshot, "w1"), 22)

    def test_missing_or_inconsistent_width_fails_safe(self):
        self.assertIsNone(refresh.sidebar_width({}, "w1"))
        snapshot = {"result": {"snapshot": {"layouts": [
            {"workspace_id": "w1", "area": {"x": 25}},
            {"workspace_id": "w1", "area": {"x": 30}},
        ]}}}
        self.assertIsNone(refresh.sidebar_width(snapshot, "w1"))


class WorktreeTest(unittest.TestCase):
    def test_hides_main_checkout_and_finds_linked_worktree(self):
        listing = "worktree /repo\nHEAD abc\n\nworktree /repo.worktrees/fix-api\nHEAD def\n"
        roots = refresh.parse_worktree_roots(listing)
        self.assertEqual(refresh.root_for_cwd(Path("/repo/src"), roots), Path("/repo"))
        self.assertEqual(
            refresh.root_for_cwd(Path("/repo.worktrees/fix-api/src"), roots),
            Path("/repo.worktrees/fix-api"),
        )

    def test_queries_git_once_for_panes_in_same_repository(self):
        panes = [
            {"terminal_id": "t1", "cwd": "/repo.worktrees/a"},
            {"terminal_id": "t2", "foreground_cwd": "/repo.worktrees/a/src"},
        ]
        completed = subprocess.CompletedProcess([], 0, "worktree /repo\n\nworktree /repo.worktrees/a\n", "")
        with patch.object(refresh.subprocess, "run", return_value=completed) as run:
            self.assertEqual(
                refresh.linked_worktree_basenames(panes),
                {"terminal:t1": "a", "terminal:t2": "a"},
            )
        self.assertEqual(run.call_count, 1)

    def test_workspace_linked_worktree_is_a_fallback(self):
        pane = {"terminal_id": "t1", "workspace_id": "w1", "cwd": "/outside"}
        failed = subprocess.CompletedProcess([], 1, "", "")
        with patch.object(refresh.subprocess, "run", return_value=failed):
            self.assertEqual(refresh.linked_worktree_basenames([pane], {"w1": "fix-api"}), {"terminal:t1": "fix-api"})


class ActivityStateTest(unittest.TestCase):
    def test_timestamp_changes_only_when_status_changes(self):
        state = {}
        pane = {"terminal_id": "t1", "agent_status": "working"}
        self.assertEqual(refresh.update_activity_state(state, pane, 100), 100)
        self.assertEqual(refresh.update_activity_state(state, pane, 200), 100)
        pane["agent_status"] = "idle"
        self.assertEqual(refresh.update_activity_state(state, pane, 300), 300)

    def test_status_change_preserves_session_title_state(self):
        pane = {"terminal_id": "t1", "agent_status": "idle"}
        state = {"terminal:t1": {"status": "working", "since_ms": 100, "agent_session_key": "s1"}}
        refresh.update_activity_state(state, pane, 200)
        self.assertEqual(state["terminal:t1"]["agent_session_key"], "s1")

    def test_terminal_identity_survives_pane_move(self):
        state = {}
        refresh.update_activity_state(state, {"terminal_id": "t1", "pane_id": "p1", "agent_status": "working"}, 100)
        self.assertEqual(
            refresh.update_activity_state(state, {"terminal_id": "t1", "pane_id": "p9", "agent_status": "working"}, 200),
            100,
        )

    def test_prunes_missing_terminal_after_grace(self):
        state = {"terminal:t1": {"status": "idle", "since_ms": 0}}
        refresh.prune_state(state, [], 100)
        self.assertIn("terminal:t1", state)
        refresh.prune_state(state, [], 100 + refresh.PRUNE_GRACE_MS)
        self.assertNotIn("terminal:t1", state)


class ReportTest(unittest.TestCase):
    def setUp(self):
        self.pane = {
            "pane_id": "p1",
            "terminal_id": "t1",
            "agent": "claude",
            "agent_status": "working",
        }

    def test_reports_native_fields_and_clears_old_tokens(self):
        state = {}
        with patch.object(refresh.subprocess, "run") as run:
            self.assertTrue(refresh.report(
                self.pane, {"claude": "Claude"}, "repo · reviewer", "reviewer", "fix-api", 30, state, 60_000
            ))
        command = run.call_args.args[0]
        self.assertIn("agent_location=repo · reviewer", command)
        self.assertIn("agent_context=⎇ fix-api", command)
        for old in ("agent_task", "agent_subject", "agent_name"):
            self.assertIn(old, command)
        self.assertNotIn("pane_role_key", " ".join(command))

    def test_skips_report_when_visible_output_is_unchanged(self):
        state = {}
        with patch.object(refresh.subprocess, "run") as run:
            self.assertTrue(refresh.report(self.pane, {"claude": "Claude"}, "Claude", "Claude", None, 30, state, 1_000))
            self.assertFalse(refresh.report(self.pane, {"claude": "Claude"}, "Claude", "Claude", None, 30, state, 30_000))
        self.assertEqual(run.call_count, 1)

    def test_reports_again_when_displayed_minute_changes(self):
        state = {}
        with patch.object(refresh.subprocess, "run") as run:
            refresh.report(self.pane, {"claude": "Claude"}, "Claude", "Claude", None, 30, state, 1_000)
            refresh.report(self.pane, {"claude": "Claude"}, "Claude", "Claude", None, 30, state, 61_000)
        self.assertEqual(run.call_count, 2)


class ScopeQueryFailureTest(unittest.TestCase):
    def test_missing_workspace_does_not_discard_other_tab_context(self):
        healthy = {"result": {"tabs": [{"tab_id": "t1", "label": "1"}]}}

        def response(*args):
            if args[-1] == "gone":
                raise RuntimeError("workspace_not_found")
            return healthy

        with patch.object(refresh, "run_json", side_effect=response):
            self.assertEqual(
                refresh.tab_context({"gone", "healthy"}),
                {"t1": {"label": "1", "auto": True}},
            )

    def test_missing_workspace_does_not_discard_other_pane_context(self):
        healthy = {"result": {"panes": [{"pane_id": "p1", "label": "reviewer"}]}}

        def response(*args):
            if args[-1] == "gone":
                raise RuntimeError("workspace_not_found")
            return healthy

        with patch.object(refresh, "run_json", side_effect=response):
            labels, order = refresh.pane_context({"gone", "healthy"})
        self.assertEqual(labels, {"p1": "reviewer"})
        self.assertEqual(order, {"p1": 0})


class SelectionAndPersistenceTest(unittest.TestCase):
    def test_event_refresh_still_reads_all_agents_for_scope_and_collisions(self):
        response = {"result": {"agents": [{"pane_id": "p1"}]}}
        with patch.dict(refresh.os.environ, {"HERDR_PLUGIN_EVENT": "{}"}, clear=False), patch.object(
            refresh, "run_json", return_value=response
        ) as run:
            self.assertEqual(refresh.panes(), [{"pane_id": "p1"}])
        run.assert_called_once_with("agent", "list")

    def test_state_round_trip_is_versioned(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(refresh, "state_dir", return_value=Path(directory)):
            state = {"terminal:t1": {"status": "idle", "since_ms": 123}}
            refresh.save_state(state)
            self.assertEqual(refresh.load_state(), state)
            payload = json.loads((Path(directory) / "activity-state.json").read_text())
            self.assertEqual(payload["version"], 4)

    def test_invalid_label_config_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "icons.json").write_text('{"claude":{"label":""}}')
            with patch.dict(refresh.os.environ, {"HERDR_PLUGIN_CONFIG_DIR": directory}, clear=False):
                with self.assertRaises(ValueError):
                    refresh.labels_config()


class WatcherAndManifestTest(unittest.TestCase):
    def test_refresh_interval_is_fifteen_seconds(self):
        self.assertEqual(refresh.REFRESH_SECONDS, 15)

    def test_manifest_covers_scope_changing_events(self):
        manifest = tomllib.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        events = {event["on"] for event in manifest["events"]}
        self.assertTrue({"workspace.renamed", "tab.renamed", "pane.moved", "pane.agent_detected"} <= events)

    def test_watcher_exits_after_sustained_failures(self):
        sleeps = []
        with tempfile.TemporaryDirectory() as directory, patch.object(refresh, "state_dir", return_value=Path(directory)), patch.object(
            refresh, "refresh", return_value=1
        ), patch.object(refresh, "script_signature", return_value=(1, 1)):
            result = refresh.watch(sleep=lambda seconds: sleeps.append(seconds))
        self.assertEqual(result, 1)
        self.assertEqual(sleeps, [15, 15, 15])


if __name__ == "__main__":
    unittest.main()
