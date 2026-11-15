#!/usr/bin/env node
/** Smoke-load the Record tab client factory with a minimal React/Cordis stand-in. */

import assert from 'node:assert/strict'

let plugin = null
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      plugin = { id, value: factory((name) => {
        if (name === 'react') return fakeReact
        throw new Error(`unexpected require: ${name}`)
      }) }
    },
  },
}

const registered = { tabs: [], slots: [], components: [], styles: 0 }
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
  Component: class Component {
    constructor(props) { this.props = props; this.state = {} }
    setState(update) { this.state = { ...this.state, ...(typeof update === 'function' ? update(this.state) : update) } }
  },
  Fragment: 'Fragment',
}

const ctx = {
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  get(name) { return name === 'sidebarRight' ? { openTab(id) { registered.opened = id } } : undefined },
  locale: { register() {}, bind: () => (key) => key },
  slots: {
    inject(name, fn) { fn() },
    register(spec, component) {
      registered.slots.push(spec)
      registered.components.push({ spec, component })
      return () => {}
    },
  },
  sidebarRightTabs: {
    register(spec) { registered.tabs.push(spec); return () => {} },
  },
}

await import('../ffs-record/client.js')
assert.ok(plugin, 'client module did not register through __ModuleLoader__')
assert.equal(plugin.id, '@local/ffs-record')
assert.equal(plugin.value.name, 'ffs-record')
assert.ok(Array.isArray(plugin.value.inject))
plugin.value.apply(ctx)

assert.equal(registered.tabs.length, 1)
assert.equal(registered.tabs[0].kind, 'ffs-record')
assert.equal(registered.tabs[0].id, '@local/ffs-record')
assert.equal(registered.tabs[0].guide[0].id, 'ffs-record')
assert.equal(typeof registered.tabs[0].guide[0].icon, 'function')
const slotNames = registered.slots.map((slot) => slot.name)
assert.ok(slotNames.includes('sidebar.right.pane.tab'))
assert.ok(slotNames.includes('conversation.session.header.utilities'))
assert.ok(registered.slots.every((slot) => typeof slot.key !== 'undefined' || typeof slot.id !== 'undefined'))
// Render-level smoke: a fake React hook runtime lets us walk the returned element tree so
// undefined references in the loading state fail here instead of in the browser.
let rendered = 0
function render(node, depth = 0) {
  if (depth > 40 || node === null || node === undefined || typeof node === 'boolean'
    || typeof node === 'string' || typeof node === 'number') return
  if (Array.isArray(node)) { for (const child of node) render(child, depth + 1); return }
  if (typeof node !== 'object') return
  rendered += 1
  if (typeof node.type === 'function') {
    render(node.type({ ...(node.props || {}), children: node.children }), depth + 1)
    return
  }
  for (const child of node.children || []) render(child, depth + 1)
}
const bodyEntry = registered.components.find((entry) => entry.spec.name === 'sidebar.right.pane.tab')
assert.ok(bodyEntry?.component, 'Record tab body component missing')
render(bodyEntry.component({}))
assert.ok(rendered > 5, `render tree too small (${rendered})`)
console.log(`record client ok: tab ${registered.tabs[0].kind} · ${registered.slots.length} slots · rendered ${rendered} element(s)`)
console.log('PASS record client')
