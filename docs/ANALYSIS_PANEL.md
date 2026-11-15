# Analysis panel — autoproc-centred redesign

Status: **design v0.3, implemented 2026-11-14. EP0–EP3, the detailed §4 layout items (stage
inspector inherited values/defaults/last-run, recipe coverage/reset, options accordion/search/
changed count/path pickers/list + append chips/footer, editable output script, Generate+Run bar),
§6 routes and `ffs_pipeline_edit`, and §7 package/decision flows are built.** The remaining gap is
only **live in-browser visual/a11y verification** (no browser control in this environment);
structural verification is 45 JS + 56 Python tests, client render smoke, Host API smoke, and
export-package checksums.
Revision history: v2 (workflow builder, rejected) → v0.2 (small settings panel) → **v0.3 (this)**,
after reading the current `ffs_autoproc` source and `--help` model. The pipeline is still
`ffs_autoproc`; the UI now mirrors its actual option groups, recipes and stage plan instead of
inventing a simplified settings form.

Evidence base: `fastfuncstuff/cli/autoproc.py` (3,277 lines), its `build_parser()` (174
options, 12 groups, 31 per-stage op overrides), `fastfuncstuff/autoproc/config.py` (`RECIPES`),
`fastfuncstuff/autoproc/emit.py` (stage banners, script header, skip toggles), and a real
generated `proc_sub-001.sh`. The reference checkout and `origin/main` have an identical
`autoproc.py` (the newer upstream commits are group-level features), so this model is current.

## 0. The constraint

The panel stays a sidebar tab: check data, configure the run, watch it, judge it, package it.
It must not become a workflow builder. `ffs_autoproc` already *is* the composition language —
a recipe plus flags plus optional extra commands — so the UI exposes that language honestly
instead of layering a second model on top.

**Complexity budget**

| Resource | Budget | Notes |
|---|---|---|
| User concepts | **4**: Pipeline, Stage, Run, Decision | Stage is autoproc's own concept, not invented; recipe is the pipeline's preset |
| Option model | **served, not rewritten** | one JSON endpoint dumps the 174 flags, groups, defaults, choices and help from Python |
| New state files | **1** (`ffs-pipeline.json`: recipe + explicit overrides + commands) | no stage objects, no per-version freeze trees |
| New routes | **4** (+ reuse of tool-run for scratch) | pipeline read/save, autoproc schema, promote |
| New agent tools | **1** (`ffs_pipeline_edit`) | |
| New client components | **≈10** | stage board, row, inspector, option field, drawer, group, recipe picker, detection strip, preview, validation |
| Tabs / modes / panes | **0 new** | one Pipeline section, two panes inside it, one options drawer |

The 174 flags are data rendered from the schema, not 174 hand-written UI concepts. That is the
line that keeps the implementation small.

## 1. What a user does

1. **Check data** — pick dataset and subject; the panel shows detected runs, sessions, tasks,
   fieldmaps, SBRefs, phase and slice timing, and which stages the data makes applicable.
2. **Pick a recipe** — `bare_bones | simple | simple_linear | simple_nonlin | complete |
   extreme`, or "no preset (defaults)". The recipe description is the CLI's own.
3. **See the stage plan** — the 20 emitted stages, grouped by phase, each marked
   *will run / not applicable (no fieldmaps) / off by recipe*, in the order the script runs
   them.
4. **Tune a stage** — click a stage to edit only its flags; open the "op string" for the exact
   tool arguments with the default shown.
5. **Go deeper** — the **All options** drawer lists the same 12 groups as `ffs_autoproc -help`,
   with search, "changed only", per-field reset and per-group reset.
6. **Generate and run** — see the exact `ffs_autoproc` command and the generated script before
   running, with validation warnings; then the existing run card (stages, log, cancel).
7. **Inspect and decide** — Data/QC/Results unchanged; QC verdicts record decisions; optional
   command steps run after the script.

## 2. Autoproc is the model

> Upstream refresh (fastfuncstuff `3919968`): FFS now has **174 flags / 20 stages**. New:
> `-physio` and `-physio_mode {nuisance,clean}` (NORDIC / phase group) plus the emitted
> **stage00 physio** stage (`ffs_physio`), and new CLIs **`ffs_group`** and **`ffs_physio`**.
> The panel model includes the new flags and stage; `-glm_ortvec physio` is in the upstream
> default nuisance set.


