/**
 * Pure pipeline logic for the analysis panel's autoproc planner.
 *
 * No filesystem, no child processes, no Cordis: `index.js` supplies paths and runs the
 * generated command. Keeping this module pure makes the argv builder, stage applicability
 * and validation testable with `node --test`.
 *
 * The pipeline file is the user's intent (scope + recipe + explicit flags + optional
 * commands). Everything else - the stage plan, the argv, the script - is derived.
 */

import { normalizeCommands } from './commands.js'

export const PIPELINE_SCHEMA = 'ffs-panel-pipeline/1'
export const PIPELINE_FILE = 'work/ffs-pipeline.json'

/** Destinations owned by the planner (scope/recipe/output), never by an override. */
export const RESERVED_DESTS = new Set([
  'bids_dir', 'subject', 'session', 'task', 'out', 'work_dir', 'exec', 'recipe',
])

/** Fallback path destinations when a caller supplies a minimal model without pathFlags. */
const PATH_FALLBACK = new Set([
  'anat', 'suma', 'fs_subject', 'tpm', 'spm_tpm', 'anat_t2', 'presurf_tpm',
  'ref_anat', 'ref_anat_inv1', 'ref_anat_inv2', 'ref_file', 'ref_file_anat',
  'mni_template', 'tissue', 'ref_transforms', 'grand_reference', 'surface_target',
])

function isPathDest(model, dest) {
  if ((model.pathFlags || []).includes(dest)) return true
  return PATH_FALLBACK.has(dest)
}

function listValues(value) {
  if (Array.isArray(value)) return value.map(String)
  return String(value ?? '').split(/[\s,]+/).filter(Boolean)
}

function isAppendFlag(flag) {
  return flag && (flag.action === 'append' || flag.action === 'extend')
}

/**
 * Normalize an append-flag value to occurrences. `[['a','b'], ['c','d']]` is two
 * occurrences; `['a','b']` is one occurrence of two values; `'a b'` is one occurrence.
 * This is how a repeatable autoproc flag (`-family rest 4 -family nback 5`) is expressed.
 */
function appendOccurrences(flag, value) {
  const raw = Array.isArray(value) ? value : [value]
  const nested = raw.some((item) => Array.isArray(item))
  if (nested) {
    return raw.map((item) => (Array.isArray(item) ? item.map(String) : listValues(item)))
  }
  return [listValues(value)]
}

/** Validate one explicit override against the parser's action/type/choices. */
export function validateOverride(flag, value) {
  if (flag.kind === 'bool') {
    if (typeof value !== 'boolean') return `${flag.flag || flag.dest} takes true/false`
    return null
  }
  if (isAppendFlag(flag)) {
    const occurrences = appendOccurrences(flag, value)
    const present = occurrences.filter((items) => items.length)
    if (!present.length) return `${flag.flag || flag.dest} needs at least one value`
    for (const items of present) {
      if (Number.isInteger(flag.nargs) && flag.nargs > 0 && items.length !== flag.nargs) {
        return `${flag.flag || flag.dest} occurrence expects ${flag.nargs} values (got ${items.length})`
      }
      if (flag.nargs === '+' && !items.length) return `${flag.flag || flag.dest} expects values`
      if (flag.choices) {
        const allowed = flag.choices.map(String)
        const bad = items.find((item) => !allowed.includes(item))
        if (bad) return `${flag.flag || flag.dest} choices: ${allowed.join(', ')} (got ${bad})`
      }
      if (flag.type === 'int' && items.some((item) => !Number.isInteger(Number(item)))) {
        return `${flag.flag || flag.dest} values must be integers`
      }
      if (flag.type === 'float' && items.some((item) => !Number.isFinite(Number(item)))) {
        return `${flag.flag || flag.dest} values must be numbers`
      }
    }
    return null
  }
  if (flag.kind === 'list') {
    const items = listValues(value)
    if (!items.length) return `${flag.flag || flag.dest} needs at least one value`
    if (flag.choices) {
      const allowed = flag.choices.map(String)
      const bad = items.find((item) => !allowed.includes(item))
      if (bad) return `${flag.flag || flag.dest} choices: ${allowed.join(', ')} (got ${bad})`
    }
    if (Number.isInteger(flag.nargs) && flag.nargs > 0 && items.length !== flag.nargs) {
      return `${flag.flag || flag.dest} expects ${flag.nargs} values`
    }
    return null
  }
  if (value === null || value === undefined || value === '') return `${flag.flag || flag.dest} needs a value`
  if (flag.choices && !flag.choices.map(String).includes(String(value))) {
    return `${flag.flag || flag.dest} choices: ${flag.choices.map(String).join(', ')}`
  }
  if (flag.type === 'int' && !Number.isInteger(Number(value))) return `${flag.flag || flag.dest} must be an integer`
  if (flag.type === 'float' && !Number.isFinite(Number(value))) return `${flag.flag || flag.dest} must be a number`
  return null
}

