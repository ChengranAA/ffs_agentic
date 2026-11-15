import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Bridge } from '../ffs-harness-viewer/index.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE = path.join(ROOT, 'work', 'ffs-record', 'preferences', 'profile.json')

class FakeSidecar {
  constructor() {
    this.requests = []
    this.onExit = null
  }
  async request(method, payload) {
    this.requests.push({ method, payload })
    if (method === 'open') return { state: { grid: { shape: [2, 2, 2] } }, opened: true }
    if (method === 'execute_batch') return { state: { rev: 7 }, results: payload.lines.map(() => ({ ok: true })) }
    if (method === 'state') return { rev: 7 }
    return {}
  }
}

function withProfile(profile) {
  const saved = existsSync(PROFILE) ? readFileSync(PROFILE, 'utf8') : null
  mkdirSync(path.dirname(PROFILE), { recursive: true })
  writeFileSync(PROFILE, JSON.stringify(profile))
  return () => {
    if (saved === null) rmSync(PROFILE, { force: true })
    else writeFileSync(PROFILE, saved)
  }
}

const alpha = {
  id: 'pref-alpha-0-4', version: 2, status: 'established', kind: 'preference',
  scientific: false, active: true, recommendation: { family: 'alpha', value: '0.4' },
}

test('auto-applies presentation defaults once on open', async () => {
  const restore = withProfile({ schema: 'ffs-record-profile/1', preferences: [alpha] })
  const oldRecord = process.env.FFS_RECORD
  process.env.FFS_RECORD = 'off'
  try {
    const sidecar = new FakeSidecar()
    const bridge = new Bridge(sidecar, { autoApplyPresentation: true })
    await bridge.ensureOpen()
    assert.deepEqual(sidecar.requests.map((entry) => entry.method), ['open', 'execute_batch'])
    assert.deepEqual(sidecar.requests[1].payload.lines, ['SET_ALPHA S 0.4'])
    assert.equal(sidecar.requests[1].payload.origin, 'system')
    assert.equal(bridge.presentationApplied, true)
    await bridge.ensureOpen()
    assert.equal(sidecar.requests.length, 2, 'presentation defaults applied more than once')
  } finally {
    process.env.FFS_RECORD = oldRecord
    restore()
  }
})

test('opt-out skips application; restart re-arms it', async () => {
  const restore = withProfile({ schema: 'ffs-record-profile/1', preferences: [alpha] })
  const oldRecord = process.env.FFS_RECORD
  process.env.FFS_RECORD = 'off'
  try {
    const sidecar = new FakeSidecar()
    const bridge = new Bridge(sidecar, { autoApplyPresentation: false })
    await bridge.ensureOpen()
    assert.deepEqual(sidecar.requests.map((entry) => entry.method), ['open'])

    const enabled = new Bridge(sidecar, { autoApplyPresentation: true })
    await enabled.ensureOpen()
    assert.equal(sidecar.requests.filter((entry) => entry.method === 'execute_batch').length, 1)
    sidecar.onExit?.()
    enabled.opened = null
    await enabled.ensureOpen()
    assert.equal(sidecar.requests.filter((entry) => entry.method === 'execute_batch').length, 2)
  } finally {
    process.env.FFS_RECORD = oldRecord
    restore()
  }
})

test('tool apply method honours dryRun and needs a profile', async () => {
  const restore = withProfile({ schema: 'ffs-record-profile/1', preferences: [alpha] })
  try {
    const sidecar = new FakeSidecar()
    const bridge = new Bridge(sidecar, { autoApplyPresentation: false })
    const plan = await bridge.applyPresentation({ dryRun: true })
    assert.equal(plan.dryRun, true)
    assert.deepEqual(plan.plan.map((entry) => entry.command), ['SET_ALPHA S 0.4'])
    assert.equal(sidecar.requests.length, 0)
    const applied = await bridge.applyPresentation({ ensure: true, actor: { kind: 'agent' } })
    assert.equal(applied.applied.length, 1)
  } finally {
    restore()
  }
})
