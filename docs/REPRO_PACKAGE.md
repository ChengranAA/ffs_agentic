# Reproducible analysis package, cohort, and methods

Status: **draft for review** — companion to [WORKFLOW.md](WORKFLOW.md) and [ANALYSIS_UI.md](ANALYSIS_UI.md).

A settled analysis must survive the chat that produced it. The deliverable is one directory
that (a) reruns the analysis — per subject **and** at group level — with **no agent and no
Harness**, and (b) documents every step well enough to write a methods section.

## 1. Guarantees

| # | Guarantee | How |
|---|---|---|
| G1 | **Runs without the agent** | plain bash + python + FFS/AFNI/FSL CLIs; no DSH, no manifest server, no viewer |
| G2 | **Frozen** | each subject's authoritative proc script, design specs, stimuli, argv and decisions are copied in and hashed |
| G3 | **Traceable** | every step maps to a command, an input hash, an output hash, and a methods sentence |
| G4 | **Paper-ready** | `METHODS.md` + `STEPS.md` + `CITATIONS.md`, generated from recorded facts, not from model memory |
| G5 | **Verifiable** | `doctor.sh`, `bash -n`, `--dry-run`, input hashes, cohort completeness, optional output verification |
| G6 | **Portable enough** | `env.sh` records interpreter, FFS/AFNI/FSL/R locations, versions, device; optional `setup.sh` + lock |
| G7 | **Non-uniform by design** | per-subject scripts may differ; the cohort layer validates compatibility instead of assuming sameness |

Non-goal: shipping a container or vendoring the FFS source (license/size). The package
records exactly what it needs and checks it before running.

## 2. Settle → freeze → export

The chat is where decisions are made; the manifest is where they become facts. With a
cohort, settling covers **two levels**: each subject's first-level analysis, and each
group-level analysis.

```
agentic chat ──▶ ffs_settle ──▶ settled revision ──▶ ffs_export ──▶ package/
                 (per-subject + group decisions)       (snapshot)     (immutable)
```

**`ffs_settle`** records:

- per subject: pipeline id, **script sha256**, run/exclusion set, first-level configuration,
  and the `subject.yaml` variant notes (one run, no fieldmap, hand-edited script, …);
- per group analysis: contrast, design, engine, included subjects, covariates, correction
  method and parameters;
- the **decisions** made in conversation, structured:
  `{ id, kind: "exclusion|model|hrf|threshold|contrast|qc-case|group-engine|group-correction|other", value, rationale, at }`;
- optionally: the viewer state and a screenshot set.

After settling, further edits create a new working revision. `ffs_export` always builds
from a **settled** revision (or refuses and asks to re-settle), so an export can never mix
facts from two different states.

**`ffs_export`** builds the directory, validates it, and returns a checklist. Exports are
immutable: re-exporting makes a new timestamped directory, never overwrites the old one.

Manifest fields added at v1 (see [WORKFLOW.md](WORKFLOW.md) §5.1): `decisions[]`,
`settled{}`, `cohort{}`, `groupAnalyses[]`.

## 3. Package layout

