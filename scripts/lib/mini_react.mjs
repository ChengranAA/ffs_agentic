/** Minimal stateful React stand-in for UI interaction smokes.
 *
 * Supports useState/useRef/useEffect/useCallback/Component, function components, sync state
 * re-render, and button lookup in the returned element tree. Not a DOM renderer: it asserts what
 * a component would render/handle, not layout/styles. */

let current = null
const listeners = new Map()

export const React = {
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
  useCallback(fn, deps) {
    const instance = current
    const index = instance.hookIndex++
    const previous = instance.hooks[index]
    const stable = !deps || (previous && previous.deps
      && deps.length === previous.deps.length
      && deps.every((value, item) => value === previous.deps[item]))
    if (stable && previous) return previous.fn
    instance.hooks[index] = { fn, deps }
    return fn
  },
  Component: class Component {
    constructor(props) { this.props = props; this.state = {} }
    setState(update) { this.state = { ...this.state, ...(typeof update === 'function' ? update(this.state) : update) } }
  },
  Fragment: 'Fragment',
}

export function installWindow(extra = {}) {
  globalThis.document = { activeElement: null }
  globalThis.window = {
    __ModuleLoader__: { load({ factory }) { globalThis.__miniPlugin = { value: factory((name) => {
      if (name === 'react') return React
      throw new Error(`unexpected require: ${name}`)
    }) } } },
    addEventListener(type, fn) { listeners.set(fn, type) },
    removeEventListener(_type, fn) { listeners.delete(fn) },
    location: { search: '' },
    localStorage: { getItem: () => null, setItem: () => {} },
    confirm: () => true,
    ...extra,
  }
}

export async function loadClient(url) {
  installWindow()
  await import(url)
  if (!globalThis.__miniPlugin) throw new Error('client module did not register')
  return globalThis.__miniPlugin.value
}

function render(instance) {
  instance.renders = (instance.renders || 0) + 1
  if (instance.renders > 2000) {
    throw new Error(`render loop: ${instance.component?.name || 'component'} rendered ${instance.renders} times`)
  }
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

export function mount(component, props) {
  const instance = { component, props, hooks: [], hookIndex: 0, pendingEffects: [] }
  render(instance)
  return instance
}

export function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object') return ''
  return textOf(node.children)
}

export function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, out); return out }
  if (predicate(node)) out.push(node)
  findAll(node.children, predicate, out)
  return out
}

export function findButton(node, label) {
  return findAll(node, (element) => element.type === 'button' && textOf(element).includes(label))[0] || null
}

export function findInput(node, placeholderPart) {
  return findAll(node, (element) => (element.type === 'input' || element.type === 'textarea')
    && String(element.props?.placeholder || '').includes(placeholderPart))[0] || null
}
