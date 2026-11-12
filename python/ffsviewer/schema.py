"""Machine-readable view of the FFS command vocabulary, for UI and agent tools."""

from __future__ import annotations

import dataclasses
import typing

from fastfuncstuff.viewer import commands as ffs_commands

from .classify import category_of


def _type_name(annotation: object) -> str:
    if annotation is type(None):
        return "None"
    if isinstance(annotation, type):
        return annotation.__name__
    return str(annotation).replace("typing.", "")


def command_schema() -> list[dict]:
    """One entry per registered command: name, typed args, doc, category, major."""
    out: list[dict] = []
    for name in ffs_commands.registered_names():
        cls = ffs_commands.resolve(name)
        hints = typing.get_type_hints(cls)
        args = []
        for field in dataclasses.fields(cls):
            kind = _type_name(hints.get(field.name, str))
            entry = {"name": field.name, "type": kind}
            if field.default is not dataclasses.MISSING:
                entry["default"] = field.default
            args.append(entry)
        out.append({
            "name": name,
            "args": args,
            "doc": (cls.__doc__ or "").strip().splitlines()[0] if cls.__doc__ else "",
            "category": category_of(name),
            "major": bool(getattr(cls, "major", False)),
        })
    return out


def command_names() -> list[str]:
    return ffs_commands.registered_names()


def lookup(name: str) -> dict:
    for entry in command_schema():
        if entry["name"] == name.upper():
            return entry
    raise KeyError(name)
