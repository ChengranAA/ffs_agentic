/**
 * Append-only record store shared by the analysis and record bundles.
 *
 * One ledger per project under `work/ffs-record/`, one JSONL shard per family per month.
 * Appends are single lines; reads skip a torn trailing line instead of failing. This module
 * is intentionally dependency-free and testable with `node --test`.
 *
 * The record layer is design v0 (docs/RECORD.md). R0 covers the attempt ledger, actors and
 * legacy migration; decisions/inspection/preferences stay where they are until their slices.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export const RECORD_SCHEMA = 'ffs-record/1'
export const RECORD_DIR = 'work/ffs-record'
export const FAMILIES = ['runs', 'decisions', 'preferences']

export const ACTOR_KINDS = ['user', 'agent', 'scheduler', 'system', 'unknown']

const SHARD_LIMIT_BYTES = 8 * 1024 * 1024

export function recordRoot(projectRoot) {
  return path.join(projectRoot, RECORD_DIR)
}

export function normalizeActor(actor) {
  if (!actor || typeof actor !== 'object') return { kind: 'unknown', reason: 'no-actor' }
  const kind = ACTOR_KINDS.includes(actor.kind) ? actor.kind : 'unknown'
  const normalized = { kind }
  for (const key of ['sessionId', 'agentPath', 'tool', 'surface', 'reason']) {
    if (actor[key]) normalized[key] = String(actor[key])
  }
  return normalized
}

function shardName(at) {
  const date = new Date(at)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}.jsonl`
}

function familyDir(projectRoot, family) {
  return path.join(recordRoot(projectRoot), family)
}

function assertFamily(family) {
  if (!FAMILIES.includes(family)) throw new Error(`unknown record family: ${family}`)
}

/** Append one event to its family shard. Returns the stored envelope. */
export function appendEvent(projectRoot, family, event = {}) {
  assertFamily(family)
  if (!event.type || typeof event.type !== 'string') throw new Error('record event needs a type')
  const at = event.at ? new Date(event.at).toISOString() : new Date().toISOString()
  const envelope = {
    schema: RECORD_SCHEMA,
    type: event.type,
    id: event.id ? String(event.id) : `evt-${Date.parse(at).toString(36)}-${randomUUID().slice(0, 8)}`,
    at,
    actor: normalizeActor(event.actor),
    project: event.project && typeof event.project === 'object' ? event.project : { root: '.' },
    links: event.links && typeof event.links === 'object' ? event.links : {},
    payload: event.payload && typeof event.payload === 'object' ? event.payload : {},
  }
  const dir = familyDir(projectRoot, family)
  mkdirSync(dir, { recursive: true })
  appendFileSync(path.join(dir, shardName(at)), `${JSON.stringify(envelope)}\n`)
  return envelope
}

/** Read every event in a family, oldest first. A torn last line is reported, not parsed. */
export function readFamily(projectRoot, family) {
  assertFamily(family)
  const dir = familyDir(projectRoot, family)
  if (!existsSync(dir)) return { events: [], corrupt: [], shards: [] }
  const shards = readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort()
  const events = []
  const corrupt = []
  for (const shard of shards) {
    const file = path.join(dir, shard)
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      corrupt.push({ file: shard, reason: `unreadable: ${error?.message || error}` })
      continue
    }
    if (!text) continue
    const torn = !text.endsWith('\n')
    const lines = text.split('\n')
    if (torn) lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        corrupt.push({ file: shard, reason: 'invalid-json' })
      }
    }
    if (torn) corrupt.push({ file: shard, reason: 'torn-tail' })
  }
  return { events, corrupt, shards }
}

/** Fold run events into one record per attempt. Newest first. */
export function foldRuns(events) {
  const runs = new Map()
  const ensure = (id) => {
    if (!runs.has(id)) {
      runs.set(id, {
        runId: id, mode: null, attempt: null, status: 'unknown', actor: null,
        subject: null, script: null, startedAt: null, endedAt: null, durationMs: null,
        error: null, commands: [], outputs: [], events: [],
      })
    }
    return runs.get(id)
  }
  for (const event of events) {
    const runId = event.links?.run || event.payload?.runId
    if (!runId) continue
    const run = ensure(String(runId))
    run.events.push(event)
    if (event.type === 'run.started' || event.type === 'run.imported') {
      run.mode = event.payload.mode || run.mode
      run.attempt = event.payload.attempt ?? run.attempt
      run.subject = event.payload.subject ?? run.subject
      run.script = event.payload.script?.path ?? event.payload.script ?? run.script
      run.startedAt = event.at
      run.actor = event.actor || run.actor
      if (event.type === 'run.imported') {
        run.status = event.payload.record?.status || 'imported'
        run.endedAt = event.payload.record?.finishedAt || run.endedAt
      } else {
        run.status = 'running'
      }
    } else if (event.type === 'run.ended') {
      run.endedAt = event.at
      run.status = event.payload.status || 'ended'
      run.durationMs = event.payload.durationMs ?? run.durationMs
      run.error = event.payload.error ?? run.error
      run.commands = event.payload.commands ?? run.commands
      run.outputs = event.payload.outputs ?? run.outputs
      if (!run.startedAt && event.payload.startedAt) run.startedAt = event.payload.startedAt
    }
  }
  return [...runs.values()].sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))
}