```
ffs_analysis_cohort_20261112/
├── README.md                 # what this is, prerequisites, how to run, expected outputs
├── STEPS.md                  # numbered audit trail: purpose, command, inputs, outputs
├── METHODS.md                # paper-ready prose (subject + group), with step markers
├── methods.yaml              # structured facts behind METHODS.md
├── CITATIONS.md              # software citations + placeholders for the user's papers
├── LICENSE
├── env.sh                    # interpreter, PYTHONPATH, device, data root, tool paths
├── doctor.sh                 # python/FFS/AFNI/FSL/R, data, cohort completeness, versions
├── run.sh                    # orchestrator: subjects → group; resume, --jobs, --dry-run
├── cohort.yaml               # included/excluded subjects, groups, covariates file
├── cohort.tsv                # one row per subject: label, group, covariates
├── subjects/
│   └── sub-001/
│       ├── subject.yaml      # what differs here + first-level contrast pointers
│       ├── frozen/
│       │   ├── proc_sub-001.sh   # authoritative preprocessing script
│       │   ├── autoproc.cmd      # exact CLI invocation that produced it
│       │   ├── design.spec
│       │   └── stimuli/
│       └── scripts/
│           ├── 01_preprocess.sh
│           ├── 02_first_level.sh
│           └── 03_contrasts.sh
├── subjects/sub-002/ …       # same shape; contents may differ by subject
├── group/
│   ├── group.yaml            # group analyses: contrast, design, engine, correction
│   ├── 00_cohort.sh          # validate included subjects and required outputs
│   ├── 01_assemble.sh        # collect coef/tstat, grid+mask checks, write inputs.tsv
│   ├── 02_group_stats.sh     # dispatch to the engine named in group.yaml
│   ├── 03_threshold.sh       # dispatch to the correction named in group.yaml
│   ├── 04_tables.sh          # cluster/contrast tables (CSV)
│   ├── 05_figures.sh         # group figures
│   └── engines/
│       ├── 3dMEMA.sh         # AFNI mixed effects (needs R)
│       ├── 3dttest++.sh      # AFNI t-test (+ -randomsign)
│       ├── flame.sh          # FSL FLAME (optional)
│       └── custom.sh         # user script + manifest entry
├── manifest.json             # export id, settled block, cohort, group analyses, hashes
├── checksums.sha256          # frozen inputs + scripts
├── tables/                   # generated: qc.csv, contrasts.csv, clusters.csv, …
├── figures/                  # generated: *.png / *.pdf
└── logs/                     # generated: one log per subject/stage
```

## 4. Scripts

`run.sh` contract:

```bash
./run.sh                          # all included subjects (resume), then group
./run.sh --subjects all           # subjects only
./run.sh --subject sub-007        # one subject
./run.sh --subjects pending       # only subjects with incomplete outputs
./run.sh --group-only             # group analyses from existing outputs
./run.sh --jobs 4                 # bounded parallel subjects (default 4)
./run.sh --analysis g1            # one group analysis by id
./run.sh --exclude sub-009        # drop a subject for this run (recorded in the log)
./run.sh --dry-run                # every command, nothing executed
./run.sh --from 03_qc             # resume at a stage
./run.sh --device cpu             # override the recorded device
./run.sh --verify inputs|strict   # dataset hashes, or produced outputs too
```

Conventions for every script:

- `set -euo pipefail`; non-interactive; non-zero exit on the first real failure;
- idempotent: skip work whose outputs already verify, unless `--force`;
- all environment through `env.sh` with overridable variables (`FFS_PYTHON`,
  `FFS_PYTHONPATH`, `FFS_DEVICE`, `FFS_DATA_ROOT`, `AFNI_DIR`, `FSLDIR`, `FFS_JOBS`);
- logs to `logs/<subject>/<stage>.log` and `logs/group/<analysis>.log`;
- `--dry-run` prints the exact commands (this is what the verification test checks).

Subject runs are independent and bounded-parallel (`--jobs`). The group stages start only
after every included subject passes `00_cohort.sh`; there is no scheduler and no cluster
dependency in v1 (cohorts are expected in the 10–50 subject range).

## 5. Per-subject variability

Subjects are not uniform, so the package never generates one template and assumes it fits.

- **`subjects/<id>/frozen/` is authoritative.** It is the script that actually ran for that
  subject — including hand edits. `run.sh` runs it as-is; it does not regenerate it.
- **`subjects/<id>/subject.yaml` records the variant** the script embodies:

```yaml
subject: sub-001
sessions: [ses-01]
runs: {ses-01: [run-01, run-02]}
tasks: [rest]
assets: {t1w: true, fieldmap: epi, freesurfer: true}
edited: true                    # hand-edited proc script after inspection
notes: "run-02 dropped for motion; re-ran stage10 only"
first_level:
  space: MNI152
  contrasts:
    A>B: { coef: "work/.../stats-reml.nii.gz[Coef]", tstat: "work/.../stats-reml.nii.gz[Tstat]" }
```

- **Cohort validation, not coercion.** `group/00_cohort.sh` checks that every included
  subject has the required contrast files, on the same grid and mask; a mismatch fails with
  the exact subject list and the reason (`grid-mismatch`, `missing-contrast`,
  `missing-output`). No silent downsampling or re-gridding.
- **Methods summarize the variants**, generated from `subject.yaml` rather than invented:
  "One subject had a single run; two lacked field maps; one subject's preprocessing script
  was edited to drop a run after QC."

## 6. Group analyses

`group/group.yaml` is the single source for the group level; one entry per analysis, so
the engine and the correction can differ per analysis (the decision from the design
discussion):

```yaml
analyses:
  - id: g1
    contrast: "A > B"
    design: one-sample            # one-sample | two-sample | covariates | repeated | custom
    engine: 3dMEMA                # 3dMEMA | 3dttest++ | flame | custom
    include: [sub-001, sub-002, …]   # default: cohort.yaml included subjects
    groups: { patients: [...], controls: [...] }   # two-sample only
    covariates: [age, sex]
    correction: { method: cluster, voxel_p: 0.005, cluster_p: 0.05, nn: 2 }
    outputs: { stats: group/g1/stats.nii.gz, clusters: group/g1/clusters.csv }
  - id: g2
    contrast: "A > B"
    design: two-sample
    engine: 3dttest++
    groups: { patients: [...], controls: [...] }
    correction: { method: permutation, n: 5000, randomsign: true }
```

Supported designs:

| design | marshalling | engines |
|---|---|---|
| one-sample | one contrast per subject → group mean vs 0 | 3dMEMA, 3dttest++ |
| two-sample | `-groups A B` (per-subject labels from `cohort.yaml`) | 3dMEMA, 3dttest++, FLAME |
| covariates | `cohort.tsv` columns passed as `-covariates` | 3dMEMA, 3dttest++ |
| repeated-measures | per-subject condition contrast (e.g. `A-B`) carried up as one-sample | 3dMEMA, 3dttest++ |
| custom | a user script + declared inputs/outputs | custom adapter |

3dMEMA limits (documented, not hidden): between-subject ANOVA/ANCOVA only; within-subject
factors are handled by carrying a contrast up; multi-way designs need dummy coding.

**Engine adapter contract** (`group/engines/<engine>.sh`):

```
--analysis <id> --inputs <inputs.tsv> --out <dir> [--dry-run]
→ <out>/stats.nii.gz      normalized group statistic bucket
→ <out>/result.json       engine, design, N, sub-bricks, warnings
→ <out>/log.txt
```

`02_group_stats.sh` reads `engine:` and execs the adapter; an unknown engine fails with
`engine-missing` before any data is read. **Correction adapters** have the same shape
(`cluster`, `permutation`, `fdr`, `none`) and write `clusters.csv` + corrected thresholds
into `result.json`.

AFNI availability is checked by `doctor.sh`: `3dMEMA`/`3dttest++`/`3dClustSim`/`3dFWHMx`
and R for 3dMEMA; FSL only when a `flame` analysis is requested.

## 7. Description files

Three layers, each with one job:

### `STEPS.md` — what ran
Generated from frozen scripts + manifest + `group.yaml`. One numbered block per subject
stage and per group stage:

```
## group/02 group stats (g1)
Purpose  mixed-effects group test of A > B across 28 subjects
Command  group/engines/3dMEMA.sh --analysis g1 --inputs group/g1/inputs.tsv --out group/g1
Inputs   sub-001 Coef/Tstat … (28 rows in group/g1/inputs.tsv)
Outputs  group/g1/stats.nii.gz, group/g1/result.json
```

