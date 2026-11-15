import test from 'node:test'
import assert from 'node:assert/strict'

import {
  RESERVED_DESTS,
  defaultPipeline,
  detectionFromScan,
  formatArgv,
  migratePipelineFromState,
  normalizePipeline,
  resolvePipelineArgv,
  stagePlan,
  validatePipeline,
} from '../ffs-analysis-ui/lib/pipeline.js'

const model = {
  defaults: { go_to_anat: true, distortion: true, run_glm: true, locomoco: false },
  recipes: [
    {
      id: 'complete',
      settings: {
        go_to_anat: true, distortion: true, run_glm: true,
        xrun_nonlin: true, anat_nonlin: true, slicetiming_method: 'integrate',
        moco_ref: 'sbref',
      },
    },
    {
      id: 'bare_bones',
      settings: { go_to_anat: false, distortion: false, run_glm: true, slicetiming_method: 'none' },
    },
  ],
  groups: [{
    title: 'Inputs & scope',
    flags: [
      { dest: 'device', flag: '-device', kind: 'value' },
      { dest: 'no_qc', flag: '-no_qc', kind: 'bool' },
      { dest: 'do_mni', flag: '-do_mni', kind: 'bool' },
      { dest: 'anat', flag: '-anat', kind: 'value' },
      { dest: 'surface_target', flag: '-surface_target', kind: 'list' },
      { dest: 'surface_glm', flag: '-surface_glm', kind: 'bool' },
      { dest: 'tpm', flag: '-tpm', kind: 'value' },
      { dest: 'moco_ref', flag: '-moco_ref', kind: 'value', type: 'str' },
      { dest: 'moco_opts', flag: '-moco_opts', kind: 'value', type: 'str' },
      { dest: 'nordic_dof_adjust', flag: '-no_nordic_dof_adjust', kind: 'bool', action: 'store_false', default: true },
      { dest: 'acq', flag: '-acq', kind: 'value', choices: ['auto', '2d', '3d'] },
      { dest: 'family', flag: '-family', kind: 'list', action: 'append', nargs: 2 },
      { dest: 'glm_blur', flag: '-glm_blur', kind: 'list', action: 'append', nargs: '+' },
      { dest: 'event_filter_in', flag: '-event_filter_in', kind: 'list', action: 'append', nargs: '+', choices: ['rest', 'nback'] },
    ],
  }],
  pathFlags: ['anat', 'surface_target', 'ref_transforms'],
  stages: [
    { id: 'preflight', label: 'preflight', phase: 'Prep', tools: [], flags: [], opts: [], when: [{ any: ['always'] }] },
    { id: 'stage00', label: 'NORDIC', phase: 'Denoise', tools: ['ffs_nordic'], flags: [], opts: [], when: [{ any: ['flag:want_nordic', 'data:phase'] }] },
    { id: 'stage02', label: 'moco', phase: 'Timing & motion', tools: ['ffs_moco'], flags: ['moco_ref'], opts: ['moco_opts'], when: [{ any: ['always'] }] },
    { id: 'stage04', label: 'fieldmap', phase: 'Distortion', tools: ['ffs_blipflip'], flags: [], opts: [], when: [{ any: ['recipe:distortion'] }, { any: ['data:fieldmaps'] }] },
    { id: 'stage09', label: 'anat', phase: 'Alignment', tools: [], flags: ['anat'], opts: [], when: [{ any: ['recipe:go_to_anat'] }] },
    { id: 'stage09b', label: 'MNI', phase: 'Alignment', tools: [], flags: ['do_mni'], opts: [], when: [{ any: ['override:do_mni'] }] },
    { id: 'stage12', label: 'GLM', phase: 'Model', tools: ['ffs_reml'], flags: [], opts: [], when: [{ any: ['recipe:run_glm'] }] },
  ],
  reasonText: {
    'data:phase': 'no phase data detected',
    'data:fieldmaps': 'no fieldmaps detected',
    'recipe:distortion': 'distortion not in this recipe',
    'recipe:go_to_anat': 'anat not in this recipe',
    'recipe:run_glm': 'GLM disabled',
    'override:do_mni': '-do_mni not set',
  },
}

const resolvePath = (rel, label) => {
  if (String(rel).startsWith('/')) throw new Error(`absolute path not allowed: ${label}`)
  return `/project/${String(rel).replace(/^\.\//, '')}`
}

