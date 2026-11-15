# Rendering architecture evaluation — FFS Harness viewer prototype

**Status:** evaluation of the prototype as it exists in this checkout on 2026-11-12
(no git metadata in this workspace). The client (`ffs-harness-viewer/client.js`) was
being edited concurrently while this was written; line citations are to that file as
read at 17:20, and the sidecar behaviour measured was stable across the session (byte
counts were identical in five separate 36-sample runs). Measurements come from
[`verification/bench_render.py`](../verification/bench_render.py), which drives the real
sidecar over its NDJSON protocol; every number below is reproducible with that script.
Architecture contract: [`docs/API.md`](API.md).

**One-paragraph verdict.** Server-rendered PNG slices are cheap on the server
(0.71–1.32 ms p50 per frame) and tiny on the wire *for the pixels* (3.3–5.0 kB binary PNG),
but the prototype's **interaction cost is dominated by two things that are not
rendering**: a 350 ms client poll (99% of click-to-pixels latency) and redundant
re-fetching of payloads whose semantics did not change (surface colours 109.7 kB and
surface outlines 24–40 kB re-sent on every global revision bump). At the demo's scale,
the alternative GPU/JS rendering paths (raw planes + JS colormap, volume textures)
cost more wire bytes and much more semantic risk than they save. **Phase 2 should keep
the server-side FFS render path and fix the transport/invalidation architecture first.**

**Headline numbers** (36 samples per cell; full tables below):

- Slice frame, canonical V1: **≈47.0 kB** on the wire — PNG 6,608 B b64 (14%), surface
  outlines 39,776 B b64 (85%), envelope ~1%. Server render **1.32 ms** p50 cold
  (0.71 ms with outlines off); warm cache hit 0.07 ms, but the UI cannot reach it.
- Snapshot poll: **8,063 B every 350 ms = 1,382 kB/min** while open (484 kB/min at
  1,100 ms closed). `state` costs 0.35 ms p50 to build.
- Click: **175.0 kB inbound** from all three visible panes and **≈ 177 ms** to new
  pixels, of which **99.0% is waiting for the next poll** (measured sidecar+decode work
  is 1.7 ms).
- Parked pane: 36/36 crosshair moves re-sent a byte-identical image — **≈47 kB each**.
- Surface: **1,093,022 B** full mesh (one-time, `meshRev` cached) and **109,679 B**
  colours-only *per display change*; 5.79 ms / 4.30 ms p50. Pick: 4.92 ms.
- Graph: 3,067 B / 0.09 ms at the demo's grid 2; 180,024 B / 3.99 ms at grid 16.
- Client CPU proxy (V8, not browser): PNG path **< 0.2 ms**; full mesh load ~1.0–1.3 ms.

---

## 1. What is actually implemented

The prototype has three rendering paths, each with a different split of work:

| Path | Server (FFS semantics) | Client (browser) | Code |
|---|---|---|---|
| **Slice pane** | `compose.render_viewport` composites every visible layer, applies colormap/threshold/sign/alpha/boxed/mask, samples the plane, returns **RGBA8 PNG at the cropped native plane resolution** plus surface outlines, crosshair position and the view mapping | decodes PNG (`Image`), draws it with `drawImage` at an integer-ish upscale with `imageSmoothingEnabled = false`, strokes outlines and crosshair, draws text | `python/ffsviewer/server.py:350-417`, `ffs-harness-viewer/client.js:839-1016` |
| **Surface pane** | `surface3d.shape_positions/faces/hemisphere_models` → world-space mesh; `surface.profiles.sample_depths` + `surface3d.reduce_depth` + `surfacelayers.layer_rgba` + folding `over` → one RGBA per vertex; **picking** `surface3d.pick` | WebGL2, two draw calls (one per hemisphere), JS-computed vertex normals, camera pose/orbit/zoom entirely client-side | `python/ffsviewer/surface_ops.py`, `python/ffsviewer/server.py:513-549`, `ffs-harness-viewer/client.js:1019-1313` |
| **Graph pane** | `PlaneLayout` cell placement + `ViewerSession.timeseries` + `detrend_trace` → JSON number arrays | canvas 2-D line rasterization, time cursor, legend | `python/ffsviewer/series_ops.py`, `ffs-harness-viewer/client.js:1315-1465` |

Everything scientific is server-side: the client never re-derives a coordinate mapping,
a colormap lookup, a threshold decision or a surface sample. The client does own camera
pose for surfaces, canvas size, hover, and the pixel-preserving upscale of slice PNGs
(`client.js:898-899`). Full state is polled from `state` (`client.js:310-322`), at
**350 ms while the workspace is open, 1100 ms while closed**; no state push or
conditional GET exists (`rev` is in the snapshot but the client never sends it back).

The render result's own documentation says it: *"The client never re-derives these
mappings"* (`docs/API.md:135`).

---

## 2. Method

- **Environment.** Apple M4 (10 cores), macOS 27.2/arm64, Python 3.15.2 in
  `.venv` (numpy 2.5.4), FFS 0.1.0, sidecar 0.1.0, `device: cpu`.
  Node 26.13.0 (V8) for the client-CPU proxy.
- **Process.** Spawned exactly as the Host spawns it:

  ```bash
  PYTHONPATH=python:reference/fastfuncstuff \
  .venv/bin/python -u -m ffsviewer.server \
      --project-root . --state-dir <tmp> --no-autosave
  ```

  then `open {"preset":"demo"}` → 64×64×48 grid (1.5 mm), anat + 80-volume func +
  2-volume stats, 3 layers (`A` visible gray, `F` hidden, `S` visible redblue
  threshold 2.5 alpha linear), three image viewports, one surface viewport
  (`inflated`, depth 0.5–0.5, 1 sample, folding curv), one graph viewport (grid 2).
