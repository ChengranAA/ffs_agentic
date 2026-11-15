import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  inspectionSummary,
  readInspectionSession,
  readInspectionSessions,
} from '../shared/record/inspection.js'

function sessionLines(sessionId, { mark = true, capture = true } = {}) {
  const frames = [
    { schema: 'ffs-inspection/1', frame: 'session.start', seq: 1, sessionId, ts: '2026-11-13T10:00:00Z', restored: false },
    { schema: 'ffs-inspection/1', frame: 'session.baseline', seq: 2, sessionId, ts: '2026-11-13T10:00:00Z',
      path: `.ffs-viewer/inspection/${sessionId}.start.ffs`, sha256: 'd'.repeat(64), stateSha256: 'e'.repeat(64), bytes: 42 },
    { schema: 'ffs-inspection/1', frame: 'event', seq: 3, sessionId, ts: '2026-11-13T10:00:01Z',
      command: { line: 'SET_IJK 1 2 3', name: 'SET_IJK', category: 'navigation' },
      semantic: { kind: 'crosshair', ijk: [1, 2, 3] }, snapshot: { rev: 2, stateSha256: 'a'.repeat(64) } },
  ]
  if (capture) {
    frames.push({ schema: 'ffs-inspection/1', frame: 'capture', seq: 4, sessionId, ts: '2026-11-13T10:00:02Z',
      label: 'registration', stateSha256: 'b'.repeat(64),
      coordinates: { space: 'voxel', ijk: [1, 2, 3] }, display: { threshold: 2.3 } })
  }
  if (mark) {
    frames.push({ schema: 'ffs-inspection/1', frame: 'mark', seq: 5, sessionId, ts: '2026-11-13T10:00:03Z',
      text: 'looks fine', tags: ['qc'], kind: 'mark', stateSha256: 'b'.repeat(64) })
  }
  frames.push({ schema: 'ffs-inspection/1', frame: 'session.end', seq: 6, sessionId, ts: '2026-11-13T10:05:00Z' })
  return frames
}

test('reads sessions, folds marks/captures and reports a torn tail', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ffs-inspection-index-'))
  try {
    const inspection = path.join(dir, 'inspection')
    mkdirSync(inspection, { recursive: true })
    const first = sessionLines('insp-a')
    writeFileSync(path.join(inspection, 'insp-a.jsonl'), `${first.map((frame) => JSON.stringify(frame)).join('\n')}\n`)
    const second = sessionLines('insp-b', { mark: false, capture: false })
    writeFileSync(path.join(inspection, 'insp-b.jsonl'), second.map((frame) => JSON.stringify(frame)).join('\n'))

    const read = readInspectionSessions(dir)
    assert.equal(read.sessions.length, 2)
    assert.equal(read.corrupt.length, 1)
    assert.equal(read.corrupt[0].reason, 'torn-tail')
    const a = read.sessions.find((session) => session.sessionId === 'insp-a')
    assert.equal(a.events, 1)
    assert.equal(a.marks.length, 1)
    assert.equal(a.captures.length, 1)
    assert.equal(a.captures[0].stateSha256, 'b'.repeat(64))
    assert.equal(a.startedAt, '2026-11-13T10:00:00Z')
    assert.equal(a.endedAt, '2026-11-13T10:05:00Z')
    assert.equal(a.baseline.sha256, 'd'.repeat(64))
    assert.equal(a.baseline.stateSha256, 'e'.repeat(64))

    const one = readInspectionSession(dir, 'insp-a')
    assert.equal(one.frames, 6)
    assert.equal(readInspectionSession(dir, 'insp-missing'), null)

    const summary = inspectionSummary(dir)
    assert.equal(summary.sessions, 2)
    assert.equal(summary.events, 2)
    assert.equal(summary.captures, 1)
    assert.equal(summary.marks, 1)
    assert.equal(summary.corrupt, 1)
    assert.equal(summary.recent.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('missing inspection directory is empty, not an error', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ffs-inspection-index-'))
  try {
    const summary = inspectionSummary(dir)
    assert.equal(summary.sessions, 0)
    assert.deepEqual(summary.recent, [])
    assert.deepEqual(summary.corrupt, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
