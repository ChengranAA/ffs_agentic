#!/usr/bin/env python3
"""Render a surface GLM bucket on fsaverage to a PNG (M6 evidence figure).

Uses the fsaverage inflated mesh and a per-vertex GIFTI statistic. Two lateral
panels (lh/rh) are drawn with tripcolor; values below the threshold are transparent
over black, so the suprathreshold map is what stands out.

Usage::

    .venv/bin/python scripts/render_surface_map.py \\
        --stat-lh work/.../stage12s.stats-reml...lh.func.gii \\
        --stat-rh work/.../stage12s.stats-reml...rh.func.gii \\
        --out work/.../screenshots/surface-fsaverage.png
"""

from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import nibabel as nib
import numpy as np
from nibabel.freesurfer.io import read_geometry


def load_stat(path: Path, index: int) -> np.ndarray:
    image = nib.load(str(path))
    return np.asarray(image.darrays[index].data, dtype=np.float32)


def panel(ax, hemi: str, surf_dir: Path, stat: np.ndarray, threshold: float, vmax: float) -> None:
    vertices, faces = read_geometry(surf_dir / f"{hemi}.inflated")
    # A 2-panel lateral projection of the inflated mesh: horizontal is posterior->anterior,
    # vertical is inferior->superior. Keep the lateral half of each hemisphere.
    horizontal = -vertices[:, 1] if hemi == "lh" else vertices[:, 1]
    vertical = vertices[:, 2]
    centroids = vertices[faces].mean(axis=1)
    keep = centroids[:, 0] < 0 if hemi == "lh" else centroids[:, 0] > 0
    triangles = faces[keep]
    ax.set_facecolor("black")
    ax.tripcolor(horizontal, vertical, triangles, stat, cmap="coolwarm", shading="gouraud", vmin=-vmax, vmax=vmax)
    supra = np.abs(stat) >= threshold
    ax.scatter(horizontal[supra], vertical[supra], s=1.2, c="#ffe066", linewidths=0, alpha=0.9)
    ax.set_aspect("equal")
    ax.axis("off")
    ax.set_title(f"fsaverage {hemi} · localizer t (|t| ≥ {threshold})", color="white", fontsize=10)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stat-lh", required=True, type=Path)
    parser.add_argument("--stat-rh", required=True, type=Path)
    parser.add_argument("--index", type=int, default=2, help="GIFTI darray index (default 2 = condition t)")
    parser.add_argument("--threshold", type=float, default=2.3)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--surf-dir", type=Path, default=Path("/Applications/freesurfer/8.1.0/subjects/fsaverage/surf"))
    args = parser.parse_args()
    lh = load_stat(args.stat_lh, args.index)
    rh = load_stat(args.stat_rh, args.index)
    vmax = float(np.nanpercentile(np.abs(np.concatenate([lh, rh])), 99.5)) or 5.0
    figure, axes = plt.subplots(1, 2, figsize=(12, 4.2), facecolor="black")
    panel(axes[0], "lh", args.surf_dir, lh, args.threshold, vmax)
    panel(axes[1], "rh", args.surf_dir, rh, args.threshold, vmax)
    figure.suptitle("FFS surface GLM · fsaverage · demo phantom", color="white", fontsize=12)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(args.out, dpi=150, facecolor="black", bbox_inches="tight")
    print(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
