/**
 * Post-autoproc command steps: normalization, validation and sequential execution.
 *
 * Pure except for the injected `spawnOne`, so the scheduler is testable with a fake runner.
 * The Host supplies the real child-process spawner, path resolution and hashing.
 */

export const TOOL_WHITELIST = /^(ffs_[a-z0-9_]+|3d[A-Za-z0-9_]+|python3?|Rscript|zstd)$/

const ENV_KEY = /^[A-Z][A-Z0-9_]*$/

function basename(value) {
  return String(value || '').split('/').filter(Boolean).pop() || 'command'
}

/** Normalize one command from the pipeline file. Returns null for unusable entries. */
export function normalizeCommand(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null
  const argv = Array.isArray(raw.argv) ? raw.argv.map(String).filter((item) => item !== '') : []
  const scriptPath = raw.scriptPath ? String(raw.scriptPath) : null
  if (!argv.length && !scriptPath) return null
  const env = {}
  if (raw.env && typeof raw.env === 'object') {
    for (const [key, value] of Object.entries(raw.env)) {
      if (ENV_KEY.test(key)) env[key] = String(value)
    }
  }
  const expect = Array.isArray(raw.expect) ? raw.expect.map(String) : []
  return {
    id: raw.id ? String(raw.id) : `cmd-${index + 1}`,
    name: raw.name ? String(raw.name) : (scriptPath ? basename(scriptPath) : basename(argv[0])),
    argv,
    scriptPath,
    cwd: raw.cwd ? String(raw.cwd) : null,
    env,
    expect,
    frozen: raw.frozen && typeof raw.frozen === 'object' ? {
      sha256: raw.frozen.sha256 ? String(raw.frozen.sha256) : null,
      bytes: Number.isFinite(Number(raw.frozen.bytes)) ? Number(raw.frozen.bytes) : null,
      at: raw.frozen.at ? String(raw.frozen.at) : null,
    } : null,
    origin: raw.origin && typeof raw.origin === 'object' ? { ...raw.origin } : { kind: 'user' },
  }
}

export function normalizeCommands(list) {
  if (!Array.isArray(list)) return []
  return list.map((item, index) => normalizeCommand(item, index)).filter(Boolean)
}

/**
 * Structural validation. Filesystem facts (script exists, hash matches, executable present)
 * are supplied by the Host through `checkFile`.
 */
export function validateCommand(command, { checkFile } = {}) {
  const errors = []
  const warnings = []
  if (!command) return { errors: [{ code: 'command-invalid', message: 'empty command' }], warnings }
  if (command.scriptPath && command.argv.length) {
    errors.push({ code: 'command-ambiguous', message: `${command.name}: use either argv or a script path, not both` })
  }
  if (!command.scriptPath && !command.argv.length) {
    errors.push({ code: 'command-empty', message: `${command.name}: argv is empty` })
  }
  if (command.argv.length) {
    if (!TOOL_WHITELIST.test(basename(command.argv[0]))) {
      errors.push({ code: 'command-not-allowed', message: `${command.name}: tool not allowed: ${command.argv[0]}` })
    }
    if (command.argv.some((item) => item.includes('\u0000'))) {
      errors.push({ code: 'command-invalid', message: `${command.name}: argv contains a NUL byte` })
    }
  }
  for (const key of Object.keys(command.env || {})) {
    if (!ENV_KEY.test(key)) errors.push({ code: 'command-env', message: `${command.name}: env key not allowed: ${key}` })
  }
  if (command.scriptPath && checkFile) {
    const facts = checkFile(command.scriptPath)
    if (!facts.exists) {
      errors.push({ code: 'command-script-missing', message: `${command.name}: script not found: ${command.scriptPath}` })
    } else if (command.frozen?.sha256 && facts.sha256 && facts.sha256 !== command.frozen.sha256) {
      errors.push({
        code: 'command-script-changed',
        message: `${command.name}: ${command.scriptPath} changed on disk — re-freeze it`,
        details: { id: command.id, expected: command.frozen.sha256, actual: facts.sha256 },
      })
    } else if (!command.frozen?.sha256 && facts.sha256) {
      warnings.push({ code: 'command-script-unfrozen', message: `${command.name}: script will be frozen on save` })
    }
  }
  return { errors, warnings }
}

export function validateCommands(commands, options = {}) {
  const errors = []
  const warnings = []
  const ids = new Set()
  for (const command of commands) {
    if (ids.has(command.id)) errors.push({ code: 'command-duplicate-id', message: `duplicate command id: ${command.id}` })
    ids.add(command.id)
    const result = validateCommand(command, options)
    errors.push(...result.errors)
    warnings.push(...result.warnings)
  }
  return { ok: errors.length === 0, errors, warnings }
}

/**
 * Run commands one at a time. `spawnOne(command)` resolves to a record
 * `{exitCode, durationMs, outputs?, missing?, error?}` and must not throw for a normal
 * non-zero exit. `onUpdate(update)` reports lifecycle events for the run state/log.
 * Returns as soon as a command fails; earlier records are preserved.
 */
export async function runCommandList({ commands, spawnOne, onUpdate = () => {}, shouldStop = () => false }) {
  const records = []
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index]
    if (shouldStop()) {
      onUpdate({ index, command, status: 'cancelled' })
      return { ok: false, cancelled: true, records }
    }
    onUpdate({ index, command, status: 'running' })
    let record
    try {
      record = await spawnOne(command)
    } catch (error) {
      record = { exitCode: 1, durationMs: 0, error: String(error?.message || error), outputs: [], missing: [] }
    }
    records.push(record)
    if (record.exitCode !== 0 || (record.missing || []).length || record.error) {
      onUpdate({ index, command, status: 'failed', record })
      return { ok: false, failedAt: index, records }
    }
    onUpdate({ index, command, status: 'ok', record })
  }
  return { ok: true, records }
}
