# Philosophy conformance map

Re-audited **2026-11-13**, against [PHILOSOPHY.md](PHILOSOPHY.md), after the record layer
(R0–R5) and the analysis panel (EP0–EP3). This is a measurement, not a wish list: every status
below names the file, test or artifact that justifies it, or the concrete residual gap.

Status vocabulary:

- **met** — the mechanism exists, is wired into the work, and evidence can be pointed at.
- **partial** — a named part of the section exists; a named part does not.
- **absent** — no mechanism at all; nothing to audit yet.

## Summary

| Charter section | Status | Short version |
|---|---|---|
| Purpose / increase human capability | **met** | Reproducibility + judgment records + per-stage/QC/artifact why-and-failure explanations |
| Core philosophy (project is truth, shared state) | **met** | Project, settled, viewer and record files are the truth; exploration trace is durable |
| Preserve freedom of composition | **met** | Escape hatch, frozen script commands and imported manual scripts (hash+log+promote) are recorded with actors |
| Complete and honest analysis record | **met** | Inputs/outputs hashed, actors/attempts/verdicts recorded, run log shipped, provenance edges explicit |
| QC as measurement and judgment | **met** | Figures + accept/tentative/reject decisions with rationale/confidence/actor and visual evidence |
| Record how inspection happens | **met** | Durable per-session JSONL with semantics, captures, marks, state hash, seq-0 baseline |
| Learn work habits as preferences | **met** | Deterministic evidence shards, policy, statuses, confidence, lifecycle |
| Algorithms vs LLM split | **met** | Python feature/profile math; the agent can only interpret/request confirmation |
| Bounded storage, meaningful deletion | **met** | Tiers, tombstones, dry-run diffs, exact subtraction, confirmation retention |
| Preference precedence | **met** | Six-level `resolve()` with audit and `preferencesUsed` in the package |
| Expand competence without constraining expertise | **met** | Escape hatches + teaching + taxonomy + policy gates on plan/run/settle + reasoned departures |
| Plugin and interface design | **met** | Tools, tabs, stable ids, provenance, record review, preference/deletion UI, policy editor |
| Package for humans and agents | **met** | Record subtree, decisions, preferences, cited inspection slices, METHODS/STEPS sections, checksums |

Counts: **met 13, partial 0, absent 0** (was met 1, partial 8, absent 4).

## Evidence map

| Slice | Implementation | Tests / smoke | Status |
|---|---|---|---|
| Run attempts, actors, logs | `ffs-analysis-ui/index.js` (`run.started/ended`, `recordStarted/Ended`), `shared/record/store.js` | `tests/test_record_store.mjs`, `scripts/check_pipeline_api.mjs` | met |
| Decision records | `recordDecision`, `POST /ffs-analysis/decisions`, ledger mirrors | `check_pipeline_api.mjs` (decisions + revisions + settle gate) | met |
| Durable inspection | `python/ffsviewer/inspection.py`, sidecar wiring, `shared/record/inspection.js` | `tests/test_inspection_log.py`, `check_inspection_api.py` | met |
| Inspection retention | `scripts/compact_inspection.py` | `tests/test_inspection_compaction.py` | met |
| Preference features/profile | `python/ffsrecord/features.py`, `profile.py`, `policy.py` | `tests/test_preferences.py` | met |
| Preference precedence | `python/ffsrecord/precedence.py`, analysis `resolvePreferences` | precedence tests; `check_pipeline_api.mjs` (`preferencesUsed`) | met |
| Preference lifecycle | `python/ffsrecord/lifecycle.py`, record routes, `ffs_preference_confirm` | lifecycle tests; `check_record_api.mjs` (user/agent split) | met |
| Bounded deletion | `python/ffsrecord/deletion.py`, sidecar deletion queue | `tests/test_deletion.py`, `check_record_api.mjs`, `check_inspection_api.py` | met |
| Package record subtree | `writeRecordSubtree` in `ffs-analysis-ui/index.js` | `check_pipeline_api.mjs` (`record/`, manifest, checksums) | met |
| Record UI (tab) | — | — | **not built** |
| Run log shipped in package | export copies `settled.project.log` to `logs/run.log` | `check_pipeline_api.mjs` | met |
| Input checksums | `collectInputChecksums` → `inputs.json` | `check_pipeline_api.mjs` | met |

## Section detail

### Purpose — increase human capability

**Met:** reproducibility is produced by doing the work: plan → generated `ffs_autoproc`
script → run attempts in the ledger → artifacts/QC → decisions → settled record → package.
A reader can now follow *what ran* (`STEPS.md`, `record/runs/`), *what was judged*
(`decisions.json`, `record/decisions/`), *how it was inspected* (cited `record/inspection/`
sessions with baseline + state hash) and *what habits informed it* (`preferences.json`).

The explanation layer is present: every autoproc stage has a **why** and **what failure looks
like** text (`ffs-analysis-ui/lib/explain.js`), shown in the stage inspector and exported as
`tables/checks.csv` + METHODS `## What the checks look for`; QC figures get the same treatment;
every artifact carries a status and why-note. **Residual:** the teaching text is curated rather
than adaptive, so it cannot explain a *specific* anomaly.

