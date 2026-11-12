# FFS Harness Viewer — Client audit

Audited file: `ffs-harness-viewer/client.js`
Cross-checked against: `ffs-harness-viewer/index.js`, `python/ffsviewer/{server,snapshot,series_ops,surface_ops}.py`,
`docs/API.md`, the bundled FFS sources under `reference/fastfuncstuff/`, and the DeepSeek Harness
Web client surface (`shell.overlay`, theme tokens, React 18, locale, Connection RPC).

No file was modified except this report. The viewer file was being edited concurrently while this
audit ran; findings are anchored to these revisions:

| File | SHA-256 (first 12) | Lines |
|---|---|---|
| `ffs-harness-viewer/client.js` | `9309a6e53797` | 1639 |
| `ffs-harness-viewer/index.js` | `8568e564516a` | 604 |
| `python/ffsviewer/server.py` | `e5d2cd3638ac` | 896 |
| `python/ffsviewer/snapshot.py` | `53441b2f9183` | 157 |
| `docs/API.md` | `c6433327a4a5` | 207 |

If any of those files change, re-check the line numbers before applying fixes.

## Resolution after the audit (lead, same session)

The audit was run while `client.js` was being edited. The following fixes were applied
afterwards and re-checked with the auditor's executable stub (module evaluation,
`apply(ctx)` registration, and SSR of the overlay plus all 17 internal components still
pass; the one stub assertion that now fails is the old "exactly one `ctx.effect`"
expectation, because locale registration was correctly moved into its own effect).

| Finding | Status after fix |
|---|---|
| C1 P0 saved layout pruned before the session loads | **fixed** — `reconcileLayout` returns a saved layout untouched while the viewport list is empty, and layout saves are gated on `snapshot.grid` |
| C2 P1 opening replays saved state over a live session | **fixed** — the client only calls `open` when no dataset is authoritative, and Host `open` is idempotent (`ensureOpen` then return state) |
| C3 P1 stale poll closure / no refresh after commands | **fixed** — poll reads a live `open` ref (350 ms open / 1100 ms closed) and command responses apply `result.state` directly |
| C4 P1 one RPC per pan/zoom/slider event | **partly fixed** — pan and zoom coalesce to one request per animation frame and sliders to one per 70 ms; there is still no local preview before the server responds |
| C5 P1 split sizes inert; divider math wrong | **fixed** — child wrappers use `flexGrow: child.size`, and the divider adjusts only the two adjacent children with the correct cumulative offset |
| C6 P1 surface shift-pan axes/sign | **fixed** — `cameraPan` uses FFS `Camera.pan`'s row axes and signs; orbit now uses the original `2π·drag/height`; right-drag zoom and wheel `0.9**steps` match the original |
| C7 P2 wheel passive | **fixed** — native non-passive `wheel` listeners on both canvases |
| C8 P2 LOCK/follow/resample/range command semantics | **fixed** — LOCK keeps the view locked, follow preserves the zoom link, the bogus per-view `SET_VIEW_SAMPLING` control was replaced by a layer `SET_RESAMPLE` control, and range inputs are controlled and validated |
| C9 P2 feedback / unhandled rejections / show target / loading | **mostly fixed** — dispatch and buttons swallow after logging, `showTarget` is delivered and activates the tab, and the no-layout state shows the error with Retry instead of an endless "Loading"; agent-set `workspace.open` can still be rewritten by the local open-state effect |
| C10 DSH locale/theme rules | **partly fixed** — locale registration is inside `ctx.effect` and key labels use `t()`; most strings remain English literals, the invalid idle token is unused, and imaging canvases keep a dark image background in light theme |
| Tiled view | **not fixed** — `compose.render_viewport` does not implement tiles; the control remains inert and is tracked in PARITY |

The remaining gaps (C4 local echo, C9 open-state arbitration, C10 full localization/light
theme, tiles) are recorded here and in `docs/PARITY.md` rather than silently dropped.

**Placement change after the audit.** The floating `shell.overlay` workspace was replaced
by a docked right-Sidebar tab (`sidebarRightTabs` type + `sidebar.right.pane.tab` body,
opened from a Session-header button, the Sidebar guide, or `ffs_viewer_show`). The overlay
is now used only for an invisible `show` bridge. This removes the overlay pointer-events
and floating-window drag issues and the C1/C2 class of layout/state conflicts; the
SSR-internal-consistency and hook-order checks pass under a real React 18 mount.

The floating version also had a **Rules-of-Hooks crash**: the window-drag `useEffect`
was declared after the `if (!connection) return` early return, so the second render (when
the first snapshot arrived) rendered one more hook than the first and React unmounted
the slot entry — the launcher vanished. The docked rewrite declares every hook before
any conditional return and was mounted under jsdom + React 18 with real effects to prove
the sequence is stable.

---

## How this was verified

1. **Full static read** of `client.js` (module format, hooks order, state machines, event and drag
   math, layout tree mutation, WebGL lifecycle, RPC use) against the Host bridge and the sidecar
   schemas.
2. **Executable stub**, in `/tmp/ffs-ui-audit.HipfzQ` (outside the repo):
   - a mock `window.__ModuleLoader__.load` captured the real module entry;
   - a recording mock `ctx` implemented `effect`, `slots.inject`, `slots.register`, `locale.register`
     and `locale.bind`;
   - the real module was loaded with `factory(require)` using **React 18.3.1 / ReactDOM 18.3.1 from
     the local npm cache** (nothing was installed);
   - `plugin.apply(ctx)` and `ReactDOMServer.renderToString(...)` of the registered overlay entry ran;
   - an instrumented copy of the same source exposed the internal pane components so each could be
     server-rendered against a complete synthetic snapshot.
3. **Pure-helper checks** against the same instrumented copy: `defaultLayout`, `reconcileLayout`,
   `nextViewId`, tab mutation, split-resize arithmetic.
4. **Numeric cross-check** of the WebGL camera against the Python FFS `surface3d.Camera` in the
   project venv, and of the surface-pan formula against `Camera.pan`.
5. **FFS command parser checks** for the exact command lines the client emits.
6. **DSH source checks**: theme token catalogue, overlay-layer pointer-events contract, locale
   registration pattern, React 18 wheel-listener passivity.

