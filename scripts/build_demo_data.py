#!/usr/bin/env python3
"""Build the deterministic synthetic demo dataset for the ffs viewer.

Run from the repository root::

    .venv/bin/python scripts/build_demo_data.py

It writes, under ``data/demo/``:

    anat.nii.gz          3-D T1-like phantom         64 x 64 x 48,  1.5 mm
    func.nii.gz          4-D task run                64 x 64 x 48 x 80, TR 2 s
    stats.nii.gz         4-D stats bucket            64 x 64 x 48 x 2  (t | coef)
    task_regressor.1D    the task regressor, one row per TR
    subject/             a FreeSurfer subject whose surfaces are co-registered
    README.md            what the files are and how to regenerate them

The build is deterministic.  Every random field comes from a fixed seed, the
surfaces come from a fixed Fibonacci direction mesh, the surfaces are written
with a fixed creation stamp, and nibabel's gzip writer stamps mtime 0, so two
runs produce byte-identical files.  Nothing touches the network.

One model drives the anatomy, the task activation and the surfaces: a folded
ellipsoid

    r(direction) = R(axis radii) * (1 + FOLD_AMP * fold_field(direction))

The white surface, the pial surface and the T1 phantom's white-matter / grey-
matter boundary are therefore the same iso-surface by construction.  That is
what lets the viewer's ribbon check (``check_anat``) and the depth sampling
read real tissue instead of coincidence.
"""

from __future__ import annotations

import math
from pathlib import Path

import nibabel as nib
import numpy as np
from scipy.ndimage import gaussian_filter
from scipy.spatial import ConvexHull

# ---------------------------------------------------------------------------
# Geometry constants (world millimetres, RAS+)
# ---------------------------------------------------------------------------

SHAPE = (64, 64, 48)  # (nx, ny, nz)
VOX = 1.5  # isotropic voxel size, mm
TR = 2.0  # repetition time, s
N_VOLUMES = 80  # 160 s of task
BLOCK_ON, BLOCK_OFF = 20.0, 20.0  # seconds

#: Semi-axes of the folded ellipsoids, mm.  Anisotropy is the point: the FOV is
#: 96 x 96 x 72 mm, so a spherical 40 mm brain would run out of the volume in z.
#: The nominal radii the surfaces are described by are the largest semi-axes.
WHITE_AXES = np.array([38.0, 34.0, 26.5])
PIAL_AXES = np.array([42.0, 38.0, 30.5])
SMOOTHWM_AXES = WHITE_AXES
INFLATED_AXES = np.array([58.0, 54.0, 44.0])
SPHERE_RADIUS = 100.0

#: Fold amplitude as a fraction of the radius.  ``fold_field`` is normalised to
#: [-1, 1], so along the largest white semi-axis (38 mm) the surface moves by up to
#: about +-4 mm; the gyri seen in a slice are smaller than that maximum.
FOLD_AMP = 0.100
#: The medial wall of each hemisphere: lh is clamped to x <= -1 mm and rh to
#: x >= +1 mm, so the two hemispheres are closed surfaces that do not intersect.
MIDLINE = 1.0
#: The T1 sulcal CSF creases: ribbon voxels this close to the pial end (a
#: fraction of the local 4 mm ribbon) become dark where a fold runs deep.
SULCUS_DEPTH = 0.60
SULCUS_FOLD = -0.35

#: Tissue intensities, arbitrary but T1-like units (WM bright, GM mid, CSF dark).
WM_INTENSITY = 110.0
GM_INTENSITY = 58.0
CSF_INTENSITY = 10.0
VENTRICLE_INTENSITY = 6.0

#: Functional constants.
BOLD_BASELINE = 1000.0  # arbitrary scanner units
PSC_PEAK = 0.032  # 3.2 % peak signal change in the language ROI
PSC_NEG = 0.016  # 1.6 % negative task response at the two default-mode foci
NOISE_FRACTION = 0.0055  # 0.55 % smooth BOLD noise
DRIFT_FRACTION = 0.008  # 0.8 % slow drift (plus a slow secondary term)
NOISE_SPATIAL_SIGMA = 1.2  # voxels
NOISE_AR = 0.45  # temporal autocorrelation per TR

#: FreeSurfer surface geometry.  ``volume_info`` is the geometry of a volume
#: whose NIfTI affine is exactly :data:`AFFINE` (see :func:`_volume_info`): the
#: conformed-axes conventions FreeSurfer uses put the volume centre at index
#: ``dims / 2``, hence cras = AFFINE @ (dims / 2).
VOLUME_INFO_FILENAME = "orig.mgz"

#: Subject name written into the label header lines and the README.
SUBJECT_NAME = "ffs-demo"

# ---------------------------------------------------------------------------
# Reproducibility
# ---------------------------------------------------------------------------

SEED_ANAT = 20240501
SEED_FUNC = 20240502
SEED_STATS = 20240503

#: Fixed AFNI IDCODE so the writer's XML extension is byte-stable across runs.
AFNI_IDCODE = "AFN_ffsdemo000000000000"

#: Fixed creation stamp: ``nibabel.freesurfer.write_geometry`` otherwise stamps
#: the current time, which would make every run's bytes differ.
SURFACE_STAMP = "created by scripts/build_demo_data.py (ffs synthetic demo)"


# ---------------------------------------------------------------------------
# Shared folded-ellipsoid model
# ---------------------------------------------------------------------------


def _unit(dirs: np.ndarray) -> np.ndarray:
    d = np.asarray(dirs, dtype=np.float64)
    return d / np.linalg.norm(d, axis=-1, keepdims=True)


def _fold_raw(dirs: np.ndarray) -> np.ndarray:
    """Deterministic smooth scalar field on the unit sphere, before scaling.

    Frequencies in azimuth (theta) are whole numbers so the field is continuous
    across theta = +-pi; the polar frequencies make the folds run around the
    brain, and the 9/15/23-cycle mix gives gyri at several scales.
    """
    u = _unit(dirs)
    x, y, z = u[..., 0], u[..., 1], u[..., 2]
    theta = np.arctan2(y, x)
    phi = np.arccos(np.clip(z, -1.0, 1.0))
    return (
        0.38 * np.sin(9.0 * theta + 1.20) * np.sin(6.0 * phi + 0.50)
        + 0.30 * np.sin(15.0 * theta + 2.40) * np.sin(11.0 * phi + 1.10)
        + 0.24 * np.sin(23.0 * theta + 0.30) * np.sin(17.0 * phi + 2.00)
    )