export const DEVICES = ['auto', 'cpu', 'mps', 'cuda']

const SLICE = (value) => String(value || '').trim()

export function defaultPipeline(overrides = {}) {
  return normalizePipeline({
    schema: PIPELINE_SCHEMA,
    version: 1,
    scope: {
      bidsDir: overrides.bidsDir || '',
      subject: overrides.subject || '',
      session: overrides.session ? [].concat(overrides.session) : [],
      task: overrides.task ? [].concat(overrides.task) : [],
      workDir: overrides.workDir || '',
    },
    recipe: overrides.recipe ?? null,
    overrides: overrides.overrides || {},
    commands: [],
    history: [],
  })
}

export function normalizePipeline(raw) {
  const pipe = raw && typeof raw === 'object' ? raw : {}
  const scope = pipe.scope && typeof pipe.scope === 'object' ? pipe.scope : {}
  const list = (value) => (Array.isArray(value) ? value.map(SLICE).filter(Boolean)
    : (value ? String(value).split(/[\s,]+/).filter(Boolean) : []))
  return {
    schema: PIPELINE_SCHEMA,
    version: Number.isInteger(pipe.version) && pipe.version > 0 ? pipe.version : 1,
    scope: {
      bidsDir: SLICE(scope.bidsDir) || '',
      subject: SLICE(scope.subject) || '',
      session: list(scope.session),
      task: list(scope.task),
      workDir: SLICE(scope.workDir) || '',
      out: SLICE(scope.out),
    },
    recipe: pipe.recipe ? SLICE(pipe.recipe) : null,
    overrides: pipe.overrides && typeof pipe.overrides === 'object' ? { ...pipe.overrides } : {},
    commands: normalizeCommands(pipe.commands),
    history: Array.isArray(pipe.history) ? pipe.history.slice(-50) : [],
  }
}

/** Build a pipeline from the legacy single-project state, so existing work keeps running. */
export function migratePipelineFromState(state) {
  const params = state?.params || {}
  const workDir = state?.workDir || params.workDir || ''
  const session = params.session ? [String(params.session)] : []
  const task = params.task ? [String(params.task)] : []
  const recipe = params.recipe || null
  const overrides = {}
  // Only values that differ from the legacy PLAN_DEFAULTS are carried over. The legacy state
  // stored merged values, so this records the ambiguity instead of inventing user intent.
  if (params.device && params.device !== 'auto') overrides.device = params.device
  if (params.noQc === false) overrides.no_qc = false
  if (params.anat) overrides.anat = params.anat
  if (params.surfaceTarget?.length) overrides.surface_target = params.surfaceTarget
  if (params.surfaceGlm) overrides.surface_glm = true
  const pipe = defaultPipeline({
    bidsDir: params.bidsDir, subject: params.subject, session, task, workDir, recipe, overrides,
  })
  pipe.history = [{
    version: 1,
    at: new Date().toISOString(),
    actor: 'migration',
    summary: 'imported from work/ffs-analysis-project.json',
    source: 'legacy-project-state',
  }]
  return pipe
}

/* ------------------------------------------------------------------ stage plan */

function recipeSettings(model, recipe) {
  if (!recipe) return { ...model.defaults }
  const found = (model.recipes || []).find((item) => item.id === recipe)
  return found ? { ...found.settings } : { ...model.defaults }
}

