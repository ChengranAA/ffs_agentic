/**
 * Presentation defaults from established preferences (RECORD.md §7.6).
 *
 * Only non-scientific, established presentation preferences are applicable. Scientific kinds
 * (threshold, qc, exclusion, model, …) are deliberately excluded: a learned display habit may
 * change the view, never the analysis. Pure: no filesystem, no viewer calls.
 */

const FAMILIES = {
  alpha: (value) => {
    const number = Number(value)
    if (!Number.isFinite(number) || number < 0 || number > 1) return null
    return `SET_ALPHA S ${number}`
  },
  colormap: (value) => {
    const text = String(value || '').trim()
    if (!/^[A-Za-z0-9_+-]{1,40}$/.test(text)) return null
    return `SET_COLORMAP S ${text}`
  },
}

export function presentationCommand(record) {
  if (!record || record.active === false) return null
  if (record.status !== 'established') return null
  if (record.scientific === true) return null
  const family = record.recommendation?.family
  const handler = FAMILIES[family]
  if (!handler) return null
  return handler(record.recommendation?.value)
}

export function presentationPlan(profile) {
  if (!profile || !Array.isArray(profile.preferences)) return []
  const entries = []
  for (const record of profile.preferences) {
    const command = presentationCommand(record)
    if (!command) continue
    entries.push({
      id: record.id,
      version: record.version ?? null,
      family: record.recommendation.family,
      value: record.recommendation.value,
      command,
    })
  }
  return entries
}
