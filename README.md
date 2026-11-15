# FFS Harness viewer

<p align="center"><img src="screenshots/logo_preview.png" width="300" alt="FFS logo — folded cortex and crosshair"></p>

An interactive fMRI viewer for DeepSeek Harness, built on the
[fastfuncstuff](https://github.com/dowdlelt/fastfuncstuff) viewer. FFS's datasets, layers,
modes, command controller and independent viewports are preserved; its separate desktop
windows are consolidated into one resizable workspace with docked and tabbed panes inside
the Harness Web interface.

![Workspace layout](docs/workspace.svg)

## Logo

A monochrome **folded-cortex slice with a crosshair** inside a hexagonal slice contour.
`ffs-harness-viewer/icon.svg` is the standalone tab icon; `ffs-harness-viewer/logo.svg`
is the icon + **FFS** lockup.

## What is here

| Path | What |
|---|---|
| `ffs-record/` | `@local/ffs-record` bundle (R0–R5): Host tools/route over the append-only ledger, decisions, preferences and inspection index, plus a **Record tab** Client surface. **Installed** in the `desktop` profile (Host tools live; reload the page for the Client tab) |
| `docs/PHILOSOPHY_CONFORMANCE.md` | re-audited charter conformance map: **13 met / 0 partial / 0 absent**, with file-level evidence and residual gaps |
| `scripts/compact_inspection.py` | inspection retention: compact old viewer sessions (age/byte budget) into compact records with tombstones; `--dry-run` supported |
| `python/ffsrecord/` | R3 deterministic preference layer: inspection-session feature shards, policy.yaml, profile aggregation, precedence resolution, `python -m ffsrecord.cli` |
| `shared/record/` | dependency-free record store shared by the analysis and record bundles (append-only shards, actors, fold, rebuild, legacy import) |
| `ffs-harness-viewer/` | the Harness bundle: Host plugin (`index.js`: sidecar manager, authenticated `/ffs` bridge route, ten agent tools) and Client plugin (`client.js`: right-Sidebar tab with docked slice/surface/series panes) |
| `python/ffsviewer/` | headless FFS sidecar: authoritative `ViewerSession`, validated command dispatch, PNG slice rendering, surface sampling/picking, series extraction, persistence |
| `reference/fastfuncstuff` | read-only clone of the original viewer/scientific core the sidecar imports |
| `data/demo/` | deterministic demo dataset + synthetic FreeSurfer subject (`scripts/build_demo_data.py`) |
| `docs/API.md` | the shared validated command/transport contract |
| `docs/WORKFLOW.md` | FFS analysis workflow and plugin-integration design (compute ↔ viewer ↔ project manifest) |
| `docs/ANALYSIS_UI.md` | analysis inspection UI design: tab, cohort/group views, slots, transport, wireframes |
| `docs/ANALYSIS_PANEL.md` | **design v0.3 (autoproc-centred)** for the analysis panel: recipe presets, the 19-stage board, grouped editing of the 172 autoproc flags, scratch runner, inline QC verdicts |
| `docs/analysis_panel_*.svg` | design sketches: stage board + inspector, all-options drawer, QC decisions (v0.3) |
| `docs/RECORD.md` | record-layer design and build status: run-attempt ledger, decision records, durable inspection log, preference profile, deletion semantics, milestones R0–R5 built |
| `docs/REPRO_PACKAGE.md` | reproducible cohort/group package: runnable scripts, STEPS/METHODS, verification |
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

### Record tab installation

The record bundle **is installed** in the `desktop` profile (linked from `ffs-record/`, bundle
row appended, `package.json` backed up). The Host half is live — `ffs_record_query` and
`ffs_record_rebuild` respond — and the Client half is registered live (Record tab body and
header button active in the slot tree; reload the page if the tab is not visible):

```bash
bash scripts/install_record_bundle.sh --dry-run   # inspect the plan; writes nothing
bash scripts/install_record_bundle.sh --apply     # already run for the desktop profile
```

After reloading, the **Record** tab appears in the right Sidebar (and a Record button in the
Session header). Visual behavior of the docked tab has not been verified here (no browser
control); the Host routes/tools and the client factory/render smoke are covered by tests.

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
- **Minimize** — **–** in a window title sends it to the bottom **Minimized:** taskbar; click
the chip to restore it. Clicking anywhere in a window raises it to the front.

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

The left **Controls** rail is a collapsible card inspector: **Layers**, **Colour** and
**Overlay** cards; **Colour** holds the selected layer, opacity, colormap, sign and the
range bar (min/max inputs + **Auto** + mirror/fixed/reverse); **Overlay** holds the OLAY /
THR ON sub-brick selectors, threshold on/off with numeric entry + slider, alpha and
boxed/edges/time-linked options. Layer visibility and unload live in Layers; and a horizontal colour bar (min left/max right, click to set threshold when THR ON reads this sub-brick (the bar grays out otherwise), Shift+click to reverse, sub-threshold dimming), sign, **OLAY** shown sub-brick,
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