def _fold_normaliser() -> float:
    """max |fold| over a dense fixed direction set, so the field is in [-1, 1]."""
    i = np.arange(4096) + 0.5
    phi = np.arccos(1.0 - 2.0 * i / 4096.0)
    theta = np.pi * (1.0 + 5.0**0.5) * i
    dirs = np.stack(
        [np.cos(theta) * np.sin(phi), np.sin(theta) * np.sin(phi), np.cos(phi)], axis=1
    )
    return float(np.abs(_fold_raw(dirs)).max())


_FOLD_NORM = _fold_normaliser()


def fold_field(dirs: np.ndarray) -> np.ndarray:
    """The fold field, normalised to [-1, 1] (positive = gyrus, negative = sulcus)."""
    return _fold_raw(dirs) / _FOLD_NORM


def ellipsoid_radius(dirs: np.ndarray, axes: np.ndarray) -> np.ndarray:
    """Radius of the ``axes`` ellipsoid along each unit direction (mm)."""
    u = _unit(dirs)
    q = np.sqrt(np.sum((u / np.asarray(axes, np.float64)) ** 2, axis=-1))
    return 1.0 / q


#: The anatomy's NIfTI affine: 1.5 mm RAS+, voxel (0, 0, 0) at the corner, so the
#: volume *centre* sits on the scanner origin.
AFFINE = np.eye(4)
AFFINE[0, 0] = AFFINE[1, 1] = AFFINE[2, 2] = VOX
AFFINE[:3, 3] = -(np.asarray(SHAPE, np.float64) - 1.0) / 2.0 * VOX


def _world_grid() -> np.ndarray:
    """World RAS coordinates of every voxel centre, shape (nx, ny, nz, 3)."""
    ijk = np.stack(np.meshgrid(*[np.arange(n) for n in SHAPE], indexing="ij"), axis=-1)
    return ijk * VOX + AFFINE[:3, 3]


# ---------------------------------------------------------------------------
# Anatomy
# ---------------------------------------------------------------------------


def _tissue_masks(points: np.ndarray) -> dict[str, np.ndarray]:
    """Masks and the ribbon coordinate for the folded-ellipsoid head.

    ``u`` is the normalised cortical depth: 0 on the white surface, 1 on the
    pial surface, negative in white matter, > 1 in CSF.  It is computed from the
    *same* folded ellipsoid the surfaces are made from, so the phantom's tissue
    boundaries and the meshes are the same iso-surfaces by construction.

    The intensity ramps from WM to GM across the ribbon rather than stepping at
    the white boundary.  That is what ``fastfuncstuff.processing.
    surface_projection.check_anat`` measures (WM-ish at depth 0.1, GM-ish at
    0.9) and it is also what a T1 at 1.5 mm looks like: the WM/GM edge is only
    partly resolved, so the ribbon carries a gradient.
    """
    d = _unit(points)
    fold = fold_field(d)
    s = 1.0 + FOLD_AMP * fold
    r = np.linalg.norm(points, axis=-1)
    r_white = ellipsoid_radius(d, WHITE_AXES) * s  # white iso-surface radius
    r_pial = ellipsoid_radius(d, PIAL_AXES) * s  # pial iso-surface radius
    u = (r - r_white) / (r_pial - r_white)
    # A 10 mm CSF shell beyond pial, i.e. the inside of the head.
    qh = np.sqrt(np.sum((points / (PIAL_AXES + 10.0)) ** 2, axis=-1))
    head = qh < 1.0
    wm = u < 0.0
    gm = (u >= 0.0) & (u <= 1.0)
    csf = head & (u > 1.0)
    # Deep folds: the outer part of the ribbon turns into CSF (a sulcal pool).
    sulcal = gm & (fold < SULCUS_FOLD) & (u > 1.0 - SULCUS_DEPTH)
    return {
        "fold": fold,
        "s": FOLD_AMP * fold,
        "u": u,
        "r_white": r_white,
        "r_pial": r_pial,
        "wm": wm,
        "gm": gm,
        "csf": csf,
        "head": head,
        "sulcal": sulcal,
        "tissue": u <= 1.0,
    }


def _ventricles(points: np.ndarray) -> np.ndarray:
    """Two lateral ventricles plus a thin third ventricle, as an ellipsoid union."""

    def ellipsoid(centre, radii):
        return np.sum(((points - np.asarray(centre)) / np.asarray(radii)) ** 2, axis=-1) < 1.0

    out = np.zeros(points.shape[:-1], bool)
    for sx in (-1.0, 1.0):
        out |= ellipsoid((sx * 7.5, -2.0, 1.0), (4.5, 13.0, 8.0))
    out |= ellipsoid((0.0, -1.0, 0.0), (1.8, 10.0, 6.0))
    return out


def build_anatomy() -> np.ndarray:
    """The 64 x 64 x 48 T1-like phantom, float32."""
    rng = np.random.default_rng(SEED_ANAT)
    p = _world_grid()
    m = _tissue_masks(p)

    img = np.zeros(SHAPE, np.float32)
    # WM -> GM transition over the first third of the ribbon (~1.4 mm), then
    # uniform grey matter: a T1 at 1.5 mm resolves exactly this much edge.
    ribbon = np.clip(m["u"] / 0.35, 0.0, 1.0)
    ramp = ribbon * ribbon * (3.0 - 2.0 * ribbon)  # smoothstep
    img[m["wm"]] = WM_INTENSITY
    img = np.where(m["gm"], WM_INTENSITY + (GM_INTENSITY - WM_INTENSITY) * ramp, img)
    img[m["csf"]] = CSF_INTENSITY
    img[m["sulcal"]] = CSF_INTENSITY
    img[_ventricles(p)] = VENTRICLE_INTENSITY

    # A little smooth intensity texture so the phantom reads as a scan rather
    # than a label map; deterministic and low amplitude.
    texture = gaussian_filter(rng.standard_normal(SHAPE), sigma=1.5)
    texture /= texture.std()
    img *= 1.0 + 0.015 * texture
    img = np.clip(img, 0.0, None).astype(np.float32)
    return img


# ---------------------------------------------------------------------------
# Task, HRF, regressor
# ---------------------------------------------------------------------------


def canonical_hrf(t: np.ndarray) -> np.ndarray:
    """SPM's canonical double-gamma HRF (peak normalised, no dispersion)."""
    t = np.asarray(t, np.float64)
    a1, b1 = 6.0, 1.0
    a2, b2 = 16.0, 1.0
    h = t ** (a1 - 1.0) * np.exp(-t / b1) / (b1**a1 * math.gamma(a1))
    h -= (1.0 / 6.0) * t ** (a2 - 1.0) * np.exp(-t / b2) / (b2**a2 * math.gamma(a2))
    h[t < 0] = 0.0
    return h


