#!/usr/bin/env python3
"""Permutation / cluster-size correction for an FFS group analysis.

Reads a design JSON (written by the analysis Host), the subject-level resampled
contrast Coef maps and the group statistic bucket. Enumerates sign flips
(one-sample) or group-label permutations (two-group), builds a null distribution
of the largest positive cluster at the cluster-forming threshold, and reports
cluster-level p values (max-statistic FWE) plus a 95% cluster-size threshold.

Usage::

    .venv/bin/python scripts/group_permutation.py --design design.json --out correction.json
"""

from __future__ import annotations

import argparse
import itertools
import json
import math
from pathlib import Path

import nibabel as nib
import numpy as np
from scipy import ndimage

STRUCTURE = ndimage.generate_binary_structure(3, 1)  # 6-connectivity, as scripts/results.py


def load_volume(path: str) -> np.ndarray:
    data = np.squeeze(np.asanyarray(nib.load(path).dataobj, dtype=np.float32))
    if data.ndim != 3:
        raise ValueError(f"{path}: expected a 3-D volume, got {data.shape}")
    return data


def load_bucket(path: str, stat_index: int | None) -> np.ndarray:
    image = nib.load(path)
    data = np.squeeze(np.asanyarray(image.dataobj, dtype=np.float32))
    if data.ndim != 4:
        raise ValueError(f"{path}: expected a 4-D bucket, got {data.shape}")
    if stat_index is None:
        labels = []
        try:
            labels = [str(value) for value in nib.load(path).header["BRICK_LABS"].split("~")]
        except Exception:
            labels = []
        index = next((i for i, label in enumerate(labels) if "tstat" in label.lower() or label.lower().endswith(":t")), 0)
    else:
        index = int(stat_index)
    return data[..., index]


def t_map_one_sample(stack: np.ndarray, signs: np.ndarray) -> np.ndarray:
    values = stack * signs[:, None, None, None]
    n = values.shape[0]
    mean = values.mean(axis=0)
    sd = values.std(axis=0, ddof=1) if n > 1 else np.zeros_like(mean)
    denom = sd / math.sqrt(n)
    out = np.zeros_like(mean)
    mask = denom > 1e-6
    out[mask] = mean[mask] / denom[mask]
    return out


def t_map_two_group(stack: np.ndarray, groups_a: list[int], groups_b: list[int]) -> np.ndarray:
    a = stack[groups_a]
    b = stack[groups_b]
    mean_a, mean_b = a.mean(axis=0), b.mean(axis=0)
    var_a = a.var(axis=0, ddof=1) if len(groups_a) > 1 else np.zeros_like(mean_a)
    var_b = b.var(axis=0, ddof=1) if len(groups_b) > 1 else np.zeros_like(mean_b)
    denom = np.sqrt(var_a / len(groups_a) + var_b / len(groups_b))
    out = np.zeros_like(mean_a)
    mask = denom > 1e-6
    out[mask] = (mean_a[mask] - mean_b[mask]) / denom[mask]
    return out


def clusters_at(stat: np.ndarray, threshold: float, min_cluster: int) -> list[dict]:
    labels, count = ndimage.label(stat > threshold, structure=STRUCTURE)
    out = []
    for index in range(1, count + 1):
        voxels = np.argwhere(labels == index)
        if not len(voxels) or len(voxels) < min_cluster:
            continue
        values = stat[tuple(voxels.T)]
        peak_index = tuple(int(value) for value in voxels[int(np.argmax(values))])
        out.append({
            "size": int(len(voxels)),
            "peakT": float(stat[peak_index]),
            "ijk": [int(value) for value in peak_index],
        })
    return out


def max_cluster_size(stat: np.ndarray, threshold: float) -> int:
    labels, count = ndimage.label(stat > threshold, structure=STRUCTURE)
    if not count:
        return 0
    sizes = np.bincount(labels.ravel())[1:]
    return int(sizes.max())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--design", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    design = json.loads(args.design.read_text(encoding="utf-8"))
    method = design.get("method", "permutation")
    threshold = float(design.get("threshold", 3.1))
    model = design.get("model", "one-sample")
    coefs = [load_volume(item) for item in design["coefs"]]
    stack = np.stack(coefs, axis=0)
    observed = load_bucket(design["stats"], design.get("stat_index"))
    min_cluster = int(design.get("min_cluster", 10))
    observed_clusters = clusters_at(observed, threshold, min_cluster)

    groups = design.get("groups") or {}
    groups_a = [int(value) for value in groups.get("a", [])]
    groups_b = [int(value) for value in groups.get("b", [])]
    n = len(coefs)
    null_sizes: list[int] = []
    if model == "two-group":
        if not groups_a or not groups_b:
            raise SystemExit("two-group design needs groups.a and groups.b")
        for pick in itertools.combinations(range(n), len(groups_a)):
            chosen = set(pick)
            a = sorted(chosen)
            b = [index for index in range(n) if index not in chosen]
            if len(b) != len(groups_b):
                continue
            null_sizes.append(max_cluster_size(t_map_two_group(stack, a, b), threshold))
    else:
        total = 1 << n
        for mask in range(total):
            signs = np.array([1.0 if (mask >> bit) & 1 else -1.0 for bit in range(n)], dtype=np.float32)
            null_sizes.append(max_cluster_size(t_map_one_sample(stack, signs), threshold))

    null_sizes = sorted(null_sizes)
    n_null = len(null_sizes)
    rank = lambda value: (1 + sum(1 for item in null_sizes if item >= value)) / (n_null + 1)
    for cluster in observed_clusters:
        cluster["p"] = round(float(rank(cluster["size"])), 5)
    cluster_threshold = int(np.percentile(null_sizes, 95)) if null_sizes else 0
    for cluster in observed_clusters:
        cluster["significant"] = bool(cluster["size"] >= cluster_threshold and cluster_threshold > 0)
    result = {
        "method": method,
        "model": model,
        "threshold": threshold,
        "nPerm": n_null,
        "clusterThreshold": cluster_threshold,
        "alpha": 0.05,
        "clusters": observed_clusters,
        "maxNull": max(null_sizes) if null_sizes else 0,
    }
    args.out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
