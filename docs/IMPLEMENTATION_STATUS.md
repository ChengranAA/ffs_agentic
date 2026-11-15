# Implementation status against the workflow spec

**Current status (2026-11-13).** All workflow milestones **M0–M6**, UI milestones **U0–U6**,
record milestones **R0–R6**, analysis-panel milestones **EP0–EP3** and the follow-ups
(artifact statuses, teaching layer, override taxonomy, policy gates, package provenance/inputs/
logs, record/package consistency, scale check) are built. Summary:

- Charter conformance: **13 met / 0 partial / 0 absent** in
  [PHILOSOPHY_CONFORMANCE.md](PHILOSOPHY_CONFORMANCE.md).
- Verification: **36 JS + 56 Python tests**, five smoke scripts plus Record-tab render and viewer-presentation smokes, a 400-session scale check,
  and package `verify.sh` (checksums + record/package consistency).
- `@local/ffs-record` is **installed** in the desktop profile (approved profile write; backup
  `package.json.bak-2026-11-13T19-54-07-171Z`). The Host half is live: `ffs_record_query`
  returned an empty ledger and `ffs_record_rebuild` rebuilt `work/ffs-record/index/runs.json`.
  The Client half is registered live as well (Record tab body + header button active in the
  client slot tree). Remaining: human/browser click-through of the docked tabs (no DOM input
  control in this environment). The one known capability residual is interactive one-off shell
  history outside a saved/imported script.

**How to read this file.** It is an append-only build log: earlier sections describe the state
at that time, and later sections supersede them (e.g. an early "not built" note about the
record layer or a panel gap is resolved by a later "built" section). When in doubt, the current
status above and the latest build-status section at the end are authoritative. Each section
names the artifact or command that proves it.

**Charter.** [PHILOSOPHY.md](PHILOSOPHY.md) is the goal/philosophy; conformance is audited
section by section in [PHILOSOPHY_CONFORMANCE.md](PHILOSOPHY_CONFORMANCE.md) (13/0/0). The
judgment/inspection/preference half designed in [RECORD.md](RECORD.md) (R0–R6) is built and
covered by the smoke scripts.

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

Superseded in part: the inspection UI below stays the reference for slots, transport, design
system and viewer handoff, but its information architecture and composition assumptions are
replaced by the autoproc-centred redesign in [ANALYSIS_PANEL.md](ANALYSIS_PANEL.md) (v0.3,
2026-11-13; milestones EP0–EP3, nothing built yet).

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
| **M6** portable lock | **done (rehearsed)** | package vendors `code/fastfuncstuff`; fresh unzip → `setup.sh --install --reuse-python --python <venv>` installed the FFS wheel into a package-local venv, imports + `ffs_info` work, `tools: ok`, checksums pass, and `verify.sh --replay` reproduced the stats bucket **hash-equal** (`exact=true`, max Δ 0.0) from that venv. Physical second-Mac run remains the only unverified step |

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
bash exports/<pkg>/setup.sh --install --reuse-python        # M6: package-local venv rehearsal
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

## Analysis panel v0.3 — EP0 + EP1 build (started 2026-11-13)

The autoproc-centred panel redesign in [ANALYSIS_PANEL.md](ANALYSIS_PANEL.md) is now partly
built. EP0 (schema + planner backend + first UI) and EP1 (every curated flag/op-string
editable + the all-options drawer) are implemented and verified except live in-tab rendering,
which needs a page refresh/restart of the profile.

| Piece | Where | Evidence |
|---|---|---|
| Autoproc CLI model (172 flags, 12 groups, 6 recipes, 19 stages, 31 op overrides) | `python/ffsviewer/autoproc_model.py` | `.venv/bin/python -m unittest tests.test_autoproc_model -v` |
| Pure pipeline layer: scope/recipe/overrides → exact argv, stage applicability, validation, legacy migration | `ffs-analysis-ui/lib/pipeline.js` | `node --test tests/test_pipeline.mjs` |
| Host routes `GET /ffs-analysis/autoproc/schema`, `GET/POST /ffs-analysis/pipeline`, `POST /ffs-analysis/pipeline/generate` | `ffs-analysis-ui/index.js` | `node scripts/check_pipeline_api.mjs` |
| Client "Autoproc planner": scope + detection, recipe chips, stage board + inspector, common flags, resolved command, save/generate | `ffs-analysis-ui/client.js` | `node --check ffs-analysis-ui/client.js`; live tab render pending |

Build decisions recorded while implementing:

- The UI never hard-codes the flag list: the schema is dumped from the installed
  `build_parser()` and cached by the autoproc/config source hash.
- Pipeline state is recipe + explicit CLI-dest overrides + optional commands; the stage board
  is a derived view. Only `device`, `no_qc`, `do_mni`, `anat`, `surface_target` and
  `surface_glm` are editable in EP0; everything else waits for EP1.
- The stage map is curated in Python and tested against the real parser so a renamed flag
  fails a test instead of producing a broken UI.
- Stage applicability is advisory; the generated script is generated by the real
  `ffs_autoproc` and the smoke test checks the banner count and script hash.

Verification commands added:

```bash
node --test tests/test_pipeline.mjs
.venv/bin/python -m unittest tests.test_autoproc_model -v
node scripts/check_pipeline_api.mjs          # mocks Cordis, exercises the real routes
```

### EP1 — editable flags and the all-options drawer (built)

- Any `ffs_autoproc` flag can be written as an explicit override; the Host validates the
  argparse action/type/choices before saving and before building argv, and rejects the
  scope/recipe destinations (`-bids_dir`, `-subject`, …) as reserved.
- `store_true`/`store_false` inverse flags are handled correctly (e.g.
  `nordic_dof_adjust: false` emits `-no_nordic_dof_adjust`), and project-relative paths are
  resolved for the path flags declared by the model.
- The client inspector edits the focused stage's flags and op strings; the drawer mirrors the
  12 `--help` groups with search, changed-only, and reset-group/reset-all.
- The planner is wrapped in a React error boundary so a client-side failure cannot blank the
  analysis tab.
- Evidence: `node scripts/check_pipeline_api.mjs` (choice flag `-glm_mask brain`, op string,
  inverse boolean, script generation), `node --test tests/test_pipeline.mjs` (10 tests incl.
  typed/reserved/invalid overrides and path lists).
- Known EP1 limit: repeated-flag actions (`-family`, `-glm_stim_vec`, `-event_filter_*`,
  `-round_*` …) currently hold one occurrence per destination; the form is one value/list
  field, not a repeatable row. Repeated occurrences are EP2 scope.

### EP2 — command steps, scratch runner and promote (built)

- The pipeline file now carries `commands`: argv steps (same whitelist as `ffs_tool_run`) or
  project-relative scripts run with `bash`, frozen by sha256. A changed script blocks save
  with `command-script-changed` until the user re-freezes it.
- Commands run after the autoproc script exits successfully, in order, as their own process
  groups: per-command status/exit/duration/output hashes are recorded in the run state and the
  log; a failure sets `commands-failed` without misreporting the preprocessing stages, and
  cancel targets the current command (`RUN.commandPid`).
- Scratch: the existing `/ffs-analysis/tool-run` route is used by the client's scratch box
  (recorded in `work/ffs-tool-runs.json`); scratch runs can be added to the draft as steps, and
  the drawer shows the recent scratch runs.
- Client: "After autoproc" command list + inline editor (name/argv/script/cwd/expect),
  "Re-freeze scripts & save" banner, and the scratch runner.
- Evidence: `node --test tests/test_commands.mjs` (5 tests: normalization, validation,
  changed-script detection, sequential failure, cancellation), and
  `node scripts/check_pipeline_api.mjs` now also checks two saved command steps, the stale-script
  409 + re-freeze, the `/tool-run` scratch route, and a real command phase after a stand-in
  script (2/2 commands `ok` recorded in the run state and log).

Known EP2 limits:

- The command phase runs after the DSH job has resolved, so the Jobs panel ring shows the
  preprocessing job only; the run state and analysis tab show the command statuses.
- Repeated-flag actions (`-family`, `-glm_stim_vec`, `-event_filter_*`, `-round_*` …) still
  hold one occurrence per destination; repeatable rows are future work.
- Commands are not yet copied into the exported package (EP3).

### EP3 — QC verdicts, decisions and package additions (built)

- `POST /ffs-analysis/decisions` appends a decision to the project state's canonical
  `decisions[]`: id, action (`accept`/`tentative`/`reject`/`undecided`), target
  `{kind, ref, path?, sha256?}`, rationale (explicitly `unknown` when the user says nothing),
  optional confidence, actor, subject, run and pipeline version. A target file that exists in
  the work dir is hashed, so a verdict can cite the reviewed figure.
- The snapshot exposes `decisions` + `decisionSummary`; the QC tab gains per-figure
  Accept/Tentative/Reject with an inline reason and confidence selector, plus a decision list
  showing action, target, rationale, confidence and actor.
- Regenerating a script now preserves existing decisions instead of resetting project state.
- Package additions: `decisions.json`, `pipeline.json`, `commands.json`, `manifest.decisions`
  (counts), `manifest.pipeline`, `manifest.commands`, a `## Judgment calls` METHODS section and
  `## Decisions` / `## Post-processing commands` STEPS sections. Checksums cover the new files.
- EP3 evidence: `node scripts/check_pipeline_api.mjs` records two decisions (one with no
  rationale, one accepted with confidence) and exports a package, asserting
  `decisions.json` (2), `pipeline.json` recipe, `commands.json` (2), the manifest blocks and
  the METHODS/STEPS sections. Full suites: 10 Python + 15 JS tests pass.

Known EP3 limits:

- Exclusion decisions are still recorded through the cohort include toggle, not yet converted
  into `exclusion` decision records.
- The package records commands but `run.sh` still executes preprocessing only; commands are
  documented as a separate post-processing list.
- Repeated-flag actions (`-family`, `-glm_stim_vec`, `-event_filter_*`, `-round_*` …) remain
  one occurrence per destination in the editor.
- Live rendering of the docked QC/planner UI still requires the profile to reload the changed
  Host/Client halves.

Remaining for the panel: live UI verification only (exclusions-as-decisions closed).
The record-layer work in [RECORD.md](RECORD.md) (preferences, inspection sessions, bounded
deletion) is still design-only and independent of this milestone.

## Record layer — R0 build (started 2026-11-13)

The first slice of [RECORD.md](RECORD.md) is built: the append-only attempt ledger, actor
attribution, query/rebuild and one-time legacy import. It is **not installed in the profile
yet** (that is an explicit `plugin_manager install_bundle` profile change).

| Piece | Where | Evidence |
|---|---|---|
| Append-only store: month shards, envelope, actor normalization, fold, query, rebuild, torn-tail tolerance, migration | `shared/record/store.js` | `node --test tests/test_record_store.mjs` (600 appends survive reload, torn tail reported, migration idempotent) |
| Reader bundle: `ffs_record_query`, `ffs_record_rebuild`, authenticated `/ffs-record` route | `ffs-record/` (package, patch row, locale, icon, DETAIL) | `node scripts/check_record_api.mjs` |
| Producer wiring in the analysis plugin: plan/run/tool/replay attempts with route-user vs agent-tool actors, attempts, outputs and command results | `ffs-analysis-ui/index.js` | `node scripts/check_pipeline_api.mjs` ledger assertions |
| One-time import of `ffs-analysis-run.json` / `ffs-tool-runs.json` / `ffs-replays.json` | `shared/record/store.js` `migrateLegacy` | store tests + `ffs_record_rebuild` |

Design deviation, recorded deliberately: R0 uses a **plain shared JS module** imported by both
bundles (file-based producer/reader seam) instead of the two Cordis service rows in RECORD.md
§2.1. This avoids adding a `@deepseek-ai/cordis` build/runtime dependency to the local bundles
and keeps the ledger testable without the Host. A callable service can be added when the
record UI needs live push; the files and schemas do not change.

Known R0 gaps:

- The bundle must be installed/patch-inserted before its tools appear; until then the ledger
  is written but no reader tool is callable.
- The legacy `appendProvenance` 200-entry cap remains for the old provenance files; the
  ledger keeps the full attempts independently, but the old files are still capped until R1.
- Decisions are still stored in the project state (panel EP3); migrating them into
  `ffs-record/decisions` is R1. Inspection sessions/preferences are R2–R4.

## Record layer — R1 decisions in the ledger (built)

The panel's decisions now have a second, append-only home:

- `POST /ffs-analysis/decisions` appends `decision.recorded` events to
  `work/ffs-record/decisions/` (schema, decision id/version, target, action, rationale,
  confidence, actor, subject) **and** keeps the project-state `decisions[]` as the current
  panel/package view. A ledger failure warns and never blocks saving the decision.