def task_regressor() -> np.ndarray:
    """Block design 20 s on / 20 s off convolved with the HRF, one value per TR."""
    dt = 0.01
    duration = N_VOLUMES * TR
    fine = np.arange(int(round(duration / dt))) * dt
    design = np.zeros_like(fine)
    onset = 0.0
    while onset < duration - 1e-9:
        design[(fine >= onset) & (fine < onset + BLOCK_ON)] = 1.0
        onset += BLOCK_ON + BLOCK_OFF
    hrf = canonical_hrf(np.arange(0.0, 32.0 + dt, dt))
    conv = np.convolve(design, hrf)[: fine.size] * dt
    # Read the series at the middle of each TR, as a scanner does.
    idx = np.clip(np.rint(((np.arange(N_VOLUMES) + 0.5) * TR) / dt).astype(int), 0, fine.size - 1)
    reg = conv[idx]
    return reg / reg.max()


def default_mode_roi(points: np.ndarray, gm: np.ndarray) -> np.ndarray:
    """Right temporoparietal and medial-prefrontal foci with a negative task response.

    The two places ``stats.nii.gz`` puts its negative t-blobs, so the functional
    run and the statistics bucket tell the same story.
    """
    def gauss(centre, sigma):
        d = np.linalg.norm(points - np.asarray(centre, np.float64), axis=-1)
        return np.exp(-0.5 * (d / sigma) ** 2)

    w = np.maximum(gauss((24.0, -26.0, 10.0), 8.0), gauss((2.0, 34.0, 10.0), 8.0))
    return (w * gm.astype(np.float64)).astype(np.float32)


def language_roi(points: np.ndarray, gm: np.ndarray) -> np.ndarray:
    """Left-lateral language ROI weight in [0, 1] on grey matter.

    Two overlapping foci on the left lateral cortex: inferior frontal
    (~[-33, 15, 6] mm, Broca-ish) and posterior superior temporal
    (~[-38, -10, -2] mm, Wernicke/STS-ish).  Both centres sit in the GM ribbon,
    not in white matter, so the mask keeps a peak weight near 1.
    """
    def gauss(centre, sigma):
        d = np.linalg.norm(points - np.asarray(centre, np.float64), axis=-1)
        return np.exp(-0.5 * (d / sigma) ** 2)

    w = np.maximum(gauss((-33.0, 15.0, 6.0), 8.0), gauss((-38.0, -10.0, -2.0), 8.0))
    return (w * gm.astype(np.float64)).astype(np.float32)


# ---------------------------------------------------------------------------
# Function
# ---------------------------------------------------------------------------


def build_function(masks: dict[str, np.ndarray], roi: np.ndarray,
                   dmn: np.ndarray) -> tuple[np.ndarray, dict]:
    """4-D task run as int16 (values in scanner units, no scaling needed)."""
    rng = np.random.default_rng(SEED_FUNC)
    reg = task_regressor()
    times = (np.arange(N_VOLUMES) + 0.5) * TR

    # Baseline with a smooth spatial bias field (scanner units, T2*-like).
    bias = gaussian_filter(rng.standard_normal(SHAPE), sigma=3.0)
    bias -= bias.min()
    bias /= max(bias.max(), 1e-9)
    baseline = BOLD_BASELINE * (0.90 + 0.20 * bias)

    # Smooth, autocorrelated low-amplitude noise (spatial sigma in voxels).
    raw = rng.standard_normal((*SHAPE, N_VOLUMES)).astype(np.float32)
    noise = gaussian_filter(raw, sigma=(NOISE_SPATIAL_SIGMA, NOISE_SPATIAL_SIGMA,
                                        NOISE_SPATIAL_SIGMA, 0.0))
    del raw
    flat = noise.reshape(-1, N_VOLUMES)
    ar = np.empty_like(flat)
    ar[:, 0] = flat[:, 0]
    for t in range(1, N_VOLUMES):
        ar[:, t] = NOISE_AR * ar[:, t - 1] + math.sqrt(1.0 - NOISE_AR**2) * flat[:, t]
    ar /= max(float(ar.std()), 1e-12)
    noise = ar.reshape(*SHAPE, N_VOLUMES)

    # Slow drift: a 160 s wave, an 80 s wave and a gentle linear trend.
    drift = (
        DRIFT_FRACTION * np.sin(2.0 * np.pi * times / 160.0 + 0.6)
        + 0.5 * DRIFT_FRACTION * np.sin(2.0 * np.pi * times / 80.0 + 1.7)
        + 0.5 * DRIFT_FRACTION * (times - 80.0) / 80.0
    )

    activation = (roi[..., None] * PSC_PEAK - dmn[..., None] * PSC_NEG) * reg[None, None, None, :]
    factor = 1.0 + activation + NOISE_FRACTION * noise + drift[None, None, None, :]
    signal = baseline[..., None] * factor

    # Only the head carries EPI signal, so the outside stays exactly zero.
    head = masks["head"][..., None]
    signal = np.where(head, signal, 0.0)

    data = np.rint(signal).astype(np.int16)
    extra = {"regressor": reg, "times": times, "roi": roi, "dmn": dmn}
    return data, extra


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------


#: Peak task t in the language ROI (kept at/below 6 for the [-6, 6] brief).
PSC_T_TEST = 5.6


def build_stats(masks: dict[str, np.ndarray], roi: np.ndarray) -> np.ndarray:
    """(nx, ny, nz, 2): t-stat then coefficient, float32, exact zero background."""
    rng = np.random.default_rng(SEED_STATS)
    p = _world_grid()
    tissue = masks["tissue"]

    def gauss(centre, sigma):
        d = np.linalg.norm(p - np.asarray(centre, np.float64), axis=-1)
        return np.exp(-0.5 * (d / sigma) ** 2)

    t = (
        PSC_T_TEST * roi
        + 3.1 * gauss((18.0, -30.0, -14.0), 7.0)  # right inferior focus
        - 4.8 * gauss((24.0, -26.0, 10.0), 8.0)  # right temporoparietal (negative)
        - 4.2 * gauss((2.0, 34.0, 10.0), 8.0)  # medial prefrontal (negative)
    )
    t *= tissue
    # Structured sub-threshold noise: what a threshold has to cut through.
    t += 0.85 * gaussian_filter(rng.standard_normal(SHAPE), sigma=1.4) * tissue
    t = np.clip(t, -6.0, 6.0).astype(np.float32)
    t[~tissue] = 0.0

    coef = (0.35 * t).astype(np.float32)
    coef[~tissue] = 0.0
    return np.stack([t, coef], axis=3)


# ---------------------------------------------------------------------------
# FreeSurfer surfaces
# ---------------------------------------------------------------------------