- **Samples.** 36 samples per latency cell (≥30 as required); 12 samples for the
  grid-8/16 graph cells and 6 for the pick-miss cell. Every latency is wall time around
  a request write + response read on the local pipe (`perf_counter`), i.e. it
  **excludes** the Host's IPC/JSON work and the browser.
- **Cold vs warm.** Every mutating command clears the sidecar render cache
  (`server.py:98-103`), so a "cold" frame below means *state changed, then render* —
  the path the UI actually takes. "Warm" means an identical repeat with no intervening
  command (in-process cache hit, `server.py:358-360`).
- **Bytes.** "line bytes" = the complete NDJSON response line on the wire (JSON envelope
  included), the closest available proxy for the browser's payload. base64 expansion is
  reported separately from decoded bytes. The browser adds an authenticated RPC envelope
  around this, so real wire bytes are slightly larger. PNG and outline byte counts are
  exact; **line-byte medians move by ±~60 B between runs** because the growing `rev`
  digit count and `crosshairPx` decimal strings change JSON length — treat the last
  digits as indicative.
- **Client CPU proxy.** A Node/V8 script (embedded in the benchmark) measures
  JSON parse, the client's own `toB64Bytes` loop, PNG zlib-inflate+unfilter, and the
  client's own `vertexNormals` (`client.js:1091-1105`) over the real payloads. **This is
  not a browser measurement**: no browser automation exists in this checkout, so canvas
  `drawImage`, WebGL upload/raster and React reconciliation are *not measured*.
- **Variance.** The machine is shared with other agent work. Five full 36-sample runs
  gave the same byte counts exactly (data-determined) but p50 latencies spread by
  10–40%: across five runs cold V1 render p50 was 1.32–1.90 ms, surface colours-only
  4.30–5.40 ms, `surface_pick` 4.92–6.07 ms. Tables below quote one representative
  run (F, the quietest of the five) and give the range where it matters.
- **Scale caveat.** This demo is small: 64×64×48 voxels, 80 TRs, and **10,242
  vertices / 20,480 triangles per hemisphere** (a decimated surface; fsaverage is
  ~163,842 vertices/hemi). Byte counts are real for this demo; extrapolations to a real
  dataset are marked **estimated** and scale linearly.

---

## 3. Measurements

### 3.1 Boot

| Item | Measured |
|---|---|
| `open {"preset":"demo"}` (load NIfTIs, build session, initial save) | **341–446 ms** |
| Initial snapshot | 8,096 B line |
| First render in the process (V1) | **15.6–18.5 ms** (one-time torch/LUT warm-up) |
| First render of V2/V3 after that | 1.4–2.1 ms |
| First `surface` call (full mesh, cold) | **9.8–11.8 ms** |

The first-touch penalty is a per-process cost only; it is not in steady-state numbers.

### 3.2 Slice rendering — `render`

Cold frames, state bumped before each call, 36 samples; the run-to-run spread is
quoted in §2:

| View | Plane (rows×cols) | p50 / p95 / max (ms) | PNG b64 | PNG binary | outlines binary | line bytes |
|---|---|---|---|---|---|---|
| V1 axial | 64×64 | 1.32 / 1.61 / 1.92 | 5,818 | 4,363 | 29,824 | 46,035 |
| V2 sagittal | 48×64 | 0.90 / 1.11 / 1.19 | 4,636 | 3,476 | 11,616 | 20,434 |
| V3 coronal | 48×64 | 1.12 / 1.31 / 1.41 | 4,468 | 3,350 | 23,456 | 36,401 |

Canonical fixed slice (crosshair 32,32,24, surfaces `white,pial`, zoom 1) — the numbers
used in the decision matrix:

| View | Span (rows×cols) | PNG b64 / binary | Outlines b64 / binary | Line bytes | Result JSON |
|---|---|---|---|---|---|
| V1 axial | 64×64 | 6,608 / 4,956 B | 39,776 / 29,824 B (4 outlines, 1,864 segs) | 46,979 B | 46,948 B |
| V2 sagittal | 48×64 | 4,660 / 3,493 B | 0 (plane at x≈0 misses the midline gap) | 4,958 B | 4,927 B |
| V3 coronal | 48×64 | 4,600 / 3,449 B | 32,768 / 24,576 B (4 outlines, 1,536 segs) | 37,983 B | 37,952 B |

**Warm** identical repeats: V1 0.07 / 0.07 / 1.50 ms, V2 0.04 / 0.05 / 1.12,
V3 0.05 / 0.06 / 0.06 — 4.4–5.0% of cold p50 (occasional GC outliers appear at p95/max).
The cache works, but the UI can never hit it: the key contains the global `rev`, which
every command bumps (`server.py:357-365` + `_bump` at `server.py:88-100`), so a *parked*
pane whose image did not change still re-renders cold and re-sends the full frame
(§3.4).

**What the bytes are.** In the canonical V1 frame the PNG is **14% of the response**
and surface outlines are **85%**; in V3, 12% / 86%. In the sweep medians the same split
holds (V1 12.6% / 86.4%, V2 22.7% / 75.8%, V3 12.3% / 85.9%). The client decodes the
outline segments with `decodeF32` and strokes 735–1,864 segments per frame
(`client.js:898-912`). **Surface outlines, not PNG pixels, are the dominant slice wire
cost when outlines are on.** Hiding surfaces (`SHOW_SURFACES ''`) drops V1 from
46,035 B / 1.32 ms to **6,101 B / 0.71 ms** — i.e. outlines cost ≈ 39.9 kB and
≈ 0.6 ms p50 per frame.

