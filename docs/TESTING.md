# Automated tests and benchmarks

One entry point covers unit tests, UI render/interaction smokes, API smokes, and benchmarks.

```bash
node scripts/run_test_suite.mjs            # full: units + UI/API smokes + benchmark
node scripts/run_test_suite.mjs --quick    # skip the benchmark
node scripts/run_test_suite.mjs --bench    # benchmark only
node scripts/run_test_suite.mjs --no-bench # units + smokes
node scripts/run_test_suite.mjs --check    # fail if the benchmark regresses
```

The runner writes `work/test-suite-report.json` (per-step pass/fail, duration, failure tail) and
exits non-zero on any failure. The benchmark is separate:

```bash
node scripts/bench_analysis_record.mjs     # writes work/benchmarks/analysis-record.json
```

## What is covered

| Layer | Tooling |
|---|---|
| JS unit | `node --test tests/*.mjs` (store, pipeline, commands, UI contracts, hook hygiene, record UI) |
| Python unit | `.venv/bin/python -m unittest discover -s tests` |
| Analysis UI | `check_analysis_client.mjs` render, `check_analysis_qc.mjs` decision interaction, `check_analysis_guide.mjs` guidance, `check_analysis_snapshot_ui.mjs` all sections against the live snapshot, `check_analysis_sections_nav.mjs` rail navigation |
| Record UI | `check_record_client.mjs` render smoke, `check_record_ui_interaction.mjs` decision-composer smoke, `check_record_sections_interaction.mjs` runs-filter/inspection-controls smoke |
| Viewer UI | `check_viewer_client_render.mjs` mounts `ViewerBody` (render), `ControlRail` (pause/save/restore bridge calls), and `CommandBar` (submit + history recall) |
| API | `check_pipeline_api.mjs`, `check_record_api.mjs`, `check_inspection_api.py`, `check_viewer_preferences.mjs` |
| Benchmark | `bench_analysis_record.mjs` — autoproc model load, stagePlan/argv/validation; record append/query/fold/rebuild/stats; viewer inspection-log parsing, presentation command/plan, workspace restore JSON parse. Prints deltas vs the previous run; `--check` fails when a per-op metric exceeds max(1 ms, 3× baseline) |

## Interaction smoke pattern

`check_analysis_qc.mjs` contains a small stateful React stand-in (hooks, render, effects). It
mounts an internal panel component (exposed as `__test` on the client module), finds buttons in
the returned tree, invokes their handlers, re-renders on state setters, and asserts what the user
would see. Use it as the template for new UI interaction tests instead of relying on manual
click-through.

## Latest run

Full suite: **16/16 steps pass** (unit-js, unit-python, 3 UI, 4 API, benchmark), recorded in
`work/test-suite-report.json`. Benchmark baseline (analysis, record, viewer) is stored in
`work/benchmarks/analysis-record.json`.
