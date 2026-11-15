"""Deterministic preference aggregation (RECORD.md §7.3–§7.5).

Pure given evidence shards + policy + now. No LLM call is involved. The profile is derived:
deleting a shard and recomputing produces exactly the profile that would have existed without
that session. Statuses follow the user-only promotion rule for scientific kinds.
"""

from __future__ import annotations

import json
import math
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from .features import feature_from_session, write_shard
from .lifecycle import apply_events, read_events
from .policy import load_policy, preferences_dir

PROFILE_SCHEMA = "ffs-record-profile/1"

# family -> (scientific, kind, recommendation sentence)
FAMILIES = {
    "threshold": (True, "preference", "work at a display threshold near {value}"),
    "alpha": (False, "preference", "use a layer alpha near {value}"),
    "colormap": (False, "preference", "use the {value} colormap for derived maps"),
}
_RECENCY_HALF_LIFE_FALLBACK = 90.0


def _now(value: str | datetime | None) -> datetime:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc)
    if value:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)
    return datetime.now(timezone.utc)


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(value).lower()).strip("-") or "value"


def _confidence(score: float) -> str:
    if score >= 0.8:
        return "high"
    if score >= 0.65:
        return "medium"
    return "low"


def _age_days(shard: dict, now: datetime) -> float:
    stamp = (shard.get("window") or {}).get("to") or (shard.get("window") or {}).get("from")
    if not stamp:
        return 0.0
    try:
        seen = datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return 0.0
    return max(0.0, (now - seen).total_seconds() / 86400.0)


def _values(shard: dict) -> dict[str, list[tuple[str, str]]]:
    """Normalized (family, value) observations from one shard."""
    settings = shard.get("settings") or {}
    out: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for value in settings.get("thresholdsSet") or []:
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        out["threshold"].append((f"{number:.2f}".rstrip("0").rstrip("."), "threshold"))
    for value in settings.get("alphasSet") or []:
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if 0.0 <= number <= 1.0:
            out["alpha"].append((f"{number:.2f}".rstrip("0").rstrip("."), "alpha"))
    for value in settings.get("colormaps") or []:
        text = str(value).strip()
        if text:
            out["colormap"].append((text, "colormap"))
    return out


def load_evidence(project_root: Path) -> list[dict]:
    directory = preferences_dir(project_root) / "evidence"
    if not directory.exists():
        return []
    shards = []
    for path in sorted(directory.glob("*.json")):
        try:
            shard = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(shard, dict) and shard.get("schema") == "ffs-record-features/1":
            shards.append(shard)
    return shards


def ingest_sessions(project_root: Path, state_dir: Path, *, project: dict | None = None) -> list[Path]:
    """Create/refresh a feature shard for every inspection session."""
    inspection = Path(state_dir) / "inspection"
    written: list[Path] = []
    if not inspection.exists():
        return written
    for path in sorted(inspection.glob("insp-*.jsonl")):
        shard = feature_from_session(path, project=project)
        if not shard.get("sessionId"):
            continue
        written.append(write_shard(project_root, shard))
    return written


def _preference_id(family: str, value: str) -> str:
    return f"pref-{family}-{_slug(value)}"


def _previous_records(project_root: Path) -> dict[str, dict]:
    path = preferences_dir(project_root) / "profile.json"
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return {record.get("id"): record for record in data.get("preferences", []) if record.get("id")}


