#!/usr/bin/env python3
"""Tests for R3: deterministic feature shards, profile aggregation, deletion, precedence, CLI."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PYTHON = ROOT / ".venv" / "bin" / "python"
if str(ROOT / "python") not in sys.path:
    sys.path.insert(0, str(ROOT / "python"))

from ffsrecord.features import feature_from_frames  # noqa: E402
from ffsrecord.lifecycle import PreferenceError, read_events, record_action  # noqa: E402
from ffsrecord.policy import load_policy, policy_path, preferences_dir  # noqa: E402
from ffsrecord.precedence import resolve  # noqa: E402
from ffsrecord.profile import read_profile, recompute  # noqa: E402

NOW = "2026-11-13T12:00:00+00:00"
START = "2026-11-13T10:00:00+00:00"
END = "2026-11-13T10:05:00+00:00"


def frames(session_id: str, *, commands: list[tuple[str, str]] | None = None, agent: int = 0,
           restored: bool = False, marks: int = 0, category: str = "display") -> list[dict]:
    out = [
        {"schema": "ffs-inspection/1", "frame": "session.start", "seq": 1, "sessionId": session_id,
         "ts": START, "restored": restored, "context": {"project": {"task": "rest", "modality": "func", "stage": "qc"}}},
    ]
    seq = 2
    for name, line in (commands or []):
        out.append({"schema": "ffs-inspection/1", "frame": "event", "seq": seq, "sessionId": session_id,
                    "ts": START, "origin": "ui", "command": {"line": line, "name": name, "category": category},
                    "semantic": _semantic(name, line)})
        seq += 1
    for index in range(agent):
        out.append({"schema": "ffs-inspection/1", "frame": "event", "seq": seq, "sessionId": session_id,
                    "ts": START, "origin": "agent", "command": {"line": "SET_THEME dark", "name": "SET_THEME", "category": "display"},
                    "semantic": {"kind": "theme", "value": "dark"}})
        seq += 1
    for index in range(marks):
        out.append({"schema": "ffs-inspection/1", "frame": "mark", "seq": seq, "sessionId": session_id,
                    "ts": START, "text": f"mark {index}", "tags": ["qc"], "kind": "mark"})
        seq += 1
    out.append({"schema": "ffs-inspection/1", "frame": "session.end", "seq": seq, "sessionId": session_id, "ts": END})
    return out


def _semantic(name: str, line: str) -> dict:
    tokens = line.split()
    if name == "SET_THRESHOLD":
        return {"kind": "display", "command": name, "value": tokens[2:] or None}
    if name == "SET_ALPHA":
        return {"kind": "display", "command": name, "value": tokens[2:] or None}
    if name == "SET_COLORMAP":
        return {"kind": "display", "command": name, "value": tokens[2:] or None}
    return {"kind": "other"}


def write_session(state_dir: Path, session_id: str, **kwargs) -> Path:
    directory = state_dir / "inspection"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{session_id}.jsonl"
    path.write_text("\n".join(json.dumps(frame) for frame in frames(session_id, **kwargs)) + "\n", encoding="utf-8")
    return path


def preference(session_id: str = "pref") -> list[tuple[str, str]]:
    return [
        ("SET_THRESHOLD", "SET_THRESHOLD S 2.3"),
        ("SET_THRESHOLD", "SET_THRESHOLD S 2.3"),
        ("SET_THRESHOLD", "SET_THRESHOLD S 2.3"),
        ("SET_ALPHA", "SET_ALPHA S 0.4"),
        ("SET_ALPHA", "SET_ALPHA S 0.4"),
        ("SET_COLORMAP", "SET_COLORMAP S redblue"),
        ("SET_COLORMAP", "SET_COLORMAP S redblue"),
    ]


class FeatureTests(unittest.TestCase):
    def test_only_user_origin_feeds_behavior(self) -> None:
        shard = feature_from_frames(frames("insp-1", commands=preference(), agent=2, marks=1),
                                    project={"stage": "qc"})
        self.assertEqual(shard["schema"], "ffs-record-features/1")
        self.assertEqual(shard["originCounts"]["ui"], 7)
        self.assertEqual(shard["originCounts"]["agent"], 2)
        self.assertAlmostEqual(shard["behavioralWeight"], 0.778, places=3)
        self.assertEqual(shard["counts"]["byName"]["SET_THRESHOLD"], 3)
        self.assertEqual(shard["counts"]["marks"], 1)
        self.assertEqual(shard["settings"]["thresholdsSet"], [2.3, 2.3, 2.3])
        self.assertEqual(shard["settings"]["colormaps"], ["redblue", "redblue"])

    def test_restored_session_cannot_support(self) -> None:
        shard = feature_from_frames(frames("insp-restored", commands=preference(), restored=True))
        self.assertEqual(shard["behavioralWeight"], 0.0)
        self.assertEqual(shard["status"], "complete")

    def test_agent_heavy_session_cannot_support(self) -> None:
        shard = feature_from_frames(frames("insp-agent", commands=preference()[:2], agent=5))
        self.assertEqual(shard["behavioralWeight"], 0.0)


class ProfileTests(unittest.TestCase):
    def test_aggregation_statuses_and_scientific_gate(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            state_dir = project / ".ffs-viewer"
            for index in range(9):
                write_session(state_dir, f"insp-{index}", commands=preference())
            from ffsrecord.profile import ingest_sessions
            ingest_sessions(project, state_dir)
            profile = recompute(project, now=NOW)
            by_id = {record["id"]: record for record in profile["preferences"]}
            alpha = by_id["pref-alpha-0-4"]
            colormap = by_id["pref-colormap-redblue"]
            threshold = by_id["pref-threshold-2-3"]
            self.assertEqual(alpha["status"], "established")
            self.assertEqual(colormap["status"], "established")
            self.assertEqual(threshold["status"], "candidate")
            self.assertTrue(threshold["scientific"])
            self.assertTrue(threshold["confirmation"]["required"])
            self.assertEqual(alpha["scientific"], False)
            self.assertEqual(alpha["evidence"]["sessions"], 9)
            self.assertEqual(alpha["evidence"]["score"], 1.0)
            self.assertEqual(alpha["confidence"]["level"], "high")
            self.assertTrue(policy_path(project).exists())
            self.assertEqual(profile["stats"]["established"], 2)

    def test_recompute_is_deterministic_and_versions_only_on_change(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            state_dir = project / ".ffs-viewer"
            for index in range(3):
                write_session(state_dir, f"insp-{index}", commands=preference())
            from ffsrecord.profile import ingest_sessions
            ingest_sessions(project, state_dir)
            first = recompute(project, now=NOW)
            second = recompute(project, now=NOW)
            self.assertEqual(first["preferences"], second["preferences"])
            self.assertEqual([p["version"] for p in second["preferences"]], [p["version"] for p in first["preferences"]])
            versions = sorted((preferences_dir(project) / "versions").glob("*.json"))
            self.assertEqual(len(versions), 2)

    def test_deleting_evidence_demotes_exactly(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            state_dir = project / ".ffs-viewer"
            for index in range(9):
                write_session(state_dir, f"insp-{index}", commands=preference())
            from ffsrecord.profile import ingest_sessions
            ingest_sessions(project, state_dir)
            before = {p["id"]: p for p in recompute(project, now=NOW)["preferences"]}
            self.assertEqual(before["pref-alpha-0-4"]["status"], "established")
            evidence = preferences_dir(project) / "evidence"
            for path in sorted(evidence.glob("*.json"))[3:]:
                path.unlink()
            after = {p["id"]: p for p in recompute(project, now=NOW)["preferences"]}
            self.assertEqual(after["pref-alpha-0-4"]["status"], "candidate")
            self.assertEqual(after["pref-alpha-0-4"]["evidence"]["sessions"], 3)
            self.assertEqual(after["pref-alpha-0-4"]["version"], 2)
            self.assertIn(before["pref-alpha-0-4"]["version"], [record["version"] for record in after["pref-alpha-0-4"]["history"]])

    def test_profile_read_and_policy_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            policy = load_policy(project)
            self.assertEqual(policy["observation"]["candidate"]["minSessions"], 3)
            self.assertEqual(policy["scientificKinds"][0], "qc")
            self.assertTrue(policy_path(project).exists())
            self.assertIsNone(read_profile(project))


class LifecycleTests(unittest.TestCase):
    def make_project(self, tmp: str) -> Path:
        project = Path(tmp)
        state_dir = project / ".ffs-viewer"
        for index in range(3):
            write_session(state_dir, f"insp-{index}", commands=preference())
        from ffsrecord.profile import ingest_sessions, recompute as recompute_profile
        ingest_sessions(project, state_dir)
        recompute_profile(project, now=NOW)
        return project

    def test_user_actions_replay_over_the_derived_profile(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(tmp)
            established = record_action(project, "establish", "pref-threshold-2-3",
                                        actor={"kind": "user"}, reason="confirmed on three runs", now=NOW)
            self.assertEqual(established["type"], "preference.established")
            from ffsrecord.profile import recompute as recompute_profile
            profile = recompute_profile(project, now=NOW)
            by_id = {record["id"]: record for record in profile["preferences"]}
            self.assertEqual(by_id["pref-threshold-2-3"]["status"], "established")
            self.assertEqual(by_id["pref-threshold-2-3"]["confirmation"]["by"], "user")
            self.assertEqual(by_id["pref-threshold-2-3"]["origin"], "explicit")
            self.assertFalse(by_id["pref-threshold-2-3"]["confirmation"]["required"])
            self.assertEqual(by_id["pref-threshold-2-3"]["confirmation"]["reason"], "confirmed on three runs")

            request = record_action(project, "request", "pref-alpha-0-4",
                                    actor={"kind": "agent", "tool": "ffs_preference_confirm"},
                                    reason="do you always start with a translucent overlay?", now=NOW)
            self.assertEqual(request["type"], "preference.confirmation-requested")
            profile = recompute_profile(project, now=NOW)
            alpha = {record["id"]: record for record in profile["preferences"]}["pref-alpha-0-4"]
            self.assertEqual(alpha["status"], "candidate")
            self.assertEqual(alpha["confirmation"]["requested"]["by"], "agent")

            version = alpha["version"]
            record_action(project, "retire", "pref-alpha-0-4", actor={"kind": "user"}, reason="not habitual", now=NOW)
            edited = record_action(project, "edit", "pref-alpha-0-4", actor={"kind": "user"},
                                   payload={"action": "use alpha 0.35 for overlays"}, now=NOW)
            self.assertEqual(edited["type"], "preference.edited")
            record_action(project, "delete", "pref-threshold-2-3", actor={"kind": "user"}, now=NOW)

            profile = recompute_profile(project, now=NOW)
            by_id = {record["id"]: record for record in profile["preferences"]}
            self.assertEqual(by_id["pref-threshold-2-3"]["status"], "retired")
            self.assertFalse(by_id["pref-threshold-2-3"]["active"])
            self.assertIn("deletedAt", by_id["pref-threshold-2-3"])
            self.assertEqual(by_id["pref-alpha-0-4"]["status"], "retired")
            self.assertFalse(by_id["pref-alpha-0-4"]["active"])
            self.assertGreater(by_id["pref-alpha-0-4"]["version"], version)
            self.assertEqual(by_id["pref-alpha-0-4"]["recommendation"]["action"], "use alpha 0.35 for overlays")
            self.assertEqual(profile["stats"]["retired"], 2)
            self.assertEqual(len(read_events(project)), 5)

            again = recompute_profile(project, now=NOW)
            self.assertEqual(profile["preferences"], again["preferences"])

    def test_agent_cannot_establish_or_retire(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(tmp)
            for action in ("establish", "retire", "delete", "edit"):
                with self.assertRaises(PreferenceError) as caught:
                    record_action(project, action, "pref-threshold-2-3", actor={"kind": "agent"}, now=NOW)
                self.assertEqual(caught.exception.code, "preference-user-only")

    def test_unknown_preference_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(tmp)
            with self.assertRaises(PreferenceError) as caught:
                record_action(project, "establish", "pref-does-not-exist", actor={"kind": "user"}, now=NOW)
            self.assertEqual(caught.exception.code, "preference-not-found")

    def test_confirmed_preference_survives_evidence_deletion(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = self.make_project(tmp)
            record_action(project, "establish", "pref-threshold-2-3", actor={"kind": "user"}, now=NOW)
            from ffsrecord.policy import preferences_dir as prefs_dir
            for path in (prefs_dir(project) / "evidence").glob("*.json"):
                path.unlink()
            from ffsrecord.profile import recompute as recompute_profile
            profile = recompute_profile(project, now=NOW)
            self.assertEqual(len(profile["preferences"]), 1)
            retained = profile["preferences"][0]
            self.assertEqual(retained["id"], "pref-threshold-2-3")
            self.assertEqual(retained["status"], "established")
            self.assertTrue(retained["evidence"]["behavioralDeleted"])
            self.assertEqual(retained["evidence"]["sessions"], 0)
            self.assertEqual(retained["provenance"], "confirmation-supported (behavioral evidence deleted)")
            self.assertEqual(profile["lifecycle"]["skipped"], [])


class PrecedenceTests(unittest.TestCase):
    def make_profile(self) -> dict:
        def record(pid, *, kind="preference", scope="project", status="established", stages=None):
            return {
                "id": pid, "version": 1, "kind": kind, "scope": scope, "status": status,
                "appliesTo": {"tasks": ["rest"], "modalities": ["func"], "stages": stages or ["qc"]},
                "recommendation": {"action": pid}, "active": True,
            }
        return {"preferences": [
            record("constraint-1", kind="constraint", scope="project"),
            record("task-1", scope="task"),
            record("cross-1", scope="cross-project"),
            record("candidate-1", status="candidate"),
        ]}

    def test_instruction_wins_then_constraint_then_task(self) -> None:
        profile = self.make_profile()
        with_instruction = resolve(profile=profile, context={"task": "rest", "modality": "func", "stage": "qc"},
                                   instruction={"text": "use overlay"})
        self.assertEqual(with_instruction["effective"]["rung"], "instruction")
        no_instruction = resolve(profile=profile, context={"task": "rest", "modality": "func", "stage": "qc"})
        self.assertEqual(no_instruction["effective"]["rung"], "constraint")
        self.assertEqual(no_instruction["effective"]["items"][0]["id"], "constraint-1")
        self.assertEqual(no_instruction["rungs"][2]["items"][0]["id"], "task-1")
        overridden = [entry for entry in no_instruction["applied"] if entry["id"] == "task-1"][0]
        self.assertFalse(overridden["applied"])
        self.assertEqual(overridden["overriddenBy"], "constraint")

    def test_context_filter_and_candidate_fallback(self) -> None:
        profile = self.make_profile()
        other = resolve(profile=profile, context={"task": "nback", "modality": "func", "stage": "qc"})
        self.assertEqual(other["effective"]["rung"], "cross-project")  # task filter excludes the constraint/task rungs
        without_constraint = {"preferences": [p for p in profile["preferences"] if p["id"] != "constraint-1"]}
        result = resolve(profile=without_constraint, context={"task": "rest", "modality": "func", "stage": "qc"})
        self.assertEqual(result["effective"]["rung"], "task-modality")
        self.assertEqual(result["effective"]["items"][0]["id"], "task-1")

    def test_decisions_can_supply_constraints(self) -> None:
        result = resolve(profile={"preferences": []}, context={},
                         decisions=[{"id": "dec-1", "kind": "constraint", "status": "accepted", "text": "no smoothing"}])
        self.assertEqual(result["effective"]["rung"], "constraint")
        self.assertEqual(result["gates"][0]["source"], "decision")

    def test_defaults_are_the_last_rung(self) -> None:
        result = resolve(profile={"preferences": []}, context={}, defaults=[{"id": "default-1"}])
        self.assertEqual(result["effective"]["rung"], "defaults")


class CliTests(unittest.TestCase):
    def test_profile_cli_is_reproducible(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            state_dir = project / ".ffs-viewer"
            for index in range(3):
                write_session(state_dir, f"insp-{index}", commands=preference())
            env = dict(os.environ)
            env["PYTHONPATH"] = f"{ROOT / 'python'}{os.pathsep}{env.get('PYTHONPATH', '')}"
            command = [str(PYTHON), "-m", "ffsrecord.cli", "profile", "--project", str(project),
                       "--now", NOW, "--json"]
            first = subprocess.run(command, capture_output=True, text=True, env=env, cwd=str(ROOT))
            self.assertEqual(first.returncode, 0, first.stderr)
            profile = json.loads(first.stdout)
            self.assertEqual(profile["evidence"]["sessions"], 3)
            self.assertTrue((preferences_dir(project) / "profile.json").exists())
            second = subprocess.run(command, capture_output=True, text=True, env=env, cwd=str(ROOT))
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(json.loads(second.stdout)["preferences"], profile["preferences"])

    def test_preference_cli_establishes_and_requires_user(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            state_dir = project / ".ffs-viewer"
            for index in range(3):
                write_session(state_dir, f"insp-{index}", commands=preference())
            env = dict(os.environ)
            env["PYTHONPATH"] = f"{ROOT / 'python'}{os.pathsep}{env.get('PYTHONPATH', '')}"
            subprocess.run([str(PYTHON), "-m", "ffsrecord.cli", "profile", "--project", str(project),
                            "--now", NOW], capture_output=True, text=True, env=env, cwd=str(ROOT), check=True)
            command = [str(PYTHON), "-m", "ffsrecord.cli", "preference", "--project", str(project),
                       "--action", "establish", "--id", "pref-threshold-2-3", "--json", "--now", NOW]
            established = subprocess.run(command, capture_output=True, text=True, env=env, cwd=str(ROOT))
            self.assertEqual(established.returncode, 0, established.stderr)
            payload = json.loads(established.stdout)
            self.assertEqual(payload["event"]["type"], "preference.established")
            self.assertEqual(payload["preference"]["status"], "established")
            denied = subprocess.run([*command, "--actor", "agent"], capture_output=True, text=True, env=env, cwd=str(ROOT))
            self.assertEqual(denied.returncode, 1)
            self.assertIn("preference-user-only", denied.stderr)

    def test_resolve_cli(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            recompute(project, now=NOW)
            env = dict(os.environ)
            env["PYTHONPATH"] = f"{ROOT / 'python'}{os.pathsep}{env.get('PYTHONPATH', '')}"
            result = subprocess.run(
                [str(PYTHON), "-m", "ffsrecord.cli", "resolve", "--project", str(project),
                 "--context", '{"task":"rest","modality":"func","stage":"qc"}',
                 "--instruction", "use overlay", "--json"],
                capture_output=True, text=True, env=env, cwd=str(ROOT))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["effective"]["rung"], "instruction")


if __name__ == "__main__":
    unittest.main()
