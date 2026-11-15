#!/usr/bin/env python3
"""Content-level consistency check between a package's record subtree and its top-level views.

Checksums prove bytes did not change; this proves the shipped views agree with the shipped
events: every decision has a ledger event, the preference view matches the profile, provenance
edges reference manifest artifacts, and the record counts match the files.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def _read(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _ledger_decisions(package: Path) -> set[str]:
    ids: set[str] = set()
    directory = package / "record" / "decisions"
    if not directory.exists():
        return ids
    for path in directory.glob("*.jsonl"):
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            decision = ((event.get("payload") or {}).get("decision") or {})
            if decision.get("id"):
                ids.add(str(decision["id"]))
    return ids


def verify(package: Path) -> dict:
    package = Path(package)
    checks: list[dict] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        checks.append({"name": name, "ok": bool(ok), "detail": detail})

    manifest = _read(package / "manifest.json")
    check("manifest readable", manifest is not None)
    manifest = manifest or {}
    decisions = _read(package / "decisions.json") or []
    check("decisions readable", isinstance(decisions, list))

    ledger_ids = _ledger_decisions(package)
    missing = [item.get("id") for item in decisions if item.get("id") not in ledger_ids]
    check("decision ledger covers decisions", not missing,
          f"missing ledger events for {missing[:5]}" if missing else f"{len(decisions)} decision(s)")

    record_counts = (manifest.get("record") or {}).get("counts") or {}
    check("manifest decision count matches decisions.json",
          (record_counts.get("decisions") or {}).get("records") == len(decisions),
          f"manifest {((record_counts.get('decisions') or {}).get('records'))} vs {len(decisions)}")

    preferences = _read(package / "preferences.json")
    profile = _read(package / "record" / "preferences" / "profile.json")
    if preferences is not None and profile is not None:
        check("preference view matches record profile", preferences == profile,
              "preferences.json differs from record/preferences/profile.json")
    else:
        check("preference view/profile presence consistent", preferences is None and profile is None,
              f"preferences={preferences is not None} profile={profile is not None}")

    provenance = _read(package / "provenance.json")
    if provenance is not None:
        artifact_hashes = {artifact.get("name"): artifact.get("sha256") for artifact in manifest.get("artifacts") or []}
        mismatched = [output.get("name") for output in provenance.get("outputs") or []
                      if artifact_hashes.get(output.get("name")) != output.get("sha256")]
        check("provenance outputs match manifest artifacts", not mismatched,
              f"mismatched {mismatched[:5]}" if mismatched else f"{len(provenance.get('outputs') or [])} edge(s)")
        check("provenance run is the settled run", provenance.get("run", {}).get("id") == manifest.get("settledId"),
              "provenance.run.id does not match manifest.settledId")
    else:
        check("provenance present", False, "provenance.json missing")

    inputs = _read(package / "inputs.json")
    if inputs is not None:
        files = inputs.get("files") or []
        check("inputs are hashed", bool(files) and all(
            isinstance(item.get("sha256"), str) and len(item["sha256"]) == 64 for item in files),
            f"{len(files)} input file(s)")
        check("manifest inputs count matches inputs.json",
              (manifest.get("inputs") or {}).get("count") == len(files))
    else:
        check("inputs present", False, "inputs.json missing")

    artifacts_csv = package / "tables" / "artifacts.csv"
    if artifacts_csv.exists():
        rows = [line for line in artifacts_csv.read_text(encoding="utf-8").splitlines()[1:] if line.strip()]
        check("artifacts table matches manifest artifacts", len(rows) == len(manifest.get("artifacts") or []),
              f"csv {len(rows)} vs manifest {len(manifest.get('artifacts') or [])}")

    return {"ok": all(item["ok"] for item in checks), "checks": checks}


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    package = Path(args[0]) if args else Path(".")
    result = verify(package)
    print(json.dumps(result, indent=1))
    if result["ok"]:
        print("record/package consistency: ok")
        return 0
    print("record/package consistency: FAILED", file=sys.stderr)
    for item in result["checks"]:
        if not item["ok"]:
            print(f"  - {item['name']}: {item['detail']}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
