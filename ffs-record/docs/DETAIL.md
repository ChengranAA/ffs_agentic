# FFS record

Reads the append-only analysis record that the FFS analysis plugin writes while work happens.

## What it provides

- **Attempt ledger query** (`ffs_record_query`): runs folded from `run.started` / `run.ended`
  events with mode, attempt number, actor (`user`, `agent`, `scheduler`, `system`, `unknown`),
  status, duration, error and post-processing command results.
- **Rebuild** (`ffs_record_rebuild`): rebuilds the derived index from the JSONL shards and
  imports the pre-ledger `ffs-analysis-run.json`, `ffs-tool-runs.json` and `ffs-replays.json`
  once. Shards remain the truth; a torn trailing line is reported, never repaired silently.
- **Route**: `GET /ffs-record/snapshot`, `GET /ffs-record/runs`, `GET /ffs-record/family`,
  `POST /ffs-record/rebuild`, all behind the Harness connection admission check.

## Where the data lives

`work/ffs-record/runs/<YYYY-MM>.jsonl` with a common envelope (`schema`, `type`, `id`, `at`,
`actor`, `project`, `links`, `payload`). One shard per month; appends are single lines, reads
skip a torn tail.

## Limits (R0)

- This bundle reads the ledger; the analysis plugin is the writer. It must be installed in
  the same checkout so the shared `shared/record/store.js` module resolves.
- Decisions/inspection/preferences slices are not implemented yet (design: `docs/RECORD.md`).
- No Client half or tab in R0; the tools and route are the interface.
