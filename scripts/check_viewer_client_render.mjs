#!/usr/bin/env node
/** Viewer client render smoke: mounts ViewerBody against a stub bridge. */

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadClient, mount, findButton, findAll, textOf } from './lib/mini_react.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  disconnect() {}
}
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)

const state = {
  schema: 'ffs-viewer-state/1', rev: 3, showSeq: 0, notice: null,
  grid: { shape: [64, 64, 40], voxelMm: 2 }, layers: [{
    key: 'l1', name: 'bench layer', visible: true, opacity: 1, colormap: 'hot',
    threshold: 0, rangeLo: 0, rangeHi: 10, nVolumes: 1, labels: ['vol 0'],
  }], selected: 'l1', crosshair: [32, 32, 20], crosshairMm: [64, -64, 40],
  timeIndex: 0, maxTimeIndex: 0, surfaces: null, workspace: null,
  viewports: [{ id: 'V1', kind: 'image', title: 'V1', slice: 0, layer: null, zoom: 1 }],
  inspection: { active: true, paused: false, seq: 5, sessionId: 'insp-smoke', path: '.ffs-viewer/inspection/insp-smoke.jsonl' },
  status: 'idle',
}
const client = await loadClient(pathToFileURL(path.join(ROOT, 'ffs-harness-viewer/client.js')).href)
const ViewerBody = client.__test?.ViewerBody
assert.ok(ViewerBody, 'ViewerBody test export missing')

const calls = []
const ctx = {
  get(name) {
    if (name === 'connection') return { rpc: { call: async (bridge, endpoint, payload) => {
      calls.push({ endpoint, payload })
      return { ok: true, value: state }
    } } }
    if (name === 'sidebarRight') return { openTab() {} }
    return undefined
  },
}
const instance = mount(ViewerBody, { ctx, t: (key) => key })
await new Promise((resolve) => setTimeout(resolve, 20))
const rendered = textOf(instance.root)
assert.ok(rendered.length > 0, 'viewer rendered nothing')
const buttons = findAll(instance.root, (node) => node.type === 'button')
if (!buttons.length) console.log('rendered:', rendered.slice(0, 500))
assert.ok(buttons.length > 0, 'viewer rendered no controls')

// Mount the control rail directly so nested component buttons are inspectable.
const ControlRail = client.__test?.ControlRail
assert.ok(ControlRail, 'ControlRail test export missing')
const railCalls = []
const rail = mount(ControlRail, {
  snapshot: state, dispatch: () => {}, busy: false, t: (key) => key,
  run: (endpoint, payload) => { railCalls.push({ endpoint, payload }); return Promise.resolve({}) },
  onOpenPicker: () => {}, onClose: () => {},
})
const pause = findButton(rail.root, 'Pause rec')
assert.ok(pause, 'inspection pause control missing')
pause.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 10))
assert.ok(railCalls.some((call) => call.endpoint === 'inspection_pause' && call.payload?.paused === true),
  'pause did not call inspection_pause')
findButton(rail.root, 'Save').props.onClick()
await new Promise((resolve) => setTimeout(resolve, 10))
assert.ok(railCalls.some((call) => call.endpoint === 'save'), 'save did not call the bridge')
findButton(rail.root, 'Restore').props.onClick()
await new Promise((resolve) => setTimeout(resolve, 10))
assert.ok(railCalls.some((call) => call.endpoint === 'restore'), 'restore did not call the bridge')

// Command bar: submit dispatches, history recall restores the typed command.
const CommandBar = client.__test?.CommandBar
assert.ok(CommandBar, 'CommandBar test export missing')
const dispatched = []
const bar = mount(CommandBar, { dispatch: (line) => dispatched.push(line), busy: false })
const inputOf = (instance) => findAll(instance.root, (node) => node.type === 'input')[0]
inputOf(bar).props.onChange({ target: { value: 'SET_IJK 4 5 6' } })
inputOf(bar).props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
assert.deepEqual(dispatched, ['SET_IJK 4 5 6'], 'command was not dispatched')
assert.equal(inputOf(bar).props.value, '', 'command input was not cleared')
inputOf(bar).props.onKeyDown({ key: 'ArrowUp', preventDefault: () => {} })
assert.equal(inputOf(bar).props.value, 'SET_IJK 4 5 6', 'history recall did not restore the command')

console.log(`viewer interaction ok: ${buttons.length} header button(s) · ${railCalls.length} rail call(s) · ${dispatched.length} command(s)`)
console.log('PASS viewer interaction')
// The mounted bridge keeps polling timers; the smoke is complete, so exit deterministically.
process.exit(0)
