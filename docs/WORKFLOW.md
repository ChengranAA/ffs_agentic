# FFS analysis workflow — plugin integration design

Status: **draft for review** (2026-11-12).

Decisions taken in the design discussion:

- Compute stays **local**: macOS, PyTorch MPS/CPU, no cluster in the first design.
- The **FFS suite is the analysis core** (`ffs_autoproc` + `ffs_reml`/`ffs_perm`/`ffs_ridge`/design/contrast/QC tools).
- **FreeSurfer/SUMA surfaces** and **AFNI/FSL/ANTs interop** are first-class inputs/outputs, not afterthoughts.
- **Custom lab tools** never get bespoke plugins; they go through one validated escape hatch.
- First milestone is **one subject, end to end**: `ffs_autoproc` → QC gate → first-level GLM → viewer → screenshots, on a synthetic **BIDS-lite** fixture.

## 1. Problem

Today the pieces do not meet in the middle:

- [ffs-harness-viewer/](../ffs-harness-viewer/) is a **display authority**: the Python sidecar owns `ViewerSession`, every mutation goes through the FFS command bus, and the agent drives it with `ffs_viewer_*` tools ([docs/API.md](API.md)). It cannot compute anything and exposes **no service** to other plugins.
- [reference/fastfuncstuff](../reference/fastfuncstuff) is the **compute authority**: `ffs_autoproc` writes a readable, resumable `proc_sub-<id>.sh` plus `.log`, design specs and stimuli, and ~90 CLIs cover the rest. It is not pip-installed; it is imported through `PYTHONPATH` and invoked as `python -m fastfuncstuff.cli.<tool>`.
- The only join point between them is the agent, hand-rolling shell commands. That is neither reproducible nor observable, and it burns context on logs.

The goal is one thread — **raw BIDS → validated derivatives → stats in the viewer → report** — where each plugin owns one job and the seams are explicit.

## 2. Principles

1. **FFS CLIs stay the computation authority.** Plugins orchestrate, validate, record, and render. No plugin reimplements registration, resampling, or GLM math. (Same rule the viewer already applies to its sidecar.)
2. **One project/artifact manifest is the contract between plugins.** Compute writes it; viewer, QC, report read it. No plugin depends on another plugin's memory, so each stays independently installable.
3. **Services for plugin↔plugin, tools for agent↔plugin.** The agent gets narrow phase tools; plugins call each other through Cordis services. The viewer gains a small service seam so "show these results" is one call, not a narration of commands.
4. **The generated script is the reproducibility unit.** `ffs_autoproc` emits a reviewable, editable script; we run that file, not a private re-derivation of it. Replay = re-run the same script.
5. **Bounded outputs.** Tools return summaries, stage status, and artifact ids; logs stay behind the job API. The model never receives a 10 MB preprocessing log.

## 3. Architecture

```
                      Harness (one Host process)
 ┌──────────────────────────────────────────────────────────────────┐
 │  ffs-compute                          ffs-viewer                 │
 │   ├─ project + artifact manifest ──service──▶ Bridge             │
 │   ├─ ctx.jobs (long runs)              │      └─▶ sidecar         │
 │   └─ ctx.subprocess                    │           ViewerSession  │
 │                                        │                 │        │
 └───────────────┬────────────────────────┼─────────────────┼────────┘
                 │ python -m fastfuncstuff.cli.*            │ /ffs RPC
                 ▼                                         ▼
        ffs_* CLIs + proc_sub-*.sh                    Browser tab
                 │
                 ▼
      derivatives + ffs.project.json
```

Three authorities, each with exactly one writer:

| Authority | Owner | Never written by |
|---|---|---|
| Computation | FFS CLIs (child processes) | plugins |
| Display | viewer sidecar `ViewerSession` | compute, agent |
| Project/artifacts | `ffs-compute` manifest store | viewer (it reads) |

### DSH surfaces used

| Need | Surface |
|---|---|
| Agent actions | `ctx.tools.register` (phase tools) |
| Plugin↔plugin | Cordis services (`inject`, service class rows) |
| Long/expensive runs | `ctx.jobs` (output ring, progress, cancel, owner fencing) |
| Child processes | `ctx.subprocess` / `ctx.jobs` starters |
| Multi-subject fan-out | Workflow tool (`workflowEngine`) — later milestone |
| Review gates | plan mode / `ask_user_question` / approval |
| Conventions | `ctx.systemPrompt.section()` + one skill |
| Report | `present` + office/PDF skills |

Note: the live `JobKind` map currently defines only `bash`, so pipeline jobs start with `kind: 'bash'`; the subject/stage goes in `label`/`progress`. Re-check at build time.