### `methods.yaml` — the facts
Generated from the settled manifest, then **editable** by the user. Sketch:

```yaml
study: { title: "" }
dataset:
  name: "BIDS-lite fixture"
  root: "/data/bids"
  subjects_total: 32
  subjects_included: 28
  exclusions:
    - { subject: sub-009, reason: "motion (FD > 0.5 in 22%)" }
cohort:
  groups: { patients: 14, controls: 14 }
  covariates: [age, sex]
  variability:
    one_run: [sub-004]
    no_fieldmap: [sub-011, sub-019]
    edited_script: [sub-001]
preprocessing:
  - id: stage02
    tool: ffs_moco
    action: "rigid-body motion correction"
    parameters: { dof: 6, reference: "run-wise mean" }
    source: { script: "subjects/sub-001/frozen/proc_sub-001.sh", stage: "stage02" }
analysis:
  - id: glm
    tool: ffs_reml
    model: "ARMA(1,1) prewhitened GLM"
    hrf: SPMG1
group:
  - id: g1
    contrast: "A > B"
    design: one-sample
    engine: 3dMEMA
    n: 28
    correction: { method: cluster, voxel_p: 0.005, cluster_p: 0.05, nn: 2 }
software:
  - { name: fastfuncstuff, version: "…", commit: "…" }
  - { name: AFNI, version: "…", tools: [3dMEMA, 3dClustSim] }
  - { name: R, version: "4.5.2" }
```

### `METHODS.md` — the prose
Sectioned for a paper, with markers tying each sentence to a fact:

```markdown
### Group-level analysis

Subject-level contrast estimates and their variances were combined in a mixed-effects
model (`3dMEMA`) <!-- step:group/g1 -->. The analysis included 28 of 32 subjects; four
were excluded for excessive motion <!-- step:exclusions -->. Age and sex were included as
covariates <!-- step:covariates -->. Statistical maps were corrected with cluster-size
inference (voxel-wise p < .005; cluster p < .05; NN2) <!-- step:correction -->
```

Sections: Data · Preprocessing · First-level analysis · Group-level analysis ·
Statistical thresholding · Quality control and exclusions · Software. The user (or the
agent) may polish the prose, but `ffs_methods_check` enforces that every **number and tool
name** traces to `methods.yaml`; a sentence that introduces a new number fails the check.

### `CITATIONS.md`
Software citations with versions and URLs, plus clearly marked placeholders for the
user's own references. Only references that exist are emitted — e.g. AFNI (Cox 1996) and
3dMEMA (Chen et al. 2012) are included because the engine is used; anything else is a TODO
marker, not a plausible-looking reference.

## 8. Methods fidelity

| Fact | Source of truth |
|---|---|
| per-subject stages, order, parameters | frozen `proc_sub_*.sh` + autoproc options |
| model, HRF, contrasts | `design.spec` + `ffs_glm`/`ffs_contrast` provenance |
| group design, engine, N, covariates | `group.yaml` + `manifest.groupAnalyses` |
| correction method and parameters | `group.yaml` correction block |
| exclusions and reasons | `cohort.yaml` + manifest `exclusions[]`/`decisions[]` |
| per-subject variability | `subjects/*/subject.yaml` |
| versions, devices | manifest environment + `env.sh` |
| citations | `CITATIONS.md`, user-supplied or real software references only |

- **Styles**: `--style journal` (default), `concise`, `detailed`; one YAML, three
  renderings, facts unchanged.
- **Human edit loop**: edit `methods.yaml` → `./run.sh --only 08_methods` re-renders
  `METHODS.md`.
- **Fidelity check**: `ffs_methods_check` resolves every marker, cross-checks numbers
  against `methods.yaml`, and flags unsourced claims.

## 9. Verification

`ffs_export` runs, and records in `manifest.json`:

