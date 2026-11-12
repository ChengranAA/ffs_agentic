# FFS viewer — feature inventory (source-referenced)

**What this is.** An exhaustive inventory of the desktop fMRI viewer in the
`fastfuncstuff` project, written to drive a faithful rebuild of it as an
in-interface workspace for DeepSeek Harness. Every claim points at the read-only
clone at `reference/fastfuncstuff`. Nothing here is inferred from the upstream
README: behaviour statements are taken from the source (docstrings, dataclasses,
command handlers, UI wiring) and the file:line is given so the claim can be
checked.

**Source of truth.** `reference/fastfuncstuff` at commit
`995b7d23a7294dec0408479371dde0d486ba9487` (2026-11-12), package version
`0.1.0` (`pyproject.toml:7`). It was treated as read-only and was not modified.

**Path convention.** Unless stated otherwise, a citation such as
`viewer/vocab.py:1209` is relative to
`reference/fastfuncstuff/fastfuncstuff/`. Citations in `tests/` are relative to
`reference/fastfuncstuff/`.

**How the inventory was produced.** Direct reading of the viewer core
(`viewer/*.py`, ~27.7k lines including modes), the Qt shell
(`viewer/ui/*.py`, ~18.9k lines), the surface package
(`surface/*.py`, ~6.1k lines), and the surface/mode tests. The command
vocabulary was extracted mechanically by `scripts/extract_commands.py` into
[`docs/COMMAND_REFERENCE.md`](COMMAND_REFERENCE.md); its counts are quoted here
rather than retyped. Numeric parameters and mode/tool control defaults were
read from the live objects (import of `viewer.modes.registry` /
`viewer.tools.registry`, no GPU or display) and are reproduced exactly.

**Where the harness rebuild stands.** That is the subject of
[`docs/PARITY.md`](PARITY.md), not this file. This file describes the original
only.

