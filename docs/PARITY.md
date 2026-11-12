# FFS viewer → Harness rebuild: parity matrix

**Purpose.** Map every feature inventoried in
[`docs/FEATURE_INVENTORY.md`](FEATURE_INVENTORY.md) to the Harness rebuild, with a
status that a later agent can reconcile. This is a *tracker*, not a promise: the
Guiding rule is that a row says what is actually true in this checkout, and
anything unverified is marked rather than assumed.

**Original.** `reference/fastfuncstuff` @ `995b7d23a7294dec0408479371dde0d486ba9487`;
feature descriptions and file:line citations are in
`docs/FEATURE_INVENTORY.md` (paths there are relative to
`reference/fastfuncstuff/fastfuncstuff/`). Command reference:
[`docs/COMMAND_REFERENCE.md`](COMMAND_REFERENCE.md). Harness architecture:
[`docs/API.md`](API.md).

**Harness under test.** The sidecar (`python/ffsviewer/`), the Host plugin
(`ffs-harness-viewer/index.js`) and the browser client
(`ffs-harness-viewer/client.js`) in this workspace at the time of writing. The
sidecar imports the *real* FFS core (`ViewerSession`, `CommandBus`, `vocab`,
`compose`, `surface3d`, `surface.profiles`, `surfacelayers`, …), so "the FFS
mechanism" rows are usually implemented by reuse rather than reimplementation.

## Status vocabulary

The `ffs_viewer_parity` tool (`ffs-harness-viewer/index.js:520-534`) counts rows
whose status cell is one of the five words below. Use exactly these words in the
status cell; do not qualify them inside the cell (put qualifications in Notes).

| Status | Meaning |
|---|---|
| `implemented` | Reachable in the harness and its effect is visible through at least one surface: a pane, a control, the state snapshot, a saved file, or an agent tool. |
| `partial` | The FFS mechanism exists in the sidecar (usually because the command is accepted and authoritative state changes), but the harness surface is missing or incomplete — no pane, no control, or no gesture. |
| `not started` | No harness mechanism at all. |
| `out of scope` | Deliberately not rebuilt, either because it is desktop-only (separate-window geometry, Qt dialogs) or because the Harness replaces it (its own layout/persistence). "Intentionally out of scope" in the brief. |
| `not implemented` | In the original, absent from the harness, and no decision recorded to drop it. Used sparingly; prefer `not started` for work still intended. |

**Reconcile before trusting.** The statuses below were seeded from the harness
code as it stood when this file was written (the demo data, sidecar, host and
client were being built in parallel). Re-read `python/ffsviewer/` and
`ffs-harness-viewer/` and update rows rather than assuming. Where the harness
later adds a surface, flip `partial` → `implemented`; do not flip it without the
surface existing.

**Architecture substitutions already decided** (record them here so they are not
re-litigated):

- The original opens **13 separate top-level windows** and has **no docking**.
  The Harness consolidates them into **one resizable workspace with docked/
  tabbed panes** (`ffs-harness-viewer/docs/DETAIL.md`). That is a deliberate
  replacement, not a regression: `out of scope` for "separate windows",
  "window manager placement/geometry", and the per-window Qt shortcut tables.
- The original's **controller tabs** (A/B/C… with mm-linked crosshair and time)
  have no harness equivalent yet; a single workspace is the prototype scope.
- The original's **session script file** is persisted by the harness as
  `viewer.ffs` alongside `workspace.json` and `manifest.json`
  (`python/ffsviewer/persist.py`); layout is stored separately because it is not
  scientific state. This preserves the original's script-vs-command-line split.

## Command-category taxonomy — reconciled

There were two independent classifications while the viewer was being built. They now
agree on all 114 commands: `python/ffsviewer/classify.py` is the runtime authority (it
drives `ffs_viewer_*` results, revision chips and the saved manifest), and
`scripts/extract_commands.py` holds the same table for `docs/COMMAND_REFERENCE.md`.
`scripts/extract_commands.py --check` fails if either drifts.

| | source | analysis | display | navigation |
|---|---|---|---|---|
| all 114 commands | 17 | 16 | 65 | 16 |

The distinction the product requires is the one these categories encode: **display**
changes are cosmetic and replays over any analysis; **source** and **analysis** changes
define what data exists and what was computed. **Navigation** is where/when you look and
is saved with display in `display.ffs`.

## Reconciliation status (2026-11-12, prototype revision)

This matrix has been reconciled against the implemented prototype at the time of
delivery. Statuses that changed from the seeded revision:

- `VK-01` image, `VK-02` graph, `VK-03` surface → **implemented** (real panes, gestures,
  linked navigation, per-view settings).
- The workspace requirements that the brief adds beyond FFS — docked/tabbed panes,
  duplicate views, parked reference slices, linked navigation, per-view settings,
  maximize any pane, persistent layout, display/analysis/source separation, shared
  UI/agent command interface — are delivered; see the PERS/UI rows and
  `docs/API.md`. FFS's separate windows remain `out of scope` by design.
- `PERS-09` demo data → **implemented** (`data/demo/`, regenerated deterministically by
  `scripts/build_demo_data.py`).
- `CORE-08` device/VRAM control → **partial**: the sidecar deliberately fixes the FFS
  device to CPU for reproducible verification, with no config surface yet.
- Everything marked `partial` below is reachable through the validated command
  vocabulary and changes authoritative state, but lacks a dedicated harness surface
  (pane, control or gesture). That is the explicit Phase-2 backlog.
- Nothing here is marked `implemented` on the strength of a command being accepted:
  the row's Notes name the surface that exposes it.

## Harness workspace requirements (delivered, beyond the original)

These are the consolidation requirements from the rebuild brief. They have no direct
FFS counterpart — the original opened 13 separate top-level windows — so they are tracked
separately from the FFS feature rows.

