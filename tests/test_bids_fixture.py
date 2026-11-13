#!/usr/bin/env python3
"""M0 tests for the BIDS-lite fixture.

Run with::

    .venv/bin/python -m unittest discover -s tests -v
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "build_bids_fixture.py"


def build(destination: Path) -> None:
    subprocess.run(
        [sys.executable, str(SCRIPT), "--out", str(destination)],
        check=True,
        capture_output=True,
        text=True,
    )


def tree_hashes(root: Path) -> dict[str, str]:
    hashes = {}
    for path in sorted(root.rglob("*")):
        if path.is_file():
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            hashes[str(path.relative_to(root))] = digest
    return hashes


class TestBidsFixture(unittest.TestCase):
    def test_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            first = Path(tmp) / "a"
            second = Path(tmp) / "b"
            build(first)
            build(second)
            self.assertEqual(tree_hashes(first), tree_hashes(second))

    def test_layout_and_variants(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "bids"
            build(root)
            description = json.loads((root / "dataset_description.json").read_text())
            self.assertEqual(description["BIDSVersion"], "1.8.0")
            self.assertTrue((root / "participants.tsv").exists())
            subjects = sorted(path.name for path in root.glob("sub-*"))
            self.assertEqual(subjects, ["sub-001", "sub-002", "sub-003", "sub-004"])

            def runs(subject: str) -> list[Path]:
                return sorted((root / subject / "ses-01" / "func").glob("*_bold.nii.gz"))

            self.assertEqual(len(runs("sub-001")), 2)
            self.assertEqual(len(runs("sub-002")), 1)  # single-run variant
            self.assertEqual(len(runs("sub-003")), 2)
            for subject in subjects:
                self.assertTrue((root / subject / "ses-01" / "anat" / f"{subject}_ses-01_T1w.nii.gz").exists())
                for bold in runs(subject):
                    stem = bold.name.replace("_bold.nii.gz", "")
                    self.assertTrue((bold.parent / f"{stem}_bold.json").exists())
                    events = bold.parent / f"{stem}_events.tsv"
                    self.assertTrue(events.exists())
                    header = events.read_text().splitlines()[0]
                    self.assertEqual(header, "onset\tduration\ttrial_type")

    def test_autoproc_accepts_fixture(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "bids"
            work = Path(tmp) / "work"
            work.mkdir(parents=True)
            build(root)
            env = dict(os.environ)
            env["PYTHONPATH"] = f"{ROOT / 'python'}:{ROOT / 'reference' / 'fastfuncstuff'}"
            result = subprocess.run(
                [
                    sys.executable, "-m", "fastfuncstuff.cli.autoproc",
                    "-bids_dir", str(root), "-subject", "001", "-task", "localizer",
                    "-recipe", "bare_bones", "-no_qc",
                    "-work_dir", str(work), "-out", str(work / "proc.sh"),
                ],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                timeout=240,
            )
            self.assertEqual(result.returncode, 0, result.stderr[-2000:])
            script = (work / "proc.sh").read_text()
            self.assertGreaterEqual(script.count("echo '== stage"), 7)


if __name__ == "__main__":
    unittest.main()