**Ambiguities.** Genuinely uncertain or unimplemented-in-this-clone points are
collected in [§14](#14-ambiguities-and-unverified-details); they are marked
`(ambiguous)` at the point of first mention where practical.

---

## 0. Snapshot counts

| Thing | Count | Where |
|---|---|---|
| `ViewKind`s (window kinds) | **10** | `viewer/viewports.py:58` |
| Top-level window classes a user can open | **13** (see §2.4) | `viewer/ui/manager.py:59-73` plus mesh/vertex windows |
| Companion windows reconciled from viewports | 10 | `viewer/ui/manager.py:59-73` |
| Modal/dialog window types | 4 (see §2.5) | help, tool, band split, combo picker |
| Modes in the selector | **12** registered, **11** shown in the MODE picker | `viewer/modes/__init__.py:1-50`, `in_selector` flag |
| Preproc tools (buttons inside Preproc) | **3** | `viewer/tools/__init__.py:1-20` |
| Commands on the bus | **114** (26 major) | `viewer/vocab.py`, generated reference |
| — by category (documented taxonomy) | source **17**, analysis **16**, display **65**, navigation **16** | `docs/COMMAND_REFERENCE.md#summary` |
| Colour scales offered by name | 17 ordered + all others alphabetically | `viewer/colormap.py:103` |
| Surface shapes | 6 (`mid`, `white`, `pial`, `inflated`, `sphere`, `flat`) | `viewer/surface3d.py:31` |
| Depth statistics | 6 | `viewer/surface3d.py:751` |
| Profile QC flags | 6 | `surface/profiles.py:297` |
| Viewer test files | **65** | `tests/viewer/test_*.py` |

---

## 1. Architecture

### 1.1 Headless core, thin Qt shell

The viewer is explicitly split into a headless core (state, commands, loading,
residency, colour mapping, slicing, surface sampling) and a thin UI shell, so
the core is testable without a display and recorded sessions replay without the
GUI (`viewer/__init__.py:1-9`). The package re-exports the stable core API
(`ViewerSession`, `ViewerState`, `CommandBus`, `Command`, `Aspect`, `Layer`,
`LayerStack`, `SignMode`, `AlphaMode`, `ViewKind`, `Viewport`, `ViewportSet`,
`DisplayGrid`, `Plane`, colour helpers, `extract_plane`, `parse_script`, … —
`viewer/__init__.py:11-66`). The Qt shell is import-guarded
(`viewer/ui/__init__.py:1`).

Three consequences that matter for a rebuild:

1. **Everything is a command.** The UI never mutates state directly; a click, a
   keystroke and a line of a replayed script all arrive as the same `Command`
   object (`viewer/commands.py:1-14`, `viewer/ui/window.py:1-14`).
2. **The viewport list is the truth.** Windows are a projection of
   `ViewerState.viewports`; opening/closing is `OPEN_VIEW`/`CLOSE_VIEW` and
   `WindowManager` reconciles the screen (`viewer/ui/manager.py:1-14`).
3. **Rendering is out of the UI.** `viewer/compose.py` turns state into
   `(H, W, 4)` `PaneImage`s with no Qt, which is what lets screenshots, montages
   and tests share the screen's code path (`viewer/compose.py:1-12`).

### 1.2 The command bus

- `Command` is a frozen dataclass carrying only plain scalars and homogeneous
  tuples of scalars, so a session round-trips through text
  (`viewer/commands.py:62-90`). `to_args()`/`to_line()` produce a script line
  (`:77`, `:84`).
- Commands are registered by `@command` under a class-level `name`
  (`viewer/commands.py:92-108`); `resolve`/`registered_names` look them up
  (`:110`, `:118`). Registration is mandatory — an unregistered command cannot
  be replayed.
- Script encoding is AFNI-flavoured: one command per line, positional
  arguments; `bool` → `1`/`0`, `None` → `-`, `shlex` quoting, `#` comments
  (`viewer/commands.py:134-223`). Parsing is `parse_line`/`parse_script`
  (`:196`, `:205`).
- `Aspect` (`IntFlag`) is what a command invalidates: `NOTHING`, `CROSSHAIR`,
  `SLICES`, `COLORMAP`, `THRESHOLD`, `LAYERS`, `TIME`, `GRAPH`, `GRID`,
  `VIEWPORTS`, `THEME`, `ALL` (`viewer/commands.py:32-60`). Handlers return the
  aspects they actually dirtied, which may be narrower than declared
  (`viewer/commands.py:238-245`).
- `CommandBus.dispatch` applies the handler, records the command when recording
  is on, then notifies listeners; listeners must not dispatch
  (`viewer/commands.py:309-325`, `:293`). `record(cmd)` exists for work done on a
  worker that is installed already-computed (`:366`).
- Recording: `to_script()` collapses consecutive runs of the *same* non-major
  command aimed at the same target (target = fields named `key`, `view`,
  `which`, `name`, `param`; `_target` at `:425`, `_collapse` at `:442`), inserts
  a blank line before each `major` command, and writes a replayable script
  (`:403-418`). `major_events()` returns the commands a replay "should be able
  to pause on" (`:420-423`). **Note:** in this clone `major_events()` has no
  caller in the UI or CLI — the pause behaviour is declared and tested
  (`tests/viewer/test_commands.py:302-315`) but not implemented; see §14.
- `FFS_VIEWER_TIMING` turns on per-command latency logging: `=1` (or
  `=<ms>`) prints slow commands live and a per-command median/p95/max table at
  exit (`viewer/commands.py:226-235`, `:336-364`).

### 1.3 Session, state, residency, catalog

- `ViewerSession` owns `ViewerState`, the `VolumeStore` (residency) and the
  `CommandBus`, and is the only entry point above the core: everything goes
  through `session.do(Command)` (`viewer/session.py:1-10`, `:289`).
- `ViewerState` holds the layer stack, one `DisplayGrid`, the crosshair, time
  index, viewports, selection/input keys, display grid size, InstaCorr seed,
  theme, and all surface display scalars (`viewer/state.py:142-221`).
- Residency is a three-tier store (disk → CPU RAM → compute device) with a
  configurable device budget; only what is being touched is promoted
  (`viewer/residency.py:1-28`, `:68`, `:239`).
- `catalog.py` indexes a directory from headers only — cheap enough to populate
  the pickers eagerly (`viewer/catalog.py:1-10`), classifies datasets as
  anat/func/stats/mask/other (`:38-106`), and rescans on change (`:325`).
- Dependencies: numpy, torch (`grid_sample`, colour math), scipy (stat
  conversions, profiles), PySide6 for the UI. The CLI resolves a device
  (`auto`/`cpu`/`cuda,N`), applies a VRAM budget, and hand off either to the
  headless replay path or to `viewer.ui.window.launch`
  (`cli/viewer.py:1-19`, `:276-340`).

---

## 2. Windows and view kinds

### 2.1 The controller (main window)

`ViewerWindow` (`viewer/ui/window.py:186`) is a single `QMainWindow` used as a
*controller*, not a display: it holds "the things there is exactly one of — what
is loaded, what the stack looks like, how the selected layer is coloured, and
what the mode is doing", and it "holds no brain"
(`viewer/ui/window.py:1-34`). Its chrome is built from toolbars plus one
scrollable central panel (`:1521-1899`):

- **Controller tabs** (top toolbar): one tab per controller letter from
  `ABCDEFGHIJ` (`viewer/ui/window.py:159`, `_build_selector` `:499-548`), `+`
  (`ctrl+T`) adds a controller, and a `linked` checkbox makes controllers follow
  one crosshair in **millimetres** and one time index (`:499-550`, `:419-470`).
- **READ** (`ctrl+O`), **RESCAN**, **SURF**, **ICA**, then `3D` / `DEPTH` / `QC` /
  `CHEDI` / `MESH` buttons, then `DEBUG` (`:571-628`).
- **DIR** row: directories this session read/loaded, plus favourites (★);
  picking one re-reads it (`:636-696`).
- **DATA** row: one `PreviewCombo` dataset picker and **LOAD** (`ctrl+L`).
  Picking an item *previews* it as a layer; only a double-click/Enter loads
  (`:676-720`; `viewer/ui/widgets.py:127-146`; `tests/viewer/test_picker_preview.py`).
  There is deliberately only one load verb and no underlay/overlay kind at load
  time; position/visibility/input are decided afterwards (`:1-20`, `:684-706`).
- **Window bar** (`:699-806`): `MODE` picker, `GRID` (display voxel size),
  `+IMAGE`/`+GRAPH`/`+CARPET`/`+MATRIX`/`+CLUSTERS`, `TILE`/`STACK`/`RAISE`,
  `CMD` (print reopen command), a theme toggle showing the palette you would
  switch *to*, a time spinner and a time label. A wrapping flow layout is used
  because the row is wider than the 430-pixel controller
  (`viewer/ui/flow.py:1-10`).
- **Panel** (`:1521-1899`): layer list with drag-reorder, check boxes for
  visibility, per-layer values at the crosshair, and `LOWER`/`RAISE`/`UNDERLAY`/
  `DROP`/`SAVE`; layer form with OLAY sub-brick, THR ON sub-brick + `same`/`+1`/
  `+2` follow checks, COLOR, SIGN, ALPHA (`linear`/`quadratic`), DRAW
  (auto/nearest/linear/cubic), TIME (detrend + `PSC`); the colour bar
  (`RANGE`, threshold, autorange, reverse, mirror, fixed); OPACITY; `boxed`;
  `edges`; `is ROIs`; `follows time`; then INPUT (what the active mode reads),
  MODE PARAMETERS (rendered from the mode's declarations) and the mode's action
  buttons. A `QScrollArea` is the only central widget — **there are no dock
  widgets anywhere in the viewer** (`grep QDockWidget` finds only a theme rule).
- Status bar: VRAM, preparation progress, messages (`:2594-2670`).

### 2.2 The ten `ViewKind`s

`ViewKind` is a `StrEnum` of exactly 10 values (`viewer/viewports.py:58-69`),
used both as the window's identity and as the `OPEN_VIEW` argument. `Viewport`
carries every per-window setting, never voxels (`viewer/viewports.py:77-243`),
and ids are minted with per-kind stems (`viewer/viewports.py:326-360`).

| ViewKind | id stem | Window class | What it shows |
|---|---|---|---|
| `image` | `V` | `ImageWindow` (`viewer/ui/imagewindow.py:94`) | one display plane of the layer stack |
| `graph` | `G` | `GraphWindow` (`viewer/ui/gridgraph.py:472`) | N×N voxel time-course grid around the crosshair |
| `carpet` | `C` | `CarpetWindow` (`viewer/ui/carpetwindow.py:234`) | grayplot: every voxel's time course as rows |
| `matrix` | `M` | `MatrixWindow` (`viewer/ui/matrixwindow.py:268`) | node×node correlation matrix |
| `clusters` | `K` | `ClusterWindow` (`viewer/ui/clusterwindow.py:112`) | table of thresholded connected components |
| `trace` | `T` | `TraceWindow` (`viewer/ui/tracewindow.py:212`) | one named panel a mode offers (time course, spectrum, scree, HRF) |
| `surface` | `S` | `SurfaceWindow` (`viewer/ui/surfacewindow.py:1139`) | 3-D hemispheres with data sampled between white and pial |
| `profile` | `P` | `ProfileWindow` (`viewer/ui/profilewindow.py:211`) | ribbon-profile QC column, one row per vertex |
| `depth` | `D` | `DepthWindow` (`viewer/ui/depthwindow.py:379`) | depth profile of an overlay over a cortical region |
| `chedi` | `E` | `ChediWindow` (`viewer/ui/chediwindow.py:321`) | a piece of cortex flattened, anatomy sampled at a depth |

Notes from the window fields:

- **`locked`** (default `True`) means follow the shared crosshair; an unlocked
  viewport keeps its own parked **`position`** (`viewer/viewports.py:88-100`).
- **`zoom_linked`** is the second LOCK step: locked *and* sharing zoom with
  every other zoom-linked image window, all centred on one shared point
  (`viewer/viewports.py:92-96`, `viewer/state.py:163`). The centre is shared as
  an mm point, never as a pan, because a pan is counted along each window's own
  rows/columns (`viewer/vocab.py:1612-1650`).
- Zoom is **per window**; there is no viewer-wide zoom (`viewer/vocab.py:421-431`).
- Image windows add: `solo`, `tiles`, `strip`/`strip_step`/`strip_zoom`,
  `zoom`/`pan`, and a 3×3 `tilt` (oblique slice) (`viewer/viewports.py:102-131`).
- Graph windows add: `grid_n` (1–16 cells/side), `traces`, `shared_scale`,
  `tint`, `hidden`, `regressors` (`:129-148`).
- Carpet/matrix add: `order`, `matrix_order`, `rois`, `detrend`, `scaling`
  (`:150-169`).
- Surface adds: `shape`, `depth`, `samples`, `hemis`, `split`, `hinge`,
  `equivolume`, `depth_stat`, `vertex_map`, `folding` (`:178-207`).
- Profile/depth/chedi add their own region/depth/patch fields
  (`:211-239`).
- `geometry` (x, y, w, h) is written by the window manager only, so a saved
  session comes back tiled (`:243-244`, `viewer/ui/manager.py:641`).

### 2.3 Companion windows: separate, never docked

A graph window is a top-level window "rather than a docked pane, because
looking at time courses is something you do sometimes" (`viewer/ui/gridgraph.py:1-6`).
The same choice is made for every companion, and the manager's own docstring
states the rule: windows are a projection of the viewport list
(`viewer/ui/manager.py:1-14`). There is no docking system, no splitter between
companions, no MDI: **all 10 companion windows are independent top-level
windows**. Placement is by the window manager from remembered `geometry`, or a
gap search (`TILE_GAP`, `PLACE_STEPS`), and `TILE`/`STACK`/`RAISE` operate on
every open companion across controllers (`viewer/ui/manager.py:39-56`,
`:485-640`).

The image window itself is a small top-level window (it used to be 420 px, now
resized to 280×280 by default — an EPI is 64–100 voxels across; `viewer/ui/imagewindow.py:348-350`).

Two windows are deliberately **not** in the viewport list:

- `MeshWindow` (`viewer/ui/meshwindow.py:32`) — the mesh list (load/compare/use/back
  up white and pial meshes), opened by the `MESH` button or `ctrl+M`.
- `VertexGraphWindow` (`viewer/ui/vertexgraph.py:107`) — time courses of vertices on a
  flattened patch; opened from a surface window with `g`, parented to that
  window, and its state (rings, detrend, hidden) is kept in the window "rather
  than in a recorded viewport: what is plotted around a vertex, not something a
  script needs to replay" (`viewer/ui/vertexgraph.py:121-126`).

### 2.4 Window inventory (13 user-facing top-level windows)

1 controller (`ViewerWindow`)
+ 10 viewport windows (image, graph, carpet, matrix, clusters, trace, surface,
profile, depth, chedi)
+ `MeshWindow`
+ `VertexGraphWindow`
= **13 top-level window classes**.

Widgets that are not top-level windows but are substantial: `ColorBar` /
`RangeBar` (`viewer/ui/colorbar.py:52`, `:277`), `ControlPanel` (`viewer/ui/controls.py:139`),
`Player` (a `QObject`, `viewer/ui/player.py:21`), `StripBar` (`viewer/ui/stripbar.py:32`),
`MapLegend` (`viewer/ui/surfacewindow.py:1100`), `FlowLayout` (`viewer/ui/flow.py:18`).

### 2.5 Dialogs

| Dialog | Class | Opened by | Purpose |
|---|---|---|---|
| Shortcut help | `ShortcutsDialog` (`viewer/ui/shortcuts.py:276`) | `h` in any window | renders that window's own binding table; the table is both installed and displayed (`viewer/ui/shortcuts.py:1-9`) |
| Tool form | `ToolDialog` (`viewer/ui/tooldialog.py:28`) | a mode action that declares a `DialogSpec` | generic form for a slow tool: runs on a worker with progress, installs on the GUI thread (`viewer/ui/tooldialog.py:1-12`) |
| Band split | `BandSplitDialog` (`viewer/ui/bandsplit.py:268`) | a regressor path control's band-split action | split a regressor file by frequency, by looking at its spectrum |
| Combo picker | `ComboPicker` (`viewer/ui/widgets.py:147`) | every dropdown, via `install_combo_pickers` | searchable list for long pickers |

### 2.6 Controllers (tabs) and linking

Controllers exist to compare things — two subjects, subject vs template, raw vs
denoised — each with its own directory list, stack, mode and windows
(`viewer/ui/window.py:24-34`). `Ctrl+1..5` activate controllers; `ctrl+T` opens one.
The `linked` checkbox propagates the crosshair **in millimetres** and the time
index to every other controller (`viewer/ui/window.py:419-470`). Window titles start
with the controller letter so `A`'s axial and `B`'s axial are distinguishable
(`viewer/ui/manager.py:105-110`).

### 2.7 Opening behaviour

- A session with no configured windows opens **three image windows** (axial,
  sagittal, coronal), no graph (`viewer/session.py:988-1003`).
- Modes that declare named panels cause a trace window per panel, once per
  panel (`viewer/session.py:1005-1021`).
- `OPEN_VIEW` names its id explicitly so replay rebuilds the same windows and
  later lines still address them (`viewer/vocab.py:162-179`).
- `+IMAGE` always opens a new image window; `SHIFT+N` a graph; the buttons name
  their own keys (`viewer/ui/window.py:750-806`).

---

## 3. Modes

### 3.1 The mode contract

A mode answers "where does the overlay come from". Everything it needs is
declarative (`viewer/modes/base.py:1-38`):

- `overlay_kind` (`VALUE`, `STATISTIC`, `CORRELATION`, `COMPONENT` —
  `viewer/modes/base.py:59-67`) tells the UI what the threshold slider means.
- `controls()` returns `Control` specs (`FloatControl`, `OptionalFloatControl`,
  `IntControl`, `ChoiceControl`, `BoolControl`, `PathControl`, `PathListControl`,
  `TextControl`, `ActionControl`; `viewer/modes/base.py:86-330`); the UI renders them
  generically and calls back via `SET_MODE_PARAM` (`viewer/ui/controls.py:1-30`).
  Controls carry `span`, `newline`, `visible_when`, help text, defaults.
- `actions()` declares buttons; `action(name)` runs one; `dialog_for(action)`
  optionally turns a button into a `DialogSpec` form instead of an immediate
  action (`viewer/modes/base.py:458-510`).
- `prepare()` is slow and must not touch session state; `compute()` is fast on
  the GUI thread (`viewer/modes/base.py`, `viewer/ui/work.py:1-20`).
- `series(ijk)` contributes `Trace` lines to graphs; `panels()` /
  `panel_names()` declare named trace windows (`viewer/modes/base.py:682-700`).
- The live output is a layer named for the controller + mode tag
  (`A_ICORR`), owned by the mode and replaced in place; KEEP freezes a
  numbered copy (`A_ICORR_1`) (`viewer/modes/base.py:24-39`, `:443-451`; generic
  `keep` action at `:447-455`; session `keep_output` `viewer/session.py:1911`).
- `input_kind` (`"4d"` / `"any"` / `"none"`) declares what the mode can read,
  resolved against `ViewerState.input_key` — deliberately separate from what is
  drawn or selected (`viewer/modes/base.py:395-420`, `viewer/state.py:176`,
  `viewer/session.py:1237-1279`; `tests/viewer/test_mode_input.py`).
- `gated` modes hold preparation-parameter changes for GO/live
  (`viewer/modes/base.py:447-565`).
- A mode reached by a button rather than the picker sets `in_selector = False`
  (ICA folder review; `viewer/modes/ica.py:72`, `viewer/modes/base.py:390-397`).

### 3.2 Registered modes and their parameters

Registration is an import side effect in `viewer/modes/__init__.py:1-50`; the registry
is `ModeRegistry` (`viewer/modes/base.py:757-785`). There are **12** modes:

| Mode | class | tag | selector | input | overlay kind | panels |
|---|---|---|---|---|---|---|
| `align` | `AlignMode` `viewer/modes/align.py:65` | ALIGN | yes | any | value | — |
| `denoise` | `DenoiseMode` `viewer/modes/denoise.py:40` | DENOISE | yes | 4d | value | — |
| `ica` | `ICAMode` `viewer/modes/ica.py:72` | ICA | **no** (button) | none | component | timecourse, spectrum |
| `instacorr` | `InstaCorrMode` `viewer/modes/instacorr.py:45` | ICORR | yes | 4d | correlation | — |
| `instaglm` | `InstaGLMMode` `viewer/modes/instaglm.py:87` | IGLM | yes | 4d | value | hrf |
| `instaica` | `InstaICAMode` `viewer/modes/instaica.py:28` | IICA | yes | 4d | correlation | timecourse, spectrum, scree |
| `instapca` | `InstaPCAMode` `viewer/modes/instapca.py:63` | IPCA | yes | 4d | correlation | timecourse, spectrum, scree |
| `paint` | `PaintMode` `viewer/modes/paint.py:47` | PAINT | yes | none | value | — |
| `plain` | `PlainMode` `viewer/modes/plain.py:15` | — | yes | none | value | — |
| `preproc` | `PreprocMode` `viewer/modes/preproc.py:72` | — | yes | none | value | — |
| `rgb` | `RGBMode` `viewer/modes/rgb.py:123` | RGB | yes | any | value | channels, colour axes |
| `tcorr` | `TCorrMode` `viewer/modes/tcorr.py:47` | TCORR | yes | none | correlation | — |

Controls and actions, exactly as declared (defaults in brackets). "gated" means
preparation parameters wait for GO unless `live` is ticked.

**align** — moves one layer by hand or hands it to allineate; fixed image = the
underlay, moving image = the mode's INPUT; anything attached follows on its own
grid (`viewer/modes/align.py:1-40`).
Controls: `tx`/`ty`/`tz` [0, −120..120], `rx`/`ry`/`rz` [0, −180..180].
Actions: `attach`, `detach`, `pivot`, `cmass`, `reset`, `save`, `load`,
`allineate`. Drag in an image window: ring turns, centre slides
(`viewer/ui/imagewindow.py:588-594`). `.aff12.1D` bridge and follower transforms live
in `viewer/align.py:1-40`.

**denoise** — project nuisance out of a run as a new layer, plus a
variance-removed map (`A_DENOISE_VR`); nothing runs on parameter change
(`viewer/modes/denoise.py:1-20`).
Controls: `matrix` path [""], `polort` [2, −1..9], `ica_noise` [False],
`ica_style` [non-aggressive | aggressive], `keep_mean` [True].
Actions: `apply`, `carpets`.

**ica** — review a MELODIC-compatible decomposition folder: component map as
overlay, time course + spectrum as traces, label signal/noise, save labels
(`viewer/modes/ica.py:1-30`).
Controls: `folder` path, `component` [0], plus computed component count.
Actions: `prev`, `next`, `signal`, `noise`, `unlabel`, `save_labels`, `keep`.

**instacorr** — seed correlation recomputed on click; preparation (detrend,
bandpass, blur, mask, ortvec) runs on a worker, correlation is one
matrix-vector product (`viewer/modes/instacorr.py:1-20`).
Controls: `drop_first` [0], `drop_last` [0], `polort` [2, −1..6], `fbot`
[0, off], `ftop` [0, off], `blur` [0 mm], `ortvec` path list [] ,
`automask` [True], `live` [False], `go` action, `seed_radius` [0 mm],
`seed_roi` [`crosshair`].
Action: `keep`.

**instaglm** — one run against one events file; change HRF/drift/motion/PCs and
refit, then take the model apart map by map (`viewer/modes/instaglm.py:1-20`).
Controls: `show` [beta | t | R2 | unique R2 | task R2 | task F | resid sd],
`thresh` [same | beta | t | R2 | unique R2 | task R2 | task F | resid sd],
`column` [--], `psc` units [swing | per unit], `events` path, `rois` path,
`basis` HRF [spmg1 | spmg2 | spmg3 | library | custom], `hrf_index` [0]
(visible when library), `peak` [6 s] / `width` [1] / `undershoot` [0.167]
(visible when custom), `blur` [0], `polort` [2, −1..9], `pcs` [0, 0..10],
`drop_first` [0], `drop_last` [0], `ortvec` path list.
Actions: `fit`, `keep`. Panel: `hrf`.

**instaica** — spatial ICA of the run under review, MELODIC's rotation
(`viewer/modes/instaica.py:1-20`).
Controls: `roi` [none], `mask` path, `drop_first`/`drop_last` [0], `polort`
[2, 0..9], `n_components` [30, 2..200], `seed` [0], `live` [False], `go`,
`component` [0], `map` [correlation | amplitude | z], `ortvec` save-to path.
Actions: `prev`, `next`, `unlabel`, `signal`, `noise`, `save`, `keep`.

**instapca** — temporal-PCA-style decomposition (drift out, unit-length
voxels) with the same review loop; SAVE NOISE writes an ortvec
(`viewer/modes/instapca.py:1-20`).
Controls: `roi`, `mask`, `drop_first`, `drop_last`, `polort` [2, 0..9],
`n_components` [20, 1..200], `live`, `go`, `component` [0],
`map` [correlation | amplitude], `ortvec`.
Actions: `prev`, `next`, `unlabel`, `signal`, `noise`, `save`, `keep`.

**paint** — draw integer-label ROI on the slices; left drag paints, right drag
erases, ctrl+wheel sizes the brush; painted layer is an ordinary ROI layer
(`viewer/modes/paint.py:1-12`).
Controls: `layer` [new], `value` [1, 1..999], `label_name` text, `radius`
[2 mm, 0.1..40], `brush` [disk | sphere], `overwrite` [True], `save_like`
[own grid], `save_to` path.
Actions: `new`, `undo`, `save`.

**plain** — the default "no mode" object: overlay is whatever file you picked
(`viewer/modes/plain.py:1-6`).

**preproc** — buttons for preproc tools; each opens a form and installs the
result above its input (`viewer/modes/preproc.py:1-20`).
Actions: `moco`, `slicetime`, `smooth`.

**rgb** — N images of one brain as one colour image; echoes/contrast views with
decorrelation stretch, PCA, TE basis or custom weights, Oklab colour maths,
region contrast optimiser (`viewer/modes/rgb.py:1-20`, `viewer/chroma.py`,
`viewer/contrast.py:1-30`).
Controls (defaults): `view` [echoes | contrast], `files` path list, `siblings`
action, `add_input` action, `live` [False], `go`, `basis` [pick | dstretch |
pca | te | custom], `signal` [raw | log | psc], `fit_on` [auto | mean | frames],
`floor` [0.05], `red`/`green`/`blue` [−1..0], `te` text, `weights` text,
`stats` [core | brain | slice | crosshair], `radius` [12 mm], `mask_from`
[auto], `space` [auto | rgb | oklab], `lightness` [basis | channel 1],
`shift0..2` [0], `stretch0..2` [1], `hue` [0], `spread` [2.5], `masked` [True],
`chroma` [0.25], `gamma` [1], `window` [1], `blur` [0], `radius_a` [5],
`move_b` [False], `radius_b` [5], `b_at` text, `regions` [spheres],
`a_label` [1], `b_labels` text, `context` [1], `optimise` action,
`tolerance` [0.3], `save_to` path.
Actions: `reset_look`, `select`, `save`, `keep`. Panels: `channels`,
`colour axes`.

**tcorr** — voxel-to-voxel correlation between datasets, as a live overlay
(`viewer/modes/tcorr.py:1-12`).
Controls: `files` path list, `polort` [2, −1..6], `blur` [0], `pairs`
[all | adjacent | first], `pair` [--].
Actions: `go`, `keep`.

### 3.3 Preproc tools

Tools make a *dataset* (not an overlay): they run on a worker, return a
`ToolOutcome` and are installed above their source under a stem like `A_MOCO`;
results stay in RAM and a re-run replaces the previous one
(`viewer/tools/base.py:1-35`, `:59-141`). Registered tools
(`viewer/tools/__init__.py`):

| Tool | class | input | controls |
|---|---|---|---|
| `moco` | `MocoTool` `viewer/tools/moco.py:127` | 4d | `base` [first \| middle \| last], `interp` [linear \| cubic \| quintic \| heptic \| wsinc5], `final_interp` [wsinc5] |
| `slicetime` | `SliceTimeTool` `viewer/tools/slicetime.py:113` | 4d | `timing` path, `reference` [mean \| start of TR \| first slice \| middle slice], `interp` [fourier \| linear \| cubic \| quintic \| heptic \| wsinc5 \| wsinc9] |
| `smooth` | `SmoothTool` `viewer/tools/smooth.py:39` | 4d | `fwhm` [4 mm, 0..16] |

Each dialog is built generically by `PreprocMode.dialog_for`, which prepends an
`input` choice over the layers the tool can use (`viewer/modes/preproc.py:153-190`,
`viewer/ui/tooldialog.py`). MOCO also makes QC volumes (difference maps before/after)
and can contribute named trace panels (`viewer/tools/base.py:53-141`).

---

## 4. Command vocabulary

Full detail — argument types/defaults, aspects, major flag, category, line —
is generated into [`docs/COMMAND_REFERENCE.md`](COMMAND_REFERENCE.md) by
`scripts/extract_commands.py`. This section is the map, not a copy.

**114 registered commands, 26 major.** Categories (definition in the generated
reference; the taxonomy is the rebuild's documented split: source / analysis / display /
navigation):

| Category | n | Commands (source tokens) |
|---|---|---|
| source 17 | | `ADD_LAYER`, `ADD_OVERLAY`, `LOAD`, `LOAD_MESH`, `LOAD_SURFACES`, `LOAD_SURFACE_ROI`, `READ`, `READ_FILES`, `RELOAD_LAYER`, `REMOVE_LAYER`, `REMOVE_MESH`, `SAVE_MESH`, `SAVE_SURFACES`, `SAVE_SURFACE_ROI`, `SET_OVERLAY`, `SET_UNDERLAY`, `USE_MESH` |
| analysis 16 | | `DELETE_SURFACE_VERTEX`, `DENOISE`, `EDIT_SURFACE`, `EDIT_SURFACE_STROKE`, `HIGHLIGHT_TO_ROI`, `MODE_ACTION`, `MOVE_SURFACE_HIGHLIGHT`, `NEW_PAINT_LAYER`, `PAINT_STROKE`, `PAINT_UNDO`, `SET_INPUT`, `SET_MODE`, `SET_MODE_PARAM`, `SET_SEED`, `SPLIT_SURFACE_EDGE`, `UNDO_SURFACE_EDIT` |
| display 65 | | `HIGHLIGHT_SURFACE`, `MOVE_LAYER`, `SELECT_LAYER`, `SET_ALPHA`, `SET_ATLAS`, `SET_BOXED`, `SET_CARPET_ORDER`, `SET_COLORMAP`, `SET_COLORMAP_REVERSED`, `SET_DEPTH_VIEW`, `SET_EDGES`, `SET_GRID_RES`, `SET_LAYER_FOLLOWS`, `SET_LAYER_OPACITY`, `SET_LAYER_ROI`, `SET_LAYER_TIME_VIEW`, `SET_LAYER_VISIBLE`, `SET_LAYER_XFORM`, `SET_MATRIX_ORDER`, `SET_MESH`, `SET_OUTLINE_WIDTH`, `SET_PANES`, `SET_PATCH_LAYER`, `SET_PATCH_OVERLAYS`, `SET_PATCH_SIZE`, `SET_PROFILE_VIEW`, `SET_RANGE`, `SET_RANGE_FIXED`, `SET_RANGE_MIRROR`, `SET_RESAMPLE`, `SET_SIGN`, `SET_SURFACE_BRUSH`, `SET_SURFACE_DEPTH`, `SET_SURFACE_DEPTH_STAT`, `SET_SURFACE_EDITING`, `SET_SURFACE_EQUIVOLUME`, `SET_SURFACE_FOLDING`, `SET_SURFACE_FREE`, `SET_SURFACE_HEMIS`, `SET_SURFACE_HINGE`, `SET_SURFACE_MAP`, `SET_SURFACE_SHAPE`, `SET_SURFACE_SNAP`, `SET_SURFACE_SNAP_GATE`, `SET_SURFACE_STEP`, `SET_SURFACE_TOOL`, `SET_THEME`, `SET_THRESHOLD`, `SET_THRESHOLD_FOLLOW`, `SET_THRESHOLD_INDEX`, `SET_TIME_LINKED`, `SET_VIEW_DETREND`, `SET_VIEW_GRID`, `SET_VIEW_HIDDEN`, `SET_VIEW_REGRESSORS`, `SET_VIEW_ROIS`, `SET_VIEW_SAMPLING`, `SET_VIEW_SCALING`, `SET_VIEW_SHARED_SCALE`, `SET_VIEW_SOLO`, `SET_VIEW_TILES`, `SET_VIEW_TINT`, `SET_VIEW_TRACES`, `SET_VOLUME`, `SHOW_SURFACES` |
| navigation 16 | | `CLOSE_VIEW`, `JUMP_BACK`, `OPEN_VIEW`, `SELECT_SURFACE_VERTEX`, `SET_IJK`, `SET_INDEX`, `SET_PAN`, `SET_VIEW_GEOMETRY`, `SET_VIEW_LOCKED`, `SET_VIEW_PANEL`, `SET_VIEW_PLANE`, `SET_VIEW_POSITION`, `SET_VIEW_STRIP`, `SET_VIEW_TILT`, `SET_XYZ`, `SET_ZOOM` |

The generated reference also lists the commands where the category choice is
arguable and *why* it was made (e.g. `SET_SEED` is analysis, `SET_LAYER_XFORM`
is display). The extractor exits non-zero if `vocab.py` gains/renames a command
the table does not classify, so the table cannot silently drift.

Vocabulary design notes worth preserving:

- The bus exists so recording, replay, external driving and undo share one
  mechanism; the dispatch table comes first, not bolted on afterwards
  (`viewer/commands.py:1-14`).
- There is no underlay/overlay *role*: `LOAD` is the one load verb and a layer is
  a layer; the three legacy load commands are understood only so old scripts
  replay (`viewer/vocab.py:465-536`, `viewer/layers.py:349-393`).
- Layer identity is a stable `key` (`L1`, …), not a path, so scripts survive
  reordering (`viewer/layers.py:45-58`).
- `SET_MODE_PARAM` carries its value as text so the vocabulary stays closed over
  scalars and round-trips (`viewer/vocab.py:1177-1193`).
- Mode actions that are logically "press a button" are `MODE_ACTION`, so a
  script can drive KEEP/APPLY/next/prev (`viewer/vocab.py:1193-1202`).

### 4.1 Script syntax (recap)

One command per line, positional args, AFNI-flavoured (`SET_IJK 32 40 25`,
`SET_THRESHOLD L2 2.5`); `#` comments; booleans `1`/`0`; empty optionals `-`;
tuples flattened (`SetViewTilt` is 9 floats, `SetLayerXform` 12). `parse_script`
reports the failing line number (`viewer/commands.py:196-223`). A recorded
script is what `ctrl+S` writes and the `-script` CLI option replays.

---

## 5. Layer model and display semantics

### 5.1 The layer record and the stack

A layer is one volume plus its display parameters; the voxels live in the store
(`viewer/layers.py:1-10`). `Layer` is frozen and scalar-only so it is cheap to
copy and safe in undo history (`viewer/layers.py:45-58`). Fields and defaults
(selected):

- identity/provenance: `key`, `name`, `path`, `shape`, `n_volumes`, `affine`,
  `native_affine` (moving-layer original), `follows`, `source` (`"file"`,
  `"mode:<name>"`, `"derived:<op>:<key>"`, `"paint:"`, `"surface:"`)
  (`viewer/layers.py:52-110`).
- `stataux`: `{sub_brick: (AFNI stat code, params)}` — makes a threshold
  expressible as a p without guessing dof (`:59-63`); `labels` from the header
  (`:64-67`); `sub_brick()` renders `#3 Faces#0_Coef` (`:240-253`).
- `roi` / `integer_labels`: values are region identities, not magnitudes; guessed
  for a 3-D volume of small integers, correctable by `SET_LAYER_ROI`
  (`:68-84`).
- display: `visible` [True], `opacity` [1.0], `colormap` [`gray`],
  `colormap_reversed` [False], `n_panes` [0 = continuous], `sign_mode`
  [`both`], `volume_index` [0], `time_linked` [False],
  `time_detrend` [−1], `time_psc` [False], `range_lo`/`range_hi` [None =
  derive], `range_mirror` [False], `range_fixed` [True], `threshold` [0],
  `threshold_index` [None], `threshold_follow` [`same`], `threshold_p` [None],
  `alpha_mode` [`off`], `boxed` [False], `edges` [False], `resample` [`auto`],
  `colour` [False] (`viewer/layers.py:90-168`).
- `LayerStack` is ordered bottom-first; index 0 is the underlay by position
  (`viewer/layers.py:254-266`). `add` inserts a new dataset below the top
  *results* so loading an anatomy does not bury a correlation map (`:301-320`);
  key minting and lookup at `:277-297`; move/remove/update at `:322-348`.
- Legacy replacement semantics (`set_underlay`, `set_overlay`, `add_overlay`)
  remain for replayed scripts (`:349-393`).
- `flip_with_below(key)` computes the A/B visibility swap used by `shift+O`
  (`:395-413`). `base` is `layers[0]` (`:414-417`).

### 5.2 Colour mapping

- Scales are stored as RGB control points and interpolated into a 256-entry LUT
  on demand (`viewer/colormap.py:31-76`). Named order: gray, hot, cool, red,
  viridis, plasma, inferno, magma, cividis, turbo, spectrum, redblue, RdBu,
  RdYlBu, hsv, twilight, twilight_shifted, then any extras alphabetically
  (`:80-104`). RdBu/RdYlBu are deliberately reversed from matplotlib so red is
  the high end (`:75-76`).
- `normalize` maps to [0, 1] honouring `SignMode`: BOTH spreads `[lo, hi]`;
  POS/NEG use the relevant half over the whole scale (`:136-156`). `quantize`
  makes AFNI-style discrete panes by flooring into `n_panes` bands (`:158-169`).
  `apply_colormap` handles NaN by sending it to the bottom of the scale, whose
  alpha is zero anyway (`:171-189`).
- Label layers colour by identity through a palette indexed by the value and
  make value 0 transparent (`apply_label_colors`, `:192-202`). `label_edges`
  outlines borders *between* regions (background counts as a label) rather than
  the union's outer hull (`:204-221`).
- `available_colormaps`, `build_lut` (`:103`, `:107`); LUTs are cached per
  (name, device, size, reverse) in `compose.cached_lut` (`viewer/compose.py:49`).

### 5.3 Ranges

- `None` means derive from the data. Autorange uses the **2nd/98th
  percentiles** (`AUTORANGE_PERCENTILES`, `viewer/session.py:50`), because one
  bright voxel at the edge would otherwise set the scale (`:72-89`).
- A freshly loaded overlay gets the scale its contents call for
  (`viewer/session.py:839-883`): statistics = has stataux/labels or a
  stats-like filename → `hot`, and a threshold at **p = 0.001**
  (`OVERLAY_START_P`, `:52`) when the bucket states its own dof; a signed map
  whose two tails are comparable (`MIRROR_MIN_SHARE = 0.2`,
  `MIRROR_BALANCE = 0.5`, `:57-60`) or a coefficient label → symmetric range and
  `redblue`; one-signed maps run from 0 to their top percentile. `overlay_look`
  is the implementation (`:894-932`); `negative_tail` sets min in one click
  (`:934-945`).
- `range_mirror` keeps min at −max (`viewer/vocab.py:1483-1493`);
  `range_fixed` keeps a typed scale when the displayed values change and is on
  by default (`viewer/layers.py:122-128`); `SET_VOLUME` re-derives the scale for
  a bucket's next sub-brick unless fixed, because the next brick is a different
  quantity (`viewer/vocab.py:2788-2815`).

### 5.4 Threshold semantics (the scientifically important part)

- A layer's threshold is a magnitude cut applied to a **threshold statistic**
  that may be a different sub-brick from the one being coloured
  (`threshold_index`; `viewer/layers.py:130-142`).
- `threshold_follow` moves the threshold sub-brick with the displayed one:
  `same` (threshold on what is shown), `next` (the brick after it — a
  `_Coef`/`_Tstat` pair), `next2` (two after — a `_Coef`/`_Tstat`/`_Zstat`
  triplet), `fixed` (stay on the chosen one) (`viewer/vocab.py:1704-1721`,
  `:1505-1521`). `brick_stops` makes `,`/`.` step one Coef group at a time when
  following (`:1709-1721`).
- **p-value coupling**: `threshold_p` is the p the threshold stands for, kept
  whenever the threshold is on a statistic. Moving the threshold to another
  statistic (F → t, one dof to another) re-derives the value from the stored p,
  so the cut means the same thing (`_hold_p`, `viewer/vocab.py:1749-1760`;
  `_p_of_threshold`/`_threshold_at_p`, `:1722-1747`). Conversion goes through
  `fastfuncstuff.stats.fdr` (`stat_value_to_pvalue`, `pvalue_to_stat`); the
  bucket's own `stataux` supplies the test and dof (`Layer.stat_spec`,
  `viewer/layers.py:211-239`). AFNI *value* parity for these conversions is a
  settled decision pinned by `tests/viewer/test_pthreshold.py`.
- The threshold slider's reach is read from the brick the threshold applies to,
  not the displayed one (`threshold_scale`, `viewer/session.py:947-970`).
- A layer with no threshold is fully opaque (subject to sign mode); a
  one-sided sign mode still hides the other side (`threshold_alpha`,
  `viewer/colormap.py:224-272`). NaNs are always fully transparent, in every
  mode, so "no value here" never darkens the composite.
- Thresholds are stored as values, not p's, in the script; `threshold_p` rides
  along in state and is preserved across sub-brick moves.

### 5.5 Sign, alpha, boxed, edges

- `SignMode` = `both | pos | neg` (`viewer/layers.py:23-29`): which side of zero
  is shown (and normalised) — POS/NEG keep the full colour resolution on the
  shown half.
- `AlphaMode` = `off | linear | quadratic` (`:31-43`): OFF is a hard mask;
  LINEAR/QUADRATIC fade sub-threshold voxels toward zero rather than hiding them
  ("a voxel just under threshold reads as faint rather than absent") and reach
  zero only at zero (`viewer/colormap.py:224-272`; rationale at
  `viewer/colormap.py:1-18`).
- `boxed` outlines voxels that passed, so fading never leaves you guessing which
  survived: a 2-D 4-neighbour edge map of the suprathreshold region drawn in a
  near-white that reads against every scale (`BOX_RGB`,
  `viewer/compose.py:44`, `viewer/colormap.py:275-300`; boxes are composited
  last so a higher layer cannot hide them, `viewer/compose.py:284-288`).
  For a label layer `boxed` instead draws the borders *between* regions
  (`viewer/compose.py:246-255`).
- `edges` draws the layer as its thin edges instead of intensities — the
  alignment check: edges of one image over another show at a glance whether
  boundaries coincide (`viewer/layers.py:145-149`). Edges are computed in 2-D on
  the displayed plane with the same detector/ramp as the QC edge movies, at one
  native voxel of smoothing however far the grid magnifies it, and the step from
  data to background is suppressed (`viewer/compose.py:94-138`, `:212-221`).

### 5.6 Resampling and the display grid

- One display grid: `DisplayGrid(shape, affine)` maps voxel indices to scanner
  RAS mm; the crosshair is an anatomical location (`viewer/state.py:24-73`).
- The bottom layer defines the grid; changing the bottom carries the crosshair,
  seed, parked slices and pans across in millimetres
  (`_adopt_grid_preserving_position`/`_carry_to_grid`, `viewer/vocab.py:1652-1704`).
- `SET_GRID_RES` resizes the grid in mm, same field of view and orientation;
  0 = underlay's own voxels (`resize_grid`, `viewer/state.py:70-101`;
  `viewer/vocab.py:1571-1586`). `grid_res_choices` builds the picker: underlay,
  each layer's own size by name, then round sizes, always including the current
  setting (`viewer/state.py:108-140`; `GRID_SIZES` `:94`).
