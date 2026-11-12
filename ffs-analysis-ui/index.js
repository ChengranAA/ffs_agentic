/**
 * FFS analysis — Host half.
 *
 * Serves the analysis tab's snapshot projection and three live actions:
 *
 *   POST /ffs-analysis/plan    ffs_autoproc script generation (no execution)
 *   POST /ffs-analysis/run     execute the generated script as one managed child process
 *   POST /ffs-analysis/cancel  stop it (process group)
 *
 * The snapshot is built from the project plan (`work/ffs-analysis-project.json`), the run
 * state (`work/ffs-analysis-run.json`), the generated script and its log. With no plan it
 * falls back to the ds005165 fixture.
 *
 * All requests are gated with `connection.admit(req)` (host/origin + browser cookie), the
 * same authenticated-route pattern the FFS viewer uses; file paths are validated to stay
 * inside the project root. The run is a plain child process for this milestone; moving it
 * under `ctx.jobs` (Jobs panel, owner fencing) is the follow-up.
 */

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'ffs-analysis'

/** The agent tool set is mandatory; the HTTP route mounts only when Host services exist. */
export const inject = ['tools']

const PKG_DIR = path.dirname(realpathSync(fileURLToPath(import.meta.url)))
const FIXTURE_DIR = path.join(PKG_DIR, 'fixtures')
const FIXTURE_FILE = path.join(FIXTURE_DIR, 'demo.json')
const ROUTE = '/ffs-analysis'

const RECIPES = ['bare_bones', 'simple', 'simple_linear', 'simple_nonlin', 'complete', 'extreme']

const PLAN_DEFAULTS = {
  bidsDir: 'data/real/ds005165',
  subject: '01',
  session: '01',
  task: 'localizer',
  recipe: 'bare_bones',
  noQc: true,
  workDir: 'work/ds005165/sub-01',
}

const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

/** Bumped by `ffs_analysis_show`; the Client half's always-mounted bridge reveals the tab. */
let showSeq = 0

function findProjectRoot(start) {
  let current = path.resolve(start)
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      existsSync(path.join(current, 'python', 'ffsviewer', 'server.py'))
      && existsSync(path.join(current, 'reference', 'fastfuncstuff', 'fastfuncstuff'))
    ) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return path.resolve(PKG_DIR, '..')
}

const PROJECT_ROOT = findProjectRoot(PKG_DIR)
const PROJECT_STATE_FILE = path.join(PROJECT_ROOT, 'work', 'ffs-analysis-project.json')
const RUN_STATE_FILE = path.join(PROJECT_ROOT, 'work', 'ffs-analysis-run.json')

function resolveInside(rel, label = 'path') {
  const abs = path.resolve(PROJECT_ROOT, String(rel || ''))
  if (abs !== PROJECT_ROOT && !abs.startsWith(`${PROJECT_ROOT}${path.sep}`)) {
    throw new Error(`${label} is outside the project: ${rel}`)
  }
  return abs
}

// ------------------------------------------------------------------ script parsing
const STAGE_RE = /echo '== (stage[0-9a-z]+):\s*(.*?)\s*=='/gm

function parseStages(scriptText) {
  const seen = new Map()
  let match
  while ((match = STAGE_RE.exec(scriptText))) {
    if (!seen.has(match[1])) {
      seen.set(match[1], { name: match[1], label: match[2].replace(/\s+/g, ' ').trim() })
    }
  }
  const stages = [...seen.values()]
  // The GLM stage is a commented block, not an `echo '== stage12'` banner.
  if (!stages.some((stage) => stage.name === 'stage12') && /stage12:\s*GLM/.test(scriptText)) {
    stages.push({ name: 'stage12', label: 'GLM (ffs_reml)' })
  }
  return stages
}

function logBanners(logText) {
  return [...logText.matchAll(/^== (stage[0-9a-z]+):/gm)].map((match) => match[1])
}

function parseLog(logText) {
  const finished = /finished after \d+:\d+ \(\d+s\)/.test(logText)
  const failed = /ffs_autoproc: FAILED/.test(logText)
  return { finished, failed }
}

function cleanLogText(text) {
  return String(text || '')
    // OSC + CSI + two-character escapes, then backspace.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\x08/g, '')
    // tqdm redraws with CR; each frame becomes a line and is filtered below.
    .replace(/\r\n?/g, '\n')
}

