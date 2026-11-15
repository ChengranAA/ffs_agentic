#!/usr/bin/env node
/** Benchmark analysis (autoproc model/argv/stage-plan) and record (append/query/rebuild).
 * Writes work/benchmarks/analysis-record.json and prints a compact table. No repo state is kept. */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

import { appendEvent, queryRuns, readFamily, rebuildIndex, recordStats, foldRuns } from '../shared/record/store.js'
import { readSessionFile, readInspectionSessions } from '../shared/record/inspection.js'
import { presentationCommand, presentationPlan } from '../shared/record/presentation.js'
import { defaultPipeline, resolvePipelineArgv, stagePlan, validatePipeline } from '../ffs-analysis-ui/lib/pipeline.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PYTHON = path.join(ROOT, '.venv/bin/python')
const fmt = (ms) => `${ms.toFixed(2)} ms`

function measure(label, iterations, fn) {
  const started = performance.now()
  for (let i = 0; i < iterations; i += 1) fn(i)
  const elapsed = performance.now() - started
  return { label, iterations, totalMs: Number(elapsed.toFixed(2)), perOpMs: Number((elapsed / iterations).toFixed(3)) }
}

const results = { startedAt: new Date().toISOString(), analysis: [], record: [], viewer: [] }
const outDir = path.join(ROOT, 'work', 'benchmarks')
const file = path.join(outDir, 'analysis-record.json')
let previous = null
try { previous = JSON.parse(readFileSync(file, 'utf8')) } catch { previous = null }
const check = process.argv.includes('--check')

