import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = readFileSync(path.join(ROOT, 'ffs-analysis-ui', 'client.js'), 'utf8')

test('both analysis dialogs manage focus and trap Tab', () => {
  assert.match(CLIENT, /function useDialogFocus\(onClose, panelRef\)/, 'shared focus hook exists')
  assert.match(CLIENT, /closeRef\.current\?\.focus\?\.\(\)/, 'Close receives focus on open')
  assert.match(CLIENT, /previous\?\.focus\?\.\(\)/, 'focus is restored on close')
  assert.match(CLIENT, /onCloseRef\.current/, 'onClose is held in a ref so typing cannot retrigger focus')
  assert.match(CLIENT, /\}, \[panelRef\]\)/, 'focus setup does not depend on inline callbacks')
  assert.match(CLIENT, /event\.key !== 'Tab'/, 'Tab handling exists')
  assert.match(CLIENT, /'aria-modal': 'true'/, 'dialogs are modal')
  const hookUses = CLIENT.match(/useDialogFocus\(onClose, panelRef\)/g) || []
  assert.equal(hookUses.length, 3, 'hook is defined and used by both dialogs')
})

test('path picker traps focus and closes independently', () => {
  assert.match(CLIENT, /ffa-path-panel/, 'path picker dialog exists')
  assert.match(CLIENT, /addEventListener\('keydown', handler, true\)/, 'picker uses capture-phase keys')
  assert.match(CLIENT, /stopImmediatePropagation\(\)/, 'Escape does not also close the parent drawer')
})

test('panel remembers the active section and warns about remote pipeline edits', () => {
  assert.match(CLIENT, /ffs-analysis-section/, 'section selection is persisted')
  assert.match(CLIENT, /pipeline changed on disk/, 'dirty draft shows a remote-change warning')
  assert.match(CLIENT, /remoteVersion/, 'remote version is tracked')
})