| ID | Requirement | Status | Where | Notes |
|---|---|---|---|---|
| HX-01 | One resizable workspace consolidating separate desktop windows | implemented | `client.js` workspace frame + corner resize handle; `docs/workspace.svg` | Docked/tabbed panes replace 13 top-level windows. |
| HX-02 | Free-floating panes, optional edge snap, resize | implemented | `client.js` `FloatingWorkspace` | Free drag by default; Shift inside a 16 px edge/corner band snaps halves/quarters; no accidental snaps; resize any edge. |
| HX-03 | Move/resize/close panes | implemented | title-bar drag snap, resize handles, tab ✕ | No minimize/maximize/close window chrome; two arrangement gestures only. |
| HX-04 | Independent viewport identities; duplicate views | implemented | FFS `OPEN_VIEW` ids; `GroupPane.duplicate` copies view settings | Ids stay `V1…` for commands; the UI labels them Viewer 1, Surface 1, etc. |
| HX-05 | Parked reference slices and linked navigation | implemented | `SET_VIEW_LOCKED`/`SET_VIEW_POSITION`; verified in `verification/REPORT.md` check 5 | Unlocked panes stay put while locked panes follow. |
| HX-06 | Per-view settings (plane, zoom, pan, solo, tiles, surface depth/shape, graph grid) | implemented | pane settings popover; controlled FFS commands | No direct numeric pan entry yet. |
| HX-07 | Persistent layout | implemented | `workspace.json` + `workspace` endpoint; client autosave | Layout is separate from scientific state. |
| HX-08 | Save viewer state and layout together | implemented | `ffs_viewer_save`; `viewer.ffs`, `display.ffs`, `analysis.ffs`, `workspace.json`, `session.json` | Display vs analysis vs source split is explicit. |
| HX-09 | One validated command interface for user controls and agent tools | implemented | `/ffs` Connection RPC + `ffs_viewer_command`; `verification/REPORT.md` check 5 | 53-command ui-vs-agent state/render comparison, 0 diffs. |
| HX-10 | Bidirectional synchronization | implemented | 350 ms state poll when open + command responses applied immediately + `showSeq` | Agent actions appear in open panes; UI commands are visible to tools on the next state read. |
| HX-11 | Display changes distinguished from analysis/source data | implemented | `classify.py` categories, `revByCategory`, dirty chips, split scripts | Verified: display-only save leaves `analysis.ffs` byte-identical. |
| HX-12 | FFS-style data sources | implemented | client `DataPicker`; sidecar `sources`/folders/catalog/preview/subjects | Add/remove/read/rescan folders, catalog preview+load, persistent subjects; no demo at launch. |
| HX-16 | Card-based controls rail | implemented | `client.js` `ControlRail` | Collapsible cards, compact sliders, segmented controls, advanced disclosure, footer session actions. |
| HX-14 | Simplified floating-window manager | implemented | `client.js` `FloatingWorkspace` + `workspace.json` | Free movement + optional edge snap + resize; no layout menu, imposed grid, or window buttons. |
| HX-15 | Scientific semantics preserved (threshold/colormap/coordinate/surface sampling) | implemented | FFS core called directly; `verification/REPORT.md` checks 1–4 | Pixel-exact slices; 430 164 exact vertex colours; picking exact. |

## Core and session

| ID | Feature | Original behaviour / reference | Status | Harness location | Notes |
|---|---|---|---|---|---|
| CORE-01 | Headless viewer core | `ViewerSession` + `CommandBus` + `vocab.install`, no Qt (`viewer/__init__.py:1-9`, `viewer/session.py:289`) | implemented | `python/ffsviewer/server.py`, imports FFS core | The sidecar drives the real session; no reimplementation. |
| CORE-02 | Typed command bus; every mutation a recorded command | `viewer/commands.py:62-325` | implemented | `server.execute` (`python/ffsviewer/server.py:262-320`) parses with original `parse_line` | 114 commands validated; unknown/unclassified rejected with typed errors. |
| CORE-03 | Aspect-driven invalidation | `Aspect` flag per command, handlers return actual dirt (`viewer/commands.py:32-60`, `:309-325`) | implemented | `server.execute` returns `dirty`; `_render_cache` cleared; snapshot `revByCategory` | Categories drive revision chips and saved manifest. |
| CORE-04 | Command recording / replayable script | `bus.to_script`, collapse + major events (`viewer/commands.py:403-454`) | implemented | `python/ffsviewer/persist.py` writes `viewer.ffs` | Layout saved separately. |
| CORE-05 | Script replay on open (`-script`) | `cli/viewer.py:146-150`, `session.run_script` | partial | `persist.restore_state` replays saved `viewer.ffs` | Only the saved script can be replayed; no endpoint to submit an arbitrary script file (batch commands cover the common case). |
| CORE-06 | Pause on `major` events | `major_events()` declared and tested (`viewer/commands.py:420-423`, `tests/viewer/test_commands.py:302-315`) | out of scope | — | Not implemented upstream either (see inventory §14); no desktop replay UI to reproduce. |
| CORE-07 | Three-tier residency (disk/RAM/device) | `viewer/residency.py` | implemented | `ViewerSession.store`; `server._await_resident` | Demo waits for 4-D inflate so scrubbing/graph are immediately live. |
| CORE-08 | VRAM budget / device selection | `-vram_budget`, `-device` (`cli/viewer.py:199-207`) | partial | sidecar fixes `torch.device("cpu")` (`server.ensure_session`) | Deliberate for reproducible verification and background-thread safety; no harness configuration surface yet. |
| CORE-09 | Per-command timing (`FFS_VIEWER_TIMING`) | `viewer/commands.py:226-235`, `:336-364` | out of scope | — | Debug facility for the desktop app; sidecar can be profiled normally. |
| CORE-10 | Debug report (state + script) | `viewer/report.py:1-16` | partial | `ffs_viewer_state` tool + saved manifest | State is exposed; no single "write a debug report file" button. |

## Data, catalog and formats

| ID | Feature | Original behaviour / reference | Status | Harness location | Notes |
|---|---|---|---|---|---|
| DATA-01 | Read a directory into pickers | `READ`, `catalog.scan` (`viewer/vocab.py:475-485`, `viewer/catalog.py:397`) | implemented | `server.add_folder`/`read_folder` + client `DataPicker` | Persistent source-folder list with add/remove/rescan and the FFS catalog (kind, shape, TR, labels). |
| DATA-02 | Named-file catalog without scanning dirs | `READ_FILES` (`viewer/vocab.py:487-498`) | implemented | `server.add_files`, `ffs_viewer_load`; path field | Named files build a catalog without scanning their directory. |
| DATA-03 | One load verb, stack position decided later | `LOAD` (`viewer/vocab.py:498-517`; `viewer/layers.py:261-320`) | implemented | command bar / `open` paths / demo | Layers rail lists the stack; `SELECT_LAYER`, visibility, reorder via command. |
| DATA-04 | Replace/remove layers, legacy load verbs | `REMOVE_LAYER`, `SET_UNDERLAY`, `SET_OVERLAY`, `ADD_OVERLAY` | implemented | `server.execute` | Effects visible in panes/layers rail. |
| DATA-05 | Reload overwritten layer in place | `RELOAD_LAYER` (`viewer/vocab.py:1209-1230`) | implemented | `server.execute` | No rescan watcher UI. |
| DATA-06 | Preview picker (click previews, Enter loads) | `PreviewCombo`, `session.preview/commit_preview` (`viewer/ui/widgets.py:127-146`, `viewer/session.py:605-652`) | not started | — | Command bar's `LOAD` is the only load surface; agent tools can load. |
| DATA-07 | Directory favourites (XDG config) | `viewer/favorites.py:1-10` | not started | — | No directory UI. |
| DATA-08 | File/directory/subject drag-and-drop routing | `catalog.sort_dropped` (`viewer/catalog.py:186-232`), `viewer/ui/window.py:2524-2593` | not started | — | Browser DnD of tabs exists (layout), not of data. |
| DATA-09 | Supported volume formats (NIfTI/AFNI/FreeSurfer/GIFTI surface data) | `catalog.SUFFIXES` (`viewer/catalog.py:31-35`) | implemented | FFS loaders used by sidecar `LOAD` | Whatever the FFS core can open works through the sidecar; no suffix hints in UI. |
| DATA-10 | FreeSurfer subject surfaces / loose meshes / template space | `LOAD_SURFACES`, `LOAD_MESH`, `-surf_space` | implemented | `open` subject param; `LOAD_SURFACES`/`LOAD_MESH` via command bar | Template-space (`-surf_space`) has no harness toggle yet. |
| DATA-11 | Mesh list: multiple meshes per hemisphere, top-most in use | `viewer/meshlist.py`, `MeshWindow` | partial | mesh commands accepted; no mesh list UI | USE_MESH changes the active mesh and surface pane updates; no list/compare view. |

