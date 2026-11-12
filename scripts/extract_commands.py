#!/usr/bin/env python3
"""Generate ``docs/COMMAND_REFERENCE.md`` from the FFS viewer command vocabulary.

The source of truth is the read-only clone of the original project:

    reference/fastfuncstuff/fastfuncstuff/viewer/vocab.py

Every command there is a frozen dataclass decorated with ``@command``; its
class-level ``name`` is the script token, its annotated fields are the positional
arguments, and ``aspects`` / ``major`` are class-level declarations. This script
reads that file with :mod:`ast` only -- it never imports the project, so it does
not need torch, a GPU or even the CLONE ROOT on ``PYTHONPATH`` -- and emits a
deterministic Markdown reference.

Usage::

    .venv/bin/python scripts/extract_commands.py            # regenerate the doc
    .venv/bin/python scripts/extract_commands.py --check     # fail if stale
    .venv/bin/python scripts/extract_commands.py --stdout   # print, do not write

The output depends on nothing but the contents of ``vocab.py`` (and, for
validation, the ``Aspect`` enum in ``commands.py``): no timestamps, no absolute
paths, no environment. Re-running it is a no-op when the vocabulary has not
changed, which is what makes it safe to wire into a check.

Categories
----------
The brief defines four purposes; the table is explicit, not inferred from name
prefixes, because the vocabulary mixes purposes that a prefix cannot separate
(``SET_SURFACE_EDGES`` edits geometry, ``SET_EDGES`` changes how a layer is
drawn). Each name is assigned exactly once below. The script exits non-zero if
``vocab.py`` gains, loses or renames a command and the table is not updated: the
table is a maintenance contract, not a best-effort guess.

source      data loaded, reloaded, removed, re-ordered onto the stack, or written
            to disk -- anything whose effect is "a different dataset exists".
analysis    what a mode computes or a tool derives: mode switching/parameters,
            DENOISE, paint, the surface editor (a mesh is data, not display),
            ROI/cluster/derive-producing commands, InstaCorr's seed.
navigation  where and when you are looking: crosshair, time index, viewport
            open/close/geometry, zoom/pan/tilt/lock/parked slice, strip, and the
            layer's time linkage.
display     how existing data is drawn: colour, range, threshold, layer
            visibility/opacity/stack order/transform, sub-brick shown, surface
            shape/depth/map/folding, per-window what-to-draw settings, theme.

Precedence, for commands that touch more than one: file I/O wins (source), then
data mutation (analysis), then viewport/camera geometry (navigation), then how
things are painted (display).
"""

from __future__ import annotations

import argparse
import ast
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
VOCAB_PATH = REPO_ROOT / "reference/fastfuncstuff/fastfuncstuff/viewer/vocab.py"
COMMANDS_PATH = REPO_ROOT / "reference/fastfuncstuff/fastfuncstuff/viewer/commands.py"
OUTPUT_PATH = REPO_ROOT / "docs/COMMAND_REFERENCE.md"

CATEGORIES = ("source", "analysis", "display", "navigation")

#: category -> (one-line definition, what a command in it changes)
CATEGORY_RULES: dict[str, tuple[str, str]] = {
    "source": (
        "Data loaded, reloaded, removed, re-stacked or saved.",
        "Which datasets exist and where they sit in the stack.",
    ),
    "analysis": (
        "What is computed from the data: modes, DENOISE, paint, committed surface edits, "
        "ROI/cluster/derive producers, InstaCorr's seed.",
        "A layer's values, a mesh's geometry, or what the active mode fits.",
    ),
    "navigation": (
        "Where and when you are looking: crosshair, time index, viewport lifecycle, "
        "zoom/pan/tilt/lock, parked slices, panel choice.",
        "Nothing in the data; the view and the clock move.",
    ),
    "display": (
        "How existing data is drawn: colour, range, threshold, layer appearance and "
        "stack order, sub-brick shown, surface shape/depth/map/folding, window contents, "
        "theme.",
        "Pixels only -- no voxel, mesh or fit changes.",
    ),
}