function evaluateToken(token, { settings, overrides, detection }) {
  if (token === 'always') return true
  const [kind, ...rest] = token.split(':')
  const name = rest.join(':')
  if (kind === 'recipe') return Boolean(settings[name])
  if (kind === 'flag') return Boolean(overrides[name])
  if (kind === 'override') {
    const value = overrides[name]
    return value !== undefined && value !== false && value !== null && value !== ''
  }
  if (kind === 'not') {
    const [innerKind, ...innerRest] = name.split(':')
    const inner = innerRest.join(':')
    if (innerKind === 'override') {
      const value = overrides[inner]
      return value === undefined || value === false || value === null || value === ''
    }
    return !evaluateToken(name, { settings, overrides, detection })
  }
  if (kind === 'data') return Boolean(detection[name])
  if (kind === 'min_runs') return Number(detection.runs || 0) >= Number(name)
  if (kind === 'min_sessions') return Number(detection.sessions || 0) >= Number(name)
  if (kind === 'min_fmaps') return Number(detection.fieldmapGroups || 0) >= Number(name)
  return false
}

/** Evaluate one stage's clauses; returns the first failing token for the reason text. */
function stageState(stage, context) {
  for (const clause of stage.when || []) {
    const tokens = clause.any || []
    if (tokens.some((token) => evaluateToken(token, context))) continue
    return { included: false, failing: tokens }
  }
  return { included: true, failing: [] }
}

/**
 * The stage plan shown by the board: one row per emitted script stage, in order, with an
 * advisory inclusion state and the reason. Autoproc's generated script remains the authority.
 */
export function stagePlan({ model, pipeline, detection = {} }) {
  const pipe = normalizePipeline(pipeline)
  const settings = recipeSettings(model, pipe.recipe)
  const context = { settings, overrides: pipe.overrides, detection }
  const changed = new Set(Object.keys(pipe.overrides))
  return (model.stages || []).map((stage) => {
    const state = stageState(stage, context)
    const stageChanged = [...stage.flags, ...stage.opts].some((dest) => changed.has(dest))
    const reasonToken = state.failing.find((token) => model.reasonText?.[token]) || state.failing[0] || null
    // Values the recipe itself puts in effect (not overrides), so the inspector can say
    // "set by recipe complete: moco_ref=sbref" instead of leaving the source invisible.
    const inherited = pipe.recipe
      ? [...(stage.flags || []), ...(stage.opts || [])].flatMap((dest) => {
        if (Object.prototype.hasOwnProperty.call(pipe.overrides, dest)) return []
        if (!Object.prototype.hasOwnProperty.call(settings, dest)) return []
        return [{ dest, source: pipe.recipe, value: settings[dest] }]
      })
      : []
    return {
      id: stage.id,
      label: stage.label,
      phase: stage.phase,
      tools: stage.tools || [],
      flags: stage.flags || [],
      opts: stage.opts || [],
      outputs: stage.outputs || [],
      included: state.included,
      reasonToken,
      reason: state.included ? null : (model.reasonText?.[reasonToken] || 'not applicable'),
      changed: stageChanged,
      inherited,
    }
  })
}

export function changedOverrides(pipeline) {
  return Object.entries(normalizePipeline(pipeline).overrides)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
}

/* ------------------------------------------------------------------ argv */

function flagFor(model, dest) {
  for (const group of model.groups || []) {
    const found = group.flags.find((flag) => flag.dest === dest)
    if (found) return found
  }
  return null
}

function pushValue(args, flag, value, resolvePath, dest, model) {
  const pathDest = isPathDest(model, dest)
  if (isAppendFlag(flag)) {
    for (const occurrence of appendOccurrences(flag, value)) {
      const items = occurrence.filter((item) => String(item).length)
      if (!items.length) continue
      args.push(flag.flag, ...items.map((item) => (
        pathDest && (item.includes('/') || item.startsWith('.')) ? resolvePath(item, dest) : item
      )))
    }
    return
  }
  if (flag.kind === 'list') {
    const items = listValues(value)
    if (!items.length) return
    args.push(flag.flag, ...items.map((item) => (
      pathDest && (item.includes('/') || item.startsWith('.')) ? resolvePath(item, dest) : item
    )))
    return
  }
  if (flag.kind === 'bool') {
    // A `store_false` flag (e.g. -no_nordic_dof_adjust) means "pass the flag to turn the
    // destination OFF"; a plain store_true flag means "pass it to turn it ON".
    const isFalseAction = flag.action === 'store_false'
    if (!isFalseAction && value === true) args.push(flag.flag)
    if (isFalseAction && value === false) args.push(flag.flag)
    return
  }
  if (value === '' || value === null || value === undefined) return
  const resolved = pathDest ? resolvePath(value, dest) : String(value)
  args.push(flag.flag, resolved)
}