const detection = {
  runs: 4, sessions: 1, tasks: ['localizer'], fieldmaps: true, fieldmapGroups: 2, fieldmapFiles: 4,
  sliceTiming: true, phase: false, sbref: true, echoes: 1,
  anat: ['data/real/ds005165/sub-01/ses-01/anat/sub-01_ses-01_T1w.nii.gz'],
}

function basePipeline(overrides = {}) {
  return defaultPipeline({
    bidsDir: 'data/real/ds005165', subject: '01', session: ['01'], task: ['localizer'],
    workDir: 'work/ds005165/sub-01', recipe: 'complete', overrides, ...overrides,
  })
}

test('external input roots are allowed while outputs stay inside the project', () => {
  const base = basePipeline()
  const external = normalizePipeline({
    ...base,
    scope: { ...base.scope, bidsDir: '/data/real/bids' },
  })
  const resolved = resolvePipelineArgv({
    pipeline: external,
    model,
    resolvePath: (rel) => (String(rel).startsWith('/') ? rel : `/project/${rel}`),
    resolveOutputPath: (rel) => `/project/${String(rel).replace(/^\.\//, '')}`,
  })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.args[resolved.args.indexOf('-bids_dir') + 1], '/data/real/bids')
  assert.match(resolved.args[resolved.args.indexOf('-work_dir') + 1], /^\/project\//)
  assert.match(resolved.args[resolved.args.indexOf('-out') + 1], /^\/project\//)
})

test('optional output script overrides the derived path', () => {
  const base = basePipeline()
  const custom = normalizePipeline({ ...base, scope: { ...base.scope, out: 'work/custom/proc.sh' } })
  const resolved = resolvePipelineArgv({ pipeline: custom, model, resolvePath })
  assert.equal(resolved.ok, true)
  assert.ok(resolved.args.includes('/project/work/custom/proc.sh'))
  const bad = normalizePipeline({ ...base, scope: { ...base.scope, out: 'work/custom/proc.txt' } })
  const badResolved = resolvePipelineArgv({ pipeline: bad, model, resolvePath })
  assert.equal(badResolved.ok, false)
  assert.ok(badResolved.errors.some((error) => error.code === 'scope-out'))
})

test('stage plan exposes recipe-inherited values and respects overrides', () => {
  const inheritedPlan = stagePlan({ model, pipeline: basePipeline(), detection })
  const moco = inheritedPlan.find((stage) => stage.id === 'stage02')
  assert.deepEqual(moco.inherited, [{ dest: 'moco_ref', source: 'complete', value: 'sbref' }])
  const overridden = stagePlan({ model, pipeline: basePipeline({ moco_ref: 'first' }), detection })
  assert.deepEqual(overridden.find((stage) => stage.id === 'stage02').inherited, [])
  const noRecipe = stagePlan({ model, pipeline: defaultPipeline({ recipe: null }), detection })
  assert.deepEqual(noRecipe.find((stage) => stage.id === 'stage02').inherited, [])
})

test('normalizes and migrates a pipeline', () => {
  const migrated = migratePipelineFromState({
    params: { bidsDir: 'data/bids', subject: '01', session: '01', task: 'rest', recipe: 'complete', device: 'cpu', noQc: false },
    workDir: 'work/bids/sub-01',
  })
  assert.equal(migrated.scope.subject, '01')
  assert.equal(migrated.scope.workDir, 'work/bids/sub-01')
  assert.deepEqual(migrated.scope.session, ['01'])
  assert.equal(migrated.recipe, 'complete')
  assert.equal(migrated.overrides.device, 'cpu')
  assert.equal(migrated.overrides.no_qc, false)
  assert.equal(migrated.history.length, 1)
  assert.equal(normalizePipeline({}).schema, 'ffs-panel-pipeline/1')
})

test('builds the exact autoproc argv from scope, recipe and overrides', () => {
  const pipeline = basePipeline({ no_qc: true, do_mni: true, anat: 'anat/T1w.nii.gz', surface_target: ['native', 'onavg-ico64'] })
  const resolved = resolvePipelineArgv({ pipeline, model, resolvePath })
  assert.equal(resolved.ok, true)
  assert.deepEqual(resolved.args, [
    '-m', 'fastfuncstuff.cli.autoproc',
    '-bids_dir', '/project/data/real/ds005165',
    '-subject', '01',
    '-session', '01',
    '-task', 'localizer',
    '-work_dir', '/project/work/ds005165/sub-01',
    '-out', '/project/work/ds005165/sub-01/proc_sub-01.sh',
    '-recipe', 'complete',
    '-no_qc',
    '-do_mni',
    '-anat', '/project/anat/T1w.nii.gz',
    '-surface_target', 'native', 'onavg-ico64',
  ])
})

test('handles store_true and store_false booleans correctly', () => {
  const falseBools = resolvePipelineArgv({
    pipeline: basePipeline({ no_qc: false, do_mni: false }), model, resolvePath,
  })
  assert.equal(falseBools.ok, true)
  assert.ok(!falseBools.args.includes('-no_qc'))
  assert.ok(!falseBools.args.includes('-do_mni'))

  const inverseOff = resolvePipelineArgv({
    pipeline: basePipeline({ nordic_dof_adjust: false }), model, resolvePath,
  })
  assert.ok(inverseOff.args.includes('-no_nordic_dof_adjust'))
  const inverseOn = resolvePipelineArgv({
    pipeline: basePipeline({ nordic_dof_adjust: true }), model, resolvePath,
  })
  assert.ok(!inverseOn.args.includes('-no_nordic_dof_adjust'))
})

test('accepts any typed override and rejects reserved, unknown or invalid ones', () => {
  const typed = resolvePipelineArgv({
    pipeline: basePipeline({ moco_ref: 'first', moco_opts: '-cost lpa -twopass', acq: '2d' }),
    model, resolvePath,
  })
  assert.equal(typed.ok, true, JSON.stringify(typed.errors))
  assert.ok(typed.args.includes('-moco_ref'))
  assert.ok(typed.args.includes('first'))
  assert.ok(typed.args.includes('-moco_opts'))
  assert.ok(typed.args.includes('-cost lpa -twopass'))
  assert.ok(typed.args.includes('-acq'))

  const reserved = resolvePipelineArgv({ pipeline: basePipeline({ subject: 'x' }), model, resolvePath })
  assert.equal(reserved.ok, false)
  assert.equal(reserved.errors[0].code, 'override-reserved')
  assert.ok(RESERVED_DESTS.has('subject'))

  const unknown = resolvePipelineArgv({ pipeline: basePipeline({ not_a_flag: 1 }), model, resolvePath })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.errors[0].code, 'override-unknown')

  const badChoice = resolvePipelineArgv({ pipeline: basePipeline({ acq: '4d' }), model, resolvePath })
  assert.equal(badChoice.ok, false)
  assert.equal(badChoice.errors[0].code, 'override-invalid')

  const badBool = resolvePipelineArgv({ pipeline: basePipeline({ do_mni: 'yes' }), model, resolvePath })
  assert.equal(badBool.ok, false)
  assert.equal(badBool.errors[0].code, 'override-invalid')
})

