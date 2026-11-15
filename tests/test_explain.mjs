import test from 'node:test'
import assert from 'node:assert/strict'

import { explainQc, explainStage } from '../ffs-analysis-ui/lib/explain.js'

const STAGE_IDS = [
  'preflight', 'stage00', 'stage01', 'stage02', 'stage03', 'stage04', 'stage05',
  'stage06', 'stage07', 'stage08', 'stage08b', 'stage09', 'stage09b', 'stage10a',
  'stage10', 'stage10b', 'stage10s', 'stage12', 'stage12s',
]

test('every autoproc stage has a why and a failure description', () => {
  for (const id of STAGE_IDS) {
    const explanation = explainStage({ id, label: id })
    assert.equal(typeof explanation.why, 'string')
    assert.equal(typeof explanation.failure, 'string')
    assert.ok(explanation.why.length > 30, `${id} why too short`)
    assert.ok(explanation.failure.length > 30, `${id} failure too short`)
  }
})

test('unknown stages still explain themselves', () => {
  const unknown = explainStage({ id: 'stage99', label: 'mystery', phase: 'Model' })
  assert.ok(unknown.why.length > 10)
  assert.ok(unknown.failure.length > 10)
  assert.match(explainStage({ id: 'stage99', phase: 'Model' }).why, /task|model|statistical/i)
})

test('QC checks map by common figure names and always answer', () => {
  const cases = [
    [['fd.png', 'framewise displacement'], /motion|displacement/i],
    [['tSNR.png'], /signal|noise|SNR/i],
    [['motion.png'], /motion|alignment/i],
    [['dvars.png'], /time series|spike|DVARS/i],
    [['reg_check.png'], /registration|overlay|align/i],
    [['mask.png'], /voxels|mask|coverage/i],
    [['design.png'], /regressors|model|design/i],
  ]
  for (const [[label], expected] of cases) {
    const explanation = explainQc({ label })
    assert.match(`${explanation.why} ${explanation.failure}`, expected)
  }
  const unknown = explainQc({ label: 'something-new.png' })
  assert.ok(unknown.why.length > 20)
  assert.ok(unknown.failure.length > 20)
})