/**
 * Resolve the exact `ffs_autoproc` argv for a pipeline. `resolvePath` maps a project-relative
 * path to an absolute one (and rejects paths outside the project).
 */
export function resolvePipelineArgv({ pipeline, model, resolvePath, resolveOutputPath = resolvePath }) {
  const pipe = normalizePipeline(pipeline)
  const { scope } = pipe
  const errors = []
  if (!scope.bidsDir) errors.push({ code: 'scope-bids', message: 'dataset is required' })
  if (!scope.subject) errors.push({ code: 'scope-subject', message: 'subject is required' })
  if (!/^[A-Za-z0-9_-]+$/.test(scope.subject)) {
    errors.push({ code: 'scope-subject', message: `invalid subject: ${scope.subject}` })
  }
  if (!scope.workDir) errors.push({ code: 'scope-work', message: 'work directory is required' })
  if (pipe.recipe && !(model.recipes || []).some((item) => item.id === pipe.recipe)) {
    errors.push({ code: 'recipe-unknown', message: `unknown recipe: ${pipe.recipe}` })
  }
  for (const dest of Object.keys(pipe.overrides)) {
    if (RESERVED_DESTS.has(dest)) {
      errors.push({ code: 'override-reserved', message: `${dest} is owned by scope/recipe, not an override` })
      continue
    }
    const flag = flagFor(model, dest)
    if (!flag) {
      errors.push({ code: 'override-unknown', message: `unknown flag: ${dest}` })
      continue
    }
    const problem = validateOverride(flag, pipe.overrides[dest])
    if (problem) errors.push({ code: 'override-invalid', message: problem })
  }
  if (errors.length) return { ok: false, errors, args: [], workAbs: null, outAbs: null }

  const args = ['-m', 'fastfuncstuff.cli.autoproc']
  args.push('-bids_dir', resolvePath(scope.bidsDir, 'bidsDir'))
  args.push('-subject', scope.subject)
  if (scope.session.length) args.push('-session', ...scope.session)
  if (scope.task.length) args.push('-task', ...scope.task)
  args.push('-work_dir', resolveOutputPath(scope.workDir, 'workDir'))
  const outRel = scope.out || `${scope.workDir.replace(/\/$/, '')}/proc_sub-${scope.subject}.sh`
  if (scope.out && !/\.sh$/i.test(scope.out)) {
    errors.push({ code: 'scope-out', message: 'output script must end in .sh' })
  }
  args.push('-out', resolveOutputPath(outRel, 'out'))
  if (pipe.recipe) args.push('-recipe', pipe.recipe)
  if (errors.length) return { ok: false, errors, args: [], workAbs: null, outAbs: null }
  for (const [dest, value] of Object.entries(pipe.overrides)) {
    const flag = flagFor(model, dest)
    if (flag) pushValue(args, flag, value, resolvePath, dest, model)
  }
  return { ok: true, errors: [], args, outRel }
}

export function formatArgv(args) {
  return args.map((item) => (/^[A-Za-z0-9_./:=+-]+$/.test(item) ? item : `'${item.replaceAll("'", "'\\''")}'`)).join(' ')
}

/* ------------------------------------------------------------------ validation */

