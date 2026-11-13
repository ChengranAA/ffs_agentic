#!/usr/bin/env python3
"""Build the deterministic BIDS-lite fixture for the FFS analysis suite (M0).

Three subjects with intentionally different shapes so cohort handling is exercised:

  sub-001  two localizer runs, the canonical subject
  sub-002  one run only (single-run variant)
  sub-003  two runs, no fieldmaps anywhere in the fixture

The data are tiny on purpose (32^3, 2 mm, 40 volumes, TR 2 s): the fixture tests
pipeline mechanics and cohort code, not science. Every random field comes from a
fixed seed, and nibabel writes gzip with mtime 0, so two builds are byte-identical.

Run from the repository root::

    .venv/bin/python scripts/build_bids_fixture.py
    .venv/bin/python -m unittest discover -s tests -v
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import nibabel as nib
import numpy as np
from scipy.ndimage import gaussian_filter

SHAPE = (32, 32, 32)
VOX = 2.0
TR = 2.0
N_VOL = 40
SEED = 20261112
TASK = "localizer"
CONDITIONS = ("faces", "scenes")

SUBJECTS = {
    "001": {"runs": (1, 2)},
    "002": {"runs": (1,)},
    "003": {"runs": (1, 2)},
}


def _affine() -> np.ndarray:
    affine = np.diag([VOX, VOX, VOX, 1.0])
    affine[:3, 3] = -np.array(SHAPE, float) * VOX / 2.0
    return affine


def _grid() -> np.ndarray:
    axes = [np.arange(n) * VOX - n * VOX / 2.0 + VOX / 2.0 for n in SHAPE]
    return np.stack(np.meshgrid(*axes, indexing="ij"), axis=-1)


def _anatomy(seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    points = _grid()
    radius = np.linalg.norm(points, axis=-1)
    image = np.zeros(SHAPE, np.float32)
    image[radius < 0.82 * SHAPE[0] * VOX / 2] = 620.0   # grey matter
    image[radius < 0.48 * SHAPE[0] * VOX / 2] = 950.0   # white matter
    image[radius < 0.18 * SHAPE[0] * VOX / 2] = 180.0   # ventricles
    texture = gaussian_filter(rng.standard_normal(SHAPE), sigma=1.0)
    texture /= max(float(texture.std()), 1e-9)
    image *= 1.0 + 0.02 * texture
    return np.clip(image, 0.0, None).astype(np.float32)


def _hrf(t: np.ndarray) -> np.ndarray:
    a1, b1, a2, b2 = 6.0, 1.0, 16.0, 1.0
    h = t ** (a1 - 1.0) * np.exp(-t / b1) / (b1**a1 * math.gamma(a1))
    h -= (1.0 / 6.0) * t ** (a2 - 1.0) * np.exp(-t / b2) / (b2**a2 * math.gamma(a2))
    h[t < 0] = 0.0
    return h


def _task_regressor() -> np.ndarray:
    """10 s on / 10 s off blocks, one value per TR."""
    dt = 0.01
    duration = N_VOL * TR
    fine = np.arange(int(round(duration / dt))) * dt
    design = np.zeros_like(fine)
    onset = 0.0
    while onset < duration - 1e-9:
        design[(fine >= onset) & (fine < onset + 10.0)] = 1.0
        onset += 20.0
    hrf = _hrf(np.arange(0.0, 24.0 + dt, dt))
    convolved = np.convolve(design, hrf)[: fine.size] * dt
    idx = np.clip(np.rint(((np.arange(N_VOL) + 0.5) * TR) / dt).astype(int), 0, fine.size - 1)
    reg = convolved[idx]
    return reg / max(float(reg.max()), 1e-9)


def _activation() -> np.ndarray:
    points = _grid()
    centre = np.array([-10.0, -6.0, 6.0])
    weight = np.exp(-0.5 * (np.linalg.norm(points - centre, axis=-1) / 7.0) ** 2)
    return weight.astype(np.float32)


def _bold(seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    reg = _task_regressor()
    act = _activation()
    baseline = 1000.0
    noise = gaussian_filter(rng.standard_normal((*SHAPE, N_VOL)), sigma=(0.7, 0.7, 0.7, 0.0))
    noise /= max(float(noise.std()), 1e-9)
    data = baseline + np.einsum("ijk,t->ijkt", act, 45.0 * reg)
    data += 12.0 * noise
    return np.clip(data, 0.0, None).astype(np.int16)


def _events() -> list[tuple[float, float, str]]:
    rows = []
    onset = 0.0
    condition = 0
    while onset < N_VOL * TR - 1e-9:
        rows.append((onset, 10.0, CONDITIONS[condition % len(CONDITIONS)]))
        onset += 20.0
        condition += 1
    return rows


def _save(img: nib.Nifti1Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    nib.save(img, str(path))


def _json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _events_tsv(path: Path) -> None:
    lines = ["onset\tduration\ttrial_type"]
    lines += [f"{onset:.1f}\t{duration:.1f}\t{trial}" for onset, duration, trial in _events()]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def build(root: Path, seed: int = SEED) -> dict:
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    for subject, spec in SUBJECTS.items():
        session = root / f"sub-{subject}" / "ses-01"
        anat = _anatomy(seed + int(subject))
        anat_path = session / "anat" / f"sub-{subject}_ses-01_T1w.nii.gz"
        anat_img = nib.Nifti1Image(anat, _affine())
        anat_img.header.set_zooms((VOX, VOX, VOX))
        anat_img.header.set_xyzt_units("mm")
        anat_img.header["descrip"] = "FFS BIDS-lite fixture: T1-like phantom"
        _save(anat_img, anat_path)
        _json(Path(str(anat_path).replace(".nii.gz", ".json")), {"Modality": "MR", "MagneticFieldStrength": 3.0})
        for run in spec["runs"]:
            stem = f"sub-{subject}_ses-01_task-{TASK}_run-{run}"
            bold_path = session / "func" / f"{stem}_bold.nii.gz"
            func = _bold(seed + int(subject) * 100 + run)
            bold_img = nib.Nifti1Image(func, _affine())
            bold_img.header.set_zooms((VOX, VOX, VOX, TR))
            bold_img.header.set_xyzt_units("mm", "sec")
            bold_img.header["descrip"] = "FFS BIDS-lite fixture: task fMRI"
            _save(bold_img, bold_path)
            _json(Path(str(bold_path).replace(".nii.gz", ".json")), {
                "Modality": "MR",
                "MagneticFieldStrength": 3.0,
                "TaskName": TASK,
                "RepetitionTime": TR,
                "EchoTime": 0.03,
                "SliceThickness": VOX,
            })
            _events_tsv(session / "func" / f"{stem}_events.tsv")
    _json(root / "dataset_description.json", {
        "Name": "FFS BIDS-lite fixture",
        "BIDSVersion": "1.8.0",
        "DatasetType": "raw",
    })
    participants = ["participant_id\tage\tsex"]
    participants += [f"sub-{subject}\t{20 + int(subject)}\t{'F' if int(subject) % 2 else 'M'}" for subject in SUBJECTS]
    (root / "participants.tsv").write_text("\n".join(participants) + "\n", encoding="utf-8")
    return {"root": str(root), "subjects": len(SUBJECTS), "runs": sum(len(spec["runs"]) for spec in SUBJECTS.values())}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "data" / "bids-lite")
    parser.add_argument("--seed", type=int, default=SEED)
    args = parser.parse_args()
    summary = build(args.out, args.seed)
    print(f"wrote {summary['subjects']} subjects / {summary['runs']} runs to {summary['root']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