#: The explicit command -> category table. Keep in sync with vocab.py; the
#: script validates completeness in both directions.
CATEGORY_BY_NAME: dict[str, str] = {
    # -- source ----------------------------------------------------------
    "READ": "source",
    "READ_FILES": "source",
    "LOAD": "source",
    "ADD_LAYER": "source",
    "RELOAD_LAYER": "source",
    "REMOVE_LAYER": "source",
    "SET_UNDERLAY": "source",  # legacy load verb: replacement means a new dataset
    "SET_OVERLAY": "source",  # legacy load verb
    "ADD_OVERLAY": "source",  # legacy load verb
    "LOAD_SURFACES": "source",
    "LOAD_MESH": "source",
    "LOAD_SURFACE_ROI": "source",
    "SAVE_SURFACES": "source",
    "SAVE_MESH": "source",
    "SAVE_SURFACE_ROI": "source",
    "USE_MESH": "source",  # swaps which loaded mesh supplies the hemisphere
    "REMOVE_MESH": "source",
    # -- analysis --------------------------------------------------------
    "SET_MODE": "analysis",
    "SET_MODE_PARAM": "analysis",
    "MODE_ACTION": "analysis",
    "SET_INPUT": "analysis",  # selects the data a mode fits, not what is drawn
    "DENOISE": "analysis",
    "SET_SEED": "analysis",  # InstaCorr's seed voxel -- an input to a computation
    "NEW_PAINT_LAYER": "analysis",
    "PAINT_STROKE": "analysis",
    "PAINT_UNDO": "analysis",
    "SET_SURFACE_EDITING": "display",  # arms editing; no mesh changes until an edit
    "SET_SURFACE_TOOL": "display",
    "SET_SURFACE_BRUSH": "display",
    "SET_SURFACE_SNAP_GATE": "display",
    "SET_SURFACE_STEP": "display",
    "SET_SURFACE_FREE": "display",
    "SET_SURFACE_SNAP": "display",
    "EDIT_SURFACE": "analysis",
    "EDIT_SURFACE_STROKE": "analysis",
    "SELECT_SURFACE_VERTEX": "navigation",
    "DELETE_SURFACE_VERTEX": "analysis",
    "SPLIT_SURFACE_EDGE": "analysis",
    "UNDO_SURFACE_EDIT": "analysis",
    "HIGHLIGHT_SURFACE": "display",
    "MOVE_SURFACE_HIGHLIGHT": "analysis",
    "HIGHLIGHT_TO_ROI": "analysis",
    # -- navigation ------------------------------------------------------
    "SET_IJK": "navigation",
    "SET_XYZ": "navigation",
    "JUMP_BACK": "navigation",
    "SET_INDEX": "navigation",
    "OPEN_VIEW": "navigation",
    "CLOSE_VIEW": "navigation",
    "SET_VIEW_PLANE": "navigation",
    "SET_VIEW_LOCKED": "navigation",
    "SET_VIEW_POSITION": "navigation",
    "SET_VIEW_GEOMETRY": "navigation",
    "SET_VIEW_TILT": "navigation",
    "SET_VIEW_STRIP": "navigation",
    "SET_ZOOM": "navigation",
    "SET_PAN": "navigation",
    "SET_TIME_LINKED": "display",  # whether the shared clock drives this layer
    # -- display ---------------------------------------------------------
    "SET_THEME": "display",
    "SET_VIEW_SOLO": "display",
    "SET_VIEW_TILES": "display",
    "SET_VIEW_GRID": "display",
    "SET_VIEW_TRACES": "display",
    "SET_VIEW_HIDDEN": "display",
    "SET_VIEW_REGRESSORS": "display",
    "SET_VIEW_TINT": "display",
    "SET_VIEW_SHARED_SCALE": "display",
    "SET_VIEW_PANEL": "navigation",
    "SET_VIEW_SCALING": "display",
    "SET_VIEW_DETREND": "display",  # a display-side detrend for carpet/matrix
    "SET_CARPET_ORDER": "display",
    "SET_MATRIX_ORDER": "display",
    "SET_VIEW_ROIS": "display",  # which ROI layer supplies matrix nodes
    "SET_VIEW_SAMPLING": "display",
    "SET_ATLAS": "display",  # names regions in the readout / annot map
    "SET_OUTLINE_WIDTH": "display",
    "SHOW_SURFACES": "display",
    "SET_MESH": "display",  # show/hide/recolour a comparison mesh
    "SET_SURFACE_SHAPE": "display",
    "SET_SURFACE_DEPTH": "display",
    "SET_SURFACE_DEPTH_STAT": "display",
    "SET_SURFACE_EQUIVOLUME": "display",
    "SET_SURFACE_MAP": "display",
    "SET_SURFACE_FOLDING": "display",
    "SET_SURFACE_HEMIS": "display",
    "SET_SURFACE_HINGE": "display",
    "SET_PATCH_SIZE": "display",
    "SET_PATCH_LAYER": "display",
    "SET_PATCH_OVERLAYS": "display",
    "SET_DEPTH_VIEW": "display",
    "SET_PROFILE_VIEW": "display",
    "SELECT_LAYER": "display",  # aims the controls and decides what solo draws
    "MOVE_LAYER": "display",
    "SET_LAYER_VISIBLE": "display",
    "SET_LAYER_OPACITY": "display",
    "SET_LAYER_XFORM": "display",  # moves where a layer is drawn, not its voxels
    "SET_LAYER_FOLLOWS": "display",
    "SET_VOLUME": "display",
    "SET_THRESHOLD_INDEX": "display",
    "SET_LAYER_ROI": "display",
    "SET_COLORMAP": "display",
    "SET_COLORMAP_REVERSED": "display",
    "SET_PANES": "display",
    "SET_SIGN": "display",
    "SET_RANGE": "display",
    "SET_RANGE_MIRROR": "display",
    "SET_RANGE_FIXED": "display",
    "SET_THRESHOLD": "display",
    "SET_THRESHOLD_FOLLOW": "display",
    "SET_ALPHA": "display",
    "SET_BOXED": "display",
    "SET_EDGES": "display",
    "SET_RESAMPLE": "display",
    "SET_GRID_RES": "display",
    "SET_LAYER_TIME_VIEW": "display",  # detrend/PSC of the shown frame only
}