## Slice rendering and display semantics

| ID | Feature | Original behaviour / reference | Status | Harness location | Notes |
|---|---|---|---|---|---|
| IMG-01 | Cardinal slice panes (axial/sagittal/coronal) | `compose.render_viewport`, `render_plane` (`viewer/compose.py:140-397`) | implemented | `server.render`, client `SlicePane` | Default workspace opens three image panes. |
| IMG-02 | Arbitrary image windows, duplicates, plane change | `OPEN_VIEW`, `SET_VIEW_PLANE` (`viewer/vocab.py:162-199`) | implemented | client dock/tab tree | New image view ids, duplicate tab, split. |
| IMG-03 | Zoom (crop, no invented voxels) + pan | `PlaneView` (`viewer/slicing.py:99-249`) | implemented | client wheel/drag → `SET_ZOOM`/`SET_PAN` | Pan/zoom per viewport. |
| IMG-04 | Parked slices / unlock | `Viewport.position`, `SET_VIEW_POSITION` (`viewer/viewports.py:98-100`) | implemented | client settings popover; "PARKED" label | Core requirement met. |
| IMG-05 | LOCK: shared zoom centred on one mm point | `Viewport.zoom_linked`, `_sync_zoom_links` (`viewer/vocab.py:1612-1650`) | implemented | client `SET_VIEW_LOCKED * 1 1` | Both views zoom together; centre carried in mm. |
| IMG-06 | Solo and tile modes | `Viewport.solo/tiles`, `render_viewport`, `tile_layers` (`viewer/compose.py:366-397`) | implemented | client settings/commands | Tiles share slice/zoom/pan. |
| IMG-07 | Crosshair styles (lines/off/ring; 3-D lines/off/dot) | image window `x`; surface `x` | partial | client draws lines + dot only | No style cycle. |
| IMG-08 | Crosshair click / nudge / jump back | `SET_IJK`, `JUMP_BACK` | implemented | client click → pick → `SET_IJK`; ↶ button | No arrow-key nudge. |
| IMG-09 | Oblique/tilted slices | `SET_VIEW_TILT`, `view_grid`, `section_tilt` (`viewer/compose.py:293-347`) | implemented | server render honours viewport tilt; command bar | No tilt gestures (`t`, alt+arrows) or view row. |
| IMG-10 | Neighbour strip | `Viewport.strip`, `viewer/strip.py` | partial | `SET_VIEW_STRIP` accepted | Not rendered by the client. |
| IMG-11 | Surface outlines on slices, width, cycle | `SHOW_SURFACES`, `SET_OUTLINE_WIDTH`, `SurfaceStore.outlines` (`viewer/surfaces.py:456-506`) | partial | client draws outlines at fixed width; `SHOW_SURFACES` control | No width control; fixed 1 px in canvas. |
| IMG-12 | Readout at crosshair (value / threshold stat / region) | `layer_reading`, `overlay_readout` (`viewer/session.py:1325-1396`) | implemented | snapshot `readout.lines`; control rail | Shows first lines; atlas defaults used. |
| IMG-13 | Surface highlight/marks/paint drawn on panes | `viewer/ui/panes.py:504-633` | not started | — | No highlight or paint rendering. |
| IMG-14 | Colormap picker + reversal | `SET_COLORMAP`, `SET_COLORMAP_REVERSED` | implemented | control rail select; render | Same scale set, `redblue`, etc. |
| IMG-15 | Range min/max, autorange, mirror, fixed | `SET_RANGE`, `SET_RANGE_MIRROR`, `SET_RANGE_FIXED`; percentile auto-range (`viewer/session.py:50`, `:894-945`) | partial | rail numeric min/max; render honours all | No autorange/negative-tail/mirror/fixed controls; commands work. |
| IMG-16 | Threshold value, sub-brick, follow modes, p coupling | `SET_THRESHOLD`, `SET_THRESHOLD_INDEX`, `SET_THRESHOLD_FOLLOW`, `threshold_p` (`viewer/vocab.py:1457-1521`, `:1722-1760`) | implemented | rail OLAY/THR ON selects, follow same/+1/+2/fixed, threshold on/off slider | p-value entry remains command-level; core semantics preserved. |
| IMG-17 | Sign mode | `SET_SIGN` (`viewer/layers.py:23-29`) | implemented | rail select | |
| IMG-18 | Sub-threshold alpha fade | `SET_ALPHA` (`viewer/colormap.py:224-272`) | implemented | rail select | |
| IMG-19 | Boxed suprathreshold outlines | `SET_BOXED` (`viewer/compose.py:44`, `:281-288`) | implemented | rail checkbox | |
| IMG-20 | Edges layer mode | `SET_EDGES` (`viewer/compose.py:94-138`) | implemented | render honours; command bar | No rail control. |
| IMG-21 | Resample auto/nearest/linear/cubic | `SET_RESAMPLE`, `session.resample_mode` (`viewer/session.py:1202-1235`) | implemented | render honours; command bar | No DRAW control. |
| IMG-22 | Display grid resolution (mm), grid picker | `SET_GRID_RES`, `resize_grid` (`viewer/state.py:70-140`) | implemented | render honours; command bar | No GRID picker; crosshair carried in mm by the handler. |
| IMG-23 | Layer opacity / visibility / stack order | `SET_LAYER_OPACITY`, `SET_LAYER_VISIBLE`, `MOVE_LAYER` | implemented | rail opacity + tick; command for order | Drag reorder not implemented. |
| IMG-24 | Layer world transform / followers | `SET_LAYER_XFORM`, `SET_LAYER_FOLLOWS`, `viewer/align.py` | implemented | command bar; render honours | No align-mode gestures. |
| IMG-25 | ROI/label layers (identity colours, region names, nearest sampling) | `Layer.roi`, `SET_LAYER_ROI`, `apply_label_colors`, `label_edges` | implemented | render honours; readout names | No "is ROIs" control. |
| IMG-26 | Time view: detrend and percent signal change | `SET_LAYER_TIME_VIEW`, `viewer/timeview.py` | implemented | render honours; command bar | No TIME control. |
| IMG-27 | Theme (dark/light palette is state) | `SET_THEME`, `viewer/ui/theme.py:1-25` | partial | `SET_THEME` accepted; snapshot carries theme | Client has one dark style; no light palette/toggle. |
| IMG-28 | Composites, NaN transparency, opacity | `colormap.composite`, `threshold_alpha` NaNs | implemented | server render via `compose.render_plane` | Pixel output comes from FFS, not reimplemented. |

