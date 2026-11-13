#!/usr/bin/env python3
"""Compare two pipeline artifacts: exact hash and numeric tolerance.

Strict hashes expose tiny floating-point nondeterminism in REML fits; this helper
separates "byte/canonical-hash equal" from "numerically equivalent within tolerance".

Usage::

    .venv/bin/python scripts/artifact_compare.py a.nii.gz b.nii.gz --atol 1e-2 --rtol 1e-2
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import nibabel as nib
import numpy as np


def canonical_nifti(path: Path) -> tuple[np.ndarray, str]:
    image = nib.load(str(path))
    data = np.asanyarray(image.dataobj, dtype=np.float32)
    digest = hashlib.sha256()
    digest.update(np.ascontiguousarray(data).tobytes())
    digest.update(np.asarray(image.affine, dtype=np.float64).round(6).tobytes())
    digest.update(str(data.shape).encode())
    return data, digest.hexdigest()


def compare(a: Path, b: Path, atol: float, rtol: float) -> dict:
    result: dict = {"a": str(a), "b": str(b), "atol": atol, "rtol": rtol}
    if not a.exists() or not b.exists():
        return {**result, "ok": False, "error": "missing artifact"}
    nifti = a.name.endswith((".nii.gz", ".nii")) and b.name.endswith((".nii.gz", ".nii"))
    if not nifti:
        sha_a = hashlib.sha256(a.read_bytes()).hexdigest()
        sha_b = hashlib.sha256(b.read_bytes()).hexdigest()
        return {**result, "ok": True, "kind": "bytes", "exact": sha_a == sha_b, "toleranceMatch": sha_a == sha_b}
    try:
        data_a, sha_a = canonical_nifti(a)
        data_b, sha_b = canonical_nifti(b)
    except Exception as error:  # noqa: BLE001
        return {**result, "ok": False, "error": f"{type(error).__name__}: {error}"}
    result.update({"ok": True, "kind": "nifti", "exact": sha_a == sha_b, "sha_a": sha_a, "sha_b": sha_b})
    if data_a.shape != data_b.shape:
        return {**result, "toleranceMatch": False, "shapeMatch": False, "shapeA": list(data_a.shape), "shapeB": list(data_b.shape)}
    finite = np.isfinite(data_a) & np.isfinite(data_b)
    if not finite.any():
        return {**result, "toleranceMatch": False, "shapeMatch": True, "error": "no finite voxels"}
    difference = np.abs(data_a[finite] - data_b[finite])
    tolerance_match = bool(np.allclose(data_a[finite], data_b[finite], rtol=rtol, atol=atol, equal_nan=True))
    correlation = float(np.corrcoef(data_a[finite], data_b[finite])[0, 1]) if data_a[finite].size > 1 else 1.0
    result.update({
        "toleranceMatch": tolerance_match,
        "shapeMatch": True,
        "maxAbsDiff": float(difference.max()),
        "meanAbsDiff": float(difference.mean()),
        "voxelsOverTolerance": int(np.sum(difference > atol + rtol * np.abs(data_a[finite]))),
        "correlation": correlation,
    })
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("a", type=Path)
    parser.add_argument("b", type=Path)
    parser.add_argument("--atol", type=float, default=1e-2)
    parser.add_argument("--rtol", type=float, default=1e-2)
    args = parser.parse_args()
    print(json.dumps(compare(args.a, args.b, args.atol, args.rtol), indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
