# Implementation status against the workflow spec

Living checklist for [WORKFLOW.md](WORKFLOW.md) milestones. Each line names the artifact
or command that proves it. Update this file whenever a milestone moves.

## Workflow milestones

| Milestone | Status | Evidence |
|---|---|---|
| **M0 — Seed** | **done** | `scripts/build_bids_fixture.py` builds a byte-identical 3-subject/5-run fixture (`data/bids-lite`); `ffs_project_scan` scans BIDS + doctor (python, fastfuncstuff/torch, 86 `ffs_*` shims, zstd, AFNI/R, MPLCONFIGDIR, disk); `python -m unittest discover -s tests -v` passes determinism/layout/autoproc tests |
| **M1 — Plan** | **done** | `ffs_analysis_plan` writes `proc_sub-001.sh` + design specs for the fixture (2 runs); `scripts/check_stage_parity.py` proves planned stages equal emitted log banners (stage12 exempt: commented banner), order and finish included |
| **M2 — Run + QC + viewer** | partial (acceptance behaviour met) | fixture pipeline completes in 91 s; stage progress/times visible; QC figures + `qc_review.tsv` surfaced; screenshots; run state self-heals after Host reload. **Resume** label + `ffs_analysis_resume` tool rerun the frozen script with existing outputs skipped. Missing: `ctx.jobs` wrapper (runs are a plain managed child) |
| **M3 — Analysis** | **done** | stats buckets with sub-brick/colormap viewer hand-off; results inspector (peaks/clusters) with persisted **threshold + min-cluster controls** (`ffs_analysis_results`); settle/export package; surface GLM separately in M6. Single-subject multiple-comparison correction is not part of M3 |
| **M4 — Cohort** | **done (backend + package); UI partial** | fixture cohort of 4 subjects on one 42³ grid; `ffs_cohort` list/validate/export; `subjects/` + `cohort.yaml` + `subject.yaml` (canonical + hand-edited `sub-002-edited` variant); bounded-parallel `run.sh` reran all three and revalidated; negative cohort reports `grid-mismatch` and `missing-output` and export refuses. UI: matrix/variants/validate button + include/exclude checkboxes (persisted); subject detail drawer still open (U4) |
| **M5 — Group level** | **done (adapters + package)** | one-sample 3dMEMA and two-group 3dttest++ on the 4-subject fixture; common-grid resampling; permutation/max-cluster correction adapter (`scripts/group_permutation.py`) and cluster-size threshold; `group.yaml` + per-analysis bucket/correction/clusters + group METHODS in the cohort package; methods lint clean. Covariates and true 3dClustSim remain a follow-on |
| **M6 — Surface + interop + replay** | **done except exact-hash replay** | surface GLM on **fsaverage** (demo phantom): stage10s sampling + stage12s ffs_reml lh/rh, figure `surface/screenshot.png`, viewer state; `ffs_tool_run` argv runner; `ffs_replay` (canonical hash + tolerance; exact false from REML numerical noise, 0 voxels over tolerance, corr 0.999999997); AFNI/ANTs interop plan inputs (`-ref_file`/`-ref_file_anat`/`-ref_transforms` verified in the script); portable lock/setup/env; deterministic zip; optional viewer state in the package. Caveat: replay is numerically equivalent, not byte/hash-equal |

## Analysis UI milestones

| Milestone | Status | Evidence |
|---|---|---|
| **U0** shell + artifacts | done | right-sidebar tab, fixture fallback, artifact list |
| **U1** plan/review | done | Plan produces `proc_sub-*.sh`, design spec and stage flow |
| **U2** live run/log | done | progress, stage times, cleaned log, cancel, QC table/figures, viewer screenshots, load-to-viewer |
| **U3** results/provenance | partial | contrast/cluster tables, viewer hand-off, settle/export, provenance, Replay card, **threshold/min-cluster controls**, **Verify package** button; single-subject correction controls still missing |
| **U4** cohort | partial | matrix, variant list, Validate button with issue codes, persisted include/exclude checkboxes; subject detail drawer still missing |
| **U5** group | **done** | design form (one-sample/two-group), engine selector (3dMEMA/3dttest++, disabled with reason for two-group), correction selector, groups A/B inputs, cluster table with p, viewer sync |
| **U6** tool cards/polish | not started | — |

## Reproducible package milestones

| Milestone | Status | Evidence |
|---|---|---|
| **M3a** settle/export skeleton | done | `exports/ffs_analysis_01_20261112-221452` (16 files, checksums verified) |
| **M3b** figures/verification/UI card | **partial** | package includes `figures/` (surface/QC screenshots), frozen stats, `verify.sh` (checksums + optional `--replay`), bundled hash/compare helpers, `ffs_analysis_verify` tool + Verify button; checksum verification passes (29 files). Full clean-shell package replay still to run |
| **M4** cohort package | **done** | `exports/ffs_cohort_bids-lite_20261113-125046` (28 files): subjects/, cohort.yaml, subject.yaml (incl. variant), run.sh, validate.py, METHODS/STEPS, manifest; `MAX_PARALLEL=2 ./run.sh` reran and `validate.py` passed |
| **M5** group package | **done** | `exports/ffs_cohort_bids-lite_20261113-130318`: group/group.yaml, per-analysis group.yaml + frozen bucket + mask + correction.json + clusters.csv, group/results.csv, group/METHODS.md; manifest methodsLint both clean |
| **M6** portable lock | **partial** | lock.json/setup.sh/env.sh in single-subject and cohort packages; surface package `ffs_analysis_001_20261113-140402.zip` (3.7 MB, 25 files) includes surface GIFTI, figure and viewer state; setup passes on this Mac. Second-Mac repro still untested |

## Verification commands

```bash
.venv/bin/python -m unittest discover -s tests -v          # M0
.venv/bin/python scripts/build_bids_fixture.py            # regenerate fixture
.venv/bin/python scripts/check_stage_parity.py \
  --script work/bids-lite/sub-001/proc_sub-001.sh \
  --log work/bids-lite/sub-001/proc_sub-001.log            # M1
ffs_analysis_snapshot                                      # M2: qc figures/review/screenshots
ffs_cohort validate                                        # M4: 3-subject fixture cohort
ffs_cohort export                                          # M4: subjects/ + cohort.yaml + run.sh
ffs_analysis_results threshold=2.5 minCluster=5           # M3: result controls
ffs_cohort include workRoot=work/bids-lite subject=004 include=false
ffs_analysis_resume                                        # M2: resume
ffs_analysis_verify dir=exports/<pkg>                      # REPRO M3b: checksums
bash exports/<pkg>/verify.sh [--replay]                     # REPRO M3b: full verification
ffs_group model=two-group groups='{"a":["001","002"],"b":["003","004"]}' correction=permutation
                                                            # M5: engine + correction + package
ffs_tool_run argv='["ffs_info","-nv",<bucket>]'             # M6: escape hatch + provenance
ffs_replay workDir=work/bids-lite/sub-004                   # M6: hash/tolerance replay
ffs_analysis_plan ... surfaceTarget='["fsaverage"]' surfaceGlm=true fsSubject=data/demo/subject
                                                            # M6: surface GLM
bash exports/<pkg>/setup.sh                                 # M6: lock check
```

Agent tools: `ffs_project_scan`, `ffs_analysis_plan`, `ffs_analysis_run`,
`ffs_analysis_snapshot`, `ffs_analysis_group`, `ffs_analysis_settle`, `ffs_analysis_export`.
