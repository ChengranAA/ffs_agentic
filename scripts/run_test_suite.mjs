#!/usr/bin/env node
/** Unified test suite for analysis + record + viewer.
 *
 * Usage:
 *   node scripts/run_test_suite.mjs            # units + UI/API smokes + benchmark
 *   node scripts/run_test_suite.mjs --quick    # skip benchmark
 *   node scripts/run_test_suite.mjs --bench    # benchmark only
 *   node scripts/run_test_suite.mjs --no-bench # units + smokes
 *   node scripts/run_test_suite.mjs --check    # fail on benchmark regressions
 *
 * Writes work/test-suite-report.json. Exit code is non-zero if any step fails. */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PYTHON = path.join(ROOT, '.venv/bin/python')
const argv = new Set(process.argv.slice(2))
const onlyBench = argv.has('--bench')
const benchCheck = argv.has('--check')
const skipBench = argv.has('--quick') || argv.has('--no-bench') || onlyBench
const env = {
  ...process.env,
  PYTHONPATH: [path.join(ROOT, 'python'), path.join(ROOT, 'reference', 'fastfuncstuff'), process.env.PYTHONPATH || '']
    .filter(Boolean).join(path.delimiter),
}
const node = process.execPath
const jsTests = readdirSync(path.join(ROOT, 'tests')).filter((name) => name.endsWith('.mjs')).sort()
  .map((name) => path.join('tests', name))

const steps = []
if (!onlyBench) {
  steps.push({ name: 'unit-js', argv: [node, '--test', ...jsTests] })
  steps.push({ name: 'unit-python', argv: [PYTHON, '-m', 'unittest', 'discover', '-s', 'tests'] })
  steps.push({ name: 'ui-analysis-render', argv: [node, 'scripts/check_analysis_client.mjs'] })
  steps.push({ name: 'ui-analysis-qc', argv: [node, 'scripts/check_analysis_qc.mjs'] })
  steps.push({ name: 'ui-analysis-guide', argv: [node, 'scripts/check_analysis_guide.mjs'] })
  steps.push({ name: 'ui-analysis-sections', argv: [node, 'scripts/check_analysis_snapshot_ui.mjs'] })
  steps.push({ name: 'ui-analysis-nav', argv: [node, 'scripts/check_analysis_sections_nav.mjs'] })
  steps.push({ name: 'ui-record-render', argv: [node, 'scripts/check_record_client.mjs'] })
  steps.push({ name: 'ui-record-interaction', argv: [node, 'scripts/check_record_ui_interaction.mjs'] })
  steps.push({ name: 'ui-record-sections', argv: [node, 'scripts/check_record_sections_interaction.mjs'] })
  steps.push({ name: 'ui-viewer-render', argv: [node, 'scripts/check_viewer_client_render.mjs'] })
  steps.push({ name: 'api-pipeline', argv: [node, 'scripts/check_pipeline_api.mjs'] })
  steps.push({ name: 'api-record', argv: [node, 'scripts/check_record_api.mjs'] })
  steps.push({ name: 'api-inspection', argv: [PYTHON, 'scripts/check_inspection_api.py'] })
  steps.push({ name: 'api-viewer-preferences', argv: [node, 'scripts/check_viewer_preferences.mjs'] })
}
if (!skipBench) steps.push({ name: 'benchmark', argv: [node, 'scripts/bench_analysis_record.mjs', ...(benchCheck ? ['--check'] : [])] })

const report = { startedAt: new Date().toISOString(), steps: [] }
let failed = false
for (const step of steps) {
  const started = Date.now()
  process.stdout.write(`\n▶ ${step.name}\n`)
  const result = spawnSync(step.argv[0], step.argv.slice(1), {
    cwd: ROOT, env, encoding: 'utf8', timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
  })
  const durationMs = Date.now() - started
  const ok = result.status === 0
  if (!ok) failed = true
  const stdout = String(result.stdout || '')
  const stderr = String(result.stderr || '')
  const tail = (stdout + (stderr ? `\n${stderr}` : '')).trim().split('\n').slice(-12).join('\n')
  console.log(`${ok ? '✔' : '✖'} ${step.name} · ${(durationMs / 1000).toFixed(2)}s${ok ? '' : ` (exit ${result.status ?? 'timeout'})`}`)
  if (!ok && tail) console.log(tail)
  report.steps.push({ name: step.name, ok, durationMs, exitCode: result.status, tail: ok ? undefined : tail })
}
report.finishedAt = new Date().toISOString()
report.ok = !failed
const out = path.join(ROOT, 'work', 'test-suite-report.json')
mkdirSync(path.dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
const passed = report.steps.filter((step) => step.ok).length
console.log(`\n${failed ? 'FAIL' : 'PASS'} · ${passed}/${report.steps.length} steps · ${path.relative(ROOT, out)}`)
if (failed) process.exit(1)