### 3.3 Zoom and threshold

Zoom **crops** the sampled window instead of interpolating (`slicing.py:99-132`:
`span = round(extent / zoom)`), so both pixels and PNG shrink, while outline payload
(computed from the cropped geometry) barely moves:

| View/zoom | span | p50 ms | PNG b64 | line bytes |
|---|---|---|---|---|
| V1 ×1 | 64×64 | 1.22 | 6,608 | 46,979 |
| V1 ×2 | 32×32 | 0.92 | 2,176 | 42,549 |
| V1 ×4 | 16×16 | 0.84 | 644 | 41,016 |
| V1 ×8 | 8×8 | 0.82 | 268 | 40,636 |
| V2 ×1→×8 | 48×64 → 6×8 | 0.90 → 0.57 | 4,660 → 212 | 4,959 → 507 |
| V3 ×1→×8 | 48×64 → 6×8 | 1.05 → 0.73 | 4,600 → 216 | 37,984 → 33,599 |

Threshold sweep on layer S (1.0 → 5.0, 36 values): p50 1.25 / p95 1.47 / max 1.54 ms;
PNG b64 ranged 6,352–6,760 (median 6,582), line bytes 46,954. **A threshold change
re-renders the whole slice at full cost**, and the image bytes change little, but there
is no delta mechanism, so the browser refetches everything.

### 3.4 Parked panes re-send unchanged images

With V1 unlocked and parked at slice 24, 36 crosshair moves (`SET_IJK`):

- PNG was **byte-identical in 36/36** frames.
- `crosshairPx` changed in **35/36** frames.
- Median response **≈47 kB** (46,983–47,043 B across runs; PNG 6,608 B b64 + outlines
  39,776 B b64), p50 1.20–1.86 ms.

Every crosshair move re-sends the complete image and outline geometry in order to move
a 2-px crosshair line. The same happens to *other* panes on any display command:
`_bump` invalidates all views, and the pane effects key on the global `snapshot.rev`
(`client.js:859`, `:1134`, `:1165`, `:1336`, `:1344`).

### 3.5 Interaction commands and the 350 ms poll

| Endpoint | n | p50 / p95 / max (ms) | line bytes (median) |
|---|---|---|---|
| `state` | 36 | 0.35 / 0.57 / 0.62 | **8,063 B** |
| `execute SET_IJK` | 36 | 0.43 / 0.57 / 1.69 | 8,175 B |
| `pick` (click → crosshair) | 36 | 0.44 / 0.59 / 0.64 | 8,115 B |
| `pan` (one pointermove) | 36 | 0.43 / 0.49 / 0.55 | 8,079 B |
| `zoom` (one right-drag step) | 36 | 0.42 / 0.49 / 0.55 | 8,082 B |
| `step` (one wheel notch, slices) | 36 | 0.71 / 0.89 / 2.03 | 8,086 B |

Every command response carries the **full snapshot** (~8.1 kB), because the state is
serialized unconditionally (`server.py:312-318` → `build_snapshot`). Snapshot
composition at the demo's shape (8,013 B in a separate probe): **viewports 4,129 B
(52%)** — five viewport dictionaries of ~825 B each, mostly default fields the client
ignores — layers 2,195 B (27%), sources 354 B, workspace layout 416 B, surfaces 166 B,
grid 126 B.

**Poll bandwidth** (workspace open, 350 ms → 171.4 polls/min): **1,382 kB/min**
(8,063 B × 171.4). With the workspace closed the client polls at 1100 ms → 484 kB/min.
The poll is a full snapshot every time: the client does not send `rev`, and
`revByCategory` exists in the payload (`snapshot.py:120`) but is never read by
`client.js` (grep: no occurrence). The client also does **not** use the `state` returned
by command responses — `run()` only logs `result.state.rev` (`client.js:418-433`);
the UI snapshot only ever changes on the next poll timer.

**Derived interaction budget, default demo layout** (measured components):

| Estimate | Value |
|---|---|
| One click, all panes refetch | **175.0 kB** = poll 8.1 + pick 8.1 + V1 render 46.0 + surface colours 109.7 + series grid-2 3.1 |
| Share of that click: surface colours | 62.7% |
| Share of that click: slice render | 26.3% |
| Drag: one `pan`/`zoom` command per pointermove, unthrottled; at 60/s + 350 ms poll | **≈ 985 kB/s** = 8,079 B × 60 + 175.0 kB / 0.35 s (≈ 1.47 MB/s at 120/s) |
| Click → new pixels (mean) | **≈ 177 ms** = pick 0.44 + render 1.28 + PNG-decode proxy 0.02 + **poll wait ~175 ms (99.0%)** |
| Bytes the browser decodes per click | **≈ 176 kB JSON text** (poll 8.1 + pick 8.1 + render 46.9 + surface colours 109.6 + series 3.1 kB) plus **≈ 117 kB base64→binary** (PNG 5.0 + outlines 29.8 + surface colours 82.0 kB); the 737 kB mesh binary is decoded only when `meshRev` changes |

The client sends one `pan` (or right-drag `zoom`) command per `pointermove` with no
throttle (`client.js:975-989`); 60/s is a conservative input rate, 120/s is possible on
high-rate pointers. That rate is read from the code, not measured in a browser; the
sidecar-side byte counts and latencies are measured. A wheel notch is a `step` command
(8,086 B, 0.71 ms p50) — slice stepping also pays the full snapshot.

The poll wait is architectural: the timer runs independently of commands, so the user
waits on average half the poll interval (max 350 ms + RTT).

