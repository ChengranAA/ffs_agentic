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
| Pipeline | run card, stage flow (`stage02` … `stage12`, numbered nodes on a rail), elapsed time, script and log tail |
| Data | artifact table with kind/stage/size, artifact detail with path and display hints, **Load in viewer** |
| QC | QC figures (motion, tSNR, carpet) and the note about CPU-only QC on this Mac |
| Results | REML model summary, contrasts and peak, preview montage, empty cluster-table state |
| Cohort | subject matrix (one row in this fixture), stage dots, variants |
| Group | group analysis card (draft; needs a real cohort) |
| Provenance | settle status, script/log paths, disabled **Export package** |

## Interactions

- **Load in viewer** calls the FFS viewer's authenticated `/ffs` channel with
  `load_paths` and then reveals the viewer tab. It is the only live integration today; the
  rest of the tab reads the fixture snapshot.
- **Refresh** re-fetches `/ffs-analysis/snapshot`.
- The snapshot is polled every 10 s; the fixture's `rev` is its file mtime.

## Current limitations

- **Fixture data only.** The snapshot comes from `fixtures/demo.json`; no compute, no live
  manifest, no settle/export yet. Pipeline/QC/cohort/group actions are displayed but not
  executable.
- **English UI only** (the `zh` locale covers the plugin metadata, not the tab body).
- **Cluster tables, exports, cohort matrices for real cohorts** arrive with M3–M5 in
  [`../../docs/WORKFLOW.md`](../../docs/WORKFLOW.md).

## Files

- `index.js` — Host half: `/ffs-analysis/snapshot`, `/ffs-analysis/asset/<name>`, and the
  `ffs_analysis_snapshot` agent tool.
- `client.js` — Client half: tab registration, header button, sections and styles.
- `fixtures/demo.json` — snapshot fixture (paths resolve against the project root).
- `fixtures/*.png` — QC and result images shown in the tab.
