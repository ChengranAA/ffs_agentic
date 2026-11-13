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
| **M4 — Cohort** | partial | cohort auto-discovery from work dirs; `sub-01`+`sub-02` first-level fits; cohort UI matrix. Missing: 3-subject fixture runs, `subjects/` packaging, `subject.yaml` variants, include/exclude/validate UI, bounded-parallel `run.sh` |
| **M5 — Group level** | partial | one-sample 3dMEMA over 2 subjects (native common grid via 3dresample), group clusters + viewer hand-off. Missing: two-group/covariate designs, cluster/permutation corrections, engine adapters, group package + methods |
| **M6 — Surface + interop + replay** | not started | — |

## Analysis UI milestones

| Milestone | Status | Evidence |
|---|---|---|
| **U0** shell + artifacts | done | right-sidebar tab, fixture fallback, artifact list |
| **U1** plan/review | done | Plan produces `proc_sub-*.sh`, design spec and stage flow |
| **U2** live run/log | done | progress, stage times, cleaned log, cancel, QC table/figures, viewer screenshots, load-to-viewer |
| **U3** results/provenance | partial | contrast/cluster tables, viewer hand-off, settle/export, provenance; threshold/correction controls and replay card missing |
| **U4** cohort | partial | matrix from discovery; variants/include/exclude/validate and pending-run view missing |
| **U5** group | partial | analysis cards, run one-sample 3dMEMA, cluster table, viewer sync; engine/correction selectors, two-group form missing |
| **U6** tool cards/polish | not started | — |

## Reproducible package milestones

| Milestone | Status | Evidence |
|---|---|---|
| **M3a** settle/export skeleton | done | `exports/ffs_analysis_01_20261112-221452` (16 files, checksums verified) |
| **M3b** figures/verification/UI card | partial | settle + export card exist; figures, clean-shell rerun and verification modes missing |
| **M4** cohort package | not started | single-subject package only |
| **M5** group package | not started | group analysis not exported |
| **M6** portable lock | not started | — |

## Verification commands

```bash
.venv/bin/python -m unittest discover -s tests -v          # M0
.venv/bin/python scripts/build_bids_fixture.py            # regenerate fixture
.venv/bin/python scripts/check_stage_parity.py \
  --script work/bids-lite/sub-001/proc_sub-001.sh \
  --log work/bids-lite/sub-001/proc_sub-001.log            # M1
ffs_analysis_snapshot                                      # M2: qc figures/review/screenshots
```

Agent tools: `ffs_project_scan`, `ffs_analysis_plan`, `ffs_analysis_run`,
`ffs_analysis_snapshot`, `ffs_analysis_group`, `ffs_analysis_settle`, `ffs_analysis_export`.