## Windows / view kinds

Ten FFS `ViewKind`s (`viewer/viewports.py:58-69`). The harness uses the same
kinds in its layout tree (`client.js:39`, `:175-188`), but only three have a
renderer at this revision.

| ID | ViewKind | Original window (class) | Status | Harness location | Notes |
|---|---|---|---|---|---|
| VK-01 | `image` | `ImageWindow` | implemented | `client.js` `SlicePane`; `server.render` | Multi-plane, per-viewport settings, parked/locked, zoom/pan. |
| VK-02 | `graph` | `GraphWindow` (voxel grid) | implemented | `client.js` `SeriesPane`; `server.series` | N×N grid, click-to-scrub, hide lines, shared scale, tint; no design regressors/legend subtleties. |
| VK-03 | `surface` | `SurfaceWindow` (3-D) | implemented | `client.js` WebGL2 pane; `server.surface`, `surface_pick` | FFS geometry/sampling/colouring; Flatten/Inflated button (requires `?h.*.patch.3d`), shape/depth/equivolume/folding; picking via FFS ray cast; no surface editing/highlight painting. |
| VK-04 | `carpet` | `CarpetWindow` | not started | — | View can be opened; no renderer. |
| VK-05 | `matrix` | `MatrixWindow` | not started | — | View can be opened; no renderer. |
| VK-06 | `clusters` | `ClusterWindow` | not started | — | View can be opened; no table/clusterize surface. |
| VK-07 | `trace` | `TraceWindow` | not started | — | Mode panels have no window. |
| VK-08 | `profile` | `ProfileWindow` | not started | — | Profile column not built. |
| VK-09 | `depth` | `DepthWindow` | not started | — | Laminar depth profiles not built. |
| VK-10 | `chedi` | `ChediWindow` | not started | — | Flattened patch view not built. |

## Controller, windows, UI chrome

| ID | Feature | Original behaviour / reference | Status | Harness location | Notes |
|---|---|---|---|---|---|
| UI-01 | Separate top-level companion windows (no docking) | `viewer/ui/manager.py:1-14`; all 10 companions top-level | out of scope | — | Deliberately replaced by one dock/tab workspace (DETAIL.md). |
| UI-02 | Window manager placement, tiling, stagger, raise | `viewer/ui/manager.py:485-640` | out of scope | browser dock tree instead | Browser layout (splits/tabs/sizes) is persisted in `workspace.json`. |
| UI-03 | Per-window geometry in session state | `SET_VIEW_GEOMETRY` (`viewer/viewports.py:243-244`) | out of scope | `workspace.json` | Layout is separate from scientific state. |
| UI-04 | Controllers A/B/C tabs, mm-linked crosshair + time | `viewer/ui/window.py:24-34`, `:419-470`, `_build_selector` | not started | — | Single workspace; no second controller. |
| UI-05 | Controller panel: layer stack + selection + readout | `viewer/ui/window.py:1521-1740` | implemented | control rail Layers / Display | Simpler than the original form. |
| UI-06 | Data picker/LOAD row, directory row, rescan | `viewer/ui/window.py:560-720` | partial | command bar `LOAD`; `open` paths | No pickers. |
| UI-07 | Mode picker + generic mode parameter panel | `viewer/ui/window.py:699-806`, `viewer/ui/controls.py` | partial | snapshot mode name; `SET_MODE`/`SET_MODE_PARAM` via command bar | No rendered mode form. |
| UI-08 | Mode action buttons (KEEP/APPLY/next/prev…) | `Mode.actions`, `MODE_ACTION` | partial | `MODE_ACTION` via command bar/agent | Preproc tool dialogs cannot run (writer/ToolDialog absent). |
| UI-09 | Colour bar with min/threshold/max on the bar | `viewer/ui/colorbar.py:52`, `:277` | partial | rail numeric fields + slider | No LUT legend/gradient bar, no p-value spinner, no autorange buttons. |
| UI-10 | Shortcut help (`h`) and per-window key tables | `viewer/ui/shortcuts.py:1-9`, `:276-355` | out of scope | — | Browser keyboard model; command bar has history. Lead may add a help panel later. |
| UI-11 | Keyboard shortcuts (main/image/graph/3-D/etc.) | `docs/FEATURE_INVENTORY.md` §10 | not started | — | No global key map; only browser-local interactions. |
| UI-12 | Mouse gestures (crosshair click, drag pan, wheel zoom) | `viewer/ui/panes.py:732-923` | partial | `SlicePane` click/pan/wheel | Wheel = zoom (original: wheel = slice; right-drag = zoom). Divergence to confirm with lead. |
| UI-13 | Mouse gestures: surface rotate/pick, paint, editing | `viewer/ui/surfacewindow.py:874-1070` | partial | WebGL orbit + picking | No paint/edit gestures. |
| UI-14 | Theme toggle d/button | `viewer/ui/window.py` (`d`, theme button) | not started | — | dark-only UI. |
| UI-15 | Debug button / launch-command copy (ctrl+P) | `viewer/ui/window.py:2179-2190`, `:2483-2508` | not started | state tool + manifest substitute | No clipboard command line. |
| UI-16 | Status bar (VRAM, progress, messages) | `viewer/ui/window.py:2594-2670` | partial | snapshot `loading`, notices | No VRAM/progress bar; long loads block the request. |
| UI-17 | Mesh window | `MeshWindow` (`viewer/ui/meshwindow.py:32`) | not started | — | Commands only. |
| UI-18 | Vertex graph window | `VertexGraphWindow` (`viewer/ui/vertexgraph.py:107`) | not started | — | — |
| UI-19 | Modal dialogs: help, tool form, band split, combo picker | `viewer/ui/shortcuts.py:276`, `viewer/ui/tooldialog.py:28`, `viewer/ui/bandsplit.py:268`, `viewer/ui/widgets.py:147` | out of scope | — | Desktop Qt dialogs; the sidecar/agent route replaces the tool form only partially (see MODE-13). |
| UI-20 | Overview minimap / hover tooltips | original surfaces/windows have various | not started | — | Not tracked as a required feature by the brief. |

## Modes and analysis

