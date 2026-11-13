#!/usr/bin/env python3
"""Read NIfTI bucket metadata for cohort validation.

Prints one JSON array so the Host can compare grids without importing nibabel in JS.

Usage::

    .venv/bin/python scripts/bucket_meta.py path/to/stats1.nii.gz path/to/stats2.nii.gz
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import nibabel as nib
import numpy as np


def describe(path: Path) -> dict:
    try:
        image = nib.load(str(path))
        shape = list(image.shape)
        zooms = [float(value) for value in image.header.get_zooms()]
        affine = np.asarray(image.affine, dtype=float).round(6).tolist()
        return {
            "path": str(path),
            "ok": True,
            "shape": shape,
            "zooms": zooms,
            "affine": affine,
        }
    except Exception as error:  # noqa: BLE001 - report, do not crash the cohort
        return {"path": str(path), "ok": False, "error": f"{type(error).__name__}: {error}"}


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: bucket_meta.py <bucket> [<bucket> ...]", file=sys.stderr)
        return 2
    print(json.dumps([describe(Path(value)) for value in sys.argv[1:]], indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
