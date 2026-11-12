# FFS Harness Viewer — command and transport contract

The authoritative viewer state is a `ViewerSession` from `fastfuncstuff.viewer.session`.
Everything in the Harness interface — user controls, panes, and agent tools — reaches it
through **one validated command interface**: the FFS command bus (`viewer/commands.py` +
`viewer/vocab.py`). No Harness component mutates viewer state directly.

## Layers

```
Browser (client.js)                 Host (index.js)                  Python sidecar (python/ffsviewer)
--------------------                ---------------                  -----------------------------------
ctx.connection.rpc.call('/ffs') --> connection.rpc.handle('/ffs') --> NDJSON request
  state / render / surface            FfsBridge methods                 ViewerSession
  / series / pick / ...               (one implementation)              ViewerState + CommandBus
                                      agent tools call the same
                                      FfsBridge methods
```

- The sidecar owns FFS state. The Host owns the sidecar process and the layout file.
- The client owns only ephemeral view concerns (camera pose, hover, canvas size). Every
  scientific decision (coordinate mapping, threshold, colormap, surface sampling) is
  computed by FFS code in the sidecar.
- Agent tools and the browser call the same Host methods with the same payloads; the
  only difference is the recorded `origin` (`"ui"` / `"agent"` / `"system"`).

## Transport

### Browser ↔ Host

An authenticated route registered by the Host plugin on the shared Web server, using
`ctx.webServer.register({kind:'prefix', path:'/ffs', handler})` and gating every request
with `ctx.connection.admit(req)` (Host/Origin fence + browser cookie). It speaks the same
envelope as a Connection RPC channel, so the browser can use the stock caller:

```js
ctx.connection.rpc.call('/ffs', endpoint, payload, signal)   // browser
POST /ffs/<endpoint>  {type:'client-request', rpcId, method, payload}
                      -> {type:'server-response', rpcId, result}
```

Results use the Connection result envelope: `{ ok: true, value }` or
`{ ok: false, error: { code, message, details } }`. `rpc.call()` resolves to that
envelope (the caller checks `.ok`).

