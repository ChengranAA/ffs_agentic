import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = readFileSync(path.join(ROOT, 'ffs-record', 'client.js'), 'utf8')

test('Record client destructures every React hook it calls', () => {
  assert.match(CLIENT, /const \{ useCallback, useEffect, useRef, useState \} = React/, 'useRef is imported')
})

test('Record settings section exposes retention, policy and rebuild', () => {
  assert.match(CLIENT, /function SettingsSection/, 'Settings section exists')
  assert.match(CLIENT, /raw retention/, 'retention settings are shown')
  assert.match(CLIENT, /recency half-life/, 'recency half-life is shown')
  assert.match(CLIENT, /policy file/, 'policy path is shown')
  assert.match(CLIENT, /ffs-record\/rebuild/, 'rebuild action calls the Host route')
  assert.match(CLIENT, /pause in the viewer/, 'recording default is explained')
  assert.match(CLIENT, /ffs-record\/runs\?/, 'attempts query the filtered runs route')
  assert.match(CLIENT, /any status/, 'attempt filters include status')
  assert.match(CLIENT, /any actor/, 'attempt filters include actor')
  assert.match(CLIENT, /ffs-record\/family\?family=decisions/, 'decisions query status-filtered route')
  assert.match(CLIENT, /ffr-history/, 'decision history expands inline')
  assert.match(CLIENT, /recording paused/, 'inspection shows paused state')
  assert.match(CLIENT, /Open in viewer/, 'inspection can open the viewer')
  assert.match(CLIENT, /inspection\?session=.*frames=100/, 'inspection loads a bounded event list')
  assert.match(CLIENT, /function DecisionComposer/, 'decision composer modal exists')
  assert.match(CLIENT, /ffs-analysis\/decisions/, 'composer writes to the shared decision store')
  assert.match(CLIENT, /ffr-modal-backdrop/, 'composer is modal')
  assert.match(CLIENT, /addEventListener\('keydown', handler, true\)/, 'composer traps keys in capture phase')
  assert.match(CLIENT, /stopImmediatePropagation/, 'composer Escape is isolated')
  assert.match(CLIENT, /inspection_pause/, 'Record tab can pause/resume recording')
  assert.match(CLIENT, /Resume recording/, 'recording toggle has pause/resume labels')
  assert.match(CLIENT, /confirmPreference/, 'pending preference confirmation can be answered')
  assert.match(CLIENT, /class RecordBoundary/, 'record tab has an error boundary')
  assert.match(CLIENT, /record 0\.1\.12/, 'record tab shows its build stamp')
  assert.doesNotMatch(CLIENT, /'withdraw', 'exclude', 'include'/, 'composer only offers actions the route accepts')
  assert.match(CLIENT, /'accept', 'tentative', 'reject', 'undecided'/, 'composer actions match DECISION_ACTIONS')
  assert.match(CLIENT, /relative to the work dir/, 'composer path help matches the route semantics')
  assert.match(CLIENT, /\.ffr-root \{[^}]*flex: 1 1 auto/, 'record root fills the flex tab body')
  assert.match(CLIENT, /\.ffr-root \{[^}]*min-height: 0/, 'record root can shrink and scroll')
  assert.match(CLIENT, /\.ffr-root, \.ffr-root \* \{ box-sizing: border-box/, 'record padding is inside the width')
  assert.match(CLIENT, /padding: 10px 12px/, 'record has right padding')
  assert.match(CLIENT, /table-layout: fixed/, 'record tables stay inside the canvas')
})