def direction_mesh(n_vertices: int = 10242) -> tuple[np.ndarray, np.ndarray]:
    """A Fibonacci-sphere direction set and its outward-wound triangle faces.

    The faces come from the convex hull of points on the unit sphere; the
    resulting triangulation is a closed, manifold, outward-wound sphere that the
    ellipsoid/fold model then deforms.  Same points -> same mesh every run.
    """
    i = np.arange(n_vertices) + 0.5
    phi = np.arccos(1.0 - 2.0 * i / n_vertices)
    theta = np.pi * (1.0 + 5.0**0.5) * i
    dirs = np.stack([np.cos(theta) * np.sin(phi), np.sin(theta) * np.sin(phi), np.cos(phi)], 1)
    hull = ConvexHull(dirs)
    faces = hull.simplices.astype(np.int32)
    a, b, c = dirs[faces[:, 0]], dirs[faces[:, 1]], dirs[faces[:, 2]]
    normals = np.cross(b - a, c - a)
    outward = np.einsum("ij,ij->i", normals, (a + b + c) / 3.0) > 0.0
    faces[~outward] = faces[~outward][:, ::-1]
    _check_mesh(dirs, faces)
    return dirs.astype(np.float32), faces


def _check_mesh(vertices: np.ndarray, faces: np.ndarray) -> None:
    """Fail loudly unless this is a closed, consistently wound 2-manifold."""
    edges = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    edges = np.sort(edges, axis=1)
    _, counts = np.unique(edges, axis=0, return_counts=True)
    if not np.all(counts == 2):
        raise RuntimeError("surface is not a closed 2-manifold (an edge is not shared twice)")
    euler = vertices.shape[0] - edges.shape[0] // 2 + faces.shape[0]
    if euler != 2:
        raise RuntimeError(f"surface Euler characteristic is {euler}, expected 2")
    # Faces wound outward: every face normal points away from the centre.
    a, b, c = vertices[faces[:, 0]], vertices[faces[:, 1]], vertices[faces[:, 2]]
    outward = np.einsum("ij,ij->i", np.cross(b - a, c - a), (a + b + c) / 3.0) > 0.0
    if not outward.all():
        raise RuntimeError("surface has inward-wound faces")


def _check_surface(positions: np.ndarray, faces: np.ndarray, label: str) -> None:
    """Fail loudly unless a finished surface is closed, out-facing and non-degenerate.

    The hemisphere is a *cut* surface, so the star-shaped "normal points away
    from the origin" test of :func:`_check_mesh` no longer applies.  What still
    must: every edge is shared by exactly two faces (checked on the base mesh),
    no triangle is degenerate, and the signed volume is positive, i.e. the faces
    are wound outward.
    """
    a, b, c = positions[faces[:, 0]], positions[faces[:, 1]], positions[faces[:, 2]]
    areas = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    if (areas == 0.0).any():
        raise RuntimeError(f"{label}: {int((areas == 0.0).sum())} degenerate faces")
    volume = float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)
    if volume <= 0.0:
        raise RuntimeError(f"{label}: faces are wound inward (signed volume {volume:.1f})")


def _place(dirs: np.ndarray, axes: np.ndarray, fold_damping: float) -> np.ndarray:
    """Folded ellipsoid vertices in scanner RAS, before the medial-wall cut."""
    radius = ellipsoid_radius(dirs, axes)  # mm along each direction
    scale = 1.0 + FOLD_AMP * fold_damping * fold_field(dirs)
    return (dirs * radius[:, None] * scale[:, None]).astype(np.float64)


def _cut_medial(pos: np.ndarray, hemi: str) -> np.ndarray:
    """Clamp each hemisphere's medial side onto its wall plane (x = -+1 mm)."""
    out = pos.copy()
    if hemi == "lh":
        out[:, 0] = np.minimum(out[:, 0], -MIDLINE)
    else:
        out[:, 0] = np.maximum(out[:, 0], MIDLINE)
    return out


def surface_states(dirs: np.ndarray, hemi: str) -> tuple[dict[str, np.ndarray], np.ndarray]:
    """All five surface states in scanner RAS, plus the cortex (non-wall) mask."""
    white = _place(dirs, WHITE_AXES, 1.0)
    wall = white[:, 0] > -MIDLINE if hemi == "lh" else white[:, 0] < MIDLINE
    states = {
        "white": _cut_medial(white, hemi),
        "pial": _cut_medial(_place(dirs, PIAL_AXES, 1.0), hemi),
        "smoothwm": _cut_medial(_place(dirs, SMOOTHWM_AXES, 0.45), hemi),
        "inflated": _cut_medial(_place(dirs, INFLATED_AXES, 0.35), hemi),
        "sphere": (dirs.astype(np.float64) * SPHERE_RADIUS),
    }
    return states, ~wall


# ---------------------------------------------------------------------------
# FreeSurfer subject directory
# ---------------------------------------------------------------------------


def _volume_info() -> dict[str, object]:
    """FreeSurfer volume geometry equal to the anatomy's NIfTI affine.

    ``fastfuncstuff.io.freesurfer._volume_geometry`` reconstructs vox2ras as
    ``cosines * voxelsize`` translated so that the volume *centre* (``dims / 2``)
    is at ``cras``.  Setting ``cras = AFFINE @ (dims / 2)`` therefore makes the
    reconstructed vox2ras exactly ``AFFINE`` -- the surfaces and the NIfTI share
    one scanner frame, with no hand-tuned offset.
    """
    dims = np.asarray(SHAPE, np.float64)
    cras = AFFINE[:3, :3] @ (dims / 2.0) + AFFINE[:3, 3]
    return {
        "head": np.array([2, 0, 20], np.int32),
        "valid": "1  # volume info valid",
        "filename": VOLUME_INFO_FILENAME,
        "volume": np.array(SHAPE, np.int64),
        "voxelsize": np.array([VOX, VOX, VOX], np.float64),
        "xras": np.array([1.0, 0.0, 0.0]),
        "yras": np.array([0.0, 1.0, 0.0]),
        "zras": np.array([0.0, 0.0, 1.0]),
        "cras": cras,
    }


def tkr_to_scanner(volume_info: dict[str, object]) -> np.ndarray:
    """The 4x4 that places surface vertices in scanner RAS.

    Mirrors ``fastfuncstuff.io.freesurfer._volume_geometry`` /
    :func:`tkr_to_scanner` so the build script can write vertices in the file's
    tkregister frame; the viewer then reads them straight back into world RAS.
    """
    dims = np.asarray(volume_info["volume"], np.float64)
    vs = np.asarray(volume_info["voxelsize"], np.float64)
    cosines = np.column_stack(
        [volume_info["xras"], volume_info["yras"], volume_info["zras"]]
    ).astype(np.float64)
    cras = np.asarray(volume_info["cras"], np.float64)
    centre = dims / 2.0
    vox2ras = np.eye(4)
    vox2ras[:3, :3] = cosines * vs
    vox2ras[:3, 3] = cras - vox2ras[:3, :3] @ centre
    tkr = np.eye(4)
    tkr[:3, :3] = [[-vs[0], 0.0, 0.0], [0.0, 0.0, vs[2]], [0.0, -vs[1], 0.0]]
    tkr[:3, 3] = -tkr[:3, :3] @ centre
    return vox2ras @ np.linalg.inv(tkr)