#: Assignments a reader could reasonably expect under another heading. Printed
#: in the generated doc so the choice is visible rather than silent.
AMBIGUOUS: dict[str, str] = {
    "SET_SEED": "navigation-like (it names a voxel) but it is InstaCorr's input, so analysis.",
    "SET_LAYER_XFORM": "geometry, but the voxels never move -- it is where they are drawn, so display.",
    "SET_LAYER_FOLLOWS": "same transform question as SET_LAYER_XFORM; display.",
    "SET_VIEW_DETREND": "projects drift out, but only into the carpet/matrix picture; display.",
    "SET_VIEW_ROIS": "picks a data source, but only for the matrix window's nodes; display.",
    "SET_ATLAS": "changes names in the readout and the annot map, never a voxel; display.",
    "SET_TIME_LINKED": "a layer setting, but it decides what the clock does to it; navigation.",
    "USE_MESH": "reads no file, but selects which loaded mesh is the hemisphere's data; source.",
    "SET_VIEW_STRIP": "draws extra slices, but it is window geometry (which slices); navigation.",
    "SELECT_LAYER": "aims the controls (editing) but also decides what a soloed window draws; display.",
    "SET_LAYER_ROI": "also changes what an ROI can be used for, but its visible effect is colouring; display.",
}


@dataclass(frozen=True)
class Argument:
    name: str
    annotation: str
    default: str | None  # None = required


@dataclass(frozen=True)
class CommandInfo:
    name: str
    lineno: int
    class_name: str
    doc: str
    aspects: list[str]
    major: bool
    arguments: list[Argument]
    category: str


def _aspect_names(expr: ast.expr) -> list[str]:
    """Member names of an ``Aspect.A | Aspect.B`` expression, in source order."""
    if isinstance(expr, ast.Attribute) and isinstance(expr.value, ast.Name):
        if expr.value.id == "Aspect":
            return [expr.attr]
    if isinstance(expr, ast.BinOp) and isinstance(expr.op, ast.BitOr):
        return _aspect_names(expr.left) + _aspect_names(expr.right)
    raise ValueError(f"unrecognised aspects expression: {ast.unparse(expr)}")