Results that matter:

| Check | Result |
|---|---|
| `client.js` evaluation under a mock module loader | pass |
| `factory(require)` → plugin shape `{name, inject, apply}` | pass |
| `apply(ctx)` → exactly one `shell.overlay` entry (`name: shell.overlay, id: ffs-viewer, order: 40`) | pass |
| Locale registration shape (`ctx.locale.register(ns, {en})`, `bind`) | pass (but see R2–R4) |
| SSR of the overlay entry | pass (8 446 chars, contains launcher markup) |
| SSR of `ViewerRoot` + 17 internal pane/control renders | 17/17 pass, no hook-order or TDZ throw at render time |
| WebGL camera matrix vs FFS `Camera.view()/projection()` | matches to float32 rounding (max abs Δ 3.2e-5) |
| Surface shift-pan formula vs FFS `Camera.pan` | **wrong direction/axes** (see C6) |
| Split-resize arithmetic for a 3-child split | **total size changes 3 → 4** (see C5) |
| `reconcileLayout(saved, [])` then `reconcileLayout(pruned, viewports)` | **all tabs dumped into the first group** (see C1) |
| FFS parser on `SET_RANGE A null 6` / `SET_RANGE A  6` | `ValueError` (see C10) |
| React 18.3.1 wheel listener | registered passive → `preventDefault()` ineffective (see C7) |
| `--dsw-alias-state-idle-primary` in DSH theme catalogue | absent (see R1) |

Effects (ResizeObserver, pointer capture, WebGL drawing, drag/drop, polling) do **not** run in SSR;
they were reviewed statically. See “What could not be verified”.

---

## 1. Confirmed bugs

Severity: **P0** user data/layout loss · **P1** core interaction wrong or severe cost · **P2**
functional bug with workaround · **P3** polish/dead code.

### C1 — P0: reopening a saved-but-closed workspace destroys the saved dock layout

**Where:** `ffs-harness-viewer/client.js:205-239` (`reconcileLayout`), `:338-356` (`useLayout`),
`:397-406` (open + `layout.open` sync).

**Why it happens**
- On page load the sidecar is lazy: the first `state` snapshot has the saved `workspace` object but
  **`viewports: []`**, because no dataset/session has been opened yet.
- `useLayout` immediately reconciles the saved docks against that empty viewport list. Every tab is
  “unknown”, so `reconcileLayout` deletes all tabs (`client.js:210-212`); the groups remain empty
  (`:227-236`). The on-disk workspace is not written yet, but the in-memory layout is now empty.
- When the user clicks the launcher, `open` becomes true and the sync effect writes the *UI* open
  flag into the *empty* layout: `setLayout({ ...layout, open })` (`:403-406`). `commit` schedules
  `workspace` save after 450 ms (`:358-367`). That save fires with the pruned layout (or with the
  later “all views in the first group” reconcile, if the session loaded within 450 ms). Remote
  adoption cannot rescue it in between: the layout effect refuses remote changes for 900 ms after a
  local edit (`:350`), which is longer than the save delay. The workspace file on disk is therefore
  overwritten with a layout whose group structure has been destroyed.
- The session then loads; the next reconcile has viewports but its groups are empty, so
  `reconcileLayout` falls back to “first group” (`:215-226`) and puts **all** views (`V1,V2,V3,S1,G1`)
  into `g-slices`, leaving `g-surface`/`g-graph` empty. The split structure is lost permanently.

The exact failure was reproduced with the exported helpers:

```text
reconcileLayout(saved, [])          -> tabs [] ; groups g-slices/g-surface/g-graph all []
reconcileLayout(emptied, 4 views)   -> g-slices: [V1,V2,S1,G1] ; g-surface: [] ; g-graph: []
```

This is the normal path after a user closes the viewer (the close writes `open:false`), reloads the
page, and opens the viewer again.

**Fix (suggested)**
- Do not reconcile or save the workspace until a session is actually loaded: gate both the
  layout effect and the `open` sync effect on `snapshot.grid !== null` (or
  `snapshot.viewports.length > 0`) and on the first `open` having completed.
- Make `reconcileLayout` preserve tabs whose viewport is not in the snapshot yet (render an
  “unavailable” tab) instead of pruning them. Only prune after a loaded snapshot that lacks the id.
- Do not write `layout.open` through the same `commit` path that persists docks; keep window state
  (`open`, panel geometry) in a separate persisted fields/endpoint, or save it only after load.

### C2 — P1: opening the panel replays saved/demo state over any live session (agent work can be lost)

**Where:** `client.js:397-402`; Host `ffs-harness-viewer/index.js:232-240, 253-254, 284-285`;
sidecar `python/ffsviewer/server.py:137-168`.

`open` is called unconditionally the first time the panel opens, without checking
`snapshot.grid`. Meanwhile agent tools are allowed to load and mutate data before anyone opens the
panel (`ffs_viewer_command` → Host `execute` → `ensureOpen` → `open`). When the user then opens the
viewer, the client calls `open` again. The Host bridge also calls `ensureOpen()` for the `open`
endpoint and then issues the requested `open`, so **two `open` operations** happen. Sidecar `open`
with `preset:"auto"` calls `persist.restore_state()`, which replays the saved `viewer.ffs` on top of
the existing session (or loads the demo if no script exists). Any unsaved agent-authored state can be
replayed over, reset (`meta.rev = 1`), or mixed in.

**Fix**
- In `client.js`, call `open` only when there is no live session:
  `if (snapshot && snapshot.grid === null && !snapshot.viewports?.length) call('open', ...)`.
- In the Host, make `open` idempotent: `case 'open'` should return the existing opened state when
  `this.opened` is set, or the client should use a dedicated “ensure loaded” endpoint.
- Also surface the `notice`/`restored` fields from the open result (see A5).

### C3 — P1: polling closure is stale, so the viewer always polls at 1.1 s and never refreshes after a command

**Where:** `client.js:305-316` (poll loop), `:418-433` (`run`).

`tick` closes over `snapshot` from the render that created the effect. The effect depends only on
`[refresh]`, which is identity-stable, so the closure's `snapshot` is the initial `null` forever.
The line

