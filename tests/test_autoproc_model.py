#!/usr/bin/env python3
"""Tests for the ffs_autoproc CLI model used by the analysis panel.

Run with::

    .venv/bin/python -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for entry in (ROOT / "python", ROOT / "reference" / "fastfuncstuff"):
    if str(entry) not in sys.path:
        sys.path.insert(0, str(entry))

from ffsviewer import autoproc_model  # noqa: E402


class AutoprocModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.model = autoproc_model.build_model()
        cls.dests = {
            flag["dest"]
            for group in cls.model["groups"]
            for flag in group["flags"]
        }
        cls.opt_group_dests = {
            flag["dest"]
            for group in cls.model["groups"]
            if group["title"].lower().startswith("per-stage")
            for flag in group["flags"]
        }

    def test_totals_match_the_cli(self) -> None:
        totals = self.model["totals"]
        self.assertEqual(self.model["schema"], autoproc_model.MODEL_SCHEMA)
        self.assertEqual(totals, {
            "flags": 174, "groups": 12, "recipes": 6,
            "stages": 20, "optsOverrides": 31,
        })

    def test_groups_are_the_help_groups(self) -> None:
        titles = [group["title"] for group in self.model["groups"]]
        self.assertEqual(len(titles), 12)
        self.assertIn("Inputs & scope", titles)
        self.assertIn("Anatomical & reference space", titles)
        self.assertIn("per-stage option overrides (replace the default op string)", titles)
        for dest in ("anat", "surface_target", "ref_transforms"):
            self.assertIn(dest, self.model["pathFlags"])
        for group in self.model["groups"]:
            self.assertTrue(group["flags"], group["title"])
            for flag in group["flags"]:
                self.assertTrue(flag["dest"])
                self.assertTrue(flag["flag"].startswith("-"))
                self.assertNotIn(flag["flag"], ("-h", "--help"))
                self.assertIn("help", flag)
                self.assertIn("default", flag)
                self.assertIn(flag["action"], {
                    "store_true", "store_false", "store", "append", "extend",
                    "count", "store_const",
                })
                if flag["kind"] == "bool":
                    self.assertIn(flag["action"], ("store_true", "store_false", "store_const"), flag["dest"])

    def test_stage_map_points_at_real_flags(self) -> None:
        stages = self.model["stages"]
        self.assertEqual([stage["id"] for stage in stages], [
            "preflight", "stage00", "stage00_physio", "stage01", "stage02", "stage03", "stage04",
            "stage05", "stage06", "stage07", "stage08", "stage08b", "stage09",
            "stage09b", "stage10a", "stage10", "stage10b", "stage10s",
            "stage12", "stage12s",
        ])
        for stage in stages:
            self.assertTrue(stage["phase"])
            self.assertTrue(stage["when"], stage["id"])
            for dest in stage["flags"]:
                self.assertIn(dest, self.dests, f"{stage['id']} lists unknown -{dest}")
            for dest in stage["opts"]:
                self.assertIn(dest, self.opt_group_dests,
                              f"{stage['id']} option {dest} is not a per-stage override")
            for clause in stage["when"]:
                self.assertTrue(clause.get("any"), stage["id"])
                for token in clause["any"]:
                    if token == "always":
                        continue
                    self.assertIn(token, self.model["reasonText"],
                                  f"{stage['id']} token {token} has no reason text")

    def test_recipes_match_autoproc_config(self) -> None:
        from fastfuncstuff.autoproc import config
        recipes = {item["id"]: item for item in self.model["recipes"]}
        self.assertEqual(set(recipes), set(config.RECIPES))
        for name, settings in config.RECIPES.items():
            self.assertEqual(recipes[name]["settings"], settings, name)
            self.assertTrue(recipes[name]["description"], name)

    def test_model_is_deterministic(self) -> None:
        again = autoproc_model.build_model()
        self.assertEqual(
            json.dumps(self.model, sort_keys=True, ensure_ascii=False),
            json.dumps(again, sort_keys=True, ensure_ascii=False),
        )

    def test_cli_check(self) -> None:
        env = dict(**__import__("os").environ)
        env["PYTHONPATH"] = f"{ROOT / 'python'}:{ROOT / 'reference' / 'fastfuncstuff'}"
        result = subprocess.run(
            [sys.executable, "-m", "ffsviewer.autoproc_model", "--check"],
            capture_output=True, text=True, cwd=ROOT, env=env, timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["totals"]["flags"], 174)


if __name__ == "__main__":
    unittest.main()