- `migrateLegacy` imports pre-ledger project decisions as `decision.imported` events with an
  `unknown` actor (`legacy-project-state`); deterministic ids make the import idempotent.
- `ffs_record_query family=decisions` and the `/ffs-record/{snapshot,family}` route expose the
  family; the snapshot includes `recentDecisions`.
- The legacy provenance cap is gone: `appendProvenance` no longer slices the JSON array to 200,
  so tool-run/replay history is not silently dropped (the ledger is the long-term record).
- Evidence: `node --test tests/test_record_store.mjs` (6 tests incl. legacy-decision import),
  `node scripts/check_record_api.mjs` (decisions family in snapshot), and
  `node scripts/check_pipeline_api.mjs` (two `decision.recorded` events with user actors and
  targets alongside the two run attempts).

### R1 remainder — revisions, supersedes and the settle gate (built)

- `POST /ffs-analysis/decisions` accepts `decisionId` to **revise** a decision (same id,
  version +1, `decision.revised` event) and `supersedes` to replace a different decision
  (target marked `superseded` with `supersededBy`, a `decision.superseded` event, both kept
  in history). The project-state view is updated; the ledger keeps every version.
- The reader folds decision events (`foldDecisions`/`queryDecisions`): `family=decisions` and
  the snapshot return the current decision per id (latest action/version/status, supersede
  links) instead of raw events.
- **Settle gate**: open `tentative`/`undecided` decisions make `POST /settle` fail with
  `409 open-decisions` naming the targets. `{acknowledge:true, note}` records an
  `export/settle` acknowledgement decision and settles; the settled record carries
  `decisions {total, open, openIds, acknowledgedId, …}` and the package manifest exposes it as
  `decisionGate`.
- The analysis tab's Settle action explains the open decisions and asks for confirmation,
  then retries with the acknowledgement.
- Evidence: `node --test tests/test_record_store.mjs` (7 tests incl. decision folding),
  `node scripts/check_record_api.mjs` (folded decisions in snapshot + tool),
  `node scripts/check_pipeline_api.mjs` (revise → v2 → 3 ledger events; settle refused with
  1 open decision → acknowledged settle → package `decisionGate.open = 1`).

Known remaining gaps:

- The record bundle is still not installed in the profile (explicit `install_bundle` change).
- Legacy provenance JSON files are now unbounded arrays; a later slice should shard them or
  drop them entirely in favour of the ledger.
- Decision UI shows the current list but has no revise/supersede controls yet (the API and
  ledger support them).
- Inspection sessions and preferences (R2–R4) remain design-only.

## Record layer — R2 core: durable inspection sessions (built)

The viewer sidecar now writes what inspection actually happened:

- `python/ffsviewer/inspection.py` — per-boot session `insp-<utc>-<4>`, append-only JSONL at
  `<state-dir>/inspection/<sessionId>.jsonl` with a common envelope (`schema`, `frame`, `seq`,
  `sessionId`, `ts`). Frames: `session.start/context/end/paused/resumed`, `event` (command line,
  semantic projection, view/layer, rev + `stateSha256`), `capture`, `mark|measure|correct`,
  `save`, `prune`.
- Semantic projection is table-driven for the FFS vocabulary (`SET_IJK`, `SET_XYZ`, display
  commands, viewports, layers, surfaces, theme) with an `other` fallback; a vocabulary test
  covers every registered command.
- `stateSha256` hashes display state (theme, crosshair, time index, selected layer, layers,
  viewports, surfaces, mode, grid) — never voxel bytes; `capture` returns
  `{sessionId, seq, stateSha256, coordinates, display}` for citing in a decision.
- Sidecar wiring: recording starts at boot; every accepted command appends an event after the
  state snapshot; `save`/`shutdown`/`prune` frames record what happened; when no subject is
  loaded `_prune_surface_log` still trims the `.ffs` replay but now reports the removed count
  in a `prune` frame and never touches the inspection log. New RPC: `inspection_state`,
  `inspection_capture`, `inspection_mark`, `inspection_pause`; `hello`/`state` expose the
  session id and sequence.
- Host viewer: the bridge forwards the four RPCs and the agent tool
  **`ffs_viewer_inspection`** exposes `state|capture|mark|pause`.
- Evidence: `.venv/bin/python -m unittest tests.test_inspection_log -v` (4 tests: append-only
  sequence, stable/sensitive state hash, pause suppression, 114-command semantics) and
  `.venv/bin/python scripts/check_inspection_api.py` (real sidecar: 16 frames, capture hash,
  mark seq, paused command suppressed, save/end frames).

Known R2 gaps:

- Decisions do not yet cite a capture in the panel composer, and the record bundle does not
  index inspection sessions; that link is the next slice.
- No retention/compaction yet; the JSONL grows with the session and the `.ffs-viewer` cleanup
  policy is unchanged.
- No seq-0 baseline state artifact; a cited seq currently relies on the session's event stream
  plus the saved state scripts.
- The viewer tab has no recording indicator/pause control yet (the RPC exists); the running
  sidecar must be restarted to load the new code.

## Record layer — R2 link: decisions cite inspection evidence (built)

- `shared/record/inspection.js` reads the sidecar's session files read-only: sessions, events,
  marks, captures, torn-tail reporting, bounded recent frames, and a compact summary. Node
  tests cover folding, a torn tail and the missing-directory case.
- The record bundle now indexes inspection sessions: `snapshot.inspection`
  (`sessions/events/marks/captures/corrupt/recent`), `GET /ffs-record/inspection` (list) and
  `?session=<id>` (frames), and `ffs_record_query family=inspection`. The viewer state dir is
  `FFS_VIEWER_STATE_DIR` or `.ffs-viewer/`.
- Decisions accept visual evidence: `evidence.visual[]` (or `capture`) with
  `{sessionId, seq, stateSha256, coordinates, display}` is validated (insp-… id, integer seq,
  64-hex hash), stored on the decision as `evidence.visual`, carried in the ledger event and
  exported in `decisions.json`. Revisions keep the previous evidence unless replaced.
- The analysis tab's QC composer gained **Capture viewer state** (through the same `/ffs`
  bridge as Inspect), shows the session/seq/hash chip, and sends the capture with the verdict;
  decision rows show a capture count.
- Evidence: `node --test tests/test_inspection_index.mjs` (2 tests), `check_record_api.mjs`
  (inspection session list/detail/tool/snapshot), `check_pipeline_api.mjs` (decision evidence in
  state + ledger + package), `check_inspection_api.py` (real sidecar capture), 24 JS + 14
  Python tests green.

Known R2 gaps:

- Viewer tab still has no recording indicator or pause control (the RPC and tool exist).
- No retention/compaction or seq-0 baseline artifact yet.
- The record bundle remains uninstalled in the profile; the viewer/analysis hosts need a
  reload to serve the new code live.
- Exclusions are not yet decision records.

## Record layer — R2 remainder: baseline + retention (built)

- **Seq-0 baseline**: the sidecar writes `<sessionId>.start.ffs` (the full FFS state script) the
  first time a viewer state exists after open/restore, hashes it, and appends a
  `session.baseline` frame (`path`, `sha256`, `stateSha256`, `bytes`). `inspection.status` and
  `capture` expose `baselineSha256`, and the record index includes `baseline` per session, so a
  cited seq can be reconstructed from the baseline plus the event stream.
- **Retention/compaction** (`scripts/compact_inspection.py`): keeps the newest N sessions raw,
  compacts older sessions (age and/or total raw-byte budget) into
  `inspection/compact/<id>.json` with marks, captures, head/tail frames and counts, removes the
  raw JSONL, and appends a `session.compacted` tombstone. `--dry-run` plans without touching
  files; repeated runs are idempotent; marks/captures are never rewritten.
- Evidence: `tests/test_inspection_log.py` (baseline assertions), `tests/test_inspection_compaction.py`
  (3 tests: age+keep, under-budget, oldest-first byte budget), `check_inspection_api.py`
  (17 frames incl. `session.baseline`, baseline hash in capture), `check_record_api.mjs`
  (baseline in the indexed session), 24 JS + 17 Python tests green.

Known remaining gaps:

- Viewer tab has no recording indicator/pause control yet (RPC and tool exist).
- Compaction is a CLI only; it is not yet exposed through a tool/route or run automatically.
- `@local/ffs-record` is still uninstalled in the profile; Hosts need a reload for live code.
- Panel polish (repeated-flag rows, exclusions as decisions) and R3–R4 remain.

## Record layer — R3 core: deterministic preference profile (built)

`python/ffsrecord/` implements the preference layer without any LLM call:

- **Features** (`features.py`): one inspection JSONL → a bounded `ffs-record-features/1` shard
  (origin counts, UI-only category/name counts, marks, thresholds/alphas/colormaps/views/layers,
  window/status). Sessions with <60% user-origin events or restored sessions get
  `behavioralWeight: 0` and cannot support a preference.
- **Policy** (`policy.py`): `work/ffs-record/preferences/policy.yaml` is written from defaults
  on first use and is authoritative thereafter (recency half-life, candidate/established
  thresholds, scientific kinds, retention).
- **Profile** (`profile.py`): deterministic aggregation with recency weights and
  support/contradiction scores; statuses `observed → candidate → established`; scientific kinds
  (threshold, qc, exclusion, model, …) can only reach **candidate** — explicit user confirmation
  is required for establishment. Records carry the charter fields (kind/scope/appliesTo,
  recommendation, evidence with representative session ids, score, confidence, history,
  scientific flag). Recompute is idempotent; versions increment only on change; deleting an
  evidence shard and recomputing demotes exactly.
- **Precedence** (`precedence.py`): pure `resolve()` implementing instruction → constraint →
  task/modality → cross-project → candidate → defaults, with an audit list
  (`applied/overriddenBy`) and constraints supplied by established records or accepted
  constraint decisions.
- **CLI** (`python -m ffsrecord.cli`): `feature`, `profile` (ingests sessions, writes evidence,
  profile and version snapshots), `resolve`; `--now` makes output reproducible.
- **Readers/package**: `shared/record/preferences.js` + record bundle snapshot/route/tool
  (`family=preferences`); `exportPackage` ships `preferences.json`, `manifest.preferences`, and
  a `## Preferences considered` METHODS section.
- Evidence: `python -m unittest tests.test_preferences` (13 tests: shard gating, statuses,
  scientific gate, deterministic recompute, versioning, deletion demotion, policy defaults,
  precedence ladder, decisions as constraints, CLI reproducibility), 2 Node reader tests,
  `check_record_api.mjs` (profile in snapshot/route/tool) and `check_pipeline_api.mjs`
  (package preferences + METHODS). 30 Python + 26 JS tests green.

Known R3 gaps:

- No user-only route/UI yet to establish/retire/edit/delete preferences, and no agent
  `ffs_preference_propose` interpretation tool.
- The planner does not yet consume `resolve()` (preferences are informational in the package,
  not injected into run defaults); that is the R3 behaviour slice.
- Presentation-only promotion policy is wired; conditional-context signatures are not mined.
- Profile recompute is CLI-driven; no scheduled/automatic recompute after inspection sessions.
- R4 preference deletion UI, `@local/ffs-record` installation and live UI verification remain.

## Record layer — R3 behaviour: profile reaches the plan (built)

- `GET /ffs-analysis/preferences?task=&stage=` resolves the current context through
  `ffsrecord.cli resolve` (cached by profile mtime): effective rung, matching rungs and the
  applied ids/versions. The analysis snapshot carries the same `preferences` summary.
- Generating a plan reads the resolution and stores `preferencesUsed`
  (`{id, version, rung}` of the applied entries) on the project state. The generated script's
  scientific flags are **never** changed by an inferred preference — only the audit is recorded.
- Settle copies `preferencesUsed` into the settled project, and export puts it in
  `manifest.preferencesUsed` beside `preferences.json` and the METHODS section.
- The viewer sidecar recomputes the profile on shutdown (ingest inspection sessions →
  `ffsrecord.profile.recompute`), so plans see current evidence without a manual CLI step;
  `FFS_RECORD_NO_RECOMPUTE` disables it.
- Evidence: `check_pipeline_api.mjs` (route resolves `task-modality`, applied
  `pref-alpha-0-4`; project state + settled project + manifest all carry it),
  `check_inspection_api.py` (auto profile with 1 session after shutdown), 30 Python + 26 JS
  tests green.

Known remaining R3 gaps:

- User-only preference actions (establish/retire/edit/delete) have no route/UI yet, and there
  is no `ffs_preference_propose` agent tool or confirmation-request event.
