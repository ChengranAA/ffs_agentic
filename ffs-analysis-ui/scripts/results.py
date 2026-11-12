#!/usr/bin/env python3
"""Summarize an FFS GLM stats bucket for the analysis tab.

Reads a NIfTI bucket (e.g. ``stage12.stats-reml.task-localizer.nii.gz``), gets the
AFNI-style sub-brick labels via ``3dinfo -label``, and writes a compact JSON summary:

  - per T-stat contrast: global peak t, its voxel (IJK) and mm coordinate,
  - clusters above a threshold (6-connectivity), size / peak / coordinate,
  - the sub-brick labels and the in-mask voxel count.

Only positive t is extracted (``SET_SIGN ... pos`` in the viewer); negative effects are
left for a later pass. This is inspection support, not a statistical method: the numbers
are read from the bucket the pipeline wrote, never recomputed.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import nibabel as nib
import numpy as np
from scipy import ndimage


def subbrick_labels(path: Path) -> list[str]:
    info = shutil.which("3dinfo")
    if info:
        try:
            result = subprocess.run(
                [info, "-label", str(path)],
                capture_output=True,
                text=True,
                timeout=60,
            )
            labels = [part.strip() for part in result.stdout.strip().split("|") if part.strip()]
            if result.returncode == 0 and labels:
                return labels
        except (OSError, subprocess.SubprocessError):
            pass
    return []


def labels_from_header(image: nib.Nifti1Image) -> list[str]:
    """FFS writes AFNI-style BRICK_LABS into a NIfTI AFNI extension."""
    for extension in image.header.extensions:
        try:
            content = bytes(extension.get_content() or b"").decode("utf-8", "replace")
        except Exception:
            continue
        match = re.search(r'atr_name="BRICK_LABS"\s*>\s*(.*?)\s*</AFNI_atr>', content, re.S)
        if not match:
            continue
        raw = match.group(1).strip().strip('"')
        raw = raw.replace("&quot;", '"')
        labels = [part.strip() for part in raw.split("~") if part.strip()]
        if labels:
            return labels
    return []


def summarize(
    stats_path: Path,
    threshold: float,
    min_cluster: int,
    max_clusters: int,
) -> dict:
    image = nib.load(str(stats_path))
    data = np.asanyarray(image.dataobj, dtype=np.float32)
    # AFNI group buckets can carry a singleton 4th axis (e.g. (x, y, z, 1, 5)).
    data = np.squeeze(data)
    if data.ndim != 4:
        raise ValueError(f"expected a 4-D bucket, got shape {data.shape}")
    affine = image.affine
    labels = subbrick_labels(stats_path)
    if len(labels) != data.shape[3]:
        labels = labels_from_header(image)
    if len(labels) != data.shape[3]:
        labels = [labels[i] if i < len(labels) else f"sub-brick {i}" for i in range(data.shape[3])]

    structure = ndimage.generate_binary_structure(3, 1)  # 6-connectivity
    contrasts = []
    in_mask = 0

    for index, label in enumerate(labels):
        lower = label.lower()
        is_t = "tstat" in lower or bool(re.search(r":t$", lower))
        if not is_t:
            continue
        volume = data[..., index]
        finite = np.isfinite(volume)
        if in_mask == 0:
            # FFS writes the full grid; in-mask voxels are the non-zero ones.
            in_mask = int(np.count_nonzero(volume != 0))
        if not finite.any():
            continue

        masked = np.where(finite, volume, -np.inf)
        flat_index = int(np.argmax(masked))
        peak_ijk = tuple(int(v) for v in np.unravel_index(flat_index, volume.shape))
        peak_t = float(volume[peak_ijk])

        binary = finite & (volume >= threshold)
        labeled, count = ndimage.label(binary, structure=structure)
        clusters = []
        if count:
            sizes = ndimage.sum(binary, labeled, index=np.arange(1, count + 1))
            order = np.argsort(sizes)[::-1]
            for rank in order:
                size = int(sizes[rank])
                if size < min_cluster:
                    continue
                component = int(rank) + 1
                coords = np.argwhere(labeled == component)
                if not len(coords):
                    continue
                values = volume[tuple(coords.T)]
                best = int(np.argmax(values))
                ijk = tuple(int(v) for v in coords[best])
                mm = tuple(round(float(v), 2) for v in (affine @ np.array([*ijk, 1.0]))[:3])
                clusters.append({
                    "size": size,
                    "peakT": round(float(values[best]), 3),
                    "ijk": list(ijk),
                    "mm": list(mm),
                })
                if len(clusters) >= max_clusters:
                    break

        mm = tuple(round(float(v), 2) for v in (affine @ np.array([*peak_ijk, 1.0]))[:3])
        if "#" in label:
            name = label.split("#")[0]
        elif ":" in label:
            name = label.split(":")[0]
        else:
            name = label.replace("tstat", "")
        contrasts.append({
            "name": name.strip(" _-") or label,
            "subBrick": label,
            "index": index,
            "peakT": round(peak_t, 3),
            "peakIJK": list(peak_ijk),
            "peakMM": list(mm),
            "clusters": clusters,
        })

    return {
        "stats": str(stats_path),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "threshold": threshold,
        "minCluster": min_cluster,
        "subBricks": labels,
        "voxels": in_mask,
        "contrasts": contrasts,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stats", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--threshold", type=float, default=3.1)
    parser.add_argument("--min-cluster", type=int, default=10)
    parser.add_argument("--max-clusters", type=int, default=10)
    args = parser.parse_args()

    summary = summarize(args.stats, args.threshold, args.min_cluster, args.max_clusters)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(summary, indent=2) + "\n")
    print(
        f"results: {len(summary['contrasts'])} contrast(s), "
        f"{sum(len(c['clusters']) for c in summary['contrasts'])} cluster(s) -> {args.out}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
