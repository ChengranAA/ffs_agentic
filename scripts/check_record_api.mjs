#!/usr/bin/env node
/**
 * Smoke-check the @local/ffs-record bundle: tool registration, snapshot, runs and rebuild.
 *
 * It mounts the plugin with a Cordis stand-in, writes one temporary ledger event, exercises
 * the tools and route, then restores `work/ffs-record/`.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../ffs-record/index.js'
import { appendEvent, queryRuns } from '../shared/record/store.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RECORD_DIR = path.join(ROOT, 'work', 'ffs-record')
const RECORD_BACKUP = path.join(ROOT, 'work', '.ffs-record.api-smoke-backup')
const INSPECTION_DIR = path.join(ROOT, '.ffs-viewer', 'inspection')
const INSPECTION_BACKUP = path.join(ROOT, '.ffs-viewer', '.inspection.api-smoke-backup')

let handler = null
const tools = new Map()
const ctx = {
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  tools: { register(definition) { tools.set(definition.name, definition); return () => {} } },
  inject(deps, callback) {
    if (deps.includes('webServer')) {
      callback({
        webServer: { register(route) { handler = route.handler; return () => {} } },
        connection: { admit() { return {} } },
        effect: ctx.effect,
      })
    }
  },
}
apply(ctx)
assert.ok(handler, 'the /ffs-record route did not register')
assert.ok(tools.has('ffs_record_query'))
assert.ok(tools.has('ffs_record_rebuild'))

function respond() {
  return {
    status: null,
    body: '',
    writeHead(status) { this.status = status },
    end(chunk) { this.body = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk ?? '') },
  }
}

async function call(method, route, body) {
  const res = respond()
  const req = {
    method,
    url: `/ffs-record/${route}`,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  await handler(req, res)
  let parsed
  try { parsed = JSON.parse(res.body) } catch { parsed = null }
  return { status: res.status, body: parsed }
}

const had = existsSync(RECORD_DIR)
if (had) {
  rmSync(RECORD_BACKUP, { recursive: true, force: true })
  renameSync(RECORD_DIR, RECORD_BACKUP)
}
const hadInspection = existsSync(INSPECTION_DIR)
if (hadInspection) {
  rmSync(INSPECTION_BACKUP, { recursive: true, force: true })
  renameSync(INSPECTION_DIR, INSPECTION_BACKUP)
}
mkdirSync(INSPECTION_DIR, { recursive: true })
const inspectionFrames = [
  { schema: 'ffs-inspection/1', frame: 'session.start', seq: 1, sessionId: 'insp-api-smoke', ts: '2026-11-13T09:00:00Z' },
  { schema: 'ffs-inspection/1', frame: 'session.baseline', seq: 2, sessionId: 'insp-api-smoke', ts: '2026-11-13T09:00:00Z',
    path: '.ffs-viewer/inspection/insp-api-smoke.start.ffs', sha256: 'd'.repeat(64), stateSha256: 'e'.repeat(64), bytes: 10 },
  { schema: 'ffs-inspection/1', frame: 'event', seq: 3, sessionId: 'insp-api-smoke', ts: '2026-11-13T09:00:01Z',
    command: { line: 'SET_IJK 1 2 3', name: 'SET_IJK', category: 'navigation' }, semantic: { kind: 'crosshair' } },
  { schema: 'ffs-inspection/1', frame: 'capture', seq: 4, sessionId: 'insp-api-smoke', ts: '2026-11-13T09:00:02Z',
    label: 'smoke', stateSha256: 'c'.repeat(64), coordinates: { space: 'voxel', ijk: [1, 2, 3] } },
  { schema: 'ffs-inspection/1', frame: 'session.end', seq: 5, sessionId: 'insp-api-smoke', ts: '2026-11-13T09:05:00Z' },
]
writeFileSync(path.join(INSPECTION_DIR, 'insp-api-smoke.jsonl'), `${inspectionFrames.map((frame) => JSON.stringify(frame)).join('\n')}\n`)
mkdirSync(path.join(RECORD_DIR, 'preferences', 'evidence'), { recursive: true })
for (const index of [1, 2, 3]) {
  writeFileSync(path.join(RECORD_DIR, 'preferences', 'evidence', `insp-${index}.json`), JSON.stringify({
    schema: 'ffs-record-features/1',
    sessionId: `insp-${index}`,
    project: { task: 'localizer', modality: 'func', stage: 'qc' },
    window: { from: '2026-11-13T09:00:00Z', to: '2026-11-13T10:00:00Z', durationS: 3600 },
    status: 'complete',
    restored: false,
    originCounts: { ui: 3 },
    behavioralWeight: 1,
    userEvents: 3,
    counts: { byCategory: { display: 3 }, byName: { SET_THRESHOLD: 1, SET_ALPHA: 1, SET_COLORMAP: 1 }, marks: 0 },
    settings: { thresholdsSet: [2.3], alphasSet: [0.4], colormaps: ['redblue'], viewsOpened: [], layersLoaded: [] },
  }))
}
execFileSync(path.join(ROOT, '.venv', 'bin', 'python'), [
  '-m', 'ffsrecord.cli', 'profile', '--project', ROOT, '--now', '2026-11-13T12:00:00+00:00', '--no-ingest',
], {
  cwd: ROOT,
  env: {
    ...process.env,
    PYTHONPATH: [path.join(ROOT, 'python'), path.join(ROOT, 'reference', 'fastfuncstuff'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  },
  timeout: 60000,
})
let failed = false
try {
  appendEvent(ROOT, 'runs', {
    type: 'run.started',
    actor: { kind: 'user', surface: 'analysis-tab' },
    links: { run: 'run-api-smoke' },
    payload: { mode: 'run', subject: '001', attempt: 1, script: { path: 'work/proc.sh' } },
  })
  appendEvent(ROOT, 'runs', {
    type: 'run.ended',
    links: { run: 'run-api-smoke' },
    payload: { status: 'completed', durationMs: 42, commands: [] },
  })

  appendEvent(ROOT, 'decisions', {
    type: 'decision.recorded',
    actor: { kind: 'user', surface: 'analysis-tab' },
    links: { decision: 'dec-api-smoke' },
    payload: { version: 1, decision: { id: 'dec-api-smoke', action: 'tentative', target: { kind: 'qc', ref: 'sub-001:qc/fd.png' } } },
  })
  appendEvent(ROOT, 'decisions', {
    type: 'decision.revised',
    actor: { kind: 'user', surface: 'analysis-tab' },
    links: { decision: 'dec-api-smoke' },
    payload: { version: 2, decision: { id: 'dec-api-smoke', action: 'accept', target: { kind: 'qc', ref: 'sub-001:qc/fd.png' } } },
  })

  const snapshot = await call('GET', 'snapshot')
  assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body))
  assert.equal(snapshot.body.families.runs.events, 2)
  assert.equal(snapshot.body.families.decisions.events, 2)
  assert.equal(snapshot.body.recentDecisions[0].action, 'accept')
  assert.equal(snapshot.body.recentDecisions[0].version, 2)
  assert.equal(snapshot.body.inspection.sessions, 1)
  assert.equal(snapshot.body.inspection.captures, 1)
  assert.equal(snapshot.body.inspection.recent[0].sessionId, 'insp-api-smoke')
  assert.equal(snapshot.body.preferences.count, 3)
  assert.equal(snapshot.body.preferences.stats.observed, 3)
  const decisionTool = JSON.parse(await tools.get('ffs_record_query').execute({ family: 'decisions', limit: 5 }))
  assert.equal(decisionTool.decisions.length, 1)
  assert.equal(decisionTool.decisions[0].status, 'recorded')
  assert.equal(snapshot.body.recentRuns.length, 1)
  assert.equal(snapshot.body.recentRuns[0].status, 'completed')

  const runs = await call('GET', 'runs?status=completed&limit=5')
  assert.equal(runs.status, 200)
  assert.equal(runs.body.runs.length, 1)

  const sessions = await call('GET', 'inspection')
  assert.equal(sessions.status, 200)
  assert.equal(sessions.body.sessions.length, 1)
  assert.equal(sessions.body.sessions[0].captures.length, 1)
  assert.equal(sessions.body.sessions[0].baseline.sha256, 'd'.repeat(64))
  const session = await call('GET', 'inspection?session=insp-api-smoke')
  assert.equal(session.status, 200)
  assert.equal(session.body.session.frames, 5)
  const inspectionTool = JSON.parse(await tools.get('ffs_record_query').execute({ family: 'inspection', limit: 5 }))
  assert.equal(inspectionTool.sessions.length, 1)
  assert.equal(inspectionTool.summary.captures, 1)

  const policyRoute = await call('GET', 'policy')
  assert.equal(policyRoute.status, 200, policyRoute.text)
  assert.ok(policyRoute.body.policy.constraints.length >= 3)
  assert.equal(policyRoute.body.policy.constraints[0].id, 'constraint-bids-subject')
  assert.ok(policyRoute.body.policy.standards.some((entry) => entry.id === 'standard-qc-review'))

  const policyDocument = policyRoute.body.policy
  policyDocument.constraints = [...(policyDocument.constraints || []), {
    id: 'constraint-smoke-inputs', text: 'Inputs must exist.', check: 'inputs-present', appliesTo: ['plan'],
  }]
  const policyWritten = await call('POST', 'policy', { policy: policyDocument })
  assert.equal(policyWritten.status, 200, policyWritten.text)
  assert.ok(policyWritten.body.policy.constraints.some((entry) => entry.id === 'constraint-smoke-inputs'))
  const policyReread = await call('GET', 'policy')
  assert.ok(policyReread.body.policy.constraints.some((entry) => entry.id === 'constraint-smoke-inputs'))
  const invalidPolicy = await call('POST', 'policy', { policy: { constraints: 'not-a-list', standards: [] } })
  assert.equal(invalidPolicy.status, 400, invalidPolicy.text)
  assert.equal(invalidPolicy.body.error.code, 'policy-invalid')

  const preferencesRoute = await call('GET', 'preferences')
  assert.equal(preferencesRoute.status, 200)
  assert.equal(preferencesRoute.body.profile.preferences.length, 3)
  const preferenceTool = JSON.parse(await tools.get('ffs_record_query').execute({ family: 'preferences', limit: 5 }))
  assert.equal(preferenceTool.preferences.length, 3)
  assert.equal(preferenceTool.preferences.find((record) => record.id === 'pref-threshold-2-3').scientific, true)
  assert.ok(tools.has('ffs_preference_confirm'))

  const toolResult = JSON.parse(await tools.get('ffs_record_query').execute({ family: 'runs', limit: 5 }))
  assert.equal(toolResult.ok, true)
  assert.equal(toolResult.runs.length, 1)

  const rebuilt = await call('POST', 'rebuild', { migrate: false })
  assert.equal(rebuilt.status, 200)
  assert.equal(rebuilt.body.rebuilt.counts.runs, 1)
  assert.ok(existsSync(path.join(RECORD_DIR, 'index', 'runs.json')))

  assert.equal(queryRuns(ROOT, {}).runs.length, 1)

  // User-only preference lifecycle: establish/retire/delete through the record route, plus the
  // agent request-only tool.
  const established = await call('POST', 'preferences/establish', {
    preferenceId: 'pref-threshold-2-3', reason: 'confirmed on three localizer runs',
  })
  assert.equal(established.status, 200, established.text)
  assert.equal(established.body.event.type, 'preference.established')
  assert.equal(established.body.preference.status, 'established')
  assert.equal(established.body.preference.confirmation.by, 'user')

  const request = JSON.parse(await tools.get('ffs_preference_confirm').execute({
    preferenceId: 'pref-alpha-0-4', note: 'do you always use a 0.4 overlay?',
  }))
  assert.equal(request.event.type, 'preference.confirmation-requested')
  const requestedProfile = JSON.parse(await tools.get('ffs_record_query').execute({ family: 'preferences', limit: 5 }))
  const requestedAlpha = requestedProfile.preferences.find((record) => record.id === 'pref-alpha-0-4')
  assert.equal(requestedAlpha.status, 'observed')
  assert.equal(requestedAlpha.confirmation.requested.by, 'agent')

  const denied = await call('POST', 'preferences/establish', {
    preferenceId: 'pref-alpha-0-4', actor: 'agent',
  })
  assert.equal(denied.status, 403, denied.text)
  assert.equal(denied.body.error.code, 'preference-user-only')

  const retired = await call('POST', 'preferences/retire', { preferenceId: 'pref-alpha-0-4', reason: 'not habitual' })
  assert.equal(retired.status, 200, retired.text)
  assert.equal(retired.body.preference.status, 'retired')
  const deleted = await call('POST', 'preferences/delete', { preferenceId: 'pref-threshold-2-3' })
  assert.equal(deleted.status, 200, deleted.text)
  const finalProfile = await call('GET', 'preferences')
  assert.equal(finalProfile.body.profile.preferences.length, 3)
  const deletedThreshold = finalProfile.body.profile.preferences.find((record) => record.id === 'pref-threshold-2-3')
  assert.equal(deletedThreshold.status, 'retired')
  assert.equal(deletedThreshold.active, false)
  const lifecycleEvents = readFileSync(path.join(RECORD_DIR, 'preferences', 'events.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lifecycleEvents.length, 4)
  console.log(`preference lifecycle ok: ${lifecycleEvents.length} events · establish user · request agent · retire · delete`)

  // R4 deletion: dry-run first, then exact subtraction with a tombstone.
  assert.ok(tools.has('ffs_preference_delete'))
  const plan = await call('POST', 'preferences/delete', { scope: { sessionId: 'insp-3' }, dryRun: true })
  assert.equal(plan.status, 200, plan.text)
  assert.equal(plan.body.dryRun, true)
  assert.deepEqual(plan.body.sessions, ['insp-3'])
  assert.ok(existsSync(path.join(RECORD_DIR, 'preferences', 'evidence', 'insp-3.json')))
  const toolPlan = JSON.parse(await tools.get('ffs_preference_delete').execute({ scope: { sessionId: 'insp-3' } }))
  assert.equal(toolPlan.dryRun, true)
  assert.deepEqual(toolPlan.sessions, ['insp-3'])
  const applied = await call('POST', 'preferences/delete', {
    scope: { sessionId: 'insp-3' }, reason: 'smoke: superseded run',
  })
  assert.equal(applied.status, 200, applied.text)
  assert.equal(applied.body.dryRun, false)
  assert.equal(applied.body.deleted, 1)
  assert.ok(!existsSync(path.join(RECORD_DIR, 'preferences', 'evidence', 'insp-3.json')))
  assert.equal(applied.body.profile.evidence.sessions, 2)
  const tombstones = readFileSync(path.join(RECORD_DIR, 'preferences', 'tombstones.jsonl'), 'utf8').trim().split('\n')
  assert.equal(tombstones.length, 1)
  const tombstone = JSON.parse(tombstones[0])
  assert.equal(tombstone.schema, 'ffs-record-tombstone/1')
  assert.deepEqual(tombstone.sessionIds, ['insp-3'])
  assert.equal(tombstone.counts.sessions, 1)
  assert.ok(!JSON.stringify(tombstone).includes('settings'), 'tombstone must not carry deleted content')
  console.log(`deletion ok: 1 shard · tombstone ${tombstone.id} · profile sessions ${applied.body.profile.evidence.sessions}`)

  console.log(`record api ok: ${tools.size} tools · runs ${snapshot.body.families.runs.events} · decisions ${snapshot.body.families.decisions.events} · inspection ${snapshot.body.inspection.sessions} · preferences lifecycle+deletion · index rebuilt`)
  console.log('PASS record api')
} catch (error) {
  failed = true
  console.error('FAIL record api:', error?.stack || error?.message || error)
} finally {
  rmSync(RECORD_DIR, { recursive: true, force: true })
  if (had) renameSync(RECORD_BACKUP, RECORD_DIR)
  rmSync(INSPECTION_DIR, { recursive: true, force: true })
  if (hadInspection) renameSync(INSPECTION_BACKUP, INSPECTION_DIR)
}
if (failed) process.exit(1)