- `SET_RESAMPLE` / `Layer.resample` = `auto | nearest | linear | cubic`.
  `auto` decides **by direction**: a layer coarser than the grid is upsampled
  nearest (interpolating would paint a resolution the data does not have, and
  cluster edges would land between real voxels); a finer layer is downsampled
  linear. The underlay on a resized grid is linear so the anatomy is the
  interpolated one. A label layer is always nearest (`resample_mode`,
  `viewer/session.py:1192-1235`; rationale `viewer/layers.py:150-164`).
- Sampling implementation: a single `grid_sample` (nearest/bilinear) or an
  explicit tricubic Catmull-Rom for cubic, which **interpolates** (a sample on a
  voxel centre returns that voxel in every mode, so switching modes changes
  edges and not values); samples outside the volume return `fill` rather than
  smearing the border; `repair_nan` falls back to nearest where an
  interpolated sample is NaN so a hole does not grow (`sample_volume`,
  `viewer/slicing.py:416-477`, `_sample_cubic` `:487-519`).
- Resampling is **display only**: voxels, graphs, cluster tables and what a mode
  reads are untouched (`viewer/session.py:1202-1235`,
  `tests/viewer/test_resample_and_report.py`).
- `SET_LAYER_XFORM` / `SET_LAYER_FOLLOWS` move where a layer is drawn by changing
  its affine, keeping the file's affine in `native_affine`; a follower shares
  the parent's world transform on its own grid (`viewer/align.py:1-40`,
  `viewer/vocab.py:1287-1338`). The xform command deliberately does **not**
  dirty `LAYERS` so a drag does not drop device volumes (`viewer/vocab.py:1295-1297`).

