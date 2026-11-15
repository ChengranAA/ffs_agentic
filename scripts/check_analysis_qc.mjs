#!/usr/bin/env node
/** Interactive QC-decision smoke: mount QcSection, click Accept, save, assert payload. */

import assert from 'node:assert/strict'

let plugin = null
const listeners = new Map()
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      plugin = { id, value: factory((name) => {
        if (name === 'react') return React
        throw new Error(`unexpected require: ${name}`)
      }) }
    },
  },
  addEventListener(type, fn) { listeners.set(fn, type) },
  removeEventListener(_type, fn) { listeners.delete(fn) },
  location: { search: '' },
  confirm: () => true,
  localStorage: { getItem: () => null, setItem: () => {} },
}

let current = null
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState(initial) {
    const instance = current
    const index = instance.hookIndex++
    if (!(index in instance.hooks)) {
      instance.hooks[index] = typeof initial === 'function' ? initial() : initial
    }
    const set = (value) => {
      instance.hooks[index] = typeof value === 'function' ? value(instance.hooks[index]) : value
      render(instance)
    }
    return [instance.hooks[index], set]
  },
  useRef(value) {
    const instance = current
    const index = instance.hookIndex++
    if (!(index in instance.hooks)) instance.hooks[index] = { current: value }
    return instance.hooks[index]
  },
  useEffect(fn, deps) {
    const instance = current
    const index = instance.hookIndex++
    const previous = instance.hooks[index]
    const changed = !previous || !deps || !previous.deps
      || deps.some((value, item) => value !== previous.deps[item])
    if (changed) instance.pendingEffects.push({ index, fn, deps })
  },
  useCallback: (fn) => fn,
  Component: class Component {
    constructor(props) { this.props = props; this.state = {} }
    setState(update) { this.state = { ...this.state, ...(typeof update === 'function' ? update(this.state) : update) } }
  },
  Fragment: 'Fragment',
}

function render(instance) {
  current = instance
  instance.hookIndex = 0
  instance.pendingEffects = []
  instance.root = instance.component(instance.props)
  current = null
  for (const effect of instance.pendingEffects) {
    instance.hooks[effect.index] = { deps: effect.deps, cleanup: undefined }
    const result = effect.fn()
    if (typeof result === 'function') instance.hooks[effect.index].cleanup = result
  }
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object') return ''
  return textOf(node.children)
}

function findButton(node, label) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) { const found = findButton(child, label); if (found) return found }
    return null
  }
  if (node.type === 'button' && textOf(node).includes(label)) return node
  return findButton(node.children, label)
}

function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, out); return out }
  if (predicate(node)) out.push(node)
  findAll(node.children, predicate, out)
  return out
}

await import('../ffs-analysis-ui/client.js')
assert.ok(plugin, 'analysis client did not register')
const QcSection = plugin.value.__test?.QcSection
assert.ok(QcSection, 'QcSection test export missing')

const snap = {
  project: { subject: '001' },
  assets: { base: '/ffs-analysis/asset/' },
  qc: {
    status: 'completed',
    figures: [
      { id: 'fd', asset: 'qc/fd.png', label: 'Framewise displacement', help: { why: 'motion check', failure: 'excess motion' } },
    ],
    screenshots: [],
  },
  decisions: [],
  surface: null,
}
const decisions = []
const instance = { component: QcSection, props: {
  snap, t: (key) => key, recordingDecision: false,
  onDecision: async (body) => { decisions.push(body); return { ok: true } },
  onCapture: null,
}, hooks: [], hookIndex: 0, pendingEffects: [] }
render(instance)

const accept = findButton(instance.root, 'Accept')
assert.ok(accept, 'Accept button not rendered')
assert.equal(findButton(instance.root, 'Save decision'), null, 'composer must start closed')

accept.props.onClick()
assert.ok(findButton(instance.root, 'Save decision'), 'composer did not open after Accept')
assert.ok(findAll(instance.root, (node) => node.props?.className === 'ffa-drawer-backdrop').length, 'composer is not a modal')

const save = findButton(instance.root, 'Save decision')
await save.props.onClick()
assert.equal(decisions.length, 1)
assert.equal(decisions[0].action, 'accept')
assert.equal(decisions[0].target.kind, 'qc')
assert.match(decisions[0].target.ref, /^001:/)
assert.equal(findButton(instance.root, 'Save decision'), null, 'composer did not close after save')

// A failed decision must keep the composer open and show an error, not silently close.
const failing = { component: QcSection, props: {
  snap, t: (key) => key, recordingDecision: false,
  onDecision: async () => null, onCapture: null,
}, hooks: [], hookIndex: 0, pendingEffects: [] }
render(failing)
findButton(failing.root, 'Accept').props.onClick()
await findButton(failing.root, 'Save decision').props.onClick()
assert.ok(findButton(failing.root, 'Save decision'), 'composer must stay open when the decision fails')
assert.ok(textOf(failing.root).includes('decision was not recorded'), 'composer must show the failure')

// A recorded verdict must be visible on the figure itself (not only in the list below).
const decidedSnap = { ...snap, decisions: [{
  id: 'dec-smoke', action: 'accept', at: new Date().toISOString(), confidence: 'high',
  target: { kind: 'qc', ref: '001:fd', path: 'qc/fd.png' }, rationale: { text: 'motion acceptable', unknown: false },
}] }
const withVerdict = { component: QcSection, props: {
  snap: decidedSnap, t: (key) => key, recordingDecision: false, onDecision: async () => ({ ok: true }), onCapture: null,
}, hooks: [], hookIndex: 0, pendingEffects: [] }
render(withVerdict)
assert.ok(textOf(withVerdict.root).includes('accepted'), 'figure does not show its recorded verdict')
assert.ok(textOf(withVerdict.root).includes('accepted 1'), 'QC summary does not count verdicts')
assert.ok(!textOf(withVerdict.root).includes('not judged yet'), 'judged figure still reports not judged')

console.log(`analysis qc interaction ok: ${decisions.length} decision · ${decisions[0].target.ref}`)
console.log('PASS analysis qc interaction')