| ID | Feature | Original behaviour / reference | Status | Harness location | Notes |
|---|---|---|---|---|---|
| MODE-01 | Mode registry and selector (11 shown, 12 registered) | `viewer/modes/__init__.py`, `viewer/modes/base.py:757-785` | implemented | sidecar owns `session.mode`; snapshot `mode.name`; `SET_MODE` | Selection works; no picker control. |
| MODE-02 | Generic declarative controls (spans, visible_when, path lists) | `viewer/modes/base.py:86-330`, `viewer/ui/controls.py` | partial | command bar accepts `SET_MODE_PARAM name value` | No generated form. |
| MODE-03 | Mode output as a live layer, replaced in place; KEEP copies | `viewer/modes/base.py:24-38`, `:443-451`; `session.keep_output` | implemented | render/stack + `MODE_ACTION keep` | Output naming (`A_ICORR`) preserved by core. |
| MODE-04 | Mode input independent of drawn/selected | `SET_INPUT`, `session.input_layer` (`viewer/session.py:1237-1279`) | implemented | command bar/agent; snapshot `inputKey` | No INPUT picker; semantics preserved. |
| MODE-05 | Gated prep (`live`/GO) and worker preparation | `viewer/modes/base.py:447-565`, `viewer/ui/work.py` | partial | sidecar executes actions inline | No worker/defer surface; long preparations block the request (timeout risk). |
| MODE-06 | Mode trace panels (timecourse, spectrum, scree, HRF, RGB channels/axes) | `panel_names`, `panels` per mode | not started | — | No trace windows. |
| MODE-07 | Plain mode (no computation) | `viewer/modes/plain.py:15` | implemented | sidecar default mode | |
| MODE-08 | Align mode (manual transform, attach/followers, .aff12 bridge) | `viewer/modes/align.py:65`; `viewer/align.py` | partial | `SET_LAYER_XFORM/FOLLOWS` work; no drag/tool dialog | Allineate action not wired. |
| MODE-09 | Denoise mode (nuisance projection, VR map) | `viewer/modes/denoise.py:40`; `DENOISE` | implemented | `DENOISE`/`MODE_ACTION apply` | Derived layer visible in stack/panes. |
| MODE-10 | InstaCorr (seed correlation) | `viewer/modes/instacorr.py:45`; `SET_SEED` | implemented | `SET_MODE instacorr`, `SET_SEED`, params | Prepared in sidecar; seed button in rail; no review traces. |
| MODE-11 | InstaGLM (fit + show/thresh maps + HRF panel) | `viewer/modes/instaglm.py:87` | partial | commands accepted; fit runs inline | HRF trace panel missing; long fit may block. |
| MODE-12 | InstaICA / InstaPCA review loops, SAVE NOISE ortvec | `viewer/modes/instaica.py:28`, `viewer/modes/instapca.py:63` | partial | commands accepted; inline compute | No trace windows or review keys; ortvec save works via agent/command. |
| MODE-13 | ICA folder review (MELODIC folder) | `viewer/modes/ica.py:72` | partial | `SET_MODE ica` + `SET_MODE_PARAM folder …` | No folder dialog; no review window. |
| MODE-14 | Paint mode (integer-label ROIs) | `viewer/modes/paint.py:47`, `viewer/paintlayer.py` | partial | `NEW_PAINT_LAYER`/`PAINT_STROKE` accepted; ROI layers render | No painting gestures; agent can paint programmatically. |
| MODE-15 | RGB mode (echoes/contrast, chroma, Oklab, contrast optimiser) | `viewer/modes/rgb.py:123`, `viewer/chroma.py`, `viewer/contrast.py` | partial | commands accepted; colour layers render (`chromalayer.render` used by compose) | No RGB panel/channel picker; setup only via commands. |
| MODE-16 | tCorr mode (voxel-to-voxel correlation) | `viewer/modes/tcorr.py:47` | partial | commands accepted; overlay renders | No panel; GO via `MODE_ACTION`. |
| MODE-17 | Preproc tools: MOCO / SLICETIME / SMOOTH | `viewer/modes/preproc.py`, `viewer/tools/*` | not started | — | Tool dialogs and workers absent; actions cannot run (they need `DialogSpec.run`). |
| MODE-18 | LayNii depth-volume export from on-screen surfaces | `viewer/layerexport.py`; `ctrl+shift+L` | not started | — | No export UI; could be an agent tool later. |

## Surface pipeline

| ID | Feature | Original behaviour / reference | Status | Harness location | Notes |
|---|---|---|---|---|---|
| SURF-01 | Load subject surfaces, RAS placement, outline on slices | `LOAD_SURFACES`, `SurfaceStore.load`, `outlines` (`viewer/surfaces.py:351-506`) | implemented | `open subject`, `LOAD_SURFACES`; client outlines | No subject picker dialog. |
| SURF-02 | Loose mesh files, hemisphere/kind inference, stand-ins | `LOAD_MESH`, `meshlist.infer_label` | partial | commands accepted | No mesh list window; inference happens in CLI not sidecar (sidecar command requires explicit hemi/kind). |
| SURF-03 | Template space via sphere.reg (view-only) | `-surf_space`, `SurfaceStore.place_data` | not started | — | No toggle. |
| SURF-04 | Per-vertex results as layers, sibling hemispheres, fingerprint matching, template mapping | `-surf_data`, `surface:…` layers (`viewer/surfaces.py:191-285`, `viewer/surfacelayers.py`) | partial | `LOAD <path.func.gii>` after mesh via command bar; renders | No surf-data CLI surface; mapping logic in core. |
| SURF-05 | 3-D shapes (mid/white/pial/inflated/sphere/flat), layout, split, hinge | `SHAPE`/`SET_SURFACE_SHAPE`, `layout_offsets`, `hemisphere_models` (`viewer/surface3d.py:31-170`) | implemented | client surface pane + controls | Inflation/flat layout driven by FFS CPU functions. |
| SURF-06 | Depth sampling between white and pial in the shader (own-resolution data on any mesh) | `viewer/surface3d.py:1-18`, `shaders/surface.frag` | implemented | client samples via `surface.profiles.sample_depths` + `reduce_depth` | Uses CPU sampling rather than the GLSL shader; same FFS functions/equivolume semantics (`surface_ops.py`). |
| SURF-07 | Equivolume (Waehnert) depth vs equidistant | `SET_SURFACE_EQUIVOLUME`, `equivolume_fraction` | implemented | control in surface settings | |
| SURF-08 | Depth window (lo/hi/samples) and 6 depth statistics | `SET_SURFACE_DEPTH`, `SET_SURFACE_DEPTH_STAT` | implemented | client depth sliders + stat select | Same 6 statistics via `reduce_depth`. |
| SURF-09 | Folding shade (curv/sulc/binary/off) and per-vertex maps (thickness/sulc/curv/annot/flags) | `SET_SURFACE_FOLDING`, `SET_SURFACE_MAP`, `vertex_colors` | implemented | client settings; `surface_ops._base_shade/vertex_colors` | `flags` (profile QC) map has no source window, so it renders empty. |
| SURF-10 | Up-to-4 overlay layers composited on the surface, same colour/threshold semantics | `pack_uniforms`, `surface.frag`, `layer_rgba` | implemented | `surface_ops.vertex_colors` + client shader | Confirmed parity approach: FFS CPU colouring (`surfacelayers.layer_rgba`) is used. |
| SURF-11 | Picking (ray→triangle, barycentric→vertex), crosshair/seed on click | `surface3d.pick`, `Camera.ray` | implemented | `server.surface_pick`; client click | Picking is server-side (per DETAIL.md). |
| SURF-12 | Surface outlines on slices with cycle (both/white/pial/off) and width | `SHOW_SURFACES`, `SET_OUTLINE_WIDTH`, `next_outlines` | partial | control cycles shown set; fixed width | No width control; client doesn't draw smoothwm/extra meshes. |
| SURF-13 | Surface editing: grab/draw/point/nudge, brush, snapping, undo | `EDIT_SURFACE*`, `SET_SURFACE_*`, `SurfaceStore` edit API | partial | commands accepted; server surface cache keys on mesh revision | No edit gestures/brush UI; agent could issue `EDIT_SURFACE` with gestures. |
| SURF-14 | Topology edits (delete vertex, split edge) | `DELETE_SURFACE_VERTEX`, `SPLIT_SURFACE_EDGE` | partial | commands accepted | No point tool; effects would update the surface pane if issued. |
| SURF-15 | Highlight/mark cortex (shared selection), move along normals, ROI from highlight | `HIGHLIGHT_SURFACE`, `MOVE_SURFACE_HIGHLIGHT`, `HIGHLIGHT_TO_ROI` | partial | commands accepted | Not drawn in surface pane or slices. |
| SURF-16 | Save/install edited surfaces with backups; edit log | `SAVE_SURFACES`, `SurfaceStore.install_plan/install` | partial | `SAVE_SURFACES` command writes files | No dialog/install flow. |
| SURF-17 | Surface ROI label save/load | `SAVE_SURFACE_ROI`, `LOAD_SURFACE_ROI` | partial | commands accepted | Highlight not surfaced. |
| SURF-18 | Surface clusterization (mesh areas, SurfClustSim) | `surface_clusterize` (`viewer/surfacelayers.py:176-290`) | not started | — | No cluster window. |
| SURF-19 | CHEDI flattened patch (depth 0–1 and past both ends, push, clusters) | `viewer/ui/chediwindow.py`, `viewer/chedi.py` | not started | — | View kind exists, no renderer. |
| SURF-20 | Depth profiles over a region (disc/annot/layer), depth×time, export, pin | `viewer/ui/depthwindow.py`, `viewer/surface/profiles` | not started | — | — |
| SURF-21 | Ribbon profile QC column (profiles, ordering, flags, click-to-vertex) | `viewer/ui/profilewindow.py`, `surface/profiles.py:297-414` | not started | — | — |
| SURF-22 | Vertex graph on a flattened patch | `viewer/ui/vertexgraph.py`, `viewer/vertexpatch.py` | not started | — | — |