### 5.7 ROI / atlas / label layers

- `roi=True` changes how a layer is drawn (one colour per label, no scale), what
  the readout says (region name), and what it can be used *for* (matrix nodes,
  seed from an ROI, mask) (`viewer/layers.py:68-84`).
- Guessed on load for a 3-D integer volume (`looks_like_labels`,
  `viewer/rois.py`; applied in `ViewerSession._open`); `SET_LAYER_ROI`
  corrects either way, and turning it off also clears `integer_labels`
  (`viewer/vocab.py:2990-3010`).
- `SET_ATLAS` chooses the parcellation (`annot`, e.g. `aparc`) and the label
  volume (`volume`, e.g. `aparc+aseg`) used to name regions; empty turns either
  off (`viewer/vocab.py:1093-1104`, `viewer/state.py:220-221`). Region names
  come from FreeSurfer annotation / colour LUT / volume atlas in
  `viewer/surfaces.py:507-550`; the readout appends the crosshair's region
  (`viewer/session.py:1325-1353`).
- ROI palettes for display come from `session.roi_palette` (`:2330`), building a
  `RoiSet` from a label layer (`viewer/rois.py:1-16`); surface results,
  cluster tables and painted layers can all be installed as ROI layers
  (`session.install_rois` `:2541`).

### 5.8 Compositing and transparency

`composite` is standard premultiplied source-over, bottom first; it branches on
`alpha > 0` rather than multiplying, because `NaN * 0` is NaN and one undefined
colour would spread through the stack (`viewer/colormap.py:303-321`). Layer
opacity multiplies the threshold alpha (`viewer/compose.py:80-87`); a mask layer
(`display_mask`) zeroes both the stat and the alpha so boxed clusters are
outlined where the mask cuts them (`viewer/compose.py:264-278`). Output is
uint8 RGBA (`to_rgba8`, `viewer/colormap.py:324-331`).

### 5.9 Time view of a 4-D layer

`SET_LAYER_TIME_VIEW` makes a time series *shown* detrended (Legendre order ≥ 0)
and/or as percent signal change, frame by frame. Display only: slices, surface
and readout show the transformed frame; nothing is written and graphs keep their
own detrend (`viewer/vocab.py:1466-1482`, `viewer/timeview.py:1-12`). The
expensive part (drift coefficients per voxel against the viewer's orthonormal
Legendre basis) is done once per (layer, order), so a frame is one small
matrix-vector product (`viewer/timeview.py:8-12`).

---

## 6. Slice rendering pipeline

### 6.1 From state to pixels

`render_plane` walks the visible layers in stack order, samples each into the
display grid, colours/labels/edges it, computes its alpha (and boxed edges),
composites, then draws box outlines last; it returns `None` for an empty session
(`viewer/compose.py:140-289`). `render_viewport` adds the window's plane, solo
and crop (`:372-397`); `render_all` renders all three planes (`:399-407`).
`PaneImage` is `(H, W, 4)` uint8 plus plane and position (`:61-70`).

### 6.2 Plane layout and anatomical convention

- `_PLANE_CONVENTION` maps each plane to (normal, up, right) as RAS letters:
  axial = S normal with A up and R right; coronal = A normal with S up and R
  right; sagittal = R normal with S up and **P right** so the face looks left
  (`viewer/slicing.py:33-44`). Axial and coronal put +R to the image's right =
  **neurological convention** (subject's left on the viewer's left); sagittal
  puts anterior to the left.
- `PlaneLayout` computes which array axis is fixed/row/col plus row/col flips
  from the affine's dominant RAS axes (`ras_axes`, `plane_layout` —
  `viewer/slicing.py:45-97`, `:252-311`). Flip arithmetic lives only here, used
  by drawing, hit-testing and crosshair placement (`:78-83`).

### 6.3 Zoom, pan, crop, strip

`PlaneView` zooms by **cropping** (sampled region shrinks; the pane's
scale-to-fit magnifies without inventing extra data), and carries a pan in
display-grid voxels along the plane's own row/col axes (`viewer/slicing.py:99-249`).
`origin` is clamped so panning cannot walk off the data. `points_to_image` /
`image_to_points` are the continuous, unrounded geometry twins used for surface
outlines and drags (`:213-241`). Pans are shared between LOCK windows as a
*point*, not a copied pan (`_sync_zoom_links`, `viewer/vocab.py:1612-1650`).

The image window can also show a **neighbour strip**: an even number (0–12) of
cropped slices either side of its own, with step (0 = auto: span the edit brush
while editing, else adjacent slices) and its own zoom (`viewer/viewports.py:119-126`,
`MAX_STRIP = 12` `:73`; model in `viewer/strip.py:1-14`; `StripBar` UI
`viewer/ui/stripbar.py:1-6`). Cells report back to the window; the row reads
"below | here | above" (`viewer/ui/stripbar.py:1-6`).

### 6.4 Oblique (tilted) slices

An oblique view is the display grid with a rotated affine about the crosshair —
not a fourth plane (`viewer/compose.py:328-347`, `viewer/slicing.py:1-9`).
`SET_VIEW_TILT` stores a row-major 3×3 rotation in mm and validates that it is a
rotation (`viewer/vocab.py:433-443`, `:2522-2561`). `t` in an image window tilts
the slice to cut the cortex square-on (`section_tilt`, `viewer/compose.py:297-325`;
binding `viewer/ui/imagewindow.py:410-416`), alt+arrows tilt 5° per press, shift+T
untilt. The slice's layout still uses the untilted affine so a tilt cannot swap
a pane's axes (`DisplayGrid.layout_affine`, `viewer/state.py:36-40`).