// ---------------------------------------------------------------- record benchmark
const tempRoot = mkdtempSync(path.join(tmpdir(), 'ffs-bench-record-'))
try {
  const events = 200
  const runIds = Array.from({ length: events }, (_, i) => `run-bench-${String(i).padStart(4, '0')}`)
  results.record.push(measure('append 200 run events', events, (i) => {
    appendEvent(tempRoot, 'runs', {
      type: i % 2 ? 'run.ended' : 'run.started',
      at: new Date(Date.now() + i).toISOString(),
      actor: { kind: 'agent', tool: 'bench' },
      links: { run: runIds[i] },
      payload: { runId: runIds[i], mode: 'bench', status: i % 2 ? 'completed' : 'running', subject: '001' },
    })
  }))
  results.record.push(measure('queryRuns(limit 50)', 100, () => queryRuns(tempRoot, { limit: 50 })))
  const family = readFamily(tempRoot, 'runs')
  results.record.push(measure('foldRuns(200)', 100, () => foldRuns(family.events)))
  results.record.push(measure('rebuildIndex()', 5, () => rebuildIndex(tempRoot)))
  results.record.push(measure('recordStats()', 20, () => recordStats(tempRoot)))
  results.record.push({ label: 'record facts', events: family.events.length, shards: family.shards.length, bytes: family.events.length ? undefined : 0 })
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

// ---------------------------------------------------------------- viewer benchmark
const viewerDir = mkdtempSync(path.join(tmpdir(), 'ffs-bench-viewer-'))
try {
  const inspectionDir = path.join(viewerDir, 'inspection')
  mkdirSync(inspectionDir, { recursive: true })
  const sessionId = 'insp-bench-0001'
  const frames = [{ frame: 'session.start', sessionId, ts: new Date().toISOString(), schema: 'ffs-inspection/1' }]
  for (let i = 0; i < 2000; i += 1) {
    frames.push({
      frame: 'event', seq: i + 1, ts: new Date(Date.now() + i).toISOString(),
      command: { line: `SET_IJK ${i % 40} ${i % 30} ${i % 20}`, category: i % 3 ? 'display' : 'navigation' },
      coordinates: { ijk: [i % 40, i % 30, i % 20] },
    })
  }
  frames.push({ frame: 'session.end', ts: new Date().toISOString() })
  const file = path.join(inspectionDir, `${sessionId}.jsonl`)
  writeFileSync(file, `${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`)
  results.viewer.push({ label: 'inspection frames', count: frames.length, bytes: JSON.stringify(frames).length })
  results.viewer.push(measure('readSessionFile(2000 frames)', 20, () => readSessionFile(file, { maxFrames: 500 })))
  results.viewer.push(measure('readInspectionSessions()', 20, () => readInspectionSessions(viewerDir, { maxFrames: 500 })))
  const record = {
    status: 'established', scientific: false, active: true, id: 'pref-bench',
    display: { colormap: 'redblue', alpha: 'linear' }, appliesTo: { modalities: ['func'], stages: ['qc'] },
  }
  results.viewer.push(measure('presentationCommand()', 10000, () => presentationCommand(record)))
  results.viewer.push(measure('presentationPlan()', 1000, () => presentationPlan({ schema: 'ffs-record-preferences/1', preferences: [record] })))
  const workspaceFile = path.join(ROOT, '.ffs-viewer', 'workspace.json')
  if (existsSync(workspaceFile)) {
    const raw = readFileSync(workspaceFile, 'utf8')
    results.viewer.push(measure('workspace.json parse', 500, () => JSON.parse(raw)))
    results.viewer.push({ label: 'workspace restore payload', bytes: raw.length })
  }
} finally {
  rmSync(viewerDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- analysis benchmark
let model = null
try {
  const raw = execFileSync(PYTHON, [path.join(ROOT, 'python/ffsviewer/autoproc_model.py')], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
    env: {
      ...process.env,
      PYTHONPATH: [path.join(ROOT, 'python'), path.join(ROOT, 'reference', 'fastfuncstuff'), process.env.PYTHONPATH || '']
        .filter(Boolean).join(path.delimiter),
    },
  })
  model = JSON.parse(raw)
  results.analysis.push({ label: 'autoproc model load', flags: model.totals?.flags, stages: model.totals?.stages, recipes: model.totals?.recipes })
} catch (error) {
  results.analysis.push({ label: 'autoproc model load', skipped: String(error?.message || error).split('\n')[0] })
}

if (model) {
  const detection = {
    runs: 4, sessions: 1, tasks: ['localizer'], fieldmaps: true, fieldmapGroups: 2,
    sliceTiming: true, phase: false, sbref: true, anat: true, subjects: ['01'],
  }
  const pipeline = defaultPipeline({ bidsDir: 'data/real/ds005165', subject: '01', session: ['01'], task: ['localizer'], workDir: 'work/ds005165/sub-01', recipe: 'complete' })
  const resolvePath = (rel) => `/project/${String(rel).replace(/^\.\//, '')}`
  const stage = model.stages?.[0]
  results.analysis.push(measure('stagePlan()', 500, () => stagePlan({ model, pipeline, detection })))
  results.analysis.push(measure('resolvePipelineArgv()', 500, () => resolvePipelineArgv({ pipeline, model, resolvePath })))
  results.analysis.push(measure('validatePipeline()', 500, () => validatePipeline({ pipeline, model, detection, subjectExists: true })))
  results.analysis.push({ label: 'analysis facts', flags: model.totals?.flags, stages: model.totals?.stages, firstStage: stage?.id, argv: resolvePipelineArgv({ pipeline, model, resolvePath }).args.length })
}

// ---------------------------------------------------------------- output
mkdirSync(outDir, { recursive: true })
const previousByName = new Map()
for (const group of ['analysis', 'record', 'viewer']) {
  for (const row of previous?.[group] || []) {
    if (row.iterations) previousByName.set(row.label, row.perOpMs)
  }
}
const deltas = []
let regressed = false
for (const group of ['analysis', 'record', 'viewer']) {
  for (const row of results[group]) {
    if (!row.iterations) continue
    const before = previousByName.get(row.label)
    if (before === undefined) continue
    const deltaPct = before > 0 ? ((row.perOpMs - before) / before) * 100 : 0
    const limit = Math.max(1, before * 3)
    const bad = row.perOpMs > limit
    if (bad) regressed = true
    deltas.push({ label: row.label, before, after: row.perOpMs, deltaPct: Number(deltaPct.toFixed(1)), regressed: bad })
  }
}
results.deltas = deltas
writeFileSync(file, `${JSON.stringify({ ...results, finishedAt: new Date().toISOString() }, null, 2)}\n`)
for (const row of deltas) {
  console.log(`  Δ ${row.label.padEnd(28)} ${row.before.toFixed(3)} → ${row.after.toFixed(3)} ms/op (${row.deltaPct >= 0 ? '+' : ''}${row.deltaPct}%)${row.regressed ? ' ⚠ regression' : ''}`)
}
for (const [group, rows] of Object.entries({ analysis: results.analysis, record: results.record, viewer: results.viewer })) {
  console.log(`${group}:`)
  for (const row of rows) {
    if (row.iterations) console.log(`  ${row.label.padEnd(28)} ${fmt(row.totalMs)} total · ${fmt(row.perOpMs)}/op (${row.iterations}×)`)
    else console.log(`  ${row.label.padEnd(28)} ${JSON.stringify(Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'label')))}`)
  }
}
console.log(`wrote ${path.relative(ROOT, file)}`)
if (check && regressed) {
  console.error('benchmark regression: at least one per-op metric exceeded max(1ms, 3× baseline)')
  process.exit(1)
}