## 4. Plugin family

| Package | Contents | Why separate |
|---|---|---|
| `@local/ffs-core` (library, no bundle) | python/PYTHONPATH resolution (reuse the viewer's `findProjectRoot`), CLI spawn with env, stage/log parsers, manifest store, sha256 provenance, "doctor" checks | shared by compute and future plugins without a second install |
| `@local/ffs-compute` | services `ffsProjects`, `ffsCompute`; phase tools; QC/analysis groups | one execution/ownership boundary |
| `@local/ffs-harness-viewer` (existing) | add one small **service row** (default-exported service class) exposing load/show/render; tools unchanged | viewer keeps its authority; compute gets a clean call |
| `@local/ffs-qc`, `@local/ffs-report` | **deferred**; phases inside `ffs-compute` for v1 | split only when they need their own UI or output format |

`ffs-core` is a dependency of both, not a plugin. A package-root plugin may not mix the `apply(ctx, config)` and service-class export forms, so the viewer's service lives in its own patch row (subpath export), inserted next to the existing row.

## 5. Contracts

### 5.1 Project manifest (`<project>/project.json`, v1 draft)

```jsonc
{
  "schema": "ffs-project/1",
  "createdAt": "…", "updatedAt": "…",
  "dataset": { "root": "/data/bids", "bidsVersion": "1.8.0" },
  "python": { "executable": ".venv/bin/python",
              "pythonpath": ["python", "reference/fastfuncstuff"] },
  "defaults": { "device": "auto", "recipe": "complete" },
  "subjects": {
    "sub-001": {
      "sessions": ["ses-01"],
      "pipelines": [{
        "id": "pipe-…",
        "script": "pipelines/sub-001/proc_sub-001.sh",
        "log":    "pipelines/sub-001/proc_sub-001.log",
        "workDir": "work/sub-001",
        "recipe": "complete",
        "flags": ["-task", "rest"],
        "stages": [{ "name": "stage02", "state": "completed" }],
        "createdAt": "…", "startedAt": "…", "finishedAt": "…",
        "exitCode": 0
      }]
    }
  },
  "artifacts": [ /* 5.2 */ ],
  "exclusions": [{ "subject": "sub-003", "session": "ses-02", "reason": "motion" }],
  "reports": []
}
```

Rules: atomic write (temp + rename); every mutation bumps `updatedAt`; the manifest is the **only** inter-plugin state. UI caches may live in `storageDomain`, but a fresh install must be able to rebuild everything from the manifest and files.

### 5.2 Artifact record

```jsonc
{
  "id": "sub-001.ses-01.stage10.final-rest",
  "kind": "anat|func|stats|mask|warp|surface|design|qc|screenshot|report|script|log",
  "path": "/…/stage10.final.task-rest_mean.nii.gz",
  "subject": "sub-001", "session": "ses-01", "run": "run-01", "task": "rest",
  "space": "native|MNI152|fsaverage", "stage": "stage10",
  "bytes": 1234567, "sha256": "…",
  "hint": { "role": "underlay|overlay|mask", "colormap": "redblue",
            "threshold": 2.3, "range": [0, 6] },
  "provenance": {
    "tool": "ffs_nwarp", "argv": ["-interp", "wsinc5"],
    "inputs": [{ "path": "…", "sha256": "…" }],
    "ffsVersion": "…", "device": "mps", "script": "proc_sub-001.sh"
  }
}
```

`hint` is advisory viewer UX, not science: the viewer still applies real FFS commands and remains the sole owner of display state.

### 5.3 Tool surface (agent-facing)

| Tool | Purpose | Returns |
|---|---|---|
| `ffs_project_scan` | BIDS inventory + environment doctor | subjects/sessions/runs, events/fmap/T1w presence, missing tools, device |
| `ffs_pipeline_plan` | autoproc **without** `-exec` | script path, stage graph, design specs, warnings (`-recipe`, `-task`, `-out`, `-work_dir`) |
| `ffs_pipeline_run` | execute/continue a plan as a job | job id, stage progress, exit status, artifact ids |
| `ffs_pipeline_status` | job + parsed stage state + log tail | bounded summary |
| `ffs_artifact_list` | query manifest artifacts | id/kind/stage/path summary |
| `ffs_artifact_load` | register artifacts into the viewer | viewer load result + screenshot paths |
| `ffs_qc` | `ffs_qc_table`/`report`/`stack`, motion/tSNR | table artifact + summary |
| `ffs_glm` / `ffs_contrast` | design → `ffs_reml`/`ffs_perm`/`ffs_ridge`, `ffs_util_concalc` | stats artifacts + contrast table |
| `ffs_tool_run` | one validated CLI invocation (escape hatch) | provenance record + expected outputs |
| `ffs_replay` | reproduce a pipeline/artifact | exact command sequence |

Phase tools are thin wrappers over `ffsCompute`; they never hold state.

### 5.4 Services (plugin-facing)

- `ffsProjects`: `get()`, `update(mutator)`, `addArtifact()`, `find(query)`, `recordPipeline()`.
- `ffsCompute`: `scan()`, `plan()`, `run()`, `status()`, `cancel()`, `runTool()`.
- `ffsViewer` (added to the viewer package): `loadArtifacts(ids, opts)`, `applyHints(ids)`, `show()`, `render(views)`, `command(lines)` — a thin wrapper over the existing Bridge methods, so the validated command bus stays the only mutation path.

### 5.5 Errors

`{ code, message, details }` with stable codes: `bids-invalid`, `env-missing`, `plan-failed`, `script-failed`, `stage-failed`, `artifact-unknown`, `viewer-rejected`, `approval-required`. Never mutate the manifest on failure; record a failed pipeline attempt instead.

## 6. Execution model

- **Plan ≠ run.** `ffs_pipeline_plan` runs `ffs_autoproc` without `-exec`, so the script and design specs exist on disk before anything expensive happens. Editing the script then is a supported, recorded workflow.
- **Run the file.** Execution is `bash <script> 2>&1 | tee <log>` under a DSH job. The script is resumable, so a failed stage is fixed and the script re-run; the plugin reports which stages were already complete.
- **Progress** is parsed from the emitted banners (`== stage00: NORDIC ==` … `== stage12: GLM (ffs_reml) ==`, including `stage10s`/`stage12s` for surfaces) and mapped to `job.updateProgress`.
- **Cancel** forwards to the job, which signals the bash process group; the log keeps the last completed stage.
- **Doctor** before anything else: python interpreter, `PYTHONPATH` import of `fastfuncstuff`, `zstd`, AFNI/FreeSurfer when requested, device availability, free disk. Missing tools fail fast with `env-missing`, not 40 minutes into a run.
- **Cost acknowledgement.** `ffs_pipeline_run` states stages, subject count, and device before starting; run approval is explicit.
- **Two processes, one disk.** The viewer sidecar and pipeline children both import torch; on a laptop this is a memory/CPU issue. Compute is sequential by default and the sidecar is idle during runs.

## 7. Single-subject workflow (first milestone)

| # | Phase | Tool(s) | Artifacts | Gate |
|---|---|---|---|---|
| 0 | Audit | `ffs_project_scan` | inventory + env report (no files) | user accepts scope/recipe |
| 1 | Plan | `ffs_pipeline_plan` | `proc_sub-001.sh`, stage graph, design specs, stimuli | review/edit script |
| 2 | Preprocess | `ffs_pipeline_run`/`_status` | `stage10.final.*`, masks, warps, log | stage failure triage |
| 3 | QC | `ffs_qc`, viewer renders | `ffs_qc_table`, motion/tSNR, screenshots | accept/exclude runs |
| 4 | First-level | `ffs_glm`, `ffs_contrast` | `stats-reml` buckets, contrast tables | model/contrast review |
| 5 | Visualise | `ffs_artifact_load` | viewer layers + screenshots | user looks at the map |
| 6 | Report/replay | `ffs_replay` + report skill | report, replay script | — |

Groups (multi-subject), surface GLM, and interop are later milestones; the seams (artifact kind, `space`, `subject`) already carry them.

## 8. Viewer integration

- **Load through the validated bus.** `ffs_artifact_load` resolves ids → paths, calls `LOAD` through the existing `execute` method, then applies `hint` via the existing layer commands. No direct writes to `.ffs-viewer/` state.
- **`analysis.ffs` stays truthful.** Loaded datasets are source-category commands, so the viewer's existing display/analysis/source save split keeps meaning what it says ([docs/API.md](API.md) §Persistence).
- **Screenshots are artifacts.** `ffs_viewer_render` output is registered under `kind: "screenshot"` and reused by QC and the report; no re-rendering in the report step.
- **One state machine.** Compute never edits viewer scripts; the viewer never calls compute. The agent (or a future pipeline panel) sequences them.

## 9. Surfaces, interop, custom tools

- **FreeSurfer/SUMA**: `ffs_autoproc` already takes `-fs_subject`, `-suma`, `-surface_target` and writes `stage10s`/`stage12s` GIFTI outputs. Artifacts with `kind: "surface"` and `space: "fsaverage"` are loaded as a viewer subject. The doctor checks `SUBJECTS_DIR` and mesh availability.
- **AFNI/FSL/ANTs**: file-level interop is already strong (`ffs_nwarp` consumes AFNI/ANTs warps, AFNI-compatible bucket/xmat output). v1 exposes it through the generic tool runner plus explicit import/export tools; no attempt to wrap other pipelines. The design rule: *inputs and outputs are NIfTI/GIFTI/warp files + a recorded command*, never another package's internal state.
- **Custom lab tools**: `ffs_tool_run` takes `{argv, cwd, env, timeout, expect: [{path, kind}]}`; it validates that it can execute, records full provenance, hashes expected outputs, and requires approval. That is the **only** door for bespoke code.

## 10. Safety and provenance

- Every artifact records tool, argv, input/output hashes, FFS version, device, and the script that produced it; `ffs_replay` regenerates the exact command sequence.
- Destructive or expensive operations (pipeline run, overwriting derivatives) require explicit approval; plan mode is the default gate for the generated script.
- Compute runs as child processes under the Host's environment (`ctx.subprocess`/jobs), not via shell-string interpolation from model text; `ffs_tool_run` receives argv arrays, never a shell line.
- Manifest writes are atomic and append-only for history fields; exclusions and failed attempts are recorded, not deleted.

## 11. BIDS-lite fixture

Extend [scripts/build_demo_data.py](../scripts/build_demo_data.py) into `scripts/build_bids_fixture.py`, reusing its deterministic anatomy/function builders:

```
data/bids-lite/
  dataset_description.json
  sub-001/ses-01/anat/sub-001_ses-01_T1w.nii.gz (+ .json)
  sub-001/ses-01/func/sub-001_ses-01_task-rest_run-01_bold.nii.gz (+ .json, TR)
  sub-001/ses-01/func/sub-001_ses-01_task-rest_run-01_events.tsv
  sub-001/ses-01/func/sub-001_ses-01_task-rest_run-02_bold.nii.gz (+ .json, events)
```

- Two runs so cross-run alignment (stage06/07) is exercised; a task with two conditions so stage12 has something to fit.
- Optional fmap fixture behind a flag once stage04 is exercised; the minimum run can use `-no_anat`/no-fmap paths and still cover moco, alignment, resample, GLM.
- Deterministic like the existing builder (fixed seed, mtime 0) so byte-identical fixtures and reproducible screenshots.
- Keep it **small**: 32³–48³ voxels and few volumes, so the full pipeline is minutes, not hours, on CPU. Scientific fidelity is not the fixture's job; mechanics are.

## 12. Milestones

| Milestone | Deliverable | Acceptance |
|---|---|---|
| **M0 — Seed** | `ffs-core` (python resolution, manifest, doctor), `ffs_project_scan`, BIDS-lite fixture | scan reports fixture inventory and env; fixture byte-identical across builds; unit tests |
| **M1 — Plan** | `ffs_pipeline_plan` (no execution), stage graph parser, script review payload | `proc_sub-001.sh` + specs generated from the fixture; parsed stage list matches emitted banners |
| **M2 — Run + QC + viewer** | `ffs_pipeline_run` under jobs, resume, `ffs_qc`, viewer load/render | fixture pipeline completes; stage progress visible; QC table + screenshot artifacts; stage10 mean displayed |
| **M3 — Analysis** | `ffs_glm`, `ffs_contrast`, artifact hints in the viewer | stats bucket loaded with threshold/colormap; contrast table; screenshot |
| **M4 — Surface + interop + replay** | `stage10s/12s` surface loading, AFNI/ANTs warp input, `ffs_tool_run`, `ffs_replay`, multi-subject fan-out | a surface GLM shown on `fsaverage`; replay reproduces an artifact byte-for-byte (or hash-equal) |

## 13. Risks and open questions

- **Synthetic data may not exercise masks/segmentation realistically.** If the fixture cannot drive `ffs_segment`/mask stages, either add tissue maps to the phantom or accept a later real-data verification gate.
- **Environment drift.** `reference/fastfuncstuff` is a read-only clone used via `PYTHONPATH`; decide whether to pin a commit in the manifest and doctor (`ffsVersion` recorded now).
- **Runtime on CPU.** A "complete" recipe may be too slow even on tiny volumes; the fixture milestone may use a reduced recipe or selected stages.
- **Job kind.** `JobKind` currently only knows `bash`; confirm the label/progress path in the Jobs UI before M2.
- **Two torch processes.** Verify memory headroom on the target Mac; make compute sequential and lazy.
- **AFNI/FSL/ANTs presence.** Doctor-only in v1; interop is a file contract, not a software dependency.
- **Service export form.** Confirm the default-export service-class row works as expected in this installed DSH version before M1.
