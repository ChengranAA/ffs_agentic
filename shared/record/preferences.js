/**
 * Read the derived preference profile produced by `python -m ffsrecord.cli profile`.
 * Read-only: the profile is derived from evidence; nothing here mutates it.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const PROFILE_SCHEMA = 'ffs-record-profile/1'

export function preferencesDir(projectRoot) {
  return path.join(projectRoot, 'work', 'ffs-record', 'preferences')
}

export function readPreferenceProfile(projectRoot) {
  const file = path.join(preferencesDir(projectRoot), 'profile.json')
  if (!existsSync(file)) return null
  try {
    const profile = JSON.parse(readFileSync(file, 'utf8'))
    if (!profile || profile.schema !== PROFILE_SCHEMA) return null
    return profile
  } catch {
    return null
  }
}

export function preferenceSummary(projectRoot) {
  const profile = readPreferenceProfile(projectRoot)
  if (!profile) return { available: false, count: 0, stats: {}, recent: [] }
  const preferences = Array.isArray(profile.preferences) ? profile.preferences : []
  return {
    available: true,
    schema: profile.schema,
    generatedAt: profile.generatedAt,
    count: preferences.length,
    stats: profile.stats || {},
    evidence: profile.evidence || null,
    conflicts: Array.isArray(profile.conflicts) ? profile.conflicts.length : 0,
    recent: preferences.slice(0, 5).map((record) => ({
      id: record.id,
      version: record.version,
      status: record.status,
      kind: record.kind,
      scientific: record.scientific === true,
      recommendation: record.recommendation?.action || null,
      score: record.evidence?.score ?? null,
      sessions: record.evidence?.sessions ?? null,
    })),
  }
}