def _scanner_to_tkr(to_scanner: np.ndarray, positions: np.ndarray) -> np.ndarray:
    inv = np.linalg.inv(to_scanner)
    return (positions @ inv[:3, :3].T + inv[:3, 3]).astype(np.float32)


def _write_cortex_label(path: Path, vertex_ids: np.ndarray, coords: np.ndarray) -> None:
    """``?h.cortex.label`` in FreeSurfer's ASCII label format (0-based ids)."""
    lines = [
        f"#!ascii label  , from subject {SUBJECT_NAME} vox2ras=TkReg",
        str(int(vertex_ids.size)),
    ]
    for vid in vertex_ids:
        x, y, z = coords[int(vid)]
        lines.append(f"{int(vid)} {x:.6f} {y:.6f} {z:.6f} 0.0000000")
    path.write_text("\n".join(lines) + "\n")


#: Region names and colours for the demo ``?h.aparc.annot``.  Index 0 is
#: "unknown" and index 1 "Medial_wall" (both drawn transparent by the viewer).
APARC_NAMES = [
    "unknown",
    "Medial_wall",
    "superiorfrontal",
    "precentral",
    "postcentral",
    "paracentral",
    "supramarginal",
    "middletemporal",
    "inferiorparietal",
    "lateraloccipital",
    "parsopercularis",
    "parstriangularis",
    "insula",
    "fusiform",
]
APARC_RGBA = np.array(
    [
        [0, 0, 0, 0],
        [25, 25, 25, 0],
        [220, 180, 20, 0],
        [220, 20, 60, 0],
        [60, 140, 220, 0],
        [100, 200, 120, 0],
        [240, 120, 200, 0],
        [180, 120, 240, 0],
        [120, 200, 220, 0],
        [200, 160, 80, 0],
        [90, 120, 240, 0],
        [60, 200, 160, 0],
        [240, 200, 120, 0],
        [160, 100, 60, 0],
    ],
    np.int32,
)


def _aparc_labels(dirs: np.ndarray, cortex: np.ndarray) -> np.ndarray:
    """A small deterministic parcellation: 3 polar bands x 4 azimuth sectors."""
    u = dirs.astype(np.float64)
    theta = np.arctan2(u[:, 1], u[:, 0])
    phi = np.arccos(np.clip(u[:, 2], -1.0, 1.0))
    band = np.clip((phi / np.pi * 3.0).astype(np.int64), 0, 2)
    sector = np.floor((theta + np.pi) / (2.0 * np.pi) * 4.0).astype(np.int64) % 4
    labels = 2 + band * 4 + sector
    labels = np.where(cortex, labels, 1)  # medial wall
    return labels.astype(np.int32)


def _morph_values(
    dirs: np.ndarray, states: dict[str, np.ndarray], cortex: np.ndarray
) -> dict[str, np.ndarray]:
    """curv / sulc / thickness for the viewer's surface shading."""
    fold = fold_field(dirs)
    sulc = np.clip(-fold, -1.0, 1.0).astype(np.float32)
    curv = (0.5 * sulc).astype(np.float32)
    thickness = np.linalg.norm(states["pial"] - states["white"], axis=1).astype(np.float32)
    thickness[~cortex] = 0.0
    return {"curv": curv, "sulc": sulc, "thickness": thickness}


def _write_flat_patch(path: Path, directions: np.ndarray, faces: np.ndarray, cortex: np.ndarray) -> None:
    """Write a minimal ``?h.flat.patch.3d`` so the viewer's FLAT shape works.

    The demo has no real cortical flattening, so the patch is a deterministic
    spherical projection of the cortex: longitude/sine-latitude in the patch's
    own x/y, which ``surface3d.flat_layout`` then turns into a lateral view. It
    is a test fixture, not an anatomical flat map.
    """
    n = directions.shape[0]
    coords = np.zeros((n, 3), np.float32)
    theta = np.arctan2(directions[:, 1], directions[:, 0])
    coords[:, 0] = theta * 55.0
    coords[:, 1] = directions[:, 2] * 55.0
    mixed = faces[~np.all(cortex[faces], axis=1)]
    border = np.zeros(n, bool)
    border[np.unique(mixed.ravel())] = True
    border &= cortex
    ids = np.flatnonzero(cortex)
    record = np.zeros(ids.size, dtype=[("v", ">i4"), ("x", ">f4"), ("y", ">f4"), ("z", ">f4")])
    record["v"] = np.where(border[ids], -(ids + 1), ids + 1)
    record["x"], record["y"], record["z"] = (
        coords[ids, 0], coords[ids, 1], coords[ids, 2],
    )
    payload = np.array([-1, ids.size], ">i4").tobytes() + record.tobytes()
    Path(path).write_bytes(payload)