### 3.6 Surface rendering — geometry + server colours

Demo mesh: **10,242 vertices / 20,480 triangles per hemisphere** (two hemis).
Payload components per hemisphere: positions 122,904 B (b64 163,872), faces 245,760 B
(b64 327,680), per-vertex RGBA 40,968 B (b64 54,624). Per orbit frame the browser issues
2 `drawElements` calls, **61,440 indices and 20,480 triangles per hemisphere**
(122,880 indices / 40,960 triangles total), re-uploading 81,936 B of colour data.

| Case | n | p50 / p95 / max (ms) | line bytes | mesh b64 | colours b64 |
|---|---|---|---|---|---|
| samples=1, full mesh + colours | 36 | 5.79 / 5.96 / 6.25 | **1,093,022 B** | 983,104 | 109,248 |
| samples=1, colours only (`meshRev` matches) | 36 | 4.30 / 6.05 / 8.78 | **109,679 B** | none | 109,248 |
| samples=5, full | 36 | 11.59 / 11.90 / 12.02 | 1,093,022 | 983,104 | 109,248 |
| samples=5, colours only | 36 | 9.95 / 10.24 / 10.26 | 109,679 | none | 109,248 |
| samples=9, full | 36 | 16.00 / 16.37 / 16.93 | 1,093,022 | 983,104 | 109,248 |
| samples=9, colours only | 36 | 14.49 / 14.75 / 14.98 | 109,679 | none | 109,248 |

Reading:

- Geometry is a **one-time ~1.09 MB** cost (client caches by `meshRev`, and `meshRev` is
  identical across depth samples — verified). But the server recomputes geometry on
  **every** `surface` call before checking `client_mesh_rev`
  (`surface_ops.py:179-216`), so colours-only still pays the mesh maths: 4.30 ms vs
  5.79 ms at samples=1.
- Colours are **109.7 kB per display change** and are recomputed for every call; the
  sidecar's `_surface_cache` is written (`server.py:527`) but never read — dead code.
- Depth sampling is the expensive knob: colours-only 4.3 → 10.0 → 14.5 ms at 1/5/9
  samples for the same payload. The client's own default is 1 sample.
- Client side: parse full mesh 0.34 ms + 0.63 ms to decode and compute normals for one
  hemisphere (V8 proxy); colours parse 0.03 ms + 0.05 ms to bytes; WebGL re-uploads the
  2×40,968 B colour buffer with `DYNAMIC_DRAW` on every draw, including every orbit
  frame (`client.js:1236-1249`) — byte count measured, GPU time not measurable here.
- **Real-scale estimate:** at fsaverage ~163,842 vertices/hemi (16×), the mesh payload
  becomes ≈ 15.7 MB one-time and per-vertex colours ≈ **1.31 MB per display change**;
  that is a linear estimate from the demo payloads, not a measurement.

### 3.7 Surface picking

Server-authoritative Möller–Trumbore over both hemispheres, then two commands
(`SET_XYZ`, `SELECT_SURFACE_VERTEX`) and a full snapshot in the response
(`server.py:530-549`, `surface_ops.py:219-256`):

| Case | n | p50 / p95 / max (ms) | line bytes |
|---|---|---|---|
| hit (ndc 0.2, 0.0) → vertex 709 | 36 | 4.92 / 5.04 / 5.15 | 8,325 B |
| miss (background, -0.98,-0.98) | 6 | 4.28 / 4.40 / 4.40 | 776 B |

On this decimated mesh a hit is ~5 ms of server CPU (it is a linear scan over 40,960
triangles per hemisphere). The error path is an `internal` error envelope (776 B), not a
typed "no hit" result — worth normalising before browser use.

### 3.8 Graph rendering — `series`

| Grid | cells / traces / points | n | p50 / p95 / max (ms) | line bytes |
|---|---|---|---|---|
| 1×1 | 1 / 1 / 80 | 36 | 0.04 / 0.05 / 0.09 | 964 B |
| 2×2 (demo default) | 4 / 4 / 320 | 36 | 0.09 / 0.11 / 0.23 | **3,067 B** |
| 4×4 | 16 / 16 / 1,280 | 36 | 0.27 / 0.30 / 0.41 | 11,499 B |
| 8×8 | 64 / 64 / 5,120 | 12 | 1.00 / 1.16 / 1.19 | 45,201 B |
| 16×16 | 256 / 256 / 20,480 | 12 | 3.99 / 4.08 / 4.10 | **180,024 B** |

Values are rounded float32 JSON arrays; payload scales linearly with cells × TRs. The
client draws them on a 2-D canvas (`client.js:1347-1436`) — no science lives in that
drawing, only line rasterization. At 80 TRs even grid-16 is fine; at 1,000 TRs the
grid-2 payload is ~12.5× larger (≈ 38 kB) and the grid-16 payload ~2.25 MB (**estimated**
linear scaling). The graph is refetched on every global rev bump, including pure
slice-navigation bumps (3.1 kB each at the demo default).

### 3.9 Client CPU proxy (Node 26 / V8, same machine)