- Conditional-context signatures are not mined; presentation promotion policy is wired but
  currently unobservable in UI.
- Preference-driven **viewer presentation** defaults are not applied (only audit + docs ship).
- R4 deletion UI, `@local/ffs-record` installation, panel polish and live UI verification remain.

## Panel gap closed — repeatable autoproc flags (round 13)

The autoproc model exposes 66 `append`/variadic flags (`-family`, `-glm_stim_vec`,
`-event_filter_*`, `-round_*`, `-cut_task_vols`, `-prebuilt_contrasts`, …). The planner now
treats each occurrence as a first-class row:

- Pipeline override value: an array of occurrences, e.g.
  `family: [["rest","4"], ["nback","5"]]`. A flat array (`["rest","4"]`) remains one
  occurrence, so older pipelines keep working.
- `validateOverride` checks each occurrence's arity (`nargs` 2/3/4, `+`, `*`), choices and
  numeric type, and reports which occurrence is wrong.
- `resolvePipelineArgv` emits one flag per occurrence (`-family rest 4 -family nback 5`);
  variadic/path values are still resolved per item.
- The options drawer renders append flags as repeatable rows with **+ occurrence** / **remove**
  instead of one list field.
- Evidence: `node --test tests/test_pipeline.mjs` (new "repeats append-flag occurrences" test:
  two occurrences, single occurrence, arity error, choice error), 27 JS tests green; client
  syntax check; full smoke suite unchanged.

## Panel gap closed — cohort exclusions are decisions (round 14)

- The cohort include checkbox and the `ffs_cohort action=include` tool now write a **decision**
  alongside the include file: action `accept`/`reject`, target `{kind:"cohort", ref:"sub-…",
  cohortRoot}`, optional rationale (the tool accepts `reason`; the checkbox records “not
  stated”), actor (route = user, tool = agent), and `evidence {kind:"cohort-membership",
  include, source}`. It is appended to the decision ledger and mirrored into project
  `decisions[]`.
- Before any plan exists (cohort-only sessions), decisions go to `work/ffs-cohort-decisions.json`;
  generating a plan folds them into the project decisions once (deduped by id).
- The include file remains authoritative for membership, so existing cohort behavior is
  unchanged; the decision is the auditable record of why.
- Cohort export now writes `decisions.json` with all cohort decisions and no longer trips over
  a pre-existing `exportSubjects` ordering bug.
- Evidence: `check_pipeline_api.mjs` excludes and re-includes sub-001, then asserts two project
  decisions (reject with reason, accept with “not stated”), user actor, evidence flags, and two
  ledger events; 27 JS + 30 Python tests and the record/inspection smokes stay green.

Remaining for the panel/record layer: live UI verification, R3 user-only preference actions/UI,
R4 deletion UI, viewer recording indicator, compaction exposure and profile installation.

## Record layer — R3 lifecycle: user-only preference actions (built)

- `python/ffsrecord/lifecycle.py` adds an append-only lifecycle journal
  (`preferences/events.jsonl`) with `preference.established/retired/edited/deleted/
  confirmation-requested/confirmed` events. Events replay deterministically over the derived
  profile in `recompute`; versions are `derivedVersion + stable lifecycle offset`, so repeated
  recompute never compounds versions. If evidence disappears, stale lifecycle events are
  skipped and reported in `profile.lifecycle.skipped` instead of failing the profile.
- Authority is enforced in the lifecycle module (not only the route): establish/retire/edit/
  delete/confirm require a **user** actor; an agent can only append `confirmation-requested`.
  `record_action` validates the preference id against the current profile before writing.
- CLI: `python -m ffsrecord.cli preference --action … --id … [--reason] [--actor user|agent]`.
- Record bundle: `POST /ffs-record/preferences` and
  `/ffs-record/preferences/{establish,retire,edit,delete,confirm}` (user path; 403 for
  agent-only attempts) plus the agent tool **`ffs_preference_confirm`**, which only requests
  confirmation. `GET /ffs-record/preferences` returns the effective profile.
- Evidence: 35 Python tests (5 new lifecycle tests incl. agent denial, unknown id, lost
  evidence, deterministic replay) and `check_record_api.mjs` (3 tools): establish scientific
  threshold as user, request alpha confirmation as agent (status stays observed), reject an
  agent establish with 403, retire alpha, delete threshold, 4 journal events, 2-record profile.

Known remaining R3/R4 gaps:

- No Record-tab UI for preference actions (routes/CLI/tools exist).
- Preference **evidence** deletion and the R4 deletion UI/recompute orchestration are not built
  (preference records can be deleted; their evidence shards remain).
- Presentation defaults from preferences are still not applied; user-only actions do not write
  back into the include/planner defaults.
- Viewer recording indicator, compaction exposure, package install and live UI verification
  remain.

## Record layer — R4: bounded deletion (built)

- `python/ffsrecord/deletion.py` implements the R4 pipeline: resolve scope
  (`sessionId`, `preferenceId`, `before`, `project`), **dry-run** returns affected sessions/
  shards and pending raw deletions without touching files, then apply:
  append a content-free tombstone (`preferences/tombstones.jsonl`, schema
  `ffs-record-tombstone/1`), delete the evidence shards, queue raw inspection files in
  `inspection/deletion-queue.jsonl`, mark citing decisions' visual evidence `status:"deleted"`
  (decisions stay), append `preference.evidence-deleted`, and recompute exactly from the
  remaining shards.
- Confirmed preferences survive behavioral evidence deletion with rewritten provenance
  (`confirmation-supported (behavioral evidence deleted)`), because establish events carry the
  preference snapshot. Deleting a **preference** retires it (history retained); it is never
  removed.
- The sidecar is the sole raw-file writer: on startup it applies the queue, writes
  `inspection/deletion-receipts.jsonl`, and clears it; paths outside the inspection dir are
  refused. Session scanners now read only `insp-*.jsonl`, so queue/receipt files never become
  sessions.
- CLI `python -m ffsrecord.cli delete --scope … [--dry-run]`; record bundle
  `POST /ffs-record/preferences/delete` (user apply) and agent tool **`ffs_preference_delete`
  (dry-run only; applies are user-only)**.
- Evidence: `tests/test_deletion.py` (8 tests: dry-run untouched, tombstone/queue, add-delete-add
  exact recompute, project subtraction, confirmed retention, preference retire, cited-decision
  marking, preference-scope selection); `check_record_api.mjs` (dry-run → apply through the
  route/tool, tombstone without content, profile sessions 2); `check_inspection_api.py`
  (queued raw deletion applied at sidecar startup + receipt). 43 Python + 27 JS tests green.

Known R4/R5 gaps:

- No Record-tab UI for deletion dry-run/apply (route/tool/CLI exist).
- Tombstones are not yet copied into exported packages, and R5 package completeness (record
  subtree, manifest, METHODS preferences/judgment sections, verify.sh) is not built.
- Retention/compaction for raw sessions is still a CLI; sidecar does not run it automatically.
- Viewer recording indicator, record-bundle installation and live UI verification remain.

## Record layer — R5: package completeness (built)

Export now ships the audit trail and verifies it:

- `record/` subtree in every package: `runs/` (append-only attempt ledger shards),
  `decisions/` (decision events), `preferences/` (profile, policy, events, tombstones,
  evidence shards, latest profile version) and `inspection/` for **only the sessions cited by a
  decision** (JSONL + seq-0 baseline `.ffs`), so a decision's `{inspection, seq, stateSha256}`
  points at a file in the package.
- Manifest gains `manifest.record` (shards, decision record count, evidence shard count,
  tombstones, cited session ids, file count); README/METHODS `## Record and audit trail` and
  STEPS `## Record` summarize it; `checksums.sha256` covers the subtree.
- Evidence: `check_pipeline_api.mjs` asserts the record subtree, cited session files,
  `manifest.record`, METHODS/STEPS sections and runs `POST /verify` on the exported package
  (`checksums 770/ok`); 43 Python + 27 JS tests and all smokes green; uninstall-free.

Known R5 gaps:

- `verify.sh --replay` (numeric re-run) is covered by the existing verify tool, but the smoke
  uses checksum verification only.
- The Record tab UI, viewer recording indicator, automatic compaction, record-bundle
  installation and live UI verification remain.

## R6 — conformance re-audit and documentation alignment (built)

- [PHILOSOPHY_CONFORMANCE.md](PHILOSOPHY_CONFORMANCE.md) was rewritten as a re-audit after
  R0–R5: **met 8, partial 4, absent 0** (previously met 1, partial 8, absent 4). Every section
  now names implementation files, tests/smokes, and a concrete residual gap; a new evidence
  map lists the slice → implementation → tests. The four previously absent sections
  (preferences, deterministic split, bounded deletion, precedence) are **met**; remaining
  partials are the explanation layer, exploratory-shell recording, input checksums/shipped run
  logs, and two product surfaces.
- [WORKFLOW.md](WORKFLOW.md) now records the manifest ↔ record-layer relationship (project
  decisions are the current view; the ledger is append-only), the settle acknowledgement gate
  and the export `record/` subtree.
- [README.md](../README.md) describes the record bundle as R0–R5 and links the conformance map;
  [PARITY.md](PARITY.md) adds CORE-05 (durable inspection log) as implemented with its residual
  UI gap.
- Reproducing the audit is documented as a command block (27 JS + 43 Python tests, three smoke
  scripts, deterministic profile CLI).

Residual gaps are unchanged and explicit: Record-tab UI, explanation layer, input checksums /
shipped run logs, automatic compaction, record-bundle installation and live UI verification.

## Record tab — Client surface (built)

- `ffs-record/client.js` is the Client half of `@local/ffs-record`: a right-Sidebar **Record**
  tab (guide order 32) plus a session-header open button, following the same
  `sidebarRightTabs` / `slots` pattern as the analysis tab.
- Sections read `GET /ffs-record/snapshot` and `GET /ffs-record/preferences`:
  **Attempts** (mode/status/actor/subject/started), **Decisions** (action, target, rationale,
  capture count), **Inspection** (session ids with events/marks/captures and a
  *Delete evidence* button that dry-runs then confirms/applies), and **Preferences** (status,
  scientific chip, score/sessions/version, provenance, confirmation-requested note,
  *Establish* / *Retire* user actions with an optional reason prompt).
- User-only authority is still enforced by the Host routes; the tab is another caller.
- Evidence: `node scripts/check_record_client.mjs` (factory load with a React/Cordis stand-in:
  tab id/kind/guide icon registered, both slots present, header button), client syntax check,
  and the Host routes already covered by `check_record_api.mjs` (lifecycle and dry-run/applied
  deletion). Bundle/package metadata now exports `./client` and declares `dsh.client`.

Limits:

- The tab cannot be seen in this environment (no browser control) and appears only after the
  record bundle is installed into the profile and the Harness reloads.
- It is read/action UI only; no inline session playback (opening a cited inspection session in
  the viewer) yet.

## Viewer recording indicator + automatic compaction (built)

- The viewer status chips now show the inspection session: `rec <seq>` (or `record paused`)
  with the session id/path/baseline in the tooltip; the control rail has **Pause rec /
  Resume rec**, calling the existing `inspection_pause` bridge RPC. The tab therefore makes
  recording visible and controllable while inspecting.
- The sidecar runs retention on shutdown: `scripts/compact_inspection.py` with
  policy defaults (30 raw days, 64 MiB budget, newest 20 sessions kept),
  overridable via `FFS_RECORD_COMPACT_DAYS/BYTES/KEEP` and disabled with
  `FFS_RECORD_NO_COMPACT`. Checksums/raw history are unchanged; compact records and
  tombstones are written by the single implementation.
- Evidence: `node --check ffs-harness-viewer/client.js` (indicator + pause control),
  `check_inspection_api.py` now asserts an old raw session is compacted + tombstoned on
  shutdown (`retention ok: old raw session compacted + tombstoned`). 27 JS + 43 Python tests
  and all smokes remain green.

Remaining: record-bundle installation, live UI verification, explanation layer, packaged run
logs/input checksums, and inline inspection playback in the Record tab.

## Package inputs and run logs (built)

- Every export now hashes the BIDS inputs the subject used: `inputs.json`
  (schema `ffs-analysis-inputs/1`, per-file `{path, bytes, sha256}`, count, total bytes) and
  `manifest.inputs` carries the file hash/count. This closes the "input references + checksums"
  gap; output hashes stay in `settled.artifacts`.
- The preprocessing log is shipped as `logs/run.log` when the run produced one, with
  `manifest.logs.run {path, bytes, sha256}`; METHODS gains `## Data and inputs` and README lists
  both artifacts.