def aggregate(*, shards: list[dict], policy: dict, now: datetime,
              previous: dict[str, dict] | None = None, project_label: str = "") -> dict:
    recency = policy.get("recency") or {}
    half_life = float(recency.get("halfLifeDays") or _RECENCY_HALF_LIFE_FALLBACK)
    candidate_policy = (policy.get("observation") or {}).get("candidate") or {}
    established_policy = (policy.get("observation") or {}).get("established") or {}
    min_sessions = int(candidate_policy.get("minSessions") or 3)
    min_occurrences = int(candidate_policy.get("minOccurrences") or 6)
    established_sessions = int(established_policy.get("minSessions") or 8)
    established_score = float(established_policy.get("minScore") or 0.75)
    scientific_kinds = set(policy.get("scientificKinds") or [])

    weights: dict[str, float] = {}
    for shard in shards:
        if float(shard.get("behavioralWeight") or 0) <= 0:
            continue
        age = _age_days(shard, now)
        weights[str(shard.get("sessionId"))] = 0.5 ** (age / max(1.0, half_life))
    total_weight = sum(weights.values())

    support: dict[tuple[str, str], dict] = defaultdict(lambda: {"sessions": [], "weighted": 0.0, "occurrences": 0})
    for shard in shards:
        session_id = str(shard.get("sessionId"))
        session_weight = weights.get(session_id, 0.0)
        if session_weight <= 0:
            continue
        for family, observations in _values(shard).items():
            counts: dict[str, int] = defaultdict(int)
            for value, _ in observations:
                counts[value] += 1
            for value, count in counts.items():
                bucket = support[(family, value)]
                if session_id not in bucket["sessions"]:
                    bucket["sessions"].append(session_id)
                    bucket["weighted"] += session_weight
                bucket["occurrences"] += count
                bucket["lastSeenAt"] = (shard.get("window") or {}).get("to") or bucket.get("lastSeenAt")

    projects = [shard.get("project") or {} for shard in shards]

    def applies_to() -> dict:
        tasks = sorted({str(project.get("task")) for project in projects if project.get("task")})
        modalities = sorted({str(project.get("modality")) for project in projects if project.get("modality")})
        stages = sorted({str(project.get("stage")) for project in projects if project.get("stage")})
        return {"tasks": tasks, "modalities": modalities, "stages": stages}

    records = []
    previous = previous or {}
    for (family, value), bucket in sorted(support.items()):
        scientific, kind, sentence = FAMILIES.get(family, (True, "preference", "prefer {value}"))
        sessions = len(bucket["sessions"])
        occurrences = int(bucket["occurrences"])
        weighted = round(float(bucket["weighted"]), 4)
        contra = round(max(0.0, total_weight - weighted), 4)
        score = round(weighted / total_weight, 4) if total_weight > 0 else 0.0
        status = "observed"
        if sessions >= min_sessions and occurrences >= min_occurrences:
            status = "candidate"
            if scientific:
                # Scientific preferences need explicit user confirmation; inferred behavior
                # only ever reaches candidate (RECORD.md §7.5).
                if family in scientific_kinds:
                    status = "candidate"
            elif sessions >= established_sessions and score >= established_score:
                status = "established"
        previous_record = previous.get(_preference_id(family, value)) or {}
        same_recommendation = (
            previous_record
            and (previous_record.get("derivedStatus") or previous_record.get("status")) == status
            and (previous_record.get("recommendation") or {}).get("value") == value
        )
        # `derivedVersion` is the evidence-derived version; lifecycle events add their own
        # stable offset on top (see lifecycle.apply_events), so recompute never compounds.
        base_version = int(previous_record.get("derivedVersion") or previous_record.get("version") or 0)
        if previous_record:
            base_version = base_version if same_recommendation else base_version + 1
        else:
            base_version = 1
        version = base_version
        # Only evidence-derived history survives aggregation; lifecycle history is appended by
        # the lifecycle replay, so recompute must not inherit it twice.
        history = [entry for entry in (previous_record.get("derivedHistory") or previous_record.get("history") or [])
                   if not entry.get("event")]
        if not history or history[-1].get("version") != version:
            history.append({
                "version": version, "at": now.isoformat(), "status": status,
                "reason": "policy recompute" if previous_record else "first observation",
            })
        record = {
            "id": _preference_id(family, value),
            "version": version,
            "derivedVersion": base_version,
            "derivedStatus": status,
            "status": status,
            "kind": kind,
            "scope": "project",
            "appliesTo": applies_to(),
            "recommendation": {
                "action": sentence.format(value=value),
                "value": value,
                "family": family,
            },
            "adaptWhen": [],
            "origin": "inferred",
            "scientific": bool(scientific) and family in scientific_kinds,
            "confirmation": {
                "required": bool(scientific and family in scientific_kinds and status != "observed"),
                "by": None,
                "at": None,
            },
            "evidence": {
                "sessions": sessions,
                "occurrences": occurrences,
                "supportWeighted": weighted,
                "contradictionWeighted": contra,
                "score": score,
                "representatives": bucket["sessions"][:5],
                "lastSeenAt": bucket.get("lastSeenAt"),
            },
            "confidence": {"level": _confidence(score), "basis": f"weighted support {weighted} of {round(total_weight, 4)}"},
            "exceptions": [],
            "conflicts": [],
            "active": True,
            "createdAt": (previous_record.get("createdAt") or now.isoformat()),
            "updatedAt": now.isoformat(),
            "derivedHistory": list(history),
            "history": history,
        }
        records.append(record)

    # Conflicts: two different values in one family that both look plausible.
    by_family: dict[str, list[dict]] = defaultdict(list)
    for record in records:
        by_family[record["recommendation"]["family"]].append(record)
    conflicts = []
    for family, family_records in by_family.items():
        strong = [record for record in family_records if record["evidence"]["sessions"] >= min_sessions
                  and record["evidence"]["score"] >= 0.4]
        for left, right in zip(strong, strong[1:]):
            left["conflicts"].append(right["id"])
            right["conflicts"].append(left["id"])
            conflicts.append({"a": left["id"], "b": right["id"], "family": family, "reason": "competing values"})

    records.sort(key=lambda record: (-record["evidence"]["sessions"], record["id"]))
    return {
        "schema": PROFILE_SCHEMA,
        "generatedAt": now.isoformat(),
        "project": {"label": project_label},
        "policy": policy,
        "evidence": {
            "sessions": len(shards),
            "behavioralSessions": len(weights),
            "weight": round(total_weight, 4),
            "shards": [str(shard.get("sessionId")) for shard in shards],
        },
        "preferences": records,
        "conflicts": conflicts,
        "stats": {
            "observed": sum(1 for record in records if record["status"] == "observed"),
            "candidate": sum(1 for record in records if record["status"] == "candidate"),
            "established": sum(1 for record in records if record["status"] == "established"),
        },
    }