function isProgressLine(line) {
  if (!line) return true
  if (/\d+%\|/.test(line)) return true
  if (/\b\d+(?:\.\d+)?(?:it|run|vol|group|pair|batch|chunk|s)\/s\b/.test(line)) return true
  if (/\[A\s*$/.test(line)) return true
  if (/^[=\-]{6,}$/.test(line)) return true
  return false
}

/** Clean, meaningful tail: no ANSI, no carriage-return redraws, no tqdm bars. */
function logTail(text, count) {
  const lines = cleanLogText(text)
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter(Boolean)
    .filter((line) => !isProgressLine(line))
  return lines.slice(-count)
}

// ------------------------------------------------------------------ artifacts
function artifactKind(name) {
  if (name.endsWith('.sh')) return 'script'
  if (name.endsWith('.log')) return 'log'
  if (name.endsWith('.toml')) return 'design'
  if (/stats-reml|stats-ols/.test(name)) return 'stats'
  if (/ffsremlvar/.test(name)) return 'params'
  if (/mask/.test(name)) return 'mask'
  if (/_mean\./.test(name)) return 'func'
  if (/stage\d+/.test(name)) return 'func'
  return 'other'
}

function artifactStage(name) {
  const match = /(stage\d+[a-z]?)/.exec(name)
  return match ? match[1] : 'pipeline'
}

function artifactHint(kind) {
  if (kind === 'stats') return { role: 'overlay', colormap: 'hot', threshold: 3.1 }
  if (kind === 'params') return { role: 'overlay', colormap: 'redblue' }
  if (kind === 'func') return { role: 'underlay', colormap: 'gray' }
  if (kind === 'mask') return { role: 'mask' }
  return { role: 'text' }
}

function listArtifacts(workAbs) {
  const artifacts = []
  let entries = []
  try {
    entries = readdirSync(workAbs, { withFileTypes: true })
  } catch {
    return artifacts
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!/\.(nii\.gz|nii|sh|log|toml|json)$/i.test(entry.name)) continue
    const abs = path.join(workAbs, entry.name)
    let size = 0
    try {
      size = statSync(abs).size
    } catch {
      continue
    }
    const kind = artifactKind(entry.name)
    artifacts.push({
      id: `live.${entry.name}`,
      name: entry.name,
      kind,
      stage: artifactStage(entry.name),
      bytes: size,
      path: abs,
      hint: artifactHint(kind),
    })
  }
  const rank = { script: 0, log: 1, design: 2, stats: 3, params: 4, mask: 5, func: 6, other: 7 }
  artifacts.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || a.name.localeCompare(b.name))
  return artifacts.slice(0, 80)
}

function listQcFigures(workAbs) {
  const qcDir = path.join(workAbs, 'qc')
  if (!existsSync(qcDir)) return []
  try {
    return readdirSync(qcDir)
      .filter((name) => /\.(png|jpe?g)$/i.test(name))
      .slice(0, 6)
      .map((name) => ({
        id: `qc.${name}`,
        label: name.replace(/\.(png|jpe?g)$/i, ''),
        caption: 'FFS QC (CPU)',
        asset: `qc/${name}`,
      }))
  } catch {
    return []
  }
}

// Stage completion markers, used to infer per-stage wall time when a run predates
// instrumentation. Values are file-name prefixes written at the end of each stage.
const STAGE_MARKERS = {
  stage02: /^stage02\./,
  stage06: /^stage06\./,
  stage07: /^stage07\./,
  stage08: /^stage08\./,
  stage10a: /^stage10\.warpmaster/,
  stage10: /^stage10\.final\./,
  stage10b: /^stage10\.(mask_epi|meanall)/,
  stage12: /^stage12\./,
}

