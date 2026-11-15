import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  preferenceSummary,
  readPreferenceProfile,
} from '../shared/record/preferences.js'

function withProject(profile) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ffs-preferences-'))
  if (profile) {
    const dir = path.join(root, 'work', 'ffs-record', 'preferences')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(profile))
  }
  return root
}

test('reads a valid profile and summarizes it', () => {
  const root = withProject({
    schema: 'ffs-record-profile/1',
    generatedAt: '2026-11-13T12:00:00Z',
    stats: { observed: 1, candidate: 1, established: 2 },
    evidence: { sessions: 9, weight: 8.2 },
    conflicts: [{ a: 'pref-a', b: 'pref-b' }],
    preferences: [
      { id: 'pref-alpha-0-4', version: 2, status: 'established', kind: 'preference', scientific: false,
        recommendation: { action: 'use alpha 0.4' }, evidence: { score: 1, sessions: 9 } },
      { id: 'pref-threshold-2-3', version: 1, status: 'candidate', kind: 'preference', scientific: true,
        recommendation: { action: 'threshold 2.3' }, evidence: { score: 0.9, sessions: 9 } },
    ],
  })
  try {
    const profile = readPreferenceProfile(root)
    assert.equal(profile.schema, 'ffs-record-profile/1')
    const summary = preferenceSummary(root)
    assert.equal(summary.available, true)
    assert.equal(summary.count, 2)
    assert.equal(summary.stats.established, 2)
    assert.equal(summary.conflicts, 1)
    assert.equal(summary.recent[0].id, 'pref-alpha-0-4')
    assert.equal(summary.recent[0].score, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('missing and malformed profiles are unavailable, not errors', () => {
  const missing = withProject(null)
  const malformed = mkdtempSync(path.join(os.tmpdir(), 'ffs-preferences-'))
  try {
    assert.equal(readPreferenceProfile(missing), null)
    assert.equal(preferenceSummary(missing).available, false)
    const dir = path.join(malformed, 'work', 'ffs-record', 'preferences')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'profile.json'), '{broken')
    assert.equal(readPreferenceProfile(malformed), null)
    const wrong = path.join(malformed, 'work', 'ffs-record', 'preferences', 'profile.json')
    writeFileSync(wrong, JSON.stringify({ schema: 'other' }))
    assert.equal(readPreferenceProfile(malformed), null)
  } finally {
    rmSync(missing, { recursive: true, force: true })
    rmSync(malformed, { recursive: true, force: true })
  }
})
