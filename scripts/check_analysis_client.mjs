#!/usr/bin/env node
/** Mount the analysis Client half and render its initial tree with a fake React runtime. */

import assert from 'node:assert/strict'

let plugin = null
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  Component: class Component {
    constructor(props) { this.props = props; this.state = {} }
    setState(update) { this.state = { ...this.state, ...(typeof update === 'function' ? update(this.state) : update) } }
  },
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
  Fragment: 'Fragment',
}
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

const registered = { tabs: [], slots: [], components: [] }
const ctx = {
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  get(name) { return name === 'sidebarRight' ? { openTab() {} } : undefined },
  locale: { register() {}, bind: () => (key) => key },
  slots: {
    inject(name, fn) { fn() },
    register(spec, component) {
      registered.slots.push(spec)
      registered.components.push({ spec, component })
      return () => {}
    },
  },
  sidebarRightTabs: { register(spec) { registered.tabs.push(spec); return () => {} } },
}

await import('../ffs-analysis-ui/client.js')
assert.ok(plugin, 'client module did not register through __ModuleLoader__')
assert.equal(plugin.id, '@local/ffs-analysis-ui')
plugin.value.apply(ctx)

assert.equal(registered.tabs.length, 1)
assert.equal(registered.tabs[0].kind, 'ffs-analysis')
assert.ok(registered.components.some((entry) => entry.spec.name === 'sidebar.right.pane.tab'))

let rendered = 0
function render(node, depth = 0) {
  if (depth > 50 || node === null || node === undefined || typeof node === 'boolean'
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

const body = registered.components.find((entry) => entry.spec.name === 'sidebar.right.pane.tab')
assert.ok(body?.component, 'analysis tab body missing')
render(body.component({}))
assert.ok(rendered >= 4, `analysis render tree too small (${rendered})`)
console.log(`analysis client ok: tab ${registered.tabs[0].kind} · ${registered.slots.length} slots · rendered ${rendered} elements`)
console.log('PASS analysis client')
