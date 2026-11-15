#!/usr/bin/env python3
"""Tests for policy-driven operation gates."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PYTHON = ROOT / ".venv" / "bin" / "python"
if str(ROOT / "python") not in sys.path:
    sys.path.insert(0, str(ROOT / "python"))

from ffsrecord.gates import evaluate  # noqa: E402
from ffsrecord.policy import load_policy, policy_path  # noqa: E402


class GateTests(unittest.TestCase):
    def test_plan_constraint_requires_a_subject(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            policy = load_policy(project)
            blocked = evaluate(policy, "plan", {"subjectExists": False})
            self.assertFalse(blocked["allowed"])
            self.assertEqual(blocked["failures"][0]["id"], "constraint-bids-subject")
            allowed = evaluate(policy, "plan", {"subjectExists": True, "datasetDescription": True})
            self.assertTrue(allowed["allowed"])
            self.assertEqual(allowed["failures"], [])

    def test_run_and_export_constraints(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            policy = load_policy(Path(tmp))
            self.assertFalse(evaluate(policy, "run", {"runActive": True, "subjectExists": True, "scriptExists": True})["allowed"])
            self.assertTrue(evaluate(policy, "run", {"runActive": False, "subjectExists": True, "scriptExists": True})["allowed"])
            self.assertFalse(evaluate(policy, "export", {"settled": False})["allowed"])
            self.assertTrue(evaluate(policy, "export", {"settled": True})["allowed"])
            # Constraints are operation-scoped: export does not inherit plan's subject check.
            self.assertEqual(evaluate(policy, "export", {"settled": True})["constraints"][0]["id"],
                             "constraint-settled-export")

    def test_standard_is_reported_separately_from_constraints(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            policy = load_policy(Path(tmp))
            result = evaluate(policy, "settle", {"hasDecisions": False, "runCompleted": True})
            self.assertTrue(result["allowed"])  # a standard does not refuse
            self.assertEqual(result["standardFailures"][0]["id"], "standard-qc-review")
            self.assertEqual(result["standardFailures"][0]["kind"], "standard")
            satisfied = evaluate(policy, "settle", {"hasDecisions": True, "runCompleted": True})
            self.assertEqual(satisfied["standardFailures"], [])

    def test_policy_file_can_add_constraints_and_unknown_checks_pass(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            policy = load_policy(project)
            policy["constraints"].append({
                "id": "constraint-inputs", "text": "Inputs must exist.",
                "check": "inputs-present", "appliesTo": ["plan"],
            })
            policy["constraints"].append({
                "id": "constraint-future", "text": "Future check.", "check": "not-implemented",
                "appliesTo": ["plan"],
            })
            blocked = evaluate(policy, "plan", {"subjectExists": True, "datasetDescription": True, "inputCount": 0})
            ids = [entry["id"] for entry in blocked["failures"]]
            self.assertIn("constraint-inputs", ids)
            self.assertNotIn("constraint-future", ids)  # unknown checks are advisory
            self.assertIn("not-implemented", blocked["unknownChecks"])
            allowed = evaluate(policy, "plan", {"subjectExists": True, "datasetDescription": True, "inputCount": 3})
            self.assertTrue(allowed["allowed"])

    def test_dataset_script_and_completion_checks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            policy = load_policy(Path(tmp))
            manifest = evaluate(policy, "plan", {"subjectExists": True, "datasetDescription": False})
            self.assertIn("constraint-bids-manifest", [entry["id"] for entry in manifest["failures"]])
            scripts = evaluate(policy, "run", {"subjectExists": True, "runActive": False, "scriptExists": False})
            self.assertIn("constraint-scripts-exist", [entry["id"] for entry in scripts["failures"]])
            incomplete = evaluate(policy, "settle", {"hasDecisions": True, "runCompleted": False})
            self.assertIn("constraint-run-completed", [entry["id"] for entry in incomplete["failures"]])
            complete = evaluate(policy, "settle", {"hasDecisions": True, "runCompleted": True})
            self.assertTrue(complete["allowed"])

    def test_gate_cli_exit_codes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            env = dict(os.environ)
            env["PYTHONPATH"] = f"{ROOT / 'python'}{os.pathsep}{env.get('PYTHONPATH', '')}"
            blocked = subprocess.run(
                [str(PYTHON), "-m", "ffsrecord.cli", "gate", "--project", str(project),
                 "--op", "plan", "--facts", json.dumps({"subjectExists": False}), "--json"],
                capture_output=True, text=True, env=env, cwd=str(ROOT))
            self.assertEqual(blocked.returncode, 1)
            parsed = json.loads(blocked.stdout)
            self.assertFalse(parsed["allowed"])
            self.assertTrue(policy_path(project).exists())
            allowed = subprocess.run(
                [str(PYTHON), "-m", "ffsrecord.cli", "gate", "--project", str(project),
                 "--op", "plan", "--facts", json.dumps({"subjectExists": True, "datasetDescription": True}), "--json"],
                capture_output=True, text=True, env=env, cwd=str(ROOT))
            self.assertEqual(allowed.returncode, 0)
            self.assertTrue(json.loads(allowed.stdout)["allowed"])


if __name__ == "__main__":
    unittest.main()
