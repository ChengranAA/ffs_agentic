#!/usr/bin/env node
/**
 * Smoke-check the analysis panel's new autoproc API against the real Host half.
 *
 * It mounts `apply()` with a minimal Cordis stand-in, captures the registered
 * `/ffs-analysis` route, and exercises the schema/pipeline/generate paths against the
 * bids-lite fixture. Project state and the smoke work dir are restored afterwards.
 *
 *   node scripts/check_pipeline_api.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../ffs-analysis-ui/index.js'
import { queryRuns, readFamily } from '../shared/record/store.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT_STATE = path.join(ROOT, 'work', 'ffs-analysis-project.json')
const PIPELINE_FILE = path.join(ROOT, 'work', 'ffs-pipeline.json')
const TOOL_RUNS_FILE = path.join(ROOT, 'work', 'ffs-tool-runs.json')
const RUN_STATE_FILE = path.join(ROOT, 'work', 'ffs-analysis-run.json')
const COHORT_PREFS_FILE = path.join(ROOT, 'work', 'ffs-cohort-include.json')
const COHORT_DECISIONS_FILE = path.join(ROOT, 'work', 'ffs-cohort-decisions.json')
const GROUP_STATE_FILE = path.join(ROOT, 'work', 'ffs-analysis-group.json')
const CLIENT_DIAG_FILE = path.join(ROOT, 'work', 'ffs-analysis-client-diag.json')
const INSPECTION_FILE = path.join(ROOT, '.ffs-viewer', 'inspection', 'insp-smoke-1234.jsonl')
const INSPECTION_BASELINE = path.join(ROOT, '.ffs-viewer', 'inspection', 'insp-smoke-1234.start.ffs')
const FAKE_SCRIPT = path.join(ROOT, 'work', '.smoke-pipeline', 'fake.sh')
const FAKE_LOG = path.join(ROOT, 'work', '.smoke-pipeline', 'fake.log')
const SETTLED_FILE = path.join(ROOT, 'work', 'ffs-analysis-settled.json')
const EXPORTS_DIR = path.join(ROOT, 'exports')
const RECORD_DIR = path.join(ROOT, 'work', 'ffs-record')
const RECORD_BACKUP = path.join(ROOT, 'work', '.ffs-record.smoke-backup')
const SMOKE_WORK = path.join(ROOT, 'work', '.smoke-pipeline')

let handler = null
const tools = new Map()
const ctx = {
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
  inject(deps, callback) {
    if (deps.includes('jobs')) {
      callback({ jobs: { attachController() { return () => {} } }, effect: ctx.effect })
      return
    }
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
assert.ok(handler, 'the /ffs-analysis route did not register')

function respond() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(chunk) { this.body = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk ?? '') },
  }
}

async function call(method, route, body) {
  const res = respond()
  const req = {
    method,
    url: `/ffs-analysis/${route}`,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  await handler(req, res)
  let parsed = null
  try { parsed = JSON.parse(res.body) } catch { /* text */ }
  return { status: res.status, body: parsed, text: res.body }
}

const backup = (file) => (existsSync(file) ? readFileSync(file) : null)
const restore = (file, content) => {
  if (content === null) rmSync(file, { force: true })
  else writeFileSync(file, content)
}