| Operation | n | p50 / p95 / max (ms) |
|---|---|---|
| `JSON.parse` state (8.1 kB) | 300 | 0.014 / 0.020 / 0.171 |
| `JSON.parse` render result (47 kB) | 200 | 0.014 / 0.023 / 0.092 |
| `JSON.parse` surface colours-only (110 kB) | 200 | 0.031 / 0.065 / 0.090 |
| `JSON.parse` full surface mesh (1.09 MB) | 30 | 0.340 / 0.431 / 0.491 |
| `JSON.parse` series grid-4 (11.5 kB) | 200 | 0.025 / 0.032 / 0.071 |
| client `toB64Bytes` PNG (4,956 B out) | 200 | 0.009 / 0.020 / 0.055 |
| PNG zlib-inflate + unfilter (16,448 B RGBA) | 200 | 0.021 / 0.042 / 0.680 |
| client `decodeF32` outlines (7,456 B) | 200 | 0.009 / 0.012 / 0.017 |
| client `decodeU8` surface colours (40,968 B) | 200 | 0.045 / 0.070 / 0.553 |
| client `decodeF32` mesh positions (122,904 B) | 100 | 0.133 / 0.168 / 0.216 |
| client `decodeU32` mesh faces (245,760 B) | 100 | 0.226 / 0.327 / 0.395 |
| client mesh decode + `vertexNormals` (one hemi) | 30 | 0.625 / 1.228 / 1.329 |

So the client CPU that can be measured is **well under 0.2 ms for an ordinary slice
frame** (base64 0.01 + inflate 0.02 + JSON 0.01 + outlines 0.01) and ~1.0–1.3 ms for a
full mesh load (JSON 0.34 + two hemispheres of decode/normals). The browser's own PNG
decode (`Image`/`ImageBitmap`) is native and not measured; for a 64×64 image it is
dominated by per-image overhead, not pixels. `drawImage`, WebGL buffer upload and raster
are **not measured** — that gap is why the decision matrix does not lean on GPU claims.

### 3.10 Compressibility (informational — transport is JSON today)

zlib-1 ratios on the real payload bytes: state JSON **0.223**, render JSON 0.562,
slice outlines 0.442, surface colours 0.484, faces 0.363, positions 0.793. A binary or
compressed transport would cut the dominant slice-overlays and surface-colour payloads
roughly in half without touching any FFS semantics.

---

## 4. Alternatives and decision matrix

All byte numbers are measured on the demo; "per frame" means one user interaction that
requires new display data. CPU/GPU placement of each option: **A/D1** = FFS compositing
on the sidecar CPU, then a client GPU blit of the decoded PNG; **B** = sidecar CPU
extracts the plane, client CPU does LUT/threshold/composite into ImageData; **C** = all
display math in a client fragment shader sampling a volume texture, sidecar only for
LUTs/uniforms and picking; **D2** = FFS compositing on the sidecar CPU at display
resolution, client GPU blit only. The client-side GPU costs are not measurable in this
checkout (§2), so the matrix prices them by bytes and duplicated semantics, not by
frame time.

### 4.1 Slice path

| Option | Per-frame inbound bytes | Server CPU / frame | Client cost | Semantic-fidelity risk | Effort | Verdict |
|---|---|---|---|---|---|---|
| **A. Current: server PNG at native span + client nearest upscale** | 4,958 B (V2, no outlines) – ≈47.0 kB (V1, 4 outlines); PNG alone 3.3–5.0 kB binary | 0.71 ms (no outlines) – 1.32 ms p50 | PNG decode 0.02 ms proxy + one `drawImage`; drawImage/GPU not measured | **None** — all FFS semantics server-side | 0 | **Keep** |
| **B. Raw float32 plane + JS colormap/threshold** | V1 **21,848 B** b64 (zlib 15,784), V2/V3 16,384 B (zlib 12,004–12,636) — **3.3–3.6× the current PNG-only bytes**; plus a second stat plane when threshold uses another sub-brick (~2× again) and a LUT (~1 kB) | Lower (no colormap/composite/PNG encode); extraction still needed. The colormap/threshold/mask/boxed/alpha/composite/sign/NaN/interpolation semantics must be reimplemented in JS and kept in parity with FFS | LUT lookup per pixel (cheap) + ported semantics + parity tests | **High** — duplicates the science; every FFS colormap/alpha/sign/mask change becomes a two-place change; the API's "client never re-derives" invariant dies | Large (est. 2–4 weeks + permanent parity suite) | **Reject for Phase 2** |
| **C. WebGL texture upload of raw volume; server LUT/threshold uniforms** | 0 B per frame after residency | ≈ 0 per frame | Shader must port colormap ramps, sign modes, alpha modes (linear/quadratic), boxed edges, display mask, ROI/label palettes, NaN repair, display-grid resampling/tilt, layer compositing/opacity; picking still server | **Very high** | Very large (est. 6–10 weeks) | **Reject now.** Residency alone kills it at real scale: demo anat 0.79 MB, stats 1.57 MB, func 80 vols **62.9 MB**; a 256³ volume is 67.1 MB and 200 volumes 13.4 GB (**estimated**) — a raw-volume texture path does not fit real fMRI; only slice-texture streaming with server-side sampling/LUT would |
| **D1. Server PNG at native resolution + pixel-preserving upscale (current)** | as A | as A | nearest blit honours "a viewer must not invent voxels" (the original viewer states this rule for zoom, `slicing.py:99-112`) | None | 0 | **Keep (is A)** |
| **D2. Server renders at display resolution** | 4× nearest upscale re-encode: 13,527 B binary / **18,036 B b64** (2.73× native); 8×: 27,832 / **37,112 B b64** (5.62×); PNG encode alone 0.47 / 2.07 ms | Rises with output pixels (8× = 64× pixels); full path not implemented, so only encode cost is measured | Same decode + draw | None, but **no science gain**: nearest upscale by the client already shows the same native voxels; interpolated display would be smoother but *invents* voxels the current contract forbids | Medium | **Reject** — pays 2.7–5.6× bytes and more server work for zero semantic benefit; keep D1 |

**Recommendation for slices: keep A/D1 (server PNG at native span), fix transport and
invalidation (§6–§7).**

### 4.2 Surface path