```js
const delay = snapshot && snapshot.workspace && snapshot.workspace.open ? 350 : 1100
```

therefore always evaluates to 1100 ms, even when the workspace is open. Combined with the next point
(`run` ignores the `state` returned by every command and never calls `refresh`), **every click, pick,
pan, zoom, slider move and agent change can be up to ~1.1 s stale before any redraw**, plus the
render round trip.

**Fix**
- Keep the latest snapshot in a ref (`snapshotRef.current = snapshot`) and read the ref inside
  `tick`, or recreate the timer when open/snapshot state changes.
- In `run`, seed the next snapshot from `result.state` (all mutating endpoints return it) or call
  `refresh()` immediately after successful mutations. The same applies to `execute_batch`.
- Consider pausing/backing off polling when the document is hidden.

### C4 — P1: pan/zoom and slider drags issue an RPC per pointer/tick event, with no local feedback

**Where:** `client.js:977-991` (slice pan/zoom), `:1503-1531` (rail sliders), `:418-433`
(`setBusy`/`setLog` on every call).

`onPointerMove` sends `pan` on every pointer move (`:984-986`) and `zoom` on every right-drag move
(`:987-988`). No rAF/debounce/coalescing exists (`panPending` is declared at `:845` and never used).
`run` sets `busy` true/false and appends a `rev …` log line for each command result (`:419-431`), so a
single pan drag can produce dozens of RPCs, dozens of React state updates, log churn, and continuous
command-bar disabling. The same pattern applies to the opacity/threshold/time sliders (`:1503-1531`)
and to depth sliders. Because of C3, none of those commands redraws the pane until the next poll,
so the dominant user experience is “drag sends commands, picture jumps later”.

**Fix**
- Do pointer-move camera/scene work locally (the surface pane already shows this is feasible for
  orbit/zoom), or coalesce pan/zoom to one RPC per animation frame and suppress the per-command log
  and busy state for high-frequency navigation endpoints.
- Add optimistic/local render transforms for slice pan/zoom and sliders, reconciled from the next
  snapshot; debounce slider `execute` (e.g. 50–100 ms) and send the final value.

### C5 — P1: split sizes are stored but never applied to the DOM; dragging a divider has no visual effect, and its math is wrong for 3+ children

**Where:** `client.js:565-585` (`DockView`), `:597-620` (`Divider`), `:700` (fresh group size).

`size` is only used to build the `sizes` array for `Divider` (`:569`) and is written back on drag
(`:580`). `GroupPane` and the recursive `DockView` render with no `flexGrow`/`flexBasis`/`width` from
`size` — verified by search: the only `flex` rules are fixed CSS (`client.js:75-82`). All split
children therefore share space by content, and the workspace file's sizes are cosmetic.
Additionally `onResize` treats `fraction` as if it were the boundary for child `index2`:

```js
const pivot = total * fraction
sizes[index2] = Math.max(0.15, pivot)
sizes[index2 + 1] = Math.max(0.15, total - pivot)
```

For a 3-child split of `[1,1,1]`, `fraction 0.5`, divider index 1, this produces `[1,1.5,1.5]` —
total 4 instead of 3. The helper `cumulative` (`:601`) computes the correct cumulative boundary but
is never used.

**Fix**
- Apply sizes as flex basis: render each direct split child in a wrapper with
  `style={{ flexGrow: sizes[i], flexBasis: 0 }}` (the official `ui-dockkit` does exactly this), or
  compute percentages.
- Compute the new pair from `sizes`/cumulative offsets: `left = sizes.slice(0,index+1).sum()`,
  `right = sizes.slice(index+1).sum()`, then split `left+right` at the pointer and keep other
  children untouched; or, for two children, write sizes directly.
- Account for divider widths (5 px) and group margins when converting pointer position to fraction.

### C6 — P1: surface shift-drag pan uses the wrong rotation axes and the wrong vertical sign

**Where:** `client.js:1285-1289`.

```js
const right = [camera.rotation[0], camera.rotation[3], camera.rotation[6]]
const up = [camera.rotation[1], camera.rotation[4], camera.rotation[7]]
camera.target[i] -= dx * h * right[i] + dy * h * up[i]
```

FFS `surface3d.Camera.pan` uses the **rows** (`rotation[0]`, `rotation[1]`) and a **plus** sign for
`dy`:

```python
right, up = self.rotation[0], self.rotation[1]
self.target = self.target - (dx * h) * right + (dy * h) * up
```

With rotation = `Ry(0.3) @ Rx(-0.2)`, target `[1,2,3]`, `dx=0.1`, `dy=0.05`, the client formula gives
`[-16.368, -7.191, 10.323]`; FFS gives `[-16.918, 12.292, -0.569]`; the row-based formula reproduces
FFS exactly. After any orbit, shift-drag therefore pans in the wrong world direction (and vertical
drag is inverted). The rendered matrix and picking are fine (they match FFS to 3.2e-5) — this is
purely the pan gesture.

**Fix:** `right = [r[0],r[1],r[2]]`, `up = [r[3],r[4],r[5]]`,
`target -= dx*h*right`, `target += dy*h*up`, and normalise x by the same view height as y if matching
the desktop pane exactly.

### C7 — P2: `event.preventDefault()` on wheel does nothing under React 18 (passive listener)

**Where:** `client.js:1003-1007` (slice wheel) and `:1308-1314` (surface wheel).

DSH uses React `^18.2` resolved to 18.3.1 (verified in the local installation). React 18 registers
`wheel` listeners passively, so `preventDefault()` produces “Unable to preventDefault inside passive
event listener invocation” and the page still scrolls. Wheel-over-canvas will scroll the underlying
Harness view while also stepping/zooming. **Fix:** attach a native non-passive `wheel` listener to
the canvas in an effect (`{ passive: false }`) and remove the React `onWheel` handler, or add
`overscroll-behavior`/`touch-action` plus a non-passive wrapper.

### C8 — P2: “Zoom-link (LOCK)” always locks the view when unchecked, and “Follow crosshair” clears LOCK

**Where:** `client.js:784, 789`; FFS handler
`reference/fastfuncstuff/fastfuncstuff/viewer/vocab.py:2561-2573`.

