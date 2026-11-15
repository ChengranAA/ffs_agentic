"""Bounded deletion for preference evidence (RECORD.md §7.7).

Evidence shards are additive, so deletion is exact subtraction: delete the shards, append a
tombstone without content, queue raw inspection deletion for the sidecar (sole writer there),
mark cited decisions' visual evidence deleted, then recompute from what remains.

Dry-run never touches files and returns the before aggregate plus what would be destroyed.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from .features import SCHEMA as FEATURE_SCHEMA
from .lifecycle import EVENT_SCHEMA, append_event
from .policy import preferences_dir
from .profile import PROFILE_SCHEMA, read_profile, recompute

TOMBSTONE_SCHEMA = "ffs-record-tombstone/1"
FAMILIES = ("threshold", "alpha", "colormap")


class DeletionError(Exception):
    def __init__(self, code: str, message: str, details: dict | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}


def _now(value: str | None) -> str:
    return value or datetime.now(timezone.utc).isoformat()


def _pref_family_value(preference_id: str) -> tuple[str, str] | None:
    match = re.match(r"^pref-([a-z]+)-(.+)$", str(preference_id or ""))
    if not match:
        return None
    family, slug = match.group(1), match.group(2)
    if family not in FAMILIES:
        return None
    value = slug.replace("-", ".") if family in ("threshold", "alpha") else slug
    return family, value


def _shard_matches(shard: dict, family: str, value: str) -> bool:
    settings = shard.get("settings") or {}
    if family == "threshold":
        return any(abs(float(item) - float(value)) < 1e-9 for item in settings.get("thresholdsSet") or [])
    if family == "alpha":
        return any(abs(float(item) - float(value)) < 1e-9 for item in settings.get("alphasSet") or [])
    if family == "colormap":
        return str(value) in [str(item) for item in settings.get("colormaps") or []]
    return False


def _load_shards(project_root: Path) -> list[tuple[Path, dict]]:
    directory = preferences_dir(project_root) / "evidence"
    if not directory.exists():
        return []
    shards = []
    for path in sorted(directory.glob("*.json")):
        try:
            shard = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(shard, dict) and shard.get("schema") == FEATURE_SCHEMA:
            shards.append((path, shard))
    return shards


def resolve_scope(project_root: Path, scope: dict) -> list[tuple[Path, dict]]:
    shards = _load_shards(project_root)
    if not scope:
        raise DeletionError("scope-missing", "deletion needs a scope: sessionId, preferenceId, before or project")
    if scope.get("sessionId"):
        session_id = str(scope["sessionId"])
        return [(path, shard) for path, shard in shards if str(shard.get("sessionId")) == session_id]
    if scope.get("preferenceId"):
        parsed = _pref_family_value(scope["preferenceId"])
        if not parsed:
            raise DeletionError("scope-invalid", f"cannot parse preference id {scope['preferenceId']!r}")
        family, value = parsed
        return [(path, shard) for path, shard in shards if _shard_matches(shard, family, value)]
    if scope.get("before"):
        before = str(scope["before"])
        return [(path, shard) for path, shard in shards
                if str((shard.get("window") or {}).get("to") or "") < before]
    if scope.get("project"):
        return list(shards)
    raise DeletionError("scope-invalid", f"unknown deletion scope: {sorted(scope)}")


def _raw_paths(state_dir: Path, session_id: str) -> list[Path]:
    inspection = Path(state_dir) / "inspection"
    paths = [inspection / f"{session_id}.jsonl", inspection / f"{session_id}.start.ffs"]
    compact = inspection / "compact" / f"{session_id}.json"
    paths.append(compact)
    return [path for path in paths if path.exists()]


def _project_state_path(project_root: Path) -> Path:
    return Path(project_root) / "work" / "ffs-analysis-project.json"


def _mark_cited_decisions(project_root: Path, session_ids: set[str], now: str) -> list[dict]:
    """Keep decisions but mark visual evidence deleted; no dangling inspection reference."""
    path = _project_state_path(project_root)
    if not path.exists():
        return []
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    updated = []
    for decision in state.get("decisions") or []:
        visuals = ((decision.get("evidence") or {}).get("visual") or [])
        hit = [visual for visual in visuals if visual.get("inspection") in session_ids]
        if not hit:
            continue
        for visual in hit:
            visual["status"] = "deleted"
            visual["deletedAt"] = now
        decision["evidence"] = {**(decision.get("evidence") or {}), "visual": visuals}
        updated.append({"id": decision.get("id"), "sessions": [visual.get("inspection") for visual in hit]})
    if updated:
        path.write_text(json.dumps(state, indent=1, sort_keys=True, default=str) + "\n", encoding="utf-8")
    return updated


def _append_queue(state_dir: Path, session_ids: list[str], raw: dict[str, list[str]], now: str) -> int:
    if not raw:
        return 0
    inspection = Path(state_dir) / "inspection"
    if not inspection.exists():
        return 0
    queue = inspection / "deletion-queue.jsonl"
    count = 0
    with queue.open("a", encoding="utf-8") as handle:
        for session_id in session_ids:
            if not raw.get(session_id):
                continue
            handle.write(json.dumps({
                "schema": "ffs-inspection-deletion/1",
                "sessionId": session_id,
                "paths": raw[session_id],
                "at": now,
                "status": "pending",
            }, sort_keys=True) + "\n")
            count += 1
    return count


def _append_tombstone(project_root: Path, record: dict) -> None:
    directory = preferences_dir(project_root)
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "tombstones.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True, default=str) + "\n")


def _profile_diff(before: dict | None, after: dict) -> dict:
    before_records = {record.get("id"): record for record in (before or {}).get("preferences") or []}
    after_records = {record.get("id"): record for record in after.get("preferences") or []}
    changed = []
    status_changes = []
    confidence_changes = []
    for preference_id in sorted(set(before_records) | set(after_records)):
        old = before_records.get(preference_id)
        new = after_records.get(preference_id)
        if old is None:
            changed.append({"id": preference_id, "change": "removed"})
            continue
        if new is None:
            changed.append({"id": preference_id, "change": "removed"})
            continue
        if old.get("status") != new.get("status"):
            status_changes.append({"id": preference_id, "from": old.get("status"), "to": new.get("status")})
        if (old.get("confidence") or {}).get("level") != (new.get("confidence") or {}).get("level"):
            confidence_changes.append({
                "id": preference_id,
                "from": (old.get("confidence") or {}).get("level"),
                "to": (new.get("confidence") or {}).get("level"),
            })
        if old.get("evidence") != new.get("evidence"):
            changed.append({"id": preference_id, "change": "evidence", "sessions": (new.get("evidence") or {}).get("sessions")})
    return {"changed": changed, "statusChanges": status_changes, "confidenceChanges": confidence_changes}


def delete_evidence(project_root: Path, state_dir: Path, scope: dict, *, mode: str = "evidence",
                    dry_run: bool = False, reason: str | None = None,
                    requested_by: str = "user", now: str | None = None) -> dict:
    project_root = Path(project_root)
    state_dir = Path(state_dir)
    stamp = _now(now)
    if mode not in ("evidence", "preference"):
        raise DeletionError("mode-invalid", f"unknown deletion mode {mode!r}")
    before = read_profile(project_root)

    if mode == "preference":
        preference_id = str(scope.get("preferenceId") or "")
        if not preference_id:
            raise DeletionError("scope-invalid", "preference deletion needs preferenceId")
        if dry_run:
            record = next((item for item in (before or {}).get("preferences") or []
                           if item.get("id") == preference_id), None)
            if record is None:
                raise DeletionError("preference-not-found", f"no preference {preference_id!r}")
            return {"dryRun": True, "mode": mode, "scope": scope, "before": record,
                    "wouldRetire": preference_id}
        from .lifecycle import record_action
        from .profile import recompute as recompute_profile
        record_action(project_root, "delete", preference_id, actor={"kind": "user"},
                      reason=reason or "user deleted preference", now=stamp)
        after = recompute_profile(project_root, now=stamp)
        tombstone = {
            "schema": TOMBSTONE_SCHEMA, "id": f"tomb-{stamp}-{preference_id}", "at": stamp,
            "scope": scope, "mode": mode, "reason": reason, "requestedBy": requested_by,
            "counts": {"preferences": 1}, "preferenceIds": [preference_id],
        }
        _append_tombstone(project_root, tombstone)
        append_event(project_root, {
            "schema": EVENT_SCHEMA, "type": "preference.evidence-deleted", "action": "evidence-deleted",
            "preferenceId": preference_id, "at": stamp, "actor": {"kind": requested_by},
            "reason": reason, "payload": {"mode": mode, "tombstone": tombstone["id"]},
        })
        return {"dryRun": False, "mode": mode, "scope": scope, "tombstone": tombstone,
                "diff": _profile_diff(before, after), "profile": after}

    matched = resolve_scope(project_root, scope)
    session_ids = sorted({str(shard.get("sessionId")) for _, shard in matched})
    raw = {session_id: [str(path) for path in _raw_paths(state_dir, session_id)] for session_id in session_ids}
    pending = sum(1 for paths in raw.values() if paths)
    cited = []
    if dry_run:
        return {
            "dryRun": True, "mode": mode, "scope": scope,
            "sessions": session_ids, "shards": [str(path) for path, _ in matched],
            "rawDeletionQueued": pending,
            "alreadyCited": 0,
            "before": {
                "preferences": len((before or {}).get("preferences") or []),
                "evidence": (before or {}).get("evidence"),
            },
        }

    if not matched and not session_ids:
        return {"dryRun": False, "mode": mode, "scope": scope, "deleted": 0, "sessions": [],
                "tombstone": None, "diff": _profile_diff(before, before or {}), "pendingRawDeletions": 0}

    for path, _ in matched:
        try:
            path.unlink()
        except OSError:
            pass
    tombstone = {
        "schema": TOMBSTONE_SCHEMA,
        "id": f"tomb-{stamp}",
        "at": stamp,
        "scope": scope,
        "mode": mode,
        "reason": reason,
        "requestedBy": requested_by,
        "counts": {"sessions": len(session_ids), "shards": len(matched)},
        "sessionIds": session_ids,
    }
    _append_tombstone(project_root, tombstone)
    pending = _append_queue(state_dir, session_ids, raw, stamp)
    cited = _mark_cited_decisions(project_root, set(session_ids), stamp)
    append_event(project_root, {
        "schema": EVENT_SCHEMA, "type": "preference.evidence-deleted", "action": "evidence-deleted",
        "preferenceId": None, "at": stamp, "actor": {"kind": requested_by},
        "reason": reason,
        "payload": {"mode": mode, "sessions": session_ids, "tombstone": tombstone["id"],
                    "citedDecisions": [item["id"] for item in cited]},
    })
    after = recompute(project_root, now=stamp)
    return {
        "dryRun": False, "mode": mode, "scope": scope,
        "deleted": len(matched), "sessions": session_ids,
        "tombstone": tombstone, "pendingRawDeletions": pending,
        "citedDecisions": cited,
        "diff": _profile_diff(before, after),
        "profile": after,
    }
