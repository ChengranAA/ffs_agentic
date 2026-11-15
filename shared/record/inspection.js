/**
 * Read the viewer sidecar's durable inspection sessions (RECORD.md §6).
 *
 * The sidecar is the only writer of `<state-dir>/inspection/*.jsonl`; this module is a
 * read-only index for the record bundle and for decision evidence. A torn trailing line is
 * reported, never repaired.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

export const INSPECTION_SCHEMA = 'ffs-inspection/1'
export const MAX_FRAMES = 500

export function inspectionDir(stateDir) {
  return path.join(stateDir, 'inspection')
}

/** Parse one session file into a folded summary plus the frames that matter. */
export function readSessionFile(file, { maxFrames = MAX_FRAMES } = {}) {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { sessionId: path.basename(file, '.jsonl'), file, frames: 0, events: 0, marks: [], captures: [], corrupt: [`unreadable: ${error?.message || error}`] }
  }
  const corrupt = []
  const lines = text.split('\n')
  if (text && !text.endsWith('\n')) {
    lines.pop()
    corrupt.push('torn-tail')
  }
  const frames = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      frames.push(JSON.parse(line))
    } catch {
      corrupt.push('invalid-json')
    }
  }
  const start = frames.find((frame) => frame.frame === 'session.start') || frames[0] || {}
  const end = [...frames].reverse().find((frame) => frame.frame === 'session.end') || null
  const baselineFrame = frames.find((frame) => frame.frame === 'session.baseline') || null
  const marks = frames.filter((frame) => frame.frame === 'mark')
  const captures = frames.filter((frame) => frame.frame === 'capture')
  const events = frames.filter((frame) => frame.frame === 'event')
  return {
    sessionId: start.sessionId || path.basename(file, '.jsonl'),
    file: path.basename(file),
    path: file,
    schema: start.schema || INSPECTION_SCHEMA,
    baseline: baselineFrame ? {
      path: baselineFrame.path || null,
      sha256: baselineFrame.sha256 || null,
      stateSha256: baselineFrame.stateSha256 || null,
      bytes: baselineFrame.bytes ?? null,
    } : null,
    startedAt: start.ts || null,
    endedAt: end?.ts || null,
    seq: frames.reduce((max, frame) => Math.max(max, Number(frame.seq) || 0), 0),
    frames: frames.length,
    events: events.length,
    marks: marks.map((frame) => ({ seq: frame.seq, ts: frame.ts, text: frame.text, tags: frame.tags, kind: frame.kind, stateSha256: frame.stateSha256 || null, coordinates: frame.coordinates || null })),
    captures: captures.map((frame) => ({ seq: frame.seq, ts: frame.ts, label: frame.label || null, stateSha256: frame.stateSha256 || null, coordinates: frame.coordinates || null, display: frame.display || null })),
    paused: frames.some((frame) => frame.frame === 'session.paused'),
    corrupt,
    recentFrames: frames.slice(-Math.max(1, Math.min(maxFrames, 500))),
  }
}

export function readInspectionSessions(stateDir, { maxFrames = MAX_FRAMES } = {}) {
  const dir = inspectionDir(stateDir)
  if (!existsSync(dir)) return { dir, sessions: [], corrupt: [] }
  const sessions = []
  const corrupt = []
  for (const name of readdirSync(dir).filter((item) => /^insp-.+\.jsonl$/.test(item)).sort()) {
    const session = readSessionFile(path.join(dir, name), { maxFrames })
    sessions.push(session)
    corrupt.push(...session.corrupt.map((reason) => ({ file: name, reason })))
  }
  sessions.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))
  return { dir, sessions, corrupt }
}

export function readInspectionSession(stateDir, sessionId, options = {}) {
  const dir = inspectionDir(stateDir)
  const file = path.join(dir, `${sessionId}.jsonl`)
  if (!existsSync(file)) return null
  return readSessionFile(file, options)
}

/** Compact facts for a snapshot: counts and the latest sessions without full frames. */
export function inspectionSummary(stateDir, options = {}) {
  const { sessions, corrupt } = readInspectionSessions(stateDir, options)
  return {
    sessions: sessions.length,
    events: sessions.reduce((total, session) => total + session.events, 0),
    marks: sessions.reduce((total, session) => total + session.marks.length, 0),
    captures: sessions.reduce((total, session) => total + session.captures.length, 0),
    corrupt: corrupt.length,
    live: sessions.length ? !sessions[0].endedAt : false,
    paused: sessions.length ? sessions[0].paused : false,
    recent: sessions.slice(0, 5).map((session) => ({
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      events: session.events,
      marks: session.marks.length,
      captures: session.captures.length,
      frames: session.frames,
      paused: session.paused,
      live: !session.endedAt,
      corrupt: session.corrupt,
    })),
  }
}
