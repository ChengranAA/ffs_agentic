"""Preference lifecycle events (RECORD.md §7.5).

The profile is derived from evidence, but user-only actions (establish, retire, edit, delete)
are judgments that cannot be inferred. They live in an append-only event journal and are
replayed over the derived profile. Agents may only *request* confirmation: that event is a
note, never a promotion.

Authority is checked here, not only in the route, so a CLI or tool path cannot bypass it.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from .policy import preferences_dir

EVENT_SCHEMA = "ffs-record-preference-event/1"
USER_ACTIONS = {"establish", "retire", "edit", "delete", "confirm"}
EVENT_TYPES = {
    "establish": "preference.established",
    "retire": "preference.retired",
    "edit": "preference.edited",
    "delete": "preference.deleted",
    "request": "preference.confirmation-requested",
    "confirm": "preference.confirmed",
}


class PreferenceError(Exception):
    def __init__(self, code: str, message: str, details: dict | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}


def events_path(project_root: Path) -> Path:
    return preferences_dir(project_root) / "events.jsonl"


def read_events(project_root: Path) -> list[dict]:
    path = events_path(project_root)
    if not path.exists():
        return []
    events = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict) and event.get("schema") == EVENT_SCHEMA:
            events.append(event)
    return events


def append_event(project_root: Path, event: dict) -> dict:
    path = events_path(project_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, sort_keys=True, default=str) + "\n")
    return event


def make_event(project_root: Path, action: str, preference_id: str, *, actor: dict,
               reason: str | None = None, payload: dict | None = None,
               now: str | None = None) -> dict:
    if action not in EVENT_TYPES:
        raise PreferenceError("preference-action-invalid", f"unknown preference action: {action}")
    actor_kind = str((actor or {}).get("kind") or "unknown")
    if action in USER_ACTIONS and actor_kind != "user":
        raise PreferenceError(
            "preference-user-only",
            f"{action} is a user-only action; an agent may only request confirmation",
            {"action": action, "actor": actor_kind},
        )
    if action == "request" and actor_kind not in ("agent", "user"):
        raise PreferenceError("preference-actor-invalid", "confirmation requests need an agent or user actor")
    stamp = now or datetime.now(timezone.utc).isoformat()
    return {
        "schema": EVENT_SCHEMA,
        "type": EVENT_TYPES[action],
        "action": action,
        "preferenceId": str(preference_id),
        "at": stamp,
        "actor": {"kind": actor_kind, **{key: value for key, value in (actor or {}).items() if key != "kind"}},
        "reason": (reason or "").strip() or None,
        "payload": payload or {},
    }


def _history(record: dict, event: dict, status: str, reason: str | None = None) -> None:
    record.setdefault("history", []).append({
        "version": record.get("version"),
        "at": event["at"],
        "status": status,
        "reason": reason or event.get("reason") or event["type"],
        "event": event["type"],
        "actor": event.get("actor"),
    })


def _find(profile: dict, preference_id: str) -> dict | None:
    for record in profile.get("preferences") or []:
        if record.get("id") == preference_id:
            return record
    return None


def apply_events(profile: dict, events: list[dict], *, strict: bool = True) -> dict:
    """Replay lifecycle events over a derived profile; returns the effective profile.

    `strict=False` is used by recompute: if evidence for an established preference disappeared,
    the derived record is gone and the old event is skipped rather than failing the profile.
    """
    preferences = list(profile.get("preferences") or [])
    working = {"preferences": preferences}
    skipped: list[dict] = []
    state_changes: dict[str, int] = {}
    for event in events:
        action = event.get("action")
        preference_id = str(event.get("preferenceId") or "")
        record = _find(working, preference_id)
        if record is None:
            snapshot = (event.get("payload") or {}).get("preference")
            if action in ("establish", "confirm") and isinstance(snapshot, dict) and snapshot.get("id") == preference_id:
                # Behavioral evidence is gone but the user's explicit confirmation survives;
                # rewrite provenance instead of dropping the preference (RECORD.md §7.7).
                record = {
                    **snapshot,
                    "status": "established",
                    "active": True,
                    "evidence": {
                        **(snapshot.get("evidence") or {}),
                        "sessions": 0,
                        "occurrences": 0,
                        "supportWeighted": 0,
                        "score": 0,
                        "behavioralDeleted": True,
                    },
                    "provenance": "confirmation-supported (behavioral evidence deleted)",
                    "updatedAt": event.get("at"),
                    "derivedVersion": int(snapshot.get("derivedVersion") or snapshot.get("version") or 1),
                    "history": [entry for entry in (snapshot.get("history") or []) if not entry.get("event")],
                }
                working["preferences"].append(record)
            elif action == "request":
                continue
            elif not strict:
                skipped.append({"preferenceId": preference_id, "action": action, "at": event.get("at")})
                continue
            else:
                raise PreferenceError(
                    "preference-not-found",
                    f"no preference {preference_id!r} in the derived profile; establish from evidence first",
                    {"preferenceId": preference_id},
                )
        if action == "establish" or action == "confirm":
            record["status"] = "established"
            record["origin"] = "explicit"
            record["active"] = True
            state_changes[preference_id] = state_changes.get(preference_id, 0) + 1
            record["version"] = int(record.get("derivedVersion") or 1) + state_changes[preference_id]
            record["confirmation"] = {
                "required": False,
                "by": event.get("actor", {}).get("kind") or "user",
                "at": event["at"],
                "channel": (event.get("payload") or {}).get("channel") or "ui",
                "reason": event.get("reason"),
            }
            record["updatedAt"] = event["at"]
            _history(record, event, "established", event.get("reason"))
        elif action == "retire":
            record["status"] = "retired"
            record["active"] = False
            state_changes[preference_id] = state_changes.get(preference_id, 0) + 1
            record["version"] = int(record.get("derivedVersion") or 1) + state_changes[preference_id]
            record["retiredAt"] = event["at"]
            record["updatedAt"] = event["at"]
            _history(record, event, "retired", event.get("reason"))
        elif action == "edit":
            payload = event.get("payload") or {}
            recommendation = record.get("recommendation") or {}
            if payload.get("action"):
                recommendation["action"] = str(payload["action"])
            if payload.get("value") is not None:
                recommendation["value"] = payload["value"]
            record["recommendation"] = recommendation
            if isinstance(payload.get("adaptWhen"), list):
                record["adaptWhen"] = payload["adaptWhen"]
            state_changes[preference_id] = state_changes.get(preference_id, 0) + 1
            record["version"] = int(record.get("derivedVersion") or 1) + state_changes[preference_id]
            record["updatedAt"] = event["at"]
            _history(record, event, record.get("status", "observed"), event.get("reason"))
        elif action == "delete":
            # Deleting a preference retires it; history is never removed (RECORD.md §7.7).
            record["status"] = "retired"
            record["active"] = False
            record["deletedAt"] = event["at"]
            record["updatedAt"] = event["at"]
            state_changes[preference_id] = state_changes.get(preference_id, 0) + 1
            record["version"] = int(record.get("derivedVersion") or 1) + state_changes[preference_id]
            _history(record, event, "retired", event.get("reason") or "user deleted preference")
        elif action == "request":
            record["confirmation"] = {
                **(record.get("confirmation") or {}),
                "requested": {
                    "at": event["at"],
                    "by": event.get("actor", {}).get("kind") or "agent",
                    "note": event.get("reason"),
                },
            }
            record["updatedAt"] = event["at"]
    profile["preferences"] = working["preferences"]
    profile["stats"] = {
        "observed": sum(1 for record in profile["preferences"] if record.get("status") == "observed"),
        "candidate": sum(1 for record in profile["preferences"] if record.get("status") == "candidate"),
        "established": sum(1 for record in profile["preferences"] if record.get("status") == "established"),
        "retired": sum(1 for record in profile["preferences"] if record.get("status") == "retired"),
    }
    profile["lifecycle"] = {
        "events": len(events),
        "lastEventAt": events[-1]["at"] if events else None,
        "skipped": skipped,
    }
    return profile


def record_action(project_root: Path, action: str, preference_id: str, *, actor: dict,
                  reason: str | None = None, payload: dict | None = None,
                  now: str | None = None) -> dict:
    # Validate against the current derived profile before appending anything. Import lazily to
    # keep lifecycle independent of the aggregation module at import time.
    from .profile import read_profile

    profile = read_profile(project_root)
    if profile is not None:
        known = {record.get("id") for record in profile.get("preferences") or []}
        if preference_id not in known:
            raise PreferenceError(
                "preference-not-found",
                f"no preference {preference_id!r} in the derived profile; establish from evidence first",
                {"preferenceId": preference_id},
            )
    if action in ("establish", "confirm") and profile is not None:
        snapshot = next((item for item in profile.get("preferences") or []
                         if item.get("id") == preference_id), None)
        if snapshot is not None:
            payload = {**(payload or {}), "preference": snapshot}
    event = make_event(project_root, action, preference_id, actor=actor, reason=reason,
                       payload=payload, now=now)
    return append_event(project_root, event)