### 2.1 Option groups (the UI's "All options" drawer, verbatim)

| Group | Flags | Examples |
|---|---:|---|
| Inputs & scope | 7 | `-bids_dir`, `-subject`, `-session`, `-task`, `-work_dir`, `-out`, `-exec` |
| Recipe | 1 | `-recipe` (6 presets) |
| Anatomical & reference space | 43 | `-anat`, `-anat_skull`, `-presurf*`, `-tpm`, `-ref_anat*`, `-surface_target`, `-do_mni` |
| NORDIC / phase | 26 | `-want_nordic`, `-noise_vols`, `-phase_proc`, `-medic`, `-phasereg*`, `-hrftdv*` |
| Slice timing & motion | 14 | `-acq`, `-slicetiming*`, `-tzero`, `-TR`, `-moco_ref`, `-motsim`, `-censor_*`, `-locomoco*` |
| Cross-run / fmap / session alignment | 19 | `-fmap_*`, `-xrun_*`, `-xfmap_*`, `-xses_*`, `-family*`, `-nl_backend` |
| GLM | 27 | `-no_glm`, `-events*`, `-glm_*`, `-clustsim*`, `-prebuilt_contrasts` |
| QC | 1 | `-no_qc` |
| Batching | 1 | `-batch_overwrite` |
| Compute device | 1 | `-device` |
| Output format | 3 | `-format`, `-final_format`, `-glm_format` |
| Per-stage option overrides | 31 | `-nordic_opts`, `-moco_opts`, `-xrun_nl_opts`, `-anat_opts`, `-mni_opts`, … |

Total: **174 flags** (175 with `-h`). The drawer is generated from the parser itself, so a new
upstream flag appears in the UI the next time the schema is dumped — no JS edits.

### 2.2 Recipes (the pipeline presets)

| Recipe | Behaviour (CLI help, condensed) |
|---|---|
| `bare_bones` | moco (→ SBRef/first volume) + GLM, in EPI space. No slice timing, distortion or anat. Fast. |
| `simple` | slice timing (if present) + distortion (if fmaps) + moco + cross-run align + linear anat + GLM |
| `simple_linear` | alias of `simple` |
| `simple_nonlin` | `simple` + nonlinear cross-run refinement |
| `complete` | `simple_nonlin` + nonlinear anat (`ffs_segment`; needs `-anat`/`-suma` and a TPM, or `-suma`) |
| `extreme` | `complete` + locomoco + GLM nuisance = motion + motion derivative + locomoco warp PCs |

Any explicit flag overrides the recipe. **No recipe means the parser defaults** (anat enabled,
distortion when fmaps exist, GLM on) — offer it as "no preset (defaults)" in the picker. The
recipe never hides the flags it sets; choosing a recipe shows the flags it implies and the
stage coverage it produces.

### 2.3 The emitted stage plan (what the board shows)

Order is from `emit.py`'s banners; every row is a real script section, and the strings are what
the run log prints.

| Phase | Stage | What it does / tool |
|---|---|---|
| Prep | preflight | input + tool checks |
| Denoise | `stage00` | NORDIC denoise, phase unwrap (`ffs_nordic`, `ffs_phase_unwrap`) |
| Timing & motion | `stage01` | slice timing (`ffs_tshift`) or MEDIC (`ffs_medic`) |
| | `stage02` | motion correction (`ffs_moco`), censoring, motsim |
| | `stage03` | residual nonlinear motion (`ffs_locomoco`) |
| Distortion | `stage04` | fieldmap distortion correction (`ffs_blipflip`, `ffs_util_b0fmap`) |
| | `stage05` | cross-fmap-group alignment (`ffs_allineate`/`ffs_moco`, nonlinear refinement) |
| Alignment | `stage06` | cross-run alignment |
| | `stage07` | run/session means (→ session common grid) |
| | `stage08` | cross-session alignment, grandmean |
| | `stage08b` | runs → grandmean space (single resample) |
| | `stage09` | anat/reference alignment (`ffs_allineate`, `ffs_segment`) |
| | `stage09b` | anat → MNI (with `-do_mni`) |
| Resample | `stage10a` | warpmaster |
| | `stage10` | final compose + resample (`ffs_nwarp`) |
| | `stage10b` | masks |
| | `stage10s` | surface sampling and surface masks (`ffs_nwarp -surf`) |
| Model | `stage12` | GLM (`ffs_reml`), clustsim |
| | `stage12s` | surface GLM (`ffs_reml` on GIFTI) |