### Core philosophy — project is truth, shared state

**Met.** The project state (`work/ffs-analysis-project.json`), pipeline, settled record,
viewer state (`viewer.ffs` + `workspace.json`) and record files (`work/ffs-record/`,
`.ffs-viewer/inspection/`) are plain files both halves read. The record layer turned the
previously in-memory exploration trace into an append-only session log
(`Record how inspection happens`), and decisions/exclusions are mirrored into it. Exported
packages carry the record subtree, so the truth travels with the analysis.

### Preserve freedom of composition

**Met.** The expert paths remain: direct `ffs_viewer_command`, `ffs_tool_run` with full
argv/env/expect, editable generated scripts, planner flags, and command steps. Every executed
attempt is a ledger record with an actor, and a manually edited script can be **imported**
(`ffs_analysis_import_script` / `POST /ffs-analysis/import-script`): it is hashed, its log tail
captured, and with `promote: true` it becomes a frozen `scriptPath` command step so a later run
reproduces it. Bespoke work therefore has a recorded, reproducible home.

**Residual:** interactive shell history is not captured automatically, but it can be imported
explicitly (`ffs_analysis_import_history`, zsh/bash, credential-looking lines skipped); saved
scripts can be imported and promoted to frozen commands. Automatic live capture is out of
scope by design.

### Complete and honest analysis record

| Required | Status | Evidence / gap |
|---|---|---|
| Input references + checksums | met | `inputs.json` records sha256/size for the subject's BIDS files; `manifest.inputs` carries the file hash; outputs stay in `settled.artifacts` |
| Exact script/command/version | met | `scriptSha256`, frozen copy, `code/` in package, `record/runs` attempt script hash |
| Parameters and configuration | met | `settled.project`, `pipeline.json`, `commands.json`, `manifest.json` |
| Dependencies, software, environment | met | `lock.json`, `env.sh`, `doctor.sh`, `software{}` |
| Initiator (person/agent/process) | met | ledger actor (`user` vs `agent` + tool/agent path/session), decision actors, preference action actors |
| Start/end/status/logs/errors/retries/interruptions | met | every attempt is a separate ledger record with status/duration/error; resume creates a new attempt; the run log ships at `logs/run.log` with `manifest.logs.run` |
| Output refs + relationship to inputs | met | `provenance.json` gives every output an explicit input/script/run edge; manifest carries `provenance` |
| Inspected / accepted / rejected / superseded / undecided | met | `decisions[]` + `record/decisions/`, supersede links, settle acknowledgement, QC composer |
| Planned vs executed vs successful vs inspected vs accepted | met | pipeline plan, ledger attempts, decisions, settle gate and manifest labels |
| Never rewrite history | met | ledger is append-only, decision revisions/supersedes are additive, `.ffs` surface pruning now leaves a `prune` frame in the inspection log, and the 200-record provenance cap was removed |

### QC as measurement and judgment

**Met.** FFS writes per-step QC metrics/figures; the analysis tab renders them and records
**accept / tentative / reject** with optional rationale, confidence, actor, target hash and an
optional viewer capture (`{inspection, seq, stateSha256, coordinates, display}`). Open
tentative/undecided decisions gate settle with an explicit acknowledgement, which is itself
recorded. The package ships the decisions and the cited inspection slices.

### Record how inspection happens

**Met.** `python/ffsviewer/inspection.py` writes `<state-dir>/inspection/<sessionId>.jsonl`:
`session.start/baseline/context/end/paused/resumed`, every accepted `event` (line, semantic
projection, view/layer, state hash), `capture`, `mark|measure|correct`, `save`, `prune`.
Sessions carry a seq-0 `.start.ffs` baseline and are exempt from surface pruning. Captures feed
decision evidence; the record bundle indexes sessions and can fold marks/captures; compaction
(tombstoned) and sidecar-executed deletion are implemented.

**Residual:** no dwell/revisit statistics (the R3 feature shard stays coarse by design).

### Learn work habits as preferences

**Met.** `python/ffsrecord` implements: inspection-session feature shards (UI-only behavior,
behavioral weight 0 for restored/agent-heavy sessions), `policy.yaml`, deterministic
aggregation with recency weights/support/contradiction, statuses `observed → candidate →
established`, confidence bands, scientific kinds that stay candidate until explicit user
confirmation, lifecycle events (establish/retire/edit/delete/request), evidence deletion with
confirmation retention, and a read-only Record surface exposed as tools/routes/CLI. The
package ships the profile, policy, evidence, events and tombstones.

**Residual:** no Record-tab UI yet; presentation defaults are not applied to the viewer.

### Algorithms vs LLM split

**Met.** `features.py`/`profile.py`/`precedence.py`/`deletion.py` are pure Python with no LLM;
`python -m ffsrecord.cli profile` reproduces the profile offline. The agent can call
`ffs_preference_confirm` / `ffs_preference_delete` (dry-run) but cannot promote, retire or
apply deletion; the lifecycle module refuses non-user actors.