test('rejects unknown recipes and invalid scope', () => {
  const unknown = resolvePipelineArgv({
    pipeline: { ...basePipeline(), recipe: 'nope' }, model, resolvePath,
  })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.errors[0].code, 'recipe-unknown')

  const badSubject = resolvePipelineArgv({
    pipeline: { ...basePipeline(), scope: { ...basePipeline().scope, subject: '01/../x' } }, model, resolvePath,
  })
  assert.equal(badSubject.ok, false)
  assert.ok(badSubject.errors.some((error) => error.code === 'scope-subject'))
})

test('stage plan explains applicability and changes', () => {
  const pipeline = basePipeline({ do_mni: true })
  const plan = stagePlan({ model, pipeline, detection })
  const byId = Object.fromEntries(plan.map((stage) => [stage.id, stage]))
  assert.equal(byId.preflight.included, true)
  assert.equal(byId.stage00.included, false)
  assert.equal(byId.stage00.reason, 'no phase data detected')
  assert.equal(byId.stage04.included, true)
  assert.equal(byId.stage09.included, true)
  assert.equal(byId.stage09b.included, true)
  assert.equal(byId.stage09b.changed, true)

  const noFmaps = stagePlan({ model, pipeline, detection: { ...detection, fieldmaps: false, fieldmapGroups: 0, fieldmapFiles: 0 } })
  assert.equal(noFmaps.find((stage) => stage.id === 'stage04').included, false)
  assert.equal(noFmaps.find((stage) => stage.id === 'stage04').reason, 'no fieldmaps detected')

  const bare = stagePlan({ model, pipeline: { ...basePipeline(), recipe: 'bare_bones' }, detection })
  assert.equal(bare.find((stage) => stage.id === 'stage09').included, false)
  assert.equal(bare.find((stage) => stage.id === 'stage04').included, false)
})

