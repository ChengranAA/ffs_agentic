# FFS Record layer — design

Status: **design v0, 2026-11-13. R0, R1, R2, R3, R4 and R5 are built** (append-only run ledger,
actors, decision records with revisions/supersedes, the settle acknowledgement gate, legacy
import, query/rebuild; durable inspection sessions with semantics, state hashes, captures,
marks, seq-0 baselines, retention/compaction and decision evidence; a deterministic preference
profile with policy, statuses, precedence resolution, CLI, readers, package inclusion,
planner-context resolution, `preferencesUsed` audit, sidecar auto-recompute, the user-only
lifecycle with an agent request-only path, and bounded deletion with dry-run diffs, tombstones,
confirmation retention and a sidecar-executed raw-deletion queue) using a shared file-based
store module rather than the two Cordis service rows of §2.1; the schema and writer/reader
split are unchanged; packages carry the record subtree, cited inspection slices and checksums.
The Record-tab Client surface (attempts, decisions, inspection, preferences and deletion), the
viewer recording indicator/pause control, automatic shutdown compaction, packaged input
checksums + run logs, inline inspection replay and on-demand presentation defaults are built;
the bundle is installed and both halves are live, while browser click-through remains open. See
[IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for evidence.
Owner decisions taken: all four conformance slices designed together; a new
`@local/ffs-record` bundle owns the layer; inspection recording is on by default with a
visible pause; settle/export warns and requires a recorded acknowledgement for open
consequential decisions.

This document turns the charter in [PHILOSOPHY.md](PHILOSOPHY.md) into a concrete subsystem.
It is measured against [PHILOSOPHY_CONFORMANCE.md](PHILOSOPHY_CONFORMANCE.md), which lists
four absent slices: a preference subsystem, the deterministic statistics layer, bounded
storage with meaningful deletion, and preference precedence — plus the judgment/inspection
gaps embedded in the eight "partial" sections.

The design is deliberately a *record* layer, not a second pipeline. It adds no computation:
it observes what the viewer, the compute plugin and the user already do, and it stores what
the charter says must not live only in chat.

---

## 1. Scope

### 1.1 What this layer must make true

| Charter requirement | Mechanism in this design |
|---|---|
| Project is the source of truth, not chat | every row/decision/preference is a file under `work/ffs-record/` or `.ffs-viewer/inspection/`; the package ships them |
| Shared state for humans and agents | one Host service + one authenticated route + tools; no state duplicated in the Client |
| Reproducibility emerges from the work | run attempts are appended as they happen, not reconstructed at settle |
| Custom scripts are first-class | run records carry argv, script sha256, inputs, env, log sha256 for every mode, not only plan scripts |
| Never rewrite history | append-only JSONL with revisions; no ring buffer, no slice(-199), no silent pruning |
| Planned ≠ executed ≠ successful ≠ inspected ≠ accepted | separate event families (`run.*`, `decision.*`, `inspection.*`) and an explicit decision status vocabulary |
| QC as measurement **and** judgment | decision records cite metric values, viewer evidence, rationale, confidence and actor |
| Record how inspection happens | durable per-session inspection JSONL with semantic coordinates, display state, annotations, timings |
| Preferences: 12-field record, 5 states | preference events + deterministic profile + policy |
| Algorithms decide, LLM interprets | Python statistics layer (`python/ffsrecord/`) computes; the LLM only proposes and explains |
| Bounded storage, meaningful deletion | explicit tiers, tombstones, additive per-session shards, recompute-after-delete |
| Preference precedence | `resolve()` with the charter's six-level order, recorded on every application |
| Package for humans and agents | `record/` subtree in the export + manifest keys + METHODS/STEPS sections |

### 1.2 Non-goals (this round)

- No new rendering, no new preprocessing/statistics engines.
- No cross-project application of *scientific* preferences. Scope values are stored from v0,
  but only session/project/task/modality scopes are resolved; cross-project stays `inactive`
  until the simple layer has been exhausted (the conformance audit's own deferral).
- No clustering, sequence mining, drift models or automatic promotion of behavior. v0 is
  counts, dwell, fingerprints, n-gram repeats, recency weighting and policy arithmetic.
- No change to the 114-command FFS vocabulary. Marks/annotations are viewer RPC methods, not
  viewer commands, so `docs/PARITY.md` and the command reference do not move.
- No migration of the existing plugins to `ctx.fs`; existing writers use `node:fs` and the
  record layer uses the same helper style with atomic writes. That migration is a separate
  task (see §12, risk K4).

### 1.3 Residual gaps this design does not close

Two conformance gaps sit outside the record layer and need their own design:

- **Teaching / explanation content.** The charter asks less experienced users to see *why* a
  step or QC check matters and what common failures look like. The record layer stores the
  evidence those explanations cite, but the copy, failure gallery and per-check guidance are
  an analysis-UI content design. The decision composer links to them when they land; nothing
  here blocks them.
- **Guided defaults and task-specific recipe flows.** Those are execution concerns of the
  analysis plugin, not record concerns.

Hard constraints, standards and preferences *are* handled here (§7.8): they are fields and
override rules on the same records, not a separate subsystem.

---

## 2. Where the layer lives

### 2.1 The bundle

```
<repo root>
  ffs-record/                 # new linked bundle (sibling of the two existing bundles)
    package.json              @local/ffs-record, bundle patch, "./service" export
    cordis.patch.yml          two rows: service class + apply() plugin
    index.js                  apply(ctx, config): tools + authenticated /ffs-record route
    service.js                default-export class FfsRecord (only writer of work/ffs-record/)
    client.js                 "Record" right-sidebar tab (runs, decisions, inspection, preferences)
    lib/
      store.js                append-only store, shards, atomic writes, query, rebuild
      actor.js                actor resolution from ToolRunContext / peer / sidecar origin
      decisions.js            record/revise/fold/status logic
      inspection.js           session discovery, bounded reads, mark/annotation records
      preferences.js          lifecycle, precedence, policy loading, deletion orchestration
      migrate.js              one-shot import of legacy files
      package.js              record/ subtree builder for the analysis export
    docs/DETAIL.md            plugin-manager detail page (bundle checklist)
    locale/en.json, locale/zh.json, icon.svg
  python/ffsrecord/           # repo root: deterministic statistics layer
    __init__.py, features.py, profile.py, delete.py, cli.py
  python/ffsviewer/inspection.py  # edit existing sidecar: event sink, mark/capture/prune RPC
  tests/
    test_ffsrecord_store.mjs      node --test, Host store
    test_ffsrecord_features.py    python unittest, statistics + deletion
    test_inspection_parity.py     python unittest, classify.py <-> semantics table
```

Two patch rows are required because a package-root plugin may not mix `apply(ctx, config)`
with a service-class default export (the DSH `host-plugin` reference §Host plugin export
forms states the rule; [WORKFLOW.md](WORKFLOW.md) §4 already planned the viewer's service
row this way):

```yaml
# ffs-record/cordis.patch.yml
- insert:
    - id: ffs-record-service
      name: '@local/ffs-record/service'
      config: {}
    - id: ffs-record
      name: '@local/ffs-record'
      config:
        retention: { rawDays: 30, rawBytes: 67108864, keepSessions: 20 }
```

`Config` supplies bootstrap defaults only: on first run the service writes them into
`preferences/policy.yaml`, which is the single authoritative source thereafter (edited in the
Record tab's Settings section).

`package.json` therefore exports `.` → `index.js`, `./service` → `service.js`,
`./client` → `client.js`, `./locale/*.json` and `./icon`, and declares
`dsh.client {platform:"web", immediately:true}` — the same manifest shape as the two existing
bundles, without which the Record tab never loads. The bundle must pass the plugin-details
checklist (`locale` meta.title/description/detail, icon, `files`) because it is installed as
a first-class bundle.

The service row is inserted before the `apply` row so `index.js` can declare
`export const inject = ['tools', 'ffsRecord']` and Cordis holds the `apply` row inactive
until the service is provided. If activation order ever reverses, the `apply` row still
mounts its route and tools and resolves the service lazily through `ctx.get('ffsRecord')`
at call time, reporting `record-service-unavailable` instead of throwing.

### 2.2 Authorities and writers — one writer per file

| File / tree | Writer | Readers |
|---|---|---|
| `work/ffs-record/{runs,decisions,preferences}/*.jsonl` | `ffsRecord` service | service, route, tools, export |
| `work/ffs-record/preferences/profile.json`, `versions/*`, `evidence/*` | `python/ffsrecord` (spawned by service) | service, route, export |
| `.ffs-viewer/inspection/<sessionId>.jsonl`, `index.json` | viewer **sidecar** | record service (read-only), export |
| `.ffs-viewer/{viewer,display,analysis}.ffs`, `session.json` | viewer sidecar | record service (state hashes only) |
| `work/ffs-analysis-{project,run,settled}.json` | analysis plugin (unchanged) | record service reads for import/linking |
| `exports/<pkg>/record/**` | analysis export (calls `ffsRecord.buildPackageBundle`) | verify.sh |

The viewer keeps sole ownership of display state; the analysis plugin keeps sole ownership
of pipeline state. The record layer never mutates either, it only appends observations and
reads for attribution. This preserves the three-authority model of [WORKFLOW.md](WORKFLOW.md)
§3.

### 2.3 Cross-plugin wiring

The record bundle is useful alone but integrated when its Cordis service is present:

- **analysis plugin** (`ffs-analysis-ui`): optional-injects `ffsRecord` and calls
  `startAttempt / endAttempt / note` around plan, run, resume, cancel, replay, tool-run and
  group runs; calls `settleGate(project)` before settle/export; calls
  `buildPackageBundle(selection)` during export.
- **viewer plugin** (`ffs-harness-viewer`): optional-injects `ffsRecord` only for actor
  attribution in tool calls; the inspection events themselves are written by the sidecar.
  It also gains a `ffsViewer` service row (already planned in [WORKFLOW.md](WORKFLOW.md) §4)
  with `capture()` → `{inspectionSessionId, seq, stateSha256, coordinates, display, figure}`
  so a decision can cite the exact viewer state even when the analysis tab is the one
  composing it.
- **record → viewer** is therefore one service call, not a second sidecar client. If
  `ffsViewer` is absent, a decision records visual evidence as `unavailable` with a reason
  instead of inventing coordinates.

Optional integration is mandatory: every integration point must degrade to the pre-record
behavior with a visible "record service unavailable" notice and never throw. Integrations
attach reactively — `ctx.inject(['ffsRecord'], sub => …)` runs when the service becomes
available and disposes when it goes away — so bundle toggling and activation order are safe.
A one-shot `ctx.get()` is not used because it silently misses a later activation; the exact
Cordis reactivity must be re-verified against the installed version at R0. Each integration
registers inside `ctx.effect` so a plugin unload disposes its listeners.

The service boundary is not a security boundary between plugins: in-process callers are
trusted. User-only transitions therefore take a `UserGrant` token minted only inside the
route module's closure; the tool layer cannot construct one and the browser cannot forge
one. A caller-supplied actor that contradicts the grant or authority rules is rejected
(`authority-mismatch`), never coerced.

---

## 3. Storage model

### 3.1 Layout

```
work/ffs-record/
  schema.json                       {schema:"ffs-record-index/1", storeId, versions:{...}}
  project.json                      project identity: root (relative "."), bids root, datasets
  runs/2026-11.jsonl                sharded by month, rotated at 8 MiB → 2026-11.0002.jsonl
  decisions/
    sub-001.jsonl                   one file per subject scope
    _project.jsonl                  cohort/group/export-level decisions
  preferences/
    profile.json                    derived current view (NOT authoritative alone)
    versions/profile-0001.json      frozen profile per recomputation
    evidence/<sessionId>.json       additive per-session features (input to statistics)
    events.jsonl                    lifecycle events (observed/candidate/…/retired/edited/deleted)
    policy.yaml                     thresholds + retention, project-editable
    tombstones.jsonl                deletion records without deleted content
  index/                            derived, rebuildable: runs.idx.json, sessions.idx.json
  migrations/                       one-shot import receipts
```

Layout rules:

1. **Append-only truth, derived views rebuildable.** `runs/`, `decisions/`,
   `preferences/events.jsonl`, `preferences/evidence/`, `preferences/versions/` and
   `tombstones.jsonl` are truth (profile versions are the charter's kept lineage). Only
   `preferences/profile.json` (the current view) and the indexes are derived and can be
   deleted and rebuilt by `ffs_record_rebuild`. `work/ffs-analysis-run.json` is not part of
   the store: the analysis plugin remains its only writer and the record layer only reads it
   for import and linking.
2. **Atomic writes.** Non-JSONL files: write `path.tmp`, `fsync`, rename. JSONL appends:
   one `appendFileSync` of a single line ≤ 64 KiB, after validating the envelope; no rewrite
   of existing bytes, ever.
3. **Sharding, not truncation.** Runs rotate at 8 MiB or month end. Decisions rotate per
   subject at 4 MiB. The legacy `slice(-199)` pattern is banned from the bundle (see §11).
4. **Relative references.** Every path in a record is project-root-relative with `/`
   separators, and every referenced artifact carries `sha256` + `bytes` when it exists.
   Export copies therefore do not need path rewriting.
5. **Clock discipline.** All record timestamps are UTC ISO-8601 with milliseconds
   (`2026-11-13T16:20:11.123Z`). The viewer sidecar's float-epoch `ts` and ISO-string `ts`
   (server.py:354 vs persist.py:236) are normalized at the boundary, not stored raw. Order is
   `at`, then file offset — never wall-clock uniqueness.
6. **Bounded files.** No file is unbounded: runs/decisions rotate, inspection sessions have
   a tier policy (§6.4), profiles are versioned snapshots. `ffs_record_rebuild` is the
   recovery path after manual edits, and it reports disagreements rather than silently
   choosing.
7. **Torn-line tolerance.** One append is one `O_APPEND` write of a line capped at 32 KiB
   (rationale text ≤ 8 KiB; long evidence arrays split into their own records). Readers parse
   line by line, ignore a trailing partial line, and report `corruptTail` in the snapshot;
   `ffs_record_rebuild` quarantines it under `index/corrupt/` instead of silently repairing.
   `fsync` checkpoints run on save, on shutdown and every 100 appends.

### 3.2 Common envelope

Every JSONL line is self-describing and ignorable by older readers:

```jsonc
{
  "schema": "ffs-record/1",
  "type": "run.started",                    // discriminator, namespaced by family
  "id": "evt-20261113T162011-7f3a21",       // unique within the store
  "at": "2026-11-13T16:20:11.123Z",
  "actor": {
    "kind": "user | agent | scheduler | system | unknown",
    "sessionId": "sess-…",                  // when known
    "agentPath": "lead/reviewer",           // agent display path, when known
    "tool": "ffs_analysis_run",             // when a tool initiated the action
    "surface": "record-tab | analysis-tab | viewer-tab | cli | migration"
  },
  "project": { "root": ".", "subject": "sub-001", "session": null, "task": "rest" },
  "links": { "run": "run-…", "decision": "dec-…", "inspection": "insp-…", "parent": null },
  "payload": { }
}
```

`actor.kind: "unknown"` is a first-class value with `payload.reason` (`"pre-record"`,
`"legacy-import"`, `"scheduler-unattributed"`). The charter forbids inventing a person; an
unknown actor is recorded as unknown.

### 3.3 Actors — resolution table

| Initiator | Where resolved | actor |
|---|---|---|
| Agent tool call | `execute(args, exec)` receives `exec.agent` / `exec.callId`; derive session id and agent path there | `{kind:"agent", tool, agentPath, sessionId}` |
| Human UI action | `/ffs-record` route handler, after `connection.admit`; peer is the browser | `{kind:"user", surface:"record-tab"}` |
| Viewer human command | sidecar `origin:"ui"` | `{kind:"user"}` (sidecar event stays canonical) |
| Viewer agent command | sidecar `origin:"agent"` plus the `actor` payload the viewer Host forwards (tool + agent path) | `{kind:"agent", tool, agentPath}` |
| Scheduled/automated | no agent, no peer; call site labelled | `{kind:"system", surface:"policy"}` or `"scheduler"` |
| Migration | `migrate.js` | `{kind:"unknown", surface:"migration"}` |

One helper `actorFromTool(exec, tool)` in `lib/actor.js` is the only place this is derived;
tools never hand-write actor objects. Route handlers never trust a client-supplied actor —
the browser is always the local user, and the client cannot claim to be an agent.

---

## 4. Slice A — attempt ledger (`run.*`)

### 4.1 Why events, not a mutated record

Today `work/ffs-analysis-run.json` is a single slot (`RUN` at index.js:357, `RUN_STATE_FILE`
at :91, `persistRun` at :362): a
resume overwrites the previous attempt, so retries and interruptions vanish, and actor is
absent. The charter requires attempts, initiator, start/end, statuses, errors and retries to
be recorded and history never rewritten. Therefore the ledger is a lifecycle event stream
folded into a current view; the analysis plugin's `RUN` object becomes a view of the fold
(kept for backward compatibility and resume logic).

### 4.2 Event vocabulary

| type | payload |
|---|---|
| `run.imported` | legacy `ffs-analysis-run.json` snapshot + `reason:"legacy-import"` |
| `run.started` | `attempt` (int), `mode` (`plan\|run\|resume\|replay\|tool\|group\|verify`), `script{path,sha256}`, `argv[]`, `workDir`, `params{}`, `instruction{text,source,at}`, `derivedFrom{runIds[],sessionIds[]}`, `inputs[{path,sha256?,bytes,hashPolicy}]`, `env{python,device,lock{path,sha256}}`, `log{path}`, `jobId`, `retryOf`, `resumedFrom` |
| `run.stage` | `stage` (`stage02`), `state` (`started\|completed\|failed\|skipped`), `at`; emitted from the existing banner parser |
| `run.ended` | `status` (`succeeded\|failed\|cancelled\|interrupted`), `exitCode`, `durationMs`, `error{code,message,stackTail?}`, `outputs[{path,sha256,bytes,kind}]`, `log{path,sha256,bytes}` |
| `run.note` | `text`, `tags[]` — user or agent commentary not a decision |
| `run.cited` | `decisionIds[]`, `preferenceRefs[{id,version}]` — emitted when a decision/action used this run |

`inputs` hashing policy, because datasets are large: `full` sha256 for files ≤ 512 MiB;
`sampled` for larger (`{bytes, firstMiBsha256, lastMiBsha256}`) with `hashPolicy:"sampled"`;
`unavailable` with a reason. The policy is recorded, so a verifier knows the strength of the
claim rather than assuming a full hash.

The fold key is `links.run` (`run-<UTC>-<6 base36>`). `attempt` is the ordinal per
`(project, script, mode)`; `retryOf`/`resumedFrom` carry the causal edge. Cancellation is a
`run.ended(status:"cancelled")`, interruption likewise; a Host reload that finds a dangling
`run.started` emits `run.ended(status:"interrupted", error.code:"host-reload")` on the next
service boot, preserving the attempt instead of overwriting it.

### 4.3 Mapping the existing code

| Today | After |
|---|---|
| `persistRun` writes `ffs-analysis-run.json` (index.js:362) | service appends `run.started`/`run.ended`; `persistRun` keeps writing the derived view (no behavior change for resume) |
| `ffs_tool_runs.json` / `ffs-replays.json` capped at 200 (`slice(-199)`, index.js:2753) | `run.started/ended` with `mode:"tool"`/`"replay"`; legacy files frozen and imported once; the cap is removed |
| `RUN.error`, `stageTimes` | in `run.ended` / `run.stage`; `stageTimes` stays derived for the UI |
| no actor | `actor` on every event |
| `dshJobId` | `jobId` in `run.started`; cancel links the same run id |

### 4.4 Query surface

`ffs_record_query` with `family:"runs"` and filters `subject`, `mode`, `status`, `actorKind`,
`since`, `until`, `runId`, `limit` (≤ 100), returns folded current attempts with attempt
number, duration, actor, script sha, output count, error and log reference. `detail:true`
returns the raw event chain for one run (bounded 500 events).

---

## 5. Slice B — decision records (`decision.*`)

### 5.1 The record

A decision is the charter's unit of judgment: action + evidence + rationale + confidence +
who + status. Measurements already exist (FFS `qc/records/*.json`, `qc_review.tsv`,
figures); judgment had no home. It gets one, per subject (plus `_project.jsonl`).

```jsonc
{
  "schema": "ffs-record/1",
  "type": "decision.recorded",              // recorded | revised | withdrawn | confirmed | acknowledged
  "id": "evt-…",
  "at": "2026-11-13T16:31:02.441Z",
  "actor": { "kind": "user", "surface": "record-tab" },
  "payload": {
    "decisionId": "dec-20261113-4a91c2",
    "version": 1,
    "target": {
      "kind": "qc | exclusion | threshold | model | contrast | group-engine | group-correction | recipe | stage | artifact | export | other",
      "ref": "sub-001:stage02",             // stable project reference, never a line number
      "artifact": "work/bids-lite/sub-001/…nii.gz",
      "sha256": "…"                         // when the target is a file
    },
    "action": "accept | reject | tentative | undecided | withdraw",
    "authority": "user | agent | policy",
    "rationale": {
      "text": "Registration boundary is ambiguous without the overlay; judged acceptable.",
      "unknown": false,
      "source": "user | agent",
      "verbatim": true
    },
    "confidence": { "level": "low | medium | high", "numeric": null, "basis": "visual, single pass" },
    "evidence": {
      "quantitative": [{
        "metric": "moco.fd_max", "value": 0.41, "unit": "mm",
        "source": { "kind": "qc-record", "path": "work/…/qc/records/moco.json", "sha256": "…" }
      }],
      "visual": [{
        "inspection": "insp-20261113T161500-9c1e",
        "seq": { "from": 41, "to": 58 },
        "stateSha256": "…",
        "coordinates": { "space": "voxel", "ijk": [32, 40, 25] },
        "display": { "threshold": 2.3, "colormap": "redblue", "alpha": 0.4, "range": [0, 6] },
        "figure": { "path": ".ffs-viewer/screenshots/qc-overlay.png", "sha256": "…" }
      }],
      "judgment": { "visualBasis": true, "experienceBasis": false }
    },
    "preferencesUsed": [ { "id": "pref-qc-overlay-0003", "version": 4 } ],
    "supersedes": null,
    "notes": null
  }
}
```

Rules:

- **Never invent a justification.** `rationale.text` may be `null` only with
  `rationale.unknown:true`; the UI offers "no stated rationale" as an explicit choice, and
  the exported METHODS text then says the rationale was not stated. An agent-written
  rationale is `source:"agent"` and is displayed as the agent's statement, not the user's.
- **Authority is not inferred.** `authority:"user"` only on the browser route;
  agent tools write `authority:"agent"` and at most `action:"tentative"` (or `"undecided"`).
  Promotions to accepted/rejected are user actions. `confirmed` events carry
  `authority:"user"` and cite the decision version.
- **Visual evidence is optional but honest.** If no viewer state was captured, the decision
  says `visual: []` with `judgment.visualBasis` reflecting what the actor claims — not a
  fabricated state hash.
- **Revisions keep history.** `decision.revised` increments `payload.version`, keeps the
  same `decisionId`; the fold exposes `history[]`. Superseding a *different* decision uses
  `payload.supersedes` and a new id; both remain queryable.
- **Status is derived, not written twice.** Fold: `withdrawn` > latest `action`. Accepted
  decisions become `superseded` when a later decision supersedes them.

### 5.2 Decision targets and the gate

`settle` and `export` query `ffsRecord.settleGate(project)`:

- **No hard block; a soft gate.** The owner chose warn-plus-recorded-acknowledgement, so
  settle and export are never refused for an open judgment, but they cannot proceed
  silently: with the record service present, export requires the acknowledgement decision
  below.
- `openConsequential` = decisions whose `target.kind` is in `scientificKinds` (§7.3) and
  whose status is `undecided` or `tentative`.
- Export proceeds only with an explicit acknowledgement, which is itself a decision record:
  `target.kind:"export"`, `action:"accept"`, `rationale.text` quoting the acknowledgement,
  `evidence.quantitative` listing the open decision ids, `authority:"user"`.
- When `ffsRecord` is absent or degraded, settle/export proceed with a visible
  `record.unavailable: true` warning and a manifest field saying so — an optional bundle must
  never block the pipeline (§2.3).
- The settled record embeds `record: {open, accepted, rejected, superseded, acknowledged,
  preferenceVersionsUsed}`; the package embeds the decisions.

### 5.3 UI surfaces

| Surface | Where | Content |
|---|---|---|
| Decisions list | Record tab, section "Decisions" | filter by status/target/subject; each row shows action chip, target, actor, confidence, rationale excerpt, age |
| Decision composer | Record tab (modal) | target picker, action, rationale (text or "not stated"), confidence, evidence pickers: metric values from QC snapshot, "capture current viewer state", figure picker, preference refs; shows the exact record preview before write |
| QC row actions | Analysis tab `QcSection` (client.js:545) | Accept / Tentative / Reject buttons that open the composer prefilled with the metric source; a link to the record row |
| Exclusions | Analysis tab `CohortSection` | "Exclude" becomes a decision; the checkbox remains a derived view of the latest accepted exclusion decision |
| Settle/Export | Analysis tab cards | gate banner: "3 open decisions — acknowledge to continue", with a link to the record tab; no silent export |

The client never computes decision status: the route returns the folded list and the
record tab renders it. The analysis tab's new card reads a small `record` summary from the
existing snapshot (counts + ids), not the full store.

---

## 6. Slice C — inspection record (`inspection.*`)

### 6.1 What exists and what is lost

The sidecar already appends `{line, name, category, origin, ts}` per executed command
(server.py:347-356), once, under a lock. On save, `persist.save_state` flattens it into
`display.ffs`/`analysis.ffs` and drops origin, timestamp and any structure; `viewer.ffs` is a
collapsed state script, not a history (persist.py:143-205). `_prune_surface_log`
(server.py:952-962) additionally deletes surface commands from both stores on surface clear
and on save *when no subject is loaded* (server.py:1236-1238).

The design keeps that flattening for replay compatibility, and adds a durable sink the
flattening cannot destroy.

### 6.2 Sink and session identity

- Sidecar creates `sessionId = insp-<UTC>-<4>` at boot; `hello` and `state` gain
  `inspection: {sessionId, seq, path}` (purely additive; the Host and client read named
  fields only).
- On every accepted command, after the in-memory append (same lock, same order), append one
  line to `.ffs-viewer/inspection/<sessionId>.jsonl`; fsync at save and shutdown, buffered
  (≤ 100 ms) otherwise. Write failures are counted and surfaced in `state` as
  `inspection.degraded`; they never block viewer interaction.
- `session.start` / `session.end` frames carry app version, project root, dataset root,
  subject/session/task when the loaded paths expose them, workspace rev, coordinate
  reference space of the loaded layers, layers loaded at start, and `restored: true|false`,
  so a restored session is attributable (today restore labels everything
  `origin:"restore"`).
- Workspace/layout is RPC, not a command (`workspace` RPC, server.py:1216-1224), so every
  layout change appends a `layout` frame `{layoutSha256, workspaceRev, panes, tabs,
  viewports}`; `capture()`'s state hash includes it. Layouts and comparison arrangements are
  therefore in history, not only in the single overwritten `workspace.json`.
- Each session writes a baseline state artifact
  `.ffs-viewer/inspection/<sessionId>.start.ffs` (the FFS state script at seq 0) with
  `baselineSha256` in `session.start`, so a cited seq can be reconstructed (baseline + events
  replay); verification compares the replayed state hash to the cited `stateSha256`.
- Only `origin:"ui"` events contribute behavioral evidence; `agent`, `system` and `restore`
  events are stored for audit but carry `behavioralWeight:0` in features (§7.2).
- The inspection log is **exempt from surface pruning**. `_prune_surface_log` still trims the
  replay scripts (needed so a restore cannot resurrect an unloaded subject), but it now emits
  a `prune` frame `{count, reason:"surface-unload"}`. The `.ffs` files are
  documented as *current-state scripts*; the JSONL is the history. This resolves the
  conformance audit's "never rewrite history" violation without breaking restore.

### 6.3 Event schema

```jsonc
{
  "schema": "ffs-inspection/1",
  "frame": "event | session.start | mark | measure | layout | prune | session.end",
  "seq": 42,
  "ts": "2026-11-13T16:29:40.812Z",
  "sessionId": "insp-20261113T161500-9c1e",
  "origin": "ui | agent | system | restore",
  "actor": { "kind": "user | agent | system", "tool": "ffs_viewer_command", "agentPath": null },
  "command": { "line": "SET_ALPHA S 0.4", "name": "SET_ALPHA", "category": "display" },
  "semantic": { "kind": "display", "target": "S", "value": 0.4 },
  "view": { "active": "V1", "locked": false, "position": 20 },
  "layer": { "id": "layer-3", "name": "stats-scenes" },
  "snapshot": { "rev": 42 }
}
```

`semantic` is table-driven from the parsed `Command` fields
(`reference/fastfuncstuff/.../viewer/commands.py`) and the four `classify.py` categories:
`SET_IJK`→`{kind:"crosshair",space:"voxel",ijk}`, `SET_XYZ`→`{...,space:"mm",xyz}`,
`SET_INDEX`→`{kind:"frame",index}`, `SET_THRESHOLD/RANGE/COLORMAP/ALPHA`→`display`,
`OPEN_VIEW/CLOSE_VIEW/SET_VIEW_*`→`viewport`, `LOAD/SET_LAYER/…`→`layer`,
`SET_SURFACE_*`→`surface`, everything else → `{kind:"other"}`. Unknown commands never fail
the append; they are still recorded with their line. The mapping lives in
`python/ffsviewer/inspection.py` with a parity test against `classify.py`.

`frame` values: `event` is the command frame above; `session.start`/`session.end` carry the
session context, baseline hash and counts; `layout` carries the workspace fingerprint;
`mark`/`measure` carry `{text, tags[], correctionOf?}` plus captured coordinates and
`stateSha256`; `prune` records `{count, reason}`. Every frame inherits the session's
`projectRef` (dataset, subject, session, task) from the viewer context, never from text.

Marks, measurements and corrections are sidecar RPC methods, not commands:

- `inspection_mark {text, tags[], kind:"mark"|"measure", correctionOf?, capture:true}` → a
  `mark` frame `{text, tags, kind, correctionOf, stateSha256, coordinates, figure?}`; the
  viewer tab gets a "Mark" button and `M` shortcut.
- `inspection_capture {}` → `{sessionId, seq, stateSha256, coordinates, display, figure}`
  used by the decision composer and by tools. `stateSha256` is the canonical hash of
  `{layers, viewports, surfaces, display settings}` (sorted JSON, no voxel bytes), so a
  decision can cite display state without shipping an image.

### 6.4 Read and retention

- Record service reads sessions read-only and never writes into `.ffs-viewer/`. The sidecar
  is the sole writer there: prune, compaction and deletion are executed by the sidecar on
  request through the viewer service (`inspection_prune`, `inspection_compact`), so no
  cross-process race exists. If the viewer service is unavailable, a deletion request is
  queued in `work/ffs-record/pending-prunes.json` and reported **pending**, never as done.
- `ffs_record_query family:"inspection"` lists sessions (id, window, event count, origin
  mix, marks, decisions citing it). `ffs_inspection_get sessionId=<id> fromSeq= toSeq=` returns
  ≤ 500 events, paginated.
- **Tiers** (owner decision: recording on by default, visible, pausable):
  - dense raw: kept `rawDays` (30) days and ≤ `rawBytes` (64 MiB) per project, whichever
    first; annotated/decision-anchored windows are compacted, not dropped;
  - compact: `inspection/compact/<sessionId>.json` per-session features + first/last 50
    events + every mark + every window cited by a decision;
  - summaries: `preferences/evidence/<sessionId>.json` (§7.2) for long-term learning;
  - `.ffs` state scripts and `session.json` remain as today.
- **Stratified sample, never "most common only."** `keepSessions` (20) is the number of
  *compact raw samples* kept after the raw window, not a cap on sessions. When raw sessions
  exceed it, the retained sample is drawn across strata — task, modality, decision outcome
  (accepted / rejected / open), has-marks or not, typical vs outlier feature profile, and
  recency — so an exception that explains *when* a preference should not apply survives.
  The rule is deterministic (seeded by project id), and its receipts are tombstoned with
  `reason:"retention-sample"` so a recompute knows what left.
- The viewer tab shows a persistent "recording" indicator with a pause control; pause stops
  appends (still records `session.paused`/`resumed`) and the state snapshot reports it. No
  separate retention page is needed: the indicator and the Record tab's "Inspection" section
  expose what is stored and a delete action.
- Compaction and retention are requested on service boot and after saves, executed sidecar-side,
are idempotent, and write
  tombstone records for deleted raw data (`reason:"retention"`, counts only). Retention never
  silently drops an annotated event.

---

## 7. Slice D — preference profile

### 7.1 Two layers, one direction

```
inspection JSONL ──features──▶ evidence/<sessionId>.json ──aggregate──▶ profile.json (derived)
        (viewer)                   (python/ffsrecord)      (policy.yaml)        │
                                                                                ▼
                                                        lifecycle events (events.jsonl, append-only)
```

- **Statistics are deterministic Python.** `python/ffsrecord/features.py` transforms one
  inspection session into a fixed feature shard; `profile.py` aggregates shards with
  recency weights and policy thresholds. No LLM call is involved, and the CLI
  (`python -m ffsrecord.cli profile --project .`) reproduces the profile offline — this is
  the package-facing, auditable path the charter demands.
- **The LLM only interprets.** Agent tools read the computed candidate set and may record a
  `preference.proposed` event (interpretation, merge suggestion, conflict note). They cannot
  change status, confidence or evidence counts. Promotion is deterministic policy or explicit
  user confirmation.

### 7.2 Evidence shard (additive by construction)

```jsonc
{
  "schema": "ffs-record-features/1",
  "sessionId": "insp-…",
  "project": { "task": "rest", "modality": "func", "stage": "qc" },
  "window": { "from": "…", "to": "…", "durationS": 512 },
  "status": "complete | partial | paused",
  "originCounts": { "ui": 71, "agent": 4, "system": 2 },
  "behavioralWeight": 0.93,       // 0 for non-user-origin or agent-driven sessions
  "counts": { "byCategory": {"display": 31, "navigation": 44}, "byName": {"SET_ALPHA": 6}, "marks": 2 },
  "dwell": [ { "view": "V1", "plane": "axial", "bucket": "ijk:40,44,20", "ms": 4200 } ],
  "fingerprints": [ { "sha256": "…", "firstSeq": 12, "lastSeq": 40, "ms": 38000 } ],
  "settings": { "thresholdsSet": [2.3, 2.8], "alphasSet": [0.4], "colormaps": ["redblue"] },
  "repeats": [ { "n": 2, "lines": ["SET_IJK", "SET_ALPHA"], "count": 3 } ],
  "revisits": [ { "location": "xyz-bucket:4,-20,10", "visits": 5 } ],
  "sequences": [ { "lines": ["OPEN_VIEW V1 axial", "SET_SURFACE 1"], "count": 1 } ]
}
```

Buckets are deliberately coarse (voxel grid 8 mm, display settings as values) so the shard
is small (≤ 4 KiB), contains no image data, and is additive: every aggregate is a sum over
shards, including `counts`, dwell milliseconds, repeat counts and recency-weighted support.
Deletion therefore recomputes exactly from remaining shards. Only `origin:"ui"` events feed
`counts`, `dwell`, `repeats`, `revisits` and `sequences`; `originCounts` records the rest for
audit. If fewer than 60% of command events are user origin (an agent-driven or restore-heavy
session), the shard keeps `behavioralWeight:0` and can never support a candidate — behavior
is observation, and agent activity is not the user's habit.

### 7.3 Aggregation and confidence

At recompute time (not stored):

```
weight(session) = 0.5 ** (ageDays / halfLifeDays)        # halfLifeDays = 90 (policy)
support_w       = Σ weight(session) over sessions where the pattern occurs
contra_w        = Σ weight(session) over sessions with the opposite pattern
score           = support_w / (support_w + contra_w)      # 0 when no evidence
confidence      = low | medium | high                     # policy bands, rounded down
```

`policy.yaml` (project-editable, versioned in the profile):

```yaml
policy:
  recency: { halfLifeDays: 90 }
  observation:
    candidate:   { minSessions: 3, minOccurrences: 6 }
    established: { minSessions: 8, minScore: 0.75 }
  scientificKinds: [qc, exclusion, threshold, model, contrast, group-engine, group-correction, recipe, design]
  confirmation:
    scientificPromotion: explicit-user-only
    presentationPromotion: policy-allowed-after: { minSessions: 8, minScore: 0.75 }
  retention: { rawDays: 30, rawBytes: 67108864, keepSessions: 20 }
```

`score` and bands are printed in the UI next to every preference, with the contributing
session ids, so a user can audit rather than trust.

### 7.4 Preference record (the charter's field list, verbatim coverage)

```jsonc
{
  "id": "pref-qc-overlay-0003",           // stable identifier
  "version": 4,
  "status": "observed | candidate | established | conditional | retired",
  "kind": "constraint | standard | preference",   // §7.8; never conflated
  "scope": "session | project | task | modality | cross-project",
  "appliesTo": { "tasks": ["rest"], "modalities": ["func"], "stages": ["qc"],
                 "conditions": ["registration boundary ambiguous"] },
  "recommendation": {
    "action": "begin registration QC with linked orthogonal views and a translucent overlay",
    "startState": { "grid": "2x2", "views": ["V1","V2"], "alpha": 0.4 },
    "acceptableRanges": { "alpha": [0.2, 0.6] }
  },
  "adaptWhen": ["boundaries are unambiguous"],
  "origin": "explicit | inferred | confirmed | imported | system-default",
  "evidence": {
    "sessions": 7, "occurrences": 23,
    "supportWeighted": 5.8, "contradictionWeighted": 0.3, "score": 0.95,
    "representatives": ["insp-…", "insp-…"], "lastSeenAt": "…"
  },
  "confidence": { "level": "medium", "basis": "weighted support 5.8" },
  "confirmation": { "by": "user", "at": "…", "channel": "ui | user-question | chat" },
  "exceptions": [], "conflicts": ["pref-…"],
  "createdAt": "…", "updatedAt": "…", "active": true,
  "history": [ { "version": 1, "at": "…", "status": "observed", "reason": "…" } ]
}
```

`origin` and `status` are distinct: an explicit instruction is `origin:"explicit"` from the
first event; behavior starts `origin:"inferred"`, `status:"observed"`. A learned preference
may influence presentation, never scientific validity; the record carries `scientific: true`
when it touches `scientificKinds`.

### 7.5 Lifecycle and authority

| Transition | Trigger | Authority |
|---|---|---|
| `observed` → `candidate` | deterministic policy thresholds met | policy (recorded event) |
| `candidate` → `conditional` | policy finds a stable context signature | policy |
| `candidate/conditional` → `established` (presentation) | policy thresholds **and** no conflict | policy |
| any → `established` (scientific) | explicit user confirmation only | user |
| any → `retired` | user action, or policy after `contradiction` dominance | user / policy with reason |
| any → `candidate` (demotion) | evidence deleted or contradiction rises | policy recompute |

- **User-only actions**: establish a scientific preference, retire, edit recommendation,
  delete evidence/preference. Route handlers (`/ffs-record/preferences/*`) are the user
  path; the agent tool `ffs_preference_confirm` can only *request* confirmation — it writes
  `preference.confirmation-requested`, which becomes a user-questions prompt or a record-tab
  card; the user's answer writes the `confirmed` event. This is the DSH user-actions pattern:
  one service method, two callers, authority-granting action restricted to the user.
- **Agent-proposed interpretation** (`ffs_preference_review` → `ffs_preference_propose`)
  records `preference.proposed {proposal, rationale, llmModel?}`; it never mutates status and
  is shown to the user with the deterministic evidence beside it.
- **Conflicts**: aggregation marks two preferences as conflicting when their
  recommendations apply to the same `appliesTo` and disagree; `profile.conflicts[]` carries
  pairs, and the UI surfaces them. Nothing is auto-merged.

### 7.6 Precedence

`resolve(context)` implements the charter's order and returns an audit list:

```
1 user explicit instruction — `instruction:{text, at, source:"user"}` captured from the
  current tool/route call or a `preference.instruction` event (scope + TTL); never inferred
  from chat prose
2 project requirements + decisions — `kind:"constraint"`/`"standard"` entries from
  `policy.yaml` and the latest accepted project decisions
3 task/modality preferences (established/conditional, scope match)
4 cross-project personal preferences (stored, inactive in v0)
5 tentative inferred preferences (candidate)
6 system defaults
```

- The user's *current explicit instruction* is captured as `instruction` in the tool/route
  call context (tool args or a `user.instruction` event), never inferred from chat text.
- Every application records `preferencesUsed: [{id, version, applied, overriddenBy}]` on the
  run/decision. That is how the package can say which preference versions materially
  influenced work (charter requirement) even after later edits.
- `resolve()` is pure and tested; the Record tab shows "what would apply" for a selected
  context before any action, so precedence is inspectable.
- Constraints are not a rung of the ladder: they gate first (§7.8) and an action that would
  violate one is refused, not outranked.
- `resolveFor({project, task, modality, instruction, decisionTarget})` is the single service
  method with two call sites: the analysis plugin calls it before plan/run and passes the
  returned `{effective, overriddenBy, conflicts}` into the run/decision record; and
  `ffs_preference_review` returns it to the agent. There is no other resolution path, so
  `preferencesUsed` cannot be hand-written.

### 7.7 Deletion semantics (exact)

`POST /ffs-record/preferences/delete` with `{scope: {sessionId|preferenceId|project|before},
mode: "evidence"|"preference", dryRun}`:

1. Resolve affected sessions/preferences; return the **before** aggregate and the sessions
   that will be destroyed when `dryRun:true`.
2. On apply: append a tombstone to `preferences/tombstones.jsonl`
   `{id, at, scope, mode, counts, reason, requestedBy}` — no deleted content.
3. Delete the requested raw inspection files and/or evidence shards **through the viewer
   sidecar** (sole writer): session JSONL, `inspection/compact/*`, the baseline `.ffs` and the
   index entry; if the viewer service is down, queue the request and report pending (§6.4).
4. Recompute every affected aggregate from the remaining shards (Python, exact sums).
5. Re-evaluate lifecycle by policy; demote/retire as required, recording reasons.
6. Append `preference.evidence-deleted` (counts and ids only).
7. Write a new `versions/profile-vNNNN.json`; `profile.json`, summaries and `index/` are
   regenerated.
8. Return a diff (`changed[]`, `statusChanges[]`, `confidenceChanges[]`) for the UI.

Deletion of a session cited by a decision follows one rule: retention never drops the cited
window (it is kept in the compact tier), and an explicit user deletion marks every citing
decision's visual evidence `status:"deleted"` with a `decision.evidence-deleted` event while
keeping the decision itself. No exported package carries a dangling inspection reference.

If a preference was supported by behavior **and** an explicit confirmation, deletion of the
behavior keeps it `established` but rewrites provenance to
`confirmation-supported (behavioral evidence deleted)` — the charter's distinction between
deleting behavioral evidence and deleting the preference itself. Deleting the preference
sets it `retired`, never removes its history.

Deletion is never a hard delete of the tombstone, and it is always recorded in the package
when the package includes that preference version.

### 7.8 Constraints, standards, preferences

The charter requires three distinct things and forbids confusing them:

| kind | meaning | may be overridden |
|---|---|---|
| `constraint` | technical validity, data integrity, compatibility, safety, binding policy | no; the operation is refused and a decision attempt records `refusedBy: constraintId` |
| `standard` | recommended analysis/QC/reporting practice | yes, with a decision `override:{kind:"standard", reason, authority}`; friction only when the departure is consequential |
| `preference` | viewing, navigation, presentation, workflow habit | freely; always a default, never a validity claim |

`preferences/policy.yaml` seeds the project's constraints and standards as entries with
`kind:"constraint"` / `kind:"standard"` (origin `system-default` or `imported`), so the same
lifecycle, evidence and deletion rules apply. The Record tab shows the kind chip on every
entry; the decision composer labels an override; and the exported METHODS lists standards
that were overridden with their recorded reasons, never presenting a preference as a
standard.

---

## 8. Deterministic layer (`python/ffsrecord/`)

| Module | Responsibility | Tests |
|---|---|---|
| `features.py` | one inspection JSONL → one evidence shard (bucketing, dwell, n-grams, marks) | fixture sessions, byte-stable output |
| `profile.py` | sum shards → aggregates; recency weights; policy bands; candidate/conflict detection | determinism, order independence, exact arithmetic |
| `delete.py` | tombstone, subtract, recompute, diff | add/delete/add equivalence |
| `cli.py` | `features`, `profile`, `delete`, `verify` subcommands, JSON on stdout | CLI contract |

The Host service spawns it with the project's real resolution rules: `FFS_PYTHON` first, else
`<projectRoot>/.venv/bin/python` (the analysis plugin's `pythonPath()`, index.js:1167-1169),
with an absolute `PYTHONPATH=<projectRoot>/python:<projectRoot>/reference/fastfuncstuff`;
spawn through `ctx.subprocess.spawn` under the workspace policy when available, and fall back
to the plugin's child-process helper. argv and exit code are recorded as a `tool`-mode run. If the spawn fails, the profile is not
updated, the UI shows `degraded: true`, and the last good profile stays authoritative —
never a half-written profile.

The Python package lives in the project checkout (`python/ffsrecord/`), not inside the
installed bundle: a profile install that links the checkout resolves it from `projectRoot`,
and the exported package vendors it. If neither path exists, the service reports
`python-missing` rather than producing a profile from nothing.

Why Python and not JS: the statistics are the auditable core the charter distinguishes from
the LLM, the repo already tests Python with `unittest`, NumPy is present, and the same code
must run offline inside the exported package. Storage/lifecycle stays in JS because it must
be in-process and atomic with tool execution.

---

## 9. Transport, tools, and UI

### 9.1 Route (same pattern as the other two plugins)

`ctx.inject(['webServer','connection'], …)`, `webCtx.webServer.register({kind:'prefix',
path:'/ffs-record', handler})`, every request `connection.admit(req)` — exactly the viewer's
(ffs-harness-viewer/index.js:799-844) and analysis plugin's
(ffs-analysis-ui/index.js:3423-3633) pattern, because the browser carrier is the proven
choice for a profile-installed bundle (a generated `@Remote` needs build-time API-remotes
mounting that a third-party bundle does not get).

```
GET  /ffs-record/snapshot                        counts + recording state + degradation
GET  /ffs-record/runs?subject=&mode=&status=&limit=
GET  /ffs-record/runs/<id>                       event chain
GET  /ffs-record/decisions?target=&status=&subject=
POST /ffs-record/decisions                       record / revise / withdraw / acknowledge
GET  /ffs-record/inspection?session=&fromSeq=&toSeq=
POST /ffs-record/inspection/mark                 annotate current state
POST /ffs-record/inspection/pause                {paused:bool}
GET  /ffs-record/preferences                      profile + conflicts + policy
POST /ffs-record/preferences/confirm              user-only promotion/edit/retire
POST /ffs-record/preferences/delete               dry-run or apply
POST /ffs-record/preferences/review               deterministic candidate set (agent tool calls service)
GET  /ffs-record/package/bundle?subjects=&runIds=&decisionIds=&preferenceVersions=
POST /ffs-record/rebuild                          rebuild derived views/index
```

`GET /ffs-record/snapshot` is polled by the Record tab at 2 s idle / 1 s while an inspection
session is live; it is bounded (≤ 200 decisions, ≤ 50 sessions, counts only for preferences).
The analysis plugin's existing snapshot gains one small `record` block
`{available, openDecisions, ackRequired, preferenceVersionsUsed}` — not the store.

### 9.2 Tools (agent-facing)

| Tool | Kind | Behavior |
|---|---|---|
| `ffs_record_query` | read | runs/decisions/sessions/preferences filtered, bounded; no store mutation |
| `ffs_inspection_get` | read | `sessionId`, `fromSeq`→`toSeq`, ≤ 500 events; semantic coords, marks, decision links |
| `ffs_inspection_mark` | write | annotate current viewer state; requires an active viewer session; `capture:true` records state hash |
| `ffs_decision_record` | write | record/revise/withdraw; agent authority means at most `tentative`; schema requires `rationale.unknown` or text; optional `instruction` |
| `ffs_preference_review` | read | runs the deterministic candidate/conflict computation, returns evidence tables (calls service, not LLM math) |
| `ffs_preference_propose` | write | records the agent's interpretation as a proposal event; cannot change status |
| `ffs_preference_confirm` | write (request) | writes `confirmation-requested` and returns the prompt; only a user answer establishes |
| `ffs_preference_delete` | write | dry-run first; applies deletion pipeline with scope; records tombstones |
| `ffs_record_rebuild` | write | rebuild derived views; reports disagreements, never silently fixes |

Nine tools, all `presentCall` cards (`kind:"read"`/`"write"`), JSON-string results like the
existing 16 analysis tools. `ffs_decision_record` and `ffs_preference_*` names must not
collide with the analysis plugin's namespace; the `ffs-analysis` prefix rule is kept
(`ffs_` + verb), no new tool named `ffs_analysis_*`.

### 9.3 Client surfaces

**New right-sidebar tab "Record"** (`ctx.sidebarRightTabs.register` + keyed
`sidebar.right.pane.tab` slot, `keepMounted:true`, prefixed `.ffr-*` CSS, `--dsw-alias-*`
tokens, inline `MESSAGES` + `locale/en.json,zh.json` meta):

- **Runs**: attempt timeline; actor chip (user/agent/scheduler), mode, duration, status,
  script sha, inputs/outputs, log link; filter by subject/mode/status.
- **Decisions**: status filters, rows with action/authority/confidence/age, evidence chips
  (metric values, viewer thumbnails), expandable history; composer modal; acknowledge-open
  banner when settle is attempted.
- **Inspection**: current session (live badge, recording/paused toggle), sessions table
  (window, events, marks, decisions citing), bounded event list with semantic coordinates,
  "open in viewer" (loads the `.ffs` state by calling the viewer tab).
- **Preferences**: profile versions, candidates with deterministic evidence (support,
  contradiction, score, representative sessions), conflict pairs, confirm/retire buttons
  (user-only), evidence deletion with dry-run diff, origin/status chips.
- **Settings**: retention values, half-life, policy path, recording default, rebuild button.

**Analysis tab** additions (client.js): `QcSection` accept/tentative/reject buttons that open
the composer (via a route call, prefilled evidence), a Decisions summary card, and the
settle/export acknowledgement banner. No second decision store.

**Viewer tab** additions (ffs-harness-viewer/client.js): recording indicator (from snapshot
`inspection`), Mark button (`M`), and a "Record decision" action that switches to the Record
tab with the captured state. The viewer itself writes nothing but its own inspection file.

### 9.4 Accessibility and states

Buttons are real `<button>` elements with `aria-pressed` for toggles; the recording indicator
is `role="status"`; the composer is a modal with Escape/focus trap copied from host patterns;
status chips are not color-only (icon + text); all new strings go through the locale table.

Degraded states: `record-service-unavailable` (analysis/viewer), `inspection-degraded`
(sidecar sink wrote fewer events), `profile-stale` (last recompute older than N sessions),
`policy-invalid` (YAML parse failure → fall back to built-in defaults, shown prominently),
`tombstone-conflict` (manual edits) — each with a visible message, never silent.

### 9.5 Build, install, verification

- Plain ESM: `client.js` is served as-is by the client module loader. There is no bundler
  step, matching the two existing bundles.
- Link the package into the `desktop` profile beside the two existing local links and insert
  the two rows; install once through `plugin_manager install_bundle` with the local path
  (owner approval). A new bundle can activate via HMR, but replacing an installed package
  needs a restart for a fresh module generation, and the browser needs a refresh to load the
  new `client.js`.
- Verify after install, not from installation alone: both rows active in `list_plugins`, the
  Record tab renders with a `role="status"` recording indicator, `/ffs-record/snapshot`
  answers 200 only within an authenticated session, and the nine tools appear in the tool
  list. Report the HMR outcome honestly if a restart was required.
- The rollback path is the R0 acceptance test: remove the bundle row and the analysis and
  viewer plugins behave exactly as before.

---

## 10. Package and export

The analysis export (ffs-analysis-ui/index.js:1518-1776, `renderManifest` 1397) gains a
`record/` subtree, composed by `ffsRecord.buildPackageBundle({subjects, runIds, decisionIds,
preferenceVersions})`:

```
record/
  runs.jsonl                     attempts for included subjects + cohort/group runs
  logs/<runId>.log               full log of each included run (sha256 in runs.jsonl)
  decisions/sub-001.jsonl        all decisions for included subjects (incl. superseded)
  decisions/_project.jsonl       cohort/group/export decisions
  inspection/<sessionId>.jsonl   sessions cited by included decisions + sample (policy)
  inspection/marks/<sessionId>.json
  preferences/profile.json       the exact profile version used, copied immutable
  preferences/policy.yaml        the exact policy that produced it
  preferences/contributions.md   human-readable "which preference influenced what"
  limitations.md                 known limitations, unresolved questions, remaining barriers
  README.md                      what this subtree is, and what is deliberately absent
```

- `manifest.json` gains
  `record: { runs, logs, decisions:{total,open,accepted}, inspectionSessions,
  preferenceVersions, openDecisionsAcknowledged, unavailable }`; `checksums.sha256` walks
  the files automatically.
- `METHODS.md` gains **Judgment calls** (accepted decisions: target, action, rationale,
  confidence, actor, evidence refs) and **Software defaults vs learned preferences** (only
  preferences that materially influenced work, with ids/versions). `STEPS.md` gains a
  decision timeline interleaved with stages plus an **Exploration → selected workflow**
  section built from `run.started.derivedFrom`. Neither section invents a justification: unknown
  rationale is printed as unknown.
- `README.md` links to `record/README.md`; `verify.sh` is unchanged (checksums cover record/)
  and `--replay` never reruns record preprocessing.
- Artifacts in `tables/` and `manifest.artifacts` gain `status`
  (`exploratory|failed|superseded|tentative|selected|accepted`) derived from decisions,
  satisfying the "label exploratory/failed/superseded" package requirement.

The export refuses nothing new. With the record service present the acknowledgement decision
is the soft gate (§5.2); without it the manifest records `record.unavailable: true` and the
package README says the record was not available.

---

## 11. Migration and violation fixes

| Current behavior | Fix in this design | Milestone |
|---|---|---|
| `appendProvenance` drops older records (`slice(-199)`, index.js:2753) | ledger append-only, rotated; legacy files imported once and frozen | R0 |
| single `ffs-analysis-run.json` overwritten on resume (index.js:362) | `run.*` events + derived view; interrupted attempts preserved | R0 |
| no actor anywhere (tools route are indistinguishable) | `actorFromTool` / route peer / sidecar origin; actor on every record | R0 |
| `_prune_surface_log` deletes history at save (server.py:952) | replay scripts still pruned (restore safety) but inspection JSONL is exempt and a `history.pruned` event records it | R2 |
| QC figures exist but no verdict state | decision records + composer + settle gate | R1 |
| cohort include is the only persisted user choice (`ffs-cohort-include.json`) | exclusion decision is authoritative; include is derived; migration imports existing booleans with `actor:"unknown"` | R1 |
| `.ffs` scripts drop origin/ts (persist.py:143) | durable inspection JSONL | R2 |
| no preference concept | events + evidence shards + profile + policy | R3–R4 |
| QC runs `-no_qc` by default (PLAN_DEFAULTS.noQc, index.js:44) | not changed here; but when QC exists the decision path works. Turning QC on is a separate analysis decision | — |
| package ships no judgment | `record/` subtree, manifest keys, METHODS/STEPS sections | R5 |

Migration runs once when the service first sees a project without `work/ffs-record/`:

1. write `schema.json` + `migrations/import-v0.json` receipt (files read, counts, hashes);
2. import `ffs-analysis-run.json` → `run.imported` (status mapped, `actor.kind:"unknown"`);
3. import `ffs-tool-runs.json`/`ffs-replays.json` → `run.imported` with mode tool/replay;
4. import `ffs-cohort-include.json` → `decision.recorded` per false entry
   (`target.kind:"exclusion"`, `authority:"user"`, `rationale.unknown:true`,
   `actor.kind:"unknown"`);
5. import settled records → `decision.recorded` `target.kind:"export"`, `action:"accept"`;
6. never delete or rewrite the legacy files; the derived `ffs-analysis-run.json` keeps being
   written by the analysis plugin so a rollback (disable the record bundle) changes nothing.

Migration is idempotent: `schema.json` carries a `storeId`; `migrations/import-v0.started` is
written before the first import, imported event ids are deterministic
(`evt-migrate-v0-<source>-<ordinal>`), and a re-run skips ids that already exist. Two
concurrent boots serialize on `migrations/import-v0.lock` (O_EXCL) and the loser exits.
Deleting the whole `work/ffs-record/` directory is the documented reset and re-triggers a
clean import.

A rollback test is part of R0 acceptance: with the bundle disabled, the analysis and viewer
plugins behave exactly as before, no half-imported record breaks them, and settle/export
proceed with the `record.unavailable` warning instead of the acknowledgement gate.

---

## 12. Risks, limits, open questions

- **K1 — behavior logging is sensitive.** On by default was chosen, but the layer stores
  cursor-adjacent, timing and attention-like data. Mitigations: visible indicator, pause,
  coarse bucketing (8 mm, no pixel/screen coordinates), no cross-project aggregation,
  deletion that actually subtracts, and the Record tab showing what is stored. The charter's
  "treat behavior as observation, not proof of intent" is enforced in wording: features are
  named `dwell`/`revisit`/`repeat`, never "attention".
- **K2 — file-per-project, no transactional store.** Appends are atomic per line, but a crash
  between a run event and its derived view can disagree. Mitigation: truth is the JSONL,
  derived views are rebuildable, `ffs_record_rebuild` reports disagreements; no cross-file
  transaction is claimed.
- **K3 — statistics quality at small n.** Two-to-four-subject fixtures produce few sessions.
  Policy thresholds are configured, not hard-coded; the UI always shows support/contradiction
  counts so a user does not over-trust a "high confidence" from six events. v0 may show zero
  candidates in a small project — that is the honest outcome.
- **K4 — two plugins still use `node:fs`.** The record bundle follows the same style for
  consistency; migrating all three to `ctx.fs` + `sandboxPolicy` is a separate hardening task.
  Until then, workspaces outside the session workspace must be registered by the operator;
  the record layer writes only project-root-relative paths.
- **K5 — viewer sidecar changes are protocol-additive but must stay compatible.** Old
  clients ignore new `state.inspection` fields; new Hosts tolerate a sidecar without the
  sink (`degraded`). A parity test asserts `classify.py` and `inspection.py` agree on all 114
  commands.
- **K6 — profile recompute cost.** Only per-session shards are summed (no raw events), so a
  project with 10k sessions is still small; recompute is O(sessions) and spawned on demand.
- **K7 — agent-authored rationale.** Charter allows agent suggestions but not invented user
  intent. The schema separates `source`, and the UI/package never merges the two voices.
- **K8 — bundle activation order.** Integrations attach reactively (§2.3); R0 must prove that
  toggling the record bundle on/off re-attaches them without a restart and without duplicate
  listeners.
- **K9 — trusted in-process boundary.** Plugins share a process, so user-only transitions are
  protected by a closure-minted grant, not a sandbox. A sandboxed plugin host would need a
  stronger boundary; this is documented as trustworthy-local.

Open questions for the owner (defaults proposed, no blocker):

1. **Retention defaults** — 30 days / 64 MiB / 20 compact samples? (`policy.yaml retention`, bootstrapped from `Config`).
2. **Half-life** — 90 days for recency weighting?
3. **Naming** — `work/ffs-record/` and tool prefix `ffs_record_*` accepted?
4. **Expert friction** — should rationale be required for `target.kind ∈ scientificKinds`
   even when the actor is an agent? (Proposed: agent must give text or explicitly unknown;
   user may always choose "not stated".)
5. **Cross-project preferences** — confirm deferral to v2 (stored scope value, not resolved).

---

## 13. Milestones and acceptance

Each milestone is independently testable and leaves the system usable.

| # | Deliverable | Acceptance |
|---|---|---|
| **R0** | Bundle skeleton (2 rows, route, service), store, actors, run events, migration, `ffs_record_query`, analysis-plugin attempt wiring; remove the 200-cap from tool/replay provenance | 600 appends survive a restart; two-run retry shows two attempts with actors; legacy project imports without changing analysis behavior; bundle disabled = old behavior; toggling re-attaches integrations (K8); node tests for store, fold and torn-line tolerance |
| **R1** | Decision records, composer, QC accept/tentative/reject, exclusion decisions, settle gate + acknowledgement, export embeds decisions, METHODS/STEPS sections | record → revise → supersede fold is correct; open decision requires ack before export; package contains decisions + ack and checksums verify; user-only authority enforced on the route and impossible via tool |
| **R2** | Inspection sink, session identity, semantic extraction, marks, capture, prune event, retention tiers, Record tab Inspection section | 114-command parity; kill/restart keeps history; a decision cites session+seq+stateSha256 and opening the session reproduces the slice; pause stops appends; compaction is idempotent; a cited session replays from its baseline to the cited seq and matches `stateSha256`; prune still allows clean restore |
| **R3** | Python feature/profile layer, evidence shards, observed/candidate lifecycle, Preferences tab read-only | profile byte-identical across runs and input order; no LLM call in the math path; `python -m ffsrecord.cli profile` reproduces the JSON inside the exported package |
| **R4** | Precedence resolution, confirmation request/answer, delete-evidence pipeline, tombstones, profile versions | add/delete/add aggregates equal recompute-from-remaining exactly; confirmed preference survives evidence deletion with rewritten provenance; precedence unit tests over the six levels; every application records id+version |
| **R5** | Package completeness: record subtree, manifest, METHODS judgment/Preferences sections, status labels, `verify.sh` | exported package verifies; a reader can trace a threshold decision from METHODS → decision → inspection seq → metric file; open-decision ack visible |
| **R6** | Conformance re-audit and doc updates | `PHILOSOPHY_CONFORMANCE.md` re-measured; every previously absent section has an evidence pointer or an explicit residual gap; README/PARITY/WORKFLOW updated |

Verification commands added by the design:

```bash
node --test tests/test_ffsrecord_store.mjs                    # R0/R1
.venv/bin/python -m unittest tests.test_ffsrecord_features -v  # R3/R4
.venv/bin/python -m ffsrecord.cli profile --project . --check  # profile reproducible
.venv/bin/python -m ffsrecord.cli delete --scope session:insp-… --dry-run
.venv/bin/python -m unittest tests.test_inspection_parity -v      # 114-command semantics
ffs_record_query family=decisions status=open
ffs_record_rebuild
```

---

## 14. Conformance map

| Charter section | Mechanism | Milestone |
|---|---|---|
| Core philosophy: project is truth, shared state | files + one service, rebuildable derived views | R0 |
| Preserve freedom of composition | every mode recorded (plan/run/replay/tool), bespoke tool-runs in the same ledger | R0 |
| Complete and honest analysis record | actor, attempts, inputs, shipped logs, verdicts, no truncation | R0–R1 |
| QC as measurement and judgment | decision records with metric + visual evidence, rationale, confidence, actor | R1 |
| Record how inspection happens | durable inspection JSONL with baseline, semantic coords, layout frames, marks/measurements/corrections | R2 |
| Learn work habits as preferences | user-origin evidence shards + deterministic profile + 12-field records | R3 |
| Algorithms vs LLM | Python statistics; LLM only proposes/interprets | R3 |
| Bounded storage and meaningful deletion | tiers, stratified sample, tombstones, additive subtraction, kept profile versions, sidecar-executed deletion | R2–R4 |
| Preference precedence | six-level `resolveFor()` with explicit instruction capture and project requirements; recorded application | R4 |
| Expand competence without constraining expertise | optional rationale; constraint/standard/preference taxonomy with recorded overrides; acknowledgement instead of block. Teaching content deferred (§1.3) | R1, R4 |
| Plugin and interface design | service + route + tools + Record tab over shared records; agent actions reviewable | R0–R5 |
| Package for humans and agents | `record/` subtree, logs, limitations, METHODS/STEPS incl. exploration→plan, status labels | R5 |