**Residual:** the optional LLM *interpretation* proposal (`ffs_preference_propose`) is not
built; it is not needed for conformance.

### Bounded storage and meaningful deletion

**Met.** Retention tiers: raw sessions → compact records + tombstones
(`scripts/compact_inspection.py`, idempotent); deletion pipeline supports dry-run diffs, exact
subtraction (add → delete → add equals recompute-from-remaining), content-free tombstones,
cited-decision marking, raw-file queue applied by the sidecar, preference retirement (never
removal), and confirmation-supported preferences survive evidence deletion with rewritten
provenance. Profile versions are kept.

**Residual:** compaction runs automatically on sidecar shutdown (configurable, and the CLI is
still available), but there is no mid-session byte-budget enforcement.

### Preference precedence

**Met.** `precedence.py` implements instruction → constraint → task/modality → cross-project →
candidate → defaults with an `applied/overriddenBy` audit; project decisions can supply
constraints; `GET /ffs-analysis/preferences` resolves a context and the generated plan records
`preferencesUsed {id, version, rung}`; settle/manifest carry it. Tests cover all six levels.

**Residual:** presentation preferences apply automatically once per viewer session when the
dataset opens (opt-out config), with an on-demand tool/Record-tab Apply too; there is no
per-context presentation switching while the viewer is already open.

### Expand competence without constraining expertise

**Met.** Expert paths are not blocked: direct commands, CLI, editable scripts and full
parameters remain. The record layer distinguishes `kind: constraint | standard | preference`
and labels scientific kinds; the decision composer records a **standard** departure only with
a reason and refuses a **constraint** override (`409 decision-constraint`).

Operation gates are policy-driven (`python/ffsrecord/gates.py`) and evaluated in **plan
generation** (BIDS subject + dataset manifest), **run start** (subject, no active run, frozen
script) and **settle** (run completed; QC-review standard requires a recorded departure or
acknowledgement). `GET /ffs-analysis/constraints` exposes the evaluation. The policy is
readable **and editable** in the Record tab, validated by Python before writing `policy.yaml`.
Every stage and QC check carries why/failure teaching (panel + `tables/checks.csv`).

**Residual (cross-ref Preserve composition):** arbitrary shell history outside Harness is not
captured; recorded paths (commands, frozen script commands, tool runs) are covered.

### Plugin and interface design

**Met.** Host/Client halves exist over shared files; tools are schematized with `presentCall`
cards; the record bundle adds `ffs_record_query`, `ffs_record_rebuild`,
`ffs_preference_confirm`, `ffs_preference_delete` (dry-run) and `ffs_viewer_inspection`;
routes serve snapshot/runs/decisions/preferences/inspection; ids are stable; agent actions are
ledger records with actors and outcomes.

The Record tab (attempts, decisions, inspection with replay, preferences lifecycle, deletion,
policy editor) and the viewer recording indicator/pause control are built. **Residual:** the
record bundle is not yet installed in the profile and the live tabs have not been exercised.

### Package for humans and agents

**Met.** `exports/ffs_analysis_*` includes README/METHODS/STEPS/CITATIONS/methods.yaml/
manifest/checksums, frozen scripts/design/stimuli, code, lock/env/doctor/setup/run/verify,
tables/figures/viewer/surface, and the new `record/` subtree (runs, decisions, preferences,
tombstones, cited inspection sessions + baselines). Manifest carries `record`, `preferences`,
`preferencesUsed`, `decisionGate`; checksums cover everything (smoke verifies 770 files).

Input checksums (`inputs.json`), the run log (`logs/run.log`), explicit artifact statuses
(`manifest.artifacts[].status`, `tables/artifacts.csv`) and per-output provenance edges
(`provenance.json`) ship too, and `verify.sh` cross-checks the record views against the shipped
events; the remaining gap is live verification of the docked UI.

## What this implies for priority

The originally absent four (preferences, deterministic split, bounded deletion, precedence) are
built and tested. The remaining gaps are product surfaces and two record fields:

1. **Live verification** — install `@local/ffs-record` and exercise the docked Record/analysis
   tabs, inline inspection replay and policy editor in a real browser.
2. **Interactive shell history** — one-off commands outside a saved script are still not
   captured; imported scripts cover the reproducible composition unit.
3. **Long-term scale** — run the record layer against a large multi-session project to exercise
   sharding, retention and profile recency at scale.

None of these require changing the ledger/profile schemas.

## Reproducing this audit

```bash
node --test tests/test_pipeline.mjs tests/test_commands.mjs tests/test_record_store.mjs \
  tests/test_inspection_index.mjs tests/test_preferences_index.mjs          # 27 JS tests
.venv/bin/python -m unittest discover -s tests                              # 43 Python tests
node scripts/check_record_api.mjs                                           # store/records/preferences/deletion
node scripts/check_pipeline_api.mjs                                         # panel + package + record subtree
.venv/bin/python scripts/check_inspection_api.py                            # sidecar log + auto profile + queue
.venv/bin/python -m ffsrecord.cli profile --project . --json                # deterministic profile
```

`scan` outputs and fixtures are deterministic; smoke scripts back up and restore project state.