- Evidence: `check_pipeline_api.mjs` asserts 8+ hashed BIDS files (all 64-hex), the log content,
  manifest fields and the METHODS section; package checksums verify 772 files. 27 JS + 43
  Python tests remain green.

Remaining: explanation layer, explicit artifact-status labels, inline inspection playback in
the Record tab, record-bundle installation and live UI verification.

## Artifact statuses and why-notes (built)

- Every artifact now carries an explicit `status` (`accepted | rejected | tentative |
  undecided | recorded`), derived from decisions that name the artifact path (latest wins;
  settle-frozen data artifacts default accepted, QC figures stay undecided without a decision).
- Each artifact also carries a short `explanation` of why its kind matters (stats/mask/func/
  params/design/script/log). The analysis tab's artifact table shows the status column and the
  detail card shows status + explanation.
- Packages write `tables/artifacts.csv` (name, kind, status, stage, sha256, explanation) and
  `manifest.artifactStatus` counts; METHODS gains `## Artifact statuses`.
- Evidence: `check_pipeline_api.mjs` asserts manifest artifacts all have status+explanation,
  the snapshot exposes them, `tables/artifacts.csv` has the new columns, and METHODS includes
  the section; 774 files · checksums 773/ok. 27 JS + 43 Python tests green.

Remaining: step/check-specific teaching text and override classification UI; inline inspection
playback; record-bundle installation and live verification.

## Step/check teaching layer (built)

- `ffs-analysis-ui/lib/explain.js` provides curated **why** and **what failure looks like**
  text for all 19 autoproc stages and the common QC figure families (FD, tSNR, motion, DVARS,
  registration, mask, design), with fallbacks for unknown stages/QC names.
- The panel's stage inspector shows why/failure for the selected stage; QC figure captions show
  why/failure under the image.
- The package writes `tables/checks.csv` (check, kind, why, failure) for the run's stages and
  QC figures, `manifest.checks {file,count}`, and METHODS gains
  `## What the checks look for`.
- Evidence: `node --test tests/test_explain.mjs` (3 tests: every stage id, fallbacks, QC name
  matching), `check_pipeline_api.mjs` (snapshot stage explanation, `checks.csv` rows,
  `manifest.checks`, METHODS section), 30 JS + 43 Python tests and all smokes green.

Remaining: override classification UI + constraint gating; exploratory-shell recording;
inline inspection playback; record-bundle installation and live verification.

## Override taxonomy (built)

- Decisions carry `decisionKind: preference | standard | constraint`. A **standard** departure
  requires a recorded reason (Host rejects unreasoned ones with 400) and stores
  `override {kind, reason, authority, ref}`; a **constraint** departure is refused with
  `409 decision-constraint` — constraints are not overridable through the decision composer.
- The QC composer has a **changes: preference | standard** selector, disables save for an
  unreasoned standard departure, and passes `overrideRef` (the figure path).
- `decisionSummary` counts `overrides/standards/constraints`; the ledger event and
  `decisions.json` carry the classification; METHODS gains `## Overrides` with the reason and
  authority; STEPS decision rows show the kind.
- Evidence: `check_pipeline_api.mjs` records a reasoned standard departure, asserts the 400
  for an unreasoned one and 409 for a constraint, checks the project state + ledger, re-exports
  and asserts `decisions.json` + METHODS carry the label/reason; 30 JS + 43 Python tests green.

Remaining: operation-level constraint gating; exploratory-shell recording; inline inspection
playback; record-bundle installation and live verification.

## Inline inspection playback (built)

- The Record tab's Inspection section has a **Replay** button per session. It fetches the
  session frames (`GET /ffs-record/inspection?session=…&frames=500`), filters
  display/navigation events (up to 240), opens the FFS viewer tab and sends
  `execute_batch` over the `/ffs` bridge with `origin: agent`. The replay is a display/navigation
  reproduction over the current dataset; it does not reload the session's source data.
- Evidence: `node --check ffs-record/client.js`, `node scripts/check_record_client.mjs`
  (tab/slots still register), and the inspection/detail routes already covered by
  `check_record_api.mjs`. Note: the replay path itself cannot be exercised here without a live
  browser and an installed bundle.

Remaining: operation-level constraint gating; exploratory-shell recording; record-bundle
installation and live verification.

## Operation-level standard gate (built)

- Settling with **no recorded QC judgment** is a project-standard departure, not a silent
  accept: `POST /ffs-analysis/settle` returns `409 standard-departure`
  (`standard-qc-review`) unless the caller passes `{acknowledgeNoJudgment:true}` or records a
  reasoned `{standardOverride:{reason}}`.
- A standard override records a real decision (`decisionKind: "standard"`, target
  `process/settle`, `override.reason`, authority user) before settling; the settled record
  carries `decisions.standardOverride`. The analysis tab prompts for the reason and retries.
- Constraint overrides remain refused at the decision composer (`409 decision-constraint`);
  operation-level *constraint* gating is still not generalized beyond those refusals.
- Evidence: `check_pipeline_api.mjs` clears decisions, asserts the 409 + `standard-qc-review`,
  settles with a reasoned override, and checks the recorded departure in state;
  client syntax check; 30 JS + 43 Python tests green.

Remaining: generalized constraint operation gating; exploratory-shell recording;
record-bundle installation and live verification.

## General policy gates (built)

- `python/ffsrecord/gates.py` evaluates `policy.yaml` constraints and standards against named
  facts: `bids-subject`, `no-active-run`, `settled`, `judgment-recorded`, `scripts-exist`,
  `inputs-present`; unknown checks are advisory. Constraints refuse (`allowed:false`),
  standards are reported separately for override handling.
- Policy defaults now seed project constraints (subject must exist for plan/run; only one active
  run; export requires settle) and the QC-review standard.
- CLI `python -m ffsrecord.cli gate --op plan|run|settle|export --facts JSON` exits 1 on a
  constraint failure. The Host evaluates the same gate before plan generation
  (`409 constraint-violation`), uses the policy **standard** list for the settle gate, and
  exposes `GET /ffs-analysis/constraints?op=…&facts=…` for transparency. The gate CLI's exit 1
  is parsed as a result, not treated as a failure that would fail open.
- Settle acknowledgements (`acknowledgeNoJudgment`) now record a standard-departure decision
  rather than silently accepting.
- Evidence: `tests/test_gates.py` (5 tests: subject/run/export constraints, standards separate,
  policy extension + unknown checks, CLI exit codes); `check_pipeline_api.mjs` asserts the
  constraints route refuses/permits by facts and the settle gate still records a departure.
  30 JS + 48 Python tests green.

Remaining: operation wiring for more constraints, exploratory-shell recording, policy-authoring
UI, record-bundle installation and live verification.

## Policy visibility (built)

- `python -m ffsrecord.cli policy --json` prints the authoritative project policy; the record
  bundle exposes `GET /ffs-record/policy`, and the Record tab renders a **Project policy**
  section listing every constraint/standard with kind, text, `appliesTo`, and check name.
- This makes the gate order inspectable where the preferences live: constraints (cannot be
  overridden) above standards (departures require a recorded reason), with the exact facts the
  evaluator uses.
- Evidence: `check_record_api.mjs` asserts the policy route (≥3 constraints incl.
  `constraint-bids-subject`, `standard-qc-review`), `check_record_client.mjs` still registers
  the tab/slots; 48 Python + 30 JS tests and all smokes green.

Remaining: policy authoring UI (file edit today), wiring more gate checks into operations,
record-bundle installation and live verification.

## Provenance edges and policy authoring (built)

- `provenance.json` (schema `ffs-analysis-provenance/1`) links every output to the frozen
  script, the packaged `inputs.json` (hash + count) and the settled run (`record/runs/` for
  attempts), carrying each artifact's status on the edge. `manifest.provenance` reports the
  file hash and output/input counts; METHODS gains `## Provenance`; README lists it.
- The Record tab's **Project policy** section now has an **Edit policy** JSON editor; saving
  POSTs `/ffs-record/policy`, which validates through `ffsrecord.cli policy --set` (lists for
  constraints/standards, YAML written atomically) and returns the new policy. Invalid documents
  return `400 policy-invalid`.
- Evidence: `check_pipeline_api.mjs` asserts the provenance map (every output has
  script/inputs/run edges, counts match), `check_record_api.mjs` writes a new constraint,
  re-reads it, and rejects an invalid policy; 48 Python + 30 JS tests and all smokes green.

Conformance: "Complete and honest analysis record" is now **met** (11 met / 2 partial).
Remaining: more operation gate wiring, arbitrary outside-Harness shell history, record-bundle
installation and live verification.

## Gate wiring extension (built)

- New policy checks/constraints: BIDS `dataset-description` (plan), frozen `scripts-exist`
  (run), `run-completed` (settle), alongside the existing subject/active-run/settled checks.
- Host enforcement now evaluates gates in **plan generation** (`409 constraint-violation`),
  **run start** (script/subject facts), and **settle** (run-completed + the policy standard
  list). Runtime gate CLI exit 1 is parsed as a result, so refusals fail closed.
- `GET /ffs-analysis/constraints?op=…&facts=…` exposes the same evaluation for any operation;
  the Record tab policy editor writes `policy.yaml` through the Python validator.
- Evidence: `tests/test_gates.py` (6 tests incl. dataset/script/completion checks and CLI exit
  codes), `check_pipeline_api.mjs` asserts the new failures through the route plus the gate
  wording; 30 JS + 49 Python tests and all smokes green.

Conformance: "Expand competence without constraining expertise" is now **met**
(**12 met / 1 partial / 0 absent**); the remaining partial is the Preserve-composition gap
(arbitrary shell history outside Harness).

## Record/package consistency check (built)

- Every package now carries `verify/record_check.py` (from `scripts/verify_record_package.py`)
  and `verify.sh` runs it after checksums. It cross-checks content, not just bytes:
  every decision in `decisions.json` has a shipping ledger event; preference view equals
  `record/preferences/profile.json`; provenance outputs match manifest artifact hashes and the
  settled run id; `inputs.json` hashes/count agree; the artifacts table matches the manifest;
  manifest record counts match the files.
- `manifest.verify.recordCheck` names it. `check_pipeline_api.mjs` executes both the checker
  and the generated `verify.sh` on the exported package and asserts
  `record/package consistency: ok`; `tests/test_package_verify.py` (4 tests) covers a consistent
  package, a dangling decision, preference-view drift and missing provenance.
- Evidence: 30 JS + 53 Python tests, package `778 files · checksums 777/ok`, all smokes green.

Remaining: Preserve-composition gap (arbitrary shell history outside Harness), record-bundle
installation and live verification.

## Imported manual scripts (built)

- `POST /ffs-analysis/import-script` and the tool **`ffs_analysis_import_script`** record an
  externally edited shell script as an append-only attempt: sha256/bytes/mtime, an optional
  log path + hash + 200-line tail, subject and actor, plus a note. Nothing is executed.
- `promote: true` adds the script as a frozen command step (`scriptPath`, sha frozen on save),
  so a later pipeline run reproduces it; command validation stays green.
- Evidence: `check_pipeline_api.mjs` writes a manual script/log, imports it (hashed + logged
  ledger attempt, actor user), promotes it, asserts 3 command steps and no validation errors;
  30 JS + 53 Python tests and all smokes green.

Conformance: "Preserve freedom of composition" is now **met** (13 met / 0 partial / 0 absent);
only interactive one-off shell history outside a saved script remains uncaptured.

## Build status — all record milestones built (2026-11-13)

R0 through R6 are built and verified: append-only run ledger with actors; decision records with
revisions/supersedes, settle gate and exclusion decisions; durable inspection sessions,
captures/marks, seq-0 baselines, retention/compaction and evidence links; deterministic
preference profile with policy, lifecycle, precedence and package inclusion; bounded deletion
with tombstones and confirmation retention; R5 package completeness (record subtree, cited
slices, inputs/logs, artifact statuses, provenance edges, METHODS/STEPS); R6 conformance
re-audit. The Record tab, viewer recording indicator/pause, automatic compaction, inline
inspection replay, policy editor, policy gates and record/package consistency check are built.

Conformance: **13 met / 0 partial / 0 absent** (was 1/8/4). Remaining external steps are
installing `@local/ffs-record` into the profile (needs explicit user approval) and exercising
the docked tabs in a real browser (no browser control in this environment).

Final verification command set (56 Python tests incl. installer; render smoke in check_record_client):