Stage applicability is **display logic**, not a second planner:

- recipe/flag predicates: anat on/off, distortion on/off, GLM on/off, `-do_mni`,
  `-surface_target`, `-surface_glm`, `-locomoco`, `-phase_proc`;
- data predicates: runs, sessions, fieldmaps, SBEPI/phase, SBRef, `SliceTiming`, multiecho.

The board states the reason: "not in this recipe", "no fieldmaps detected", "no phase data",
"skipped: `-no_anat`". The autoproc-generated script remains the authority; mismatches are a UI
bug, not a pipeline rule.

### 2.4 The generated script contract

The script is the execution and reproduction unit. A real header:

```bash
# ffs_autoproc -bids_dir … -subject 001 -recipe bare_bones -work_dir …
#   -out …/proc_sub-001.sh -session 01 -task localizer -no_qc -device cpu
OUT=…/work/bids-lite/sub-001
DEVICE=cpu          # compute device for every ffs stage
FMT=.zst            # working intermediates
FINAL_FMT=.gz       # final timeseries
GLM_FMT=.gz         # GLM stat buckets
skip_nordic=1 skip_moco=1 skip_locomoco=1 skip_blip=1
skip_xfmap=1  skip_xrun=1 skip_runmean=1 skip_xses=1 skip_anat=1
skip_final=1  skip_stats=1
```

Consequences the UI must respect:

- **No wrapper script, no per-step orchestrator.** Generation runs `ffs_autoproc` (without
  `-exec`), execution runs `bash <script>` as one managed job. Today's stage parsing,
  completion detection, cancel and replay all keep working.
- **`skip_*` are script variables**, not CLI flags (except `-batch_overwrite` which sets
  `skip_moco`/`skip_final`). The UI exposes `-batch_overwrite`; per-stage skip toggles are shown
  read-only in the script preview, not promised as a re-run button.
- **Design TOMLs are user-owned.** Regenerating does not overwrite an existing design spec
  unless `-glm_spec_overwrite`; the UI warns when a flag that reaches the TOML changed
  (`-events`, `-glm_opts`, `-event_*`, `-round_*`, `-prebuilt_contrasts`).
- The exact CLI line is embedded in the script header; the UI's "command preview" is that
  line, not a re-invented one.

## 3. Pipeline state

`work/ffs-pipeline.json` — one small file describing the intended run, not the plan:

```jsonc
{
  "schema": "ffs-panel-pipeline/1",
  "version": 4,
  "scope": {
    "bidsDir": "data/real/ds005165", "subject": "01",
    "session": ["01"], "task": ["localizer"],
    "workDir": "work/ds005165/sub-01", "out": "work/ds005165/sub-01/proc_sub-01.sh"
  },
  "recipe": "complete",           // or null = parser defaults
  "overrides": {                  // explicit autoproc dest → value, only what the user changed
    "moco_ref": "sbref",
    "censor_motion": 0.5,
    "do_mni": true,
    "anat_skull": "auto"
  },
  "commands": [                   // optional post-run steps (v0.2 behaviour, unchanged)
    { "id": "c1", "name": "Custom resample", "argv": ["ffs_util_change_header", "…"] }
  ],
  "history": [ { "version": 3, "at": "…", "actor": "user", "summary": "enable MNI" } ]
}
```

- Every value maps to one `ffs_autoproc` dest; there is no parallel stage schema. The stage
  board is a **view** over `recipe + overrides + detected data`.
- Save writes a new version (history line, frozen copy of the resolved CLI in the run record);
  no draft/commit ceremony, no per-version directories.
- The resolved command is `ffs_autoproc <scope flags> [-recipe …] [explicit overrides]`; the
  generated script is written and can be previewed before running.

## 4. Layout

