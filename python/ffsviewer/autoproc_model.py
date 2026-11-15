#!/usr/bin/env python3
"""The `ffs_autoproc` CLI model, for the analysis panel.

This module is the single source of truth for the panel's planner: it reads the installed
``ffs_autoproc`` argument parser and recipe presets, adds the curated stage plan the panel
shows, and prints one JSON object. The Host half caches the output by the source hash of the
autoproc/config modules, so a new upstream flag appears in the UI without JavaScript edits.

Run directly::

    .venv/bin/python -m ffsviewer.autoproc_model > /tmp/autoproc-model.json

The panel treats the result as advisory: the generated script remains the authority for what
actually runs. Nothing here executes or writes anything.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

MODEL_SCHEMA = "ffs-autoproc-model/1"

# Recipe descriptions copied from ``ffs_autoproc --help``. Kept here (not in JS) so the panel
# and the CLI help cannot drift silently; the test suite compares them to the help text.
RECIPE_DESCRIPTIONS = {
    "bare_bones": "moco (to sbref/first volume) + GLM, in EPI space. No slice timing, distortion or anat. Fast.",
    "simple": "slice timing (if present) + distortion (if fmaps) + moco + cross-run align + LINEAR anat + GLM.",
    "simple_linear": "alias of simple.",
    "simple_nonlin": "simple, plus nonlinear cross-run refinement.",
    "complete": "simple_nonlin, plus NONLINEAR anat (ffs_segment; needs -anat/-suma and a TPM).",
    "extreme": "complete, plus locomoco (residual NL motion); GLM nuisance = motion + motion deriv + locomoco warp-PCs.",
}

# Parser defaults before a recipe is applied: autoproc's plan defaults are anat-on,
# distortion-on (when fmaps exist) and GLM-on.
DEFAULT_PLAN = {
    "go_to_anat": True,
    "distortion": True,
    "run_glm": True,
    "slicetiming_method": None,
    "locomoco": False,
}

# One row per emitted script section, in script order. "when" is a list of clauses, each
# satisfied by ANY of its tokens (``any``) and all clauses ANDed together. Tokens:
#   always | flag:<dest> | recipe:<field> | data:<key> | min_runs:N | min_sessions:N |
#   min_fmaps:N | override:<dest> | not:override:<dest>
# The token that makes a stage inapplicable names its reason (``reason_text`` below).
STAGES = [
    {
        "id": "preflight",
        "label": "preflight",
        "phase": "Prep",
        "tools": [],
        "when": [{"any": ["always"]}],
        "flags": [],
        "opts": [],
        "outputs": [],
    },
    {
        "id": "stage00",
        "label": "NORDIC / phase",
        "phase": "Denoise",
        "tools": ["ffs_nordic", "ffs_phase_unwrap"],
        "when": [{"any": ["flag:want_nordic", "flag:phase_proc", "data:phase"]}],
        "flags": [
            "want_nordic", "noise_vols", "cut_task_vols", "phase_proc", "no_phase_drift",
            "nordic_save_resid", "nordic_task_rescue", "nordic_task_qc",
            "nordic_dof_adjust", "unwrap_opts",
        ],
        "opts": ["nordic_opts", "unwrap_opts"],
        "outputs": ["stage00.nordic.*", "stage00.phase.*"],
    },
    {
        "id": "stage00_physio",
        "label": "physio",
        "phase": "Denoise",
        "tools": ["ffs_physio"],
        "when": [{"any": ["override:physio"]}],
        "flags": ["physio", "physio_mode", "tzero"],
        "opts": [],
        "outputs": ["stage00.physio.*"],
    },
    {
        "id": "stage01",
        "label": "slice timing / MEDIC",
        "phase": "Timing & motion",
        "tools": ["ffs_tshift", "ffs_medic"],
        "when": [{"any": ["data:slicetiming", "override:slicetiming", "override:slicetiming_method", "flag:medic"]}],
        "flags": ["acq", "slicetiming_method", "slicetiming", "tzero", "tr", "medic", "medic_inplane_locomoco", "tshift_opts"],
        "opts": ["tshift_opts"],
        "outputs": ["stage01.*"],
    },
    {
        "id": "stage02",
        "label": "moco",
        "phase": "Timing & motion",
        "tools": ["ffs_moco"],
        "when": [{"any": ["always"]}],
        "flags": ["moco_ref", "motsim", "censor_motion", "censor_outliers"],
        "opts": ["moco_opts"],
        "outputs": ["stage02.moco.*", "*.motsim.1D"],
    },
    {
        "id": "stage03",
        "label": "locomoco",
        "phase": "Timing & motion",
        "tools": ["ffs_locomoco"],
        "when": [{"any": ["recipe:locomoco", "flag:locomoco"]}],
        "flags": ["locomoco", "locomoco_detask", "locomoco_phase", "locomoco_task_qc"],
        "opts": ["locomoco_opts"],
        "outputs": ["stage03.locomoco.*"],
    },
    {
        "id": "stage04",
        "label": "fieldmap distortion",
        "phase": "Distortion",
        "tools": ["ffs_blipflip", "ffs_util_b0fmap"],
        "when": [{"any": ["recipe:distortion"]}, {"any": ["not:override:no_distortion"]}, {"any": ["data:fieldmaps"]}],
        "flags": ["no_distortion", "fmap_kind", "fmap_pe_dir", "fmap_ref"],
        "opts": ["blip_opts", "b0fmap_opts"],
        "outputs": ["stage04.*"],
    },
    {
        "id": "stage05",
        "label": "cross-fmap alignment",
        "phase": "Distortion",
        "tools": ["ffs_allineate", "ffs_moco"],
        "when": [
            {"any": ["recipe:distortion"]},
            {"any": ["not:override:no_distortion"]},
            {"any": ["data:fieldmaps"]},
            {"any": ["min_fmaps:2"]},
        ],
        "flags": ["xfmap_nonlin", "xfmap_nl_backend"],
        "opts": ["xfmap_opts", "xfmap_nl_opts"],
        "outputs": ["stage05.*"],
    },
    {
        "id": "stage06",
        "label": "cross-run alignment",
        "phase": "Alignment",
        "tools": ["ffs_allineate", "ffs_moco"],
        "when": [{"any": ["min_runs:2"]}],
        "flags": ["xrun_method", "xrun_nonlin", "xrun_nl_backend", "xrun_nonlin_in_source"],
        "opts": ["xrun_opts", "xrun_moco_opts", "xrun_nl_opts"],
        "outputs": ["stage06.*"],
    },
    {
        "id": "stage07",
        "label": "run + session means",
        "phase": "Alignment",
        "tools": [],
        "when": [{"any": ["always"]}],
        "flags": [],
        "opts": [],
        "outputs": ["stage07.*"],
    },
    {
        "id": "stage08",
        "label": "cross-session / grandmean",
        "phase": "Alignment",
        "tools": ["ffs_allineate"],
        "when": [{"any": ["always"]}],
        "flags": ["xses_nonlin", "xses_nl_backend", "xses_nonlin_in_source", "grand_reference", "grand_reference_nonlin", "ref_ses"],
        "opts": ["xses_opts", "xses_nl_opts"],
        "outputs": ["stage08.*", "stage08b.*"],
    },
    {
        "id": "stage08b",
        "label": "runs to grandmean space",
        "phase": "Alignment",
        "tools": ["ffs_nwarp"],
        "when": [{"any": ["always"]}],
        "flags": [],
        "opts": [],
        "outputs": ["stage08b.*"],
    },
    {
        "id": "stage09",
        "label": "anat alignment",
        "phase": "Alignment",
        "tools": ["ffs_allineate", "ffs_segment", "ffs_nwarp"],
        "when": [{"any": ["recipe:go_to_anat"]}, {"any": ["not:override:no_anat"]}],
        "flags": [
            "anat", "suma", "fs_subject", "anat_skull", "presurf", "presurf_denoise",
            "presurf_tpm", "spm_tpm", "anat_t2", "anat_nonlin", "anat_nonlin_method",
            "ref_anat", "ref_anat_inv2", "ref_anat_inv1", "ref_anat_nonlin_method",
            "tpm", "tpm_source", "anat_source", "anat_nonlin_input", "ref_file",
            "ref_transforms", "ref_file_anat", "nl_backend", "family", "family_ref",
            "family_link", "xfam_nonlin", "xfam_nl_backend",
        ],
        "opts": [
            "anat_opts", "segment_opts", "segment_fstpm_opts", "anat_tpm_opts",
            "ref_anat_opts", "ref_anat_seg_opts", "ref_anat_nl_opts", "anat_t2_opts",
            "anat_avg_opts", "synthstrip_opts", "presurf_opts", "anat_nl_opts",
        ],
        "outputs": ["stage09.*"],
    },
    {
        "id": "stage09b",
        "label": "anat to MNI",
        "phase": "Alignment",
        "tools": ["ffs_nwarp", "ffs_optiwarp", "ffs_qwarp", "ffs_formwarp"],
        "when": [
            {"any": ["recipe:go_to_anat"]},
            {"any": ["not:override:no_anat"]},
            {"any": ["override:do_mni"]},
        ],
        "flags": ["do_mni", "mni_use", "mni_template"],
        "opts": ["mni_opts", "mni_nonlin_opts"],
        "outputs": ["stage09b.*"],
    },
    {
        "id": "stage10a",
        "label": "warpmaster",
        "phase": "Resample",
        "tools": ["ffs_nwarp"],
        "when": [{"any": ["always"]}],
        "flags": ["final_dxyz"],
        "opts": ["nwarp_opts"],
        "outputs": [],
    },
    {
        "id": "stage10",
        "label": "final compose + resample",
        "phase": "Resample",
        "tools": ["ffs_nwarp"],
        "when": [{"any": ["always"]}],
        "flags": ["final_dxyz", "batch_overwrite"],
        "opts": ["nwarp_opts"],
        "outputs": ["stage10.final.*"],
    },
    {
        "id": "stage10b",
        "label": "masks",
        "phase": "Resample",
        "tools": ["ffs_util_automask"],
        "when": [{"any": ["always"]}],
        "flags": ["glm_mask"],
        "opts": [],
        "outputs": ["stage10.mask_*"],
    },
    {
        "id": "stage10s",
        "label": "surface sampling",
        "phase": "Resample",
        "tools": ["ffs_nwarp"],
        "when": [{"any": ["override:surface_target"]}],
        "flags": ["surface_target", "surface_qc", "fs_subject"],
        "opts": [],
        "outputs": ["stage10s.surf.*"],
    },
    {
        "id": "stage12",
        "label": "GLM",
        "phase": "Model",
        "tools": ["ffs_reml"],
        "when": [{"any": ["recipe:run_glm"]}, {"any": ["not:override:no_glm"]}],
        "flags": [
            "no_glm", "glm_ortvec", "glm_stim_vec", "glm_opts", "glm_drop_first",
            "glm_drop_last", "glm_blur", "glm_mask", "glm_label", "clustsim",
            "clustsim_null", "glm_blur_to", "glm_blur_local", "glm_blur_tsnr",
            "glm_blur_max_fwhm", "glm_blur_nbhd", "glm_spec_overwrite", "events",
            "spec_event_cols", "sep_spec_event_cols", "event_ignore", "sep_event_ignore",
            "round_onsets", "round_durations", "event_filter_in", "event_filter_out",
            "prebuilt_contrasts",
        ],
        "opts": [],
        "outputs": ["stage12.*"],
    },
    {
        "id": "stage12s",
        "label": "surface GLM",
        "phase": "Model",
        "tools": ["ffs_reml"],
        "when": [
            {"any": ["recipe:run_glm"]},
            {"any": ["not:override:no_glm"]},
            {"any": ["override:surface_glm"]},
            {"any": ["override:surface_target"]},
        ],
        "flags": [
            "surface_glm", "surface_glm_blur", "surface_glm_blur_to",
            "surface_glm_blur_local", "surface_glm_blur_tsnr",
            "surface_glm_blur_max_fwhm", "surface_glm_blur_nbhd",
            "surface_clustsim", "surface_clustsim_niter", "surface_glm_opts",
        ],
        "opts": [],
        "outputs": ["stage12s.*"],
    },
]

# Human text for the token that makes a stage inapplicable.
REASON_TEXT = {
    "data:phase": "no phase data detected",
    "data:slicetiming": "no SliceTiming in the sidecars",
    "override:slicetiming": "no slice timing input given",
    "override:slicetiming_method": "slice timing method not set",
    "data:fieldmaps": "no fieldmaps detected",
    "min_fmaps:2": "only one fieldmap group",
    "min_runs:2": "only one functional run",
    "min_sessions:2": "only one session",
    "recipe:go_to_anat": "anatomical space not in this recipe",
    "recipe:distortion": "distortion correction not in this recipe",
    "recipe:run_glm": "GLM disabled",
    "recipe:locomoco": "locomoco not in this recipe",
    "override:do_mni": "-do_mni not set",
    "override:surface_target": "no -surface_target given",
    "override:physio": "no -physio given",
    "override:surface_glm": "-surface_glm not set",
    "not:override:no_distortion": "-no_distortion set",
    "not:override:no_anat": "-no_anat set",
    "not:override:no_glm": "-no_glm set",
    "flag:want_nordic": "-want_nordic not set",
    "flag:phase_proc": "-phase_proc not set",
    "flag:locomoco": "-locomoco not set",
    "flag:medic": "-medic not set",
}


def _jsonable(value):
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    return str(value)


# Argparse action classes whose flag inverts the destination's default.
ACTION_KINDS = {
    "_StoreTrueAction": "store_true",
    "_StoreFalseAction": "store_false",
    "_StoreAction": "store",
    "_AppendAction": "append",
    "_ExtendAction": "extend",
    "_CountAction": "count",
    "_StoreConstAction": "store_const",
}

# Flags whose value is a project-relative path (or a list of them).
PATH_FLAGS = [
    "anat", "suma", "fs_subject", "tpm", "spm_tpm", "anat_t2", "presurf_tpm",
    "ref_anat", "ref_anat_inv1", "ref_anat_inv2", "ref_file", "ref_file_anat",
    "mni_template", "tissue", "ref_transforms", "grand_reference", "surface_target",
]


def _flag(action: argparse.Action) -> dict:
    option = next((item for item in action.option_strings if item.startswith("-")), None)
    takes_value = action.nargs != 0
    if action.nargs in ("+", "*") or (isinstance(action.nargs, int) and action.nargs > 0):
        kind = "list"
    elif takes_value:
        kind = "value"
    else:
        kind = "bool"
    action_kind = ACTION_KINDS.get(type(action).__name__, "store")
    value_type = getattr(action.type, "__name__", None) if action.type else None
    return {
        "dest": action.dest,
        "flag": option,
        "aliases": list(action.option_strings),
        "default": _jsonable(action.default),
        "choices": _jsonable(list(action.choices)) if action.choices else None,
        "help": action.help if action.help and action.help is not argparse.SUPPRESS else "",
        "takesValue": takes_value,
        "nargs": action.nargs if isinstance(action.nargs, (str, int)) else None,
        "kind": kind,
        "action": action_kind,
        "type": value_type,
    }


def _source_hash(*files: Path) -> str:
    digest = hashlib.sha256()
    for file in files:
        digest.update(file.name.encode())
        digest.update(file.read_bytes())
    return digest.hexdigest()


def build_model() -> dict:
    """Build the panel model from the installed ffs_autoproc. No side effects."""
    from fastfuncstuff.autoproc import config
    from fastfuncstuff.cli import autoproc

    parser = autoproc.build_parser()  # noqa: SLF001 - the CLI's own model
    groups = []
    flag_count = 0
    for group in parser._action_groups:  # noqa: SLF001 - argparse exposes no public API
        actions = [
            action for action in group._group_actions  # noqa: SLF001
            if any(option not in ("-h", "--help") for option in action.option_strings)
        ]
        if not actions:
            continue
        flags = [_flag(action) for action in actions]
        flag_count += len(flags)
        groups.append({"id": (group.title or "options").strip().lower().replace(" ", "-"),
                       "title": group.title or "Options", "flags": flags})

    recipes = [
        {
            "id": name,
            "description": RECIPE_DESCRIPTIONS.get(name, ""),
            "settings": _jsonable(settings),
        }
        for name, settings in config.RECIPES.items()
    ]
    recipes.sort(key=lambda item: item["id"])

    autoproc_path = Path(autoproc.__file__).resolve()
    config_path = Path(config.__file__).resolve()
    stages = []
    for stage in STAGES:
        stages.append({**stage, "flags": list(stage["flags"]), "opts": list(stage["opts"]),
                       "tools": list(stage["tools"]), "when": list(stage["when"])})

    opts_overrides = sum(len(group["flags"]) for group in groups
                         if group["title"].lower().startswith("per-stage"))
    return {
        "schema": MODEL_SCHEMA,
        "source": {
            "autoproc": str(autoproc_path),
            "config": str(config_path),
            "sha256": _source_hash(autoproc_path, config_path),
        },
        "totals": {
            "flags": flag_count,
            "groups": len(groups),
            "recipes": len(recipes),
            "stages": len(stages),
            "optsOverrides": opts_overrides,
        },
        "recipes": recipes,
        "defaults": DEFAULT_PLAN,
        "pathFlags": PATH_FLAGS,
        "stages": stages,
        "reasonText": REASON_TEXT,
        "groups": groups,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Dump the ffs_autoproc model as JSON")
    parser.add_argument("--check", action="store_true", help="validate counts, print a summary")
    parser.add_argument("--pretty", action="store_true", help="indent the JSON")
    args = parser.parse_args(argv)
    model = build_model()
    if args.check:
        totals = model["totals"]
        print(json.dumps({"ok": True, "totals": totals}, indent=2 if args.pretty else None))
        return 0
    print(json.dumps(model, indent=1 if args.pretty else None, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
