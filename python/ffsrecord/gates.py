"""Policy-driven operation gates (RECORD.md §7.8).

Constraints gate first and cannot be overridden; standards are recommended practice and a
departure must be recorded as a decision. Checks are named facts supplied by the caller, so the
policy file — not code — decides which constraints apply to which operation.
"""

from __future__ import annotations

from typing import Any

CHECKS = {
    "bids-subject": lambda facts: bool(facts.get("subjectExists")),
    "no-active-run": lambda facts: not bool(facts.get("runActive")),
    "settled": lambda facts: bool(facts.get("settled")),
    "judgment-recorded": lambda facts: bool(facts.get("hasDecisions")),
    "scripts-exist": lambda facts: bool(facts.get("scriptExists")),
    "inputs-present": lambda facts: bool(facts.get("inputCount") or 0) > 0,
    "dataset-description": lambda facts: bool(facts.get("datasetDescription")),
    "run-completed": lambda facts: bool(facts.get("runCompleted")),
}


def _applies(entry: dict, op: str) -> bool:
    applies_to = entry.get("appliesTo") or []
    return not applies_to or op in applies_to


def _evaluate_entry(entry: dict, facts: dict) -> dict:
    check = str(entry.get("check") or "")
    handler = CHECKS.get(check)
    passed = bool(handler(facts)) if handler else True
    return {
        "id": entry.get("id") or f"check-{check}",
        "kind": entry.get("kind") or "constraint",
        "text": entry.get("text") or "",
        "check": check,
        "passed": passed,
        "unknownCheck": handler is None,
    }


def evaluate(policy: dict | None, op: str, facts: dict[str, Any] | None = None) -> dict:
    policy = policy or {}
    facts = facts or {}
    constraints = [_evaluate_entry(entry, facts)
                   for entry in (policy.get("constraints") or [])
                   if _applies(entry, op)]
    standards = [_evaluate_entry({**entry, "kind": "standard"}, facts)
                 for entry in (policy.get("standards") or [])
                 if _applies(entry, op)]
    failures = [entry for entry in constraints if not entry["passed"]]
    standard_failures = [entry for entry in standards if not entry["passed"]]
    return {
        "op": op,
        "facts": facts,
        "allowed": not failures,
        "constraints": constraints,
        "standards": standards,
        "failures": failures,
        "standardFailures": standard_failures,
        "unknownChecks": [entry["check"] for entry in constraints + standards if entry["unknownCheck"]],
    }