The section rail is unchanged. Inside **Pipeline**, a two-pane workspace: stage board left,
inspector right; the All-options drawer slides over the section. Narrow sidebar collapses to
one column with a stage list → inspector navigation.

```
┌ Pipeline ───────────────────────────────────────────────────────────────┐
│ Scope   ds005165 · sub-01 · ses-01 · localizer · work/ds005165/sub-01    │
│ Detected 4 runs · 1 session · 2 fmap pairs · SBRef · SliceTiming · no phase │
│ Recipe  [bare_bones] [simple] [simple_linear] [simple_nonlin] [complete●] [extreme] │
│         complete — linear+nl anat, distortion, cross-run; needs anat/TPM  │
├───────────────────────────────┬─────────────────────────────────────────┤
│ STAGE BOARD                   │ STAGE INSPECTOR · stage02 moco          │
│ PREP    preflight             │ why: always runs                        │
│ DENOISE stage00 NORDIC  (dim) │ moco reference   [sbref ▾]  changed     │
│ TIMING  stage01 slice timing  │ motion simulation [off ▾]               │
│ MOTION  stage02 moco     ▸sel │ censor motion    [off ▾]  (0.5 if on)   │
│         stage03 locomoco(dim) │ censor outliers  [off ▾]                │
│ DISTORT stage04 fieldmap      │ op string  -cost wls -twopass  [reset]  │
│         stage05 cross-fmap    │ outputs: stage02.moco.* · motsim.1D     │
│ ALIGN   stage06 cross-run     │ re-run: skip if outputs exist ✓         │
│         stage07 means         │                                         │
│         stage08 cross-session │                                         │
│         stage08b grandmean    │                                         │
│         stage09 anat          │                                         │
│         stage09b MNI          │                                         │
│ RESAMPLE stage10a warpmaster  │                                         │
│         stage10 final         │                                         │
│         stage10b masks        │                                         │
│         stage10s surfaces     │                                         │
│ MODEL   stage12 GLM           │                                         │
│         stage12s surface GLM  │                                         │
├───────────────────────────────┴─────────────────────────────────────────┤
│ [All options 174 ▾]  changed 3 · reset recipe · validate ✓               │
│ ffs_autoproc -bids_dir … -recipe complete -moco_ref first -do_mni        │
│ [Generate script] [Run]     warnings: complete needs -anat/-suma + TPM   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Scope & recipe card

- Required inputs first: dataset, subject, session(s), task(s), work dir, output script.
- Detection strip (`4 runs · 1 session · 2 fmap pairs · SBRef · SliceTiming · no phase`) from
  the existing BIDS scan, so stage applicability is explainable before the first run.
- Recipe as a segmented row or select, with the CLI's description under it and a coverage
  preview; "no preset (defaults)" is a first-class choice. `changed N` shows explicit
  overrides; "reset recipe" clears overrides **per recipe**, with a confirmation.

### 4.2 Stage board

- One row per emitted stage, grouped by phase, in script order.
- Row: number + label, tool(s), state (will run / dimmed with reason / done from last run),
  `changed` badge when any override affects it, chevron.
- Rows are **not editable inline** except the stage's own toggle where a real CLI flag exists
  (`-no_anat`, `-no_glm`, `-no_qc` — actually global; `-no_distortion`, `-locomoco`).
  Skipping a stage that autoproc has no switch for is not offered; the board says so.
- Selecting a row fills the inspector; the selection survives section switches.

### 4.3 Stage inspector

- **Why it runs**: recipe predicate + detected data, e.g. "distortion: 2 fmap pairs detected,
  `distortion` on in `complete`".
- **Stage flags**: the curated per-stage subset (see map below), rendered from the schema with
  the parser's own help, choices and defaults. Only overridden values are stored.
- **Op string**: the tool's full argument string for that stage (one of the 31
  `-<stage>_opts` flags), default shown, reset, and "diff from default".
- **Outputs**: the glob(s) the stage writes, for orientation (from autoproc naming).
- **Re-run**: read-only skip toggle state; `-batch_overwrite` is the only global force flag.
- **Inherited**: shows which recipe/ancestor flags are in effect (e.g. "set by recipe
  `complete`: anat_nonlin=yes"), so an override is never invisible.

Curated stage→flag map (unmapped flags still appear in All options):

| Stage | Inspector flags |
|---|---|
| stage00 NORDIC/phase | `want_nordic`, `noise_vols`, `cut_task_vols`, `nordic_opts`, `nordic_save_resid`, `nordic_task_rescue`, `nordic_task_qc`, `no_nordic_dof_adjust`, `phase_proc`, `no_phase_drift`, `unwrap_opts` |
| stage01 timing/MEDIC | `acq`, `slicetiming_method`, `slicetiming`, `tzero`, `tr`, `tshift_opts`, `medic`, `medic_inplane_locomoco` |
| stage02 moco | `moco_ref`, `motsim`, `censor_motion`, `censor_outliers`, `moco_opts` |
| stage03 locomoco | `locomoco`, `locomoco_detask`, `locomoco_phase`, `locomoco_task_qc`, `locomoco_opts` |
| stage04 distortion | `no_distortion`, `fmap_kind`, `fmap_pe_dir`, `fmap_ref`, `blip_opts`, `b0fmap_opts` |
| stage05 cross-fmap | `xfmap_nonlin`, `xfmap_nl_backend`, `xfmap_opts`, `xfmap_nl_opts` |
| stage06 cross-run | `xrun_method`, `xrun_nonlin`, `xrun_nl_backend`, `xrun_opts`, `xrun_moco_opts`, `xrun_nl_opts`, `xrun_nonlin_in_source` |
| stage07 means | none (derived) |
| stage08 cross-session | `xses_nonlin`, `xses_nl_backend`, `xses_opts`, `xses_nl_opts`, `xses_nonlin_in_source`, `grand_reference`, `grand_reference_nonlin`, `ref_ses` |
| stage09 anat | `no_anat`, `anat`, `suma`, `fs_subject`, `anat_skull`, `presurf*`, `spm_tpm`, `anat_t2`, `anat_nonlin*`, `ref_anat*`, `tpm*`, `anat_source`, `anat_nonlin_input`, `family*`, `nl_backend`, `anat_opts`, `segment_opts`, `anat_tpm_opts`, `synthstrip_opts`, `nwarp_opts` |
| stage09b MNI | `do_mni`, `mni_use`, `mni_template`, `mni_opts`, `mni_nonlin_opts` |
| stage10/10a/10b | `final_dxyz`, `nwarp_opts`, `batch_overwrite`, `final_format`, `glm_mask` |
| stage10s surfaces | `surface_target`, `surface_qc`, `fs_subject` |
| stage12 GLM | `no_glm`, `glm_*` (27), `clustsim*`, `events*`, `spec_event_cols`, `event_ignore`, `round_*`, `event_filter_*`, `prebuilt_contrasts`, `glm_format` |
| stage12s surface GLM | `surface_glm*`, `surface_clustsim*`, `surface_glm_opts` |

### 4.4 All-options drawer

- One accordion per parser group, same order and titles, each with its flag count.
- Search by flag name and help text (client-side over the schema dump).
- "Changed only (N)" filter; per-field reset; per-group reset; "reset all" behind confirmation.
- Every field is one flag, labelled with the parser help; choices become selects, paths become
  pickers, booleans switches, `nargs +` lists get add/remove chips.
- Footer: "These are the ffs_autoproc flags themselves; the generated script uses exactly
  these values."

### 4.5 Generate & run bar

- Resolved command (the same line the script header will carry), validation warnings, and the
  actions **Generate script** / **Run**.
- Validation is advisory and explicit: missing `-anat`/TPM for `complete`, no SliceTiming when
  `-slicetiming_method integrate`, `-glm_mask` needing a mask stage, TOML-affecting changes,
  unknown recipe/flag, path outside the project.
- "Generate script" shows the script path and a read-only preview with the header, `OUT`,
  `DEVICE/FMT` and `skip_*` variables; TOML edits are preserved unless `-glm_spec_overwrite`.
- Run is the existing recipe run: one job, stage banners, cancel, resume; identical to the CLI
  and the agent tools.

## 5. UX rules

1. **Recipe first, flags second.** A user can run a complete recipe without opening the drawer;
   every override is visible where it applies and in `changed N`.
2. **The board is the map.** Never present 174 fields as the primary surface; present the 20
   stages, then the flags of the one being tuned.
3. **No invented vocabulary.** Rows say `stage02`, `moco`, `-moco_ref` — the same words the log
   and the CLI use. A user who asks the agent "why did stage06 not run" sees the same terms.
4. **Progressive depth**: recipe → stage → op string → full group → raw command.
5. **Advisory applicability.** "Not applicable" is explained, not enforced by the UI; the
   script decides.
6. **No silent TOML loss.** Any change that touches design specs warns before generation.
7. **Same route, same tools.** The agent tools and the panel share one pipeline file and one
   generator; there is no second planner.
8. **Narrow fallback**: board becomes a list; the inspector opens as a full-width pane; the
   drawer becomes a full-height sheet.

## 6. Transport and tools

New routes on the existing `/ffs-analysis` prefix:

```
GET  /ffs-analysis/autoproc/schema     groups, flags, defaults, choices, help, recipes, stage map
GET  /ffs-analysis/pipeline            saved pipeline (scope, recipe, overrides, commands, history)
POST /ffs-analysis/pipeline            save (validate, bump version, return resolved argv)
POST /ffs-analysis/pipeline/promote    scratch run → command step
```

The schema endpoint is produced by a Python module (e.g. `python/ffsviewer/autoproc_model.py`)
that imports `build_parser()` and `RECIPES`, adds the curated stage map, and returns JSON
cached by the FFS source hash. If the installed FFS cannot be imported, the endpoint returns a
typed `autoproc-model-unavailable` error and the panel hides the drawer rather than guessing.

One new tool `ffs_pipeline_edit`: it edits the pipeline file (scope, recipe, overrides,
commands), validates, and returns the new version and resolved argv; it never runs. The agent
reads the pipeline and the schema through the existing snapshot plus this route; the existing
16 analysis tools are unchanged.

## 7. Execution, decisions, package

- Execution is exactly the CLI: generate with `ffs_autoproc` (no `-exec`), run
  `bash proc_sub-<id>.sh` as one `ctx.jobs` child; commands run after the script as separate
  children (v0.2 rule), recorded with argv/exit/hashes.
- QC and decisions: the v0.2 inline Accept/Tentative/Reject with target + sha, stored in
  project `decisions[]`; the record layer imports them when installed.
- Package: `manifest.pipeline = {version, recipe, overrides, resolvedArgv, scriptSha256,
  stages:[{id, included, tools}]}`, plus `commands.json`, `decisions.json`; `run.sh` runs the
  frozen script exactly as generated.
- Data check additions from v0.2 stay: subject/workDir resolution from `/scan`, text artifact
  previews.

## 8. Milestones

| # | Deliverable | Acceptance |
|---|---|---|
| **EP0** | Autoproc schema route + scope/recipe card + read-only stage board with detection and applicability reasons + generate-script preview + real common overrides (`recipe`, `device`, `no_qc`, `do_mni`, `anat`, `surface_target`) written to the pipeline file | changing a recipe or a common override changes the resolved command and the generated script; the board explains why a stage is off; no regression in plan/run/log/cancel |
| **EP1** | Stage inspector with curated flags, op-string editing and reset, all-options drawer with search/changed-only/reset | a user can set `-moco_ref first`, edit `-moco_opts`, and see both in the generated command and script; a new upstream flag appears in the drawer after a schema refresh |
| **EP2** | Pipeline versions/history, validation warnings (missing anat/TPM, SliceTiming, TOML-affecting changes), batch/skip display, commands + scratch + promote | two saved versions run and cite their version; warnings fire on the known cases; a scratch command becomes a step and runs after the script |
| **EP3** | QC verdicts + decisions, package additions, text previews, narrow-layout and a11y pass, docs/conformance | a Reject is recorded with actor/target and appears in `decisions.json`; package verifies; the panel works at narrow sidebar width |

Dependencies: EP3's rich record integration needs [RECORD.md](RECORD.md) R0–R1; EP0–EP2 do not.
Cohort execution stays out (v0.2 decision).

## 9. Deliberately not built

| Cut | Why | Revisit only if |
|---|---|---|
| Invented workflow/step model | autoproc already is the model; a second one doubles the concepts | a second tool family needs composing |
| Per-stage freeze trees, drafts, variants | recipe + overrides + run snapshot is enough | audit requires pre-run freezes |
| Node graph, branches, predicate language | no demonstrated need; huge cost | repeated complex cohort patterns |
| Running/deleting individual autoproc stages from the UI | only `-batch_overwrite` is a real CLI control; `skip_*` are script edits | the generated script grows a stage-run CLI |
| Template library, JSON import/export | recipes are the templates; the pipeline file is readable | cross-project reuse becomes common |
| Modes, panes beyond the one split, saved layouts | one section, two panes, one drawer | the tab becomes the primary workspace |
| Cohort execution from the panel | does not exist today; needs per-subject scripts | users run cohorts from the panel rather than the package |
| Async group/export/verify | existing behaviour tolerates it; risky to convert | a run outlives the HTTP timeout |
| In-panel code editor | owner decision: paste commands, edit scripts externally | external editing proves insufficient |

## 10. Risks

- **K1 — option-model drift.** The schema is dumped from the installed FFS and cached by source
  hash; a version mismatch between the reference checkout and the Python the Host runs must be
  detected and reported, never silently rendered as stale help.
- **K2 — curated stage map maintenance.** The stage→flag mapping is hand-curated; a test must
  assert every mapped dest exists and every parser group is reachable, and unmapped flags must
  still appear in the drawer.
- **K3 — 174 fields is still a lot.** That is autoproc's surface, not the UI's ambition; the
  primary path is recipe → board → one stage. Search, changed-only and per-group reset keep the
  drawer navigable.
- **K4 — script regeneration.** `-glm_spec_overwrite` defaults off and the UI warns for
  TOML-affecting flags; a user can still be surprised by a stale TOML, so the warning names
  the file and the flag that changed.
- **K5 — recipe vs override precedence.** Explicit flags override recipes; the UI shows
  inherited values and `changed N`. A recipe switch with existing overrides asks whether to
  keep them.
- **K6 — argv quoting.** Long option strings (`-moco_opts`, paths with spaces) must be passed
  as argv, never a shell string; the resolved-command preview and the generator share one argv
  builder.
- **K7 — no per-stage run.** The board must not show a run button per stage; the only real
  controls are `-batch_overwrite` and the script's `skip_*` variables (read-only in preview).
- **K8 — scope creep.** Every future flag request goes to the drawer by construction; every
  *new concept* request goes through the budget table.

## 11. Conformance (panel-specific)

| Charter requirement | How v0.3 satisfies it |
|---|---|
| Freedom of composition | recipes + 174 CLI flags + op-string edits + optional commands; the exact CLI is the composition language |
| Custom scripts first-class | command step / `scriptPath` frozen by hash; the generated script is shipped and cited |
| Exploration → workflow | scratch run → "Add as step"; no separate exploratory model |
| Expert controls | op strings, full option drawer, raw command preview, external scripts, `-exec`-equivalent run |
| Novice defaults | recipe descriptions, stage board with reasons, `changed` badges, warnings |
| QC judgment | inline verdicts with target + sha + reason + confidence; decisions in the package |
| Package | recipe, overrides, resolved argv, script hash, stages, commands, decisions |
| Plugin rules | one tab, one file, same route/tools; schema served from Python rather than duplicated |

---

## Appendix — sketches

- [analysis_panel_pipeline.svg](analysis_panel_pipeline.svg) — scope, recipe, stage board,
  stage inspector, generate/run bar.
- [analysis_panel_options.svg](analysis_panel_options.svg) — the All-options drawer with the
  parser's 12 groups and the per-stage override group.
- [analysis_panel_qc.svg](analysis_panel_qc.svg) — inline verdicts and decision records.

## Appendix — why the earlier designs were cut

v2 proposed a workflow builder with draft/commit versions, variant predicates, nine step types,
pausing gates, eight modes, panes and a JSON editor. v0.2 reduced that to a settings form plus
optional commands, but after reading `ffs_autoproc` it was clear that the form was too generic:
the CLI has a real, stable structure (recipes, stages, grouped flags, op strings) that the UI
should show. v0.3 keeps the small budget and uses that structure directly — one invented
concept fewer than v0.2, one honest map more.