function inferStageTimes(workAbs, stages, run) {
  const out = {}
  if (!run?.startedAt) return out
  let names = []
  try {
    names = readdirSync(workAbs, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
  } catch {
    return out
  }
  const ends = {}
  for (const stage of stages) {
    const marker = STAGE_MARKERS[stage.name]
    if (!marker) continue
    for (const name of names) {
      if (!marker.test(name)) continue
      try {
        const mtime = statSync(path.join(workAbs, name)).mtimeMs
        if (!ends[stage.name] || mtime > ends[stage.name]) ends[stage.name] = mtime
      } catch { /* skip unreadable file */ }
    }
  }
  let previous = Date.parse(run.startedAt)
  for (const stage of stages) {
    const end = ends[stage.name]
    if (!end) continue
    if (Number.isFinite(previous) && previous > 0) {
      out[stage.name] = {
        seconds: Math.max(0, Math.round((end - previous) / 1000)),
        estimated: true,
      }
    }
    previous = end
  }
  return out
}

// ------------------------------------------------------------------ project / run state
function readProjectState() {
  if (!existsSync(PROJECT_STATE_FILE)) return null
  try {
    const state = JSON.parse(readFileSync(PROJECT_STATE_FILE, 'utf8'))
    if (!state || !state.script || !state.workDir || !state.params) return null
    return state
  } catch {
    return null
  }
}

function writeProjectState(state) {
  mkdirSync(path.dirname(PROJECT_STATE_FILE), { recursive: true })
  writeFileSync(PROJECT_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`)
  return state
}

let RUN = null

function persistRun() {
  try {
    mkdirSync(path.dirname(RUN_STATE_FILE), { recursive: true })
    writeFileSync(RUN_STATE_FILE, `${JSON.stringify(RUN, null, 2)}\n`)
  } catch (error) {
    console.error('[ffs-analysis] could not persist run state:', error)
  }
}

function ensureRunLoaded() {
  if (RUN) return RUN
  if (!existsSync(RUN_STATE_FILE)) return null
  try {
    RUN = JSON.parse(readFileSync(RUN_STATE_FILE, 'utf8'))
  } catch {
    RUN = null
    return null
  }
  if (RUN && (RUN.status === 'running' || RUN.status === 'stopping')) {
    // The child cannot survive a Host reload; never report a phantom run.
    RUN.status = 'failed'
    RUN.finishedAt = RUN.finishedAt || new Date().toISOString()
    RUN.error = RUN.error || 'Host reloaded while the run was active'
    persistRun()
  }
  return RUN
}

function isRunActive() {
  const run = ensureRunLoaded()
  return Boolean(run && (run.status === 'running' || run.status === 'stopping'))
}

// ------------------------------------------------------------------ snapshot
function runLogPath(state) {
  const scriptAbs = resolveInside(state.script, 'script')
  return state.log ? resolveInside(state.log, 'log') : scriptAbs.replace(/\.sh$/, '.log')
}

/** Merge the plan + the managed run into the stage flow. */
function runView(state) {
  const run = ensureRunLoaded()
  const scriptAbs = resolveInside(state.script, 'script')
  const logAbs = runLogPath(state)
  const scriptText = existsSync(scriptAbs) ? readFileSync(scriptAbs, 'utf8') : ''
  const logText = existsSync(logAbs) ? readFileSync(logAbs, 'utf8') : ''
  const parsed = parseStages(scriptText)
  const scriptMtime = existsSync(scriptAbs) ? statSync(scriptAbs).mtimeMs : 0
  const logMtime = existsSync(logAbs) ? statSync(logAbs).mtimeMs : 0
  const logFresh = logMtime > 0 && logMtime >= scriptMtime

  const status = run ? run.status : null
  const running = status === 'running' || status === 'stopping'
  const banners = logBanners(logText)
  const current = running ? (banners[banners.length - 1] || null) : null

  const done = new Set()
  if (status === 'completed') {
    for (const stage of parsed) done.add(stage.name)
  } else if (running) {
    for (const banner of banners.slice(0, -1)) done.add(banner)
  } else if (logFresh) {
    for (const banner of banners) done.add(banner)
    if (parseLog(logText).finished) for (const stage of parsed) done.add(stage.name)
  }

  const failedStage = status === 'failed' && current ? current : null
  const workAbs = resolveInside(state.workDir, 'work dir')
  const instrumented = run && run.stageTimes && Object.keys(run.stageTimes).length ? run.stageTimes : null
  const inferred = instrumented ? null : inferStageTimes(workAbs, parsed, run)
  const timeOf = (name) => {
    if (instrumented && typeof instrumented[name] === 'number') {
      return { seconds: instrumented[name], estimated: false }
    }
    return inferred?.[name] || null
  }
  const stages = parsed.map((stage) => {
    const time = timeOf(stage.name)
    return {
      ...stage,
      seconds: time ? time.seconds : undefined,
      estimated: time ? time.estimated : false,
      status: failedStage === stage.name
        ? 'failed'
        : done.has(stage.name)
          ? 'done'
          : (running && current === stage.name)
            ? 'running'
            : 'pending',
    }
  })
  const total = parsed.length || 1
  const percent = Math.round((100 * done.size) / total)
  const started = run?.startedAt ? Date.parse(run.startedAt) : 0
  const finished = run?.finishedAt ? Date.parse(run.finishedAt) : 0
  const elapsedSeconds = started
    ? Math.max(0, Math.round(((finished || Date.now()) - started) / 1000))
    : null

  const pipelineStatus = status
    || (parsed.length ? (logFresh && parseLog(logText).finished ? 'completed' : 'planned') : 'empty')
  const logLines = logTail(logText, 12)

  return {
    status: pipelineStatus,
    running,
    stages,
    currentStage: current,
    percent,
    elapsedSeconds,
    logExcerpt: running || logFresh ? logLines : [],
    activity: running ? (logLines[logLines.length - 1] || null) : null,
    error: run?.error || null,
    startedAt: run?.startedAt || null,
    finishedAt: run?.finishedAt || null,
  }
}

function buildLiveSnapshot(state) {
  const workAbs = resolveInside(state.workDir, 'work dir')
  const view = runView(state)
  const artifacts = listArtifacts(workAbs)
  const figures = listQcFigures(workAbs)
  const subjectId = `sub-${state.params.subject}`
  const hasStats = artifacts.some((artifact) => artifact.kind === 'stats')
  const notes = [
    'Live project state, built from the generated script, its log and the work directory.',
  ]
  if (view.status === 'planned') {
    notes.push('The script is newer than the log: the flow is the plan, not a completed run.')
  }
  if (view.running) notes.push('Run in progress; the flow and log update from the running script.')

  return {
    schema: 'ffs-analysis-live/1',
    source: 'live',
    note: notes.join(' '),
    rev: statSync(PROJECT_STATE_FILE).mtimeMs,
    showSeq,
    projectRoot: PROJECT_ROOT,
    assets: { base: `${ROUTE}/project-asset/` },
    project: {
      name: `ds005165 ${subjectId}`,
      dataset: 'BIDS · ds005165 (BOLD Moments)',
      root: state.params.bidsDir,
      subject: subjectId,
      session: state.params.session ? `ses-${state.params.session}` : null,
      device: 'auto',
      createdAt: state.plannedAt,
    },
    pipeline: {
      id: `pipe-${subjectId}`,
      status: view.status,
      recipe: state.params.recipe,
      progress: view.percent,
      currentStage: view.currentStage,
      activity: view.activity,
      elapsedSeconds: view.elapsedSeconds,
      startedAt: view.startedAt,
      finishedAt: view.finishedAt,
      error: view.error,
      script: state.script,
      log: state.log,
      command: [
        'ffs_autoproc',
        `-bids_dir ${state.params.bidsDir}`,
        `-subject ${state.params.subject}`,
        state.params.session ? `-session ${state.params.session}` : '',
        state.params.task ? `-task ${state.params.task}` : '',
        `-recipe ${state.params.recipe}`,
        state.params.noQc ? '-no_qc' : '',
        `-work_dir ${state.params.workDir}`,
        `-out ${state.script}`,
      ].filter(Boolean).join(' '),
      stages: view.stages,
      logExcerpt: view.logExcerpt,
    },
    job: {
      status: view.status,
      running: view.running,
      currentStage: view.currentStage,
      percent: view.percent,
      startedAt: view.startedAt,
      finishedAt: view.finishedAt,
      error: view.error,
    },
    artifacts,
    qc: {
      status: figures.length ? 'figures' : 'none',
      note: figures.length
        ? 'QC figures from the work directory.'
        : 'No QC figures yet. QC runs on CPU on this Mac (the MPS path raises a float64 error).',
      figures,
    },
    results: {
      model: hasStats ? 'GLM bucket present' : '—',
      voxelsInMask: null,
      meanR2: null,
      subBricks: null,
      contrasts: [],
      clusters: [],
      clusterNote: hasStats
        ? 'A GLM bucket exists in the work directory; contrast and cluster inspection lands with M3.'
        : 'No GLM yet. Run the plan to produce a stats bucket.',
    },
    cohort: {
      status: 'live',
      note: 'One subject is planned at a time in this phase; cohort management lands with M4.',
      total: 1,
      included: 1,
      variants: [state.params.recipe],
      subjects: [{
        id: subjectId,
        include: true,
        stages: {
          stage02: view.stages.find((stage) => stage.name === 'stage02')?.status || 'pending',
          stage10: view.stages.find((stage) => stage.name === 'stage10')?.status || 'pending',
          firstLevel: view.stages.find((stage) => stage.name === 'stage12')?.status || 'pending',
          qc: figures.length ? 'done' : 'pending',
        },
        variants: [state.params.recipe],
        note: view.status,
      }],
    },
    group: {
      status: 'not-ready',
      note: 'Group analyses need a cohort (M4/M5).',
      analyses: [],
    },
    provenance: {
      settled: false,
      settledNote: 'Not settled: package export needs ffs_settle/ffs_export (M3).',
      exportEnabled: false,
      artifacts: artifacts.length,
    },
  }
}

function resolveFixture() {
  const raw = JSON.parse(readFileSync(FIXTURE_FILE, 'utf8'))
  const artifacts = Array.isArray(raw.artifacts)
    ? raw.artifacts.map((artifact) => ({
      ...artifact,
      path: typeof artifact.path === 'string' && artifact.path && !path.isAbsolute(artifact.path)
        ? path.join(PROJECT_ROOT, artifact.path)
        : artifact.path,
    }))
    : []
  return {
    ...raw,
    source: 'fixture',
    rev: statSync(FIXTURE_FILE).mtimeMs,
    showSeq,
    projectRoot: PROJECT_ROOT,
    assets: { base: `${ROUTE}/asset/` },
    artifacts,
  }
}

function readSnapshot() {
  const state = readProjectState()
  if (state) {
    try {
      return buildLiveSnapshot(state)
    } catch (error) {
      console.error('[ffs-analysis] live snapshot failed, serving fixture:', error)
    }
  }
  return resolveFixture()
}

function snapshotSummary() {
  const snapshot = readSnapshot()
  return {
    source: snapshot.source,
    project: snapshot.project?.name ?? null,
    dataset: snapshot.project?.dataset ?? null,
    subject: snapshot.project?.subject ?? null,
    pipeline: {
      status: snapshot.pipeline?.status ?? null,
      recipe: snapshot.pipeline?.recipe ?? null,
      stages: Array.isArray(snapshot.pipeline?.stages) ? snapshot.pipeline.stages.length : 0,
      stageDetail: Array.isArray(snapshot.pipeline?.stages)
        ? snapshot.pipeline.stages.map((stage) => ({
          name: stage.name,
          status: stage.status,
          seconds: typeof stage.seconds === 'number' ? stage.seconds : null,
          estimated: Boolean(stage.estimated),
        }))
        : [],
      progress: snapshot.pipeline?.progress ?? null,
      currentStage: snapshot.pipeline?.currentStage ?? null,
      activity: snapshot.pipeline?.activity ?? null,
      logLines: Array.isArray(snapshot.pipeline?.logExcerpt) ? snapshot.pipeline.logExcerpt.length : 0,
      logTail: Array.isArray(snapshot.pipeline?.logExcerpt) ? snapshot.pipeline.logExcerpt.slice(-4) : [],
    },
    job: snapshot.job ?? null,
    artifacts: snapshot.artifacts?.length ?? 0,
    cohort: Array.isArray(snapshot.cohort?.subjects) ? snapshot.cohort.subjects.length : 0,
    groupAnalyses: Array.isArray(snapshot.group?.analyses) ? snapshot.group.analyses.length : 0,
    fixture: FIXTURE_FILE,
    state: PROJECT_STATE_FILE,
    runState: RUN_STATE_FILE,
  }
}

// ------------------------------------------------------------------ plan
function planParams(overrides = {}) {
  const params = { ...PLAN_DEFAULTS }
  for (const key of Object.keys(PLAN_DEFAULTS)) {
    if (overrides[key] !== undefined && overrides[key] !== null && overrides[key] !== '') {
      params[key] = overrides[key]
    }
  }
  if (!String(params.subject || '').trim()) throw new Error('subject is required')
  if (!RECIPES.includes(params.recipe)) throw new Error(`unknown recipe: ${params.recipe}`)
  for (const key of ['subject', 'session', 'task']) {
    if (!/^[A-Za-z0-9_-]*$/.test(String(params[key]))) throw new Error(`invalid ${key}: ${params[key]}`)
  }
  return params
}

function autoprocArgs(params) {
  const bidsAbs = resolveInside(params.bidsDir, 'bidsDir')
  if (!existsSync(bidsAbs)) throw new Error(`BIDS directory not found: ${params.bidsDir}`)
  const workAbs = resolveInside(params.workDir, 'workDir')
  mkdirSync(workAbs, { recursive: true })
  const outAbs = path.join(workAbs, `proc_sub-${params.subject}.sh`)
  const args = [
    '-m', 'fastfuncstuff.cli.autoproc',
    '-bids_dir', bidsAbs,
    '-subject', String(params.subject),
    '-recipe', String(params.recipe),
    '-work_dir', workAbs,
    '-out', outAbs,
  ]
  if (params.session) args.push('-session', String(params.session))
  if (params.task) args.push('-task', String(params.task))
  if (params.noQc) args.push('-no_qc')
  return { args, bidsAbs, workAbs, outAbs }
}

function ffsEnv() {
  const env = { ...process.env }
  const shimDir = path.join(PROJECT_ROOT, 'work', 'bin')
  if (existsSync(shimDir)) env.PATH = `${shimDir}${path.delimiter}${env.PATH || ''}`
  env.MPLCONFIGDIR = env.MPLCONFIGDIR || path.join(PROJECT_ROOT, 'work', '.mpl')
  try {
    mkdirSync(env.MPLCONFIGDIR, { recursive: true })
  } catch {
    // non-fatal: QC is optional in this phase
  }
  env.PYTHONPATH = [
    path.join(PROJECT_ROOT, 'python'),
    path.join(PROJECT_ROOT, 'reference', 'fastfuncstuff'),
    process.env.PYTHONPATH || '',
  ].filter(Boolean).join(path.delimiter)
  env.PYTHONUNBUFFERED = '1'
  return env
}

function runPlan(overrides = {}) {
  let params
  let paths
  try {
    if (isRunActive()) throw Object.assign(new Error('cannot re-plan while a run is active'), { code: 'run-busy' })
    params = planParams(overrides)
    paths = autoprocArgs(params)
  } catch (error) {
    return Promise.reject(error)
  }
  const python = process.env.FFS_PYTHON || path.join(PROJECT_ROOT, '.venv', 'bin', 'python')
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(python, paths.args, { cwd: PROJECT_ROOT, env: ffsEnv() })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch { /* already gone */ }
    }, 240000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > 200000) stdout = stdout.slice(-100000)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 100000) stderr = stderr.slice(-50000)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        const detail = (stderr || stdout).split('\n').filter(Boolean).slice(-4).join(' | ')
        const error = new Error(`ffs_autoproc exited ${code}${detail ? `: ${detail}` : ''}`)
        error.code = 'plan-failed'
        reject(error)
        return
      }
      try {
        // A new plan invalidates the previous run view.
        RUN = null
        persistRun()
        const scriptRel = path.relative(PROJECT_ROOT, paths.outAbs)
        const state = {
          source: 'live',
          plannedAt: new Date().toISOString(),
          params,
          script: scriptRel,
          log: scriptRel.replace(/\.sh$/, '.log'),
          workDir: path.relative(PROJECT_ROOT, paths.workAbs),
        }
        writeProjectState(state)
        const snapshot = buildLiveSnapshot(state)
        resolve({
          ok: true,
          source: 'live',
          stages: snapshot.pipeline.stages.length,
          artifacts: snapshot.artifacts.length,
          script: state.script,
          workDir: state.workDir,
          output: stdout.trim().split('\n').filter(Boolean).slice(-6).join('\n'),
        })
      } catch (error) {
        reject(error)
      }
    })
  })
}

// ------------------------------------------------------------------ run
function runSummary() {
  ensureRunLoaded()
  return {
    ok: true,
    status: RUN?.status || 'idle',
    script: RUN?.script || null,
    log: RUN?.log || null,
    startedAt: RUN?.startedAt || null,
    finishedAt: RUN?.finishedAt || null,
    error: RUN?.error || null,
  }
}

function startRun() {
  ensureRunLoaded()
  if (isRunActive()) throw Object.assign(new Error('a run is already in progress'), { code: 'run-busy' })
  const state = readProjectState()
  if (!state) throw Object.assign(new Error('no plan yet: use Plan pipeline first'), { code: 'not-planned' })
  const scriptAbs = resolveInside(state.script, 'script')
  if (!existsSync(scriptAbs)) throw Object.assign(new Error(`script not found: ${state.script}`), { code: 'not-planned' })
  const workAbs = resolveInside(state.workDir, 'workDir')
  const logAbs = runLogPath(state)
  mkdirSync(path.dirname(logAbs), { recursive: true })
  const out = createWriteStream(logAbs, { flags: 'w' })
  let child
  try {
    child = spawn('/bin/bash', [scriptAbs], {
      cwd: workAbs,
      env: ffsEnv(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    try { out.end() } catch { /* already closed */ }
    throw Object.assign(error, { code: 'run-failed' })
  }
  RUN = {
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    pid: child.pid,
    script: state.script,
    log: state.log,
    workDir: state.workDir,
    error: null,
    stageTimes: {},
  }
  persistRun()
  // Record exact stage wall times from the stream: a banner closes the previous stage.
  const stageTimes = {}
  let stageText = ''
  let bannerIndex = 0
  let currentStage = null
  let stageStartedAt = Date.now()
  let stage12Seen = false
  const transition = (name, at) => {
    if (currentStage && currentStage !== name) {
      stageTimes[currentStage] = Math.max(0, Math.round((at - stageStartedAt) / 1000))
    }
    currentStage = name
    stageStartedAt = at
    RUN.stageTimes = stageTimes
  }
  const scan = (chunk) => {
    stageText += String(chunk)
    if (stageText.length > 400000) stageText = stageText.slice(-200000)
    const banners = logBanners(stageText)
    while (bannerIndex < banners.length) transition(banners[bannerIndex++], Date.now())
    // The GLM stage has no banner: start it at its spec-compile line.
    if (!stage12Seen && /Compiling spec stage11|ffs_reml - GPU-Accelerated/.test(stageText)) {
      stage12Seen = true
      transition('stage12', Date.now())
    }
  }
  const write = (chunk) => {
    try { out.write(chunk) } catch { /* log stream gone */ }
    scan(chunk)
  }
  const finishStage = () => {
    if (currentStage) {
      stageTimes[currentStage] = Math.max(0, Math.round((Date.now() - stageStartedAt) / 1000))
    }
    RUN.stageTimes = stageTimes
  }
  child.stdout.on('data', write)
  child.stderr.on('data', write)
  child.on('error', (error) => {
    RUN.status = 'failed'
    RUN.error = String(error?.message || error)
    RUN.finishedAt = new Date().toISOString()
    finishStage()
    try { out.end() } catch { /* already closed */ }
    persistRun()
  })
  child.on('exit', (code, signal) => {
    RUN.finishedAt = new Date().toISOString()
    finishStage()
    if (code === 0) RUN.status = 'completed'
    else if (RUN.status === 'stopping' || signal) RUN.status = 'stopped'
    else RUN.status = 'failed'
    if (code !== 0 && !RUN.error) RUN.error = `exit ${code}${signal ? ` (${signal})` : ''}`
    try { out.end() } catch { /* already closed */ }
    persistRun()
  })
  return runSummary()
}

function cancelRun() {
  ensureRunLoaded()
  if (!RUN || (RUN.status !== 'running' && RUN.status !== 'stopping')) {
    throw Object.assign(new Error('nothing is running'), { code: 'not-running' })
  }
  RUN.status = 'stopping'
  persistRun()
  try {
    process.kill(-RUN.pid, 'SIGTERM')
  } catch {
    try { process.kill(RUN.pid, 'SIGTERM') } catch (error) {
      throw Object.assign(new Error(`could not stop the run: ${error?.message || error}`), { code: 'cancel-failed' })
    }
  }
  return runSummary()
}

// ------------------------------------------------------------------ transport
function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function writeText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

async function readJsonBody(req, limit = 65536) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > limit) throw new Error('request body too large')
  }
  return raw ? JSON.parse(raw) : {}
}

function serveFile(res, file) {
  if (!existsSync(file)) {
    writeText(res, 404, 'not found')
    return
  }
  const body = readFileSync(file)
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

function projectAssetFile(rel) {
  const clean = decodeURIComponent(String(rel || '').replace(/^\/+/, ''))
  if (!clean || clean.includes('..')) return null
  const base = readProjectState()
  if (!base) return null
  const workAbs = resolveInside(base.workDir, 'workDir')
  const file = path.resolve(workAbs, clean)
  if (file !== workAbs && !file.startsWith(`${workAbs}${path.sep}`)) return null
  return file
}

function routeError(res, error) {
  const status = error?.code === 'run-busy' ? 409 : error?.code === 'not-planned' || error?.code === 'not-running' ? 400 : 500
  writeJson(res, status, { ok: false, error: { code: error?.code || 'failed', message: error?.message || String(error) } })
}

// ------------------------------------------------------------------ plugin
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'ffs_analysis_snapshot',
    description: [
      'Read the FFS analysis inspection tab snapshot. Returns the source (fixture or live),',
      'pipeline status/progress/current stage, artifact count, cohort and group counts.',
      'It does not run any computation.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute() {
      return JSON.stringify(snapshotSummary(), null, 1)
    },
  }), 'ffs-analysis: snapshot tool')

  ctx.effect(() => ctx.tools.register({
    name: 'ffs_analysis_plan',
    description: [
      'Generate an ffs_autoproc plan (script + design specs, no execution) for the analysis',
      'tab. Defaults to the ds005165 sub-01 localizer subset already in this checkout.',
      'Writes work/ffs-analysis-project.json and makes the tab live.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'BIDS subject id without "sub-", e.g. "01".' },
        session: { type: 'string', description: 'BIDS session id without "ses-".' },
        task: { type: 'string', description: 'Task label to plan.' },
        recipe: { type: 'string', enum: RECIPES, description: 'ffs_autoproc recipe.' },
        bidsDir: { type: 'string', description: 'BIDS root, project-relative.' },
        workDir: { type: 'string', description: 'Work directory, project-relative.' },
        noQc: { type: 'boolean', description: 'Pass -no_qc (default true on this Mac).' },
      },
      required: [],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute(args) {
      return JSON.stringify(await runPlan(args || {}), null, 1)
    },
  }), 'ffs-analysis: plan tool')

  ctx.effect(() => ctx.tools.register({
    name: 'ffs_analysis_run',
    description: [
      'Execute the current analysis plan: run the generated ffs script as one managed child',
      'process, stream its output to the script log, and make the tab show live stage progress.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute() {
      return JSON.stringify(startRun(), null, 1)
    },
  }), 'ffs-analysis: run tool')

  ctx.effect(() => ctx.tools.register({
    name: 'ffs_analysis_cancel',
    description: 'Stop the analysis run currently in progress (process group signal).',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute() {
      return JSON.stringify(cancelRun(), null, 1)
    },
  }), 'ffs-analysis: cancel tool')

  ctx.effect(() => ctx.tools.register({
    name: 'ffs_analysis_show',
    description: 'Reveal the FFS analysis inspection tab in the right sidebar.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute() {
      showSeq += 1
      return JSON.stringify({ showSeq })
    },
  }), 'ffs-analysis: show tool')

  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const handler = async (req, res) => {
      const admission = webCtx.connection.admit(req)
      if ('rejection' in admission) {
        res.writeHead(admission.rejection)
        res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      let url
      try {
        url = new URL(req.url || '/', 'http://harness.local')
      } catch {
        writeText(res, 400, 'bad request')
        return
      }
      const rel = url.pathname.replace(new RegExp(`^${ROUTE}/?`), '')

      if (rel === '' || rel === 'snapshot') {
        try {
          writeJson(res, 200, readSnapshot())
        } catch (error) {
          writeText(res, 500, `snapshot failed: ${error?.message || String(error)}`)
        }
        return
      }

      if (rel === 'plan') {
        if (req.method !== 'POST') {
          writeText(res, 405, 'method not allowed')
          return
        }
        try {
          const body = await readJsonBody(req)
          writeJson(res, 200, await runPlan(body))
        } catch (error) {
          routeError(res, error)
        }
        return
      }

      if (rel === 'run') {
        if (req.method !== 'POST') {
          writeText(res, 405, 'method not allowed')
          return
        }
        try {
          writeJson(res, 200, startRun())
        } catch (error) {
          routeError(res, error)
        }
        return
      }

      if (rel === 'cancel') {
        if (req.method !== 'POST') {
          writeText(res, 405, 'method not allowed')
          return
        }
        try {
          writeJson(res, 200, cancelRun())
        } catch (error) {
          routeError(res, error)
        }
        return
      }

      const asset = /^asset\/([A-Za-z0-9._-]+)$/.exec(rel)
      if (asset) {
        const name = asset[1]
        const file = path.join(FIXTURE_DIR, name)
        if (name.includes('..') || !file.startsWith(`${FIXTURE_DIR}${path.sep}`)) {
          writeText(res, 404, 'asset not found')
          return
        }
        serveFile(res, file)
        return
      }

      const projectAsset = /^project-asset\/(.+)$/.exec(rel)
      if (projectAsset) {
        try {
          const file = projectAssetFile(projectAsset[1])
          if (!file) {
            writeText(res, 404, 'asset not found')
            return
          }
          serveFile(res, file)
        } catch (error) {
          writeText(res, 500, `asset failed: ${error?.message || String(error)}`)
        }
        return
      }

      writeText(res, 404, 'not found')
    }

    try {
      webCtx.effect(
        () => webCtx.webServer.register({ kind: 'prefix', path: ROUTE, handler }),
        'ffs-analysis: fixture route',
      )
    } catch (error) {
      console.error('[ffs-analysis] route registration failed:', error)
    }
  })
}
