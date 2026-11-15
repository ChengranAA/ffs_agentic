#!/usr/bin/env node
/** Record sections interaction smoke: runs filters, inspection controls/events. */

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadClient, mount, findButton, findAll, textOf } from './lib/mini_react.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const client = await loadClient(pathToFileURL(path.join(ROOT, 'ffs-record/client.js')).href)
const { RunsSection, InspectionSection } = client.__test || {}
assert.ok(RunsSection && InspectionSection, 'record section test exports missing')

const calls = []
globalThis.fetch = async (url) => {
  calls.push(String(url))
  const target = String(url)
  if (target.startsWith('/ffs-record/runs?')) {
    return { ok: true, json: async () => ({ ok: true, runs: [
      { runId: 'run-failed', mode: 'run', status: 'failed', actor: { kind: 'user' }, subject: '001' },
    ] }) }
  }
  if (target.startsWith('/ffs-record/inspection?session=')) {
    return { ok: true, json: async () => ({ ok: true, session: { recentFrames: [
      { seq: 7, frame: 'event', command: { line: 'SET_IJK 4 5 6' } },
    ] } }) }
  }
  throw new Error(`unexpected fetch: ${target}`)
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// --- runs filters
const runs = [
  { runId: 'run-ok', mode: 'run', status: 'completed', actor: { kind: 'user' }, subject: '001' },
  { runId: 'run-failed', mode: 'run', status: 'failed', actor: { kind: 'user' }, subject: '001' },
]
const runsInstance = mount(RunsSection, { runs })
const rowTexts = () => findAll(runsInstance.root, (node) => node.type === 'tr').map(textOf)
assert.ok(rowTexts().some((text) => text.includes('completed')), 'initial runs are not rendered')
const statusFilter = findAll(runsInstance.root, (node) => node.type === 'select'
  && node.props?.['aria-label'] === 'attempt status')[0]
assert.ok(statusFilter, 'status filter missing')
statusFilter.props.onChange({ target: { value: 'failed' } })
await tick()
assert.ok(calls.some((url) => url.includes('status=failed')), 'filter did not query the Host route')
assert.ok(rowTexts().some((text) => text.includes('failed')), 'filtered run missing')
assert.ok(!rowTexts().some((text) => text.includes('completed')), 'unfiltered run still rendered')

// --- inspection controls
let opened = 0
let toggled = 0
const inspection = {
  sessions: 1, events: 1, marks: 0, captures: 0, paused: false, live: true,
  recent: [{ sessionId: 'insp-smoke', startedAt: new Date().toISOString(), events: 1, marks: 0, captures: 0, frames: 3, paused: false, live: true }],
}
const inspectionInstance = mount(InspectionSection, {
  inspection, busy: false,
  onOpenViewer: () => { opened += 1 },
  onToggleRecording: () => { toggled += 1 },
  onDeleteEvidence: () => {}, onReplay: () => {},
})
findButton(inspectionInstance.root, 'Open in viewer').props.onClick()
assert.equal(opened, 1, 'Open in viewer did not fire')
findButton(inspectionInstance.root, 'Pause recording').props.onClick()
assert.equal(toggled, 1, 'Pause recording did not fire')
const eventsButton = findButton(inspectionInstance.root, 'Events')
assert.ok(eventsButton, 'Events action missing')
eventsButton.props.onClick()
await tick()
assert.ok(textOf(inspectionInstance.root).includes('SET_IJK 4 5 6'), 'bounded event list did not render')

console.log(`record sections interaction ok: ${calls.length} fetch · ${opened} open · ${toggled} toggle`)
console.log('PASS record sections interaction')