| Option | Per-change bytes | Server CPU | Client cost | Risk | Effort | Verdict |
|---|---|---|---|---|---|---|
| **A. Current: world-space mesh + per-vertex RGBA, WebGL draw, server pick** | mesh 1.09 MB one-time; **colours 109.7 kB per display change** | 5.8 ms (full, 1 sample) / 4.3 ms (colours); 16.0 / 14.5 ms at 9 samples | JSON+decode 0.34 ms mesh / 0.03 ms colours; decode+normals 0.63 ms/hemi; WebGL re-upload 81,936 B colours per draw | **None** (sampling, layer_rgba, folding, picking all FFS) | 0 | **Keep** |
| **B. Volume-texture shader port** | 0 B per change after residency | ≈ 0 | Port `sample_depths` (equivolume white→pial), `reduce_depth`, `layer_rgba`, folding `over`, label-nearest rule into GLSL; volume residency as in C | **Very high** — surface sampling is the FFS science most likely to drift | Very large (est. 4–8 weeks + parity suite) | **Reject now** |
| **C. Server-rasterized surface PNG per orbit** | New raster + PNG per camera move (camera is currently free client-side) | per-frame server render; would make orbiting a server round trip | Loses the only currently interactive path | Medium | Medium | **Reject** |

**Recommendation for surfaces: keep geometry + server RGBA, but cache colours by
display signature and skip the redundant geometry work; compress colours (0.48 ratio)
before considering any shader port.**

### 4.3 Graph path

| Option | Per-refetch bytes | Server CPU | Client | Risk | Verdict |
|---|---|---|---|---|---|
| **Canvas from server arrays (current)** | 964 B / 3,067 B / 11,499 B / 180,024 B at grid 1/2/4/16 | 0.04–3.99 ms | line raster only | None in the raster; science is the values | **Keep** |
| Server rasterized PNG | Larger per frame than the numbers above and defeats scrubbing/hover; graph viewport still refetches on rev | PNG encode per graph change | less client work | None | **Reject** |

**Recommendation for graphs: keep canvas. Gate refetches by the analysis display
revision instead of the global revision.**

---

## 5. Which science must stay server-side

Must remain in FFS (sidecar), because a port would duplicate display semantics with no
way to prove parity:

1. **Coordinate mapping and plane layout** — `PlaneLayout` flips, row/col order, tilt,
   `PlaneView` span/origin/pan, `points_to_image` for the crosshair, and `to_ijk` for
   clicks. `slicing.py` is the single place the flip arithmetic lives; a client copy is
   the canonical source of "crosshair drawn where the click did not happen" bugs.
2. **Threshold / colormap / sign / alpha / boxed / mask / NaN-repair / interpolation
   selection** — `compose.render_plane` composes FFS LUTs, `sign_mode`, alpha modes,
   `display_mask`, ROI palettes, label edges and `resample_mode` in one place. This is
   *the* display semantics of the desktop viewer.
3. **Surface sampling and colouring** — `surface.profiles.sample_depths` (equivolume
   white→pial), `surface3d.reduce_depth`, `surfacelayers.layer_rgba`, folding `over`,
   and the rule that ROI labels are sampled **nearest** (interpolating a region number
   invents a region no voxel holds). Moving this to a shader is a science change until
   proven otherwise.
4. **Surface picking** — `surface3d.pick` resolves a click to a vertex; it is the
   authoritative link between the 3-D view and the crosshair/vertex selection. Keep
   server-side for Phase 2 (4.9–6.1 ms/hit is acceptable for a click).
5. **Time-series extraction/detrend and mode series** — `ViewerSession.timeseries`,
   `detrend_trace`, `PlaneLayout` cells (`gridgraph.py` parity).
6. **Command validation and state mutation** — the command bus. The browser must stay a
   renderer plus ephemeral view state.

Can move client-side **without changing display semantics** (and mostly already has):

- Camera pose/orbit/zoom for surfaces, canvas size, hover, DPR handling.
- Drawing the crosshair line, stroking server-provided outline segments, text/HUD,
  pixel-preserving upscale of the server PNG, PNG decode.
- Canvas line rasterization of graph values the server supplied.
- **Caching/refetch gating** by `revByCategory`/`meshRev`/display signature, and
  transport compression or binary framing — protocol changes, no semantic change.
- A client-side "unchanged" fast path that keeps the previous image (server still
  decides whether the image changed).

---

## 6. What to keep / what to change before expanding the interface

**Keep.**
- The single validated command bus and sidecar authority; the browser as renderer.
- Server-rendered PNG at native plane resolution + client nearest upscale (honours the
  no-invented-voxels rule and is the cheapest correct path at this scale).
- World-space mesh + server per-vertex RGBA for surfaces; `meshRev` caching of geometry;
  server-side picking.
- Canvas graphs from server arrays.
- The native-resolution crop for zoom (fewer pixels at higher zoom: 6.6 kB → 0.27 kB
  from ×1 to ×8 on V1).
- Separate display/analysis/source categories, the script save format, `--no-autosave`
  for measurement.

**Change before the interface grows.** These are all measured inefficiencies, not
architecture rewrites:

1. **Stop paying the poll on the interaction path.** Command responses already carry the
   snapshot but the client throws it away (`client.js:418-433`); feeding
   `result.state` into the UI would remove ~175 ms mean / 350 ms max from every click.
   *(Small; no semantics change.)*
2. **Gate pane effects on `revByCategory` (and per-viewport display fields) instead of
   global `rev`.** Measured waste per unrelated command in the demo layout: surface
   colours 109.7 kB, slice PNG+outlines 46.0 kB, series 3.1 kB. *(Small.)*
