#!/usr/bin/env node
/** Planner next-step guide smoke: suggestion state, blocker review, no duplicate actions. */

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadClient, mount, findButton, findAll, textOf } from './lib/mini_react.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const client = await loadClient(pathToFileURL(path.join(ROOT, 'ffs-analysis-ui/client.js')).href)
const PlannerGuide = client.__test?.PlannerGuide
assert.ok(PlannerGuide, 'PlannerGuide test export missing')

let reviewed = 0
const base = {
  draft: { scope: { subject: '001', bidsDir: 'data/bids' }, recipe: 'complete', overrides: {} },
  validationErrors: [], validationWarnings: [], dirty: false, generated: null,
  snap: { pipeline: { status: 'planned', script: null } },
  showValidation: () => { reviewed += 1 },
}
const buttonText = (instance) => findAll(instance.root, (node) => node.type === 'button').map(textOf)

const dirty = mount(PlannerGuide, { ...base, dirty: true })
assert.ok(textOf(dirty.root).includes('Next: Generate script'), 'dirty guide did not suggest Generate')
assert.ok(textOf(dirty.root).includes('auto-saves'), 'dirty hint does not mention auto-save')
assert.deepEqual(buttonText(dirty), [], 'guide must not duplicate Save/Generate/Run actions')

const blocked = mount(PlannerGuide, {
  ...base,
  validationErrors: [{ code: 'anat', message: 'anatomical image is required' }],
})
assert.ok(textOf(blocked.root).includes('Next: Resolve blockers'), 'blocker guide did not highlight blockers')
assert.ok(textOf(blocked.root).includes('anatomical image is required'), 'guide does not show the blocker')
findButton(blocked.root, 'Review (1)').props.onClick()
assert.equal(reviewed, 1, 'guide Review did not call showValidation')

const ready = mount(PlannerGuide, {
  ...base,
  snap: { pipeline: { status: 'planned', script: 'work/proc_sub-001.sh' } },
})
assert.ok(textOf(ready.root).includes('Next: Run script'), 'ready guide did not suggest Run')
assert.deepEqual(buttonText(ready), [], 'guide must not duplicate the Run action')

const done = mount(PlannerGuide, {
  ...base,
  snap: { pipeline: { status: 'completed', script: 'work/proc_sub-001.sh' } },
})
assert.ok(textOf(done.root).includes('Ready to review'), 'completed guide did not move to review')

const failedGenerate = mount(PlannerGuide, { ...base, generateError: 'cannot generate a runnable script' })
assert.ok(textOf(failedGenerate.root).includes('Next: Resolve blockers'), 'generation error did not become guidance')

console.log('analysis guide ok: generate suggestion · blockers review · run · review · no duplicate actions')
console.log('PASS analysis guide')
