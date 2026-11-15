"""Policy loading for the FFS preference profile (RECORD.md §7.3).

The project owns `work/ffs-record/preferences/policy.yaml` after first use; the defaults below
are written there so the file, not code, is authoritative. Profiles are derived from evidence;
this module only supplies thresholds.
"""

from __future__ import annotations

import json
from pathlib import Path

import yaml

DEFAULT_POLICY = {
    "policy": {
        "recency": {"halfLifeDays": 90},
        "observation": {
            "candidate": {"minSessions": 3, "minOccurrences": 6},
            "established": {"minSessions": 8, "minScore": 0.75},
        },
        "scientificKinds": [
            "qc", "exclusion", "threshold", "model", "contrast",
            "group-engine", "group-correction", "recipe", "design",
        ],
        "confirmation": {
            "scientificPromotion": "explicit-user-only",
            "presentationPromotion": {"minSessions": 8, "minScore": 0.75},
        },
        "retention": {"rawDays": 30, "rawBytes": 67108864, "keepSessions": 20},
        "constraints": [
            {
                "id": "constraint-bids-subject",
                "text": "The planned subject must exist in the BIDS dataset.",
                "check": "bids-subject",
                "appliesTo": ["plan", "run"],
            },
            {
                "id": "constraint-active-run",
                "text": "Only one pipeline run may be active.",
                "check": "no-active-run",
                "appliesTo": ["run"],
            },
            {
                "id": "constraint-bids-manifest",
                "text": "The BIDS dataset must carry dataset_description.json.",
                "check": "dataset-description",
                "appliesTo": ["plan"],
            },
            {
                "id": "constraint-scripts-exist",
                "text": "A run requires the generated autoproc script to exist.",
                "check": "scripts-exist",
                "appliesTo": ["run"],
            },
            {
                "id": "constraint-run-completed",
                "text": "Settling requires the run to have completed.",
                "check": "run-completed",
                "appliesTo": ["settle"],
            },
            {
                "id": "constraint-settled-export",
                "text": "Export requires a settled analysis.",
                "check": "settled",
                "appliesTo": ["export"],
            },
        ],
        "standards": [
            {
                "id": "standard-qc-review",
                "text": "QC figures should be reviewed and a judgment recorded before settling.",
                "check": "judgment-recorded",
                "appliesTo": ["settle"],
            },
        ],
    }
}


def preferences_dir(project_root: Path) -> Path:
    return Path(project_root) / "work" / "ffs-record" / "preferences"


def policy_path(project_root: Path) -> Path:
    return preferences_dir(project_root) / "policy.yaml"


def load_policy(project_root: Path, *, write_default: bool = True) -> dict:
    path = policy_path(project_root)
    if path.exists():
        loaded = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        data = loaded.get("policy", loaded) if isinstance(loaded, dict) else {}
        policy = json.loads(json.dumps(DEFAULT_POLICY["policy"]))  # deep copy
        _merge(policy, data if isinstance(data, dict) else {})
        return policy
    if write_default:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(yaml.safe_dump(DEFAULT_POLICY, sort_keys=False), encoding="utf-8")
    return json.loads(json.dumps(DEFAULT_POLICY["policy"]))


def _merge(base: dict, override: dict) -> None:
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _merge(base[key], value)
        else:
            base[key] = value