- Zoom-link checkbox onChange sends `SET_VIEW_LOCKED <id> 1 <checked?1:0>`. The `on` argument is
  hard-coded to `1`, and the handler sets `locked = bool(on)`. So *unchecking* the checkbox locks an
  unlocked viewport (and leaves it locked), rather than disabling the zoom link.
- Follow-crosshair sends `SET_VIEW_LOCKED <id> <0|1>` (2 args). The handler computes
  `zoom_linked = on and zoom`, so turning follow on or off always clears an existing zoom link.

**Fix:** send `on = vp.locked ? 1 : 0` for the zoom-link control (or a dedicated `SET_VIEW_ZOOM_LINK`
command), and preserve `zoom_linked` when toggling `locked` if FFS supports it; label the control
“LOCK zoom” and explain that it implies locked.

### C9 — P2: “Resample” offers an `auto` value the sidecar rejects

**Where:** `client.js:793-794`; FFS `surface/sampling.py:14` (`MODES = ("nearest","linear","cubic")`),
handler `vocab.py:2463-2470`.

`SET_VIEW_SAMPLING <id> auto` parses, then the handler raises
`ValueError: sampling is one of nearest, linear, cubic, not 'auto'`. The select also defaults to
`vp.sampling || 'auto'`, but the viewport default is `nearest`; `auto` is never a valid state.
**Fix:** remove `auto` or map it to the layer/underlay sampling mode in the client and send a real
mode.

### C10 — P2: Range fields send `null`/empty strings and do not follow layer changes

**Where:** `client.js:1509-1512`.

The two number inputs are **uncontrolled** with `defaultValue`; React reuses the same DOM nodes when
the selected layer changes, so they show the previous layer's range until a full remount. More
seriously, on blur they send:

- `SET_RANGE <key> <lo> <hi>` where `lo`/`hi` may still be `null` (auto range) → e.g.
  `SET_RANGE A null 6`; FFS `commands._decode_scalar` raises `ValueError: could not convert string
  to float: 'null'`.
- an empty value → `SET_RANGE A  6`; FFS raises `SET_RANGE is missing a value for hi`.

Both were confirmed with the real FFS parser. **Fix:** make them controlled from
`selected.rangeLo/rangeHi`, default empty inputs to the current layer's effective auto range or
disable them until a finite range exists, and only emit a `SET_RANGE` when both operands parse as
finite numbers (`step="any"` too — current `step:1` is wrong for decimal ranges).

### C11 — P2: controlled sliders fight their own state (thumb snaps back during drag)

**Where:** `client.js:1503-1506` (opacity), `:1513-1518` (threshold), `:1528-1531` (time);
underlying cause C3.

`value` comes from the last polled snapshot, while `onChange` fires an RPC that does not update the
snapshot. Each input event re-renders with the old value, so the thumb jumps back until the next poll
(up to 1.1 s), then jumps forward. The time slider has the same problem with `SET_INDEX`. **Fix:**
local optimistic state for the dragged value (commit on change end / debounce) or seed the snapshot
from the command response as described in C3.

### C12 — P2: sidecar/state failure shows “Loading viewer state…” forever

**Where:** `client.js:490` vs `:530-533`.

The connection error is rendered only inside the `open && currentLayout` branch. If the first
`state` call never succeeds, `currentLayout` stays `null` and the fallback window shows only
“Loading viewer state…” — no error, no retry, no command bar (the command bar is inside the
`currentLayout` branch too). **Fix:** render the error and a retry action in both branches; do not
gate the command bar on layout.

### C13 — P2: fire-and-forget command promises are never caught

**Where:** `client.js:435` (`dispatch = ... run(...)`), `:774` (`SettingsPopover.set`), `:1484`,
`:1455`, `:1461`, `:1538-1539`, `:1585` (CommandBar submit), and the save/restore buttons at
`:486-487` and `:1554-1555`.

`run` rejects on failure (`:429`) but callers discard the returned promise. Any invalid command
(and C9/C10 make invalid commands easy) produces an unhandled promise rejection in addition to the
log entry; browsers report these as console errors and test harnesses may fail on them. Only surface
loaders and a few pane handlers use `.catch`. **Fix:** make `dispatch` swallow/log the rejection
(`void run(...).catch(() => {})`) or return a settled result; add `.catch` to save/restore.

### C14 — P2: `open` failures are swallowed and never retried

**Where:** `client.js:398-402`.

```js
call('open', { preset: 'auto' }).then(() => refresh()).catch(() => { openedOnce.current = false })
```

The failure is not logged, not shown, and the effect's dependencies `[open, call, refresh]` do not
change, so `openedOnce` being reset does not cause another attempt. The user sees “no dataset”/empty
docks with no explanation. **Fix:** log/set error and either retry once or expose a retry button;
include the open result's `notice` (see A5).

### C15 — P2: `ffs_viewer_show`’s `target` is ignored

**Where:** `client.js:389-391`; sidecar `server.py:686-691` returns `target`, but
`snapshot.py:118-150` exposes only `showSeq`, and the client only calls `setOpen(true)`.

The Host tool promises “target to focus”, but the client has no way to receive the target and never
selects/focuses/scolls to it. **Fix:** add `showTarget` to the snapshot (or a dedicated RPC reply)
and, on `showSeq` change, select the matching tab/group and focus the pane; keep `showSeq` for
“open only”.

### C16 — P2: the workspace `open` field is one-way and agent-set values are overwritten

**Where:** `client.js:403-406` vs `:389-396`.

The UI open flag is written into the layout (`setLayout({...layout, open})`) and persisted, but the
reverse never happens after initial mount: if an agent (or a second tab) sets `workspace.open` via
`ffs_viewer_workspace set`, `useLayout` may adopt the new layout, and the very next effect rewrites
`open` back to the local UI value and saves it. The tool therefore cannot open or close the viewer.
**Fix:** treat `open` as UI-owned ephemeral state and strip it from the persisted layout contract
(or implement both directions with an explicit “remote open requested” event like `showSeq`).

### C17 — P2: the “Tiled” checkbox is inert

**Where:** `client.js:791` (and duplicate copies it at `:667`).