## Graph / carpet / matrix / clusters / time

| ID | Feature | Original behaviour / reference | Status | Harness location | Notes |
|---|---|---|---|---|---|
| TIME-01 | Graph grid N×N around crosshair (1–16, stepped) | `Viewport.grid_n`, `viewer/ui/gridgraph.py` | implemented | client series pane + `SET_VIEW_GRID` | |
| TIME-02 | Which layers a graph plots / hides / tints / shared scale | `SET_VIEW_TRACES/HIDDEN/TINT/SHARED_SCALE`, `session.traces_for` | implemented | client legend + settings | Design regressors not plotted. |
| TIME-03 | Time stepping / scrubbing / play | `SET_INDEX`, `player.py`, `SetIndex` | partial | click-to-scrub, slider, keys none | No play/pause; time step via command bar. |
| TIME-04 | Frame step: `,`/`.` time or a non-time layer's sub-bricks (Coef groups) | `session.frame_step`, `brick_stops` | partial | `SET_INDEX`/`SET_VOLUME` commands | No key bindings. |
| TIME-05 | Design regressors in graphs from HISTORY_NOTE/xmat | `viewer/design.py` | not started | — | |
| TIME-06 | Carpet (grayplot): ordering, detrend, scaling, click row, drag→overlay | `viewer/carpet.py`, `viewer/ui/carpetwindow.py` | not started | — | |
| TIME-07 | Correlation matrix: ROI nodes or moving voxel bins, 5 orders, click pair | `viewer/matrix.py`, `viewer/ui/matrixwindow.py` | not started | — | |
| TIME-08 | Cluster window: NN1-3, min size/ClustSim alpha, hide small, within-mask, peak jump, MAKE ROIS | `viewer/clusters.py`, `viewer/ui/clusterwindow.py` | not started | — | Cluster table is core code, ready to be surfaced. |
| TIME-09 | Trace windows and review loop (step/label/save noise) | `viewer/ui/tracewindow.py`, modes' panels | not started | — | |

## Persistence, scripting, packaging

| ID | Feature | Original behaviour / reference | Status | Harness location | Notes |
|---|---|---|---|---|---|
| PERS-01 | Save session script (ctrl+S) | `to_script`, `save_script` (`viewer/session.py:1980-2041`) | implemented | `persist.save` writes `viewer.ffs`; Save button | Includes header/manifest. |
| PERS-02 | Reopen command line (ctrl+P) | `session.launch_command` (`viewer/session.py:1983-2036`) | not started | manifest records sources | No printable/copyable launch command. |
| PERS-03 | Workspace layout persistence (browser docks/tabs/sizes) | Original: viewport geometry in script | implemented | `workspace.json` via `workspace` endpoint; client auto-save | Deliberately separate from science state. |
| PERS-04 | Restore last session at startup | `-script`, `open` restore | implemented | `open {preset:"restore"}`; autosave | |
| PERS-05 | Display / analysis / source revision separation | `Aspect` categories; no saved-manifest concept upstream | implemented | `revByCategory`, `manifest.json`, category chips | Product requirement of the rebuild; original has aspects only. |
| PERS-06 | Data-resolution/memory warnings, loading state | sidecar `loading`, autosave debounce | implemented | snapshot `loading`; `_await_resident` | |
| PERS-07 | Harness agent tools (command/state/load/sources/workspace/show/render/save/debug/parity) | — (new) | implemented | `ffs-harness-viewer/index.js` | Ten tools; the sources tool owns the same folder/catalog/subject operations as the picker. |
| PERS-08 | Transport: browser↔Host RPC, Host↔sidecar NDJSON | — (new) | implemented | `docs/API.md`; `index.js` `Sidecar` | JSON-safe snapshots; typed errors. |
| PERS-09 | Demo dataset + subject | — (new) | implemented | `scripts/build_demo_data.py`, `data/demo/` | Deterministic anat/func/stats + FreeSurfer subject + task regressor; sidecar loads it on first open and degrades to a notice if absent. |
| PERS-10 | Rendered screenshot export | Original: no dedicated feature (panes only) | implemented | `ffs_viewer_render`, `server.render` PNG | New capability, useful for verification. |

## The 10 ViewKinds and the command vocabulary — status as a list

The 10 ViewKinds are in the table above (VK-01…VK-10): **3 implemented, 7 not
started**.

