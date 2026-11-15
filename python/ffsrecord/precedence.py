"""Pure preference precedence resolution (RECORD.md §7.6).

The ladder, highest first: explicit instruction, project constraints/standards, task/modality
preferences, cross-project preferences, tentative inferred candidates, defaults. Constraints
still gate separately in the caller (an action that violates a constraint must not proceed).
"""

from __future__ import annotations

from datetime import datetime, timezone

RUNGS = [
    (1, "instruction"),
    (2, "constraint"),
    (3, "task-modality"),
    (4, "cross-project"),
    (5, "candidate"),
    (6, "defaults"),
]


def _matches(scope_value, context_value) -> bool:
    if not scope_value:
        return True
    return context_value in scope_value


def applies(record: dict, context: dict) -> bool:
    applies_to = record.get("appliesTo") or {}
    return (
        _matches(applies_to.get("tasks"), context.get("task"))
        and _matches(applies_to.get("modalities"), context.get("modality"))
        and _matches(applies_to.get("stages"), context.get("stage"))
    )


def resolve(*, profile: dict | None, context: dict | None = None, instruction: dict | str | None = None,
            decisions: list[dict] | None = None, defaults: list[dict] | None = None) -> dict:
    context = dict(context or {})
    preferences = list((profile or {}).get("preferences") or [])
    active = [record for record in preferences if record.get("active", True)]

    instruction_items: list[dict] = []
    if instruction:
        if isinstance(instruction, str):
            instruction = {"text": instruction}
        text = str(instruction.get("text") or "").strip()
        if text:
            instruction_items.append({
                "type": "instruction",
                "text": text,
                "at": instruction.get("at") or datetime.now(timezone.utc).isoformat(),
                "source": "user",
                "scope": instruction.get("scope"),
                "ttl": instruction.get("ttl"),
            })

    constraints = [
        record for record in active
        if record.get("kind") in ("constraint", "standard") and applies(record, context)
    ]
    for decision in decisions or []:
        if not isinstance(decision, dict) or decision.get("kind") not in ("constraint", "standard"):
            continue
        if decision.get("status", "accepted") != "accepted":
            continue
        constraints.append({
            "id": decision.get("id", "decision-constraint"),
            "version": decision.get("version", 1),
            "kind": decision.get("kind"),
            "recommendation": {"action": decision.get("text") or decision.get("rationale")},
            "source": "decision",
        })

    task_modality = [
        record for record in active
        if record.get("scope") in ("task", "modality", "project")
        and record.get("status") in ("established", "conditional")
        and record.get("kind") not in ("constraint", "standard")
        and applies(record, context)
    ]
    cross_project = [
        record for record in active
        if record.get("scope") == "cross-project" and record.get("status") in ("established", "conditional")
    ]
    candidates = [
        record for record in active
        if record.get("status") == "candidate" and record.get("kind") not in ("constraint", "standard")
        and applies(record, context)
    ]
    default_items = list(defaults or [])

    buckets = {
        "instruction": instruction_items,
        "constraint": constraints,
        "task-modality": task_modality,
        "cross-project": cross_project,
        "candidate": candidates,
        "defaults": default_items,
    }
    rungs = [{"rung": number, "name": name, "items": buckets[name]} for number, name in RUNGS]
    effective_name = next((name for _, name in RUNGS if buckets[name]), "defaults")
    effective = buckets[effective_name]

    applied = []
    for number, name in RUNGS:
        for item in buckets[name]:
            applied.append({
                "id": item.get("id"),
                "version": item.get("version"),
                "rung": number,
                "rungName": name,
                "applied": name == effective_name,
                "overriddenBy": None if name == effective_name else effective_name,
            })
    return {
        "context": context,
        "rungs": rungs,
        "effective": {"rung": effective_name, "items": effective},
        "applied": applied,
        "gates": [record for record in constraints],
    }
