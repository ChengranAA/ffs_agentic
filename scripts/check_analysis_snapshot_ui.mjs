#!/usr/bin/env node
/** Render every analysis section against the live snapshot (or fixture fallback). */

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadClient, mount, findAll, textOf } from './lib/mini_react.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
globalThis.ResizeObserver = class { observe() {} disconnect() {} }
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)

// Load the Host route with a fake webServer so we get the same snapshot the panel sees.
const { apply } = await import(pathToFileURL(path.join(ROOT, 'ffs-analysis-ui/index.js')).href)
let handler = null
const ctx = {
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  tools: { register() { return () => {} } },
  inject(deps, callback) {
    if (deps.includes('jobs')) return
    if (deps.includes('webServer')) {
      callback({
        webServer: { register(route) { handler = route.handler; return () => {} } },
        connection: { admit: () => ({}) }, effect: ctx.effect,
      })
    }
  },
}
apply(ctx)
assert.ok(handler, 'analysis route did not register')
const response = { status: 0, body: '', writeHead(code) { this.status = code }, end(body) { this.body = String(body) } }
await handler({ method: 'GET', url: '/ffs-analysis/snapshot', headers: {} }, response)
assert.equal(response.status, 200, `snapshot route returned ${response.status}`)
const snap = JSON.parse(response.body)

const client = await loadClient(pathToFileURL(path.join(ROOT, 'ffs-analysis-ui/client.js')).href)
const test = client.__test || {}
const t = (key) => key
const sections = [
  ['DataSection', { snap, t, onLoad: () => {}, onCopy: () => {}, busy: false }],
  ['QcSection', { snap, t, onDecision: async () => ({ ok: true }), recordingDecision: false, onCapture: null }],
  ['ResultsSection', { snap, t, onInspect: () => {}, onApplyResults: () => {}, applyingResults: false }],
  ['CohortSection', {
    snap, t, onValidate: () => {}, validating: false, validation: null, onToggleInclude: () => {},
    onExport: () => {}, exporting: false, onCopy: () => {},
  }],
  ['GroupSection', { snap, t, onRunGroup: () => {}, runningGroup: false, onInspectGroup: () => {}, onCopy: () => {} }],
  ['ProvenanceSection', {
    snap, t, onSettle: () => {}, onExport: () => {}, onReplay: () => {}, onVerify: () => {},
    busyAction: null, replaying: false, replayResult: null, verifying: false, verifyResult: null, onCopy: () => {},
  }],
  ['SettingsSection', { snap, t, onApplyResults: () => {}, applyingResults: false }],
  ['PipelineSection', { snap, t, onCancel: () => {}, runningNow: false, busyRun: false }],
]
const failures = []
for (const [name, props] of sections) {
  const Section = test[name]
  if (!Section) { failures.push(`${name}: not exported`); continue }
  try {
    const instance = mount(Section, props)
    const text = textOf(instance.root)
    const nodes = findAll(instance.root, () => true).length
    assert.ok(text.length > 0 || nodes > 0, `${name}: rendered nothing`)
    console.log(`✔ ${name} · ${nodes} nodes · ${text.length} chars`)
  } catch (error) {
    failures.push(`${name}: ${error?.message || error}`)
    console.error(`✖ ${name}: ${error?.stack || error}`)
  }
}
assert.deepEqual(failures, [], `sections failed: ${failures.join('; ')}`)
console.log(`analysis snapshot ui ok: ${sections.length} sections from ${snap.source}`)
console.log('PASS analysis snapshot ui')
process.exit(0)