```bash
node --test tests/test_explain.mjs tests/test_pipeline.mjs tests/test_commands.mjs \
  tests/test_record_store.mjs tests/test_inspection_index.mjs tests/test_preferences_index.mjs
.venv/bin/python -m unittest discover -s tests
node scripts/check_record_api.mjs
node scripts/check_pipeline_api.mjs
.venv/bin/python scripts/check_inspection_api.py
node scripts/check_record_client.mjs
bash docs/../exports/*/verify.sh   # on an exported package; also checks record views
```

## Record layer scale check (built)

`scripts/check_record_scale.py` runs the record layer at scale (synthetic, no imaging):
400 inspection sessions with UI events/marks → feature ingestion and profile recompute →
retention compaction → evidence deletion by date, asserting counts and the recomputed profile
after each step. Latest run:

```
scale ok: 400 sessions · 300 retention tombstones · 300 evidence deletes
timing: write 0.15s · ingest+profile 0.23s · compact 0.71s · delete 0.10s
PASS record scale
```

This closes the "long-term scale" follow-up; add the command to the verification set below.

**Updated verification set:**

```bash
node --test tests/test_explain.mjs tests/test_pipeline.mjs tests/test_commands.mjs \
  tests/test_record_store.mjs tests/test_inspection_index.mjs tests/test_preferences_index.mjs
.venv/bin/python -m unittest discover -s tests
node scripts/check_record_api.mjs
node scripts/check_pipeline_api.mjs
.venv/bin/python scripts/check_inspection_api.py
node scripts/check_record_client.mjs     # includes a render-level tab smoke
node scripts/check_analysis_client.mjs    # analysis tab registers + renders initial tree
node scripts/check_viewer_preferences.mjs
node --test tests/test_presentation.mjs tests/test_viewer_bridge.mjs
.venv/bin/python tests/test_installer.py
.venv/bin/python scripts/check_record_scale.py
bash exports/*/verify.sh
```

Remaining external steps: `@local/ffs-record` installation (explicit approval) and live browser
verification of the docked tabs.
## Install readiness (built)

- `scripts/install_record_bundle.sh` turns the remaining profile step into a reviewable,
  reversible action: it links the checkout into the desktop profile, appends
  `@local/ffs-record` to `dsh.profile.bundles`, writes a timestamped backup of
  `package.json`, and runs `pnpm install` (corepack fallback). `--dry-run` prints the exact
  diff and writes nothing.
- Dry-run verified against the current profile: links `ffs-record/` and appends the bundle row
  (4 → 5). The installer was **not** applied — profile mutation needs the user's approval.
- Installer logic is tested on a throwaway profile (`tests/test_installer.py`, 3 tests):
  dry-run writes nothing; apply links the bundle, writes one backup, preserves existing deps
  and is idempotent; missing bundle/profile fails. `--no-deps` supports isolated testing.
- The Record-tab Client now has a render-level smoke: `check_record_client.mjs` mounts the tab
  component with a fake React hook runtime and walks the element tree, so loading-state
  references fail in CI rather than in the browser.
- README documents the two commands and the reload requirement. Scale check:
  `scripts/check_record_scale.py` (400 sessions; retention + deletion; timings) is part of the
  verification set.

Remaining to finish externally: run `--apply`, reload Harness, exercise the Record tab /
viewer indicator / inline replay / policy editor in a real browser.

## Live installation verification

- Profile write approved and applied: `@local/ffs-record@0.1.0` linked into
  `~/.dsh/profiles/desktop/node_modules/@local/ffs-record`, dependency + bundle row appended,
  `package.json` backup written, pnpm reported `Already up to date` / linked.
- Host half verified live in this session: the record tools appeared
  (`ffs_record_query`, `ffs_record_rebuild`, `ffs_preference_confirm`,
  `ffs_preference_delete`). `ffs_record_query family=runs` returned `{ok:true, runs:[], shards:0}`;
  `ffs_record_rebuild {migrate:false}` returned `{events:0, runs:0}` and wrote
  `work/ffs-record/index/runs.json`.
- Installer logic additionally covered by `tests/test_installer.py` on a throwaway profile.
- Client half verified live through DSH's Client Slots inspector:
  `sidebar.right.pane.tab` occupants include `registrant: ffs-record, key: @local/ffs-record,
  active: true`, and `conversation.session.header.utilities` includes
  `registrant: ffs-record, id: ffs-record, order: 22, active: true`. So the Record tab type/body
  and header button are mounted, not merely packaged.
- Remaining: visual interaction (click through the tab, inline replay, policy editor) still
  needs a human/browser; this environment exposes slot topology and Host tools but no DOM
  input. The installed profile has a timestamped `package.json` backup for rollback.

## Presentation defaults from preferences (built)

- `shared/record/presentation.js` turns established, non-scientific presentation preferences
  (alpha, colormap) into viewer commands (`SET_ALPHA S …`, `SET_COLORMAP S …`). Scientific
  kinds and candidates are excluded by construction.
- Viewer Host tool **`ffs_viewer_apply_preferences`** reads the project profile and applies the
  plan through the same `/ffs` bridge; `dryRun` returns the plan without executing. Each
  application appends a `preference.applied` event (ids/versions/commands/rev) to the record
  ledger.
- The Record tab shows **Apply** on applicable preferences (established, presentation only),
  sending the command to the viewer and revealing its tab.
- Evidence: `node --test tests/test_presentation.mjs` (3 tests: commands, exclusions,
  malformed profiles) and `scripts/check_viewer_preferences.mjs` (mounts the viewer Host with a
  synthetic profile; registers the tool; dry-run yields exactly two commands and skips
  scientific/candidate records).
- Live note: the installed viewer bundle predates this Host change, so the running Harness
  tool list does not show `ffs_viewer_apply_preferences` yet; a Harness/profile reload picks it
  up. The Record-tab Apply button is part of the installed client bundle's next load.

- Automatic application: the viewer applies established presentation defaults **once per
  sidecar session, right after the dataset opens** (`config.autoApplyPresentation !== false`;
  opt out at bundle config). Restarts re-arm it. The plan and ledger event are shared with the
  tool, so on-demand and automatic application are the same audited operation.
- Evidence: `tests/test_viewer_bridge.mjs` (3 tests: auto-apply once on open, opt-out +
  re-arm after restart, dry-run/ensure semantics with a fake sidecar). 36 JS + 56 Python tests.

Remaining: interactive shell history outside saved/imported scripts, and human/browser
click-through of the live tabs (a Harness reload is needed to pick up the new viewer Host).

## Interactive shell-history import (built)

- `POST /ffs-analysis/import-history` and the tool **`ffs_analysis_import_history`** record an
  explicitly chosen shell history file (zsh extended or bash plain) as an append-only
  `run.imported` attempt with mode `shell-history`: file sha256/bytes, the most recent N
  commands (default 200, max 1000), subject, actor and note. Nothing is executed.
- Credential-looking lines (`TOKEN=`, `PASSWORD=`, `secret`, API keys, authorization) are
  **skipped and counted**, never recorded.
- Evidence: `check_pipeline_api.mjs` imports a fixture history with three lines, asserts two
  commands recorded, one credential-looking line skipped, actor user, and that the ledger event
  contains no `TOKEN=`; 36 JS + 56 Python tests and all smokes green.

This closes the previously named "interactive shell history" residual as an explicit,
redacting import; only automatic/live shell capture remains out of scope by design.

## Analysis panel — text artifact previews + client render smoke (built)

- New Host route `GET /ffs-analysis/artifact-text?path=…` previews text artifacts inside the
  project (scripts, logs, design TOMLs, JSON/CSV/TSV, Markdown/YAML, Python): resolves both
  absolute project paths and work-dir-relative paths, rejects traversal, limits to 512 KiB and
  returns `{ok, path, bytes, lines, text}`; non-text types get 415.
- The Data section's artifact detail now renders a scrollable preview for text artifacts
  instead of the old "Text artifact — not a dataset" note; loadable datasets keep the viewer
  load path.
- Evidence: `check_pipeline_api.mjs` previews the generated `.sh` artifact (shebang + line
  count) and asserts the missing-path 404; new `scripts/check_analysis_client.mjs` mounts the
  analysis Client half with a fake React runtime and renders its initial tree (tab/slots +
  4 elements), alongside the existing Record-tab render smoke.
- This closes the v0.2 "text artifact previews" data-check item.
- Panel polish in the same pass: the planner now shows the **pipeline history** (last 10
  saves with version/time/summary) from the Host view; the section rail is a proper vertical
  tablist (`role=tab`, `aria-selected`, `aria-controls`, roving `tabIndex`, Arrow/Home/End
  keyboard navigation) with a labelled `tabpanel` and visible focus styles; the footer reports
  `live project state` instead of always claiming the fixture.
- Evidence: `check_pipeline_api.mjs` asserts the history entries after a save; the analysis
  client render smoke still passes. Remaining panel gap: live in-browser rendering (no browser
  control here).

## Panel bug fix — options drawer scrolling

Reported: in the analysis panel, scrolling did not reveal all options. Cause: the **All options**
drawer had two nested fixed-height scroll containers (`max-height: 420px` on the group list and
on the flag-field list) inside an already-scrolling panel. In a short sidebar the inner list
ate the wheel events and stopped at 420 px, leaving later options unreachable.

First fix: remove the inner max-heights and make `.ffa-content` the scroll container. When the
report persisted, the structural cause was that the drawer still depended on the panel's scroll
region/sidebar height at all.

Second fix: **All options is now a full-height overlay drawer** anchored to the panel root
(`role="dialog"`, backdrop + Close + Escape/backdrop dismissal). Its body
(`.ffa-drawer-body`) is its own scroll container (`flex:1; min-height:0; overflow:auto`), so
every option is reachable regardless of the panel's scroll position or the sidebar height. The
old inline placement is gone. `tests/test_panel_layout.mjs` now asserts the overlay structure,
the drawer-body scroll contract and the absence of fixed field heights (3 tests). Visual
confirmation still needs a page reload/browser, which this environment does not expose.

## Panel UX — stable stage inspector

Reported: clicking a preprocessing stage changed the options panel's height because the inline
stage inspector rendered a variable number of flags. Fix: the inspector is now a **fixed-height
pane** (`--ffa-stage-pane-height`, default 340 px) with a sticky header and its own scrollable
body; the stage board uses the same height. Selecting a stage swaps content inside the seam
without reflowing the planner or moving the command/scratch sections. Covered by
`tests/test_panel_layout.mjs` (4 tests now; the new one pins the fixed-height/overflow contract).

## Layout diagnostics for the panel scroll report

The scroll/content clipping report persisted after CSS-only fixes, so the panel now reports real
layout numbers instead of relying on guesses:

- On mount, the Client measures its root, ancestor chain (up to 8), `.ffa-content` (including
  scrollHeight/clientHeight/scrollTop), `.ffa-stage-inspector` and `.ffa-stage-board`, then
  POSTs the snapshot to `/ffs-analysis/client-diag`; the Host writes
  `work/ffs-analysis-client-diag.json`.
- Diagnostics are one-shot per mount and contain only tags, class names and geometry
  (viewport, heights, overflow/position/flex/min/max, scroll metrics) — no data or screenshots.
- Also in this pass: **All options is now a fixed, full-viewport dialog** (`position: fixed;
  z-index: 1000`) so no ancestor overflow can clip it, and the stage inspector remains a
  fixed-height pane with its own scroll.
- Route covered by `check_pipeline_api.mjs` (POST writes the JSON, viewport asserted); the client
  render smoke still passes.

Next step requires the live page: reload Harness with the analysis tab open, then
`work/ffs-analysis-client-diag.json` will contain the actual clipping chain, so the remaining
issue can be fixed from measurements instead of inference.

## Panel scrolling — single root scroll container

Nested scrollers were removed completely for the main panel path: `.ffa-root` is now the
**single vertical scroll container** (`.ffa-main`/`.ffa-content` use `overflow: visible`, the main
row is auto-height, and the header is sticky). The stage board, stage inspector, pre/log blocks
and the fixed full-viewport **All options** dialog keep their own bounded scroll only where
their content is intentionally compact. This guarantees every panel section (including command
steps and scratch) is reachable from one scrollbar, independent of an inner element's height.
`tests/test_panel_layout.mjs` pins the contract (root scrolls; content does not).

## Root cause of the panel clipping: absolute root vs flex tab body

Inspecting the shipped sidebar bundle's CSS showed the tab body contract:

```css
/* Harness right-sidebar tab body */
.Dv5QdW_tabBody { display:flex; flex-direction:column; height:100%; min-height:0; overflow:hidden; }
```

The analysis panel had `.ffa-root { position:absolute; inset:0 }`. Its containing block was
not that tab body (the body is not a positioned ancestor), so the root could be sized against a
different box while the tab body clipped it with `overflow:hidden`. That leaves the root's
scrollbar extending below the visible area — the last content can never be scrolled into view,
even though the scroll container itself works.

