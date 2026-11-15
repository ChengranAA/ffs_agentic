"""CLI for the deterministic preference layer: `python -m ffsrecord.cli ...`."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .features import feature_from_session, write_shard
from .deletion import DeletionError, delete_evidence
from .gates import evaluate as evaluate_gates
from .lifecycle import PreferenceError, read_events, record_action
from .policy import load_policy, policy_path, preferences_dir
from .precedence import resolve
from .profile import ingest_sessions, read_profile, recompute


def _json(value) -> str:
    return json.dumps(value, indent=1, sort_keys=True, default=str)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m ffsrecord.cli", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    feature = sub.add_parser("feature", help="print the feature shard for one inspection session")
    feature.add_argument("--session", required=True)
    feature.add_argument("--project", type=Path, default=Path("."))
    feature.add_argument("--context", default="{}", help="JSON project context, e.g. '{\"stage\":\"qc\"}'")

    profile = sub.add_parser("profile", help="ingest sessions and recompute the profile")
    profile.add_argument("--project", type=Path, default=Path("."))
    profile.add_argument("--state-dir", default=None, help="viewer state dir (default <project>/.ffs-viewer)")
    profile.add_argument("--now", default=None, help="ISO time for reproducible aggregation")
    profile.add_argument("--no-ingest", action="store_true", help="do not rebuild evidence shards")
    profile.add_argument("--json", action="store_true")

    preference = sub.add_parser("preference", help="record a user-only preference lifecycle event")
    preference.add_argument("--project", type=Path, default=Path("."))
    preference.add_argument("--action", required=True,
                            choices=["establish", "retire", "edit", "delete", "request", "confirm"])
    preference.add_argument("--id", required=True, help="preference id, e.g. pref-alpha-0-4")
    preference.add_argument("--reason", default=None)
    preference.add_argument("--actor", default="user", choices=["user", "agent"], help="request is agent-allowed; the rest are user-only")
    preference.add_argument("--payload", default="{}", help="JSON payload, e.g. '{\"action\":\"use alpha 0.35\"}'")
    preference.add_argument("--now", default=None)
    preference.add_argument("--json", action="store_true")

    policy_parser = sub.add_parser("policy", help="print the project policy (constraints, standards, thresholds)")
    policy_parser.add_argument("--project", type=Path, default=Path("."))
    policy_parser.add_argument("--json", action="store_true")
    policy_parser.add_argument("--set", default=None,
                               help="JSON policy document to validate and write (user-only path)")

    gate = sub.add_parser("gate", help="evaluate policy constraints/standards for an operation")
    gate.add_argument("--project", type=Path, default=Path("."))
    gate.add_argument("--op", required=True, choices=["plan", "run", "settle", "export"])
    gate.add_argument("--facts", default="{}", help="JSON facts, e.g. '{\"subjectExists\":true}'")
    gate.add_argument("--json", action="store_true")

    deletion = sub.add_parser("delete", help="delete preference evidence (dry-run first) or a preference")
    deletion.add_argument("--project", type=Path, default=Path("."))
    deletion.add_argument("--state-dir", default=None)
    deletion.add_argument("--scope", required=True, help='JSON, e.g. {"sessionId":"insp-…"} or {"preferenceId":"pref-…"}')
    deletion.add_argument("--mode", default="evidence", choices=["evidence", "preference"])
    deletion.add_argument("--dry-run", action="store_true")
    deletion.add_argument("--reason", default=None)
    deletion.add_argument("--json", action="store_true")

    precedence = sub.add_parser("resolve", help="print the precedence audit for a context")
    precedence.add_argument("--project", type=Path, default=Path("."))
    precedence.add_argument("--context", default="{}")
    precedence.add_argument("--instruction", default=None)
    precedence.add_argument("--decisions", default="[]")
    precedence.add_argument("--json", action="store_true")

    args = parser.parse_args(argv)
    if args.command == "feature":
        context = json.loads(args.context or "{}")
        shard = feature_from_session(Path(args.session), project=context)
        path = write_shard(args.project, shard)
        print(_json({"shard": shard, "path": str(path)}))
        return 0

    if args.command == "profile":
        project = Path(args.project).resolve()
        state_dir = Path(args.state_dir) if args.state_dir else project / ".ffs-viewer"
        if not args.no_ingest:
            written = ingest_sessions(project, state_dir)
        else:
            written = []
        profile_data = recompute(project, now=args.now)
        if args.json:
            print(_json(profile_data))
        else:
            print(f"profile: {preferences_dir(project) / 'profile.json'}")
            print(f"evidence: {profile_data['evidence']['sessions']} sessions · weight {profile_data['evidence']['weight']}")
            print(f"preferences: {profile_data['stats']} · shards written {len(written)}")
            for record in profile_data["preferences"]:
                if record["status"] != "observed":
                    print(f"  {record['status']:11} {record['id']:28} score {record['evidence']['score']:.2f}"
                          f" sessions {record['evidence']['sessions']}"
                          f"{' · scientific (confirmation required)' if record.get('scientific') else ''}")
        return 0

    if args.command == "preference":
        project = Path(args.project).resolve()
        profile_data = read_profile(project)
        if not profile_data:
            print("error: no profile yet; run `profile` first", file=sys.stderr)
            return 1
        known = {record.get("id") for record in profile_data.get("preferences", [])}
        if args.id not in known:
            print(f"error: preference {args.id!r} is not in the derived profile", file=sys.stderr)
            return 1
        try:
            event = record_action(
                project, args.action, args.id,
                actor={"kind": args.actor}, reason=args.reason,
                payload=json.loads(args.payload or "{}"), now=args.now,
            )
        except PreferenceError as exc:
            print(f"error: {exc.code}: {exc}", file=sys.stderr)
            return 1
        updated = recompute(project, now=args.now)
        record = next((item for item in updated["preferences"] if item.get("id") == args.id), None)
        if args.json:
            print(_json({"event": event, "preference": record, "profile": {
                "generatedAt": updated.get("generatedAt"), "stats": updated.get("stats"),
                "lifecycle": updated.get("lifecycle"),
            }}))
        else:
            print(f"{event['type']} · {args.id} · actor {args.actor}")
            if record:
                print(f"  status {record.get('status')} · version {record.get('version')} · confirmation "
                      f"{(record.get('confirmation') or {}).get('by') or (record.get('confirmation') or {}).get('requested', {}).get('by')}")
        return 0

    if args.command == "policy":
        project = Path(args.project).resolve()
        if args.set:
            try:
                body = json.loads(args.set)
            except json.JSONDecodeError as exc:
                print(f"error: invalid policy JSON: {exc}", file=sys.stderr)
                return 1
            if not isinstance(body, dict):
                print("error: policy must be a JSON object", file=sys.stderr)
                return 1
            if not isinstance(body.get("constraints", []), list) or not isinstance(body.get("standards", []), list):
                print("error: constraints and standards must be lists", file=sys.stderr)
                return 1
            import yaml
            path = policy_path(project)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(yaml.safe_dump({"policy": body}, sort_keys=False), encoding="utf-8")
            print(_json({"written": str(path), "policy": load_policy(project)}))
            return 0
        policy = load_policy(project)
        print(_json(policy))
        return 0

    if args.command == "gate":
        project = Path(args.project).resolve()
        result = evaluate_gates(load_policy(project), args.op, json.loads(args.facts or "{}"))
        if args.json:
            print(_json(result))
        else:
            print(f"gate {args.op}: {'allowed' if result['allowed'] else 'refused'}")
            for entry in result["constraints"]:
                print(f"  [{'ok' if entry['passed'] else 'FAIL'}] {entry['id']}: {entry['text']}")
            for entry in result["standards"]:
                print(f"  standard [{'ok' if entry['passed'] else 'DEPARTED'}] {entry['id']}: {entry['text']}")
        return 0 if result["allowed"] else 1

    if args.command == "delete":
        project = Path(args.project).resolve()
        state_dir = Path(args.state_dir) if args.state_dir else project / ".ffs-viewer"
        try:
            scope = json.loads(args.scope or "{}")
            result = delete_evidence(
                project, state_dir, scope, mode=args.mode,
                dry_run=bool(args.dry_run), reason=args.reason,
            )
        except (DeletionError, PreferenceError) as exc:
            print(f"error: {exc.code}: {exc}", file=sys.stderr)
            return 1
        if args.json:
            print(_json(result))
        else:
            if result.get("dryRun"):
                print(f"dry run · would delete {result.get('deleted', len(result.get('shards', [])))} shard(s) "
                      f"from {len(result.get('sessions', []))} session(s); raw deletions queued {result.get('rawDeletionQueued', 0)}")
            else:
                print(f"deleted {result.get('deleted', 0)} shard(s) · tombstone {result.get('tombstone', {}).get('id') if result.get('tombstone') else '—'} "
                      f"· profile now {len((result.get('profile') or {}).get('preferences', []))} preference(s)")
                for change in (result.get("diff") or {}).get("statusChanges", []):
                    print(f"  {change['id']}: {change['from']} → {change['to']}")
        return 0

    if args.command == "resolve":
        project = Path(args.project).resolve()
        profile_data = read_profile(project) or {}
        result = resolve(
            profile=profile_data,
            context=json.loads(args.context or "{}"),
            instruction=args.instruction,
            decisions=json.loads(args.decisions or "[]"),
        )
        if args.json:
            print(_json(result))
        else:
            print(f"effective: {result['effective']['rung']} · {len(result['effective']['items'])} item(s)")
            for rung in result["rungs"]:
                if rung["items"]:
                    print(f"  {rung['rung']} {rung['name']}: {[item.get('id') or item.get('text') for item in rung['items']]}")
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