### 6.5 Solo, tiles, and cross-layer comparison

- `solo` draws only the selected layer; `[`/`]` alternate the selection so the
  same window flips between an EPI and an anatomy — "how to see what
  registration actually did" (`viewer/viewports.py:107-112`,
  `viewer/compose.py:382-392`).
- `tiles` draws one tile per visible image in one window, each soloed on its own
  image, all sharing that window's slice/zoom/pan, so a zoom in any tile moves
  every tile (`viewer/viewports.py:113-118`; `tile_layers`,
  `viewer/compose.py:366-370`). Bound to `\` (`viewer/ui/window.py:2029-2035`).
- `shift+O` / `O` flips a layer against the one below by swapping their
  visibilities (`LayerStack.flip_with_below`, `viewer/layers.py:395-413`).

### 6.6 Crosshair, parked slices, locks

- Crosshair is a display-grid index in state; `SET_IJK`/`SET_XYZ` move it and
  `JUMP_BACK` swaps with the previous jump. The jump target is written by
  `ViewerSession.do`, in mm, and only after the crosshair rests
  (`JUMP_REST_S = 0.5 s`) so a drag is one jump (`viewer/session.py:69`,
  `:676-698`).
- An unlocked viewport keeps a `position` (park a reference slice while
  navigating elsewhere); `SET_VIEW_POSITION` with `-` puts it back on follow
  (`viewer/viewports.py:88-100`, `viewer/vocab.py:239-249`).
- Lock cycle in an image window: `l` → off (park) → Lock (follow) → LOCK
  (follow + shared zoom, centred on one point) (`viewer/ui/imagewindow.py:461-466`;
  `viewer/vocab.py:223-238`, `:2562-2596`).
- Crosshair style cycles in image windows: lines → off → ring
  (`CrosshairStyle`; binding `x`, `viewer/ui/imagewindow.py:467`); in the 3-D window:
  lines → off → dot (`viewer/ui/surfacewindow.py:1157`, `:1718-1723`).
- The pane draws the crosshair, surface outlines, highlights, mode marks,
  paint stroke/brush, coverage boxes and readout lines in that order
  (`viewer/ui/panes.py:376-633`).

### 6.7 Readout

`layer_reading` is the single lookup behind every readout: nearest-neighbour
value in the layer's own voxels (never an interpolated value), plus the threshold
statistic too when it is a different sub-brick ("the beta you colour by and the t
that decides whether it is drawn"), or the region name for an ROI layer
(`viewer/session.py:1354-1396`; nearest-neighbour rationale at
`viewer/slicing.py:567-579`). `overlay_readout` returns one line per visible
overlay top-first and appends the crosshair's atlas region
(`viewer/session.py:1325-1353`). Values appear in the layer list and status bar
and optionally as a box on the image (`alt+V`).

---

## 7. Surface pipeline

### 7.1 Surfaces are not layers

A layer is voxels on a grid with an affine; a surface is a mesh whose vertices
are already in scanner millimetres, so drawing it on a slice is a geometric
intersection, not a resample. Meshes live on the session (`SurfaceStore`), and
state carries only the scalars a script needs (subject, which outlines are
drawn) (`viewer/surfaces.py:1-14`, `viewer/state.py:192-221`). Nothing here
imports Qt; outlines come out in fractional image (row, col) through
`PlaneView.points_to_image` (`viewer/surfaces.py:1-14`).

`SurfaceStore` (`viewer/surfaces.py:109-189`) holds: hemispheres, per-grid slice
indices (up to 4 grids), edit state/undo, mesh list, template lookups, annot/
atlas caches, ribbon maps, highlight/depth ROI, per-vertex file areas, bundles
for topology edits, versions for repaint invalidation.

### 7.2 Loading

- `LOAD_SURFACES subject_dir [hemis] [space]` reads a FreeSurfer subject and
  outlines white/pial; meshes are placed in scanner RAS from the geometry each
  file carries, so they line up with `orig.mgz`, a SUMA SurfVol or anything
  aligned to them — no SUMA spec, no surface volume (`viewer/vocab.py:509-536`,
  `cli/viewer.py:157-163`).
- `space` (CLI `-surf_space`) shows the subject on a template mesh
  (`onavg-ico64`, `fsaverage`, …) placed through `sphere.reg`; view-only, edits
  are saved from the native mesh (`cli/viewer.py:174-184`, `viewer/surfaces.py:191-256`).
- `-mesh` loads a FreeSurfer surface file directly; hemisphere and white/pial
  are inferred from the name (`lh.pial`, `rh.smoothwm`, …), refusing a file whose
  name does not say (`cli/viewer.py:174-184`, `viewer/meshlist.py:1-40`).
- `LOAD_MESH` adds a mesh file to the list ("shown for comparison, not in use");
  for a hemisphere not loaded yet the file *becomes* it, and a missing
  white/pial partner is stood in by the other array so sampling collapses onto
  the surface that exists (`viewer/vocab.py:865-880`, `viewer/surfaces.py:1613-1707`).
- The mesh list rule: per hemisphere and kind, the **top-most** row is in use
  for edits and depth sampling; every other row is drawn as a comparison
  outline. `USE_MESH` makes a row current; `SET_MESH` shows/hides/recolours/
  relabels; `REMOVE_MESH` removes; `SAVE_MESH` writes a copy
  (`viewer/meshlist.py:1-14`, `viewer/vocab.py:865-928`; `MeshWindow`
  `viewer/ui/meshwindow.py:1-10`).
- Per-vertex surface results (`-surf_data`, `.func.gii`/`.shape.gii`) load as
  layers once their mesh is present; matching is by vertex count + mesh
  fingerprint, and a left/right sibling joins the same layer. Results made on a
  template are mapped back through `sphere.reg` barycentrically (nearest for
  integral maps) (`cli/viewer.py:185-198`, `viewer/surfaces.py:191-285`,
  `viewer/surfacelayers.py:1-45`).

### 7.3 Shapes, layout, hemispheres

- `SHAPES = (mid, white, pial, inflated, sphere, flat)` in the window's order
  (`viewer/surface3d.py:31`); `mid` is halfway white→pial (pycortex "fiducial"),
  `flat` is the first patch whose name says flat (`:40-48`). Anatomical shapes
  (`mid`, `white`, `pial`, `smoothwm`) stay where the head is; the rest are laid
  side by side (`ANATOMICAL_SHAPES`, `:35`; `layout_offsets`, `:104-135`;
  `HEMI_GAP = 8 mm`).
- `flat_layout` turns a patch's own arbitrary 2-D coordinates into a lateral
  view matching the anatomy's AP/SI plane (superior up, hemispheres meeting
  occipital-pole to occipital-pole) (`:50-76`).
- `hemisphere_models` applies `split` (push apart, mm) and `hinge` (swing open
  like a hot-dog bun; positive = nose to nose, negative = occipital to
  occipital, ±180 = flat), each hemisphere pivoting on its own medial edge
  (`:137-170`; `SET_SURFACE_HINGE` `viewer/vocab.py:1054-1063`).
- Shape morphing between two shapes (`morph` uniform; the vertex shader mixes
  white/mid/pial/inflated positions) is animated by `SurfaceCanvas.animate_to`
  (`viewer/ui/surfacewindow.py:382-406`, uniform `morph` in `viewer/surface3d.py:485-505`).

### 7.4 Depth sampling (how data gets on the surface)

This is the pipeline's centre and the most important behaviour to preserve.

- Every vertex carries **two positions it is drawn at** (the shape) and **two it
  is sampled at** — its white and pial points in scanner mm. The rasteriser
  interpolates the sampling positions across each triangle and the fragment
  shader reads the volume at `mix(white, pial, depth)` for every pixel. So a
  0.35 mm dataset shows its own voxels on an inflated 1 mm mesh, and an edit to
  white/pial changes the inflated view immediately (`viewer/surface3d.py:1-18`,
  shader `viewer/shaders/surface.frag:1-12`).
- A depth window is `(lo, hi)` fractions with `samples` uniformly spaced values
  between them (`SET_SURFACE_DEPTH`; `depth_fractions`,
  `viewer/surface3d.py:737-749`; window widths stepped by `{`/`}`
  `DEPTH_WIDTHS = (0, 1/5, 1/3, 1/2, 1)` with `DEPTH_SAMPLE_SPACING = 0.05`
  and `MAX_DEPTH_SAMPLES = 16`, `:702-735`). The window slides rather than
  shrinks near a boundary so a slab stays the same thickness.
- **Equivolume** depth (Waehnert 2014, per-vertex areas as pycortex):
  area varies linearly with depth, so the volume enclosed by depth ρ is a
  quadratic solved for ρ — outer layers are thinner on a gyral crown and
  thicker in a fundus. Default ON; `SET_SURFACE_EQUIVOLUME` toggles equal-volume
  vs equal-distance (`surface/profiles.py:172-192`; CPU/GLSL twins
  `viewer/surface3d.py:790-820` and `shaders/surface.frag:60-71`; per-vertex
  white/pial areas from `SurfaceStore.vertex_areas`, `viewer/surfaces.py:918-952`).
- Multiple depth samples reduce to one value by `DEPTH_STATS = (mean, median,
  max, min, max_abs, nzmean)` — names are 3dVol2Surf's map functions. Selections
  take the threshold statistic from the *same* depth as the value, so a colour
  and its threshold always describe one point (`viewer/surface3d.py:751-787`;
  same reduction in the shader).
- The CPU twin `shade_reference` reproduces the fragment shader's colouring
  through `viewer/colormap.py`, and the GPU path is tested against it
  (`viewer/surface3d.py:790-820`, `tests/viewer/test_surface_render.py` — the
  shader is right only if it matches the CPU arithmetic).
- Slice overlays *painted into the cortical ribbon* use the ribbon map
  (which vertex owns each ribbon voxel of a grid), built once per (mesh version,
  grid) and reused by every surface layer (`SurfaceStore.ribbon_map(s)`,
  `viewer/surfaces.py:304-350`; `surface/ribbon.py`).
- `sample_depths` (the headless sampler used by the depth window and by tests)
  reads a volume at given cortical depths, with equivolume inside [0, 1] and a
  linear extension outside, and supports 4-D volumes read once for all time
  points (`surface/profiles.py:193-268`). `VolumeSampler` is the general
  nearest/linear/tricubic mm-space reader (`surface/sampling.py:17-64`).

### 7.5 Shading, folding shade, vertex maps

- The fragment shader lights with a **headlight**: `0.35 + 0.65 * |n.z|`, so
  every orientation reads; the base colour is the folding shade (curv/sulc/
  binary/off) or a per-vertex map, then up to **4 overlay layers** composite
  bottom-to-top exactly as the slices do (`viewer/shaders/surface.frag:255-325`,
  `MAX_LAYERS = 4` `viewer/surface3d.py:433`; uniform block
  `pack_uniforms`, `:485-540`; `ShadeParams` `:445-464`).
- `FOLDING = (curv, sulc, binary, off)`; values in [−1, 1], positive = sulcal =
  darker; curv is fine folding, sulc is broad (best on inflated), binary is
  FreeSurfer's two-tone gyri/sulci; scaled to the 98th percentile so subjects
  look alike (`folding_values`, `viewer/surface3d.py:541-568`).
- `VERTEX_MAPS = ("", thickness, sulc, curv, annot, flags)`: thickness on a
  fixed 1–4.5 mm viridis scale (subjects comparable), sulc/curv symmetric
  red-blue at their 98th percentile, annot in the parcellation's own colours,
  flags = the profile column's QC scores on the shared grey→red ramp. Medial
  wall transparent; map is alpha-blended under the overlays
  (`vertex_map_scale`/`vertex_colors`, `viewer/surface3d.py:604-678`;
  `flag_ramp` `:588-601`; `PALETTE_W = 4096` palette texture `:679-700`).
- Surface-layer colouring (`viewer/surfacelayers.py:112-175`) mirrors the slice
  semantics: `vertex_rgba`/`layer_rgba` apply range/sign/threshold/alpha and
  label palettes to per-vertex values, with `OUTLINE_NONE/BOXED/ONLY`
  (`viewer/surface3d.py:442`) matching boxed/edges.
- Surface clusterization runs on the mesh (areas, mesh adjacency, the bucket's
  own SurfClustSim table) and paints back per vertex for every consumer
  (`surface_clusterize`, `viewer/surfacelayers.py:176-290`;
  `session.clusterize` branch at `viewer/session.py:2409-2455`).

### 7.6 Picking

`pick(origin, direction, positions, faces)` is Möller–Trumbore over every face at
once, returning `(face, barycentric, distance)`; ~20–40 ms per hemisphere, which
a click can afford and which avoids keeping a BVH in step with edits
(`viewer/surface3d.py:402-443`). `Camera.ray` builds the world ray from NDC
(`:232-315`); `SurfaceCanvas.pick_vertex`/`pick_mm`/`_hit_face` convert a widget
position through the camera and then the hit's barycentric coordinates to a
vertex (`viewer/ui/surfacewindow.py:1020-1070`). Hit-testing on the slice pane is the
2-D analogue (`viewer/ui/panes.py` gestures).

### 7.7 Editing (grab, draw, point, nudge, highlight)

Surface editing is a first-class pipeline, not a side feature:

- **Tools**: `grab` (drag an outline toward where it belongs), `draw` (press on
  an outline, draw where it should run, release on the same outline — the
  stretch moves onto the line and the surface around follows), `point` (select a
  vertex; Delete removes it, `i` splits its longest edge, `shift+I` all its
  edges), `nudge` (`SET_SURFACE_TOOL`, `viewer/vocab.py:743-772`;
  bindings in `viewer/ui/imagewindow.py:491-590`).
- **Brush**: radius mm, snap 0–1, smoothing, search mm each side, edge sign
  (−1 = T1, +1 = T2); validated (`SET_SURFACE_BRUSH`,
  `viewer/vocab.py:568-581`, `viewer/state.py:206`). Snap-to-edge can be gated
  to the boundary's expected intensity (`SET_SURFACE_SNAP_GATE`) or ungated
  (`m` cycles snap → ungated edge → hand), `SET_SURFACE_SNAP` chooses the layer
  to snap to (empty = bottom of stack), `SET_SURFACE_FREE` makes hand moves
  follow the drag instead of normals, `SET_SURFACE_STEP` sets nudge distance
  (`viewer/vocab.py:582-621`).
- **Gesture model**: commands carry the *gesture*, not the coordinates:
  `EDIT_SURFACE` = press (hemi, surface, vertex, at-mm), drag vector, brush, snap
  key; `EDIT_SURFACE_STROKE` = axis/position of the slice, a stroke in mm, and
  optionally the tilted grid it was cut in. Replaying the script on the same
  image reproduces the same displacement from a few lines instead of embedding
  100k coordinates (`viewer/vocab.py:622-700`).
- **Preview then commit**: `SurfaceStore.grab/begin/preview/apply/cancel` keep a
  pending edit keyed by its parameters so the committing command does not
  recompute what is already on screen (`viewer/surfaces.py:1116-1288`).
- **Topology edits** are edge collapse / edge split applied to *every* surface
  and per-vertex file of the hemisphere through a `MeshBundle`, refused when it
  would pinch the mesh or turn a triangle over on any surface
  (`DeleteSurfaceVertex`/`SplitSurfaceEdge`, `viewer/vocab.py:713-742`;
  `SurfaceStore.delete_vertex/split_edge`, `viewer/surfaces.py:1081-1115`;
  `surface/topology.py`).
- **Undo** restores positions or the whole mesh bundle for topology edits
  (`UNDO_SURFACE_EDIT`, `viewer/surfaces.py:1364-1383`).
- **Highlighting** (marking cortex to move or make an ROI) is a per-hemisphere
  vertex-id mask shared by *all* windows — `HIGHLIGHT_SURFACE` (add/remove/set,
  ids as ranges), `MOVE_SURFACE_HIGHLIGHT` (move along normals, optional
  `within` ranges, flatten, snap, even spacing), saved at
  `viewer/surfaces.py:586-730`; selections made in a slice, the 3-D window or
  CHEDI show everywhere (`viewer/ui/chediwindow.py:1-20`).
- **Saving/installing**: `SAVE_SURFACES suffix` writes `?h.<surface>.<suffix>`
  next to the originals plus an edit log; `ctrl+shift+S` is the dialog;
  install (`ctrl+shift+I`) replaces originals with backups after asking
  (`SAVE_SURFACES` `viewer/vocab.py:854-864`, `SurfaceStore.install_plan/
  install/save`, `viewer/surfaces.py:1391-1524`; `viewer/ui/window.py:1004-1062`).
- **LayNii export**: `ctrl+shift+L` voxelises the meshes *as shown* (edits,
  unsaved, included) and writes the `LN2_LAYERS` outputs — rim, equidist/
  equivol metrics and layers, midGM sheets, thickness (`viewer/layerexport.py:1-12`,
  `surface/volume_depth.py:40-49`).

### 7.8 Surface-related windows

- **3-D surface window** (`SurfaceWindow`, `viewer/ui/surfacewindow.py:1139`): Qt RHI
  (Vulkan/OpenGL/Metal/D3D) with precompiled shaders in
  `viewer/shaders/*.qsb`; shape buttons/keys, hemi toggles, split/hinge,
  depth window `[`/`]`/`{`/`}`, depth statistic `d`, equivolume `e`, map `m`,
  folding `k`, sampling `n`, camera views `v`/`shift+V` (top, left lateral,
  left medial, right lateral, right medial, front, back, bottom —
  `viewer/surface3d.py:219-231`), reset `0`, paint mode `p`, fill by outline,
  ROI save/load, highlight moves, animate `a`, vertex graph `g`, centre `c`,
  crosshair `x`, drag rotate / alt-drag turn one hemisphere / ctrl-drag hinge /
  ctrl+shift-drag split (`viewer/ui/surfacewindow.py:1380-1435`, `:1670-1730`).
- **CHEDI** (`ChediWindow`, `viewer/ui/chediwindow.py:321`): a piece of cortex flattened
  around the vertex nearest the crosshair, anatomy sampled onto it at one depth,
  from white (0) to pial (1) and past both, so a pial in dura or stopping short
  is visible; the wall is the underlay in grey, overlay layers are coloured over
  it in their own bars; selection shared with every other window; "push" moves
  selected and visible vertices along normals as a unit; also k-means clusters
  on what is shown (1–10 keys, spatial weighting) and selection morphology
  (`viewer/ui/chediwindow.py:1-20`, `:415-520`, `viewer/chedi.py:1-15`).
- **Depth window** (`DepthWindow`, `viewer/ui/depthwindow.py:379`): region grows from
  the crosshair by geodesic disc (radius mm), the parcel it is in (`annot`), or
  an ROI layer's region; shows overlay vs cortical depth (mean, spread, every
  vertex faintly), depth x time heatmap for a 4-D layer, EXPORT writes
  `(n_time, K)`; PIN keeps previous datasets as traces; equivolume `e`, follow
  `f`, detrend `d` (`viewer/ui/depthwindow.py:1-30`, `:470-520`;
  `SET_DEPTH_VIEW` `viewer/vocab.py:1065-1079`). Depth ROIs are published back
  to `SurfaceStore.depth_roi_vertices` so a surface window can show them
  (`viewer/surfaces.py:151-156`).
- **Profile column (QC)** (`ProfileWindow`, `viewer/ui/profilewindow.py:211`): every
  vertex's intensity profile along the white→pial line, extended past both ends,
  with tube averaging; rows ordered back-to-front in coronal slabs and around
  each slab's ring so neighbouring rows are neighbouring cortex; columns are
  fraction (white/pial on fixed columns) or mm; flags are robust z-scores
  (`pial_out`, `pial_short`, `white_deep`, `white_shallow`, `nonlinear`;
  `worst` = max of the four); clicking a row moves the crosshair, edits re-sample
  only the moved vertices; zoomed out a row shows the *most suspicious* vertex
  not the mean (`surface/profiles.py:1-15`, `:297-371`; `viewer/profilecolumn.py:1-9`;
  keys `m`, `(`, `)`, `s`, `n`, `p`, `f`, `+`/`-`/`0`).
- **Vertex graph** (`VertexGraphWindow`, `viewer/ui/vertexgraph.py:107`): time courses
  of the vertices within N mesh rings of the crosshair, each cell at that
  vertex's own place on a flattened patch laid out by geodesic distance and
  oriented to the camera; shared y-scale, overlay tint, detrend, hex lattice
  option; open with `g` from the 3-D window (`viewer/vertexpatch.py:1-16`,
  `viewer/ui/vertexgraph.py:1-10`, `:199-260`).

---

## 8. Time series, graphs, carpet, matrix, clusters, traces

### 8.1 Graph window (voxel time courses)

`GraphWindow`/`GridGraph` (`viewer/ui/gridgraph.py:231`, `:472`): an N×N grid of voxels
around the crosshair, N stepped with `+`/`-` (1–16, `MIN_GRID`/`MAX_GRID`
`viewer/viewports.py:54-55`), one `paintEvent` for the whole grid. Per window:
which layers to plot (`traces`; empty = every time-linked layer), which lines to
hide (`hidden`; `mode:<ident>` for a mode's line), shared y-scale, overlay tint
of the cell, and design regressors as `run:col:path` pins
(`viewer/viewports.py:134-148`; `SET_VIEW_*` commands). Graph defaults to
detrend `-1` (none) because "a time course drawn in its own units is what a
graph is for" (`viewer/viewports.py:382-395`). Keys: `+`/`-`, `s`, `o`,
Left/Right or `,`/`.` to step time, click to jump, `h`, `ctrl+W`.

Design regressors are recovered from the stats bucket's `HISTORY_NOTE` GLM
command line and xmat `RunStart`, so "which regressor belongs to this run" has
an answer on disk; when the chain breaks nothing is drawn
(`viewer/design.py:1-16`).

### 8.2 Carpet (grayplot)

`CarpetWindow` paints a `(rows, T)` array into a QImage; built on the worker
(`viewer/ui/carpetwindow.py:1-10`). Row order (`ORDERINGS = voxel, pc1, seed, overlay,
roi` — acquisition order, corr with PC1, corr with the seed voxel, overlay value,
corr with the overlay's ROI mean; `viewer/carpet.py:52-62`), detrend order
(default 1 for a carpet), scaling `z` or `psc`, source layer = the window's
traces selection (`viewer/viewports.py:150-168`). Automasking, normalisation and
binning are shared with the matrix through `viewer/series.py:1-20` so the two
windows cannot disagree about which voxels are brain. Click jumps to that
volume and voxel; dragging rows selects them and makes a red overlay layer of
those voxels (`viewer/ui/carpetwindow.py:324-345`; `session.build_carpet`
`viewer/session.py:1084`).

### 8.3 Matrix (connectivity)

`MatrixWindow` paints a `(K, K)` matrix with node-colour strips and diagonal
module separators where a hierarchical ordering found a boundary
(`viewer/ui/matrixwindow.py:1-16`). Nodes are either ROI layers (rows have names) or,
without one, bins of voxels grouped by how they move — never a voxelwise matrix
(`viewer/matrix.py:1-20`). Orders: `hierarchical` (default), `input`, `pc1`,
`strength`, `size` (`viewer/matrix.py:56-64`). Clicking a cell draws both
nodes' time courses and moves the crosshair to the row's node below the
diagonal, the column's above (so "the other end of the edge" is one click)
(`viewer/ui/matrixwindow.py:1-16`). Detrend and ROI source are per window; the worker
builds it (`session.build_matrix`, `viewer/session.py:1140`).

### 8.4 Clusters

`ClusterWindow` turns the thresholded map into a table: size, volume mm³ (or
mm² on a surface), peak value and coordinates, centre of mass, and the corrected
alpha each cluster earned when the dataset carries its own ClustSim tables
(`viewer/ui/clusterwindow.py:1-14`, `viewer/clusters.py:44-102`). It is rebuilt as the
threshold moves (milliseconds, so not on the worker), with NN1/NN2/NN3
neighbourhood, minimum voxels (or an alpha read off the ClustSim table), hide
small / display-mask filtering, and a "within" layer whose brain bounds the map.
Clicking a row jumps to the peak; MAKE ROIS turns the table into an ROI layer
(`viewer/ui/clusterwindow.py:112-260`; `session.clusterize`
`viewer/session.py:2375-2460`). The table always uses the layer's own threshold:
"clusterizing at a threshold other than the one on screen produces a table that
does not describe the picture beside it" (`viewer/clusters.py:1-22`).

### 8.5 Trace windows

A mode names its panels; each gets its own window with its own size, titled by
panel name (`viewer/session.py:1005-1021`; `SET_VIEW_PANEL`). Panels found:
ICA/InstaPCA/InstaICA `timecourse` + `spectrum` (+ `scree` for the Insta modes),
InstaGLM `hrf`, RGB `channels` + `colour axes`. The trace window is also where a
mode is driven from during review: Left/Right step components, `s`/`n` label,
`u` clears, `k` keeps (`viewer/ui/tracewindow.py:1-10`, `:244-260`). The same review
keys are repeated in image windows (`<`/`>`, `s`, `n`, `u`) so the decision can
be made on the map (`viewer/ui/imagewindow.py:596-603`).

### 8.6 Playing time

`Player` steps one frame after every visible 3-D canvas has submitted its frame,
so no frame is skipped and the rate is whatever the open windows can draw, capped
so a light scene does not race (`viewer/ui/player.py:1-10`). Animation in a 3-D window
is `a`; in the controller `v` (`viewer/ui/window.py`, `viewer/ui/surfacewindow.py`).

---

## 9. Scripting, persistence, geometry

### 9.1 Recording and replay

- Every dispatched command is recorded (unless `record=False`), and
  `session.to_script(header=...)` renders the history as a replayable script
  (`viewer/commands.py:309-325`, `:403-418`).
- `ctrl+S` opens save-session-script (`viewer/ui/window.py:2460-2468`); the CLI `-script`
  replays a script before showing the window (`cli/viewer.py:146-150`);
  `-no_window` replays headless and prints the resulting script
  (`cli/viewer.py:303-338`). The headless path shares session and command path
  with the GUI, so a script that works there works in the GUI.
- Replay is driven through the same handlers; load/major commands are separated
  by blank lines; superseded non-major runs are collapsed per target
  (§1.2). Replaying `OPEN_VIEW` with an already-open id is a no-op; replaying
  `CLOSE_VIEW` of a missing id is a no-op, so scripts are forgiving
  (`viewer/vocab.py:2360-2382`).
- The script is the reproduction, not a description: `DEBUG` writes a report
  containing the full state *and* the recorded script
  (`viewer/report.py:1-16`; `viewer/ui/window.py:2483-2508`).

### 9.2 Reopen command vs session script

`ctrl+P` prints (and copies) the `ffs_viewer` command line that reopens *what is
loaded now*: the directory, the stack's files bottom-first by absolute path, the
subject's surfaces (and meshes added beside them), and surface results
(`-surf_data`); computed layers that have no file are listed after a `#`
(`viewer/session.py:1983-2036`). It deliberately does **not** restore edits,
display settings or windows — that is the session script (`ctrl+S`). The two
are complementary: files/directories vs session state.

### 9.3 Geometry, layout, preferences

- Window placement is state: `SET_VIEW_GEOMETRY` stores `(x, y, w, h)` and the
  manager writes it on move/resize so a saved session comes back tiled
  (`viewer/viewports.py:243-244`, `viewer/vocab.py:408-420`,
  `viewer/ui/manager.py:641-670`). Tiling/staggering computes positions from
  peers across controllers (`viewer/ui/manager.py:485-640`).
- Favourite directories persist in one JSON file,
  `$XDG_CONFIG_HOME/fastfuncstuff/viewer.json` (`viewer/favorites.py:1-10`).
- The theme is state, not a widget setting, so a recorded session comes back
  looking as it was recorded (`viewer/state.py:189`); the palette flips all
  interface chrome, crosshair, labels, trace colours and the bar frame, but never
  the *data* colours ("a colour scale is a claim about values") and a light/dark
  toggle is `SET_THEME` (`viewer/ui/theme.py:1-25`, `viewer/vocab.py:152-161`).

### 9.4 Headless CLI surface (startup options that shape behaviour)

`ffs_viewer` accepts: positional datasets (= `-read`), `-read PATH...` (a
directory fills pickers; files load as layers; takes every path after it),
`-script FILE`, `-no_window`, `-surfaces SUBJ_DIR`, `-surf_space MESH`,
`-mesh FILE` (repeatable), `-surf_data FILE` (repeatable), `-device`, and
`-vram_budget` (`cli/viewer.py:135-207`). `SIGUSR1` prints every thread's Python
stack to stderr for diagnosing a frozen viewer (`cli/viewer.py:245-275`).
Dropping files/folders/FreeSurfer subjects on any viewer window routes each path
by kind (subjects → load surfaces, directories → read, datasets → load, meshes →
mesh list), and a BRIK stands for its HEAD (`viewer/catalog.py:186-232`;
`viewer/ui/window.py:2524-2593`; `tests/viewer/test_file_drop.py`).

---

## 10. Keyboard and mouse controls

The key tables are data, used both for installation and for the `h` help, per
window (`viewer/ui/shortcuts.py:1-9`, `:337-355`). Below is the complete inventory by
window. Modifier spelling is as in the source (`shift+`, `ctrl+`, `alt+`).

### 10.1 Controller (`viewer/ui/window.py:2011-2178`)

| Keys | Action |
|---|---|
| `Left`/`Right`, `Down`/`Up`, `PgUp`/`PgDn` | crosshair −x/+x, −y/+y, −z/+z |
| `j` (via `jump_back_key`) | jump back to where the crosshair was before its last jump |
| `n` / `shift+N` | open an image / graph window |
| `shift+C` / `shift+M` | open carpet / matrix |
| `f` / `shift+F` / `r` | tile / stagger / raise every window |
| `\` | tile the images inside every image window |
| `d` | dark / light palette |
| `,` / `.` | previous / next volume (or the selected non-time layer's sub-brick, one Coef group at a time when THR follows at +1/+2) |
| `<` / `>` | previous / next sub-brick of this layer |
| `v` | play / pause |
| `[` / `]` | select previous / next layer |
| `o` / `space` | show / hide the selected layer |
| `shift+O` | flip the overlay against the layer under it (press again to swap back) |
| `t` / `shift+T` | threshold down / up |
| `c` | next colormap |
| `s` | next sign mode |
| `a` | next alpha mode |
| `b` | toggle boxed |
| `e` | cycle how the layer is drawn (auto/nearest/linear) |
| `{` / `}` | move layer down / up the stack |
| `u` | make it the underlay |
| `shift+S` | save the layer to a file |
| `Del` / `Backspace` | remove the layer |
| `ctrl+T` | open another controller |
| `ctrl+1..5` | controller A..E |
| `ctrl+O` | read a directory |
| `alt+O` | cycle surface outlines |
| `shift+V`, `shift+E`, `shift+L`, `shift+P` | 3-D surface, CHEDI, depth profiles, profile column |
| `ctrl+M` | mesh list |
| `ctrl+shift+I` / `ctrl+shift+S` | install edited surfaces / save edited surfaces as copies |
| `ctrl+shift+L` | LayNii layers from the surfaces as shown |
| `ctrl+L` | load the chosen dataset |
| `ctrl+S` | save session script |
| `ctrl+P` | print/copy the reopen command |
| `h` | this list |

### 10.2 Image window (`viewer/ui/imagewindow.py:355-640`)

Plane `1`/`2`/`3` = axial/sagittal/coronal; arrows nudge in plane;
`PgUp`/`PgDn` next/previous slice; `o`/`shift+O` show-hide / flip underlay;
`shift+S` solo; `\` tiles; `alt+V` values box; `+`/`=`/`-`/`0` zoom, fit; `c`
centre (double-tap `c` = every window); `t` tilt to cut cortex square-on,
`shift+T` untilt, alt+arrows tilt 5°; `alt+O` outlines both/white/pial/off;
`[`/`]` outline width; right-drag zoom, middle/shift-drag pan, scroll slices;
`l` lock cycle (off/park → Lock → LOCK shared zoom); `x` crosshair style;
`,`/`.` time or sub-brick; click crosshair, `ctrl+click` InstaCorr seed; `e`
edges; `6` opacity slider; surface editing: `g` grab, `shift+G` draw, `p` point,
`b` nudge, `v` mark cortex, `shift+V` clear mark, `{`/`}` step size,
ctrl+Up/Down move marked pial, ctrl+shift+Up/Down move marked white,
`Delete`/`Backspace` delete selected vertex, `i`/`shift+I` split edge(s),
`(`/`)` brush size, `f` follow drag vs normals, `m` snap mode, `ctrl+Z` undo,
`Escape` cancel; align mode: drag ring to turn, drag centre/shift-drag to slide;
review keys `<`/`>` step, `s`/`n`/`u` label; strip `k` on/off, `shift+K` count,
alt+PgUp/PgDn spacing, alt+`+`/`-` zoom, click a cell/right-drag a cell;
`shift+N` graph on this plane; `h`; `ctrl+W` close.

### 10.3 Graph window (`viewer/ui/gridgraph.py:622-640`)

`+`/`-` more/fewer voxels; `s` shared scale; `o` tint by overlay; Left/Right
(`.`/`,`) step volume; click jump; `h`; `ctrl+W`.

### 10.4 Carpet (`viewer/ui/carpetwindow.py:324-338`)

`o` next row order; `r` rebuild; click jump to that volume and voxel; drag rows
→ red overlay layer; `h`; `ctrl+W`.

### 10.5 Matrix (`viewer/ui/matrixwindow.py:368-382`)

`o` next node order; `r` rebuild; click plots the pair and jumps (row below
diagonal, column above); `h`; `ctrl+W`.

### 10.6 Clusters (`viewer/ui/clusterwindow.py:251-268`)

`m` make an ROI layer; `r` recompute; click jump to peak; `h`; `ctrl+W`.

### 10.7 Trace (`viewer/ui/tracewindow.py:244-258`)

Right/Left (`.`/`,`) next/previous component; `s`/`n` label signal/noise; `u`
clear; `k` keep; `h`; `ctrl+W`.

### 10.8 3-D surface (`viewer/ui/surfacewindow.py:1380-1435`)

Shape keys from `_SHAPE_KEYS` (mapped to mid/white/pial/inflated/sphere/flat);
`shift+L`/`shift+R` show/hide hemisphere; `>`/`<` split apart/together; `[`/`]`
depth window shallower/deeper; `{`/`}` window width; shift+scroll slide depth
window; `e` equivolume; `d` depth statistic; `m` vertex map; `c` centre (double
= all); `x` crosshair style; `g` vertex graph; `a` animate; `k` folding; `n`
sampling; `v`/`shift+V` next/previous camera view; `0` reset camera; drag rotate,
alt-drag turn one hemisphere, ctrl-drag hinge, ctrl+shift-drag split; `o` open
hinge cycle; `p` paint mode; shift+drag fill outline in paint mode; `s` save ROI
labels; `l` load ROI labels; `shift+P` clear highlight; `(`/`)` brush; ctrl+arrows
move highlighted surfaces; `r` highlighted cortex → ROI layer;
`-`/`=` move step; right-drag zoom, middle/shift-drag pan, scroll zoom; click
crosshair, ctrl+click seed; `h`; `ctrl+W`.

### 10.9 CHEDI (`viewer/ui/chediwindow.py:415-520`)

`[`/`]` shallower/deeper; scroll depth 0.05; `ctrl+0`/`ctrl+1` mid/pial; `c`
clusters; `1..9,0` toggle clusters; `k`/`shift+K` more/fewer clusters; `x`
spatial weighting; `+`/`-` patch size; `shift+M` mesh overlay; `n` sampling;
`l` grey-wall layer; shift+click / double-click centre; drag select, right-drag
unselect, ctrl+drag select by value; `a` erode, `d` dilate, `e` drop isolated,
`v` invert, `Escape` clear selection; `(`/`)` brush; `h`; `ctrl+W`.

### 10.10 Depth (`viewer/ui/depthwindow.py:470-490`)

`e` equivolume; `(`/`)` disc radius; `f` follow/pin region; `p` pin dataset,
`shift+P` clear pins; `d` detrend order; click heatmap jumps to volume; `h`;
`ctrl+W`.

### 10.11 Profile (`viewer/ui/profilewindow.py:256-280`)

`m` fraction/mm; `(`/`)` tube radius; `s` next flag; `n`/`p` next flagged row
below/above; `f` follow crosshair; `+`/`-`/`0` zoom/fit; scroll move (ctrl
zoom); click moves crosshair to that vertex; `h`; `ctrl+W`.

### 10.12 Vertex graph (`viewer/ui/vertexgraph.py:199-220`)

`+`/`=`/`-` rings; `d` detrend; Right/Left (`.`/`,`) time; `s` shared scale;
`o` overlay tint; `x` hex lattice vs exact; click jumps to time point;
double-click moves crosshair to that vertex; `h`; `ctrl+W`.

### 10.13 Mouse summary

- **All slice panes**: left click = crosshair; ctrl+click = InstaCorr seed;
  right-drag = zoom; middle-drag or shift+drag = pan; wheel = slice step
  (`viewer/ui/panes.py:70-110`, `viewer/ui/imagewindow.py:459-482`).
- **Paint mode**: left drag paints, right drag erases, ctrl+wheel resizes the
  brush; pan stays shift/middle and slices stay wheel (`viewer/modes/paint.py:1-8`).
- **Surface editing**: near an outline a press grabs it (when editing is on)
  rather than moving the crosshair; drag previews, release commits; Escape
  cancels (`viewer/surfaces.py:1116-1226`).
- **3-D window**: drag orbit, alt-drag turn one hemisphere, ctrl-drag hinge,
  ctrl+shift-drag split, right-drag zoom, middle/shift-drag pan, scroll zoom,
  click selects the nearest vertex (or moves the crosshair), ctrl+click seed.

---

## 11. Supported file formats

From the catalog's suffix and drop tables (`viewer/catalog.py:31-114`,
`:186-232`) and the loaders:

| Kind | Formats |
|---|---|
| 3-D/4-D volumes | `.nii.gz`, `.nii.zst`, `.nii`, `.mgz`, `.mgh`, AFNI `.HEAD` (voxels in `.BRIK`/`.BRIK.gz`; a BRIK alone stands for its HEAD) |
| Surface data (per-vertex results) | `.func.gii`, `.shape.gii` — loaded as a layer once its mesh is present |
| Surface meshes | GIFTI `.surf.gii`, and FreeSurfer triangle surface files (no extension — content-sniffed), by name (`lh.pial`, `rh.white`, …) or via a subject directory |
| FreeSurfer subject | `surf/{lh,rh}.{white,pial,inflated,smoothwm,sphere}`, `label/*.annot`, `label/*.label`, `mri/<name>.mgz` for volume atlas, `surf/*.sphere.reg` for template projection |
| Session scripts | plain text, `ffs_viewer -script FILE` (`.ffs` by convention) |
| Regressors / designs | AFNI `.1D`, `.xmat.1D` (ColumnGroups say which columns are nuisance), motion/physio/ortvec 1D files; `.aff12.1D` for the aligner bridge |
| ClustSim tables | attached AFNI-format tables carried by a stats bucket (`ffs_clustsim`, `ffs_reml -clustsim`) |
| Layer export | NIfTI for volumes (`SAVE` layer), FreeSurfer surface files for meshes, `.label`/`.nii.gz` for surface ROIs, LayNii depth volumes for the surface-as-shown export |
| Colour/RGB | a session's `colour_sources` are built from loaded channel layers, not a special file type (`viewer/layers.py:164-168`) |

Discovery: `READ` lists only openable suffixes, skips a BRIK whose HEAD is
present, sorts naturally (`run-2` before `run-10`), and drops files that fail to
open rather than failing the directory (`viewer/catalog.py:108-165`, `:228-297`).
`READ_FILES` fills the catalog from named files **without opening their
directories**, the safe choice on a synced folder (`viewer/vocab.py:487-498`,
`cli/viewer.py:135-145`, `tests/viewer/test_read_files.py`). Rescan marks new and
rewritten files, and an overwritten dataset is reloaded in place
(`viewer/catalog.py:325-395`, `tests/viewer/test_rescan.py`).

---

## 12. Tests that pin behaviour

`tests/viewer/` contains **65** test files. They are the best executable
specification of the behaviours above; a rebuild should port them (or equivalent
assertions) or knowingly drop them. One-line purpose from each file's docstring:

| Test file | Pins |
|---|---|
| `test_align.py` | hand-moved layers produce the same matrix the CLI aligner gets; follower layers ride along |
| `test_align_ui.py` | align-mode gestures: ring turns, centre slides, screen→world arithmetic |
| `test_carpet.py` | carpet readability and the ways it could quietly lie (ordering, scaling, masking) |
| `test_chedi.py` | CHEDI patch sampling / flattening around the crosshair |
| `test_chroma.py` | RGB mode colour maths and basis fits |
| `test_clusters.py` | cluster table describes the picture: sizes, peaks, signs, ClustSim alpha |
| `test_colormap.py` | a voxel at threshold fully opaque, at zero fully transparent, alpha ramps, sign modes, NaN |
| `test_commands.py` | recorder honesty: round-trip, handler reporting, supersede/collapse, major events |
| `test_compose.py` | state→pane images without Qt; screenshot path equals screen path |
| `test_controller_fit.py` | controller is as tall as what it shows |
| `test_controls.py` | generic control panel layout, `visible_when` keeps its space, path lists |
| `test_depthwindow.py` | depth profile over a region and its export |
| `test_derive.py` | nuisance projection removes the right things and keeps the rest |
| `test_design.py` | regressors come from the right run/column; broken chains draw nothing |
| `test_directories.py` | numbered directory list and favourites |
| `test_edges_opacity.py` | edges and opacity as the two alignment looks, in rendered pixels and keys |
| `test_file_drop.py` | drops route by kind, folders listed unread |
| `test_frame_step.py` | `,`/`.` step time, or the selected non-time layer's bricks |
| `test_graph_across_grids.py` | reading a layer at the crosshair when it is not on the display grid |
| `test_grid_res.py` | finer display grid draws fine overlay at its own resolution; position carried |
| `test_gridgraph.py` | what a volume step redraws; how a trace is built |
| `test_image_header.py` | image window header: view row and surface tools |
| `test_instaglm.py` | GLM engine invariants (joint-model beta etc.) |
| `test_instaglm_mode.py` | fit/view split; changing what you look at does not refit |
| `test_instaica.py` | spatial ICA of the run under review |
| `test_instapca.py` | PCA arithmetic and the review loop ending in an ortvec |
| `test_layerexport.py` | LayNii export uses on-screen surfaces, edits included |
| `test_lock_zoom.py` | LOCK shares zoom + one centre point, not a copied pan |
| `test_matrix.py` | matrix is of the data, not of the ordering; ROI vs bin nodes |
| `test_meshlist.py` | multiple meshes per hemisphere; top-most in use |
| `test_mode_input.py` | what a mode reads is independent of what is drawn |
| `test_oblique.py` | tilted windows and tilt-to-cut-cortex |
| `test_ortvec.py` | ortvec grammar, derivatives, band splitting |
| `test_overlay_controls.py` | colour one sub-brick, threshold on another; p preserved, range from the shown brick |
| `test_paint.py` | PAINT mode: integer-label ROIs on the slices |
| `test_pane_gestures.py` | right-drag zoom, middle/shift pan on a slice pane |
| `test_panel_sizing.py` | controller panel fits in the controller |
| `test_picker_preview.py` | picker previews; only double-click/Enter loads |
| `test_player.py` | one frame after the last is drawn |
| `test_preproc.py` | tools make a dataset, output lands next to its input, re-run replaces |
| `test_preproc_tools.py` | smoothing and slice-timing do what they claim |
| `test_profilecolumn.py` | profile order, zoomed-out row rule, cortex mask, edits |
| `test_profilewindow.py` | click goes to the vertex; crosshair brings the column |
| `test_pthreshold.py` | AFNI value parity for p↔stat thresholds |
| `test_read_files.py` | named files load, no directory is opened |
| `test_resample_and_report.py` | resampling is display-only; written session report |
| `test_rescan.py` | new/overwritten files show up and reload |
| `test_residency.py` | tiered reading; one slice does not read a whole 4-D file |
| `test_rois.py` | ROI sets: what makes a parcellation mean anything |
| `test_selector_modes.py` | selector invariants; mode framework |
| `test_shortcuts.py` | held-key auto-repeat queueing |
| `test_slicing.py` | resampling orientation with asymmetric data |
| `test_strip.py` | neighbour strip slices |
| `test_surface3d.py` | CPU side of the 3-D view: textures, cameras, picking, layout |
| `test_surface_layers.py` | surface results are layers; slices and vertices agree |
| `test_surface_render.py` | shader matches the CPU reference (GPU) |
| `test_surface_window.py` | surface window logic: commands, uploads, picking |
| `test_surfaces.py` | outline intersection, editing, mesh list, ROI save/load |
| `test_tcorr_mode.py` | tCorr mode |
| `test_timeview.py` | detrended/PSC frame display |
| `test_ui.py` | the controller's construction and basic wiring |
| `test_vertexgraph.py` | vertex graph patch/time courses |
| `test_vertexpatch.py` | geodesic patch layout |
| `test_viewports.py` | viewport records, id minting, titles, per-kind properties |
| `test_widgets.py` | row-sized lists, value delegate, preview combo, file drop |

Beyond `tests/viewer/`, the surface/sampling package is pinned by
`tests/test_surface_*.py` (geometry, mesh, sampling, profiles, ribbon,
voxelize, volume depth, edit, outline, mask, remap, projection, statmap,
topology, smoothing), and the mode engines/CLIs by their own tests
(`tests/test_instaglm*.py`, `test_insta*.py`, `test_denoise*`, etc. — full list
in `reference/fastfuncstuff/tests/`).

---

## 13. Behaviours judged especially important to preserve

Stated here because they are the ones a rebuild is most likely to approximate
into something that still looks like a brain map but means something else:

1. **Threshold statistics are not the displayed sub-brick.** A stats bucket
   colours by a coefficient and thresholds on its t; the threshold may follow
   the displayed brick (`same`/`next`/`next2`) or be fixed, and its p is
   preserved across statistic changes (§5.4). The p↔stat conversion uses the
   bucket's own `stataux` (test and dof) — not a guessed dof.
2. **Sub-threshold voxels fade, they do not vanish** (alpha ramps), and
   `boxed` keeps the survivor boundary readable; NaNs are transparent in every
   mode (§5.5).
3. **`auto` resampling decides by direction.** A coarse functional drawn on a
   fine anatomical is upsampled nearest so its voxels stay visible and its
   cluster edges do not gain resolution they do not have; a finer layer is
   downsampled linear; label layers are always nearest (§5.6).
4. **Range derivation is percentile-based and shape-aware**: 2/98 percentiles,
   symmetric+diverging only for a coefficient or a genuinely balanced signed
   map, one-sign maps from 0, statistics start at p = 0.001, `range_fixed`
   respects a typed scale (§5.3).
5. **Surface data is sampled at a depth between the white and pial *points*, in
   the fragment shader**, so it shows the data's own resolution on any mesh
   shape; **equivolume depth is the default**, samples can be averaged with six
   3dVol2Surf-compatible statistics, and the same reduction picks the threshold
   statistic (§7.4).
6. **The displayed colour and the displayed threshold always describe the same
   point** — including the depth-selection statistics (a colour from the max
   depth is cut on that depth's statistic) (§7.4).
7. **Parked slices and LOCK.** An unlocked window keeps its slice while the
   crosshair navigates elsewhere; LOCK shares zoom *and one mm centre point*
   across windows, not a voxel pan, so an axial pan copied onto a sagittal
   window cannot move it along the wrong axes (§2.2, §6.6).
8. **Models and data live on independent axes.** What a mode reads (`input`),
   what the controls act on (`selected`), and what is drawn (`visible`) are
   three separate pieces of state (§3.1) — adjusting an anatomy's colour must
   not re-point the GLM.
9. **Display-only transformations never touch data.** Resample, grid size,
   layer time view (detrend/PSC), edges, opacity and geometry are display
   settings; graphs, readouts, cluster tables and mode inputs keep reading the
   layer's own voxels on its own grid (§5.6, §5.9, §5.5).
10. **The recording is the session.** User actions, agent actions and replay all
    go through the command bus; if a rebuild adds a control that bypasses it,
    the saved script becomes a lie. Superseded slider runs collapse; loads and
    seeds stay as major events (§1.2, §9.1).
11. **Anatomical orientation is not negotiable.** The plane layout and the
    flips are computed from the affine and live in one place; a transposed or
    mirrored slice still looks like a brain (§6.2).
12. **Per-window identity.** Windows are viewports with stable ids, not planes
    and not a fixed set of three; two axial windows soloed on different layers
    is the registration check, and scripts address windows by id (§2.2, §6.5).

---

## 14. Ambiguities and unverified details

These are places where the clone does not settle the question, or where an
apparent behaviour is declared but not wired. They are listed so a rebuild does
not silently "fill in" a guess:

1. **Pause-on-major replay is declared but not implemented.** `major` /
   `major_events()` exist and are tested
   (`tests/viewer/test_commands.py:302-315`), and `to_script` separates major
   commands, but neither the UI (`-script` is replayed eagerly in
   `viewer/ui/window.py:3266`) nor the headless CLI pauses between them. The *intent*
   is clear from the docstrings; the interactive behaviour is absent in this
   clone.
2. **`-surf_space`/template editing.** Template-mesh viewing is described as
   "view-only: edits are saved from the native mesh" (`cli/viewer.py:174-184`),
   but the exact edit/save routing under a template space was not traced
   end-to-end here.
3. **Undo scope.** Only surface edits (`UNDO_SURFACE_EDIT`) and paint strokes
   (`PAINT_UNDO`) have undo. There is no general command-bus undo of layer
   operations; whether that is a deliberate scope decision or an omission is not
   stated in the source.
4. **`SET_SEED` and `SET_IJK` relationship.** The seed is its own display-grid
   index (`viewer/state.py:185`), set independently of the crosshair;
   ctrl+click sets both (the click moves the crosshair and asks for a seed).
   The code does not guarantee they stay equal if a script moves only one.
5. **`SET_VIEW_TILT`/oblique view persistence.** The tilt is a viewport field and
   is scripted (`SET_VIEW_TILT`), but no UI key saves/restores a named tilt
   preset; `t` computes one to cut the cortex square-on and `shift+T` resets.
6. **Surface-shape morph state.** Window code animates between two shapes, but
   which shape is "current" for sampling is always the anatomical vertex
   positions (white/pial), independent of the drawn shape; the animation is
   display-only. This is implied by `viewer/surface3d.py:1-18` and the shader, but
   there is no explicit invariant test named for morph state.
7. **Window ids for the two non-viewport windows.** `MeshWindow` and
   `VertexGraphWindow` are not in `ViewerState.viewports`, so their existence and
   geometry are not part of a session script. `VertexGraphWindow`'s own comment
   says this is deliberate; `MeshWindow`'s persistence is simply absent.
8. **Unused/legacy commands.** `SET_UNDERLAY`, `SET_OVERLAY`, `ADD_OVERLAY` are
   understood but nothing in the interface issues them (`viewer/vocab.py:465-476`,
   `:1105-1148`); they exist for replaying old scripts and should be supported,
   not removed, in a rebuild that claims script compatibility.
9. **Empty docstrings.** Nine commands carry no docstring in `vocab.py`
   (`CLOSE_VIEW`, `REMOVE_LAYER`, `REMOVE_MESH`, `SET_COLORMAP`, `SET_RANGE`,
   `SET_THRESHOLD`, `SET_VIEW_SHARED_SCALE`, `SET_VIEW_SCALING`, `SET_PAN`); the
   generated reference marks them rather than inventing text. Their behaviour is
   unambiguous from their handler and field names.
10. **Exact GPU rendering parity.** The 3-D path is a Qt RHI/GLSL implementation
    with a CPU twin (`shade_reference`) tested against it
    (`tests/viewer/test_surface_render.py`, GPU-marked). Bit-exact parity across
    graphics backends is not promised; colour arithmetic parity is the test.
11. **Line counts quoted in the brief.** The brief says viewer core ≈11k lines,
    UI ≈19k, modes ≈6.4k, and ~98 commands. Measured here on the pinned commit:
    core `viewer/*.py` ≈27.7k lines *including* modes, `viewer/ui/*.py` ≈18.9k,
    `viewer/modes/*.py` ≈6.4k (the UI and modes figures agree), and **114**
    commands (not ~98). The discrepancy is almost certainly vocabulary growth
    between when the brief's figures were taken and this commit; the inventory
    and the parity matrix use the measured 114.

---

*Generated from the clone by reading, not by running the viewer. Companion
files: [`docs/COMMAND_REFERENCE.md`](COMMAND_REFERENCE.md) (machine-extracted
command table) and [`docs/PARITY.md`](PARITY.md) (feature-by-feature parity with
the Harness rebuild).*
