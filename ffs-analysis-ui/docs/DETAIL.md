# FFS analysis tab

A right-sidebar tab that inspects one FFS analysis in the Harness window. It is the UI-first
milestone of the analysis suite: the layout and interactions are real, the data is a fixture
snapshot built from the ds005165 run documented in
[`../../docs/REAL_DATA_TEST.md`](../../docs/REAL_DATA_TEST.md).

## Open it

- Click **Analysis** in the Session header, or pick **FFS analysis** from the right sidebar's
  tab guide. It sits next to the **FFS viewer** tab.
- The tab is session-scoped but reads the project snapshot from the Host half, so it can stay
  open while the viewer tab shows the images.

## Sections

| Section | Shows |
|---|---|
| Pipeline | run card, stage flow (`stage02` … `stage12`, numbered nodes on a rail), elapsed time, script and log tail, **Plan pipeline / Re-plan** |
| Data | artifact table with kind/stage/size, artifact detail with path and display hints, **Load in viewer** |
| QC | QC figures (motion, tSNR, carpet) and the note about CPU-only QC on this Mac |
| Results | REML model summary, contrasts and peak, preview montage, empty cluster-table state |
| Cohort | subject matrix (one row in this fixture), stage dots, variants |
| Group | group analysis card (draft; needs a real cohort) |
| Provenance | settle status, script/log paths, disabled **Export package** |

## Interactions

- **Plan pipeline / Re-plan** posts to `/ffs-analysis/plan`, which runs `ffs_autoproc`
  (script + design specs only, no execution) and writes `work/ffs-analysis-project.json`.
- **Run** posts to `/ffs-analysis/run`: the generated script runs as one managed child
  process, stdout/stderr stream into the script log, and the snapshot reports status,
  current stage, percent and the log tail. **Cancel** signals the process group.
  Run state lives in `work/ffs-analysis-run.json`.
- **Load in viewer** calls the FFS viewer's authenticated `/ffs` channel with
  `load_paths` and then reveals the viewer tab.
- **Refresh** re-fetches `/ffs-analysis/snapshot`; the snapshot is polled every 10 s.

## Live vs fixture

- **Fixture** (`source: "fixture"`): the rich ds005165 demo from `fixtures/demo.json` —
  useful when no plan exists yet.
- **Live** (`source: "live"`): after a plan, built from the real script/log/work dir. The
  header shows a `live`/`fixture` tag.
- **Execution is a plain child process** for this milestone (moving it under `ctx.jobs` is
  next); there is no QC/GLM result extraction yet (M3), and settle/export is still open.
- A cancelled run leaves partial outputs; the script is resumable, so Run again continues.
- `-no_qc` is the default plan on this Mac: QC must run on CPU and is not part of this run.
- **English UI only** (the `zh` locale covers the plugin metadata, not the tab body).
- **Cluster tables, exports, cohort matrices for real cohorts** arrive with M3–M5 in
  [`../../docs/WORKFLOW.md`](../../docs/WORKFLOW.md).

## Files

- `index.js` — Host half: `/ffs-analysis/snapshot`, `/ffs-analysis/asset/<name>`, and the
  `ffs_analysis_snapshot` agent tool.
- `client.js` — Client half: tab registration, header button, sections and styles.
- `fixtures/demo.json` — snapshot fixture (paths resolve against the project root).
- `fixtures/*.png` — QC and result images shown in the tab.
