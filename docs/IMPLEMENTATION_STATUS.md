# Implementation status against the workflow spec

Living checklist for [WORKFLOW.md](WORKFLOW.md) milestones. Each line names the artifact
or command that proves it. Update this file whenever a milestone moves.

## Workflow milestones

| Milestone | Status | Evidence |
|---|---|---|
| **M0 — Seed** | **done** | `scripts/build_bids_fixture.py` builds a byte-identical 3-subject/5-run fixture (`data/bids-lite`); `ffs_project_scan` scans BIDS + doctor (python, fastfuncstuff/torch, 86 `ffs_*` shims, zstd, AFNI/R, MPLCONFIGDIR, disk); `python -m unittest discover -s tests -v` passes determinism/layout/autoproc tests |
| **M1 — Plan** | **done** | `ffs_analysis_plan` writes `proc_sub-001.sh` + design specs for the fixture (2 runs); `scripts/check_stage_parity.py` proves planned stages equal emitted log banners (stage12 exempt: commented banner), order and finish included |
| **M2 — Run + QC + viewer** | partial (acceptance behaviour met) | fixture pipeline completes in 91 s; stage progress/times visible; QC produced 17 figures + `qc_review.tsv` (7 rows × 38 cols) surfaced in the tab; viewer screenshot saved under `screenshots/`; run state self-heals from the log after a Host reload. Missing: `ctx.jobs` wrapper and resume UI |
| **M3 — Analysis** | partial | stats buckets loaded with sub-brick/threshold/colormap via viewer hand-off; results inspector (peaks/clusters); settle/export package. Missing: threshold/correction controls, screenshots |
| **M4 — Cohort** | **done (backend + package); UI partial** | fixture cohort of 3 subjects on one 42³ grid; `ffs_cohort` list/validate/export; `subjects/` + `cohort.yaml` + `subject.yaml` (canonical + hand-edited `sub-002-edited` variant); bounded-parallel `run.sh` reran all three and revalidated; negative cohort reports `grid-mismatch` and `missing-output` and export refuses. UI: matrix/variants/validate button; include/exclude + subject detail still open (U4) |
| **M5 — Group level** | **done (adapters + package)** | one-sample 3dMEMA and two-group 3dttest++ on the 4-subject fixture; common-grid resampling; permutation/max-cluster correction adapter (`scripts/group_permutation.py`) and cluster-size threshold; `group.yaml` + per-analysis bucket/correction/clusters + group METHODS in the cohort package; methods lint clean. Covariates and true 3dClustSim remain a follow-on |
| **M6 — Surface + interop + replay** | not started | — |

## Analysis UI milestones

| Milestone | Status | Evidence |
|---|---|---|
| **U0** shell + artifacts | done | right-sidebar tab, fixture fallback, artifact list |
| **U1** plan/review | done | Plan produces `proc_sub-*.sh`, design spec and stage flow |
| **U2** live run/log | done | progress, stage times, cleaned log, cancel, QC table/figures, viewer screenshots, load-to-viewer |
| **U3** results/provenance | partial | contrast/cluster tables, viewer hand-off, settle/export, provenance; threshold/correction controls and replay card missing |
| **U4** cohort | partial | matrix, variant list and Validate button with per-subject issue codes; include/exclude and subject detail still missing |
| **U5** group | **done** | design form (one-sample/two-group), engine selector (3dMEMA/3dttest++, disabled with reason for two-group), correction selector, groups A/B inputs, cluster table with p, viewer sync |
| **U6** tool cards/polish | not started | — |

## Reproducible package milestones

| Milestone | Status | Evidence |
|---|---|---|
| **M3a** settle/export skeleton | done | `exports/ffs_analysis_01_20261112-221452` (16 files, checksums verified) |
| **M3b** figures/verification/UI card | partial | settle + export card exist; figures, clean-shell rerun and verification modes missing |
| **M4** cohort package | **done** | `exports/ffs_cohort_bids-lite_20261113-125046` (28 files): subjects/, cohort.yaml, subject.yaml (incl. variant), run.sh, validate.py, METHODS/STEPS, manifest; `MAX_PARALLEL=2 ./run.sh` reran and `validate.py` passed |
| **M5** group package | **done** | `exports/ffs_cohort_bids-lite_20261113-130318`: group/group.yaml, per-analysis group.yaml + frozen bucket + mask + correction.json + clusters.csv, group/results.csv, group/METHODS.md; manifest methodsLint both clean |
| **M6** portable lock | not started | — |

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
ffs_group model=two-group groups='{"a":["001","002"],"b":["003","004"]}' correction=permutation
                                                            # M5: engine + correction + package
```

Agent tools: `ffs_project_scan`, `ffs_analysis_plan`, `ffs_analysis_run`,
`ffs_analysis_snapshot`, `ffs_analysis_group`, `ffs_analysis_settle`, `ffs_analysis_export`.