def write_subject(root: Path) -> dict[str, object]:
    """Write the demo FreeSurfer subject; returns mesh/bounds statistics."""
    import nibabel.freesurfer as nfs

    surf = root / "surf"
    label = root / "label"
    surf.mkdir(parents=True, exist_ok=True)
    label.mkdir(parents=True, exist_ok=True)

    info = _volume_info()
    to_scanner = tkr_to_scanner(info)
    rebuilt = np.eye(4)
    rebuilt[:3, :3] = np.column_stack([info["xras"], info["yras"], info["zras"]]) * np.asarray(
        info["voxelsize"]
    )
    rebuilt[:3, 3] = (
        np.asarray(info["cras"]) - rebuilt[:3, :3] @ (np.asarray(SHAPE, np.float64) / 2.0)
    )
    if not np.allclose(rebuilt, AFFINE, atol=1e-9):
        raise RuntimeError("FreeSurfer volume_info does not reproduce the anat affine")

    dirs, faces = direction_mesh()
    stats: dict[str, object] = {"n_vertices": int(dirs.shape[0]), "n_faces": int(faces.shape[0])}

    for hemi in ("lh", "rh"):
        states, cortex = surface_states(dirs, hemi)
        for kind, pos in states.items():
            _check_surface(pos, faces, f"{hemi}.{kind}")
        tkr = {kind: _scanner_to_tkr(to_scanner, pos) for kind, pos in states.items()}
        for kind in ("white", "pial", "inflated", "smoothwm", "sphere"):
            nfs.write_geometry(
                str(surf / f"{hemi}.{kind}"),
                tkr[kind],
                faces,
                create_stamp=SURFACE_STAMP,
                volume_info=info,
            )
        for name, values in _morph_values(dirs, states, cortex).items():
            nfs.write_morph_data(str(surf / f"{hemi}.{name}"), values)
        _write_flat_patch(surf / f"{hemi}.flat.patch.3d", dirs, faces, cortex)
        _write_cortex_label(label / f"{hemi}.cortex.label", np.flatnonzero(cortex), tkr["white"])
        nfs.write_annot(
            str(label / f"{hemi}.aparc.annot"),
            _aparc_labels(dirs, cortex),
            APARC_RGBA,
            APARC_NAMES,
        )
        stats[hemi] = {
            "white_bounds": (states["white"].min(axis=0), states["white"].max(axis=0)),
            "pial_bounds": (states["pial"].min(axis=0), states["pial"].max(axis=0)),
            "white_radius_mean": float(
                np.mean(np.linalg.norm(states["white"], axis=1))
            ),
            "pial_radius_mean": float(np.mean(np.linalg.norm(states["pial"], axis=1))),
            "inflated_radius_mean": float(
                np.mean(np.linalg.norm(states["inflated"], axis=1))
            ),
            "cortex_vertices": int(cortex.sum()),
            "thickness_mean": float(
                np.mean(np.linalg.norm(states["pial"] - states["white"], axis=1)[cortex])
            ),
        }
    stats["tkr_to_scanner"] = to_scanner
    stats["volume_info"] = info
    return stats


# ---------------------------------------------------------------------------
# NIfTI writing
# ---------------------------------------------------------------------------


def _afni_extension(labels: list[str], stataux: dict[int, tuple[int, tuple[float, ...]]],
                    n_sub: int) -> bytes:
    """An AFNI XML NIfTI extension carrying BRICK_LABS / BRICK_STATAUX / STATSYM.

    NIfTI has no sub-brick labels; AFNI keeps them in extension code 4.  Writing
    them means the viewer sees ``tstat`` / ``coef`` (and so draws the coefficient
    as a signed effect map, not as time) and can turn the t into a p.
    """
    floats: list[float] = []
    for idx in sorted(stataux):
        code, params = stataux[idx]
        floats.extend([float(idx), float(code), float(len(params))])
        floats.extend(float(x) for x in params)
    syms = []
    for i in range(n_sub):
        if i not in stataux:
            syms.append("none")
            continue
        code, params = stataux[i]
        if code == 3:
            syms.append(f"Ttest({int(params[0])})")
        elif code == 4:
            syms.append(f"Ftest({int(params[0])},{int(params[1])})")
        else:
            syms.append("none")
    aux_body = "\n ".join(f"{v:g}" for v in floats)
    payload = (
        "<?xml version='1.0' ?>\n"
        "<AFNI_attributes\n"
        f'  self_idcode="{AFNI_IDCODE}"\n'
        '  ni_form="ni_group" >\n'
        "<AFNI_atr\n"
        '  ni_type="String"\n'
        '  ni_dimen="1"\n'
        '  atr_name="BRICK_LABS" >\n'
        f' "{"~".join(labels)}"\n'
        "</AFNI_atr>\n"
        "<AFNI_atr\n"
        '  ni_type="float"\n'
        f'  ni_dimen="{len(floats)}"\n'
        '  atr_name="BRICK_STATAUX" >\n'
        f" {aux_body}\n"
        "</AFNI_atr>\n"
        "<AFNI_atr\n"
        '  ni_type="String"\n'
        '  ni_dimen="1"\n'
        '  atr_name="BRICK_STATSYM" >\n'
        f' "{";".join(syms)}"\n'
        "</AFNI_atr>\n"
        "</AFNI_attributes>\n\x00"
    )
    return payload.encode("utf-8")