All **114** registered commands (not ~98 — see inventory §14) are accepted,
validated and dispatched by the sidecar through the original `parse_line` +
`CommandBus`. The table below is the command-level status under the definition
above: `implemented` means the effect is visible through a pane/control/state/
file surface; `partial` means the command works but its feature has no harness
surface yet (carpet/matrix/cluster/trace/profile/depth/chedi panes, paint/edit
gestures, pickers); `out of scope` is used where the Harness architecture
replaces the command's desktop-only purpose. Category is from
`docs/COMMAND_REFERENCE.md` (reconcile with `python/ffsviewer/classify.py`, see
the note above).

| ID | Command | Category | Status | Notes |
|---|---|---|---|---|
| CMD-001 | `SET_IJK` | navigation | implemented | crosshair moves panes |
| CMD-002 | `SET_XYZ` | navigation | implemented | mm → display grid |
| CMD-003 | `JUMP_BACK` | navigation | implemented | ↩ button |
| CMD-004 | `SET_INDEX` | navigation | implemented | time slider / graph scrub |
| CMD-005 | `OPEN_VIEW` | navigation | partial | image/graph/surface render; other kinds are tabs with no renderer |
| CMD-006 | `CLOSE_VIEW` | navigation | implemented | tab close |
| CMD-007 | `SET_VIEW_PLANE` | navigation | implemented | image pane re-renders |
| CMD-008 | `SET_VIEW_LOCKED` | navigation | implemented | locked/zoom-linked chips |
| CMD-009 | `SET_VIEW_POSITION` | navigation | implemented | parked slice control |
| CMD-010 | `SET_VIEW_GEOMETRY` | navigation | out of scope | browser workspace layout replaces it |
| CMD-011 | `SET_VIEW_TILT` | navigation | implemented | render honours oblique tilt; no gesture |
| CMD-012 | `SET_VIEW_STRIP` | navigation | partial | strip not drawn |
| CMD-013 | `SET_ZOOM` | navigation | implemented | wheel/drag |
| CMD-014 | `SET_PAN` | navigation | implemented | drag |
| CMD-015 | `SET_TIME_LINKED` | navigation | partial | state only; no control |
| CMD-016 | `SET_VIEW_SOLO` | display | implemented | settings popover |
| CMD-017 | `SET_VIEW_TILES` | display | implemented | tiled panes |
| CMD-018 | `SET_VIEW_GRID` | display | implemented | graph cells stepper |
| CMD-019 | `SET_VIEW_TRACES` | display | implemented | graph layer selection |
| CMD-020 | `SET_VIEW_HIDDEN` | display | implemented | legend toggles |
| CMD-021 | `SET_VIEW_REGRESSORS` | display | partial | no design-regressor plotting |
| CMD-022 | `SET_VIEW_TINT` | display | implemented | graph tint toggle |
| CMD-023 | `SET_VIEW_SHARED_SCALE` | display | implemented | graph shared scale |
| CMD-024 | `SET_VIEW_PANEL` | display | partial | no trace windows |
| CMD-025 | `SET_VIEW_SCALING` | display | partial | carpet scaling; no carpet pane |
| CMD-026 | `SET_VIEW_DETREND` | display | implemented | graph detrend |
| CMD-027 | `SET_CARPET_ORDER` | display | partial | no carpet pane |
| CMD-028 | `SET_MATRIX_ORDER` | display | partial | no matrix pane |
| CMD-029 | `SET_VIEW_ROIS` | display | partial | no matrix pane |
| CMD-030 | `SET_VIEW_SAMPLING` | display | implemented | surface sampling control |
| CMD-031 | `SET_ATLAS` | display | implemented | readout region names |
| CMD-032 | `SET_OUTLINE_WIDTH` | display | partial | client draws 1 px |
| CMD-033 | `SHOW_SURFACES` | display | implemented | outlines select |
| CMD-034 | `SET_MESH` | display | partial | no mesh list UI |
| CMD-035 | `SET_SURFACE_SHAPE` | display | implemented | shape control |
| CMD-036 | `SET_SURFACE_DEPTH` | display | implemented | depth sliders |
| CMD-037 | `SET_SURFACE_DEPTH_STAT` | display | implemented | stat select |
| CMD-038 | `SET_SURFACE_EQUIVOLUME` | display | implemented | toggle |
| CMD-039 | `SET_SURFACE_MAP` | display | implemented | vertex map control |
| CMD-040 | `SET_SURFACE_FOLDING` | display | implemented | folding control |
| CMD-041 | `SET_SURFACE_HEMIS` | display | implemented | hemi toggles |
| CMD-042 | `SET_SURFACE_HINGE` | display | implemented | hinge control |
| CMD-043 | `SET_PATCH_SIZE` | display | partial | no CHEDI pane |
| CMD-044 | `SET_PATCH_LAYER` | display | partial | no CHEDI pane |
| CMD-045 | `SET_PATCH_OVERLAYS` | display | partial | no CHEDI pane |
| CMD-046 | `SET_DEPTH_VIEW` | display | partial | no depth pane |
| CMD-047 | `SET_PROFILE_VIEW` | display | partial | no profile pane |
| CMD-048 | `SELECT_LAYER` | display | implemented | layers rail |
| CMD-049 | `MOVE_LAYER` | display | implemented | command bar; render order changes |
| CMD-050 | `SET_LAYER_VISIBLE` | display | implemented | tick box |
| CMD-051 | `SET_LAYER_OPACITY` | display | implemented | rail slider |
| CMD-052 | `SET_LAYER_XFORM` | display | implemented | render honours affine |
| CMD-053 | `SET_LAYER_FOLLOWS` | display | implemented | follower transforms preserved |
| CMD-054 | `SET_VOLUME` | display | implemented | rail OLAY select; render honours sub-brick |
| CMD-055 | `SET_THRESHOLD_INDEX` | display | implemented | rail THR ON select; render honours threshold brick |
| CMD-056 | `SET_LAYER_ROI` | display | implemented | identity palette render |
| CMD-057 | `SET_COLORMAP` | display | implemented | rail select |
| CMD-058 | `SET_COLORMAP_REVERSED` | display | implemented | render honours |
| CMD-059 | `SET_PANES` | display | implemented | render honours |
| CMD-060 | `SET_SIGN` | display | implemented | rail select |
| CMD-061 | `SET_RANGE` | display | implemented | rail fields |
| CMD-062 | `SET_RANGE_MIRROR` | display | implemented | render/handler honours |
| CMD-063 | `SET_RANGE_FIXED` | display | implemented | handler honours |
| CMD-064 | `SET_THRESHOLD` | display | implemented | rail slider |
| CMD-065 | `SET_THRESHOLD_FOLLOW` | display | implemented | rail THR ON follow modes |
| CMD-066 | `SET_ALPHA` | display | implemented | rail select |
| CMD-067 | `SET_BOXED` | display | implemented | rail checkbox |
| CMD-068 | `SET_EDGES` | display | implemented | render honours; no control |
| CMD-069 | `SET_RESAMPLE` | display | implemented | render honours; no control |
| CMD-070 | `SET_GRID_RES` | display | implemented | render honours; no control |
| CMD-071 | `SET_LAYER_TIME_VIEW` | display | implemented | render honours; no control |
| CMD-072 | `SET_THEME` | display | partial | state only; client dark-only |
| CMD-073 | `READ` | source | partial | catalog not exposed |
| CMD-074 | `READ_FILES` | source | partial | catalog not exposed |
| CMD-075 | `LOAD` | source | implemented | command bar / open / agent |
| CMD-076 | `ADD_LAYER` | source | implemented | stack grows |
| CMD-077 | `RELOAD_LAYER` | source | implemented | re-reads and re-renders |
| CMD-078 | `REMOVE_LAYER` | source | implemented | stack shrinks |
| CMD-079 | `SET_UNDERLAY` | source | implemented | legacy load verb works |
| CMD-080 | `SET_OVERLAY` | source | implemented | legacy load verb works |
| CMD-081 | `ADD_OVERLAY` | source | implemented | legacy load verb works |
| CMD-082 | `LOAD_SURFACES` | source | implemented | open subject / command |
| CMD-083 | `LOAD_MESH` | source | implemented | surface pane updates |
| CMD-084 | `USE_MESH` | source | implemented | active mesh changes |
| CMD-085 | `REMOVE_MESH` | source | implemented | mesh goes |
| CMD-086 | `LOAD_SURFACE_ROI` | source | partial | highlight not drawn |
| CMD-087 | `SAVE_SURFACES` | source | implemented | writes files |
| CMD-088 | `SAVE_MESH` | source | implemented | writes file |
| CMD-089 | `SAVE_SURFACE_ROI` | source | implemented | writes label/volume |
| CMD-090 | `SET_MODE` | analysis | implemented | mode name + overlay |
| CMD-091 | `SET_MODE_PARAM` | analysis | implemented | parameter changes take effect |
| CMD-092 | `MODE_ACTION` | analysis | partial | KEEP/APPLY work; preproc tool actions need dialogs |
| CMD-093 | `SET_INPUT` | analysis | implemented | fit input changes |
| CMD-094 | `DENOISE` | analysis | implemented | derived layer |
| CMD-095 | `SET_SEED` | analysis | implemented | seed button |
| CMD-096 | `NEW_PAINT_LAYER` | analysis | partial | painted layer renders; no paint gesture UI |
| CMD-097 | `PAINT_STROKE` | analysis | partial | command works; no gesture UI |
| CMD-098 | `PAINT_UNDO` | analysis | partial | command works; no gesture UI |
| CMD-099 | `SET_SURFACE_EDITING` | analysis | partial | no edit mode |
| CMD-100 | `SET_SURFACE_TOOL` | analysis | partial | no point/grab/draw tools |
| CMD-101 | `SET_SURFACE_BRUSH` | analysis | partial | no brush UI |
| CMD-102 | `SET_SURFACE_SNAP_GATE` | analysis | partial | no brush UI |
| CMD-103 | `SET_SURFACE_STEP` | analysis | partial | no nudge UI |
| CMD-104 | `SET_SURFACE_FREE` | analysis | partial | no edit UI |
| CMD-105 | `SET_SURFACE_SNAP` | analysis | partial | no edit UI |
| CMD-106 | `EDIT_SURFACE` | analysis | partial | command works; no gesture UI |
| CMD-107 | `EDIT_SURFACE_STROKE` | analysis | partial | command works; no gesture UI |
| CMD-108 | `SELECT_SURFACE_VERTEX` | analysis | partial | no point tool |
| CMD-109 | `DELETE_SURFACE_VERTEX` | analysis | partial | command works; no point tool |
| CMD-110 | `SPLIT_SURFACE_EDGE` | analysis | partial | command works; no point tool |
| CMD-111 | `UNDO_SURFACE_EDIT` | analysis | partial | command works; no gesture UI |
| CMD-112 | `HIGHLIGHT_SURFACE` | analysis | partial | highlight not drawn |
| CMD-113 | `MOVE_SURFACE_HIGHLIGHT` | analysis | partial | no highlight UI |
| CMD-114 | `HIGHLIGHT_TO_ROI` | analysis | partial | highlight not surfaced |