Fix: `.ffa-root` is now a **normal flex child** of the tab body
(`position: relative; flex: 1 1 auto; min-height: 0; width: 100%`) and the single vertical
scroll container. The header stays sticky; nested scrollers are limited to the compact stage
board/inspector, pre/log blocks, and the fixed full-viewport All options dialog.
`tests/test_panel_layout.mjs` now asserts root flex-fill/min-height and forbids
`position:absolute`.

## Host reload required for scroll/diagnostic fixes

Two separate reload layers were involved:

1. **Host half** was serving stale module code. File edits are not hot-applied; the supported
   local path is installing/reloading the bundle. The analysis plugin loader entry
   (`include:ffs-analysis-ui`) was disabled and re-enabled via `plugin_manager`, which returned
   `application: applied`. After that the `ffs_analysis_snapshot` tool works again — proving the
   Host is current. While checking this, a real regression was found and fixed:
   `snapshotSummary` referenced `pipe` outside its scope; it now reads
   `readPipeline().pipe.scope` inside a guard.
2. **Client half** still requires a page refresh to fetch the new `client.js`; the panel footer
   now shows **`client 0.1.1`** so a stale page is immediately visible (package version bumped
   to 0.1.1). On mount the new client posts its one-shot layout diagnostic to
   `work/ffs-analysis-client-diag.json`.

Root-cause fix from the shipped tab-body CSS: `.ffa-root` is now a normal flex child
(`flex:1 1 auto; min-height:0`) of the Harness tab body, not `position:absolute`; the tab body
(`display:flex; flex-direction:column; height:100%; overflow:hidden`) therefore clips and
scrolls exactly the panel box. A snapshot-tool regression assert was added to
`check_pipeline_api.mjs`.

Next: refresh the page with the analysis tab open; the footer must read `client 0.1.1`, and the
diagnostic file will appear if the panel still does not scroll fully.

## Stage options as a fixed dialog (UX alternative)

The inline stage inspector was removed. Clicking a preprocessing step now opens a **fixed
full-viewport stage-options dialog** (same shell as All options): sticky header with stage
id/label and runs/off state, then a scrollable body with stage flags, op strings, common flags,
tools, outputs and why/failure text. The planner therefore never changes height when selecting
a step, and the options are not confined to a 340 px pane. The stage board stays a compact
220 px full-width list (its own local scroll). Escape/Close/backdrop dismiss the dialog.
Layout tests updated; client stamped `0.1.3`.

## Diagnostic capture refinement (client 0.1.4)

Live capture showed the root now scrolls (`scrollHeight 1654` vs `clientHeight 1012`) and the
stage board is compact (220 px, local `scrollHeight 558`), but the sampled click had no dialog
mounted. The click diagnostic now samples at **+60 ms, +500 ms and +1500 ms** and posts
`drawerPanel`/`drawerBody` metrics (plus version `0.1.4`), so a click on a preprocessing step or
**All options** records the actual dialog box. Footer/build stamp is `client 0.1.4`.

## Dialog-open capture (client 0.1.5)

The +1500 after-click sample still had no dialog, so the click wasn’t on a stage/All options
(or the dialog closed before sampling). Client 0.1.5 adds a **MutationObserver** on the panel
root: the moment `.ffa-drawer-panel` mounts it posts a `dialog-open` diagnostic with the dialog
panel/body metrics. Click samples now also record the clicked element (tag/class/text), so a
sample can distinguish “clicked a stage” from “clicked elsewhere”. Footer stamp `client 0.1.5`.

## Horizontal clipping path (client 0.1.6)

A second clipping path existed independently of vertical scrolling: `.ffa-root` used
`overflow-x: hidden` while wide content (notably the 39-column QC review table and cohort/group
tables) can exceed the 793 px content column. Those columns were unreachable. The root now
allows horizontal panning (`overflow-x: auto`) and card bodies scroll their own overflow
horizontally. Diagnostics now capture `scrollWidth`/`clientWidth` so the next live sample can
confirm whether horizontal overflow exists per section. Footer stamp `client 0.1.6`.

## Live scroll verification + section scroll reset (client 0.1.6)

The running page (client 0.1.6) reported:
- root `clientHeight 1012`, `scrollHeight 1658`, `overflowY auto` → panel scrolls all content;
- root `clientWidth 1165`, `scrollWidth 1165` → no horizontal clipping;
- stage board `height 220`, `scrollHeight 558` → local board scroll works.
So the absolute-root clipping is resolved in the live UI.

Next UX gap fixed: switching an analysis rail section now resets the panel root's scrollTop to 0,
so a new section never starts mid-scroll with its heading/first controls cut off.

## Dialog focus management + cleanup (client 0.1.8)

Both dialogs (All options, stage options) now share `useDialogFocus`: on open it focuses the
**Close** button, traps Tab/Shift-Tab within the dialog, closes on Escape, and restores focus to
the previously focused element on close. The old inline `StageInspector` component and its CSS
(`.ffa-stage-inspector*`, `.ffa-planner-grid`) were removed now that stage options live in the
dialog. Added `tests/test_panel_a11y.mjs` (modal role, focus-on-open, focus restore, Tab trap,
hook used by both dialogs). Footer stamp `client 0.1.8`.

## UX review fixes (client 0.1.9)

UI/UX review findings implemented:
1. **Critical — dialog focus stealing.** `useDialogFocus` re-ran whenever an inline `onClose`
   identity changed (every keystroke); it now stores `onClose` in a ref and runs only on
   `[panelRef]`, so typing in flag fields no longer jumps focus to Close.
2. **High — unsaved planner draft survived section switches.** The planner stays mounted
   (hidden with `display:none`) while other rail sections are active, so `draft`, selected stage,
   generated preview and dialogs survive. The 2 s version poll no longer overwrites a dirty draft
   (`dirtyRef` guard).
3. **High — validation warnings moved directly under the stage board**, before Commands/Scratch,
   so they sit next to the Generate action rather than below interactive panels.
4. **Medium — All-options search is global.** With a non-empty query it searches every group,
   renders grouped matches, shows per-group match counts, and reports total matches instead of
   "0 of 43" for the active group.
5. **Medium — rail is sticky** (`position:sticky; top:6px; align-self:flex-start;
   max-height:calc(100vh - 24px)`), so section navigation stays visible while content scrolls.
6. **Medium — stage board affordance:** footer shows `included/total` plus “scroll the list ·
   click a stage to edit its options”; a bottom fade signals more rows; selecting a stage calls
   `scrollIntoView({block:'nearest'})`.

Tests: `test_panel_a11y.mjs` now pins the ref-based focus setup; `test_panel_layout.mjs` pins the
board affordance. Client stamp `0.1.9`.

## Section memory + remote-change warning (client 0.1.10)

- The active rail section is persisted in `localStorage` (`ffs-analysis-section`) and restored
  when the tab remounts, so reopening the panel resumes the previous section.
- The 2 s pipeline-version poll no longer silently ignores an external change while the draft is
  dirty: it sets `remoteVersion` and the planner header shows “pipeline changed on disk” with a
  **Reload** action (confirm discards the local draft). Saving/loading clears the notice.
- Added a11y test assertions for both behaviours. Client stamp `0.1.10`.

## Toast visibility + diagnostics opt-in (client 0.1.11)

- The toast is now `position: sticky; bottom: 8px; align-self: flex-end` inside the scrollable
  panel root, so status/error toasts stay visible when the panel is scrolled (previously an
  `absolute` toast scrolled out of view).
- Layout diagnostics are now **opt-in**: they only run when the page URL has `?ffs-diag=1`.
  Normal use no longer posts geometry or writes `work/ffs-analysis-client-diag.json` on every
  click. The route stays for future live debugging.
- Layout test pins the sticky toast. Client stamp `0.1.11`.

## Section crash boundary + command copy (client 0.1.12)

- Added `SectionBoundary` around the active section content (keyed by section, so switching
  sections retries): a rendering failure in Data/QC/Results/etc. now shows a local “Section
  failed” card and leaves the rail, planner and other sections usable, instead of blanking the
  whole tab.
- The planner’s **Resolved command** row now has a **Copy** button (clipboard with a toast),
  complementing the generated-script preview.
- Layout test pins both. Client stamp `0.1.12`.

## Group contrast picker (client 0.1.13)

The group-analysis section hardcoded `contrast: 'scenes'`, which would silently run the wrong
contrast for snapshots whose contrast names differ (e.g. localizer runs). It now derives available
contrast names from `snap.results.contrasts` (deduped, supports string or `{name|id}` entries),
shows a select when names are available and a text input otherwise, and passes the chosen value
to `onRunGroup`. Test pins that `contrast: 'scenes'` is gone.

## Two-group split validation (client 0.1.14)

The group Run button was disabled for bad splits but gave no reason. Now:
- subject ids present in both A and B are detected (`overlap`) and block the run;
- the inline hint shows `A vs B`, overlap ids, and “need 2+ per group, no overlap” in warning colour;
- the Run button's `title` explains the failing condition (fewer than 2 included subjects,
  too few ids in A/B, or overlap).
Tests pin the overlap check and `runHint`. Client stamp `0.1.14`.

## Results preview caption uses live data (client 0.1.15)

The preview caption was hardcoded to “scenes > baseline, t=3.1”. It now reads
`model · first contrast name · t ≥ <snapshot threshold> · hot`, so localizer/multi-contrast runs
show their own contrast and threshold instead of demo text. Test pins the removal and the live
threshold expression. Client stamp `0.1.15`.

## Group analysis status precedence fix (client 0.1.16)

`analysis.status || analysis.error ? 'failed' : 'completed'` parsed as
`(status || error) ? ...`, so **every** group analysis with a status string (including
“completed”) rendered as failed. The pill now uses
`analysis.error ? 'failed' : (analysis.status || 'completed')`. Test pins the expression and the
absence of the old pattern. Client stamp `0.1.16`.

## Artifact selection key fix (client 0.1.17)

Data-section rows compared `selected.id === artifact.id`. Artifacts without an `id` made both
sides `undefined`, so **every row rendered as selected** once any such artifact was clicked. The
table now uses `artifactKey = artifact.id || artifact.name || ''` for both the React key and the
selection comparison. Test pins the key and the absence of the raw id comparison.

## Cohort feedback improvements (client 0.1.18)

- The cohort header shows the **live included count** computed from the current subject rows
  (`subjects.filter(include !== false)`), not the possibly stale snapshot total.
- After validation it reports `N ok · M issue(s)` in addition to the pass/fail pill and timestamp.
- The Validate button’s tooltip explains when it is disabled (no subjects discovered) and what
  validation checks. Test pins `includedCount`/`issueCount`.

## QC decision composer survives polling (client 0.1.19)

`renderComposer` compared `pending.figure !== figure`; the 2 s snapshot poll recreates figure
objects every refresh, so an open Accept/Tentative/Reject composer could disappear mid-edit.
It now compares stable keys (`figureKey = id || asset || label`), so the composer persists across
poll refreshes. Test pins the stable key and the absence of the identity comparison.

## Persistent group-run form (client 0.1.20)

Added a small `useStoredState` hook and applied it to the group run form: design, engine,
correction, contrast, and A/B subject ids now persist in `localStorage`
(`ffs-group-*`). Switching to Cohort/Results and back no longer resets a partially configured
group run. Contrast still self-corrects if a stored name is not in the current snapshot’s
contrast list.

## Persistent result thresholds (client 0.1.21)

The Results threshold/min-cluster inputs and the Settings result defaults now use
`useStoredState` (`ffs-results-threshold`/`ffs-results-min`,
`ffs-default-threshold`/`ffs-default-min`). Switching rail sections no longer discards values the
user typed before pressing Apply. Initial values still come from the snapshot when no stored
value exists.

## Reset stage action (client 0.1.22)

The stage-options dialog now has **Reset stage**, enabled only when any stage flag/op-string has
an explicit override. It confirms, then clears all overrides for that stage’s flags and opts via
the same `onReset` path as the All-options drawer. Test pins the action.

## Group summary stale-error fix (Host, 0.1.23)

`groupSummaryRecord` spread the stored `analysis` object and then set `status: 'completed'`, but
left a previous `error` field untouched. The panel correctly treats any `error` as failed, so a
successful retry could still display as failed. The summary now sets `error: null` on success.
Host package bumped to 0.1.23 (client unchanged at 0.1.22).

## Group work-dir/file contrast tag (Host, 0.1.24)

