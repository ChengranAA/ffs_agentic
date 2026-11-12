"""Classify every FFS viewer command as source / analysis / display / navigation.

The distinction is a product requirement, not bookkeeping: a display change can be
saved, replayed over any analysis, and thrown away without losing science. A source or
analysis change defines what data exists in the session and what was computed from it,
so ``display.ffs`` and ``analysis.ffs`` are written separately and the UI shows the two
revision counters apart.

The table is explicit over all 114 commands registered by ``viewer/vocab.py``. A command
added upstream must be added here (``test_categories_cover_registry`` enforces that)
rather than silently defaulting to a category where a copy would mislead.
"""

from __future__ import annotations

CATEGORY_SOURCE = "source"
CATEGORY_ANALYSIS = "analysis"
CATEGORY_DISPLAY = "display"
CATEGORY_NAVIGATION = "navigation"

CATEGORIES = (CATEGORY_SOURCE, CATEGORY_ANALYSIS, CATEGORY_DISPLAY, CATEGORY_NAVIGATION)

#: Loading, writing back, and removing data. Nothing here is cosmetic.
SOURCE: frozenset[str] = frozenset({
    "READ",
    "READ_FILES",
    "LOAD",
    "LOAD_SURFACES",
    "LOAD_MESH",
    "USE_MESH",
    "REMOVE_MESH",
    "SAVE_MESH",
    "SAVE_SURFACES",
    "SAVE_SURFACE_ROI",
    "LOAD_SURFACE_ROI",
    "RELOAD_LAYER",
    "ADD_LAYER",
    "SET_UNDERLAY",
    "SET_OVERLAY",
    "ADD_OVERLAY",
    "REMOVE_LAYER",
})

#: Computing something (modes, denoise, paint, surface edits) or changing what a
#: layer's values mean (alignment transform, time semantics, ROI semantics).
ANALYSIS: frozenset[str] = frozenset({
    "DENOISE",
    "NEW_PAINT_LAYER",
    "PAINT_STROKE",
    "PAINT_UNDO",
    "SET_MODE",
    "SET_MODE_PARAM",
    "MODE_ACTION",
    "SET_INPUT",
    "SET_SEED",
    "EDIT_SURFACE",
    "EDIT_SURFACE_STROKE",
    "DELETE_SURFACE_VERTEX",
    "SPLIT_SURFACE_EDGE",
    "MOVE_SURFACE_HIGHLIGHT",
    "HIGHLIGHT_TO_ROI",
    "UNDO_SURFACE_EDIT",
})

#: Where you are looking: crosshair, time, window existence/identity, and the
#: geometry of the window itself.
NAVIGATION: frozenset[str] = frozenset({
    "SET_IJK",
    "SET_XYZ",
    "JUMP_BACK",
    "SET_INDEX",
    "OPEN_VIEW",
    "CLOSE_VIEW",
    "SET_VIEW_PLANE",
    "SET_VIEW_LOCKED",
    "SET_VIEW_POSITION",
    "SET_VIEW_GEOMETRY",
    "SET_ZOOM",
    "SET_VIEW_TILT",
    "SET_PAN",
    "SET_VIEW_STRIP",
    "SELECT_SURFACE_VERTEX",
    "SET_VIEW_PANEL",
})

#: Appearance and per-window content choices that change no data and no computation.
DISPLAY: frozenset[str] = frozenset({
    "SET_THEME",
    "SET_VIEW_SOLO",
    "SET_VIEW_TILES",
    "SET_VIEW_GRID",
    "SET_VIEW_TRACES",
    "SET_VIEW_HIDDEN",
    "SET_VIEW_REGRESSORS",
    "SET_VIEW_TINT",
    "SET_VIEW_SHARED_SCALE",
    "SET_CARPET_ORDER",
    "SET_VIEW_DETREND",
    "SET_VIEW_SCALING",
    "SET_MATRIX_ORDER",
    "SET_VIEW_ROIS",
    "SHOW_SURFACES",
    "SET_OUTLINE_WIDTH",
    "SET_SURFACE_EDITING",
    "SET_SURFACE_BRUSH",
    "SET_SURFACE_SNAP_GATE",
    "SET_SURFACE_STEP",
    "SET_SURFACE_FREE",
    "SET_SURFACE_SNAP",
    "SET_SURFACE_TOOL",
    "HIGHLIGHT_SURFACE",
    "SET_SURFACE_SHAPE",
    "SET_SURFACE_DEPTH",
    "SET_PATCH_SIZE",
    "SET_PATCH_LAYER",
    "SET_PATCH_OVERLAYS",
    "SET_VIEW_SAMPLING",
    "SET_SURFACE_EQUIVOLUME",
    "SET_SURFACE_DEPTH_STAT",
    "SET_SURFACE_MAP",
    "SET_SURFACE_FOLDING",
    "SET_SURFACE_HEMIS",
    "SET_SURFACE_HINGE",
    "SET_DEPTH_VIEW",
    "SET_PROFILE_VIEW",
    "SET_ATLAS",
    "SET_MESH",
    "SET_LAYER_XFORM",
    "SET_LAYER_FOLLOWS",
    "SET_LAYER_ROI",
    "SET_TIME_LINKED",
    "MOVE_LAYER",
    "SELECT_LAYER",
    "SET_LAYER_VISIBLE",
    "SET_LAYER_OPACITY",
    "SET_VOLUME",
    "SET_THRESHOLD_INDEX",
    "SET_COLORMAP",
    "SET_COLORMAP_REVERSED",
    "SET_PANES",
    "SET_SIGN",
    "SET_RANGE",
    "SET_THRESHOLD",
    "SET_LAYER_TIME_VIEW",
    "SET_RANGE_MIRROR",
    "SET_RANGE_FIXED",
    "SET_THRESHOLD_FOLLOW",
    "SET_ALPHA",
    "SET_BOXED",
    "SET_EDGES",
    "SET_RESAMPLE",
    "SET_GRID_RES",
})

_BY_CATEGORY = {
    CATEGORY_SOURCE: SOURCE,
    CATEGORY_ANALYSIS: ANALYSIS,
    CATEGORY_DISPLAY: DISPLAY,
    CATEGORY_NAVIGATION: NAVIGATION,
}


def category_of(name: str) -> str:
    """The one category a command belongs to; KeyError for an unclassified name."""
    upper = name.upper()
    for category, names in _BY_CATEGORY.items():
        if upper in names:
            return category
    raise KeyError(f"command {name!r} has no category")


def assert_complete(registered: list[str]) -> list[str]:
    """Names the registry has and this table does not (for the sidecar's self-check)."""
    known = SOURCE | ANALYSIS | NAVIGATION | DISPLAY
    return sorted(name for name in registered if name.upper() not in known)


def summary() -> dict[str, int]:
    return {category: len(names) for category, names in _BY_CATEGORY.items()}
