# Implementation status against the workflow spec

Living checklist for [WORKFLOW.md](WORKFLOW.md) milestones. Each line names the artifact
or command that proves it. Update this file whenever a milestone moves.

## Workflow milestones

| Milestone | Status | Evidence |
|---|---|---|
| **M0 — Seed** | **done** | `scripts/build_bids_fixture.py` builds a byte-identical 3-subject/5-run fixture (`data/bids-lite`); `ffs_project_scan` scans BIDS + doctor (python, fastfuncstuff/torch, 86 `ffs_*` shims, zstd, AFNI/R, MPLCONFIGDIR, disk); `python -m unittest discover -s tests -v` passes determinism/layout/autoproc tests |
| **M1 — Plan** | **done** | `ffs_analysis_plan` writes `proc_sub-001.sh` + design specs for the fixture (2 runs); `scripts/check_stage_parity.py` proves planned stages equal emitted log banners (stage12 exempt: commented banner), order and finish included |
| **M2 — Run + QC + viewer** | **done** | fixture pipeline completes; stage progress/times, QC figures + `qc_review.tsv`, screenshots; **runs registered in `ctx.jobs`** (job `bash-a52b6bf716aa4623` visible in DSH job list, output pumped to the job ring, cancel hook wired) with plain-child fallback; **Resume** label + `ffs_analysis_resume`; run state self-heals after Host reload |
| **M3 — Analysis** | **done** | stats buckets with sub-brick/colormap viewer hand-off; results inspector (peaks/clusters) with persisted **threshold + min-cluster controls** (`ffs_analysis_results`); settle/export package; surface GLM separately in M6. Single-subject multiple-comparison correction is not part of M3 |
| **M4 — Cohort** | **done (backend + package); UI partial** | fixture cohort of 4 subjects on one 42³ grid; `ffs_cohort` list/validate/export; `subjects/` + `cohort.yaml` + `subject.yaml` (canonical + hand-edited `sub-002-edited` variant); bounded-parallel `run.sh` reran all three and revalidated; negative cohort reports `grid-mismatch` and `missing-output` and export refuses. UI: matrix/variants/validate button + include/exclude checkboxes (persisted); subject detail drawer still open (U4) |
| **M5 — Group level** | **done (adapters + package)** | one-sample 3dMEMA and two-group 3dttest++ on the 4-subject fixture; common-grid resampling; permutation/max-cluster correction adapter (`scripts/group_permutation.py`) and cluster-size threshold; `group.yaml` + per-analysis bucket/correction/clusters + group METHODS in the cohort package; methods lint clean. Covariates and true 3dClustSim remain a follow-on |
| **M6 — Surface + interop + replay** | **done** | surface GLM on **fsaverage** (demo phantom) with stage10s/12s, figure + viewer state; `ffs_tool_run`; AFNI/ANTs interop plan inputs verified; portable lock/setup/env; deterministic zip; optional viewer state. **Hash-equal replay proven**: package `verify.sh --replay` reproduced the surface stats bucket with `exact=true` (sha equal, max Δ 0.0). The tiny bare-bones fixture still showed REML FP noise in an earlier replay, documented |

## Analysis UI milestones

| Milestone | Status | Evidence |
|---|---|---|
| **U0** shell + artifacts | done | right-sidebar tab, fixture fallback, artifact list |
| **U1** plan/review | done | Plan produces `proc_sub-*.sh`, design spec and stage flow |
| **U2** live run/log | done | progress, stage times, cleaned log, cancel, QC table/figures, viewer screenshots, load-to-viewer |
| **U3** results/provenance | **done** | contrasts/clusters, viewer hand-off with crosshair, threshold/min-cluster controls, settle/export, replay card, verify package button; correction controls were not part of U3 |
| **U4** cohort | **done** | matrix, variant list, Validate button with issue codes, persisted include/exclude checkboxes, expandable subject detail (work dir, stats, variants, issues); planned/missing-output rows show run-pending |
| **U5** group | **done** | design form (one-sample/two-group), engine selector (3dMEMA/3dttest++, disabled with reason for two-group), correction selector, groups A/B inputs, cluster table with p, viewer sync |
| **U6** tool cards/polish | **done (plugin-owned)** | Settings section, tab semantics (`role=tablist/tab`, `aria-selected`), labelled inputs, replay/verify cards, `presentCall` tool cards for all 16 analysis tools; turn-tail and optional in-viewer inspector are Host-owned surfaces that need no plugin registration |

## Reproducible package milestones

| Milestone | Status | Evidence |
|---|---|---|
| **M3a** settle/export skeleton | done | `exports/ffs_analysis_01_20261112-221452` (16 files, checksums verified) |
| **M3b** figures/verification/UI card | **done** | figures/, frozen stats, `verify.sh` (checksums + `--replay`), bundled hash/compare helpers, verify tool + UI button. Clean-shell package replay reproduced the stats bucket **exactly** (canonical sha equal, max Δ 0.0) after 341 s; checksums verified |
| **M4** cohort package | **done** | `exports/ffs_cohort_bids-lite_20261113-125046` (28 files): subjects/, cohort.yaml, subject.yaml (incl. variant), run.sh, validate.py, METHODS/STEPS, manifest; `MAX_PARALLEL=2 ./run.sh` reran and `validate.py` passed |
| **M5** group package | **done** | `exports/ffs_cohort_bids-lite_20261113-130318`: group/group.yaml, per-analysis group.yaml + frozen bucket + mask + correction.json + clusters.csv, group/results.csv, group/METHODS.md; manifest methodsLint both clean |
| **M6** portable lock | **partial (external validation only)** | lock.json/setup.sh/env.sh; surface/cohort packages include figures, viewer state, verify.sh. Verified from a fresh unzip in `/tmp` (`setup.sh`, `verify.sh` pass). A physical second-Mac install with only the lock is still untested |

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
bash exports/<pkg>/verify.sh [--replay]                     # REPRO M3b: checksums + hash-equal replay
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
