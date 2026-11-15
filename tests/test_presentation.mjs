import test from 'node:test'
import assert from 'node:assert/strict'

import { presentationCommand, presentationPlan } from '../shared/record/presentation.js'

const base = {
  id: 'pref-alpha-0-4', version: 2, kind: 'preference', status: 'established',
  scientific: false, active: true, recommendation: { family: 'alpha', value: '0.4' },
}

test('builds viewer commands for established presentation preferences', () => {
  assert.equal(presentationCommand(base), 'SET_ALPHA S 0.4')
  assert.equal(presentationCommand({ ...base, recommendation: { family: 'colormap', value: 'redblue' } }), 'SET_COLORMAP S redblue')
  const plan = presentationPlan({ preferences: [
    base,
    { ...base, id: 'pref-colormap-redblue', recommendation: { family: 'colormap', value: 'redblue' } },
  ] })
  assert.equal(plan.length, 2)
  assert.deepEqual(plan.map((entry) => entry.command), ['SET_ALPHA S 0.4', 'SET_COLORMAP S redblue'])
  assert.equal(plan[0].version, 2)
})

test('excludes scientific, unestablished, retired and unsupported preferences', () => {
  const cases = [
    { ...base, scientific: true },
    { ...base, status: 'candidate' },
    { ...base, status: 'retired', active: false },
    { ...base, recommendation: { family: 'threshold', value: '2.3' } },
    { ...base, recommendation: { family: 'alpha', value: '1.7' } },
    { ...base, recommendation: { family: 'colormap', value: '../../etc/passwd' } },
  ]
  for (const record of cases) assert.equal(presentationCommand(record), null, JSON.stringify(record))
  assert.deepEqual(presentationPlan({ preferences: cases }), [])
})

test('missing or malformed profiles yield no plan', () => {
  assert.deepEqual(presentationPlan(null), [])
  assert.deepEqual(presentationPlan({}), [])
  assert.deepEqual(presentationPlan({ preferences: 'nope' }), [])
})
