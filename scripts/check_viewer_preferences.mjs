#!/usr/bin/env node
/** Dry-run the viewer's presentation-preference tool with a synthetic profile. */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../ffs-harness-viewer/index.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE = path.join(ROOT, 'work', 'ffs-record', 'preferences', 'profile.json')
const saved = existsSync(PROFILE) ? readFileSync(PROFILE, 'utf8') : null

const tools = new Map()
const ctx = {
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
  inject() { /* no web server in this smoke; tools are what we exercise */ },
}

let failed = false
try {
  mkdirSync(path.dirname(PROFILE), { recursive: true })
  writeFileSync(PROFILE, JSON.stringify({
    schema: 'ffs-record-profile/1',
    preferences: [
      { id: 'pref-alpha-0-4', version: 2, status: 'established', kind: 'preference', scientific: false,
        active: true, recommendation: { family: 'alpha', value: '0.4' } },
      { id: 'pref-colormap-redblue', version: 1, status: 'established', kind: 'preference', scientific: false,
        active: true, recommendation: { family: 'colormap', value: 'redblue' } },
      { id: 'pref-threshold-2-3', version: 1, status: 'established', kind: 'preference', scientific: true,
        active: true, recommendation: { family: 'threshold', value: '2.3' } },
      { id: 'pref-candidate', version: 1, status: 'candidate', kind: 'preference', scientific: false,
        active: true, recommendation: { family: 'alpha', value: '0.8' } },
    ],
  }) + '\n', { encoding: 'utf8' })

  apply(ctx)
  const tool = tools.get('ffs_viewer_apply_preferences')
  assert.ok(tool, 'ffs_viewer_apply_preferences not registered')
  const result = JSON.parse(await tool.execute({ dryRun: true }))
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.deepEqual(result.plan.map((entry) => entry.command), ['SET_ALPHA S 0.4', 'SET_COLORMAP S redblue'])
  assert.ok(result.plan.every((entry) => entry.id !== 'pref-threshold-2-3'), 'scientific preference was applied')
  assert.ok(result.plan.every((entry) => entry.id !== 'pref-candidate'), 'candidate preference was applied')
  console.log(`viewer preferences ok: ${result.plan.length} presentation command(s) · scientific/candidate skipped`)
  console.log('PASS viewer preferences')
} catch (error) {
  failed = true
  console.error('FAIL viewer preferences:', error?.message || error)
} finally {
  if (saved === null) rmSync(PROFILE, { force: true })
  else writeFileSync(PROFILE, saved)

}

if (failed) process.exit(1)
