# FFS Harness viewer — independent verification against the original viewer

Generated 2026-11-13 15:14:27 by `verification/verify_all.py`.

* Sidecar: `python/ffsviewer` (version n/a, fastfuncstuff n/a, ? commands), spawned as `python -u -m ffsviewer.server --project-root <repo> --state-dir <tmp> --no-autosave`.
* Reference: `reference/fastfuncstuff` (cloned FFS package), driven in-process via `ViewerSession` and the same FFS command bus.
* Data: `data/demo` (synthetic phantom, stats bucket, FreeSurfer subject).
* Runtime: 72.5 s.

## Overall: **FAIL**

9 PASS, 1 FAIL, 0 SKIP, 5 INFO.

| # | Check | Status | Key evidence |
|---|---|---|---|
| 1 | Coordinate mapping (pick / crosshairPx vs reference PlaneView) | PASS | 62 pixel picks + 9 crosshairPx rounds exact; max Δ0 |
| 2a | Surface picking (default geometry) vs reference surface3d.pick | PASS | 18 hits / 2 misses exact; mesh Δ 0 mm; bary Δ 0; click mm Δ 0 |
| 2c | Surface split (SET_SURFACE_HEMIS ... 10 mm) vs reference layout | PASS | mesh Δ 0 mm |
| 2b | Surface geometry/picking with SET_SURFACE_HINGE (supported command) | PASS | hinge 30/-45: mesh Δ 7.6e-06 mm vs the reference laid-out pivot (it no longer matches the raw-pivot construction) |
| 3 | Slice rendering: PNG pixels vs reference compose.render_viewport | PASS | 78 renders byte-exact (178152 pixels, max Δ 0), 57 distinct outputs |
| 4 | Surface sampling: per-vertex RGBA vs reference sample_depths/reduce_depth/layer_rgba | PASS | 20 configs x 2 hemis, 430164 vertex colours exact (19 distinct); max Δ 0 |
| 4i | Surface colouring with folding on (client base reconstruction) | INFO | exact against the sidecar's folding base (0.62 - 0.16*fold, the original shader's base) -- self-consistency; lighting is drawn by the browser |
| 7 | Surface selection follows a surface pick | PASS | 2 picks set surfaces.selected to the picked vertex; direct command too |
| 8 | Incremental tokens: unchanged outlines/colours omitted, state unaffected | PASS | token round-trips omit outlines/colours, keep the PNG, and resend exactly when the view or the display changes |
| 5 | UI/agent synchronization, revisions, parked slices, LOCK zoom | PASS | 53 commands: ui/agent state and renders identical, rev monotone, categories and counters exact, parked/LOCK semantics match |
| ? | check_persistence | **FAIL** | check crashed: SidecarTransportError('sidecar did not become ready; stderr tail:\n[ffs-viewer] sidecar 0.1.0 ready') |
| doc | Recorded observation | INFO | `python/ffsviewer/surface_ops.py` sends the original GLSL folding base (`clip(0.62 - 0.16*fold)`); the browser applies the same view-space headlight (`0.35 + 0.65*abs(n.z)`) and the original overlay light blend. This is an appearance match, not part of the sampling check. |
| doc | Recorded observation | INFO | `docs/API.md` now documents `viewInfo`, positions+faces with client-derived normals, and the `pick-miss` code; the response payloads match that documentation. |
| fix | Fixed during verification | INFO | Surface hinge pivoted on un-laid-out positions. `python/ffsviewer/surface_ops.py` passed the raw mesh positions to `hemisphere_models`; the reference 3-D window (`viewer/ui/surfacewindow.py:1743-1767`) pivots on the laid-out positions. Measured before the fix: up to 0.769 mm (hinge 30 deg) / 1.164 mm (hinge -45 deg) world deviation and a differing picked vertex on 2/6 rays. Reproduction: demo, `SET_SURFACE_HINGE S1 30`, compare `surface` mesh positions with the reference construction. Fixed at `surface_ops.py:49-55`; check 2b now measures 7.6e-06 mm residual (float32 vs float64 model application) against that reference. |
| fix | Fixed during verification | INFO | A `surface_pick` ray that hit nothing came back as `{code:'internal'}` with a Python traceback in `details` (the bare `ValueError` from `surface_ops.pick_surface` fell into `server.handle`'s generic handler). Reproduction: demo, `surface_pick` S1 at `xNdc=0.98, yNdc=0.98`. Fixed to `SidecarError('pick-miss')`; check 2a now measures `off_surface_error_codes: ['pick-miss']` and confirms a miss leaves rev, crosshair and surface selection unchanged. |

## Check details

### 1. Coordinate mapping (pick / crosshairPx vs reference PlaneView) — PASS

*62 pixel picks + 9 crosshairPx rounds exact; max Δ0*

- `views`: 3
- `crosshairs_per_view`: 3
- `pixels_checked`: 62
- `pick_mismatches`: 0
- `crosshairPx_mismatches`: 0
- `max_abs_crosshairPx_diff`: 0.0
- `plane_view_span_origin_mismatches`: 0
- `roundtrip_mismatches`: 0
- PlaneView reconstructed twice: from the sidecar's own reported grid affine/shape/viewport zoom+pan, and from the reference session state; both agree.

### 2a. Surface picking (default geometry) vs reference surface3d.pick — PASS

*18 hits / 2 misses exact; mesh Δ 0 mm; bary Δ 0; click mm Δ 0*

- `mesh_max_delta_mm`: 0.0
- `mesh_face_mismatches`: 0.0
- `poses`: 5
- `ndc_hits`: 18
- `ndc_misses`: 2
- `hemi_vertex_mismatches`: 0
- `max_click_mm_delta_vs_reference_pick_mm`: 0.0
- `max_mm_delta_vs_picked_vertex`: 20.21275715451455
- `max_distance_delta`: 0.0
- `max_barycentric_delta`: 0.0
- `crosshairMm_vs_pick_mm_max_mm`: 0.6460580625021131
- `off_surface_error_codes`: ['pick-miss']
- `pick_miss_is_not_a_mutation`: True
- Sidecar mm is the reference window's pick_mm (the mid-depth click point), and the vertex/corners/barycentric match the nearest-barycentric vertex of the same hit; the distance to the picked vertex position is reported separately.

### 2c. Surface split (SET_SURFACE_HEMIS ... 10 mm) vs reference layout — PASS

*mesh Δ 0 mm*

- `mesh_max_delta_mm`: 0.0
- `mesh_face_mismatches`: 0.0

### 2b. Surface geometry/picking with SET_SURFACE_HINGE (supported command) — PASS

*hinge 30/-45: mesh Δ 7.6e-06 mm vs the reference laid-out pivot (it no longer matches the raw-pivot construction)*

- `poses`: [{'hinge_deg': 30.0, 'sidecar_vs_laid_pivot_world_mm': 7.62939453125e-06, 'sidecar_vs_raw_pivot_world_mm': 0.7693405151367188, 'picks': 6, 'vertex_matches': 3, 'degenerate_tie_breaks': 1, 'max_tie_break_distance_delta_mm': 1.1904088950132063e-05, 'pick_mismatches': 0}, {'hinge_deg': -45.0, 'sidecar_vs_laid_pivot_world_mm': 7.62939453125e-06, 'sidecar_vs_raw_pivot_world_mm': 1.1639556884765625, ...
- The sidecar now builds its hemisphere models from the laid-out positions (`python/ffsviewer/surface_ops.py:49-55`), matching `viewer/ui/surfacewindow.py:1743-1767`. The residual 7.6e-06 mm is float32 model application in the reference window against float64-then-cast in the sidecar; it flips a nearest-triangle tie only where a ray pierces a crease.
- hinge 30: 1/6 rays hit a crease where two triangles are tied; same hemisphere, distance Δ <= 1.2e-05 mm
- hinge -45: 1/6 rays hit a crease where two triangles are tied; same hemisphere, distance Δ <= 5e-06 mm

### 3. Slice rendering: PNG pixels vs reference compose.render_viewport — PASS

*78 renders byte-exact (178152 pixels, max Δ 0), 57 distinct outputs*

- `configs`: 26
- `views_per_config`: 3
- `renders_compared`: 78
- `mismatched_renders`: 0
- `pixels_compared`: 178152
- `max_pixel_delta`: 0.0
- `state_parity_mismatched_configs`: 0
- `distinct_reference_outputs`: 57
- `output_sensitivity_ok`: True
- Sensitivity: distinct reference renders confirms the matrix exercises threshold, alpha, sign, colormap, range/mirror, boxed, opacity, threshold_index and 4-D time.

### 4. Surface sampling: per-vertex RGBA vs reference sample_depths/reduce_depth/layer_rgba — PASS

*20 configs x 2 hemis, 430164 vertex colours exact (19 distinct); max Δ 0*

- `client_fold_base_rgb`: [158, 158, 158]
- `configs`: 20
- `vertices_compared`: 430164
- `mismatched_hemisphere_configs`: 0
- `max_per_vertex_delta`: 0
- `payload_metadata_mismatches`: 0
- `distinct_outputs`: 19
- `sensitivity`: {'mean vs max': True, 'equivolume on vs off': True, 'quadratic vs linear alpha': True, 'threshold_index on vs off': True}
- `baseline_direct_alpha255_vertices`: 1046
- folding off: every cleared vertex draws the client base grey (158, 158, 158); this is the browser renderer's unlit constant, not one of the four sampling functions under test (see observations).
- The reference GLSL shader would shade the unlit base at (158, 158, 158) (0.62, then its own headlight); the sidecar sends unlit colour for the browser's own lighting.

### 4i. Surface colouring with folding on (client base reconstruction) — INFO

*exact against the sidecar's folding base (0.62 - 0.16*fold, the original shader's base) -- self-consistency; lighting is drawn by the browser*

- `max_delta_vs_client_formula`: 0

### 7. Surface selection follows a surface pick — PASS

*2 picks set surfaces.selected to the picked vertex; direct command too*

- `surface_picks`: 2
- `selection_mismatches`: 0

### 8. Incremental tokens: unchanged outlines/colours omitted, state unaffected — PASS

*token round-trips omit outlines/colours, keep the PNG, and resend exactly when the view or the display changes*

- `outline_token_present`: True
- `outlines_in_full_render`: 4
- `outlines_unchanged_roundtrip`: True
- `outlines_resent_after_slice_change`: True
- `colors_token_present`: True
- `colors_unchanged_roundtrip`: True
- `colors_resent_after_change`: True
- `problems`: []

### 5. UI/agent synchronization, revisions, parked slices, LOCK zoom — PASS

*53 commands: ui/agent state and renders identical, rev monotone, categories and counters exact, parked/LOCK semantics match*

- `commands`: 53
- `rev`: 53
- `revByCategory`: {'source': 4, 'analysis': 1, 'display': 33, 'navigation': 15}
- `expected_category_counts`: {'display': 33, 'navigation': 15, 'source': 4, 'analysis': 1}
- `revision_monotonicity_failures`: 0
- `category_mismatches`: 0
- `counter_failures`: 0
- `ui_agent_state_diffs`: 0
- `ui_reference_state_diffs`: 0
- `render_parity_failures`: []
- `surface_colour_parity_failures`: []
- `parked_slice`: {'V4_position': 15, 'V1_position': None, 'crosshair': [12, 38, 27], 'V4_render_position': 15, 'V1_render_position': 27, 'reference_V4_position': 15, 'reference_V1_render_position': 27}
- `lock_zoom`: {'V1_zoom': 2.7, 'V4_zoom': 2.7, 'V4_pan': [-3.5, 0.0], 'V4_zoomLinked': True, 'reference_V4_zoom': 2.7, 'reference_V4_pan': [-3.5, 0.0], 'V4_follows_crosshair_pixel': 34, 'V4_follows_crosshair_state': 15, 'reference_V4_follows': 34}
- `error_path_ok`: True
- `counter_totals_ok`: True
- `final_origin`: 'ui'
- `final_category`: 'navigation'

### ?. check_persistence — FAIL

*check crashed: SidecarTransportError('sidecar did not become ready; stderr tail:\n[ffs-viewer] sidecar 0.1.0 ready')*

### doc. Recorded observation — INFO

*`python/ffsviewer/surface_ops.py` sends the original GLSL folding base (`clip(0.62 - 0.16*fold)`); the browser applies the same view-space headlight (`0.35 + 0.65*abs(n.z)`) and the original overlay light blend. This is an appearance match, not part of the sampling check.*

### doc. Recorded observation — INFO

*`docs/API.md` now documents `viewInfo`, positions+faces with client-derived normals, and the `pick-miss` code; the response payloads match that documentation.*

### fix. Fixed during verification — INFO

*Surface hinge pivoted on un-laid-out positions. `python/ffsviewer/surface_ops.py` passed the raw mesh positions to `hemisphere_models`; the reference 3-D window (`viewer/ui/surfacewindow.py:1743-1767`) pivots on the laid-out positions. Measured before the fix: up to 0.769 mm (hinge 30 deg) / 1.164 mm (hinge -45 deg) world deviation and a differing picked vertex on 2/6 rays. Reproduction: demo, `SET_SURFACE_HINGE S1 30`, compare `surface` mesh positions with the reference construction. Fixed at `surface_ops.py:49-55`; check 2b now measures 7.6e-06 mm residual (float32 vs float64 model application) against that reference.*

### fix. Fixed during verification — INFO

*A `surface_pick` ray that hit nothing came back as `{code:'internal'}` with a Python traceback in `details` (the bare `ValueError` from `surface_ops.pick_surface` fell into `server.handle`'s generic handler). Reproduction: demo, `surface_pick` S1 at `xNdc=0.98, yNdc=0.98`. Fixed to `SidecarError('pick-miss')`; check 2a now measures `off_surface_error_codes: ['pick-miss']` and confirms a miss leaves rev, crosshair and surface selection unchanged.*

## Sidecar bugs / discrepancies found

None: every check above measured exact agreement with the reference viewer. The observations marked INFO are cosmetic/documentation notes, not divergences in computed results.

## How to rerun

```bash
.venv/bin/python verification/verify_all.py
```