def _read_aspect_enum(path: Path) -> set[str]:
    """The valid names of the ``Aspect`` IntFlag, straight from commands.py."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "Aspect":
            names = set()
            for item in node.body:
                if isinstance(item, ast.Assign) and isinstance(item.targets[0], ast.Name):
                    names.add(item.targets[0].id)
                elif isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name):
                    names.add(item.target.id)
            return names
    raise SystemExit(f"{path}: no class Aspect found")


def _first_paragraph(docstring: str) -> str:
    """The summary paragraph of a command docstring, on one line, RST cleaned.

    The source docstrings are reStructuredText; converting the inline markup to
    its plain text keeps the generated Markdown readable without changing what
    the sentence says. Empty stays empty and is reported as such in the table.
    """
    text = docstring.strip()
    if not text:
        return ""
    para = text.split("\n\n", 1)[0]
    line = " ".join(part.strip() for part in para.splitlines() if part.strip())
    for role in ("mod", "class", "meth", "func", "data", "attr", "type"):
        line = line.replace(f":{role}:`", "`")
    line = line.replace("``", "`")
    return line


def _parse_vocab(path: Path) -> list[CommandInfo]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    out: list[CommandInfo] = []
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        if not any(isinstance(d, ast.Name) and d.id == "command" for d in node.decorator_list):
            continue
        name: str | None = None
        aspects: list[str] = []
        major = False
        arguments: list[Argument] = []
        for stmt in node.body:
            if isinstance(stmt, ast.Assign):
                target = stmt.targets[0]
                if isinstance(target, ast.Name):
                    if target.id == "name":
                        name = ast.literal_eval(stmt.value)
                    elif target.id == "major":
                        major = bool(ast.literal_eval(stmt.value))
                    elif target.id == "aspects":
                        aspects = _aspect_names(stmt.value)
            elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                # Only command *fields* are annotated in the class body.
                default = None if stmt.value is None else ast.unparse(stmt.value)
                arguments.append(
                    Argument(
                        name=stmt.target.id,
                        annotation=ast.unparse(stmt.annotation),
                        default=default,
                    )
                )
        if name is None:
            raise SystemExit(f"{path}:{node.lineno}: command class without a name")
        doc = ast.get_docstring(node, clean=True) or ""
        out.append(
            CommandInfo(
                name=name,
                lineno=node.lineno,
                class_name=node.name,
                doc=_first_paragraph(doc),
                aspects=aspects or ["NOTHING"],
                major=major,
                arguments=arguments,
                category="",  # filled below
            )
        )
    out.sort(key=lambda c: (c.name, c.lineno))
    return out


def _categorise(commands: list[CommandInfo]) -> None:
    names = [c.name for c in commands]
    missing = [n for n in names if n not in CATEGORY_BY_NAME]
    extra = sorted(set(CATEGORY_BY_NAME) - set(names))
    if missing or extra:
        lines = [
            "vocab.py and CATEGORY_BY_NAME disagree; update scripts/extract_commands.py:",
        ]
        if missing:
            lines.append(f"  unclassified commands: {', '.join(missing)}")
        if extra:
            lines.append(f"  table entries with no command: {', '.join(extra)}")
        raise SystemExit("\n".join(lines))
    bad = sorted(n for n, c in CATEGORY_BY_NAME.items() if c not in CATEGORIES)
    if bad:
        raise SystemExit(f"unknown categories for: {', '.join(bad)}")
    for cmd in commands:
        object.__setattr__(cmd, "category", CATEGORY_BY_NAME[cmd.name])


def _md_escape(text: str) -> str:
    return text.replace("|", "\\|").replace("*", "\\*").replace("_", "\\_")


def _args_cell(args: list[Argument]) -> str:
    if not args:
        return "--"
    parts = []
    for a in args:
        piece = f"`{a.name}` {_md_escape(a.annotation)}"
        if a.default is None:
            piece += " **required**"
        else:
            piece += f" = `{_md_escape(a.default)}`"
        parts.append(piece)
    return "<br>".join(parts)


def render(commands: list[CommandInfo], vocab_display: str, commands_display: str) -> str:
    by_cat: dict[str, list[CommandInfo]] = {c: [] for c in CATEGORIES}
    for cmd in commands:
        by_cat[cmd.category].append(cmd)
    for bucket in by_cat.values():
        bucket.sort(key=lambda c: c.name)

    total = len(commands)
    major = sum(1 for c in commands if c.major)
    lines = [
        "# FFS viewer command reference",
        "",
        "Generated by [`scripts/extract_commands.py`](../scripts/extract_commands.py) from",
        f"[`{vocab_display}`](../{vocab_display}) and the `Aspect` enum in",
        f"[`{commands_display}`](../{commands_display}). **Do not edit by hand** -- rerun the",
        "script. The read-only clone under `reference/` is the source of truth; file:line",
        "citations below are lines in that clone.",
        "",
        "Each command is a frozen dataclass registered on the FFS command bus. Arguments",
        "are positional on a script line in the order listed; `--` means the command takes",
        "none. `major` marks commands a replay may pause on (data loads, fits, seeds).",
        "`aspects` is what a command invalidates, so the UI can skip irrelevant repaints.",
        "",
        "## Summary",
        "",
        f"- Commands: **{total}** ({major} major, {total - major} not major)",
    ]
    for cat in CATEGORIES:
        lines.append(f"- `{cat}`: **{len(by_cat[cat])}**")
    lines += [
        "",
        "## Categories",
        "",
        "| Category | Definition | What a command in it changes |",
        "|---|---|---|",
    ]
    for cat in CATEGORIES:
        rule, changes = CATEGORY_RULES[cat]
        lines.append(f"| `{cat}` | {_md_escape(rule)} | {_md_escape(changes)} |")
    lines += [
        "",
        "Assignments that could reasonably be argued the other way are listed below",
        "rather than hidden in the code:",
        "",
        "| Command | Why it is where it is |",
        "|---|---|",
    ]
    for name in sorted(AMBIGUOUS):
        if name not in CATEGORY_BY_NAME:
            continue
        cat = CATEGORY_BY_NAME[name]
        lines.append(f"| `{name}` | {cat} -- {_md_escape(AMBIGUOUS[name])} |")

    for cat in CATEGORIES:
        rule, changes = CATEGORY_RULES[cat]
        lines += [
            "",
            f"## {cat} commands ({len(by_cat[cat])})",
            "",
            f"*{rule}*",
            "",
            "| Command | Args (type/default) | Aspects | Major | Doc | Line |",
            "|---|---|---|---|---|---|",
        ]
        for cmd in by_cat[cat]:
            aspects = _md_escape(" | ".join(cmd.aspects))
            doc = _md_escape(cmd.doc) if cmd.doc else "*(no docstring in source)*"
            lines.append(
                f"| **{cmd.name}** | {_args_cell(cmd.arguments)} | {aspects} | "
                f"{'yes' if cmd.major else ''} | {doc} | "
                f"`vocab.py:{cmd.lineno}` |"
            )

    lines += [
        "",
        "## Script syntax",
        "",
        "A recorded session is one command per line: the name, then the positional",
        "arguments in the order above, encoded as plain scalars. Booleans are `1`/`0`,",
        "empty optionals are `-`, strings with spaces are quoted (`shlex` rules), `#`",
        "starts a comment. Example: `SET_IJK 32 40 25`, `SET_THRESHOLD L2 2.5`.",
        "Parsing lives in `viewer/commands.py` (`parse_script`, `_build`); recording",
        "collapses runs of the same non-major command aimed at the same target.",
        "",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vocab", type=Path, default=VOCAB_PATH)
    parser.add_argument("--commands", type=Path, default=COMMANDS_PATH)
    parser.add_argument("--out", type=Path, default=OUTPUT_PATH)
    parser.add_argument("--stdout", action="store_true", help="print instead of writing")
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit 1 if the checked-in doc differs from what would be generated",
    )
    args = parser.parse_args(argv)

    for path in (args.vocab, args.commands):
        if not path.exists():
            raise SystemExit(f"missing source: {path}")

    commands = _parse_vocab(args.vocab)
    _categorise(commands)

    valid = _read_aspect_enum(args.commands)
    for cmd in commands:
        unknown = [a for a in cmd.aspects if a not in valid]
        if unknown:
            raise SystemExit(f"{cmd.name}: unknown aspect(s) {unknown}")

    try:
        vocab_display = args.vocab.resolve().relative_to(REPO_ROOT)
        commands_display = args.commands.resolve().relative_to(REPO_ROOT)
    except ValueError:
        vocab_display = args.vocab
        commands_display = args.commands
    text = render(commands, str(vocab_display), str(commands_display))

    if args.stdout:
        sys.stdout.write(text)
        return 0
    if args.check:
        current = args.out.read_text(encoding="utf-8") if args.out.exists() else ""
        if current != text:
            print(f"{args.out} is stale; rerun scripts/extract_commands.py", file=sys.stderr)
            return 1
        print(f"{args.out} is up to date ({len(commands)} commands)")
        return 0
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(text, encoding="utf-8")
    print(f"wrote {args.out}: {len(commands)} commands")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