`SET_VIEW_TILES` changes the viewport flag, but the only render path used by the client,
`compose.render_viewport`, ignores `viewport.tiles` (`reference/.../viewer/compose.py:372-396`);
tiling is implemented in the Qt window (`viewer/ui/imagewindow.py:965-994`). The browser pane always
renders the composite, so checking Tiled changes nothing except state and duplicate behavior.
**Fix:** implement tiling client-side (render one pane per visible layer via a `soloKey` render
option) or remove the control until it is supported.

### C18 — P2: Split Right/Down does not split the current view; direction is ignored below the root; a missing viewport crashes the handler

**Where:** `client.js:693-709`, `:745-746`.

`splitGroup` only sends `OPEN_VIEW <newId> <kind> <plane>` — it does not copy the source's settings
(unlike `duplicate`). If the group already lives under a split, the new group is appended to that
parent (`:701-703`) and the requested `direction` is ignored; only the root case uses it. If `vp` is
undefined (tab id from a layout whose viewport is not in the snapshot), `source.kind` throws while
the duplicate button guards with `if (!source)`. **Fix:** guard `source`, honour direction by
wrapping the group in a new split of that axis, and copy the source settings (or rename the buttons
to “New view right/down”).

### C19 — P2: closing a tab is destructive, races the poll, and leaves unremovable empty groups

**Where:** `client.js:639-648`, `:229-235`, `:629-631`.

`closeTab` removes the tab locally, then sends `CLOSE_VIEW`; if the command fails, the next snapshot
still contains the viewport, so the tab reappears (flicker). It also closes the viewport in FFS
state (no undo/confirmation) rather than just hiding the dock tab. Empty groups are kept forever
(no remove-group action), and reconciliation may fill an empty group with an unrelated new viewport
(`:229-235`). **Fix:** await the command and reconcile only on success; either prune empty groups or
offer a “remove empty group” affordance; consider a confirmation or undo for closing a viewport.

### C20 — P2: parked-slice affordance and canvas label disagree with actual state

**Where:** `client.js:740`, `:775-787`, `:940-943`.

- For an unlocked viewport whose `position` is still `null`, the canvas draws “PARKED” even though
  `render_viewport` uses `position=None` (i.e. it still follows the crosshair) and the pane head
  shows `parked --`.
- The settings slider initializes to `Math.round(positionMax/2)` when `position` is null, so it
  displays a slice that is not actually parked; moving it sends a `SET_VIEW_POSITION`.
  **Fix:** initialise the slider from `vp.position ?? snapshot.crosshair[fixedAxis]`, show
  “follow” vs “parked <n>” based on `position !== null`, and only draw PARKED when a position is set.

### C21 — P2: surface/colour errors retry every poll; GL buffers leak

**Where:** `client.js:1173-1175` (surface error resets token) and `:879` (render error resets token);
`:1234-1246` (new GL buffers) with cleanup at `:1206` only losing the context.

On a persistent error (no surfaces loaded, malformed mesh, shader failure), the token is reset so the
next 1.1 s snapshot re-renders and re-requests the same failing surface/render, producing an error
storm and log spam. When a mesh is rebuilt, the old `WebGLBuffer` objects are orphaned without
`deleteBuffer`; the only cleanup is losing the context on unmount. **Fix:** back off retries
(exponential or once per rev), show an inline error with retry, and delete old buffers/program on
mesh replacement.

### C22 — P2: the default panel resize handle grows the panel in the opposite horizontal direction

**Where:** `client.js:458-462` (default style `right:24, top:48`), `:510-528` (resize adds to
`panelSize`).

While the panel is right-anchored, increasing `width` moves the left edge left; dragging the
bottom-right handle to the right therefore makes the panel grow to the left. After the header has
been dragged once (`position` set, `left/top` used) the handle behaves as expected. **Fix:** on
resize, adjust `position.left` when `position` is null (or always store an absolute left/top and
resize from there), and clamp the resulting rect inside the viewport.

### C23 — P3: launcher overlaps the workspace footer when open

**Where:** `client.js:44-48` (`.ffs-launch` z-index 60, `.ffs-workspace` z-index 55), `:465`,
`:537-543`, `:458-462` (default top 48 / bottom 88).

The launcher is always rendered, even while the workspace is open, and its z-index is above the
workspace. With the default panel position the footer/command bar occupies the bottom of the panel;
for viewport heights below roughly 860 px the panel's bottom edge reaches the fixed launcher at
`right:18px; bottom:18px`, and while the workspace is maximized the launcher sits on top of the
command bar. Clicking it only calls `setOpen(true)`, so it is a persistent no-op overlay that can
steal clicks from the command bar. **Fix:** hide or move the launcher while `open` (or render it as
a header control); make it toggle.

### C24 — P3: dead code and unused state

- `menu`/`setMenu` never used (`client.js:626`) — likely intended context menu for tabs.
- `panPending` never used (`:845`) — old rAF throttle left behind.
- `hover`/`setHover` never used (`:1123`) — no hover readout implemented.
- `call: null` passed to `PaneBody` (`:759`), prop not destructured by `PaneBody` (`:830`).
- `cumulative`/`ref` in `Divider` unused (`:598-601`).
- `viewKind` (`:176`) and `findGroupOf` (`:156`) unused.
- `TOKENS.idle` is an invalid token and unused (`:36`).
- `.ffs-modal-bg` (`:117`) and `.ffs-pane` (`:89`) CSS classes are unused.

### C25 — P3: tab switch keeps stale per-view settings state

**Where:** `client.js:758` (`SettingsPopover` rendered without a `key`) and `:775-777` (state
initialised from `vp` only on mount).

Switch tabs while the settings popover is open: the popover component instance is reused with a new
`vp`, but `park`, `depthLo`, `depthHi` keep the previous viewport's values. **Fix:** add
`key={vp.id}` to the popover or derive/reset state from `vp` in an effect.

### C26 — P3: panel geometry and workspace-maximize state are not persisted

**Where:** `client.js:376-386`; only `docks`, `open` and pane `maximized` are saved in the layout.

`position`, `panelSize` and `maximizedWorkspace` are ephemeral; after reload the panel returns to
`right:24/top:48` and its initial size. If the workspace file is meant to capture the user's window
layout (the docs say “docks, tabs, sizes, maximized pane”), either add panel geometry to it or state
explicitly that it is ephemeral. (The split `size` values that *are* persisted are currently
ignored — see C5.)