/**
 * Fold decision events into the current view per decision id. Revisions keep the same id and
 * bump version; superseding a different decision marks the target superseded and leaves both
 * in history.
 */
export function foldDecisions(events) {
  const decisions = new Map()
  for (const event of events) {
    const payload = event.payload || {}
    const decision = payload.decision || {}
    const decisionId = payload.decisionId || decision.id || event.links?.decision
    if (!decisionId) continue
    if (event.type === 'decision.superseded') {
      const target = decisions.get(String(decisionId))
      if (target) {
        target.status = 'superseded'
        target.supersededBy = payload.supersededBy || null
        target.supersededAt = event.at
      } else {
        decisions.set(String(decisionId), {
          id: String(decisionId), status: 'superseded', supersededBy: payload.supersededBy || null,
          supersededAt: event.at, events: [event],
        })
      }
      decisions.get(String(decisionId)).events.push(event)
      continue
    }
    const current = decisions.get(String(decisionId))
    const merged = {
      ...(current || {}),
      ...decision,
      id: String(decisionId),
      version: Number(decision.version ?? payload.version ?? (current?.version || 0)) || 1,
      status: event.type === 'decision.withdrawn' ? 'withdrawn' : (decision.status || current?.status || 'recorded'),
      updatedAt: event.at,
      events: [...(current?.events || []), event],
    }
    decisions.set(String(decisionId), merged)
    if (payload.supersedes) {
      const target = decisions.get(String(payload.supersedes))
      if (target) {
        target.status = 'superseded'
        target.supersededBy = String(decisionId)
        target.supersededAt = event.at
      }
    }
  }
  return [...decisions.values()].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
}

export function queryDecisions(projectRoot, filters = {}) {
  const read = readFamily(projectRoot, 'decisions')
  let decisions = foldDecisions(read.events)
  if (filters.status) decisions = decisions.filter((decision) => decision.status === filters.status)
  if (filters.subject) decisions = decisions.filter((decision) => String(decision.subject || '') === String(filters.subject))
  if (filters.action) decisions = decisions.filter((decision) => decision.action === filters.action)
  if (filters.limit) decisions = decisions.slice(0, Math.max(1, Number(filters.limit) || 50))
  return { decisions, corrupt: read.corrupt, shards: read.shards.length, events: read.events.length }
}

export function queryRuns(projectRoot, filters = {}) {
  const { events, corrupt, shards } = readFamily(projectRoot, 'runs')
  let runs = foldRuns(events)
  if (filters.status) runs = runs.filter((run) => run.status === filters.status)
  if (filters.mode) runs = runs.filter((run) => run.mode === filters.mode)
  if (filters.subject) runs = runs.filter((run) => String(run.subject || '').replace(/^sub-/, '') === String(filters.subject).replace(/^sub-/, ''))
  if (filters.actorKind) runs = runs.filter((run) => run.actor?.kind === filters.actorKind)
  if (filters.runId) runs = runs.filter((run) => run.runId === filters.runId)
  if (filters.limit) runs = runs.slice(0, Math.max(1, Number(filters.limit) || 50))
  return { runs, corrupt, shards: shards.length, events: events.length }
}

/** Rebuild the derived index from the shards. Files remain the truth. */
export function rebuildIndex(projectRoot) {
  const runs = readFamily(projectRoot, 'runs')
  const folds = foldRuns(runs.events)
  const indexDir = path.join(recordRoot(projectRoot), 'index')
  mkdirSync(indexDir, { recursive: true })
  const index = {
    schema: 'ffs-record-index/1',
    rebuiltAt: new Date().toISOString(),
    runs: folds,
    counts: { events: runs.events.length, runs: folds.length },
    corrupt: runs.corrupt,
  }
  const target = path.join(indexDir, 'runs.json')
  const tmp = `${target}.tmp`
  writeFileSync(tmp, `${JSON.stringify(index, null, 1)}\n`)
  renameSync(tmp, target)
  return { path: path.relative(projectRoot, target), counts: index.counts, corrupt: runs.corrupt }
}

