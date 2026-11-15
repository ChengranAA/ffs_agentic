import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  appendEvent,
  foldDecisions,
  foldRuns,
  migrateLegacy,
  newRunId,
  normalizeActor,
  queryDecisions,
  queryRuns,
  readFamily,
  rebuildIndex,
  recordStats,
  recordingEnabled,
} from '../shared/record/store.js'

function tempProject() {
  return mkdtempSync(path.join(os.tmpdir(), 'ffs-record-'))
}

test('600 appends survive a reload and fold into attempts', () => {
  const root = tempProject()
  try {
    for (let index = 0; index < 600; index += 1) {
      const runId = `run-${Math.floor(index / 3)}`
      appendEvent(root, 'runs', {
        type: index % 3 === 0 ? 'run.started' : (index % 3 === 1 ? 'run.step' : 'run.ended'),
        actor: { kind: 'agent', tool: 'ffs_analysis_run', agentPath: 'lead' },
        links: { run: runId },
        payload: index % 3 === 0
          ? { mode: 'run', attempt: 1, subject: '001', script: { path: 'work/proc.sh' } }
          : (index % 3 === 2 ? { status: 'completed', durationMs: 1200, commands: [] } : {}),
      })
    }
    const read = readFamily(root, 'runs')
    assert.equal(read.events.length, 600)
    assert.equal(read.shards.length, 1)
    assert.equal(read.corrupt.length, 0)
    const runs = foldRuns(read.events)
    assert.equal(runs.length, 200)
    assert.ok(runs.every((run) => run.status === 'completed'))
    assert.ok(runs.every((run) => run.actor.kind === 'agent' && run.actor.tool === 'ffs_analysis_run'))
    const stats = recordStats(root)
    assert.equal(stats.families.runs.events, 600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('actors and queries filter the ledger', () => {
  const root = tempProject()
  try {
    const started = appendEvent(root, 'runs', {
      type: 'run.started',
      actor: { kind: 'user', surface: 'analysis-tab' },
      links: { run: 'run-a' },
      payload: { mode: 'run', subject: '001', attempt: 1, script: { path: 'work/a.sh' } },
    })
    appendEvent(root, 'runs', { type: 'run.started', actor: { kind: 'weird' }, links: { run: 'run-b' }, payload: { mode: 'tool', subject: '002' } })
    appendEvent(root, 'runs', { type: 'run.ended', links: { run: 'run-a' }, payload: { status: 'completed', durationMs: 10 } })
    assert.equal(started.schema, 'ffs-record/1')
    assert.equal(normalizeActor({ kind: 'agent', extra: 'dropped' }).kind, 'agent')
    assert.equal(normalizeActor({ kind: 'weird' }).kind, 'unknown')
    assert.equal(normalizeActor(null).reason, 'no-actor')

    const all = queryRuns(root, {})
    assert.equal(all.runs.length, 2)
    assert.equal(queryRuns(root, { status: 'completed' }).runs.length, 1)
    assert.equal(queryRuns(root, { mode: 'tool' }).runs.length, 1)
    assert.equal(queryRuns(root, { subject: 'sub-001' }).runs.length, 1)
    assert.equal(queryRuns(root, { actorKind: 'user' }).runs.length, 1)
    assert.equal(queryRuns(root, { runId: 'run-a' }).runs[0].durationMs, 10)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a torn trailing line is skipped and reported, not fatal', () => {
  const root = tempProject()
  try {
    appendEvent(root, 'runs', { type: 'run.started', links: { run: 'run-a' }, payload: { mode: 'run' } })
    const dir = path.join(root, 'work', 'ffs-record', 'runs')
    const shard = path.join(dir, readdirSync(dir).find((name) => name.endsWith('.jsonl')))
    writeFileSync(shard, `${readFileSync(shard, 'utf8')}{"broken":`)
    const read = readFamily(root, 'runs')
    assert.equal(read.events.length, 1)
    assert.equal(read.corrupt.filter((item) => item.reason === 'torn-tail').length, 1)
    const rebuilt = rebuildIndex(root)
    assert.equal(rebuilt.counts.runs, 1)
    assert.equal(rebuilt.corrupt.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy import is deterministic and idempotent', () => {
  const root = tempProject()
  try {
    mkdirSync(path.join(root, 'work'), { recursive: true })
    writeFileSync(path.join(root, 'work', 'ffs-analysis-run.json'), JSON.stringify({
      status: 'completed', startedAt: '2026-11-13T10:00:00.000Z', finishedAt: '2026-11-13T10:05:00.000Z', error: null,
    }))
    writeFileSync(path.join(root, 'work', 'ffs-tool-runs.json'), JSON.stringify([
      { id: 'tool-1', argv: ['ffs_info'], exitCode: 0, at: '2026-11-13T10:06:00.000Z' },
      { id: 'tool-2', argv: ['3dinfo'], exitCode: 0, at: '2026-11-13T10:07:00.000Z' },
    ]))
    const first = migrateLegacy(root)
    assert.equal(first.skipped, false)
    assert.equal(first.imported, 3)
    const read = readFamily(root, 'runs')
    assert.equal(read.events.length, 3)
    assert.ok(read.events.every((event) => event.type === 'run.imported'))
    assert.ok(read.events.every((event) => event.actor.kind === 'unknown' && event.actor.reason === 'legacy-import'))
    const second = migrateLegacy(root)
    assert.equal(second.skipped, true)
    assert.equal(readFamily(root, 'runs').events.length, 3)
    assert.equal(foldRuns(readFamily(root, 'runs').events).length, 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy project decisions import once into the decisions family', () => {
  const root = tempProject()
  try {
    mkdirSync(path.join(root, 'work'), { recursive: true })
    writeFileSync(path.join(root, 'work', 'ffs-analysis-project.json'), JSON.stringify({
      decisions: [
        { id: 'dec-1', at: '2026-11-13T11:00:00.000Z', action: 'accept', target: { kind: 'qc', ref: 'sub-001:qc/fd.png' }, rationale: { text: 'stable' } },
        { id: 'dec-2', at: '2026-11-13T11:05:00.000Z', action: 'tentative', target: { kind: 'qc', ref: 'sub-001:qc/tsnr.png' }, rationale: { unknown: true } },
      ],
    }))
    const first = migrateLegacy(root)
    assert.equal(first.imported, 2)
    const read = readFamily(root, 'decisions')
    assert.equal(read.events.length, 2)
    assert.ok(read.events.every((event) => event.type === 'decision.imported'))
    assert.ok(read.events.every((event) => event.actor.reason === 'legacy-project-state'))
    assert.equal(read.events[0].payload.decision.action, 'accept')
    assert.equal(migrateLegacy(root).skipped, true)
    assert.equal(readFamily(root, 'decisions').events.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('decision revisions and supersedes fold to the current view', () => {
  const root = tempProject()
  try {
    appendEvent(root, 'decisions', {
      type: 'decision.recorded', actor: { kind: 'user' }, links: { decision: 'dec-a' },
      payload: { version: 1, decision: { id: 'dec-a', action: 'tentative', target: { kind: 'qc', ref: 'sub-001:qc/fd.png' }, rationale: { unknown: true } } },
    })
    appendEvent(root, 'decisions', {
      type: 'decision.revised', actor: { kind: 'user' }, links: { decision: 'dec-a' },
      payload: { version: 2, decision: { id: 'dec-a', action: 'accept', target: { kind: 'qc', ref: 'sub-001:qc/fd.png' }, rationale: { text: 'accepted after re-inspection' } } },
    })
    appendEvent(root, 'decisions', {
      type: 'decision.recorded', actor: { kind: 'user' }, links: { decision: 'dec-b' },
      payload: { version: 1, supersedes: 'dec-a', decision: { id: 'dec-b', action: 'reject', target: { kind: 'qc', ref: 'sub-001:qc/fd.png' } } },
    })
    const folded = foldDecisions(readFamily(root, 'decisions').events)
    const byId = Object.fromEntries(folded.map((decision) => [decision.id, decision]))
    assert.equal(byId['dec-a'].version, 2)
    assert.equal(byId['dec-a'].status, 'superseded')
    assert.equal(byId['dec-a'].supersededBy, 'dec-b')
    assert.equal(byId['dec-b'].status, 'recorded')
    assert.equal(queryDecisions(root, {}).decisions.length, 2)
    assert.equal(queryDecisions(root, { status: 'superseded' }).decisions.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('run ids are unique and recording can be disabled', () => {
  const first = newRunId()
  const second = newRunId()
  assert.notEqual(first, second)
  assert.match(first, /^run-/)
  assert.equal(recordingEnabled({ FFS_RECORD: 'off' }), false)
  assert.equal(recordingEnabled({}), true)
})