3. **Conditional render.** `render` already has an `unchanged` field, but the sidecar
   always sends `false` and the full PNG (`server.py:399-417`). Add a display-signature
   cache key (not the global `rev`) and return `{unchanged:true, png:null,
   crosshairPx}` when the plane did not change. Measured: 36/36 parked frames were
   byte-identical, ≈47 kB each. *(Small–medium; also makes the existing warm cache
   actually reachable.)*
4. **Cache outlines separately** (and/or gzip them: 0.44 ratio). They are 76–86% of
   slice response bytes with surfaces shown; they change only with plane, slice
   position, span/origin and the shown-surface set, not with threshold or layer
   colour. *(Small.)*
5. **Surface colour caching.** Skip `_positions` when `client_mesh_rev` matches and
   return cached colours when the display signature is unchanged; the write-only
   `_surface_cache` (`server.py:527`) is a placeholder for this. Measured saving:
   ~4.3 ms per colours call at 1 sample. *(Small.)*
6. **Transport compression / binary frames** for the big fields — measured zlib ratios
   0.22 state, 0.36 faces, 0.44 outlines, 0.48 colours. At minimum compress the
   per-vertex colours and outlines. *(Medium.)*
7. **Fix the odd endpoints before calling them stable:** `render.unchanged` is dead;
   `surface` recomputes geometry before the `meshRev` check; `surface_pick` miss is an
   `internal` error rather than a typed empty result; the snapshot re-sends the dock
   layout (416 B) and full viewport records (52% of the poll) every tick.
8. **Instrument the browser.** No frame timing exists anywhere in this repo; add a
   Playwright/devtools timing probe before any client-side GPU rendering is funded. The
   Node proxy below is a CPU-only stand-in.

---

## 7. Phase 2 rendering plan

Ordered by measured benefit per unit of risk. Effort is an engineering estimate, not a
measurement.

| Step | What | Why (measured) | Effort | Acceptance check |
|---|---|---|---|---|
| 0 | Add a browser timing probe (Playwright or devtools trace): click→paint, orbit FPS, PNG decode, `drawImage`, WebGL upload | Currently unmeasurable; every GPU claim is a guess | Small | Trace captured for the three panes on the demo |
| 1 | Client consumes `result.state` from `pick`/`execute`; keep poll as reconciliation only | poll = 99.0% of 177 ms click latency | Small | Click→new pixels < 20 ms sidecar+client proxy |
| 2 | Per-category invalidation + per-viewport display signature | 175 kB/click, 63% of it unrelated surface colours | Small | Crosshair-only move triggers 0 surface/series calls; ≤1 slice render |
| 3 | Conditional render (`unchanged`/`png:null`) + outline cache | ≈47 kB per parked frame, 36/36 unchanged | Small–medium | Parked-pane move ≤ ~1 kB; outline-free frame ≤ 8 kB; compressed outline frame ≤ 25 kB |
| 4 | Surface colours cache + skip geometry when `meshRev` matches | 4.3 ms and 109.7 kB per display change | Small | Unchanged colours call < 1 ms, 0 B |
| 5 | Compress/binary the heavy fields (colours, outlines, faces, state) | zlib 0.36–0.48 on the dominant payloads | Medium | worst-case inbound per interaction < 100 kB (from 175 kB); typical click < 50 kB once step 2 lands |
| 6 | Slim the snapshot (deltas or omit unchanged viewport/layer records) | viewports are 52% of every 350 ms poll; 1.38 MB/min | Medium | Poll ≤ 4 kB, ≤ 0.7 MB/min |
| 7 | Re-evaluate C (volume textures) only after 0–6 and only with real-scale data; then implement **slice-texture streaming with server-computed LUTs**, not raw-volume residency | demo volumes 0.8–62.9 MB; real 256³×200 = 13.4 GB (est.) | Large | parity harness vs server PNG on a real dataset |
| 8 | If browser picking latency ever matters, port the *exact* Möller–Trumbore with a parity test; keep server authoritative for state changes | 4.9–6.1 ms per hit, acceptable now | Medium | 100% vertex agreement with server on random rays |

**Concrete Phase-2 recommendation:** **keep A/D1 (server-rendered native-resolution
PNG slices) as the only slice renderer, keep server mesh + server RGBA for surfaces and
server-side picking, keep canvas graphs; spend Phase 2 on latency, invalidation and
transport (steps 1–6), not on moving FFS science into JavaScript or WebGL.** Revisit a
GPU volume path only for a measured, real-scale need and only as slice-texture streaming
with server-side sampling/LUTs, behind a parity harness.

---

## 8. Honest weaknesses of the prototype (measured or stated as unmeasured)

1. **Polling, not push.** 99% of click latency and 1.38 MB/min while open; the client
   also refetches everything on any rev bump.
2. **Redundant payloads.** 109.7 kB surface colours + 46 kB slice frames re-sent when
   nothing they display changed; parked frames were byte-identical 36/36.
3. **Outlines dominate slice bytes** (76–86% of the response with surfaces shown) and
   are recomputed server-side every frame.
4. **Warm cache is unreachable in the UI** because its key contains the global rev,
   which every navigation command bumps.
5. **Snapshot is not minimal**: five viewport records (52%) and layer records (27%)
   are re-sent at 350 ms, including fields the client never reads; `revByCategory` is
   unused.
6. **Dead/placeholder protocol bits:** `unchanged` always false; `_surface_cache`
   write-only; `surface` recomputes geometry even when the mesh is cached.