The direct route exists because `connection.rpc.handle('/ffs', ...)` resolves
`webServer` on the Connection service's own context and throws `cannot get property
"webServer" without inject` in this profile; `ctx.inject(['webServer','connection'])`
plus an explicit route provides the same authentication and envelope without that
internal dependency.

### Host ↔ sidecar

The Host spawns `python -u -m ffsviewer.server --project-root <repo> --state-dir <dir>`
with `PYTHONPATH` = `<repo>/python:<repo>/reference/fastfuncstuff`, and speaks newline
delimited JSON on stdin/stdout:

```json
{"id": 7, "method": "execute", "params": {"line": "SET_THRESHOLD L2 2.5", "origin": "ui"}}
{"id": 7, "ok": true, "result": { "rev": 12, "state": {...}, "dirty": ["SLICES", "THRESHOLD"] }}
{"id": 8, "ok": false, "error": {"code": "command-invalid", "message": "..."}}
```

stderr is diagnostic only (logged by the Host, never parsed).

## Methods

All methods return JSON-safe values. `state` returns the full snapshot described below.

| Method | Params | Result |
|---|---|---|
| `hello` | – | `{version, ffsVersion, python, projectRoot, stateDir, device}` |
| `open` | `{preset?: "demo" \| "restore", paths?: string[], subject?: string}` | `{state, restored, loaded}` |
| `execute` | `{line: string, origin: "ui"\|"agent"\|"system"}` | `{state, dirty, command, category}` |
| `execute_batch` | `{lines: string[], origin}` | `{state, results}` (stops at first error) |
| `state` | – | snapshot |
| `render` | `{view: string, outlineToken?: string}` | render result; when `outlineToken` matches, outlines are omitted (`outlinesUnchanged: true`) |
| `pick` | `{view: string, row: number, col: number, action?: "crosshair"\|"seed"}` | `{state, ijk, mm}` |
| `pan` | `{view: string, dx: number, dy: number}` (`dx/dy` = fraction of drawn image) | `{state}` |
| `zoom` | `{view: string, factor: number}` | `{state}` |
| `step` | `{view: string, delta: number}` — wheel slice step with the original window's semantics | `{state, axis}` |
| `surface` | `{view, meshRev?, colorsToken?, shape?, fragment?, overlayToken?}` | surface result; matching `meshRev` omits geometry, matching `colorsToken` omits per-vertex colours; `fragment:true` returns one volume overlay as a 3-D R32F texture + LUT/params, sampled per fragment like the original surface shader (`overlayToken` omits unchanged volume data) |
| `surface_pick` | `{view, xNdc, yNdc, aspect, camera:{rotation:[9], distance, target:[3], fovDeg}}` | `{state, hemi, vertex, mm, distance}` |
| `series` | `{view: string}` | series result |
| `browse` | `{path?: string}` | directory listing for the data picker: `{path, parent, subject, entries:[{name,path,kind,subject?,size?,suffix?}], shortcuts}` |
| `load_paths` | `{paths?: string[], subject?: string, keep_surfaces?: boolean}` | loads datasets and/or FreeSurfer surfaces, returns `{state, loaded, subject}`; a dataset-only load unloads a previous subject unless `keep_surfaces` |
| `clear_surfaces` | – | unload the loaded FreeSurfer subject and hide its slice outlines; returns `{state, cleared}` |
| `sources` | – | persisted source folders, subjects and the current catalog |
| `add_folder` | `{path, recursive?}` | scan a directory into the catalog and persist it as a source folder |
| `remove_folder` | `{path}` | remove it from the source list (loaded layers are untouched) |
| `read_folder` | `{path, recursive?}` | read/rescan a folder into the catalog |
| `add_files` | `{paths}` | build the catalog from named files |
| `preview` | `{path}` | load a catalog entry as an unrecorded preview layer |
| `auto_range` | `{key}` | derive the layer's display range from the shown volume/sub-brick (FFS AUTORANGE) |
| `colorbar` | `{colormap, n?, reverse?}` | exact FFS colour scale as RGB stops, for the rail colour bar |
| `clear_preview` | – | drop the preview layer |
| `load_entry` | `{path}` | commit the preview or load the entry as a recorded layer |
| `add_subject` | `{path}` | load a FreeSurfer subject's surfaces and persist it under `subjects` |
| `remove_subject` | `{path}` | remove it from the subject list (loaded meshes untaken) |
| `workspace` | `{layout?: object}` (omit to read) | `{layout, rev}` |
| `save` | `{note?: string}` | `{dir, files, manifest}` |
| `restore` | – | `{state, restored}` |
| `show` | `{target?: string}` | `{showSeq}` — asks the browser to reveal the workspace |
| `commands` | – | `{commands: [{name, args, doc, category}]}` |
| `shutdown` | – | `{ok}` |

### Snapshot

```ts
{
  rev: number,
  revByCategory: { source: number, analysis: number, display: number, navigation: number, layout: number },
  category: string,            // category of the most recent change
  origin: string,              // "ui" | "agent" | "system"
  loading: boolean,
  grid: { shape:[i,j,k], affine:number[16], voxelMm:number } | null,
  crosshair: [i,j,k], crosshairMm: [x,y,z] | null,
  timeIndex: number, maxTimeIndex: number,
  selected: string | null, inputKey: string | null, theme: string,
  layers: [{
    key,name,path,shape,nVolumes,affine,visible,opacity,colormap,colormapReversed,
    rangeLo,rangeHi,rangeMirror,rangeFixed,threshold,thresholdIndex,thresholdFollow,
    alphaMode,boxed,edges,signMode,nPanes,volumeIndex,timeLinked,roi,integerLabels,
    source,labels,timeDetrend,timePsc
  }],
  viewports: [{
    id, kind, plane, locked, zoomLinked, position, zoom, pan, tilt, solo, tiles,
    strip, stripStep, stripZoom, gridN, traces, sharedScale, tint, detrend, scaling,
    order, matrixOrder, rois, panel, shape, depth, samples, hemis, split, hinge,
    equivolume, depthStat, vertexMap, folding, profileMode, profileScore, tube,
    depthSource, radius, depthLayer, depthRoiLayer, depthBins, patchMm, sampling, geometry
  }],
  surfaces: { subject: string | null, shown: string[], outlineWidth: number, loaded: string[], flatAvailable: boolean, versions: Record<string, number>, selected: [hemi,vertex] | null },
  readout: { lines: string[], brick: string | null },
  mode: { name: string },
  catalog: [{path,name,kind}],
  workspace: object | null,
  showSeq: number, showTarget: string | null, notice: string | null,
  commands: number,
  dirty: { display: boolean, analysis: boolean, source: boolean }, // since last save
  lastSavedAt: string | null
}
```

### Render result

```ts
{
  rev, unchanged: boolean, view: string,
  png: string | null,               // base64 PNG, RGBA8, native plane resolution
  width, height, plane, position,
  crosshairPx: [rowFrac, colFrac] | null,
  outlines: [{ hemi, surface, rgb:[r,g,b], segments: string }],  // base64 Float32 (n,4): r0,c0,r1,c1 normalised to [0,1]
  outlineToken: string, outlinesUnchanged: boolean,
  viewInfo: { zoom, pan, span:[rows,cols], extent:[rows,cols], origin:[r,c], identity }
}
```

The PNG is produced by `viewer.compose.render_viewport`; outlines by
`viewer.surfaces.outlines`; crosshair by `viewer.slicing.PlaneView.points_to_image`.
The client never re-derives these mappings.

### Surface result

```ts
{
  rev, view, meshRev,
  mesh?: {
    hemis: [{ hemi, positions: base64f32 (V*3), faces: base64u32 (F*3) }],
    bounds: { min:[x,y,z], max:[x,y,z] }
  },
  colors: [{ hemi, rgba: base64u8 (V*4) }],
  colorsToken: string, colorsUnchanged: boolean,
  crosshairMm: [x,y,z] | null,
  layer: { key, name, mode: "surface-layer"|"volume"|"folding" },
  shape, hemis, split, hinge, depth:[lo,hi], samples, depthStat,
  picking: { model: "server", note: string }
}
```

Geometry is FFS `surface3d.shape_positions` / `shape_faces` / `layout_offsets` /
`hemisphere_models`. Colours are FFS `surfacelayers.layer_rgba` on values from
`surface.profiles.sample_depths` (equivolume) reduced by `surface3d.reduce_depth`,
composited over the folding map with `surface3d.over`. Picks run
`surface3d.pick` in the sidecar from the ray the client's camera produces. The
browser derives vertex normals for shading; they are cosmetic and never affect sampling
or picking. A click that misses every hemisphere returns error code ``pick-miss``.

### Series result

```ts
{
  rev, view, gridN, timeIndex, maxTimeIndex,
  cells: [{ row:number, col:number, ijk:[i,j,k], centre:boolean,
            traces:[{key,label,short,values:number[],x:number[]|null,xLabel,tint:[r,g,b]|null}] }],
  secondsPerPoint: number | null
}
```

Cell positions mirror `viewer/ui/gridgraph.py:refresh` exactly: offsets in plane image
order around the crosshair, converted back with `PlaneLayout.to_ijk`.

## Validation

- A command line is parsed by `viewer.commands.parse_line`, which resolves the registered
  command class, coerces every typed field, rejects unknown names and wrong arity, and
  enforces the scalar/tuple encoding. The sidecar additionally refuses any line longer
  than 4096 bytes and any name not returned by `commands.registered_names()`.
- Errors are returned as `{code:"command-invalid", message, details:{line, offset?}}` and
  never mutate state.
- `execute` with `origin:"agent"` is exactly the same code path as `origin:"ui"`; a
  verification harness compares both.

## Persistence

`save` writes to `<state-dir>/`:

| File | Contents |
|---|---|
| `viewer.ffs` | whole session script (`session.to_script()`), replayable |
| `display.ffs` | display + navigation commands only (cosmetic; safe to replay over any analysis) |
| `analysis.ffs` | source + analysis commands (what data exists and what was computed) |
| `workspace.json` | Harness workspace layout (mode, dock tree, floating window rects/z/state, tabs, split sizes) — never FFS state |
| `sources.json` | persisted source folders (with recursive flag) and FreeSurfer subjects — the FFS DIR list, not loaded data |
| `session.json` | manifest: timestamps, source files with size/mtime, category counts, analysis layers, revs |
| `screenshots/*.png` | rendered panes saved through `ffs_viewer_render` |

The command categories are source 17 · analysis 16 · display 65 · navigation 16 (see
`python/ffsviewer/classify.py`; `scripts/extract_commands.py --check` keeps the generated
reference in sync). The split is the display/analysis/source distinction: display changes are recoverable
without touching data or computations, while `analysis.ffs` + the source list define the
scientific state. The UI shows the revision counters for each category and warns when a
display-only save would drop unsaved analysis.
