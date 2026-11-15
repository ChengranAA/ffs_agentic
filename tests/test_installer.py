#!/usr/bin/env python3
"""Verify the record-bundle installer on a throwaway profile (no real profile mutation)."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "install_record_bundle.sh"


class InstallerTests(unittest.TestCase):
    def make_profile(self, tmp: str) -> Path:
        profile = Path(tmp) / "profile"
        profile.mkdir()
        (profile / "package.json").write_text(json.dumps({
            "name": "dsh-profile-test",
            "private": True,
            "dependencies": {"@local/existing": "link:/tmp/existing"},
            "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "@local/existing"]}},
        }, indent=2) + "\n")
        return profile

    def run_installer(self, profile: Path, *args: str) -> subprocess.CompletedProcess:
        env = dict(os.environ)
        env["DSH_PROFILE_DIR"] = str(profile)
        return subprocess.run(["bash", str(SCRIPT), *args], capture_output=True, text=True, env=env, cwd=ROOT)

    def test_dry_run_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            profile = self.make_profile(tmp)
            before = (profile / "package.json").read_text()
            result = self.run_installer(profile, "--dry-run")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("@local/ffs-record", result.stdout)
            self.assertEqual((profile / "package.json").read_text(), before)
            self.assertEqual([p.name for p in profile.iterdir()], ["package.json"])

    def test_apply_links_bundle_and_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            profile = self.make_profile(tmp)
            applied = self.run_installer(profile, "--apply", "--no-deps")
            self.assertEqual(applied.returncode, 0, applied.stderr)
            pkg = json.loads((profile / "package.json").read_text())
            expected = f"link:{ROOT / 'ffs-record'}"
            self.assertEqual(pkg["dependencies"]["@local/ffs-record"], expected)
            self.assertIn("@local/ffs-record", pkg["dsh"]["profile"]["bundles"])
            self.assertIn("@local/existing", pkg["dsh"]["profile"]["bundles"])
            backups = [path for path in profile.iterdir() if path.name.startswith("package.json.bak-")]
            self.assertEqual(len(backups), 1)
            self.assertIn("backup", applied.stdout)

            again = self.run_installer(profile, "--apply", "--no-deps")
            self.assertEqual(again.returncode, 0, again.stderr)
            self.assertIn("nothing to change", again.stdout)
            backups = [path for path in profile.iterdir() if path.name.startswith("package.json.bak-")]
            self.assertEqual(len(backups), 1)

    def test_missing_bundle_or_profile_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env = dict(os.environ)
            env["DSH_PROFILE_DIR"] = str(Path(tmp) / "missing")
            result = subprocess.run(["bash", str(SCRIPT), "--dry-run"], capture_output=True, text=True, env=env, cwd=ROOT)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("profile package.json not found", result.stderr)


if __name__ == "__main__":
    unittest.main()