const savedProject = backup(PROJECT_STATE)
const savedPipeline = backup(PIPELINE_FILE)
const savedToolRuns = backup(TOOL_RUNS_FILE)
const savedRun = backup(RUN_STATE_FILE)
const savedSettled = backup(SETTLED_FILE)
const savedGroup = backup(GROUP_STATE_FILE)
const savedCohortPrefs = backup(COHORT_PREFS_FILE)
const savedCohortDecisions = backup(COHORT_DECISIONS_FILE)
const savedClientDiag = backup(CLIENT_DIAG_FILE)
const savedInspection = backup(INSPECTION_FILE)
const savedInspectionBaseline = backup(INSPECTION_BASELINE)
const exportsBefore = new Set(existsSync(EXPORTS_DIR) ? readdirSync(EXPORTS_DIR) : [])
const hadRecordDir = existsSync(RECORD_DIR)
if (hadRecordDir) {
  rmSync(RECORD_BACKUP, { recursive: true, force: true })
  renameSync(RECORD_DIR, RECORD_BACKUP)
}
let failed = false
try {
  const snapshotTool = tools.get('ffs_analysis_snapshot')
  assert.ok(snapshotTool, 'ffs_analysis_snapshot tool is not registered')
  const snapshotToolResult = JSON.parse(await snapshotTool.execute({}, {}))
  assert.equal(typeof snapshotToolResult.source, 'string')
  assert.equal(typeof snapshotToolResult.pipeline?.status !== 'undefined', true)

  const browse = await call('GET', 'browse?path=work')
  assert.equal(browse.status, 200, browse.text)
  assert.ok(Array.isArray(browse.body.entries))
  assert.equal(browse.body.path, 'work')
  assert.ok(browse.body.entries.every((entry) => typeof entry.path === 'string' && typeof entry.dir === 'boolean'))
  const outside = await call('GET', 'browse?path=..')
  assert.notEqual(outside.status, 200)
  const externalBrowse = await call('GET', `browse?path=${encodeURIComponent(path.join(ROOT, 'data/bids-demo'))}`)
  assert.equal(externalBrowse.status, 200, externalBrowse.text)
  assert.ok(path.isAbsolute(externalBrowse.body.path))
  assert.ok(externalBrowse.body.entries.every((entry) => path.isAbsolute(entry.path)))

  const diag = await call('POST', 'client-diag', {
    viewport: { width: 420, height: 880 },
    chain: [{ tag: 'DIV', className: 'ffa-root', height: 700, overflowY: 'hidden' }],
  })
  assert.equal(diag.status, 200, diag.text)
  assert.ok(existsSync(CLIENT_DIAG_FILE))
  assert.equal(JSON.parse(readFileSync(CLIENT_DIAG_FILE, 'utf8')).viewport.width, 420)

  const constraints = await call('GET', 'constraints?op=plan&facts=%7B%22subjectExists%22%3Afalse%7D')
  assert.equal(constraints.status, 200, constraints.text)
  assert.equal(constraints.body.allowed, false)
  assert.equal(constraints.body.failures[0].id, 'constraint-bids-subject')
  const constraintsOk = await call('GET', `constraints?op=plan&facts=${encodeURIComponent(JSON.stringify({ subjectExists: true, datasetDescription: true }))}`)
  assert.equal(constraintsOk.body.allowed, true)
  const manifestGate = await call('GET', `constraints?op=plan&facts=${encodeURIComponent(JSON.stringify({ subjectExists: true, datasetDescription: false }))}`)
  assert.ok(manifestGate.body.failures.some((entry) => entry.id === 'constraint-bids-manifest'))
  const runGate = await call('GET', `constraints?op=run&facts=${encodeURIComponent(JSON.stringify({ subjectExists: true, runActive: false, scriptExists: false }))}`)
  assert.ok(runGate.body.failures.some((entry) => entry.id === 'constraint-scripts-exist'))
  const settleGate = await call('GET', `constraints?op=settle&facts=${encodeURIComponent(JSON.stringify({ hasDecisions: true, runCompleted: false }))}`)
  assert.ok(settleGate.body.failures.some((entry) => entry.id === 'constraint-run-completed'))

  const schema = await call('GET', 'autoproc/schema')
  assert.equal(schema.status, 200, schema.text)
  const model = schema.body.model
  assert.deepEqual(model.totals, { flags: 174, groups: 12, recipes: 6, stages: 20, optsOverrides: 31 })
  console.log(`schema ok: ${model.totals.flags} flags, ${model.totals.groups} groups, ${model.totals.stages} stages, opts ${model.totals.optsOverrides}`)

  const initial = await call('GET', 'pipeline')
  assert.equal(initial.status, 200, initial.text)
  assert.equal(initial.body.stages.length, 20)
  assert.equal(initial.body.recipes.length, 6)
  assert.ok(initial.body.command.startsWith('ffs_autoproc '), initial.body.command)
  const included = initial.body.stages.filter((stage) => stage.included).length
  console.log(`pipeline ok: v${initial.body.version} recipe=${initial.body.pipeline.recipe} stages ${included}/20 included, migrated=${initial.body.migrated}`)

  const saved = await call('POST', 'pipeline', {
    pipeline: {
      scope: {
        bidsDir: 'data/bids-lite',
        subject: '001',
        session: [],
        task: [],
        workDir: 'work/.smoke-pipeline/sub-001',
      },
      recipe: 'bare_bones',
      overrides: {
        no_qc: true, device: 'cpu', moco_ref: 'first',
        moco_opts: '-cost lpa -twopass', glm_mask: 'brain', nordic_dof_adjust: false,
      },
    },
  })
  assert.equal(saved.status, 200, saved.text)
  assert.equal(saved.body.version, initial.body.version + 1)
  assert.equal(saved.body.validation.ok, true, JSON.stringify(saved.body.validation))
  assert.match(saved.body.command, /-recipe bare_bones/)
  assert.match(saved.body.command, /-no_qc/)
  assert.match(saved.body.command, /-device cpu/)
  assert.match(saved.body.command, /-moco_ref first/)
  assert.match(saved.body.command, /-moco_opts/)
  assert.match(saved.body.command, /-glm_mask brain/)
  assert.match(saved.body.command, /-no_nordic_dof_adjust/)
  assert.equal(saved.body.groups.length, 12)
  assert.ok(saved.body.flags.moco_opts)
  assert.equal(saved.body.flags.moco_opts.action, 'store')
  assert.ok(saved.body.stages.find((stage) => stage.id === 'stage09').included === false)
  console.log(`save ok: v${saved.body.version}, ${saved.body.stages.filter((s) => s.included).length}/20 stages, command length ${saved.body.command.length}`)

  const reloaded = await call('GET', 'pipeline')
  assert.equal(reloaded.body.version, saved.body.version)
  assert.ok(Array.isArray(reloaded.body.history) && reloaded.body.history.length >= 1)
  assert.equal(reloaded.body.history[0].version, saved.body.version)
  assert.equal(typeof reloaded.body.history[0].summary, 'string')
  assert.ok(reloaded.body.coverage && reloaded.body.coverage.complete, 'recipe coverage missing')
  assert.equal(typeof reloaded.body.coverage.complete.included, 'number')
  assert.equal(typeof reloaded.body.coverage.complete.total, 'number')
  assert.equal(reloaded.body.pipeline.scope.workDir, 'work/.smoke-pipeline/sub-001')

  mkdirSync(path.join(SMOKE_WORK, 'scripts'), { recursive: true })
  const commandScript = 'work/.smoke-pipeline/scripts/check.sh'
  writeFileSync(path.join(ROOT, commandScript), '#!/bin/bash\necho command-ok\n')
  const withCommands = {
    ...saved.body.pipeline,
    commands: [
      { id: 'c1', name: 'check', scriptPath: commandScript },
      { id: 'c2', name: 'info', argv: ['ffs_info', '-help'] },
    ],
  }
  const v3 = await call('POST', 'pipeline', { pipeline: withCommands })
  assert.equal(v3.status, 200, v3.text)
  assert.equal(v3.body.version, saved.body.version + 1)
  assert.equal(v3.body.commands.length, 2)
  assert.match(v3.body.commands[0].frozen.sha256, /^[0-9a-f]{64}$/)
  assert.equal(v3.body.commandValidation.ok, true)

  writeFileSync(path.join(ROOT, commandScript), '#!/bin/bash\necho changed\n')
  const stale = await call('POST', 'pipeline', { pipeline: v3.body.pipeline })
  assert.equal(stale.status, 409, stale.text)
  assert.equal(stale.body.error.code, 'pipeline-invalid')
  assert.ok(stale.body.error.details.errors.some((item) => item.code === 'command-script-changed'))

  const refrozen = await call('POST', 'pipeline', { pipeline: v3.body.pipeline, refreeze: true })
  assert.equal(refrozen.status, 200, refrozen.text)
  assert.notEqual(refrozen.body.commands[0].frozen.sha256, v3.body.commands[0].frozen.sha256)
  console.log(`commands ok: ${refrozen.body.commands.length} steps, script re-frozen (sha ${refrozen.body.commands[0].frozen.sha256.slice(0, 10)})`)

  const scratch = await call('POST', 'tool-run', {
    argv: ['python', '-c', 'print(42)'],
    cwd: 'work/.smoke-pipeline',
  })
  assert.equal(scratch.status, 200, scratch.text)
  assert.equal(scratch.body.exitCode, 0)
  assert.match(scratch.body.stdout, /42/)
  assert.ok(scratch.body.argv.includes('-c'))
  assert.equal(scratch.body.stdoutLines, 1)
  assert.equal(scratch.body.outputTruncated, false)
  const longScratch = await call('POST', 'tool-run', {
    argv: ['python3', '-c', 'print("\\n".join(str(i) for i in range(60)))'],
    cwd: 'work/.smoke-pipeline',
  })
  assert.equal(longScratch.status, 200, longScratch.text)
  assert.equal(longScratch.body.stdoutLines, 60)
  assert.equal(longScratch.body.outputTruncated, true)
  assert.ok(longScratch.body.stdout.split('\n').length <= 40)
  console.log(`scratch ok: exit ${scratch.body.exitCode}, ${scratch.body.durationMs} ms; truncation ${longScratch.body.stdoutLines}->${longScratch.body.stdout.split('\n').length}`)

  // End-to-end command phase: a trivial script stands in for autoproc; the saved commands
  // must run after it and be recorded in the run state.
  mkdirSync(SMOKE_WORK, { recursive: true })
  writeFileSync(FAKE_SCRIPT, '#!/bin/bash\necho fake-script-done\n')
  writeFileSync(RUN_STATE_FILE, JSON.stringify({ status: 'completed' }))
  writeFileSync(PROJECT_STATE, JSON.stringify({
    source: 'live',
    plannedAt: new Date().toISOString(),
    params: { subject: '001', bidsDir: 'data/bids-lite', recipe: 'bare_bones' },
    script: 'work/.smoke-pipeline/fake.sh',
    log: 'work/.smoke-pipeline/fake.log',
    workDir: 'work/.smoke-pipeline',
  }))
  const started = await call('POST', 'run')
  assert.equal(started.status, 200, started.text)
  let runState = null
  for (let tick = 0; tick < 150; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    runState = JSON.parse(readFileSync(RUN_STATE_FILE, 'utf8'))
    if (!['running', 'stopping', 'running-commands'].includes(runState.status)) break
  }
  assert.equal(runState.status, 'completed', JSON.stringify(runState))
  assert.equal(runState.commands.length, 2)
  assert.ok(runState.commands.every((command) => command.status === 'ok'), JSON.stringify(runState.commands))
  const logTextRun = readFileSync(FAKE_LOG, 'utf8')
  assert.match(logTextRun, /== command check:/)
  assert.match(logTextRun, /changed/)
  console.log(`run commands ok: 2/2 after the script · log ${path.basename(FAKE_LOG)}`)

  const ledger = queryRuns(ROOT, {})
  const recordedRun = ledger.runs.find((run) => run.mode === 'run' && run.status === 'completed')
  assert.ok(recordedRun, `no completed run in the record ledger: ${JSON.stringify(ledger.runs.map((run) => [run.mode, run.status]))}`)
  assert.equal(recordedRun.actor.kind, 'user')
  assert.equal(recordedRun.subject, '001')
  assert.equal(recordedRun.attempt, 1)
  assert.equal(recordedRun.commands.length, 2)
  assert.ok(ledger.runs.some((run) => run.mode === 'tool' && run.actor.kind === 'user'), 'tool attempt missing')
  console.log(`ledger ok: ${ledger.runs.length} attempts · run actor ${recordedRun.actor.kind} · attempt ${recordedRun.attempt}`)

  const decision = await call('POST', 'decisions', {
    action: 'tentative',
    target: { kind: 'qc', ref: 'sub-001:qc/fd.png', path: 'qc/fd.png' },
    reason: '',
    confidence: 'medium',
  })
  assert.equal(decision.status, 200, decision.text)
  assert.equal(decision.body.decision.rationale.unknown, true)
  assert.equal(decision.body.decision.confidence, 'medium')
  assert.equal(decision.body.decision.actor.kind, 'user')
  const decision2 = await call('POST', 'decisions', {
    action: 'accept',
    target: { kind: 'qc', ref: 'sub-001:qc/tsnr.png', path: 'qc/tsnr.png' },
    reason: 'stable tSNR across runs',
    confidence: 'high',
    evidence: {
      visual: [{
        sessionId: 'insp-smoke-1234', seq: 5, stateSha256: 'a'.repeat(64),
        coordinates: { space: 'voxel', ijk: [10, 20, 30] },
        display: { threshold: 2.3, colormap: 'redblue' },
      }],
    },
  })
  assert.equal(decision2.status, 200, decision2.text)
  assert.equal(decision2.body.decision.rationale.unknown, false)
  assert.equal(decision2.body.decision.evidence.visual.length, 1)
  assert.equal(decision2.body.decision.evidence.visual[0].inspection, 'insp-smoke-1234')
  assert.equal(decision2.body.decision.evidence.visual[0].seq, 5)
  assert.equal(decision2.body.summary.total, 2)
  const decisionEvents = readFamily(ROOT, 'decisions').events
  assert.equal(decisionEvents.length, 2)
  assert.ok(decisionEvents.every((event) => event.type === 'decision.recorded'))
  assert.ok(decisionEvents.every((event) => event.actor.kind === 'user'))
  assert.equal(decisionEvents[0].payload.decision.target.ref, 'sub-001:qc/fd.png')
  assert.equal(decisionEvents[1].payload.decision.rationale.unknown, false)
  assert.equal(decisionEvents[1].payload.decision.evidence.visual[0].stateSha256, 'a'.repeat(64))
  console.log(`decisions ok: ${decision2.body.summary.total} recorded (tentative + accepted) · ledger ${decisionEvents.length} events`)

  const revised = await call('POST', 'decisions', {
    decisionId: decision2.body.decision.id,
    action: 'accept',
    target: decision2.body.decision.target,
    reason: 'stable tSNR across runs, rechecked',
    confidence: 'high',
  })
  assert.equal(revised.status, 200, revised.text)
  assert.equal(revised.body.revised, true)
  assert.equal(revised.body.decision.version, 2)
  assert.equal(revised.body.decision.confidence, 'high')
  const revisedEvents = readFamily(ROOT, 'decisions').events
  assert.equal(revisedEvents.filter((event) => event.type === 'decision.revised').length, 1)
  console.log(`revision ok: v${revised.body.decision.version} · ledger ${revisedEvents.length} events`)

  // Preferences are derived outside the panel; an existing profile is advisory context for
  // the plan and must ship in the package.
  mkdirSync(path.join(RECORD_DIR, 'preferences'), { recursive: true })
  writeFileSync(path.join(RECORD_DIR, 'preferences', 'profile.json'), JSON.stringify({
    schema: 'ffs-record-profile/1',
    generatedAt: '2026-11-13T10:00:00Z',
    stats: { observed: 0, candidate: 1, established: 1 },
    evidence: { sessions: 9, weight: 8.1 },
    preferences: [
      { id: 'pref-alpha-0-4', version: 2, status: 'established', kind: 'preference', scope: 'project', scientific: false,
        appliesTo: { tasks: [], modalities: ['func'], stages: ['qc'] },
        recommendation: { action: 'use layer alpha near 0.4' }, evidence: { score: 1, sessions: 9 } },
      { id: 'pref-threshold-2-3', version: 1, status: 'candidate', kind: 'preference', scope: 'project', scientific: true,
        appliesTo: { tasks: [], modalities: ['func'], stages: ['qc'] },
        recommendation: { action: 'work at a display threshold near 2.3' }, evidence: { score: 0.9, sessions: 9 } },
    ],
  }))

  mkdirSync(path.dirname(INSPECTION_FILE), { recursive: true })
  writeFileSync(INSPECTION_FILE, [
    { schema: 'ffs-inspection/1', frame: 'session.start', seq: 1, sessionId: 'insp-smoke-1234', ts: '2026-11-13T10:00:00Z' },
    { schema: 'ffs-inspection/1', frame: 'session.baseline', seq: 2, sessionId: 'insp-smoke-1234', ts: '2026-11-13T10:00:00Z',
      path: '.ffs-viewer/inspection/insp-smoke-1234.start.ffs', sha256: 'b'.repeat(64), stateSha256: 'c'.repeat(64), bytes: 12 },
    { schema: 'ffs-inspection/1', frame: 'capture', seq: 3, sessionId: 'insp-smoke-1234', ts: '2026-11-13T10:00:02Z',
      stateSha256: 'a'.repeat(64), coordinates: { space: 'voxel', ijk: [10, 20, 30] } },
    { schema: 'ffs-inspection/1', frame: 'session.end', seq: 4, sessionId: 'insp-smoke-1234', ts: '2026-11-13T10:05:00Z' },
  ].map((frame) => JSON.stringify(frame)).join('\n') + '\n')
  writeFileSync(INSPECTION_BASELINE, 'SET_THEME dark\n')

  const preferenceRoute = await call('GET', 'preferences?task=localizer')
  assert.equal(preferenceRoute.status, 200, preferenceRoute.text)
  assert.equal(preferenceRoute.body.available, true)
  assert.equal(preferenceRoute.body.effective.rung, 'task-modality')
  assert.equal(preferenceRoute.body.applied.length, 1)
  assert.equal(preferenceRoute.body.applied[0].id, 'pref-alpha-0-4')
  console.log(`preferences ok: effective ${preferenceRoute.body.effective.rung} · applied ${preferenceRoute.body.applied.map((entry) => entry.id).join(', ')}`)

  mkdirSync(SMOKE_WORK, { recursive: true })
  const generated = await call('POST', 'pipeline/generate')
  assert.equal(generated.status, 200, generated.text)
  assert.match(generated.body.script, /proc_sub-001\.sh$/)
  assert.match(generated.body.scriptHead, /ffs_autoproc/)
  assert.ok(generated.body.stages >= 5, `only ${generated.body.stages} stages in the script`)
  assert.equal(generated.body.plan.length, 20)
  assert.match(generated.body.scriptSha256, /^[0-9a-f]{64}$/)
  console.log(`generate ok: ${generated.body.script} · ${generated.body.stages} script stages · sha ${generated.body.scriptSha256.slice(0, 12)}`)
  const generatedState = JSON.parse(readFileSync(PROJECT_STATE, 'utf8'))
  assert.equal(generatedState.preferencesUsed.length, 1)
  assert.equal(generatedState.preferencesUsed[0].id, 'pref-alpha-0-4')
  assert.equal(generatedState.preferencesUsed[0].rung, 'task-modality')

  const ledgerAfterPlan = queryRuns(ROOT, {})
  const planAttempt = ledgerAfterPlan.runs.find((run) => run.mode === 'plan')
  assert.ok(planAttempt, 'plan attempt missing after generate')
  assert.equal(planAttempt.status, 'completed')
  assert.equal(planAttempt.actor.kind, 'user')
  assert.ok(planAttempt.outputs.length >= 1)

  // Settle gate: one tentative decision is still open, so settle must refuse until acknowledged.
  mkdirSync(path.join(SMOKE_WORK, 'sub-001'), { recursive: true })
  writeFileSync(path.join(SMOKE_WORK, 'sub-001', 'proc_sub-001.log'), 'smoke autoproc log\n')

  const gated = await call('POST', 'settle', {})
  assert.equal(gated.status, 409, gated.text)
  assert.equal(gated.body.error.code, 'open-decisions')
  assert.equal(gated.body.error.details.open.length, 1)
  const settled = await call('POST', 'settle', { acknowledge: true, note: 'smoke: acknowledged open decisions' })
  assert.equal(settled.status, 200, settled.text)
  assert.equal(settled.body.decisions.open, 1)
  assert.ok(settled.body.decisions.acknowledgedId)
  assert.equal(settled.body.project.preferencesUsed.length, 1)
  assert.equal(settled.body.project.preferencesUsed[0].id, 'pref-alpha-0-4')
  console.log(`settle gate ok: ${gated.body.error.details.open.length} open acknowledged · ${settled.body.id}`)

  const decisionLedger = readFamily(ROOT, 'decisions').events
  assert.equal(decisionLedger.length, 4)
  assert.equal(decisionLedger.filter((event) => event.type === 'decision.recorded').length, 3)
  assert.equal(decisionLedger.filter((event) => event.type === 'decision.revised').length, 1)

  // Package additions: decisions/pipeline/commands/preferences must ship in the export.
  const exported = await call('POST', 'export')
  assert.equal(exported.status, 200, exported.text)
  const packageDir = path.join(ROOT, exported.body.path)
  const readPackage = (name) => readFileSync(path.join(packageDir, name), 'utf8')
  const decisionsJson = JSON.parse(readPackage('decisions.json'))
  const pipelineJson = JSON.parse(readPackage('pipeline.json'))
  const commandsJson = JSON.parse(readPackage('commands.json'))
  const manifest = JSON.parse(readPackage('manifest.json'))
  assert.equal(decisionsJson.length, 3)
  assert.equal(decisionsJson[1].evidence.visual[0].inspection, 'insp-smoke-1234')
  const preferencesJson = JSON.parse(readFileSync(path.join(packageDir, 'preferences.json'), 'utf8'))
  assert.equal(preferencesJson.preferences.length, 2)
  assert.ok(readFileSync(path.join(packageDir, 'METHODS.md'), 'utf8').includes('Preferences considered'))
  assert.equal(pipelineJson.recipe, 'bare_bones')
  assert.equal(commandsJson.length, 2)
  assert.equal(manifest.decisions.total, 3)
  assert.equal(manifest.commands.length, 2)
  assert.ok(manifest.pipeline)
  assert.equal(manifest.decisionGate.open, 1)
  assert.equal(manifest.preferences.count, 2)
  assert.equal(manifest.preferences.stats.established, 1)
  assert.equal(manifest.preferencesUsed.length, 1)
  assert.equal(manifest.preferencesUsed[0].id, 'pref-alpha-0-4')
  assert.ok(manifest.decisionGate.acknowledgedId)
  assert.match(readPackage('STEPS.md'), /## Decisions/)
  assert.match(readPackage('STEPS.md'), /## Post-processing commands/)
  assert.match(readPackage('STEPS.md'), /## Record/)
  assert.match(readPackage('METHODS.md'), /## Record and audit trail/)
  assert.equal(manifest.record.counts.decisions.records, 3)
  assert.equal(manifest.record.counts.tombstones, 0)
  assert.deepEqual(manifest.record.counts.inspection.citedSessions, ['insp-smoke-1234'])
  assert.ok(existsSync(path.join(packageDir, 'record', 'runs')))
  assert.ok(existsSync(path.join(packageDir, 'record', 'decisions')))
  assert.ok(existsSync(path.join(packageDir, 'record', 'preferences', 'profile.json')))
  assert.ok(existsSync(path.join(packageDir, 'record', 'inspection', 'insp-smoke-1234.jsonl')))
  assert.ok(existsSync(path.join(packageDir, 'record', 'inspection', 'insp-smoke-1234.start.ffs')))
  assert.ok(readPackage('README.md').includes('record/'))
  assert.ok(readPackage('README.md').includes('inputs.json'))
  assert.ok(existsSync(path.join(packageDir, 'logs', 'run.log')))
  assert.equal(readFileSync(path.join(packageDir, 'logs', 'run.log'), 'utf8'), 'smoke autoproc log\n')
  const inputsJson = JSON.parse(readPackage('inputs.json'))
  assert.ok(inputsJson.count >= 8, `only ${inputsJson.count} input files hashed`)
  assert.equal(inputsJson.files.length, inputsJson.count)
  assert.ok(inputsJson.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)))
  assert.equal(manifest.inputs.count, inputsJson.count)
  assert.equal(manifest.logs.run.path, 'logs/run.log')
  assert.equal(manifest.logs.run.sha256, manifest.logs.run.sha256.toLowerCase())
  assert.match(readPackage('METHODS.md'), /## Data and inputs/)
  assert.match(readPackage('METHODS.md'), /## Artifact statuses/)
  assert.match(readPackage('METHODS.md'), /## What the checks look for/)
  assert.match(readPackage('METHODS.md'), /## Overrides/)
  assert.match(readPackage('METHODS.md'), /## Provenance/)
  const provenance = JSON.parse(readPackage('provenance.json'))
  assert.equal(provenance.schema, 'ffs-analysis-provenance/1')
  assert.equal(provenance.outputs.length, manifest.artifacts.length)
  assert.ok(provenance.outputs.every((output) => output.derivedFrom.script === 'frozen/proc_sub-001.sh'))
  assert.ok(provenance.outputs.every((output) => output.derivedFrom.inputs === 'inputs.json'))
  assert.ok(provenance.outputs.every((output) => output.derivedFrom.run === provenance.run.id))
  assert.equal(provenance.inputs.count, inputsJson.count)
  assert.equal(manifest.provenance.outputs, provenance.outputs.length)
  let recordCheck
  try {
    recordCheck = execFileSync(path.join(ROOT, '.venv', 'bin', 'python'), [
      path.join(packageDir, 'verify', 'record_check.py'), packageDir,
    ], { encoding: 'utf8' })
  } catch (error) {
    throw new Error(`record check failed: ${error.stdout || ''} ${error.stderr || error.message}`)
  }
  assert.match(recordCheck, /record\/package consistency: ok/)
  assert.ok(existsSync(path.join(packageDir, 'verify', 'record_check.py')))
  const verifyOutput = execFileSync('bash', [path.join(packageDir, 'verify.sh')], { encoding: 'utf8' })
  assert.match(verifyOutput, /checksums: ok/)
  assert.match(verifyOutput, /record\/package consistency: ok/)
  const checksCsv = readPackage('tables/checks.csv').trim().split('\n')
  assert.match(checksCsv[0], /check,kind,why,failure/)
  assert.ok(checksCsv.length >= 5)
  assert.ok(manifest.checks && manifest.checks.count === checksCsv.length - 1)
  const artifactsCsv = readPackage('tables/artifacts.csv').trim().split('\n')
  assert.match(artifactsCsv[0], /name,kind,status,stage,sha256,explanation/)
  assert.ok(artifactsCsv.length > 1)
  assert.ok(manifest.artifacts.length >= 1)
  assert.ok(manifest.artifacts.every((artifact) => artifact.status && artifact.explanation))
  assert.ok(manifest.artifactStatus && Object.keys(manifest.artifactStatus).length >= 1)
  const snapshotWithArtifacts = await call('GET', 'snapshot')
  assert.ok(snapshotWithArtifacts.body.artifacts.every((artifact) => artifact.status && artifact.explanation))
  const scriptArtifact = (snapshotWithArtifacts.body.artifacts || []).find((artifact) => artifact.kind === 'script' || /\.sh$/.test(artifact.name))
  assert.ok(scriptArtifact, 'no script artifact in the snapshot')
  const preview = await call('GET', `artifact-text?path=${encodeURIComponent(scriptArtifact.path)}`)
  assert.equal(preview.status, 200, preview.text)
  assert.ok(preview.body.text.includes('#!'), 'script preview did not include the shebang')
  assert.ok(preview.body.lines > 1)
  assert.equal(preview.body.path.endsWith('.sh'), true)
  const missingPreview = await call('GET', `artifact-text?path=${encodeURIComponent('/no/such/file.sh')}`)
  assert.equal(missingPreview.status, 404)

  const pipelineWithExplain = await call('GET', 'pipeline')
  assert.ok(pipelineWithExplain.body.stages.some((stage) => stage.explanation?.why && stage.explanation?.failure))
  assert.match(readPackage('METHODS.md'), /## Judgment calls/)
  const verified = await call('POST', 'verify', { dir: exported.body.path })
  assert.equal(verified.status, 200, verified.text)
  assert.equal(verified.body.ok, true)
  assert.ok(verified.body.checked >= 770, `only ${verified.body.checked} files checked`)
  console.log(`package ok: ${exported.body.files} files · decisions ${manifest.decisions.total} · acknowledged ${manifest.decisionGate.open} · commands ${manifest.commands.length} · checksums ${verified.body.checked}/ok`)

  // Cohort membership is a decision: excluding and re-including subjects must be recorded.
  const excluded = await call('POST', 'cohort', { action: 'include', subject: '001', include: false, reason: 'motion outlier' })
  assert.equal(excluded.status, 200, excluded.text)
  const excludedSubject = (excluded.body.cohort.subjects || []).find((subject) => subject.subject === '001')
  assert.equal(excludedSubject.include, false)
  const reincluded = await call('POST', 'cohort', { action: 'include', subject: '001', include: true })
  assert.equal(reincluded.status, 200, reincluded.text)
  const includedSubject = (reincluded.body.cohort.subjects || []).find((subject) => subject.subject === '001')
  assert.equal(includedSubject.include, true)
  const stateAfterCohort = JSON.parse(readFileSync(PROJECT_STATE, 'utf8'))
  const cohortDecisions = stateAfterCohort.decisions.filter((decision) => decision.target?.kind === 'cohort')
  assert.equal(cohortDecisions.length, 2)
  assert.equal(cohortDecisions[0].action, 'reject')
  assert.equal(cohortDecisions[0].rationale.text, 'motion outlier')
  assert.equal(cohortDecisions[0].actor.kind, 'user')
  assert.equal(cohortDecisions[0].evidence.include, false)
  assert.equal(cohortDecisions[1].action, 'accept')
  assert.equal(cohortDecisions[1].rationale.unknown, true)
  const cohortLedger = readFamily(ROOT, 'decisions').events.filter((event) => event.payload?.decision?.target?.kind === 'cohort')
  assert.equal(cohortLedger.length, 2)
  assert.equal(cohortLedger[0].payload.decision.evidence.include, false)
  console.log(`cohort decisions ok: ${cohortDecisions.length} recorded (exclude + include) · ledger ${cohortLedger.length} events`)

  // Preserve-composition: an externally edited script can be imported as a recorded attempt
  // and promoted to a frozen command step (nothing is executed by the import).
  const manualScript = path.join(SMOKE_WORK, 'manual.sh')
  const manualLog = path.join(SMOKE_WORK, 'manual.log')
  writeFileSync(manualScript, '#!/usr/bin/env bash\necho manual step\n')
  writeFileSync(manualLog, 'manual output line\n')
  const imported = await call('POST', 'import-script', {
    script: 'work/.smoke-pipeline/manual.sh', log: 'work/.smoke-pipeline/manual.log',
    note: 'edited by hand while exploring', promote: true,
  })
  assert.equal(imported.status, 200, imported.text)
  assert.match(imported.body.script.sha256, /^[0-9a-f]{64}$/)
  assert.equal(imported.body.promoted.scriptPath, 'work/.smoke-pipeline/manual.sh')
  assert.ok(imported.body.log.lines >= 1)
  const importedLedger = readFamily(ROOT, 'runs').events
    .filter((event) => event.type === 'run.imported' && event.payload?.mode === 'manual')
  assert.equal(importedLedger.length, 2)
  assert.equal(importedLedger[0].actor.kind, 'user')
  assert.equal(importedLedger[0].payload.imported.script.sha256, imported.body.script.sha256)
  const pipelineAfterImport = await call('GET', 'pipeline')
  assert.equal(pipelineAfterImport.body.commands.length, 3)
  assert.equal(pipelineAfterImport.body.commands[2].scriptPath, 'work/.smoke-pipeline/manual.sh')
  assert.equal(pipelineAfterImport.body.commandValidation.errors.length, 0)
  console.log('import script ok: hashed + logged attempt · promoted command step')

  // Interactive shell history can be imported explicitly; credential-looking lines are skipped.
  const historyFile = path.join(SMOKE_WORK, 'history.txt')
  writeFileSync(historyFile, [
    'ls -la',
    'TOKEN=super-secret ffs_info',
    ': 1700000000:0;ffs_info -h',
  ].join('\n') + '\n')
  const importedHistory = await call('POST', 'import-history', {
    file: 'work/.smoke-pipeline/history.txt', note: 'commands typed while exploring',
  })
  assert.equal(importedHistory.status, 200, importedHistory.text)
  assert.equal(importedHistory.body.count, 2)
  assert.equal(importedHistory.body.skippedForSecrets, 1)
  assert.ok(importedHistory.body.commands.includes('ffs_info -h'))
  const historyLedger = readFamily(ROOT, 'runs').events
    .filter((event) => event.type === 'run.imported' && event.payload?.mode === 'shell-history')
  assert.equal(historyLedger.length, 1)
  assert.equal(historyLedger[0].actor.kind, 'user')
  assert.ok(!JSON.stringify(historyLedger[0]).includes('TOKEN='), 'credential-looking command was recorded')
  assert.equal(historyLedger[0].payload.imported.file.path, 'work/.smoke-pipeline/history.txt')
  console.log('import history ok: 2 commands · 1 credential-looking line skipped')

  // Override taxonomy: a standard departure needs a reason, constraints are refused, and the
  // departure is labeled in the decision, ledger and a re-exported package.
  const overrideTarget = { kind: 'qc', ref: 'sub-001:qc/override.png', path: 'qc/override.png' }
  const standard = await call('POST', 'decisions', {
    action: 'accept', target: overrideTarget,
    reason: 'kept a wider threshold to cover boundary coverage',
    decisionKind: 'standard', overrideRef: 'qc/override.png',
  })
  assert.equal(standard.status, 200, standard.text)
  assert.equal(standard.body.decision.decisionKind, 'standard')
  assert.equal(standard.body.decision.override.kind, 'standard')
  assert.equal(standard.body.decision.override.authority, 'user')
  assert.equal(standard.body.summary.overrides, 1)
  const unreasoned = await call('POST', 'decisions', {
    action: 'accept', target: { kind: 'qc', ref: 'sub-001:qc/override2.png' }, decisionKind: 'standard',
  })
  assert.equal(unreasoned.status, 400, unreasoned.text)
  assert.equal(unreasoned.body.error.code, 'decision-invalid')
  const refused = await call('POST', 'decisions', {
    action: 'accept', target: { kind: 'qc', ref: 'sub-001:qc/override3.png' },
    reason: 'trying to override a constraint', decisionKind: 'constraint',
  })
  assert.equal(refused.status, 409, refused.text)
  assert.equal(refused.body.error.code, 'decision-constraint')

  const overrideState = JSON.parse(readFileSync(PROJECT_STATE, 'utf8'))
  const overrideDecision = overrideState.decisions.find((decision) => decision.target?.ref === 'sub-001:qc/override.png')
  assert.equal(overrideDecision.override.kind, 'standard')
  const overrideLedger = readFamily(ROOT, 'decisions').events
    .filter((event) => event.payload?.decision?.override?.kind === 'standard')
  assert.equal(overrideLedger.length, 1)

  const overriddenExport = await call('POST', 'export')
  assert.equal(overriddenExport.status, 200, overriddenExport.text)
  const overrideDir = path.join(ROOT, overriddenExport.body.path)
  const overrideDecisions = JSON.parse(readFileSync(path.join(overrideDir, 'decisions.json'), 'utf8'))
  assert.ok(overrideDecisions.some((decision) => decision.override?.kind === 'standard'))
  assert.match(readFileSync(path.join(overrideDir, 'METHODS.md'), 'utf8'), /kept a wider threshold/)
  console.log('override taxonomy ok: standard departure reasoned · constraint refused (409) · package labeled')

  // Agent-facing pipeline edit tool: edits + validates + returns argv, never runs.
  const editTool = tools.get('ffs_pipeline_edit')
  assert.ok(editTool, 'ffs_pipeline_edit tool is not registered')
  const beforePipe = JSON.parse(readFileSync(PIPELINE_FILE, 'utf8'))
  const beforeEdit = beforePipe.version
  const edited = JSON.parse(await editTool.execute({ recipe: 'complete', overrides: { moco_ref: 'first' } }, {}))
  assert.equal(edited.ok, true)
  assert.equal(edited.version, beforeEdit + 1)
  assert.match(edited.command, /-moco_ref first/)
  assert.equal(edited.scope.subject, beforePipe.scope.subject)
  const removed = JSON.parse(await editTool.execute({ overrides: { moco_ref: null } }, {}))
  assert.doesNotMatch(removed.command, /-moco_ref first/)
  console.log(`pipeline edit tool ok: v${beforeEdit}→v${edited.version}, command resolved`)

  const promoted = await call('POST', 'pipeline/promote', {
    argv: ['ffs_info', '-nv'], cwd: 'work/.smoke-pipeline', name: 'ffs_info',
    origin: { kind: 'scratch', toolRunId: 'tool-smoke' },
  })
  assert.equal(promoted.status, 200, promoted.text)
  assert.ok(promoted.body.command.id)
  assert.equal(promoted.body.command.name, 'ffs_info')
  assert.equal(promoted.body.command.origin.toolRunId, 'tool-smoke')
  assert.ok(promoted.body.commandCount >= 1)
  const pipelineAfterPromote = await call('GET', 'pipeline')
  assert.ok(pipelineAfterPromote.body.pipeline.commands.some((command) => command.id === promoted.body.command.id))
  console.log(`promote route ok: ${promoted.body.commandCount} command step(s), v${promoted.body.version}`)

  // Operation-level standard gate: settling with no recorded QC judgment must be an explicit,
  // recorded standard departure (not a silent accept).
  const gateState = JSON.parse(readFileSync(PROJECT_STATE, 'utf8'))
  gateState.decisions = []
  writeFileSync(PROJECT_STATE, JSON.stringify(gateState))
  const noJudgment = await call('POST', 'settle', {})
  assert.equal(noJudgment.status, 409, noJudgment.text)
  assert.equal(noJudgment.body.error.code, 'standard-departure')
  assert.equal(noJudgment.body.error.details.standard, 'standard-qc-review')
  const gatedSettle = await call('POST', 'settle', {
    standardOverride: { reason: 'fixture has no QC figures to review' },
  })
  assert.equal(gatedSettle.status, 200, gatedSettle.text)
  assert.ok(gatedSettle.body.decisions.standardOverride)
  const afterGate = JSON.parse(readFileSync(PROJECT_STATE, 'utf8'))
  const departure = afterGate.decisions.find((decision) => decision.override?.kind === 'standard')
  assert.ok(departure)
  assert.equal(departure.target.ref, 'settle')
  assert.equal(departure.override.reason, 'fixture has no QC figures to review')
  console.log('operation gate ok: no-judgment settle refused (409) → recorded standard departure')

  // Clear analysis: requires explicit confirmation and backs the state up before removing it.
  const noConfirm = await call('POST', 'reset', {})
  assert.equal(noConfirm.status, 400, noConfirm.text)
  assert.equal(noConfirm.body.error.code, 'confirm-required')
  const cleared = await call('POST', 'reset', { confirm: true })
  assert.equal(cleared.status, 200, cleared.text)
  assert.ok(cleared.body.backup.startsWith('work/ffs-analysis-clear-'))
  assert.ok(cleared.body.cleared.includes('work/ffs-analysis-project.json'))
  assert.ok(existsSync(path.join(ROOT, cleared.body.backup)))
  assert.ok(!existsSync(PROJECT_STATE), 'project state was not cleared')
  rmSync(path.join(ROOT, cleared.body.backup), { recursive: true, force: true })
  console.log(`clear route ok: ${cleared.body.cleared.length} file(s) backed up and removed`)

  console.log('PASS pipeline api')
} catch (error) {
  failed = true
  console.error('FAIL pipeline api:', error?.message || error)
} finally {
  restore(PROJECT_STATE, savedProject)
  restore(PIPELINE_FILE, savedPipeline)
  restore(TOOL_RUNS_FILE, savedToolRuns)
  restore(RUN_STATE_FILE, savedRun)
  restore(SETTLED_FILE, savedSettled)
  restore(GROUP_STATE_FILE, savedGroup)
  restore(COHORT_PREFS_FILE, savedCohortPrefs)
  restore(COHORT_DECISIONS_FILE, savedCohortDecisions)
  restore(CLIENT_DIAG_FILE, savedClientDiag)
  restore(INSPECTION_FILE, savedInspection)
  restore(INSPECTION_BASELINE, savedInspectionBaseline)
  rmSync(SMOKE_WORK, { recursive: true, force: true })
  for (const name of existsSync(EXPORTS_DIR) ? readdirSync(EXPORTS_DIR) : []) {
    if (!exportsBefore.has(name)) rmSync(path.join(EXPORTS_DIR, name), { recursive: true, force: true })
  }
  rmSync(RECORD_DIR, { recursive: true, force: true })
  if (hadRecordDir) renameSync(RECORD_BACKUP, RECORD_DIR)
}
if (failed) process.exit(1)
