# FFS Harness viewer

An interactive fMRI viewer for DeepSeek Harness, built on the
[fastfuncstuff](https://github.com/dowdlelt/fastfuncstuff) viewer. FFS's datasets, layers,
modes, command controller and independent viewports are preserved; its separate desktop
windows are consolidated into one resizable workspace with docked and tabbed panes inside
the Harness Web interface.

![Workspace layout](docs/workspace.svg)

## What is here

| Path | What |
|---|---|
| `ffs-harness-viewer/` | the Harness bundle: Host plugin (`index.js`: sidecar manager, authenticated `/ffs` bridge route, ten agent tools) and Client plugin (`client.js`: right-Sidebar tab with docked slice/surface/series panes) |
| `python/ffsviewer/` | headless FFS sidecar: authoritative `ViewerSession`, validated command dispatch, PNG slice rendering, surface sampling/picking, series extraction, persistence |
| `reference/fastfuncstuff` | read-only clone of the original viewer/scientific core the sidecar imports |
| `data/demo/` | deterministic demo dataset + synthetic FreeSurfer subject (`scripts/build_demo_data.py`) |
| `docs/API.md` | the shared validated command/transport contract |
| `docs/WORKFLOW.md` | FFS analysis workflow and plugin-integration design (compute ↔ viewer ↔ project manifest) |
| `docs/FEATURE_INVENTORY.md` | exhaustive inventory of the original viewer, source-referenced |
| `docs/PARITY.md` | feature parity tracker (implemented / partial / not started / out of scope) |
| `docs/COMMAND_REFERENCE.md` | generated reference for all 114 FFS commands |
| `docs/RENDERING_EVALUATION.md` | measured evaluation of the prototype rendering architecture |
| `docs/UI_AUDIT.md` | static UI/runtime audit of the client plugin |
| `verification/` | independent verification against the original viewer's code paths |

## Run

The bundle is installed in the `desktop` Harness profile. The viewer is **docked in the
right Sidebar** as a tab: click **FFS viewer** in the Session header (or open the right
sidebar and pick the FFS viewer capsule from its guide). Ask the agent to `ffs_viewer_show`
and the docked tab is revealed. Expand the Sidebar or switch it to fullscreen with its own
panel controls for more room; inside the tab, panes still dock, tab, split, resize and
maximize.

After a client-plugin update, refresh the Harness page once so the Web loader fetches the
new `client.js`; the Host half and its Python sidecar reload with the bundle row.

Requirements: `.venv/bin/python` with `numpy`, `scipy`, `nibabel`, `torch`, `tqdm`
(see `reference/fastfuncstuff/pyproject.toml`), and the sidecar launched with
`PYTHONPATH=python:reference/fastfuncstuff` — the Host plugin sets both automatically.

```bash
# regenerate demo data
.venv/bin/python scripts/build_demo_data.py

# regenerate the command reference
.venv/bin/python scripts/extract_commands.py --check

# run the sidecar directly (NDJSON on stdio)
PYTHONPATH=python:reference/fastfuncstuff \
  .venv/bin/python -u -m ffsviewer.server --project-root . --state-dir /tmp/ffs-state
```

## Loading your own data

**Nothing is loaded at launch.** The docked viewer opens with empty panes and a **Data
sources…** button (header folder icon, control rail, or the empty-state card). The dialog
mirrors the FFS data picker:

- **Folders**: add a folder (separate directory picker, or paste a folder path), scan it
  into the catalog, rescan it, remove it, or toggle **recursive**. Folders persist in
  `sources.json`; they are not data and can be removed without touching loaded layers.
- **Datasets**: the catalog for the selected folder, sorted by kind (anat / func / stats /
  mask), with **type filter chips and counts** (All / Anat / Func / Stats / Mask). Dataset rows
show a middle-truncated filename with kind/dimensions/TR/labels on a second line, and
hovering reveals the full path in the footer (double-click loads). Clicking an entry previews it (FFS preview layer); **Load** commits it as a
  recorded layer, **Load & close** commits and returns to the viewer.
- **Subjects**: add a FreeSurfer subject folder (`surf/?h.white`) to load its surfaces;
  subjects persist in the source list.
- The same operations are agent tools: `ffs_viewer_sources` (list/add/remove/read/subject/
  load_entry) and `ffs_viewer_load` (direct paths), plus `LOAD`/`LOAD_SURFACES` command lines.

The `data/demo` fixture and its builder remain for tests and screenshots only; the viewer
never loads it implicitly.

## One validated command interface

Every mutation is an FFS command parsed by the original `viewer.commands.parse_line`
(114 registered commands, typed fields, replayable text):

- the browser dispatches the same lines through the authenticated Connection RPC channel
  (`/ffs`, origin `ui`);
- agent tools dispatch through the identical Host methods (origin `agent`);
- the sidecar is the only holder of `ViewerSession`/`ViewerState`, so user and agent
  actions cannot diverge.

Persistence writes the FFS script (`viewer.ffs`), the cosmetic-only script
(`display.ffs`), the source/analysis script (`analysis.ffs`), the Harness workspace layout
(`workspace.json`) and a manifest (`session.json`) that records the split.

## Evidence in this checkout

![Rendered demo workspace](screenshots/demo_workspace.png)

Real output of the prototype pipeline: FFS-rendered axial/sagittal/coronal slices,
FFS-sampled surface colours (WebGL rasterized for this image), and the linked graph
grid at the peak task voxel. Additional artefacts:

- `screenshots/demo_threshold.png` — the same slice soloed on the statistic map at two
  thresholds (2.0 vs 4.0), both composited by `compose.render_plane`.
- `screenshots/demo_surface.png`, `screenshots/demo_series.png`, `screenshots/demo_V*.png`.
- `verification/REPORT.md` — 10 PASS / 0 FAIL checks against the original viewer's code
  paths (pixel-exact renders, 430,164 vertex colours, picking, sync, persistence).
- `docs/RENDERING_EVALUATION.md` — measured latency/bytes and the Phase-2 plan.
- `docs/UI_AUDIT.md` — static UI/runtime audit and what was fixed/remains.

Regenerate the images with `.venv/bin/python scripts/render_demo.py`.

## Layout

Panes are floating windows inside the docked Sidebar tab, with just two gestures:

- **Move freely** — drag a window by its title bar. Panes can overlap and be placed
  anywhere; no grid is imposed.
- **Snap (optional, modifier-only)** — hold **Shift** while the pointer is in the
  narrow edge/corner band (≈16 px) to highlight that half/quarter; release with Shift
  still down to snap. Without Shift, releasing anywhere — including at an edge — keeps
the free position, so ordinary drags never snap by accident.
- **Resize** — drag any window edge/corner, or the visible **◢** grip at the bottom-right.

The initial placement is a 2×2 arrangement; after that every pane is free to move,
overlap, snap to an edge, or be resized to any proportion. Window positions and sizes persist in `workspace.json`, alongside the tab
assignment inside each window. Tabs still switch views inside a window; **✕** on a tab
closes that view, and **⚙** opens its per-view settings.

Graph 1 is one cell; **click or drag horizontally** across it to scrub the shared 4-D time index. Viewport tabs read **Viewer 1 / Viewer 2 / Viewer 3**, **Surface 1**, **Graph 1**; the raw
FFS ids (`V1`, `S1`, …) remain the command identity and appear in the tooltip/settings.
**＋ Add viewer** in the header creates a new floating viewer (image axial/sagittal/coronal,
graph, or surface). The menu's **Data** chooser selects the whole visible stack or one
layer (solo view); each viewer's ⚙ settings has a **Data** selector too. Views share the
session layer stack, so solo views follow the selected layer.

The left **Controls** rail is a collapsible card inspector: layer visibility and unload,
opacity, threshold on/off with a numeric entry and slider, colormap, range entry with **Auto** and an interactive colour bar (drag end handles for min/max, click/drag the bar for threshold), sign, **OLAY** shown sub-brick,
**THR ON** threshold sub-brick with same/+1/+2/fixed follow, and an Advanced disclosure
for resample, sub-threshold fade, boxed, range mirror/fixed, reverse, edges, time-linked
and time-view detrend/PSC.

Surface panes have a **Flatten / Inflated** button (disabled when the subject has no
`?h.*.patch.3d`). Switching surface shape animates the morph like the original FFS
surface window (450 ms, InOutCubic, camera zoom kept relative to the brain) instead of
snapping. Data loads repaint immediately.

## Prototype scope

Implemented panes: **image**, **surface**, **graph**. The other seven FFS view kinds are
accepted as viewport identities (tabs open) but have no renderer yet; they are tracked
explicitly in `docs/PARITY.md`. See `docs/RENDERING_EVALUATION.md` for measured
architecture findings and the Phase-2 plan.