export function validatePipeline({ pipeline, model, detection = {}, subjectExists = true }) {
  const pipe = normalizePipeline(pipeline)
  const warnings = []
  const errors = []
  const { scope } = pipe
  if (!/^[A-Za-z0-9_-]+$/.test(scope.subject)) {
    errors.push({ code: 'scope-subject', message: `invalid subject: ${scope.subject}` })
  }
  if (!subjectExists) {
    errors.push({ code: 'subject-missing', message: `subject ${scope.subject} is not in ${scope.bidsDir}` })
  }
  if (pipe.recipe && !(model.recipes || []).some((item) => item.id === pipe.recipe)) {
    errors.push({ code: 'recipe-unknown', message: `unknown recipe: ${pipe.recipe}` })
  }
  for (const dest of Object.keys(pipe.overrides)) {
    if (RESERVED_DESTS.has(dest)) {
      errors.push({ code: 'override-reserved', message: `${dest} is owned by scope/recipe, not an override` })
      continue
    }
    const flag = flagFor(model, dest)
    if (!flag) {
      errors.push({ code: 'override-unknown', message: `unknown flag: ${dest}` })
      continue
    }
    const problem = validateOverride(flag, pipe.overrides[dest])
    if (problem) errors.push({ code: 'override-invalid', message: problem })
  }
  const device = pipe.overrides.device
  if (device && !DEVICES.includes(String(device)) && !/^(cpu|cuda|mps)(,\\d+)?$/.test(String(device))) {
    errors.push({ code: 'device-invalid', message: `invalid device: ${device}` })
  }

  const settings = recipeSettings(model, pipe.recipe)
  const settingsMap = pipe.recipe ? settings : { ...model.defaults, ...settings }
  const anat = pipe.overrides.anat || (detection.anat || [])[0]
  const suma = pipe.overrides.suma
  const tpm = pipe.overrides.tpm || pipe.overrides.spm_tpm
  if (settingsMap.go_to_anat && !anat && !suma) {
    warnings.push({
      code: 'anat-missing',
      level: 'warn',
      message: `recipe ${pipe.recipe || 'defaults'} aligns to an anat, but none was found in the scanned sessions`,
    })
  }
  if (pipe.recipe === 'complete' || pipe.recipe === 'extreme') {
    if (!tpm && !suma) {
      warnings.push({
        code: 'tpm-missing',
        level: 'warn',
        message: 'nonlinear anat (ffs_segment) needs a TPM: pass -tpm/-spm_tpm or -suma',
      })
    }
  }
  if (String(settingsMap.slicetiming_method || '') === 'integrate' && !detection.sliceTiming) {
    warnings.push({
      code: 'slicetiming-missing',
      level: 'warn',
      message: 'slice timing requested but no SliceTiming was found in the sidecars',
    })
  }
  if ((detection.runs || 0) === 0) {
    warnings.push({ code: 'no-runs', level: 'warn', message: 'no functional runs detected for this subject' })
  }
  return { ok: errors.length === 0, errors, warnings, settings: settingsMap }
}

/* ------------------------------------------------------------------ scan projection */

/** Reduce the `/scan` payload to the detection facts the planner needs. */
export function detectionFromScan(scan, subjectInput) {
  const subjectId = `sub-${String(subjectInput || '').replace(/^sub-/, '')}`
  const subject = (scan?.subjects || []).find((item) => item.id === subjectId) || null
  if (!subject) {
    return {
      runs: 0, sessions: 0, tasks: [], fieldmaps: false, fieldmapGroups: 0, fieldmapFiles: 0,
      sliceTiming: false, phase: false, sbref: false, echoes: 1, anat: [],
      subjects: (scan?.subjects || []).map((item) => item.id.replace(/^sub-/, '')),
    }
  }
  const runs = subject.sessions.flatMap((session) => session.runs || [])
  const fmapFiles = subject.sessions.reduce((total, session) => total + (session.fmapFiles || 0), 0)
  const anat = subject.sessions.flatMap((session) => session.anat || [])
  return {
    runs: runs.length,
    sessions: subject.sessions.length,
    tasks: [...new Set(runs.map((run) => run.task))].sort(),
    fieldmapFiles: fmapFiles,
    fieldmaps: fmapFiles > 0,
    fieldmapGroups: subject.sessions.filter((session) => (session.fmapFiles || 0) > 0).length,
    sliceTiming: runs.some((run) => Boolean(run.sliceTiming)),
    phase: runs.some((run) => Boolean(run.phase)),
    sbref: runs.some((run) => Boolean(run.sbref)),
    echoes: runs.reduce((max, run) => Math.max(max, Number(run.echoes) || 1), 1),
    anat,
    subjects: (scan?.subjects || []).map((item) => item.id.replace(/^sub-/, '')),
  }
}

export function summarizePipeline({ pipeline, model, detection }) {
  const pipe = normalizePipeline(pipeline)
  const plan = stagePlan({ model, pipeline: pipe, detection })
  return {
    schema: pipe.schema,
    version: pipe.version,
    recipe: pipe.recipe,
    overrides: pipe.overrides,
    changed: changedOverrides(pipe).length,
    included: plan.filter((stage) => stage.included).length,
    stages: plan.length,
    detection,
  }
}