## Highest-risk parity gaps for scientific fidelity

These are the places where the harness currently *looks* like the FFS viewer but
a scientist could be misled unless the gap stays visible:

1. **Threshold sub-brick semantics have no UI.** `SET_THRESHOLD_INDEX` and
   `SET_THRESHOLD_FOLLOW` (+1/+2 Coef-group stepping, p-preserving conversions)
   are correct in the sidecar, but the rail exposes only a value slider. Anyone
   reading a coefficient map through the UI cannot currently see or set which
   sub-brick is being cut on. Surface it with the THR ON row before claiming
   display parity.
2. **Auto-range/mirror/fixed are missing from the rail.** The sidecar re-derives
   percentile ranges and keeps a signed map symmetric only for balanced maps;
   the rail's numeric min/max bypasses that reasoning. Add AUTO/MIRROR/FIXED
   controls (and a proper colour bar legend) rather than leaving raw numbers as
   the only path.
3. **Carpet/matrix/cluster/profile/depth/chedi views are the analysis views.**
   Slice + surface alone cannot answer "what did this run do over time", "which
   regions covary", "would this cluster survive correction", or "where is my pial
   wrong". These are seven of the ten ViewKinds; treat them as the next block of
   parity work, not garnish.
4. **Graph design regressors and mode trace panels are absent**, so a GLM/ICA
   cannot be inspected the way the original makes possible. The engines run; the
   review surface does not.
5. **Surface edit brush/gestures are absent** even though the commands exist.
   Editing is a headline FFS feature; "commands work if the agent types them" is
   not parity for a human.
6. **Mode preparation is synchronous in the sidecar.** Original runs preparation
   on a worker (`viewer/ui/work.py`) because it is seconds. In the harness a
   multi-second prepare blocks the RPC; if it exceeds the bridge timeout the UI
   shows a failure for work that actually completed. Move mode prepare onto the
   sidecar's own thread/queue (or an async endpoint) before exposing InstaGLM /
   ICA / Denoise / preproc more prominently.
7. **Multi-controller comparison is gone.** One workspace cannot yet show
   subject A vs B with a linked crosshair; the original's controller tabs exist
   exactly for that. Decide rebuild (second workspace pane or tabs per
   controller) before claiming review workflows.
8. **Input/output file surfaces are thin.** READ/READ_FILES build a catalog with
   no picker, and preview/rescan/favourites are absent. The command bar can load
   a path, but discovering datasets is a core part of the original viewer.
9. **Statuses here are seeded, not audited against tests.** `tests/viewer/` (65
   files) is the executable spec; porting those assertions to the sidecar/host is
   the fastest way to move rows from `partial` to `implemented` honestly.
10. **The two category tables disagree (see above).** Until one is canonical,
    revision chips and the generated command reference tell different stories
    about what a command changes.

---

*Seeded from the harness checkout in this workspace (sidecar + host + client at
the time of writing) and the read-only FFS clone at
`995b7d23a7294dec0408479371dde0d486ba9487`. Update rows as the rebuild lands;
keep the five statuses exact so `ffs_viewer_parity` keeps counting.*
