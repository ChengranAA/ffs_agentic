#!/usr/bin/env node
/** Record-tab interaction smoke: decision composer open/validation/save payload. */

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadClient, mount, findButton, findInput, findAll, textOf } from './lib/mini_react.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const client = await loadClient(pathToFileURL(path.join(ROOT, 'ffs-record/client.js')).href)
const DecisionComposer = client.__test?.DecisionComposer
assert.ok(DecisionComposer, 'DecisionComposer test export missing')

const saved = []
let closed = 0
const instance = mount(DecisionComposer, {
  onClose: () => { closed += 1 },
  onSave: async (body) => { saved.push(body); return true },
})

const saveButton = () => findButton(instance.root, 'Save decision')
assert.ok(saveButton(), 'composer did not render Save')
assert.equal(saveButton().props.disabled, true, 'Save must start disabled without a target ref')

const refInput = findInput(instance.root, 'sub-001:qc/fd.png')
assert.ok(refInput, 'target ref input missing')
refInput.props.onChange({ target: { value: 'sub-001:qc/fd.png' } })
assert.equal(saveButton().props.disabled, false, 'Save should enable once a ref is present')

await saveButton().props.onClick()
assert.equal(saved.length, 1, 'Save did not call onSave')
assert.equal(saved[0].action, 'accept')
assert.equal(saved[0].target.kind, 'qc')
assert.equal(saved[0].target.ref, 'sub-001:qc/fd.png')
assert.equal(closed, 1, 'successful save should close the composer')

// Standard departure requires a reason.
const strict = mount(DecisionComposer, { onClose: () => {}, onSave: async () => true })
findInput(strict.root, 'sub-001:qc/fd.png').props.onChange({ target: { value: 'sub-001:qc/fd.png' } })
const kind = findAll(strict.root, (node) => node.type === 'select' && textOf(node).includes('standard')).at(-1)
assert.ok(kind, 'decision kind select missing')
kind.props.onChange({ target: { value: 'standard' } })
assert.equal(findButton(strict.root, 'Save decision').props.disabled, true, 'standard change must require a reason')
const reason = findInput(strict.root, 'required for a standard departure')
assert.ok(reason, 'reason field missing')
reason.props.onChange({ target: { value: 'no QC figure for this run' } })
assert.equal(findButton(strict.root, 'Save decision').props.disabled, false, 'reason should enable Save')

console.log('record ui interaction ok: composer validation + payload')
console.log('PASS record ui interaction')
