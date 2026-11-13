#!/usr/bin/env python3
"""Canonical hash of a pipeline artifact, for replay comparison.

NIfTI files are hashed by shape + affine + canonical float32 voxel data, so gzip
timestamps and header furniture do not make two numerically identical runs differ.
Everything else is hashed byte-for-byte.

Usage::

    .venv/bin/python scripts/artifact_hash.py path/to/artifact
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import nibabel as nib
import numpy as np


def hash_artifact(path: Path) -> dict:
    payload: dict = {"path": str(path), "bytes": path.stat().st_size if path.exists() else 0}
    if not path.exists():
        return {**payload, "ok": False, "error": "missing"}
    if path.suffix in (".nii", ".gz") and (path.name.endswith(".nii.gz") or path.name.endswith(".nii")):
        try:
            image = nib.load(str(path))
            data = np.asanyarray(image.dataobj, dtype=np.float32)
            digest = hashlib.sha256()
            digest.update(np.ascontiguousarray(data).tobytes())
            digest.update(np.asarray(image.affine, dtype=np.float64).round(6).tobytes())
            digest.update(str(data.shape).encode())
            return {
                **payload,
                "ok": True,
                "kind": "nifti",
                "sha256": digest.hexdigest(),
                "shape": list(data.shape),
                "dtype": "float32",
            }
        except Exception as error:  # noqa: BLE001 - fall back to bytes
            return {**payload, "ok": False, "error": f"{type(error).__name__}: {error}"}
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return {**payload, "ok": True, "kind": "bytes", "sha256": digest}


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: artifact_hash.py <artifact> [<artifact> ...]", file=sys.stderr)
        return 2
    print(json.dumps([hash_artifact(Path(value)) for value in sys.argv[1:]], indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