### C27 — P3: the polling timer can fire once after unmount; pending save timer is not cleared

**Where:** `client.js:305-316` and `:358-367`.

If unmount happens while `refresh()` is in flight, `stop` is set but the post-`await` code does not
re-check it and schedules one more `setTimeout(tick, delay)`; that tick exits immediately, so the
leak is one timer. `pendingSave` is likewise never cleared on unmount, so a workspace RPC can be
issued after the component is gone. Harmless but easy to fix by re-checking `stop` and adding a
cleanup effect.

---

## 2. API / contract mismatches

### A1 — Double `open` and non-idempotent open (see C2)

`client.js:401` calls `open`; Host `index.js:235-240` runs `ensureOpen()` for the same endpoint and
then `index.js:284-285` issues the requested `open`, so one client click results in two sidecar
`open` calls. Sidecar `open` is not a “no-op if already open” operation; it may replay a saved script
onto a live session. This is a Host/Client contract bug, not just a client bug.

### A2 — Timeout policy mismatch between client abort and host work

- `client.js:271-272`: `open` is treated as long (`60 s`), everything except
  `render/surface/surface_pick/series/save/restore/open` gets 20 s.
- `index.js:224, 278-279, 284-285`: `ensureOpen` and `open` use 180 s; `restore` uses 180 s.
- The Host handler ignores the RPC `signal` (`index.js:584-593`), so a client abort closes only the
  HTTP request; the sidecar work keeps running and its result is dropped.

Consequences: a slow demo/restore `open` (>60 s) or a slow cold `state` (>20 s) reports an error in
the UI while the Host finishes successfully; a retry can then pile up work. Align the client
timeouts with Host ones (or stream progress), and have the Host forward cancellation/return a
“still working” result.

### A3 — `restore` client timeout is 60 s, Host timeout is 180 s

Same root as A2: `client.js:271-272` vs `index.js:278-279`. A large script restore can be reported as
timed out while it is still replaying.

### A4 — `snapshot.viewports[*]` needs `fixedAxis`/`positionMax` (present in the sidecar, absent from API.md)

`snapshot.py:80-91` now adds both fields; the client uses `positionMax` correctly
(`client.js:775-786`). `docs/API.md`’s snapshot schema (`docs/API.md:99-105`) does not list them.
This is a documentation gap only (unless the plan is to reject unknown snapshot fields).

### A5 — sidecar `notice` never reaches the browser

The sidecar records `meta["notice"]` (`server.py:192-201`, also `open()` `notice` results) for
“demo data not found”, “restore failed, loading demo”, etc., but `build_snapshot`
(`snapshot.py:118-150`) does not expose it, and `client.js:401` ignores the `open` response. The user
sees an empty viewer with no reason. **Fix:** add `notice` (and `restored`/`preset`) to the snapshot
or consume the `open` response, and show it in the header/empty state.

### A6 — `ffs_viewer_show` target contract (see C15)

The Host tool passes `target` to the sidecar and the sidecar returns it (`server.py:686-691`), but
neither the snapshot nor the client can use it. Either expose it or drop it from the tool contract.

### A7 — `ffs_viewer_workspace` cannot change open state (see C16)

The tool/docs advertise replacing the layout (including `open`), but the client rewrites
`layout.open` from its own UI state on the next render and saves it. The persisted layout contract is
one-directional in practice.

### A8 — `docs/API.md` snapshot advertises a `catalog` array that the sidecar never sends

`docs/API.md:111` lists `catalog: [{path,name,kind}]`; `snapshot.py:118-150` has no `catalog` key
(`sources` is present instead). The client does not use it, but agent/UI code relying on the doc
would break. Add `catalog` or remove it from the doc.

### A9 — `docs/API.md` method table omits `restart`

The Host bridge has `case 'restart'` (`index.js:286-289`) and the `ffs_viewer_save` tool accepts
`action:"restart"` (`index.js:504-518`), but the method table (`docs/API.md:60-78`) does not list it.
Minor doc gap.

### A10 — Caching tokens: checked and consistent

The new `outlineToken`/`outlinesUnchanged` and `colorsToken`/`colorsUnchanged` fields used by the
client (`client.js:866-876`, `:1143-1172`) are implemented by the Host
(`index.js:253-254, 265-266`) and sidecar (`server.py:352-383, 538-566`). No field mismatch was
found. One caveat: the client sends `outlineToken`/`colorsToken` from whatever view it last showed,
so the first render after a tab switch always recomputes; that is safe, just not optimal.

### A11 — Container fields checked

All RPC endpoint names used by the client exist in the Host bridge and sidecar:

`state`, `open`, `execute`, `execute_batch`, `render`, `pick`, `pan`, `zoom`, `step`, `surface`,
`surface_pick`, `series`, `workspace`, `save`, `restore`.

Payloads and response fields used by the client match the current Host forwarding and sidecar
payloads: render (`png/width/height/plane/position/crosshairPx/outlines/viewInfo.span` +
`outlineToken`), surface (`mesh.hemis[].hemi/positions/faces`, `mesh.bounds`, `colors`,
`colorsToken/colorsUnchanged`, `layer`, `meshRev`), series (`gridN`, `cells[].ijk/centre/tint/
traces[].key/values`, `entries[].ident/label`, `sharedScale`, `timeIndex`, `maxTimeIndex`,
`secondsPerPoint`), state (snapshot fields used by the UI, including `positionMax`), workspace
(`{layout}`), save/restore results. No wrong endpoint/payload field was found.

---

## 3. UX / visual consistency findings

### U1 — Feedback for agent-originated changes is effectively absent

The snapshot carries `origin`, `category`, `revByCategory` and the log only records UI-run commands
(`client.js:423-424`). Agent changes arrive through polling and only move the `rev` chip
(`:547-555`); there is no toast/status line naming what changed, no “agent modified this” highlight,
and `snapshot.origin`/`revByCategory` are never read (`grep` count: 0). The dirty chips
(display/analysis/source) are good but are always shown, so they do not distinguish an agent edit
from the user's. **Suggestion:** show a transient “agent: SET_THRESHOLD S 3.2 · rev 12” banner/status
in the header from `origin`/`category` changes, and badge the pane that changed; expose the three
category revision counters that the sidecar already sends.