7. **Scale is a toy.** 64×64×48, 80 TRs, 10,242-vertex hemispheres. Real datasets
   will change *bytes* a lot (linear estimates above: ~16× surface payloads at
   fsaverage, 12.5× graph bytes at 1000 TRs) and could change *relative* costs, but not
   the architecture conclusions.
8. **No browser/GPU measurement at all.** The client numbers are V8 CPU proxies for
   decode/parse/normals only; `drawImage`, WebGL upload/raster, React re-render and
   paint are unmeasured. Any claim that "the GPU can absorb it" is untested here.
9. **Latency noise.** Shared machine: 10–40% run-to-run spread on p50; the tables give
   one full run plus the range (across five runs: cold V1 render 1.32–1.90 ms,
   surface colours 4.30–5.40 ms, pick 4.92–6.07 ms). p95/max include GC outliers
   (e.g. warm render max 1.5–2.4 ms while p50 is 0.07 ms).
10. **Coverage gaps.** Only 3 layers (2 visible), one slice per pane, no tiled/solo/
    strip views, no time playback (`SET_INDEX`), no ROI/label or colour layers, no
    oblique/tilt, no interpolated sampling, no multi-pane split, no concurrent clients,
    no memory/GC measurement, no `restore`/cold-reopen path, and the pick-miss path is an
    error rather than a result.

---

## 9. Reproduction

```bash
cd <repo>
.venv/bin/python verification/bench_render.py -n 36 > /tmp/bench.txt   # ~7 s
.venv/bin/python verification/bench_render.py -n 36 --skip-node        # no V8 proxy
```

The script prints the tables above and one final `=== JSON ===` block with every
summary; nothing is written outside a private temp state directory (spawned with
`--no-autosave`, so `.ffs-viewer/` is untouched). Node 26 is optional; without it the
client-proxy section reports `unavailable` and the rest still runs. Data: `data/demo/`
(anat 64×64×48, func 80 vols, stats 2 vols, subject surf). Run-to-run spread: run the
script twice and compare the p50 columns.

---

## Addendum: optimizations applied after the measurements above

The evaluation above measured the prototype *before* the two largest payload redundancies
were addressed. Two conditional-transfer tokens were then added and measured with
`verification/bench_render.py`'s method (single run, same machine):

| Payload | Before | After (token hit) | Change |
|---|---|---|---|
| Slice response for an unchanged outline set (V1) | 47.0 kB line (39.8 kB b64 outlines + 6.6 kB b64 PNG) | **6.9 kB line** | outlines omitted; only PNG + mapping metadata travel |
| Surface full mesh + colours (first fetch) | 1.09 MB | 1.09 MB (unchanged, one-time) | geometry still cached client-side by `meshRev` |
| Surface colours after a threshold change | 109.7 kB | **109.7 kB** (expected: colours really changed) | no mesh re-sent (`mesh: false`) |
| Surface after an unrelated command (crosshair move) | 109.7 kB | **0.45 kB** | `colorsUnchanged: true` |

How it works: `render` accepts the client's last `outlineToken` (a hash of grid, plane,
slice position, zoom/pan/tilt, subject version and shown surfaces) and omits outlines on a
match; `surface` accepts `colorsToken` (a hash of every layer's display parameters, time
index, selection, mesh revision and the view's surface/depth settings) and omits per-vertex
RGBA on a match. The render cache key now includes the outline token so one client's
cached partial response can never be served to another that needs the outlines.

The remaining Phase-2 items from §7 are unchanged: consume `result.state` from command
responses, gate per-pane repaints on `revByCategory` (or per-viewport dirty aspects)
instead of the global `rev`, compress payloads, and slim the polled snapshot.


## Redraw pass (post-evaluation)

- Idle state polls with an unchanged revision no longer create snapshot objects or
  re-render panes.
- Slice render requests are coalesced to the newest display token with one request in
  flight per pane; rapid crosshair drags no longer queue every intermediate frame.
- Surface and series token keys are scoped to their real dependencies (shape, layers,
  time, crosshair) rather than the global revision; moving the crosshair no longer
  refetches the 3-D surface. Surface geometry is cached/prefetched per shape for instant
  Flatten/Inflated toggles.
- The surface sidecar skips positions/layout when the client already has the mesh
  revision; colour-only updates are now ~1 ms in the benchmark instead of recomputing
  geometry.
- Face and colour GPU buffers are uploaded only when they change; morph frames upload
  positions/normals only.


## Surface appearance regression

- Lighting now matches `shaders/surface.frag`: view-space headlight
  (`0.35 + 0.65 * abs(n.z)`), original folding base (`0.62 - 0.16*fold`) and the
  original 40 %-blended light for overlays.
- Volume overlays on the 3-D surface now stream their **3-D R32F volume texture** plus
  white/pial/area vertex attributes. The fragment shader mirrors `shaders/surface.frag`:
  it samples between white and pial at the requested depth (including equivolume),
  checks the volume bounds, applies the FFS LUT/sign/threshold/alpha per fragment, and
  composites over the folding base. `overlayToken` avoids resending the volume when only
  threshold/colormap/alpha/depth change.
- Texture filtering is nearest by default, as in the original surface window. One volume
  overlay per surface is handled this way; multiple overlays/labels still use the CPU
  colour path.


## Colour bar

The rail colour bar mirrors `viewer/ui/colorbar.py` in a horizontal orientation: values
run min at the left to max at the right through the FFS LUT, sign mode and pane count; sub-threshold values are
dimmed by the same fade as the alpha ramp; threshold lines are drawn at +threshold and
-threshold only when the threshold reads the displayed sub-brick. Click/drag sets the
threshold on the bar and Shift+click reverses the scale. Min/max are edited beside the
bar and Auto uses FFS AUTORANGE.
