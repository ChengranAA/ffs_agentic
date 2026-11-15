import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeCommand,
  normalizeCommands,
  runCommandList,
  validateCommand,
  validateCommands,
} from '../ffs-analysis-ui/lib/commands.js'

test('normalizes commands and drops unusable entries', () => {
  const cleaned = normalizeCommands([
    { name: 'resample', argv: ['ffs_util_change_header', '-dxyz', '2'] },
    { scriptPath: 'scripts/check.sh', frozen: { sha256: 'abc', bytes: 10 } },
    { name: 'empty' },
    null,
  ])
  assert.equal(cleaned.length, 2)
  assert.deepEqual(cleaned[0].argv, ['ffs_util_change_header', '-dxyz', '2'])
  assert.equal(cleaned[1].name, 'check.sh')
  assert.equal(cleaned[1].frozen.sha256, 'abc')
  assert.deepEqual(normalizeCommands([{ argv: ['ffs_info'], env: { OK: '1', bad: '2' } }])[0].env, { OK: '1' })
  assert.equal(normalizeCommand({}, 0), null)
})

test('validates tools, ambiguity, env and script hashes', () => {
  const spawnable = validateCommand(normalizeCommand({ argv: ['ffs_info', '-help'] }))
  assert.equal(spawnable.errors.length, 0)

  const blocked = validateCommand(normalizeCommand({ argv: ['rm', '-rf', 'x'] }))
  assert.equal(blocked.errors[0].code, 'command-not-allowed')

  const ambiguous = validateCommand(normalizeCommand({ argv: ['ffs_info'], scriptPath: 'x.sh' }))
  assert.equal(ambiguous.errors[0].code, 'command-ambiguous')

  const env = validateCommand(normalizeCommand({ argv: ['ffs_info'], env: { lowercase: 'x' } }))
  assert.equal(env.errors.length, 0, 'normalizeCommand drops invalid env keys')

  const missing = validateCommand(normalizeCommand({ scriptPath: 'missing.sh' }), {
    checkFile: () => ({ exists: false }),
  })
  assert.equal(missing.errors[0].code, 'command-script-missing')

  const changed = validateCommand(normalizeCommand({
    scriptPath: 'step.sh', frozen: { sha256: 'old' },
  }), { checkFile: () => ({ exists: true, sha256: 'new' }) })
  assert.equal(changed.errors[0].code, 'command-script-changed')
  assert.equal(changed.errors[0].details.actual, 'new')

  const unfrozen = validateCommand(normalizeCommand({ scriptPath: 'step.sh' }), {
    checkFile: () => ({ exists: true, sha256: 'new' }),
  })
  assert.equal(unfrozen.errors.length, 0)
  assert.equal(unfrozen.warnings[0].code, 'command-script-unfrozen')
})

test('validates duplicate ids and aggregates results', () => {
  const result = validateCommands(normalizeCommands([
    { id: 'a', argv: ['ffs_info'] },
    { id: 'a', argv: ['ffs_info'] },
  ]))
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.code === 'command-duplicate-id'))
})

test('runs commands in order and stops at the first failure', async () => {
  const seen = []
  const updates = []
  const result = await runCommandList({
    commands: [
      { id: 'a', name: 'one', argv: ['ffs_info'] },
      { id: 'b', name: 'two', argv: ['ffs_info'] },
      { id: 'c', name: 'three', argv: ['ffs_info'] },
    ],
    spawnOne: async (command) => {
      seen.push(command.id)
      return { exitCode: command.id === 'b' ? 3 : 0, durationMs: 5, outputs: [], missing: [] }
    },
    onUpdate: (update) => updates.push(`${update.command.id}:${update.status}`),
  })
  assert.deepEqual(seen, ['a', 'b'])
  assert.equal(result.ok, false)
  assert.equal(result.failedAt, 1)
  assert.deepEqual(updates.filter((entry) => entry.endsWith(':ok')), ['a:ok'])
})

test('stops before starting when cancelled', async () => {
  let spawned = false
  const result = await runCommandList({
    commands: [{ id: 'a', name: 'one', argv: ['ffs_info'] }, { id: 'b', name: 'two', argv: ['ffs_info'] }],
    spawnOne: async () => { spawned = true; return { exitCode: 0, durationMs: 1, outputs: [], missing: [] } },
    shouldStop: () => true,
  })
  assert.equal(spawned, false)
  assert.equal(result.cancelled, true)
})