### U2 — Discoverability of the launcher and workspace chrome

- The launcher is a fixed pill with a green dot and “Open FFS viewer / FFS viewer”; it is the only
  entry point, remains visible while the panel is open, and overlaps the panel footer (C23).
- The workspace title is always “FFS viewer”; the dataset/subject name is only implied by the
  subtitle (grid · mm · rev) and hidden in the rail subject row.
- Icon-only buttons (⛶ ❐ 💾 ⟲ ✕ ⚙ ⧉ ▥ ▤) rely on native `title` tooltips; official DSH surfaces use
  its Tooltip component. Emoji render differently per platform and give poor accessible names.
- Pane maximize is also available by double-clicking a tab, but that is only mentioned in the
  maximize button's title.
- There is no “add view” affordance in a group; opening views requires the command bar.

### U3 — Control density, layout, and small-screen behaviour

- Rail is fixed at 238 px and the workspace `min-width: 520px`; below that (narrow window / mobile)
  the panel overflows instead of reflowing. The canvas panes become very small.
- 9–11 px labels, 10 px hints and 9 px canvas labels are below typical DSH body sizes; several
  controls (range, threshold, time) are unlabeled for assistive tech (see U6).
- Save/Restore are duplicated in the header and the rail; the header also duplicates maximize/close
  semantics with pane controls.
- The command bar is disabled for the whole `busy` period of *any* render/surface/series call; a slow
  surface request freezes command input.

### U4 — Affordances for duplicate / split / maximize / park / lock

- Duplicate and Split are side-by-side icons with similar glyphs (⧉ / ▥ / ▤); Split does not copy the
  view (C18) and is ignored below the root.
- Park and lock live inside the ⚙ popover: no one-click “park here” or “lock this view”. The lock
  state is a chip, the park state is `parked n`/`parked --`, and the zoom-link control has the
  semantics bug in C8.
- Maximize pane is available, but while a pane is maximized the other groups are hidden with no
  visible restore bar other than the tab row and the active maximize button; closing the maximized
  tab leaves an inconsistent `maximized` id until the next reconcile.
- There is no context menu on tabs (the dead `menu` state suggests one was planned); close cannot be
  undone.

### U5 — Error display and empty states

- Persistent poll errors are displayed as a red bar only in the loaded branch (C12); open failures
  are silent (C14); sidecar notices are lost (A5).
- Slice render errors are caught and only appear in the global log (`:879`); series errors do show
  an inline error (`:1473`); surface errors show inline (`:1322`). Inconsistent.
- Empty states are generally present (No views / No layers / No time series / empty group /
  “viewports … not implemented”), but an empty group has no way to be removed (C19), and there is no
  explanation when the dataset is absent (“no dataset” is only a subtitle).

### U6 — Keyboard and accessibility

- The workspace is a plain `<div>` with no `role="dialog"`/`region`, `aria-label`, focus management,
  or Escape-to-close.
- Icon-only buttons have `title` but no `aria-label`; accessible names are the emoji glyphs.
- `<label>` elements in `field()` (`:1566-1568`) are not associated with their inputs (`htmlFor`/id
  or wrap), so screen readers do not connect the text; range sliders have no `aria-valuetext`.
- Tabs are `<button>`s but not `role="tab"`/`tablist` with `aria-selected`; no arrow-key tab
  navigation (the official dockkit does this).
- Canvas interactions (pick, pan, zoom, orbit, scrub) are pointer-only; there are no keyboard
  equivalents and the canvas is not focusable. Tab drag/drop has no keyboard alternative.
- The launch button is in the overlay DOM after the app; without a shortcut it is only discoverable
  by tabbing to the end of the document.

### U7 — Contrast and theme consistency

- Chrome uses DSH alias tokens, which is good. However the panes are hard-coded `#0b0d10`
  (`:93, :894, :1221, :1371`) with fixed white/gray overlays and a fixed chart palette
  (`SERIES_COLORS`, `:38`), so the light theme keeps dark image/graph/surface panes and hand-picked
  colors. This is defensible for image panes but is a deliberate theme exception that should be
  documented or tokenised (`--dsw-alias-*` alternatives).
- Canvas text is white at 48–65 % opacity directly over anatomy/curves; on a bright image or dense
  series it can fall below readable contrast. A translucent backdrop or text shadow would help.
- `TOKENS.idle = 'var(--dsw-alias-state-idle-primary)'` (`:36`) does not exist in DSH’s theme
  catalogue (the `design-platform.css` aliases have no `state-idle-*`); it is unused, but should be
  removed to avoid future breakage.

### U8 — State/latency feedback

Because of C3/C4 there is no “optimistic” feedback for any pointer interaction; the only progress
signal is the footer `working…`/`ready` (which flips per RPC) and the rev log. During a pan drag the
image does not follow the pointer, then jumps on the next poll. This is the largest perceptual gap
between this client and the desktop viewer, independent of correctness.

---

## 4. DSH rule compliance

| Rule | Status | Notes |
|---|---|---|
| Theme tokens only (`--dsw-alias-*`) | **partial** | Chrome is tokenised; hard-coded `#0b0d10`, white/red/amber overlays, chart palette, shadows. One invalid token (`state-idle-primary`) is declared but unused (`:36`). |
| No importing Harness Client packages | **pass** | `require('react')` only. |
| No replacing the app root | **pass** | registers one additive `shell.overlay` entry (`:1628-1635`); verified registration shape against the slot API. |
| Visible text through locale | **fail** | `t` is received but never called (`:373`, `:1634`); all labels/hints/errors are ~85 hard-coded English literals; `messages` has only 4 keys; only `en` is registered, no `zh`, and `ctx.locale.register` is called outside `ctx.effect` (`:1619-1627`). Official plugins wrap it: `ctx.effect(() => ctx.locale.register(NS, { zh, en }), ...)` (e.g. `packages/client/ui-approval/src/client/index.ts:76`). |
| No side effects in the factory | **pass** | factory only defines functions/constants; DOM work starts in effects. |
| Cleanup owned by effects | **partial** | poll timer, ResizeObservers, slots and GL context are cleaned; locale registration is not wrapped/disposed; pending layout save timer not cleared; GL buffers/program not deleted when meshes are replaced. |
| `shell.overlay` click-through; entries opt into pointer events | **pass** | `.ffs-root { pointer-events:none }` + `.ffs-root > * { pointer-events:auto }` (`:42-43`) matches the AppFrame contract (`.overlayLayer{pointer-events:none}`, `.overlayLayer>*{pointer-events:auto}`). Caveat: the launcher still consumes clicks in the bottom-right corner even when the viewer is closed/open (C23). |
| Module loader contract | **pass** | `window.__ModuleLoader__.load({ id, factory })`, id matches `package.json` name; factory returns `{name, inject, apply}` like the shipped bundles; `apply(ctx)` registers its effect. |
| Avoid stale React closures | **fail** | poll loop stale `snapshot` (C3); the stale-closure symptom is the constant 1100 ms interval. |

