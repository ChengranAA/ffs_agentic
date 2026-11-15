import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CSS = readFileSync(path.join(ROOT, 'ffs-analysis-ui', 'client.js'), 'utf8')
const CLIENT = CSS

test('the options drawer does not create a nested fixed-height scroll trap', () => {
  const fieldsRule = /\.ffa-options-scroll\s*\{([^}]*)\}/.exec(CSS)?.[1] || ''
  assert.doesNotMatch(fieldsRule, /max-height:\s*\d/, 'drawer fields must not have a fixed height')
  assert.match(fieldsRule, /overflow:\s*visible/, 'drawer fields flow inside the drawer scroll region')
  const groupsRule = /\.ffa-options-groups\s*\{([^}]*)\}/.exec(CSS)?.[1] || ''
  assert.doesNotMatch(groupsRule, /max-height:\s*\d/, 'group list must not trap scrolling')
  const rootRule = /\.ffa-root\s*\{([^}]*)\}/.exec(CSS)?.[1] || ''
  assert.match(rootRule, /overflow-y:\s*auto/, 'the panel root is the single scroll container')
  assert.match(rootRule, /flex:\s*1 1 auto/, 'root fills the flex tab body')
  assert.match(rootRule, /min-height:\s*0/, 'root may shrink to the tab body')
  assert.doesNotMatch(rootRule, /position:\s*absolute/, 'absolute root is clipped by the flex tab body')
  assert.match(CSS, /\.ffa-content\s*\{[^}]*overflow:\s*visible/, 'content does not create a nested scroller')
})