/**
 * Import the pre-ledger files once. Event ids are deterministic and existing ids are skipped,
 * so a crash mid-import converges instead of duplicating attempts.
 */
export function migrateLegacy(projectRoot, { now = new Date().toISOString() } = {}) {
  const migrations = path.join(recordRoot(projectRoot), 'migrations')
  mkdirSync(migrations, { recursive: true })
  const doneFile = path.join(migrations, 'import-v0.done')
  if (existsSync(doneFile)) return { skipped: true, imported: 0 }
  const startedFile = path.join(migrations, 'import-v0.started')
  if (!existsSync(startedFile)) writeFileSync(startedFile, `${JSON.stringify({ at: now })}\n`)

  const existing = new Set(readFamily(projectRoot, 'runs').events.map((event) => event.id))
  const sources = [
    { id: 'analysis-run', file: path.join(projectRoot, 'work', 'ffs-analysis-run.json'), mode: 'run' },
    { id: 'tool-runs', file: path.join(projectRoot, 'work', 'ffs-tool-runs.json'), mode: 'tool' },
    { id: 'replays', file: path.join(projectRoot, 'work', 'ffs-replays.json'), mode: 'replay' },
  ]
  let imported = 0
  for (const source of sources) {
    if (!existsSync(source.file)) continue
    let parsed
    try {
      parsed = JSON.parse(readFileSync(source.file, 'utf8'))
    } catch {
      continue
    }
    const records = Array.isArray(parsed) ? parsed : [parsed]
    records.forEach((record, ordinal) => {
      const id = `evt-migrate-v0-${source.id}-${ordinal}`
      if (existing.has(id)) return
      const runId = `run-migrate-${source.id}-${ordinal}`
      appendEvent(projectRoot, 'runs', {
        id,
        at: record?.at || record?.finishedAt || record?.startedAt || now,
        type: 'run.imported',
        actor: { kind: 'unknown', reason: 'legacy-import' },
        links: { run: runId },
        payload: {
          mode: source.mode,
          source: path.relative(projectRoot, source.file),
          record,
        },
      })
      existing.add(id)
      imported += 1
    })
  }

  // Panel decisions lived in the project state before the ledger existed. Import them once,
  // preserving the record verbatim and marking the actor as unattributed.
  const decisionIds = new Set(readFamily(projectRoot, 'decisions').events.map((event) => event.id))
  const projectFile = path.join(projectRoot, 'work', 'ffs-analysis-project.json')
  if (existsSync(projectFile)) {
    let project = null
    try { project = JSON.parse(readFileSync(projectFile, 'utf8')) } catch { project = null }
    const decisions = Array.isArray(project?.decisions) ? project.decisions : []
    decisions.forEach((decision, ordinal) => {
      const id = `evt-migrate-v0-decision-${ordinal}`
      if (decisionIds.has(id)) return
      appendEvent(projectRoot, 'decisions', {
        id,
        at: decision?.at || now,
        type: 'decision.imported',
        actor: { kind: 'unknown', reason: 'legacy-project-state' },
        links: { decision: decision?.id || `decision-migrate-${ordinal}` },
        payload: { version: 1, source: 'legacy-project-state', decision },
      })
      decisionIds.add(id)
      imported += 1
    })
  }
  writeFileSync(doneFile, `${JSON.stringify({ at: now, imported })}\n`)
  return { skipped: false, imported }
}

export function recordStats(projectRoot) {
  const families = {}
  const corrupt = []
  for (const family of FAMILIES) {
    const read = readFamily(projectRoot, family)
    families[family] = { events: read.events.length, shards: read.shards.length }
    corrupt.push(...read.corrupt.map((item) => ({ ...item, family })))
  }
  return { root: RECORD_DIR, families, corrupt: corrupt.length > 0 ? corrupt : [] }
}

/** True when the record layer should append (a project env can turn it off). */
export function recordingEnabled(env = process.env) {
  return String(env.FFS_RECORD || '').toLowerCase() !== 'off'
}

export function newRunId(prefix = 'run') {
  return `${prefix}-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-')}-${randomUUID().slice(0, 6)}`
}

export function shardBytes(projectRoot, family) {
  const dir = familyDir(projectRoot, family)
  if (!existsSync(dir)) return 0
  return readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
    .reduce((total, name) => total + statSync(path.join(dir, name)).size, 0)
}

export { SHARD_LIMIT_BYTES }