---

## 5. What could not be verified

No browser control is available in this environment, so **runtime/visual behaviour was not executed**
beyond server-side React rendering and the stubbed module/apply path. Specifically not verified:

- actual DOM/CSS cascade (inline `<style>` vs shell stylesheet), overlay stacking, launcher/workspace
  overlap, focus outlines, native `title` tooltips;
- ResizeObserver values and canvas DPR sizing in a real browser; letterboxing and text rendering;
- WebGL2 context creation, shader compile/link, buffer upload, draw output, context-loss recovery,
  and the user-visible surface image (only the camera matrix was verified numerically);
- pointer capture, wheel passivity in the real app (inferred from React 18.3.1 source, not exercised),
  drag/drop MIME behaviour across browsers, touch gestures;
- contrast ratios in light and dark themes (token values were not rendered against real surfaces);
- actual sidecar/RPC timings, polling cadence, large-dataset performance, and the layout-loss scenario
  end-to-end in the running GUI (the helper-level failure and the code path are proven, but the
  destructive save was not executed in a browser);
- multi-tab / multi-session behaviour, HMR/unload/reload of the client plugin, and StrictMode effects;
- real keyboard/screen-reader interaction;
- the running Host’s behaviour while `client.js` was being edited concurrently — re-check the hashes
  in the header before applying fixes.

Not installed, not modified: no packages were installed; only `docs/UI_AUDIT.md` was created. The
temporary harness lives outside the repo at `/tmp/ffs-ui-audit.HipfzQ`; the repo’s FFS sources,
sidecar and client were not modified by this audit.

---

## 6. Suggested fix order (for the lead)

1. **C1 layout loss** — gate layout reconciliation/save on a loaded session and preserve tabs for
   viewports that are not in the snapshot yet. This is the only finding that destroys persisted
   user data.
2. **C2 open replay/clobber + A1/A2** — make `open` idempotent (client checks `snapshot.grid`, Host
   does not call `ensureOpen` for `open`), align timeouts, show the open result/notice.
3. **C3/C4/U8 state freshness and input coalescing** — ref for the poll snapshot, seed snapshot from
   command results, rAF/debounce pan/zoom/slider commands, keep per-event work out of `setBusy`/log.
4. **C5 split sizes** — apply flex sizes and fix the drag math; if sizes are not going to be applied,
   do not persist them (or remove the divider).
5. **C6 surface pan** — rows/plus-sign fix; verify against `Camera.pan`.
6. **C8/C9/C10/C11 command correctness** — lock semantics, remove `auto`, controlled/finite range
   inputs, optimistic slider state.
7. **C7/C12/C13/C14/C15/C16/C17/C18/C19/C20/C21** — feedback/error handling and the remaining
   functional gaps.
8. **Locale (R2/R4), token cleanup (U7), accessibility (U6), dead code (C24)** — rule-compliance and
   polish.

---

## Appendix A — audit harness

Location: `/tmp/ffs-ui-audit.HipfzQ` (outside the repo).

- `run-audit.cjs` — mock `window.__ModuleLoader__`, recording `ctx`, real React/ReactDOMServer from
  the local npm cache, instrumented-source copy, synthetic snapshot, 17 pane/control SSR renders,
  layout-helper checks, camera/pan numeric checks.
- `client.old.js` / `client.current.js` / `client.diff` — snapshots taken while the source was edited
  concurrently (used only to keep line references current).
- `camera.py` / `pan.py` — Python FFS `surface3d.Camera` cross-checks; `camera-python.json` and
  `pan-python.json` hold the reference values.
- `audit-current.json` — the full pass/fail result for the current revision (0 failures for module
  load, apply, overlay render, and the 17 pane renders).

Useful reproduction commands:

```bash
cd /tmp/ffs-ui-audit.HipfzQ
node run-audit.cjs > audit-current.json
PYTHONPATH=/Users/chengran/Documents/small_projects/ffs_agentic/python:\
/Users/chengran/Documents/small_projects/ffs_agentic/reference/fastfuncstuff \
  /Users/chengran/Documents/small_projects/ffs_agentic/.venv/bin/python camera.py
```

## Appendix B — line-reference index (current `client.js`)

| Concern | Lines |
|---|---|
| Poll loop / stale snapshot | 305-316 |
| `open` on first panel open | 397-402 |
| `layout.open` sync (source of C1 save) | 403-406 |
| Layout reconciliation / tab pruning | 205-239 |
| Layout commit + debounce | 358-367 |
| `run` (busy/log/no refresh) | 418-433 |
| Split rendering & resize math | 565-585 |
| Divider drag | 597-620 |
| Panel default position / resize handle | 458-462, 510-528 |
| Slice pan/zoom/pick/wheel | 961-1019 |
| Surface pan/orbit/wheel/pick | 1273-1324 |
| Surface fetch/caching/GL | 1138-1262 |
| Tiled / sampling / lock settings | 784-794 |
| Parked-slice state | 740, 775-787, 940-943 |
| Range/threshold/time controls | 1503-1531 |
| Tab close / duplicate / split | 639-709 |
| Locale registration / messages | 1609-1635 |
| Invalid idle token | 36 |
| Launcher / workspace z-index | 44-48, 437-543 |
| Error rendering locations | 490, 530-533, 1322, 1473 |