test('resolves project-relative paths in list values', () => {
  const resolved = resolvePipelineArgv({
    pipeline: basePipeline({ surface_target: ['native', 'meshes/onavg-ico64'] }), model, resolvePath,
  })
  assert.equal(resolved.ok, true)
  assert.ok(resolved.args.includes('/project/meshes/onavg-ico64'))
  assert.ok(resolved.args.includes('native'))
})

test('validation warns about missing anat/TPM and slice timing', () => {
  const result = validatePipeline({
    pipeline: basePipeline(),
    model,
    detection: { ...detection, anat: [], sliceTiming: false },
  })
  assert.equal(result.ok, true)
  const codes = result.warnings.map((warning) => warning.code)
  assert.ok(codes.includes('anat-missing'))
  assert.ok(codes.includes('tpm-missing'))
  assert.ok(codes.includes('slicetiming-missing'))

  const badDevice = validatePipeline({
    pipeline: basePipeline({ device: 'quantum' }), model, detection,
  })
  assert.equal(badDevice.ok, false)
  assert.equal(badDevice.errors[0].code, 'device-invalid')

  const missingSubject = validatePipeline({
    pipeline: basePipeline(), model, detection, subjectExists: false,
  })
  assert.ok(missingSubject.errors.some((error) => error.code === 'subject-missing'))
})

test('projects scan output to detection facts', () => {
  const scan = {
    subjects: [{
      id: 'sub-01',
      sessions: [{
        id: 'ses-01',
        fmapFiles: 4,
        anat: ['anat/T1w.nii.gz'],
        runs: [
          { task: 'localizer', sliceTiming: true, phase: false, sbref: true, echoes: 1 },
          { task: 'localizer', sliceTiming: true, phase: false, sbref: true, echoes: 1 },
        ],
      }],
    }],
  }
  const projected = detectionFromScan(scan, '01')
  assert.equal(projected.runs, 2)
  assert.equal(projected.sessions, 1)
  assert.equal(projected.fieldmapGroups, 1)
  assert.equal(projected.sliceTiming, true)
  assert.equal(projected.phase, false)
  assert.deepEqual(projected.subjects, ['01'])
  assert.equal(detectionFromScan({ subjects: [] }, '01').runs, 0)
})

test('repeats append-flag occurrences and validates each one', () => {
  const base = defaultPipeline({ subject: '01', bidsDir: 'data/bids-lite', workDir: 'work/sub-01' })
  const repeated = {
    ...base,
    overrides: {
      family: [['rest', '4'], ['nback', '5']],
      glm_blur: [['4'], ['6']],
    },
  }
  const resolved = resolvePipelineArgv({ pipeline: repeated, model, resolvePath: (value) => `/abs/${value}` })
  assert.equal(resolved.ok, true, JSON.stringify(resolved.errors))
  const familyIndices = resolved.args.reduce((out, item, index) => (item === '-family' ? [...out, index] : out), [])
  assert.equal(familyIndices.length, 2)
  assert.deepEqual(resolved.args.slice(familyIndices[0], familyIndices[0] + 3), ['-family', 'rest', '4'])
  assert.deepEqual(resolved.args.slice(familyIndices[1], familyIndices[1] + 3), ['-family', 'nback', '5'])
  assert.equal(resolved.args.filter((item) => item === '-glm_blur').length, 2)

  const single = resolvePipelineArgv({
    pipeline: { ...base, overrides: { family: ['rest', '4'] } },
    model, resolvePath: (value) => `/abs/${value}`,
  })
  assert.equal(single.ok, true, JSON.stringify(single.errors))
  assert.equal(single.args.filter((item) => item === '-family').length, 1)
  assert.deepEqual(single.args.slice(single.args.indexOf('-family'), single.args.indexOf('-family') + 3), ['-family', 'rest', '4'])

  const badArity = resolvePipelineArgv({
    pipeline: { ...base, overrides: { family: [['rest']] } },
    model, resolvePath: (value) => `/abs/${value}`,
  })
  assert.equal(badArity.ok, false)
  assert.ok(badArity.errors.some((error) => error.code === 'override-invalid' && /expects 2 values/.test(error.message)))

  const badChoice = resolvePipelineArgv({
    pipeline: { ...base, overrides: { event_filter_in: [['faces']] } },
    model, resolvePath: (value) => `/abs/${value}`,
  })
  assert.equal(badChoice.ok, false)
  assert.ok(badChoice.errors.some((error) => error.code === 'override-invalid'))
})

test('formats argv for display with quoting', () => {
  assert.equal(formatArgv(['-a', 'plain', 'has space']), "-a plain 'has space'")
})