Group runs embedded the raw contrast label in the work-directory and output file names. Labels
with spaces/punctuation (e.g. `scenes > baseline`) produced paths with spaces. `runGroupAnalysis`
now derives a safe `contrastTag` (`[A-Za-z0-9._-]`, trimmed) for the group id and coef/tstat file
names, while the original contrast string remains in the analysis record. Host package 0.1.24.

## Group history metadata (client 0.1.25)

Group analyses are now sorted **newest first** (by `at`) and each card shows the run timestamp
plus its work directory/bucket path (mono, truncated by wrapping). This makes repeated runs with
different designs/corrections distinguishable. Test pins `analysis.at` and the newest-first sort.

## Provenance concurrency guard (client 0.1.26)

Settle, export, replay and verify could be started concurrently. `ProvenanceSection` now computes
`provenanceBusy = busyAction !== null || replaying || verifying` and every provenance action
button disables while any of them runs, preventing concurrent package mutations/reads.
Also verified the existing export package end-to-end: `ffs_analysis_verify` checked **766**
checksums with **0 mismatches**.

## Group summary copy (client 0.1.27)

Each group-analysis card has **Copy summary**, which copies a plain-text block (id · contrast,
model/engine/n, correction, run time, work dir, cluster count) for notes/methods. `copyPath` now
accepts an optional toast label, so the group copy reports “Group summary copied” instead of the
path-copied message.

## Cohort package export from the panel (client 0.1.28)

The Host already supported cohort package export (`POST /ffs-analysis/cohort {action:'export'}`),
but the Cohort section had no action. Added **Export cohort** next to Validate:
- disabled for empty cohorts or while exporting;
- shows `Exporting…` and a busy state;
- posts the export, toasts the resulting package directory, refreshes the snapshot;
- tooltip explains that it validates and builds the reproducible package (scripts, subjects,
  methods, hashes).

Tests pin the action and busy state.

## Cohort export result surfaced (client 0.1.29)

After **Export cohort** succeeds, the Cohort section now shows the package directory, file count
and subject count inline, with a **Copy** button (custom toast label). Previously only a transient
toast carried the result. `onExport` returns the payload so the section can retain it.

## Stage-board and dialog text fixes (client 0.1.30)

Reported: a stage row (e.g. stage12s) was only partially visible and some floating options text
was clipped.

- Stage board no longer has a fixed 220 px local scroll with a bottom fade. It is auto-height
  (`height:auto`, `.ffa-scroll.ffa-stage-board { max-height:none; overflow:visible }`), so every
  preprocessing step is fully visible via the panel root scroll, with no partial row under a
  gradient.
- Floating option dialogs: the header now wraps and its title can break long words; flag labels
  wrap within a `minmax(96px,150px)` column; group labels wrap instead of ellipsis-truncating;
  option columns use `minmax(170px,220px)`; names can wrap. This makes long flag/group text
  readable instead of clipped.

## Scratch rendering fixes (client/Host 0.1.31)

- Host `tool-run` now returns `stdoutLines`, `stderrLines` and `outputTruncated` alongside the
  already-truncated stdout (last 40) / stderr (last 20). The scratch panel shows
  “output truncated · showing last N of M …” so long output no longer looks silently incomplete.
- Scratch/command rows wrap long argv text (`flex-wrap`, `overflow-wrap:anywhere`, `min-width:0`)
  and the recent-run argv has a full-text `title`, so command text isn’t clipped off the row.
- Smoke now runs a 60-line scratch command and asserts `stdoutLines=60`, `outputTruncated=true`,
  and ≤40 returned lines.

## Stage inspector: inherited values, last run, skip note (0.1.32)

Spec §4.3 gaps closed:
- `stagePlan` now returns `inherited`: recipe settings that apply to a stage's flags/opts when the
  user has not overridden them (`{dest, source: recipeId, value}`). Overridden values are omitted,
  and no recipe means no inherited list (defaults are not mislabeled as recipe values).
- The stage options dialog shows **Inherited from recipe** (e.g. `moco_ref = sbref`), **last run**
  (`done · 17s` / not recorded) and a read-only re-run note (script skips existing outputs;
  `-batch_overwrite` forces).
- Stage-board rows now show the stage tool(s) for included stages and `done · <time>` when the
  last run completed them; row `title` includes the reason/tools.
- `tests/test_pipeline.mjs` asserts inherited values and override suppression.

## ffs_pipeline_edit agent tool (0.1.33)

Added the spec §6 tool `ffs_pipeline_edit`: edits scope/recipe/overrides/commands in the shared
pipeline file, validates it, bumps the version and returns the resolved `ffs_autoproc` command;
it never runs anything. Overrides merge by default (`replaceOverrides: true` replaces the map,
null/empty removes a key); commands replace the full list. History records the agent actor via
`savePipeline(body, actor)`. Smoke calls the tool, asserts version bump + `-moco_ref first` in the
resolved command, then removes the override and asserts it disappears.

## Recipe coverage + reset (0.1.34)

Spec §4.1 gaps closed:
- `pipelineView` now returns `coverage[recipeId] = {included,total}` computed by applying each
  recipe to the current scope/overrides/detection and counting included stages.
- Recipe chips include coverage in their tooltip; the description line shows
  `included/total stages` for the selected recipe.
- A confirmed **reset recipe (N)** action clears all explicit overrides, returning to the
  selected recipe/defaults. It is disabled when there are no overrides.
- Smoke asserts `/pipeline` returns coverage for every recipe.

## All-options affordances (0.1.35)

Spec §4.4 gap closure:
- The changed-only checkbox now reports the total changed flag count: `changed only (N)`.
- Option-group buttons expose the full group title as a tooltip.
- The drawer has the spec footer: “These are the ffs_autoproc flags themselves; the generated
  script uses exactly these values.”
Still open from §4.4: accordion presentation (current is group list + active group), path pickers
and list chips.

## Editable output script (0.1.36)

Spec §4.1 required-input gap closed:
- `scope.out` is now an optional pipeline field; normalization preserves it, and the resolved
  `-out` argument uses it when set, otherwise the derived
  `<workDir>/proc_sub-<subject>.sh`.
- Non-`.sh` output paths are rejected with `scope-out` and the resolver returns `ok:false`.
- Planner scope has an **Output script** input with the derived path as placeholder.
- `tests/test_pipeline.mjs` covers custom/derived output and invalid suffix (13 pipeline tests).

## All-options accordion (0.1.37)

Spec §4.4 accordion presentation implemented: the fields area now renders one collapsible
`<details>` section per parser group (same order/titles), each with a flag count and changed-in-
group count. The active group starts open; clicking a group in the side list opens it; during a
search every matching group opens and non-matching groups are hidden. The group list, search,
changed-only, resets and footer remain.

## List flags as chips (0.1.38)

Spec §4.4 list affordance: `kind: 'list'` flags now render values as removable chips plus a
value input (Enter adds; space/comma separates multiple values). Empty lists show the default or
“no values”. Removing/adding commits through the same override path. Exact-`nargs` append flags
keep their repeatable rows; path flags are still text inputs (picker remains open).

## Path pickers (0.1.39)

Spec §4.4 path affordance:
- `pipelineView.flags` marks path destinations (`path: true`).
- Single-value path flags render an input plus **Browse…**, opening a project-scoped picker:
  directory navigation/up, project-relative path input, file selection, “Use this path”.
- New Host route `GET /ffs-analysis/browse?path=` lists ≤500 non-hidden entries under the project,
  sorted dirs-first, rejects paths outside the project. Smoke covers listing and traversal
  rejection.
- List-valued path flags keep the chip editor; boolean/choice/int fields keep their controls.

## Generate + Run action bar (0.1.40)

Spec §4.5: the planner header now contains **Generate script** and **Run** in one bar, alongside
All options/Save. Run uses the same `runPipeline` callback as the pipeline card, is disabled
while a planner action or run is active, shows `Running…` when the pipeline is already running,
and keeps the existing pipeline card controls (cancel/resume) intact.

## /pipeline/promote route (0.1.41)

Spec §6 route parity: `POST /ffs-analysis/pipeline/promote` accepts a scratch attempt
(`argv` + optional name/scriptPath/cwd/expect/env/origin/toolRunId), appends it as a command step
through `savePipeline` (validation + version bump), and returns the command, new version and
count. Smoke promotes an `ffs_info` step and verifies it appears in the pipeline; route traversal
and validation reuse existing command normalization.

## Path picker accessibility (0.1.42)

The new path picker is a modal dialog and now behaves like one: capture-phase Escape closes only
the picker (`stopImmediatePropagation` keeps the parent All-options drawer open), Tab/Shift-Tab
traps focus inside the picker, focus moves to its path input on open and returns to the previous
element on close. The test suite pins the capture-phase listener and Escape isolation.

## Append flags as editable chips (0.1.43)

Repeatable append flags (`nargs` integer or `+`) now render each occurrence as an editable chip
with an inline value input and a × remove control, plus “+ occurrence”. Editing stays live
through the same commit path; the hint describes the expected value count. This closes the
All-options “list/tuple chips” item.

## Visible default for overridden fields (0.1.44)

Spec §4.3 op-string detail: when a field has an explicit override that differs from the parser
default, the field now shows a muted `default: …` line (arrays joined) under the control, so the
diff is visible without pressing reset. Applies to stage flags/op strings and All-options fields.

## Final spec audit (0.1.44)

All buildable items in `ANALYSIS_PANEL.md` are implemented:
- §4.1 scope/output script, detection, recipe chips with coverage + confirmed reset.
- §4.2 stage board rows (number/label/tools/run-done/changed), selection survives sections.
- §4.3 stage dialog: why/failure, stage flags, op strings, outputs, inherited recipe values,
  visible defaults, last-run state, read-only re-run/skip note.
- §4.4 All-options accordion per parser group, search, changed-only count, per-field/group/all
  reset, path pickers, list chips, editable append chips, footer.
- §4.5 Generate + Run bar, resolved command, validation and generated-script preview.
- §6 routes (`autoproc/schema`, `pipeline`, `pipeline/promote`) and the `ffs_pipeline_edit` tool.
- §7 execution/decisions/package flows; §9 deliberate cuts remain cut.

Verification: **45 JS tests, 56 Python tests**, analysis-client render smoke, pipeline API smoke
(includes schema, save/history, previews, decisions, package checksums, `ffs_pipeline_edit`,
`pipeline/promote`, browse), record API smoke, and `ffs_analysis_verify` on the existing export
package: **766 checksums, 0 mismatches**. Live visual/a11y review remains the only unverified item.

## Record tab Settings section (record 0.1.1)

Closed the §9.3 Settings gap: the Record tab now shows record root/family counts/corrupt lines,
policy **raw retention** (days/bytes/keepSessions), **recency half-life**, policy file path, and
the recording default (on unless paused / `FFS_RECORD=off`), with a **Rebuild index** button that
calls `POST /ffs-record/rebuild` and reports counts. Rebuild result toast uses the returned
`counts` shape. Added `tests/test_record_ui.mjs`.

## Record attempt filters (record 0.1.2)

Closed the §9.3 Runs filter gap: the Attempts section now has status/mode/actor selects and a
subject input, queries `/ffs-record/runs` with the active filters (limit 100), shows a query error
inline, and has a clear-filters action. Unfiltered lists still come from the snapshot.

## Record decision filters + history (record 0.1.3)

§9.3 Decisions: status filter queries `/ffs-record/family?family=decisions` (limit 100), rows show
action/status, id, actor authority, confidence, capture count and age; clicking a row (or
Enter/Space) expands the decision’s event history inline (`ffr-history`) with timestamp/type/actor.
Snapshot rows remain the default when no filter is active.

## Record inspection live state/events (record 0.1.4)

§9.3 Inspection: `inspectionSummary` now exposes top-level `live` (latest session still open) and
`paused`, and each recent session carries `paused`/`live`. The Record tab shows live/paused
badges, an **Open in viewer** action, per-session **Events** loading a bounded 100-frame list from
`/ffs-record/inspection?session=…&frames=100`, and keeps replay/delete. Pause/resume remains in
the viewer tab as specified.

## Record decision composer (record 0.1.5)

§9.3 Decisions composer: the Record tab now has **Record decision**, opening a modal with
action (accept/tentative/reject/withdraw/exclude/include), target kind/ref/path, reason,
confidence and preference-vs-standard kind. A standard departure requires a reason before Save.
It posts to the existing `/ffs-analysis/decisions` route (the one decision store; no second
ledger) and refreshes the snapshot; failures surface as toasts/inline errors.

## Record inspection toggle + preference confirm (record 0.1.6)

- Inspection: added **Pause recording / Resume recording** in the Record tab, calling
  `/ffs` `inspection_pause` through the viewer RPC and refreshing the snapshot.