def recompute(project_root: Path, *, now: str | datetime | None = None, write: bool = True,
              project_label: str = "") -> dict:
    project_root = Path(project_root)
    policy = load_policy(project_root)
    shards = load_evidence(project_root)
    previous = _previous_records(project_root)
    profile = aggregate(shards=shards, policy=policy, now=_now(now), previous=previous,
                        project_label=project_label or str(project_root))
    # User-only lifecycle judgments replay over the derived records (RECORD.md §7.5).
    profile = apply_events(profile, read_events(project_root), strict=False)
    if write:
        directory = preferences_dir(project_root)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "profile.json").write_text(
            json.dumps(profile, indent=1, sort_keys=True, default=str) + "\n", encoding="utf-8")
        versions = directory / "versions"
        versions.mkdir(parents=True, exist_ok=True)
        existing = [int(path.stem) for path in versions.glob("*.json") if path.stem.isdigit()]
        version = (max(existing) + 1) if existing else 1
        (versions / f"{version}.json").write_text(
            json.dumps(profile, indent=1, sort_keys=True, default=str) + "\n", encoding="utf-8")
    return profile


def read_profile(project_root: Path) -> dict | None:
    path = preferences_dir(project_root) / "profile.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def age_weight(shard: dict, now: datetime, half_life_days: float = _RECENCY_HALF_LIFE_FALLBACK) -> float:
    return 0.5 ** (_age_days(shard, now) / max(1.0, half_life_days))