def _save(img: nib.Nifti1Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    nib.save(img, str(path))


def write_niftis(root: Path, anat: np.ndarray, func: np.ndarray, stats: np.ndarray,
                 extra: dict) -> dict[str, dict]:
    """Write the three NIfTI files; returns {name: summary} of what was written."""
    out: dict[str, dict] = {}

    anat_img = nib.Nifti1Image(anat, AFFINE)
    anat_img.header.set_zooms((VOX, VOX, VOX))
    anat_img.header.set_xyzt_units("mm")
    anat_img.header["descrip"] = "ffs synthetic demo: T1-like phantom, 1.5 mm"
    _save(anat_img, root / "anat.nii.gz")
    out["anat.nii.gz"] = {"shape": anat.shape, "dtype": "float32"}

    func_img = nib.Nifti1Image(func, AFFINE)
    func_img.header.set_zooms((VOX, VOX, VOX, TR))
    func_img.header.set_xyzt_units("mm", "sec")
    func_img.header["descrip"] = "ffs synthetic demo: 20s on/20s off task, TR=2.0s"
    _save(func_img, root / "func.nii.gz")
    out["func.nii.gz"] = {"shape": func.shape, "dtype": "int16"}

    stats_img = nib.Nifti1Image(stats, AFFINE)
    stats_img.header.set_zooms((VOX, VOX, VOX, 1.0))
    stats_img.header.set_xyzt_units("mm", "unknown")
    stats_img.header["descrip"] = "ffs synthetic demo: sub-brick 0 tstat, 1 coef"
    stats_img.header.extensions.append(
        nib.nifti1.Nifti1Extension(
            4,
            _afni_extension(
                ["tstat", "coef"],
                {0: (3, (76.0,))},
                stats.shape[3],
            ),
        )
    )
    _save(stats_img, root / "stats.nii.gz")
    out["stats.nii.gz"] = {"shape": stats.shape, "dtype": "float32"}

    reg_path = root / "task_regressor.1D"
    reg_path.write_text("\n".join(f"{v:.6f}" for v in extra["regressor"]) + "\n")
    out["task_regressor.1D"] = {"shape": (N_VOLUMES,), "dtype": "text"}

    return out


# ---------------------------------------------------------------------------
# README
# ---------------------------------------------------------------------------


def _size(path: Path) -> str:
    n = path.stat().st_size
    return f"{n / 1024.0:.1f} KiB" if n < 1024 * 1024 else f"{n / 1024.0 / 1024.0:.2f} MiB"


def write_readme(root: Path, subject: dict[str, object]) -> None:
    aff = "\n".join("    " + "  ".join(f"{v:9.4f}" for v in row) for row in AFFINE)
    vi = subject["volume_info"]
    lh, rh = subject["lh"], subject["rh"]
    lh_white = lh["white_bounds"]
    rh_white = rh["white_bounds"]
    text = f"""# Synthetic demo dataset

A small, fully synthetic, deterministic dataset for exercising the ffs viewer
end to end: a T1-like anatomy, a task fMRI run, a stats bucket, and a
co-registered FreeSurfer subject whose `white`/`pial` surfaces are the exact
white-matter / grey-matter boundaries of the anatomy.  Nothing here is real
human data; every value is generated by `scripts/build_demo_data.py`.

## Regenerating

From the repository root, with the virtual environment's Python:

```bash
.venv/bin/python scripts/build_demo_data.py
```

The script needs only `numpy`, `scipy` and `nibabel`, uses fixed seeds
({SEED_ANAT}, {SEED_FUNC}, {SEED_STATS}), writes fixed creation stamps, and
never touches the network.  Two runs produce byte-identical files.

To verify with the viewer's own reading/sampling code:

```bash
PYTHONPATH=reference/fastfuncstuff .venv/bin/python - <<'PY'
import numpy as np, torch
from fastfuncstuff.viewer.session import ViewerSession
from fastfuncstuff.viewer.vocab import LoadSurfaces
s = ViewerSession(device=torch.device("cpu"))
s.load("data/demo/anat.nii.gz"); s.load("data/demo/func.nii.gz")
s.load("data/demo/stats.nii.gz")
s.do(LoadSurfaces("data/demo/subject", "lh,rh"))
print(s.state.grid.shape, s.state.layers.keys, s.surfaces.meshes)
PY
```

## Files

### `anat.nii.gz` — T1-like phantom

* Shape **{SHAPE[0]} x {SHAPE[1]} x {SHAPE[2]}**, dtype **float32** on disk,
  **{VOX} mm** isotropic voxels, size {_size(root / "anat.nii.gz")}.
* RAS+ affine, centred on the origin (voxel centre `(0,0,0)` is at
  `(-{abs(AFFINE[0, 3]):.2f}, -{abs(AFFINE[1, 3]):.2f}, -{abs(AFFINE[2, 3]):.2f})` mm):

```
{aff}
```

* Intensities (arbitrary T1-like units): white matter {WM_INTENSITY:g}, grey
  matter {GM_INTENSITY:g}, CSF {CSF_INTENSITY:g}, ventricles
  {VENTRICLE_INTENSITY:g}, background 0, plus 1.5 % smooth texture.
* Anatomy model: folded anisotropic ellipsoid, white-matter semi-axes
  {WHITE_AXES[0]:g}/{WHITE_AXES[1]:g}/{WHITE_AXES[2]:g} mm, grey-matter shell to
  pial semi-axes {PIAL_AXES[0]:g}/{PIAL_AXES[1]:g}/{PIAL_AXES[2]:g} mm, a 4 mm
  cortical ribbon whose boundary is modulated by a deterministic fold field
  (amplitude +-{FOLD_AMP * 100:.0f} % of the local radius, i.e. up to about
  +-{FOLD_AMP * WHITE_AXES[0]:.0f} mm), lateral ventricles, a third ventricle, and
  dark CSF in the deepest folds.  The FOV is 96 x 96 x 72 mm, so the brain fills
  it without touching the edges.

### `func.nii.gz` — task fMRI run

* Shape **{SHAPE[0]} x {SHAPE[1]} x {SHAPE[2]} x {N_VOLUMES}**, dtype **int16**
  on disk (no scaling; values are scanner units, baseline ~{BOLD_BASELINE:g}),
  size {_size(root / "func.nii.gz")}.  Same affine as `anat`.
* **TR = {TR:g} s**, {N_VOLUMES} volumes = {N_VOLUMES * TR:g} s, `pixdim[4]` =
  {TR:g}, time units seconds.  Only the head carries signal; outside is exactly 0.
* Task: block design **{BLOCK_ON:g} s on / {BLOCK_OFF:g} s off**, four cycles
  (onsets at 0, 40, 80, 120 s), convolved with the canonical SPM double-gamma
  HRF (peaks at 6 s and 16 s, second lobe scaled to 1/6).
* Activation: a **left-lateral language ROI** (two overlapping Gaussian foci in
  the left inferior-frontal and posterior-superior-temporal cortex) with a peak
  of **{PSC_PEAK * 100:.1f} % signal change** in grey matter, plus **{PSC_NEG * 100:.1f} %
  negative task responses** at the right temporoparietal and medial-prefrontal
  foci.  The same ROIs are used for the t-blobs in `stats.nii.gz`, so the two
  files tell the same story.
* Noise: smooth (Gaussian sigma ~{NOISE_SPATIAL_SIGMA * VOX:g} mm), temporally
  autocorrelated (AR(1) rho={NOISE_AR:g}) BOLD noise at
  ~{NOISE_FRACTION * 100:.2f} % of baseline, plus a slow drift (a 160 s and an
  80 s wave and a small linear trend, together under 1.6 %).

### `task_regressor.1D` — the task regressor

One value per TR ({N_VOLUMES} rows, 6 decimal places): the 20 s on / 20 s off
boxcar convolved with the canonical HRF and peak-normalised to 1.  Useful for a
GLM or a design plot without recomputing the convolution.

### `stats.nii.gz` — statistics bucket

* Shape **{SHAPE[0]} x {SHAPE[1]} x {SHAPE[2]} x 2**, dtype **float32**, size
  {_size(root / "stats.nii.gz")}; sub-brick index spacing 1 (this is not a time
  axis).  Same affine as `anat`.
* Sub-brick 0 = **t-statistic**, values in **[-6, 6]**, Student-t with 76 degrees
  of freedom.  Positive task blobs reach about **+5.6** in the same language ROI
  as the functional run (plus a right inferior focus ~+3.1); negative blobs
  reach about **-4.8** (right temporoparietal) and **-4.2** (medial prefrontal).
  Smooth sub-threshold noise (sigma ~1.4 voxels, ~0.85) is added in tissue only.
* Sub-brick 1 = **coefficient / effect size**, `0.35 * t` in percent-signal
  units, so about **-1.7 to +2.0**.
* Background **outside the brain is exactly 0** (no NaNs anywhere), so a
  threshold can be demonstrated cleanly: at |t| > 3 most of the map drops out and
  the above blobs remain.
* AFNI NIfTI extension: `BRICK_LABS = tstat~coef`, `BRICK_STATAUX = 0 3 1 76`
  (t-test, 76 DoF), `BRICK_STATSYM = Ttest(76);none`.  The viewer therefore shows
  sub-brick 0 as the t map, sub-brick 1 as a signed coefficient, and can turn t
  into p; sub-brick labels also stop it treating the bucket as a time series.

### `subject/` — FreeSurfer subject (`{SUBJECT_NAME}`)

```
subject/
  surf/lh.white  lh.pial  lh.inflated  lh.smoothwm  lh.sphere
  surf/rh.white  rh.pial  rh.inflated  rh.smoothwm  rh.sphere
  surf/lh.curv  lh.sulc  lh.thickness        (same for rh)
  surf/lh.flat.patch.3d  rh.flat.patch.3d    (synthetic test flattening)
  label/lh.cortex.label  rh.cortex.label
  label/lh.aparc.annot   rh.aparc.annot
```

* Each surface is **{subject["n_vertices"]:,} vertices / {subject["n_faces"]:,}
  triangles**, a closed, manifold, outward-wound Fibonacci-sphere triangulation
  deformed by the same fold model as the anatomy.  `white`, `pial`, `smoothwm`
  and `inflated` share the same faces and vertex numbering, as FreeSurfer
  requires; `sphere` is the full registration sphere (radius {SPHERE_RADIUS:g} mm).
* Files are written by `nibabel.freesurfer.write_geometry` with identical
  `volume_info` on every surface:

  | field | value |
  |---|---|
  | `head` | `[2, 0, 20]` |
  | `valid` | `1  # volume info valid` |
  | `filename` | `{VOLUME_INFO_FILENAME}` |
  | `volume` | `{[int(v) for v in vi["volume"]]}` |
  | `voxelsize` | `{[float(v) for v in vi["voxelsize"]]}` |
  | `xras`/`yras`/`zras` | `{[float(v) for v in vi["xras"]]}` / `{[float(v) for v in vi["yras"]]}` / `{[float(v) for v in vi["zras"]]}` |
  | `cras` | `{[round(float(v), 4) for v in vi["cras"]]}` |

  `cras` is `AFFINE @ (dims / 2)`, which makes FreeSurfer's reconstructed
  `vox2ras` exactly the anatomy's NIfTI affine, so
  `fastfuncstuff.io.freesurfer.read_scanner_surface` puts every vertex in the
  same scanner RAS as `anat.nii.gz`.  No manual offset is applied anywhere.

* Nominal radii (+-{FOLD_AMP * 100:.0f} % folding): white
  {WHITE_AXES[0]:g}/{WHITE_AXES[1]:g}/{WHITE_AXES[2]:g} mm, pial
  {PIAL_AXES[0]:g}/{PIAL_AXES[1]:g}/{PIAL_AXES[2]:g} mm, inflated
  {INFLATED_AXES[0]:g}/{INFLATED_AXES[1]:g}/{INFLATED_AXES[2]:g} mm.
  Mean vertex radius measured from the scanner origin (the flat medial wall
  pulls this below the nominal semi-axes): lh white
  {lh["white_radius_mean"]:.1f} mm / pial {lh["pial_radius_mean"]:.1f} mm /
  inflated {lh["inflated_radius_mean"]:.1f} mm; rh white
  {rh["white_radius_mean"]:.1f} / pial {rh["pial_radius_mean"]:.1f} /
  inflated {rh["inflated_radius_mean"]:.1f} mm.
* Bounds (scanner RAS, mm): lh white x [{lh_white[0][0]:.1f}, {lh_white[1][0]:.1f}],
  y [{lh_white[0][1]:.1f}, {lh_white[1][1]:.1f}],
  z [{lh_white[0][2]:.1f}, {lh_white[1][2]:.1f}]; rh white
  x [{rh_white[0][0]:.1f}, {rh_white[1][0]:.1f}],
  y [{rh_white[0][1]:.1f}, {rh_white[1][1]:.1f}],
  z [{rh_white[0][2]:.1f}, {rh_white[1][2]:.1f}].
* The medial wall (where the two hemispheres' `x = -+{MIDLINE:g} mm` cut planes
  are) is excluded from `label/?h.cortex.label`, and labelled `Medial_wall`
  in the annotation, exactly as a real FreeSurfer subject would be.
* Mean cortical thickness (white to pial, mm):
  lh {lh["thickness_mean"]:.2f}, rh {rh["thickness_mean"]:.2f}.  Cortex vertices:
  lh {lh["cortex_vertices"]:,}, rh {rh["cortex_vertices"]:,}.
* `label/?h.aparc.annot` is a deterministic toy parcellation (3 polar bands
  x 4 azimuth sectors, plus `unknown` and `Medial_wall`) with region names and
  colours a viewer can display; it is not an anatomical atlas.

## Sizes

| file | size |
|---|---|
"""
    for name in ("anat.nii.gz", "func.nii.gz", "stats.nii.gz", "task_regressor.1D"):
        text += f"| `{name}` | {_size(root / name)} |\n"
    for hemi in ("lh", "rh"):
        surf_bytes = sum((root / "subject" / "surf" / f"{hemi}.{k}").stat().st_size
                         for k in ("white", "pial", "inflated", "smoothwm", "sphere",
                                   "curv", "sulc", "thickness"))
        text += f"| `subject/surf/{hemi}.*` | {surf_bytes / 1024.0:.1f} KiB |\n"
    text += (
        "\n`func.nii.gz` stays small because it is stored as int16 and the noise "
        "is spatially and temporally smooth; it is far below the ~25 MB limit.\n"
    )

    (root / "README.md").write_text(text)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    root = Path(__file__).resolve().parent.parent / "data" / "demo"
    root.mkdir(parents=True, exist_ok=True)

    print("building anatomy ...")
    anat = build_anatomy()
    masks = _tissue_masks(_world_grid())
    roi = language_roi(_world_grid(), masks["gm"])
    dmn = default_mode_roi(_world_grid(), masks["gm"])
    print(f"  tissue voxels: wm={int(masks['wm'].sum())}, gm={int(masks['gm'].sum())}, "
          f"csf={int(masks['csf'].sum())}; ROI peak weight={float(roi.max()):.3f}")

    print("building function ...")
    func, extra = build_function(masks, roi, dmn)

    print("building stats ...")
    stats = build_stats(masks, roi)

    print("writing NIfTIs ...")
    written = write_niftis(root, anat, func, stats, extra)

    print("writing FreeSurfer subject ...")
    subject = write_subject(root / "subject")

    print("writing README ...")
    write_readme(root, subject)

    print("\nwritten files:")
    for name, meta in written.items():
        print(f"  {name:24s} {str(meta['shape']):28s} {meta['dtype']:8s} "
              f"{_size(root / name)}")
    surf = root / "subject" / "surf"
    total = sum(p.stat().st_size for p in root.rglob("*") if p.is_file())
    print(f"\nsubject: {subject['n_vertices']} vertices / {subject['n_faces']} faces "
          f"per hemisphere, {len(list(surf.iterdir()))} surf files")
    print(f"total data/demo size: {total / 1024.0 / 1024.0:.2f} MiB")


if __name__ == "__main__":
    main()
