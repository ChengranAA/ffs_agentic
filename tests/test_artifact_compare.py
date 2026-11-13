#!/usr/bin/env python3
"""Tests for the replay artifact comparator (M6)."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

import nibabel as nib
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ffs-analysis-ui" / "scripts"))

from artifact_compare import compare  # noqa: E402


def save(path: Path, data: np.ndarray) -> None:
    nib.save(nib.Nifti1Image(data.astype(np.float32), np.eye(4)), str(path))


class TestArtifactCompare(unittest.TestCase):
    def test_exact_and_tolerance(self) -> None:
        rng = np.random.default_rng(3)
        base = rng.standard_normal((6, 6, 6, 3)).astype(np.float32) * 10
        with tempfile.TemporaryDirectory() as tmp:
            a = Path(tmp) / "a.nii.gz"
            b = Path(tmp) / "b.nii.gz"
            c = Path(tmp) / "c.nii.gz"
            save(a, base)
            save(b, base)
            close = base.copy()
            close[0, 0, 0, 0] += 1e-4
            save(c, close)
            exact = compare(a, b, 1e-2, 1e-2)
            self.assertTrue(exact["exact"])
            self.assertTrue(exact["toleranceMatch"])
            near = compare(a, c, 1e-2, 1e-2)
            self.assertFalse(near["exact"])
            self.assertTrue(near["toleranceMatch"])
            self.assertLess(near["maxAbsDiff"], 1e-3)


if __name__ == "__main__":
    unittest.main()