test('stage options open in a fixed dialog and the board stays compact', () => {
  const board = /\.ffa-stage-board\s*\{([^}]*)\}/.exec(CSS)?.[1] || ''
  assert.match(board, /height:\s*auto/, 'board shows every stage instead of clipping a partial row')
  assert.match(board, /width:\s*100%/, 'board uses the full planner width')
  assert.match(CSS, /\.ffa-group-label\s*\{[^}]*white-space:\s*normal/, 'option group labels wrap instead of truncating')
  assert.match(CSS, /StageOptionsDialog/, 'stage options render in a dialog component')
  assert.match(CLIENT, /ffa-stage-board-foot/, 'board shows its scroll/included affordance')
  assert.match(CLIENT, /scrollIntoView/, 'selected stage is scrolled into view')
  const toast = /\.ffa-toast\s*\{([^}]*)\}/.exec(CSS)?.[1] || ''
  assert.match(toast, /position:\s*sticky/, 'toast stays visible while the panel scrolls')
  assert.match(CLIENT, /class SectionBoundary/, 'sections have a crash boundary')
  assert.match(CLIENT, /Resolved command copied/, 'resolved command can be copied')
  assert.match(CLIENT, /contrastNames/, 'group analysis contrast is selectable')
  assert.match(CLIENT, /onRunGroup\(\{\s*contrast,/, 'group run passes the selected contrast')
  assert.match(CLIENT, /const overlap = a\.filter/, 'two-group split detects overlapping subjects')
  assert.match(CLIENT, /runHint/, 'disabled group run explains why')
  assert.doesNotMatch(CLIENT, /scenes > baseline, t=3\.1/, 'results caption is not hardcoded')
  assert.match(CLIENT, /results\.threshold \?\? '—'/, 'results caption uses the live threshold')
  assert.match(CLIENT, /analysis\.error \? 'failed' : \(analysis\.status \|\| 'completed'\)/, 'group analysis status is not inverted')
  assert.doesNotMatch(CLIENT, /analysis\.status \|\| analysis\.error \? 'failed'/, 'status/error precedence bug is gone')
  assert.match(CLIENT, /const artifactKey =/, 'artifact selection uses a stable key')
  assert.doesNotMatch(CLIENT, /selected\.id === artifact\.id/, 'artifacts without ids cannot all look selected')
  assert.match(CLIENT, /includedCount/, 'cohort shows the live included count')
  assert.match(CLIENT, /issueCount/, 'cohort validation reports issue counts')
  assert.match(CLIENT, /figureKey/, 'QC composer compares stable figure keys')
  assert.match(CLIENT, /useStoredState\(/, 'group form values are persisted')
  assert.match(CLIENT, /Reset stage/, 'stage dialog can reset its overrides')
  assert.match(CLIENT, /localeCompare\(String\(a\.at/, 'group history is sorted newest first')
  assert.match(CLIENT, /analysis\.at/, 'group history shows the run time')
  assert.match(CLIENT, /Copy summary/, 'group analyses can copy a summary')
  assert.match(CLIENT, /Export cohort/, 'cohort package can be exported from the panel')
  assert.match(CLIENT, /busyCohortExport/, 'cohort export has a busy state')
  assert.match(CLIENT, /lastExport/, 'cohort export result is shown in the panel')
  assert.match(CLIENT, /outputTruncated/, 'scratch output reports truncation')
  assert.match(CLIENT, /Inherited from recipe/, 'stage dialog shows recipe-inherited values')
  assert.match(CLIENT, /last run:/, 'stage dialog shows last-run state')
  assert.match(CLIENT, /runStageById/, 'stage board annotates done stages from the last run')
  assert.match(CLIENT, /selectedCoverage/, 'recipe coverage is shown')
  assert.match(CLIENT, /reset recipe/, 'recipe overrides can be reset')
  assert.match(CLIENT, /Output script/, 'output script is editable')
  assert.match(CLIENT, /ffa-chip-value/, 'list flags use add/remove chips')
  assert.match(CLIENT, /ffa-chip-remove/, 'chips can be removed')
  assert.match(CLIENT, /ffa-chip-editable/, 'repeatable append flags use editable chips')
  assert.match(CLIENT, /ffa-field-default/, 'overridden fields show their default')
  assert.match(CLIENT, /ffa-path-picker|ffa-path-panel/, 'path flags open a picker dialog')
  assert.match(CLIENT, /Generate script/, 'planner bar offers Generate script')
  assert.match(CLIENT, /runningNow \? 'Running…'/, 'planner bar offers Run with running state')
  assert.match(CLIENT, /validationErrors\.length > 0/, 'Generate is blocked by validation errors')
  assert.match(CLIENT, /Fix \$\{validationErrors\.length\} validation error/, 'Generate explains the block')
  assert.match(CLIENT, /validationWarnings\.length/, 'planner header summarizes warnings')
  assert.match(CLIENT, /\$\{blockers\.length\} error/, 'planner header summarizes blockers')
  assert.match(CLIENT, /const validationRef = useRef\(null\)/, 'validation ref exists')
  assert.ok(CLIENT.indexOf('const validationRef = useRef') < CLIENT.indexOf('if (error) {'), 'validation ref is declared before any early return')
  assert.match(CLIENT, /blockers\.length > 0 \|\| dirty/, 'Run is blocked by blockers and dirty state')
  assert.match(CLIENT, /Generate and Run are in the planner header/, 'pipeline card defers actions to the header')
  assert.match(CLIENT, /ffa-run-chip/, 'header shows live run progress')
  assert.match(CLIENT, /id: 'ffa-pipeline-run'/, 'run card is a scroll target')
  assert.match(CLIENT, /scrollIntoView.*ffa-pipeline-run|ffa-pipeline-run.*scrollIntoView/, 'run auto-scrolls to the pipeline')
  assert.match(CLIENT, /generateError/, 'generation failures are retained')
  assert.match(CLIENT, /Script generation failed/, 'generation failure is shown in the validation block')
  assert.match(CLIENT, /blockers\.length > 0/, 'generation failure blocks Run')
  assert.match(CLIENT, /scrollIntoView.*block: 'center'/, 'validation pills jump to the block')
  assert.match(CLIENT, /ffs-analysis\/browse/, 'path picker browses project files')
  assert.match(CLIENT, /changedTotal/, 'options drawer shows changed count')
  assert.match(CLIENT, /ffa-drawer-foot/, 'options drawer carries the flags footer')
  assert.match(CLIENT, /ffa-option-group/, 'options are rendered as per-group accordions')
  assert.match(CLIENT, /openGroups/, 'accordion open state is tracked')
  assert.match(CLIENT, /title: group\.title/, 'option group buttons expose full titles')
  assert.match(CLIENT, /ffa-cmd-row > \.ffa-small/, 'scratch/command rows wrap long text')
  assert.match(CLIENT, /provenanceBusy/, 'provenance actions cannot run concurrently')
  assert.match(CLIENT, /ffs-group-contrast/, 'group contrast selection is persisted')
  assert.match(CLIENT, /ffs-results-threshold/, 'results threshold is persisted')
  assert.match(CLIENT, /ffs-default-threshold/, 'settings defaults are persisted')
  assert.doesNotMatch(CLIENT, /pending\.figure !== figure/, 'QC composer survives snapshot polling')
})

test('All options is a full-height overlay with its own scroll body', () => {
  assert.match(CSS, /\.ffa-drawer-backdrop\s*\{[^}]*position:\s*fixed/, 'drawer escapes ancestor clipping')
  const panelRule = /\.ffa-drawer-panel\s*\{([^}]*)\}/.exec(CSS)?.[1] || ''
  assert.match(panelRule, /height:\s*100%/, 'panel fills the viewport area')
  assert.match(panelRule, /overflow:\s*hidden/, 'panel clips its header/body only')
  const bodyRule = /\.ffa-drawer-body\s*\{([^}]*)\}/.exec(CSS)?.[1] || ''
  assert.match(bodyRule, /overflow:\s*auto/, 'drawer body is the scroll container')
  assert.match(bodyRule, /min-height:\s*0/, 'drawer body can shrink inside the flex panel')
})

test('the stage board keeps its own compact scroll but the drawer does not', () => {
  assert.match(CSS, /\.ffa-scroll\s*\{[^}]*overflow:\s*auto/, 'stage board retains a local scroll')
  assert.match(CSS, /\.ffa-options-scroll\s*\{[^}]*overflow:\s*visible/, 'drawer list has no local scroll')
})