- Preferences: when a preference has a pending `confirmation.requested` (agent request), the row
  now offers **Confirm preference**, which answers through the user-only `confirm` action.
- Composer modal now has capture-phase Escape/focus trap + focus restore (§9.4).

## Record tab blank render fixed (record 0.1.7)

The decision composer added `useRef` without adding it to the Record client’s React destructure,
so the entire Record tab threw `useRef is not defined` on render. Fixed the import and added a
guard test that the client destructures every hook it calls (`tests/test_record_ui.mjs`).

## Record tab error boundary + build stamp (record 0.1.8)

- `RecordBoundary` wraps all Record-tab sections: a runtime failure now shows an inline error with
  the message and a Reload button instead of a blank tab. The render smoke provides a Component
  stand-in so the boundary is exercised.
- Header shows `record 0.1.8`, making stale/blank-client diagnosis visible.

## Record root flex + client hook hygiene (record 0.1.9)

- `.ffr-root` now fills the Harness tab body as `flex:1 1 auto; min-height:0; width:100%` (same
  contract as the analysis panel), instead of relying on `height:100%`; the tab scrolls within its
  own box.
- Added `tests/test_client_hygiene.mjs`: for all three clients, every bare React hook call must be
  destructured from `React` — the exact failure class that blanked the Record tab.
- Record header stamp updated to `record 0.1.9`.

## Decision composer action alignment (record 0.1.10)

The composer offered `withdraw/exclude/include`, but `/ffs-analysis/decisions` only accepts
`accept/tentative/reject/undecided`; those choices would have failed at save. The select now
matches the Host `DECISION_ACTIONS` set, with a test pinning the list.

## Composer path semantics (record 0.1.11)

The decision composer’s path field said “project-relative”, but `recordDecision` resolves
`target.path` **inside the run work dir** and hashes it there. The label/placeholder/tooltip now
say “relative to the work dir”, avoiding paths that silently fail to hash. Test pins the wording.

## Generate blocked by validation errors (analysis 0.1.45)

The planner allowed Generate even when `view.validation.errors` was non-empty; the run record
shows repeated failed `plan` attempts caused by missing TPM/surface prerequisites. Generate is now
disabled while validation errors exist, with a tooltip naming the error count, so the user fixes
the configuration (visible directly under the stage board) instead of creating a failed attempt.

## Planner header validation summary (analysis 0.1.46)

Added compact **N errors / N warnings** pills to the planner header, with the first four messages
as tooltip. Combined with the Generate guard, the reason generation is blocked is visible without
scrolling to the validation block under the stage board.

## Validation pills jump to the block (analysis 0.1.47)

The header `N errors`/`N warnings` pills are now buttons that smooth-scroll the panel to the
validation block under the stage board (`validationRef.scrollIntoView({block:'center'})`). Tooltip
still lists the first four messages.

## Run blocked by validation errors (analysis 0.1.48)

The new planner Run action now shares Generate’s validation guard: disabled while
`view.validation.errors` is non-empty, with a tooltip naming the error count. This prevents
failed run/plan attempts when prerequisites (TPM, FreeSurfer subject, etc.) are missing.

## Pipeline-card Run/Plan validation guard (analysis 0.1.49)

`PlannerSection` reports its validation counts to `AnalysisBody`; the pipeline card receives them
and now disables **Plan** and **Run/Resume** while validation errors exist, with the error count in
the tooltip. Both run entry points share one guard now.

## Record tab right-edge overflow fix (record 0.1.12)

The Record root had `width:100%` plus 10 px padding without `box-sizing:border-box`, so it rendered
past the right canvas edge. Added global `box-sizing:border-box` for the Record subtree,
`min-width:0/max-width:100%` on root/head/body/sections, 12 px right padding, table
`table-layout:fixed` + wrapping, and `overflow-x:hidden` with `overflow-y:auto`.

## React error #310 fix (analysis 0.1.50)

`validationRef = useRef(null)` had been added after PlannerSection’s early returns
(`if (error)`, `if (!view || !draft)`), so the first render returned before that hook and the
loaded render called it — “Rendered more hooks than during the previous render.” The ref is now
declared in the unconditional hook section; a test pins it before the first early return.

## QC decision modal + interaction smoke (analysis 0.1.51)

QC Accept/Tentative/Reject previously opened an inline composer under the figure, which could be
off-screen (felt like “nothing happened”). It is now a fixed modal with the action/figure header,
reason, standards/confidence, capture, Close/Cancel/Save, and Escape dismissal; a failed
`onDecision` keeps it open with an error instead of closing silently.

Added `scripts/check_analysis_qc.mjs`, a real component interaction smoke: it mounts `QcSection`
with a fake stateful React runtime, clicks **Accept**, asserts the modal opens, clicks **Save**,
asserts the `accept` QC decision payload, and verifies the failure path keeps the composer open.

## Automated test suite + benchmarks (tooling)

Added `scripts/run_test_suite.mjs` (unified units + UI/API smokes + benchmark, JSON report under
`work/test-suite-report.json`) and `scripts/bench_analysis_record.mjs` (autoproc model/argv/stage
plan + record append/query/fold/rebuild/stats, JSON under `work/benchmarks/`). Documented in
`docs/TESTING.md`; full run passed 10/10 steps.

## UI interaction harness + Record smoke (tooling)

Added `scripts/lib/mini_react.mjs` (stateful React stand-in: hooks, effects, re-render, element
tree/button/input lookup) and `scripts/check_record_ui_interaction.mjs` (opens the decision
composer, asserts Save disabled until a target ref, verifies the saved `accept`/`qc` payload, and
verifies a standard departure requires a reason). The suite runner now includes
`ui-record-interaction`; full run passes **11/11** steps.

## Viewer benchmark (tooling)

`bench_analysis_record.mjs` now includes a viewer section: writes a 2,002-frame inspection session
to a temp dir and measures `readSessionFile`, `readInspectionSessions`, plus
`presentationCommand`/`presentationPlan`. Baseline: inspection read ~1.2 ms/session at 2k frames;
presentation command ~0.00 ms. Output includes both analysis/record/viewer groups.

## Record sections interaction smoke (tooling)

Added `scripts/check_record_sections_interaction.mjs`: filters Runs by status and asserts the Host
query + table rows; exercises Inspection **Open in viewer**, **Pause recording**, and **Events**
(bounded frame list). Suite runner now has 12 steps; full run passes.

## Viewer client render smoke (tooling)

Added `scripts/check_viewer_client_render.mjs`: exposes `ViewerBody` via `__test`, mounts it with a
stub bridge state (one image viewport) using the mini-React harness, waits for the async refresh,
and asserts controls render. The process exits deterministically after the assertion so the
bridge polling timers do not keep Node alive. Suite now 13 steps.

## Viewer interaction smoke (tooling)

Extended `check_viewer_client_render.mjs`: after the ViewerBody render assertion, it mounts
`ControlRail` directly (nested component buttons are not visible to the raw harness tree) and
asserts **Pause recording** calls `inspection_pause` with `paused:true`, and **Save/Restore** call
their bridge endpoints. Stub viewer state now includes a layer/grid/crosshair so the rail renders.

## Viewer command bar + restore benchmark (tooling)

`check_viewer_client_render.mjs` now also mounts `CommandBar`, asserts Enter dispatches the typed
line and clears the input, and ArrowUp recalls history. The benchmark adds viewer workspace restore
(`workspace.json` parse; 2.3 KB payload, ~0.00 ms/op at 500×).

## Benchmark regression mode (tooling)

`bench_analysis_record.mjs` now reads the previous baseline, prints per-metric deltas, and supports
`--check` (fails when per-op time exceeds `max(1 ms, 3× baseline)`). The suite runner forwards
`--check` to the benchmark, so `node scripts/run_test_suite.mjs --check` is a full regression gate.

## QC verdict indication (analysis 0.1.52)

After recording a decision there was no local visual confirmation on the figure (only the list at
the bottom). Added per-figure verdict badges (`accepted · time`, `tentative`, `rejected`, or
“not judged yet”) plus a QC summary row with verdict counts, and the QC card subtitle now shows
`N verdict(s)`/`no verdicts`. Matching uses target ref/path so polling refreshes keep the badge.
The QC interaction smoke asserts an existing decision renders as “accepted” and counts in the
summary.

## Planner next-step guide (analysis 0.1.53)

Added a compact **Next step** strip in the planner: Configure → Save → Generate → Run, with the
current step highlighted, a one-line hint, blocker message/count with **Review**, and direct
**Save/Generate/Run/All options** actions. This makes it explicit where to configure and what to
do next. Added `scripts/check_analysis_guide.mjs` interaction smoke (dirty, blockers, ready-to-run,
scriptless states) to the suite.

## Generation failure now blocks Run (analysis 0.1.54)

Generate-script failures come from `ffs_autoproc` semantics that the client-side model cannot fully
predict. A failed generation is now retained (`generateError`): Run is disabled in the header,
guide, and pipeline card, the error appears as a blocker pill and as “Script generation failed: …”
in the validation block, and Run’s tooltip names the blocker. Editing the pipeline clears the
error; a successful generation clears it too. Retry Generate remains available from the header.

## Pipeline workflow consolidation (analysis 0.1.55)

Removed duplicated actions and clarified the path:
- **Planner header is the single action surface**: All options · Save · Generate script · Run/Resume.
- **Generate auto-saves**; Save remains an explicit checkpoint. **Run requires a non-dirty, generated
  script** (Resume appears for failed/stopped runs).
- The **Next step guide** is guidance-only: checklist Configure → Resolve blockers → Generate →
  Run → Review, with the current step highlighted and a single **Review blockers** action; it no
  longer duplicates Save/Generate/Run/All options buttons.
- The **pipeline card** no longer has Plan/Run controls; it only observes status/progress/stages and
  offers Cancel while running.
- Removed the obsolete planner-validation plumbing/state.
Tests updated; `check_analysis_guide.mjs` now asserts the guide has no duplicate action buttons.

## Run observability (analysis 0.1.56)

Hitting Run no longer leaves the run card far below the scroll: Run/Resume auto-scrolls to the
pipeline run card (`#ffa-pipeline-run`) after the run starts, and while running the sticky panel
header shows a compact `running · % · stage` chip plus **Watch** (scroll to run card) and **Cancel**
actions. Generate/Run remain in the planner header; the pipeline card stays observation-only.

## QC blank fix + snapshot/nav smokes (analysis 0.1.57)

The workflow refactor had accidentally removed AnalysisBody’s `recordDecision` callback, so clicking
QC threw `recordDecision is not defined` and the panel did not render. Restored the callback.

Added two automatic UI tests:
- `check_analysis_snapshot_ui.mjs` — renders Data/QC/Results/Cohort/Group/Provenance/Settings/
  Pipeline against the actual live snapshot.
- `check_analysis_sections_nav.mjs` — mounts the full `AnalysisBody`, clicks all 8 rail tabs, and
  fails on any render error/blank content.

The mini-React harness now memoizes `useCallback` (fixing a false render loop) and guards against
render loops. Suite now **16 steps**.

## FFS upstream refresh — new commands (reference 3919968)

Fast-forwarded `reference/fastfuncstuff` from `995b7d2` to upstream `3919968` (46 commits).
Autoproc changes used by the panel:
- **New flags** `-physio` and `-physio_mode {nuisance,clean}` (NORDIC / phase group, now 26 flags).
- **New emitted stage `stage00: physio`** (`ffs_physio`) between NORDIC and slice timing, gated by
  `-physio`; `-glm_ortvec physio` is in the upstream default nuisance set.
- Schema totals are now **174 flags / 12 groups / 6 recipes / 20 stages**; the curated panel
  stage map includes `stage00_physio` (`physio`, `physio_mode`, `tzero`).
- **New CLIs** upstream: `ffs_physio` (cardiac/respiratory regressors from data) and `ffs_group`
  (one/two-sample group tests, 3dttest++). `ffs_group` is not yet wired into the panel's group
  analysis (which still uses 3dMEMA/3dttest++).
Tests updated for the new totals; full suite passes (16/16).

## External real-data inputs (analysis 0.1.58)

Real datasets can now be tested in place:
- `resolveInputPath` allows absolute existing paths for BIDS roots and path flags (anat, TPM,
  FreeSurfer subject, references) in `scanBids`, legacy plan args, and pipeline resolution.
- Outputs (work dir, script path) still resolve inside the project, keeping packages
  self-contained.
- Path picker/browse accepts absolute directories and returns absolute entry paths; Dataset
  and picker show hints.
- README documents the external-data workflow.
Tests: pipeline external-input/output separation and absolute browse smoke.
