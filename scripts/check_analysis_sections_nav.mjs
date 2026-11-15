#!/usr/bin/env node
/** Navigation smoke: mount AnalysisBody, click every rail tab, assert content renders. */

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadClient, mount, findAll, textOf } from './lib/mini_react.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
globalThis.ResizeObserver = class { observe() {} disconnect() {} }
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0)

// Live snapshot through the Host route.
const { apply } = await import(pathToFileURL(path.join(ROOT, 'ffs-analysis-ui/index.js')).href)
let handler = null
const hostCtx = {
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  tools: { register() { return () => {} } },
  inject(deps, callback) {
    if (deps.includes('jobs')) return
    if (deps.includes('webServer')) {
      callback({ webServer: { register(route) { handler = route.handler; return () => {} } }, connection: { admit: () => ({}) }, effect: hostCtx.effect })
    }
  },
}
apply(hostCtx)
const response = { status: 0, body: '', writeHead(code) { this.status = code }, end(body) { this.body = String(body) } }
await handler({ method: 'GET', url: '/ffs-analysis/snapshot', headers: {} }, response)
assert.equal(response.status, 200)
const snap = JSON.parse(response.body)

globalThis.fetch = async (url) => {
  const target = String(url)
  if (target.includes('/snapshot')) return { ok: true, json: async () => snap }
  if (target.includes('/pipeline')) {
    return { ok: true, json: async () => ({ ok: true, version: 1, pipeline: { scope: {}, recipe: null, overrides: {}, commands: [] }, validation: { ok: true, errors: [], warnings: [] }, totals: { flags: 0, groups: 0 }, recipes: [], groups: [], stages: [], flags: {} }) }
  }
  return { ok: false, status: 404, json: async () => ({ ok: false, error: { message: 'stub' } }) }
}

const client = await loadClient(pathToFileURL(path.join(ROOT, 'ffs-analysis-ui/client.js')).href)
const AnalysisBody = client.__test?.AnalysisBody
assert.ok(AnalysisBody, 'AnalysisBody test export missing')
const ctx = { get: () => undefined }
const instance = mount(AnalysisBody, { ctx, t: (key) => key })
await new Promise((resolve) => setTimeout(resolve, 30))
assert.ok(textOf(instance.root).length > 0, 'analysis body rendered nothing')

const railButtons = () => findAll(instance.root, (node) => node.type === 'button' && String(node.props?.id || '').startsWith('ffa-tab-'))
assert.ok(railButtons().length === 8, `expected 8 rail tabs, got ${railButtons().length}`)
const failures = []
for (const button of railButtons()) {
  const id = button.props.id
  try {
    button.props.onClick()
    const text = textOf(instance.root)
    if (!text || text.length < 10) failures.push(`${id}: blank`)
    else console.log(`✔ ${id} · ${text.length} chars`)
  } catch (error) {
    failures.push(`${id}: ${error?.message || error}`)
    console.error(`✖ ${id}: ${error?.stack || error}`)
  }
}
assert.deepEqual(failures, [], `section navigation failed: ${failures.join('; ')}`)
console.log(`analysis sections nav ok: ${railButtons().length} tabs from ${snap.source}`)
console.log('PASS analysis sections nav')
process.exit(0)