1. the settled block exists and every frozen script hash matches;
2. every input has a sha256 and still exists;
3. `bash -n` on every script; `shellcheck` when available;
4. `doctor.sh --check` passes (including AFNI/R/FSL for the engines actually used);
5. **cohort completeness**: every included subject has the required first-level outputs;
6. `run.sh --dry-run` completes and emits subject + group stage commands;
7. `group.yaml` analyses resolve to a known engine and correction adapter;
8. `METHODS.md` markers all resolve.

Heavier acceptance test: export the fixture cohort, copy it to a temp directory, run
`./run.sh` in a clean shell with no Harness state, and compare tables/hashes — **inputs**
strictly, **outputs** with documented tolerance for GPU nondeterminism. The fixture must
contain at least one variant subject (single run, no fieldmap, or edited script) so the
non-uniform path is exercised.

## 10. Tools and UI

| Tool | Purpose |
|---|---|
| `ffs_settle` | freeze per-subject pipelines + group analyses + decisions; returns the settled id |
| `ffs_cohort` | validate/normalize the cohort: included subjects, variants, missing outputs |
| `ffs_group` | create/edit/run a group analysis (design, engine, covariates, correction) |
| `ffs_export` | build the package; returns path, size, checklist, validation summary |
| `ffs_methods` | render `METHODS.md`/`STEPS.md`; lint number provenance |
| `ffs_export_verify` | re-check an exported package (hashes, cohort, dry run) |

UI: the analysis tab gains **Cohort** (subject × stage matrix, include/exclude, variant
badges) and **Group** (analysis cards, engine/correction selectors, group cluster table,
viewer preview) sections. The **Provenance** section's package card now lists cohort and
group checks. See [ANALYSIS_UI.md](ANALYSIS_UI.md).

## 11. Milestones

| Milestone | Ships | Acceptance |
|---|---|---|
| **M3a** | `ffs_settle`, manifest `decisions`/`settled`, `ffs_export` skeleton for one subject (scripts + manifest + STEPS + METHODS draft) | fixture analysis exports; `run.sh --dry-run` passes; methods lint clean |
| **M3b** | figures/tables, citations, verification modes, UI package card | clean-shell rerun reproduces tables/hashes |
| **M4** | cohort packaging: `subjects/`, `cohort.yaml`, `subject.yaml`, cohort validation, bounded-parallel `run.sh`, cohort UI | 3-subject fixture with variants exports and reruns; missing-output and grid-mismatch fail clearly |
| **M5** | group analyses: `group.yaml`, engine adapters (3dMEMA/3dttest++), correction adapters, group methods section, group UI | one-sample and two-group fits on the fixture; cluster and permutation corrections; methods lint clean |
| **M6** | surface/interop, portable lock + `setup.sh`, zip export, optional viewer state | package runs on a second Mac with only the lock installed |

Package generation begins at **M3** (single subject) so the methods text has real numbers;
cohort and group packaging land in **M4/M5** before interop polish. The manifest fields
they need (`decisions`, `settled`, `cohort`, `groupAnalyses`) are added at **M0**.

## 12. Open questions

- **Covariate file format**: `cohort.tsv` with a `subject` column is the default; is a
  `participants.tsv`-style BIDS file enough, or do you need transformation/centering rules
  recorded too?
- **Group output normalization**: one canonical NIfTI bucket + `result.json` per analysis
  (so the UI/report never parse AFNI output formats). Confirm no external consumers need
  raw AFNI output.
- **Engine defaults**: `3dMEMA` for variance-weighted one-sample/two-group, `3dttest++`
  when R is unavailable or permutation is requested. Is that the right default order?
- **Figures in the package**: include by default (regenerable, not screenshots of the UI).
- **Portability depth**: same-machine-with-tools (v1) vs. lock + `setup.sh` (M6) vs. a
  container (later). Default: v1 + optional lock.
- **Language**: English methods prose by default; a second locale is a rendering option,
  not a fact change.
