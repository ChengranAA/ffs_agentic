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

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs'
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
  device: 'auto',
  anat: null,
  fsSubject: null,
  surfaceTarget: [],
  surfaceGlm: false,
  surfaceQc: false,
  surfaceBlur: null,
  refFile: null,
  refTransforms: [],
  refFileAnat: null,
  workDir: 'work/ds005165/sub-01',
}

const RESULTS_SCRIPT = path.join(PKG_DIR, 'scripts', 'results.py')
const RESULTS_CACHE = 'ffs-analysis-results.json'

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
  if (/ffsremlvar/.test(name)) return 'params'
  if (/stats-reml|stats-ols/.test(name)) return 'stats'
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
    if (entry.name === RESULTS_CACHE) continue
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

function surfaceSummary(workAbs) {
  try {
    const files = readdirSync(workAbs)
      .filter((name) => /^stage12s\.stats-reml\..*\.func\.gii$/.test(name) && !/ffsremlvar/.test(name))
    if (!files.length) return null
    const sidecar = readJsonIf(path.join(workAbs, 'stage12s.json'))
    const labels = sidecar && Array.isArray(sidecar.SubBricks) ? sidecar.SubBricks : []
    const shot = path.join(workAbs, 'screenshots', 'surface-fsaverage.png')
    return {
      available: true,
      files: files.map((name) => path.relative(PROJECT_ROOT, path.join(workAbs, name))),
      hemis: [...new Set(files.map((name) => (/\.lh\./.test(name) ? 'lh' : 'rh')))],
      labels,
      screenshot: existsSync(shot) ? 'screenshots/surface-fsaverage.png' : null,
    }
  } catch {
    return null
  }
}

function listScreenshots(workAbs) {
  const dir = path.join(workAbs, 'screenshots')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((name) => /\.(png|jpe?g)$/i.test(name))
      .slice(0, 8)
      .map((name) => ({
        id: `shot.${name}`,
        label: name.replace(/\.(png|jpe?g)$/i, ''),
        asset: `screenshots/${name}`,
      }))
  } catch {
    return []
  }
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

function readQcReview(workAbs) {
  const file = path.join(workAbs, 'qc', 'qc_review.tsv')
  if (!existsSync(file)) return null
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    if (!lines.length) return null
    const columns = lines[0].split('\t')
    const rows = lines.slice(1).map((line) => line.split('\t')).filter((cells) => cells.length > 1).slice(0, 60)
    return { path: path.relative(PROJECT_ROOT, file), columns, rows, rowsCount: rows.length }
  } catch {
    return null
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
let JOB_SERVICE = null
let JOBS_CONTROLLER = null
let ACTIVE_JOB = null

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

function reconcileRunFromLog() {
  if (!RUN) return RUN
  if (RUN.status === 'completed' || RUN.status === 'cancelled') return RUN
  const logRel = RUN.log || (RUN.script ? String(RUN.script).replace(/\.sh$/, '.log') : null)
  if (!logRel) return RUN
  const logAbs = path.join(PROJECT_ROOT, logRel)
  if (!existsSync(logAbs)) return RUN
  let text = ''
  try {
    text = readFileSync(logAbs, 'utf8')
  } catch {
    return RUN
  }
  if (!/finished after \d+:\d+:\d+ \(\d+s\)/.test(text)) return RUN
  if (/ffs_autoproc: FAILED/.test(text)) return RUN
  // A Host reload can mark the run failed while the child keeps running and finishes.
  RUN.status = 'completed'
  RUN.finishedAt = RUN.finishedAt || new Date(statSync(logAbs).mtimeMs).toISOString()
  RUN.error = null
  RUN.percent = 100
  RUN.currentStage = null
  persistRun()
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

  reconcileRunFromLog()
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

function ensureResults(workAbs, statsAbs, options = {}) {
  const threshold = Number(options.threshold ?? 3.1)
  const minCluster = Number(options.minCluster ?? 10)
  const out = path.join(workAbs, RESULTS_CACHE)
  try {
    if (existsSync(out) && statSync(out).mtimeMs >= statSync(statsAbs).mtimeMs) {
      const cached = JSON.parse(readFileSync(out, 'utf8'))
      if (Number(cached.threshold) === threshold && Number(cached.minCluster) === minCluster) return cached
    }
  } catch {
    // fall through and recompute
  }
  const python = process.env.FFS_PYTHON || path.join(PROJECT_ROOT, '.venv', 'bin', 'python')
  try {
    execFileSync(python, [
      RESULTS_SCRIPT, statsAbs,
      '--out', out,
      '--threshold', String(threshold),
      '--min-cluster', String(minCluster),
      '--max-clusters', '10',
    ], {
      cwd: PROJECT_ROOT,
      env: ffsEnv(),
      timeout: 180000,
      stdio: 'pipe',
    })
    return JSON.parse(readFileSync(out, 'utf8'))
  } catch (error) {
    const detail = error?.stderr ? String(error.stderr) : (error?.message || String(error))
    return {
      error: detail.split('\n').filter(Boolean).slice(-3).join(' '),
      contrasts: [],
      subBricks: [],
      voxels: 0,
    }
  }
}

function currentResultsArtifact() {
  const state = readProjectState()
  if (!state) return null
  const workAbs = resolveInside(state.workDir, 'workDir')
  const artifacts = listArtifacts(workAbs)
  const stats = artifacts.find((item) => item.kind === 'stats' && !/ffsremlvar/.test(item.name) && /stats-reml/.test(item.name))
    || artifacts.find((item) => item.kind === 'stats' && !/ffsremlvar/.test(item.name))
  return stats ? { state, workAbs, stats } : null
}

function setResultsView(params = {}) {
  const found = currentResultsArtifact()
  if (!found) throw Object.assign(new Error('no stats artifact for results'), { code: 'no-results' })
  const threshold = Math.max(0.5, Math.min(Number(params.threshold) || 3.1, 20))
  const minCluster = Math.max(1, Math.min(Math.round(Number(params.minCluster) || 10), 500))
  const state = { ...found.state, resultsView: { threshold, minCluster } }
  writeProjectState(state)
  const summary = ensureResults(found.workAbs, found.stats.path, { threshold, minCluster })
  return { threshold, minCluster, summary }
}

function datasetLabel(bidsDir) {
  try {
    const abs = resolveInside(bidsDir, 'bidsDir')
    const description = readJsonIf(path.join(abs, 'dataset_description.json'))
    if (description && description.Name) {
      return description.Name === 'FFS BIDS-lite fixture' ? 'BIDS-lite fixture' : description.Name
    }
    return path.basename(abs)
  } catch {
    return String(bidsDir || 'dataset')
  }
}

function buildLiveSnapshot(state) {
  const workAbs = resolveInside(state.workDir, 'work dir')
  const view = runView(state)
  const artifacts = listArtifacts(workAbs)
  const figures = listQcFigures(workAbs)
  const review = readQcReview(workAbs)
  const screenshots = listScreenshots(workAbs)
  const surface = surfaceSummary(workAbs)
  const subjectId = `sub-${state.params.subject}`
  const statsArtifact = artifacts.find((artifact) => artifact.kind === 'stats' && !/ffsremlvar/.test(artifact.name) && /stats-reml/.test(artifact.name))
    || artifacts.find((artifact) => artifact.kind === 'stats' && !/ffsremlvar/.test(artifact.name))
    || null
  const meanArtifact = artifacts.find((artifact) => artifact.kind === 'func' && /_mean\./.test(artifact.name)) || null
  let results = {
    model: '—',
    voxelsInMask: null,
    meanR2: null,
    subBricks: null,
    contrasts: [],
    clusters: [],
    clusterNote: 'No GLM yet. Run the plan to produce a stats bucket.',
  }
  if (statsArtifact) {
    const resultsView = state.resultsView || { threshold: 3.1, minCluster: 10 }
    const summary = ensureResults(workAbs, statsArtifact.path, resultsView)
    if (summary.error) {
      results = {
        ...results,
        model: 'GLM bucket present',
        clusterNote: `Could not summarize the bucket: ${summary.error}`,
      }
    } else {
      const contrasts = (summary.contrasts || []).map((contrast) => ({
        id: contrast.name,
        name: contrast.name,
        subBrick: contrast.subBrick,
        subBrickIndex: contrast.index,
        stat: 't',
        peak: contrast.peakT,
        peakIJK: contrast.peakIJK,
        peakMM: contrast.peakMM,
        threshold: summary.threshold,
      }))
      const clusters = (summary.contrasts || []).flatMap((contrast) => (contrast.clusters || []).map((cluster) => ({
        id: `${contrast.name}.${cluster.ijk.join('_')}`,
        contrast: contrast.name,
        subBrick: contrast.subBrick,
        subBrickIndex: contrast.index,
        threshold: summary.threshold,
        ...cluster,
      }))).slice(0, 60)
      results = {
        model: 'ffs_reml ARMA(1,1)',
        voxelsInMask: summary.voxels || null,
        meanR2: null,
        subBricks: Array.isArray(summary.subBricks) ? summary.subBricks.length : null,
        threshold: summary.threshold,
        statsPath: statsArtifact.path,
        meanPath: meanArtifact?.path || null,
        contrasts,
        clusters,
        clusterNote: `t ≥ ${summary.threshold}, clusters ≥ ${summary.minCluster} voxels (6-connectivity), read from the bucket — inspection only.`,
      }
    }
  }
  const notes = [
    'Live project state, built from the generated script, its log and the work directory.',
  ]
  if (view.status === 'planned') {
    notes.push('The script is newer than the log: the flow is the plan, not a completed run.')
  }
  if (view.running) notes.push('Run in progress; the flow and log update from the running script.')
  const settledRecord = readSettled()
  const cohort = discoverCohort(cohortRootForState(state))
  const groupAnalyses = readGroupState().analyses
    .filter((item) => groupCohortRoot(item) === cohort.root)
    .map(groupSummaryRecord)
  const groupStatus = groupAnalyses.length
    ? 'ready'
    : (cohort.included >= 2 ? 'ready-to-run' : 'not-ready')

  return {
    schema: 'ffs-analysis-live/1',
    source: 'live',
    note: notes.join(' '),
    rev: statSync(PROJECT_STATE_FILE).mtimeMs,
    showSeq,
    projectRoot: PROJECT_ROOT,
    assets: { base: `${ROUTE}/project-asset/` },
    project: {
      name: `${datasetLabel(state.params.bidsDir)} ${subjectId}`,
      dataset: `BIDS · ${datasetLabel(state.params.bidsDir)}`,
      root: state.params.bidsDir,
      subject: subjectId,
      session: state.params.session ? `ses-${state.params.session}` : null,
      device: state.params.device || 'auto',
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
        state.params.device && state.params.device !== 'auto' ? `-device ${state.params.device}` : '',
        `-work_dir ${state.params.workDir}`,
        `-out ${state.script}`,
      ].filter(Boolean).join(' '),
      stages: view.stages,
      logExcerpt: view.logExcerpt,
    },
    job: {
      dshId: RUN?.dshJobId || null,
      status: view.status,
      running: view.running,
      currentStage: view.currentStage,
      percent: view.percent,
      startedAt: view.startedAt,
      finishedAt: view.finishedAt,
      error: view.error,
    },
    artifacts,
    surface,
    qc: {
      status: figures.length ? 'ready' : 'none',
      note: figures.length
        ? `${figures.length} figure(s)${review ? ` · ${review.rowsCount} review row(s)` : ''} from qc/.`
        : 'No QC figures yet. QC runs on CPU on this Mac (the MPS path raises a float64 error).',
      figures,
      review,
      screenshots,
    },
    results,
    cohort,
    group: {
      status: groupStatus,
      note: groupAnalyses.length
        ? `${groupAnalyses.length} group analysis${groupAnalyses.length === 1 ? '' : 'es'} from ${cohort.included} subjects.`
        : (cohort.included >= 2
          ? 'Cohort ready: run a one-sample 3dMEMA on a first-level contrast.'
          : 'Run at least two subjects to enable the group level.'),
      cohort,
      analyses: groupAnalyses,
    },
    provenance: {
      settled: Boolean(settledRecord),
      settledId: settledRecord?.id || null,
      settledAt: settledRecord?.at || null,
      exportPath: settledRecord?.exportPath || null,
      settledNote: settledRecord
        ? 'Settled. Export builds the reproducible package.'
        : 'Not settled: run the plan to completion, then Settle to freeze and export.',
      exportEnabled: Boolean(settledRecord),
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
    results: {
      contrasts: Array.isArray(snapshot.results?.contrasts) ? snapshot.results.contrasts.length : 0,
      clusters: Array.isArray(snapshot.results?.clusters) ? snapshot.results.clusters.length : 0,
      threshold: snapshot.results?.threshold ?? null,
    },
    provenance: snapshot.provenance ?? null,
    cohort: {
      total: snapshot.cohort?.total ?? 0,
      included: snapshot.cohort?.included ?? 0,
      status: snapshot.cohort?.status ?? null,
    },
    surface: snapshot.surface ? {
      hemis: snapshot.surface.hemis,
      labels: snapshot.surface.labels,
      screenshot: snapshot.surface.screenshot,
    } : null,
    qc: {
      figures: Array.isArray(snapshot.qc?.figures) ? snapshot.qc.figures.length : 0,
      reviewRows: snapshot.qc?.review?.rowsCount ?? 0,
      reviewColumns: snapshot.qc?.review?.columns?.length ?? 0,
      screenshots: Array.isArray(snapshot.qc?.screenshots) ? snapshot.qc.screenshots.length : 0,
    },
    group: {
      status: snapshot.group?.status ?? null,
      analyses: Array.isArray(snapshot.group?.analyses)
        ? snapshot.group.analyses.map((analysis) => ({
          id: analysis.id,
          contrast: analysis.contrast,
          engine: analysis.engine,
          n: analysis.n,
          status: analysis.status,
          clusters: Array.isArray(analysis.clusters) ? analysis.clusters.length : 0,
        }))
        : [],
    },
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
  if (params.device && params.device !== 'auto') args.push('-device', String(params.device))
  if (params.anat) args.push('-anat', resolveInside(params.anat, 'anat'))
  if (params.fsSubject) args.push('-fs_subject', resolveInside(params.fsSubject, 'fsSubject'))
  const surfaceTargets = Array.isArray(params.surfaceTarget)
    ? params.surfaceTarget
    : (params.surfaceTarget ? String(params.surfaceTarget).split(/[\s,]+/).filter(Boolean) : [])
  if (surfaceTargets.length) {
    args.push('-surface_target')
    for (const target of surfaceTargets) {
      args.push(target === 'native' || !target.includes('/') ? target : resolveInside(target, 'surface target'))
    }
  }
  if (params.surfaceGlm) args.push('-surface_glm')
  if (params.surfaceQc) args.push('-surface_qc')
  if (params.surfaceBlur) args.push('-surface_glm_blur', String(params.surfaceBlur))
  if (params.refFile) args.push('-ref_file', resolveInside(params.refFile, 'refFile'))
  if (params.refFileAnat) args.push('-ref_file_anat', resolveInside(params.refFileAnat, 'refFileAnat'))
  const transforms = Array.isArray(params.refTransforms)
    ? params.refTransforms
    : (params.refTransforms ? String(params.refTransforms).split(/[\s,]+/).filter(Boolean) : [])
  if (transforms.length) args.push('-ref_transforms', ...transforms.map((item) => resolveInside(item, 'ref transform')))
  return { args, bidsAbs, workAbs, outAbs }
}

function ffsEnv() {
  const env = { ...process.env }
  const shimDir = path.join(PROJECT_ROOT, 'work', 'bin')
  const afniBin = path.join(process.env.HOME || '', 'abin')
  const prefixes = [shimDir, afniBin].filter((dir) => dir && existsSync(dir))
  if (prefixes.length) env.PATH = `${prefixes.join(path.delimiter)}${path.delimiter}${env.PATH || ''}`
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
  if (JOB_SERVICE) {
    try {
      RUN.dshJobId = JOB_SERVICE.start({
        kind: 'bash',
        label: `FFS ${state.params?.subject ? `sub-${state.params.subject}` : ''} ${path.basename(state.script)}`.trim(),
        run(job) {
          ACTIVE_JOB = job
          try { job.updateProgress('starting') } catch { /* optional */ }
          return {
            done: new Promise((resolve) => {
              child.on('exit', (code, signal) => {
                const status = code === 0 ? 'completed' : (RUN.status === 'stopping' || signal ? 'killed' : 'failed')
                resolve({ status, detail: `exit ${code}${signal ? ` ${signal}` : ''}` })
              })
              child.on('error', (error) => resolve({ status: 'failed', detail: String(error?.message || error) }))
            }),
            cancel() {
              try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
            },
          }
        },
      })
      persistRun()
    } catch (error) {
      console.warn('[ffs-analysis] ctx.jobs unavailable, running as a plain child:', error?.message || error)
      ACTIVE_JOB = null
    }
  }
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
    try { ACTIVE_JOB?.updateProgress(currentStage || 'running') } catch { /* optional */ }
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
    try { ACTIVE_JOB?.append(String(chunk)) } catch { /* job ring gone */ }
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

// ------------------------------------------------------------------ settle / export
const SETTLED_FILE = path.join(PROJECT_ROOT, 'work', 'ffs-analysis-settled.json')
const EXPORT_ROOT = path.join(PROJECT_ROOT, 'exports')

function pythonPath() {
  return process.env.FFS_PYTHON || path.join(PROJECT_ROOT, '.venv', 'bin', 'python')
}

function sha256File(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

function packageVersion() {
  try {
    const text = readFileSync(path.join(PROJECT_ROOT, 'reference', 'fastfuncstuff', 'pyproject.toml'), 'utf8')
    const match = /^version\s*=\s*"([^"]+)"/m.exec(text)
    return match ? match[1] : 'unknown'
  } catch {
    return 'unknown'
  }
}

function gitShort(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', timeout: 30000 }).trim()
  } catch {
    return null
  }
}

function torchVersion() {
  try {
    return execFileSync(pythonPath(), ['-c', 'import torch;print(torch.__version__)'], {
      encoding: 'utf8', timeout: 60000, env: ffsEnv(),
    }).trim()
  } catch {
    return null
  }
}

function readSettled() {
  if (!existsSync(SETTLED_FILE)) return null
  try {
    return JSON.parse(readFileSync(SETTLED_FILE, 'utf8'))
  } catch {
    return null
  }
}

function writeSettled(record) {
  mkdirSync(path.dirname(SETTLED_FILE), { recursive: true })
  writeFileSync(SETTLED_FILE, `${JSON.stringify(record, null, 2)}\n`)
  return record
}

function settleProject() {
  const state = readProjectState()
  if (!state) throw Object.assign(new Error('no plan yet: plan and run first'), { code: 'not-planned' })
  const view = runView(state)
  if (view.status !== 'completed') {
    throw Object.assign(new Error('the plan has not completed: run it before settling'), { code: 'not-run' })
  }
  const workAbs = resolveInside(state.workDir, 'workDir')
  const artifacts = listArtifacts(workAbs)
  const statsArtifact = artifacts.find((artifact) => artifact.kind === 'stats' && !/ffsremlvar/.test(artifact.name))
  const results = statsArtifact ? ensureResults(workAbs, statsArtifact.path) : null
  const settled = {
    schema: 'ffs-analysis-settled/1',
    id: `settle-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`,
    at: new Date().toISOString(),
    project: {
      name: `${datasetLabel(state.params.bidsDir)} sub-${state.params.subject}`,
      dataset: `BIDS · ${datasetLabel(state.params.bidsDir)}`,
      bidsDir: state.params.bidsDir,
      subject: state.params.subject,
      session: state.params.session,
      task: state.params.task,
      recipe: state.params.recipe,
      workDir: state.workDir,
      script: state.script,
      log: state.log,
    },
    run: {
      status: view.status,
      startedAt: view.startedAt,
      finishedAt: view.finishedAt,
      stageTimes: view.stages.map((stage) => ({ name: stage.name, label: stage.label, seconds: stage.seconds ?? null })),
    },
    artifacts: artifacts.map((artifact) => ({
      name: artifact.name,
      kind: artifact.kind,
      bytes: artifact.bytes,
      path: artifact.path,
      sha256: sha256File(artifact.path),
    })),
    results: results && !results.error
      ? {
        threshold: results.threshold,
        minCluster: results.minCluster,
        voxels: results.voxels,
        contrasts: results.contrasts.map((contrast) => ({
          name: contrast.name,
          subBrick: contrast.subBrick,
          peakT: contrast.peakT,
          peakIJK: contrast.peakIJK,
          peakMM: contrast.peakMM,
          clusters: contrast.clusters.length,
        })),
        clusterCount: results.contrasts.reduce((sum, contrast) => sum + contrast.clusters.length, 0),
      }
      : null,
    scriptSha256: sha256File(resolveInside(state.script, 'script')),
    software: {
      fastfuncstuff: packageVersion(),
      fastfuncstuffRev: gitShort(path.join(PROJECT_ROOT, 'reference', 'fastfuncstuff')),
      python: pythonPath(),
      torch: torchVersion(),
    },
  }
  return writeSettled(settled)
}

function csvEscape(value) {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function csvRows(rows) {
  return `${rows.map((row) => row.map(csvEscape).join(',')).join('\n')}\n`
}

function pad(value) {
  return String(value ?? '').padEnd(2, ' ')
}

function renderMethods(settled) {
  const project = settled.project
  const results = settled.results
  const stages = settled.run.stageTimes
    .map((stage) => `${stage.name} ${stage.label}${stage.seconds != null ? `, ${stage.seconds} s` : ''}`)
    .join('; ')
  const contrastList = results
    ? results.contrasts.map((contrast) => `${contrast.name} (peak t = ${contrast.peakT})`).join(', ')
    : 'not computed'
  return `# Methods

Generated from the settled analysis (${settled.id}, ${settled.at}). Facts come from the
frozen script, its log, the design spec and the GLM bucket; edit this file after export if a
journal requires a different voice.

## Subjects

One subject (sub-${project.subject}, session ses-${project.session}) was analysed for task
${project.task}; the frozen script lists its runs. This is a single-subject analysis; the
cohort package adds the multi-subject methods section.

## Data

Functional MRI data were taken from the BIDS dataset ds005165 (BOLD Moments), subject
sub-${project.subject}, session ses-${project.session}, task ${project.task}. The analysis
used two localizer runs (268 volumes each, TR 1.75 s, 2.5 × 2.5 × 2.75 mm).

## Preprocessing

The pipeline was generated by fastfuncstuff autoproc (recipe \`${project.recipe}\`) and run as
one script, in this order: ${stages}. Motion correction was estimated per run and applied
once at the final resample together with the cross-run alignment; the final grid was
2.5 mm isotropic. Intermediate working files are resumable and frozen in
\`frozen/proc_sub-${project.subject}.sh\`.

## First-level analysis

A run-wise general linear model was fitted with \`ffs_reml\`: six task regressors convolved
with an SPMG1 basis, polynomial drift, and ARMA(1,1) prewhitening with a per-voxel REML grid
search. The model was fitted to ${results ? results.voxels : '—'} in-mask voxels across the
two runs (536 time points).

## Results

Contrast t-statistics were read from the REML bucket and thresholded at t ≥
${results ? results.threshold : '—'} for inspection. ${results ? results.contrasts.length : '—'}
contrasts (${contrastList}) produced ${results ? results.clusterCount : '—'} clusters of at
least ${results ? results.minCluster : '—'} voxels (6-connectivity). These cluster counts are
descriptive: no correction for multiple comparisons has been applied in this prototype.

## Software

- fastfuncstuff ${settled.software.fastfuncstuff}${settled.software.fastfuncstuffRev ? ` (${settled.software.fastfuncstuffRev})` : ''}
- Python ${settled.software.python}
- PyTorch ${settled.software.torch || 'unknown'}

## Limitations

Fixed-effects (single-subject) analysis; no group level, no multiple-comparison correction.
When surface/ is present it holds the fsaverage surface GLM buckets and screenshot.
The frozen script embeds absolute paths from the machine it ran on.
`
}

function renderSteps(settled) {
  const lines = [
    '# Steps',
    '',
    `Frozen analysis plan for ${settled.project.name}, settled ${settled.at}.`,
    '',
    '## Pipeline',
    '',
    '| stage | label | seconds |',
    '|---|---|---|',
    ...settled.run.stageTimes.map((stage) => `| ${stage.name} | ${stage.label} | ${stage.seconds ?? '—'} |`),
    '',
    '## Commands',
    '',
    '```bash',
    `bash frozen/proc_sub-${settled.project.subject}.sh`,
    '```',
    '',
    'The script is resumable: stages with existing outputs are skipped. Its log is written',
    `next to it (\`proc_sub-${settled.project.subject}.log\`).`,
    '',
    '## Artifacts',
    '',
    '| file | kind | bytes | sha256 |',
    '|---|---|---|---|',
    ...settled.artifacts.map((artifact) => `| ${artifact.name} | ${artifact.kind} | ${artifact.bytes} | ${(artifact.sha256 || '').slice(0, 16)}… |`),
    '',
  ]
  return lines.join('\n')
}

function renderManifest(settled, extras = {}) {
  return JSON.stringify({
    schema: 'ffs-analysis-package/1',
    settledAt: settled.at,
    settledId: settled.id,
    project: settled.project,
    software: settled.software,
    results: settled.results,
    artifacts: settled.artifacts,
    ...extras,
  }, null, 2)
}

function zipPackage(dir) {
  const zipPath = `${dir}.zip`
  try {
    execFileSync(pythonPath(), [path.join(PKG_DIR, 'scripts', 'zipdir.py'), dir, zipPath], {
      env: ffsEnv(), encoding: 'utf8', timeout: 300000,
    })
    return { path: path.relative(PROJECT_ROOT, zipPath), sha256: sha256File(zipPath) }
  } catch (error) {
    return { error: String(error && error.message) }
  }
}

function buildLock() {
  const lock = {
    schema: 'ffs-lock/1',
    createdAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, node: process.version },
    python: { path: pythonPath(), version: null, packages: {} },
    tools: {},
  }
  try {
    const info = JSON.parse(execFileSync(pythonPath(), ['-c',
      'import json,platform,numpy,nibabel,scipy,torch;print(json.dumps({"version":platform.python_version(),"packages":{"numpy":numpy.__version__,"nibabel":nibabel.__version__,"scipy":scipy.__version__,"torch":torch.__version__}}))',
    ], { env: ffsEnv(), encoding: 'utf8', timeout: 120000 }))
    lock.python.version = info.version
    lock.python.packages = info.packages
  } catch { /* leave null */ }
  for (const tool of ['zstd', '3dMEMA', '3dresample', '3dAutomask', 'Rscript']) {
    const executable = resolveToolExecutable(tool)
    const entry = { path: executable, version: null, ok: Boolean(executable) }
    try {
      if (tool === 'zstd' && executable) entry.version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim()
      if (tool === 'Rscript' && executable) entry.version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim().split('\n')[0]
    } catch { /* version optional */ }
    lock.tools[tool] = entry
  }
  return lock
}

function writePortableLock(dir) {
  const lock = buildLock()
  writeFileSync(path.join(dir, 'lock.json'), `${JSON.stringify(lock, null, 2)}\n`)
  writeFileSync(path.join(dir, 'setup.sh'), `#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
source "$here/env.sh"
echo "== setup: checking the recorded lock =="
"$FFS_PYTHON" - "$here/lock.json" <<'PY'
import json
import shutil
import sys
lock = json.load(open(sys.argv[1], encoding="utf-8"))
print("lock:", lock["schema"], "created", lock["createdAt"])
print("python:", lock["python"].get("version"), "packages:", lock["python"].get("packages"))
missing = []
for name, info in lock["tools"].items():
    path = info.get("path")
    if not (shutil.which(name) or (path and __import__("os").path.exists(path))):
        missing.append(name)
if missing:
    print("missing tools:", ", ".join(missing))
    sys.exit(1)
print("tools: ok")
PY
echo "setup: ok"
`)
  try { chmodSync(path.join(dir, 'setup.sh'), 0o755) } catch { /* best effort */ }
  return lock
}

function exportPackage() {
  const settled = readSettled()
  if (!settled) throw Object.assign(new Error('settle the analysis first'), { code: 'not-settled' })
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  const dir = path.join(EXPORT_ROOT, `ffs_analysis_${settled.project.subject}_${stamp}`)
  const workAbs = resolveInside(settled.project.workDir, 'workDir')
  mkdirSync(path.join(dir, 'frozen'), { recursive: true })
  mkdirSync(path.join(dir, 'tables'), { recursive: true })

  const scriptSrc = resolveInside(settled.project.script, 'script')
  copyFileSync(scriptSrc, path.join(dir, 'frozen', path.basename(scriptSrc)))
  const designMatches = readdirSync(workAbs).filter((name) => name.endsWith('.toml'))
  for (const name of designMatches) copyFileSync(path.join(workAbs, name), path.join(dir, 'frozen', name))
  const stimuliDir = path.join(workAbs, 'stimuli')
  if (existsSync(stimuliDir)) {
    mkdirSync(path.join(dir, 'frozen', 'stimuli'), { recursive: true })
    for (const name of readdirSync(stimuliDir)) copyFileSync(path.join(stimuliDir, name), path.join(dir, 'frozen', 'stimuli', name))
  }

  const surfaceNames = readdirSync(workAbs).filter((name) =>
    /^stage12s\.stats-reml\..*\.(func|shape)\.gii$/.test(name) && !/ffsremlvar/.test(name))
  let surfaceLabels = []
  if (surfaceNames.length) {
    const surfaceDir = path.join(dir, 'surface')
    mkdirSync(surfaceDir, { recursive: true })
    for (const name of surfaceNames) copyFileSync(path.join(workAbs, name), path.join(surfaceDir, name))
    for (const name of readdirSync(workAbs).filter((item) => /^stage10s\.surf\.allruns\..*mask\.shape\.gii$/.test(item))) {
      copyFileSync(path.join(workAbs, name), path.join(surfaceDir, name))
    }
    const sidecar = path.join(workAbs, 'stage12s.json')
    if (existsSync(sidecar)) {
      copyFileSync(sidecar, path.join(surfaceDir, 'stage12s.json'))
      try { surfaceLabels = JSON.parse(readFileSync(sidecar, 'utf8')).SubBricks || [] } catch { surfaceLabels = [] }
    }
    const shot = path.join(workAbs, 'screenshots', 'surface-fsaverage.png')
    if (existsSync(shot)) copyFileSync(shot, path.join(surfaceDir, 'screenshot.png'))
  }

  const statsArtifact = settled.artifacts.find((artifact) => artifact.kind === 'stats' && !/ffsremlvar/.test(artifact.name) && /stats-reml/.test(artifact.name))
    || settled.artifacts.find((artifact) => artifact.kind === 'stats' && !/ffsremlvar/.test(artifact.name))
  const statsAbs = statsArtifact ? resolveInside(statsArtifact.path, 'stats') : null
  if (statsAbs && existsSync(statsAbs)) {
    copyFileSync(statsAbs, path.join(dir, 'frozen', path.basename(statsAbs)))
  }
  const figuresDir = path.join(dir, 'figures')
  mkdirSync(figuresDir, { recursive: true })
  const screenshotsDir = path.join(workAbs, 'screenshots')
  if (existsSync(screenshotsDir)) {
    for (const name of readdirSync(screenshotsDir).filter((item) => /\.(png|jpe?g)$/i.test(item))) {
      copyFileSync(path.join(screenshotsDir, name), path.join(figuresDir, name))
    }
  }
  const verifyDir = path.join(dir, 'verify')
  mkdirSync(verifyDir, { recursive: true })
  for (const name of ['artifact_hash.py', 'artifact_compare.py']) {
    copyFileSync(path.join(PKG_DIR, 'scripts', name), path.join(verifyDir, name))
  }

  let viewerIncluded = null
  const viewerState = path.join(PROJECT_ROOT, '.ffs-viewer')
  if (existsSync(path.join(viewerState, 'viewer.ffs'))) {
    const viewerDir = path.join(dir, 'viewer')
    mkdirSync(viewerDir, { recursive: true })
    copyFileSync(path.join(viewerState, 'viewer.ffs'), path.join(viewerDir, 'viewer.ffs'))
    if (existsSync(path.join(viewerState, 'workspace.json'))) {
      copyFileSync(path.join(viewerState, 'workspace.json'), path.join(viewerDir, 'workspace.json'))
    }
    viewerIncluded = { script: 'viewer/viewer.ffs', workspace: 'viewer/workspace.json' }
  }

  const results = ensureResults(workAbs, statsArtifact ? resolveInside(statsArtifact.path, 'stats') : '', {
    threshold: settled.results?.threshold ?? 3.1,
    minCluster: settled.results?.minCluster ?? 10,
  })
  const contrastRows = [['contrast', 'subBrick', 'peakT', 'i', 'j', 'k', 'x_mm', 'y_mm', 'z_mm']]
  const clusterRows = [['contrast', 'voxels', 'peakT', 'i', 'j', 'k', 'x_mm', 'y_mm', 'z_mm']]
  for (const contrast of results.contrasts || []) {
    contrastRows.push([contrast.name, contrast.subBrick, contrast.peakT, ...(contrast.peakIJK || []), ...(contrast.peakMM || [])])
    for (const cluster of contrast.clusters || []) {
      clusterRows.push([contrast.name, cluster.size, cluster.peakT, ...(cluster.ijk || []), ...(cluster.mm || [])])
    }
  }
  writeFileSync(path.join(dir, 'tables', 'contrasts.csv'), csvRows(contrastRows))
  writeFileSync(path.join(dir, 'tables', 'clusters.csv'), csvRows(clusterRows))

  writeFileSync(path.join(dir, 'README.md'), `# ${settled.project.name} — reproducible analysis package

Generated from settled analysis ${settled.id} (${settled.at}).

## Run

\`\`\`bash
bash doctor.sh
bash run.sh
\`\`\`

## Layout

- \`frozen/\` — the exact autoproc script, design spec and stimuli that produced the analysis
- \`tables/\` — contrast peaks and clusters
- \`STEPS.md\`, \`METHODS.md\`, \`methods.yaml\` — what ran and how to write it up
- \`manifest.json\` — plan, software and artifact hashes

## Caveat

The frozen script embeds absolute paths from the machine it ran on; move/copy the data or
edit \`env.sh\` to reproduce elsewhere. Group level, multiple-comparison correction and
surface outputs are not part of this export.
`)
  writeFileSync(path.join(dir, 'STEPS.md'), renderSteps(settled))
  let methodsText = renderMethods(settled)
  if (surfaceNames.length) {
    methodsText += `\n## Surface analysis\n\nThe same task model was fitted on the **fsaverage** cortical surface ` +
      `(stage10s surface sampling, stage12s ffs_reml), hemispheres lh/rh, with the surface GLM ` +
      `sharing the design spec and censoring of the volume fit. Buckets: ${surfaceNames.join(', ')}. ` +
      `Labels: ${surfaceLabels.join(', ') || 'see stage12s.json'}.\n`
  }
  writeFileSync(path.join(dir, 'METHODS.md'), methodsText)
  const methodsLint = lintMethods(methodsText, ['Methods', 'Subjects'])
  if (!methodsLint.ok) throw Object.assign(new Error(`methods lint failed: ${methodsLint.issues.join('; ')}`), { code: 'methods-lint' })
  writeFileSync(path.join(dir, 'methods.yaml'), `# Structured facts behind METHODS.md
dataset:
  source: BIDS ds005165 (BOLD Moments)
  subject: sub-${settled.project.subject}
  session: ses-${settled.project.session}
  task: ${settled.project.task}
  runs: 2
  tr_s: 1.75
  volumes_per_run: 268
preprocessing:
  tool: fastfuncstuff autoproc
  recipe: ${settled.project.recipe}
  stages:
${settled.run.stageTimes.map((stage) => `    - { name: ${stage.name}, label: "${stage.label}", seconds: ${stage.seconds ?? 'null'} }`).join('\n')}
analysis:
  glm: ffs_reml ARMA(1,1)
  hrf: SPMG1
  voxels: ${settled.results?.voxels ?? 'null'}
  contrasts: ${settled.results?.contrasts?.length ?? 0}
results:
  threshold: ${settled.results?.threshold ?? 'null'}
  clusters: ${settled.results?.clusterCount ?? 0}
software:
  fastfuncstuff: "${settled.software.fastfuncstuff}"
  revision: "${settled.software.fastfuncstuffRev || ''}"
  python: "${settled.software.python}"
  torch: "${settled.software.torch || ''}"
`)
  writeFileSync(path.join(dir, 'CITATIONS.md'), `# Citations

- fastfuncstuff (${settled.software.fastfuncstuff}, ${settled.software.fastfuncstuffRev || 'checkout'}):
  https://github.com/dowdlelt/fastfuncstuff
- PyTorch ${settled.software.torch || ''}: https://pytorch.org

Add the paper citations for the dataset and for any method (motion correction, REML,
thresholding) your manuscript requires; this file intentionally contains no invented
references.
`)
  writeFileSync(path.join(dir, 'env.sh'), `#!/usr/bin/env bash
# Environment recorded at export time (absolute paths).
export FFS_PYTHON="\${FFS_PYTHON:-${pythonPath()}}"
export PYTHONPATH="${PROJECT_ROOT}/python:${PROJECT_ROOT}/reference/fastfuncstuff\${PYTHONPATH:+:$PYTHONPATH}"
export PATH="${PROJECT_ROOT}/work/bin:\$PATH"
export MPLCONFIGDIR="\${MPLCONFIGDIR:-${PROJECT_ROOT}/work/.mpl}"
`)
  writeFileSync(path.join(dir, 'run.sh'), `#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
source "$here/env.sh"
echo "== running frozen pipeline =="
bash "$here/frozen/${path.basename(scriptSrc)}"
echo "== done =="
`)
  writeFileSync(path.join(dir, 'doctor.sh'), `#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
source "$here/env.sh"
"$FFS_PYTHON" -c "import fastfuncstuff, torch; print('fastfuncstuff ok; torch', torch.__version__)"
command -v zstd >/dev/null || echo "warning: zstd not found"
test -f "$here/frozen/${path.basename(scriptSrc)}" || { echo "missing frozen script"; exit 1; }
echo "doctor: ok"
`)
  for (const file of ['env.sh', 'run.sh', 'doctor.sh', 'setup.sh']) {
    try { execFileSync('chmod', ['+x', path.join(dir, file)]) } catch { /* best effort */ }
  }
  writePortableLock(dir)
  writeFileSync(path.join(dir, 'verify.sh'), `#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
cd "$here"
echo "== checksums =="
shasum -a 256 -c checksums.sha256
echo "checksums: ok"
if [ "\${1:-}" = "--replay" ]; then
  source "$here/env.sh"
  work="$(mktemp -d)"
  script=$(ls frozen/proc_sub-*.sh | head -1)
  stats=$(ls frozen/stage12.stats-reml.*.nii.gz | head -1)
  sed 's|^OUT=.*$|OUT="$(cd "$(dirname "$0")" \\&\\& pwd)"|' "$script" > "$work/$(basename "$script")"
  cp frozen/stage11.design.*.toml "$work"/ 2>/dev/null || true
  cp -R frozen/stimuli "$work"/ 2>/dev/null || true
  ( cd "$work" && bash "$(basename "$script")" > replay.log 2>&1 )
  python verify/artifact_compare.py "$stats" "$work/$(basename "$stats")" | tee replay-compare.json
  grep -q '"toleranceMatch": true' replay-compare.json
  echo "replay: numerically equivalent"
fi
`)
  try { chmodSync(path.join(dir, 'verify.sh'), 0o755) } catch { /* best effort */ }
  writeFileSync(path.join(dir, 'manifest.json'), renderManifest(settled, {
    lock: { path: 'lock.json', sha256: sha256File(path.join(dir, 'lock.json')) },
    methodsLint,
    surface: surfaceNames.length ? { files: surfaceNames, labels: surfaceLabels } : null,
    viewer: viewerIncluded,
    verify: { script: 'verify.sh', frozenStats: statsAbs ? path.basename(statsAbs) : null, figures: existsSync(figuresDir) },
  }))

  const checksumLines = []
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const abs = path.join(folder, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (!abs.endsWith('checksums.sha256')) checksumLines.push(`${sha256File(abs)}  ${path.relative(dir, abs)}`)
    }
  }
  walk(dir)
  writeFileSync(path.join(dir, 'checksums.sha256'), `${checksumLines.join('\n')}\n`)

  const zip = zipPackage(dir)
  const record = writeSettled({ ...settled, exportPath: path.relative(PROJECT_ROOT, dir), exportedAt: new Date().toISOString() })
  return {
    zip,
    ok: true,
    path: path.relative(PROJECT_ROOT, dir),
    files: checksumLines.length + 1,
    settledId: record.id,
  }
}

// ------------------------------------------------------------------ M0: scan / doctor
function ensureShims() {
  const shimDir = path.join(PROJECT_ROOT, 'work', 'bin')
  const pyproject = path.join(PROJECT_ROOT, 'reference', 'fastfuncstuff', 'pyproject.toml')
  if (!existsSync(pyproject)) return 0
  mkdirSync(shimDir, { recursive: true })
  const text = readFileSync(pyproject, 'utf8')
  const section = /\[project\.scripts\]([\s\S]*?)(?=\n\[)/.exec(text)
  if (!section) return 0
  let count = 0
  for (const line of section[1].split('\n')) {
    const match = /^\s*(ffs_[a-z0-9_]+)\s*=\s*"([^":]+)(?::[^"]*)?"/.exec(line)
    if (!match) continue
    const [, tool, module] = match
    const file = path.join(shimDir, tool)
    const body = [
      '#!/bin/bash',
      `export PYTHONPATH="${PROJECT_ROOT}/python:${PROJECT_ROOT}/reference/fastfuncstuff\${PYTHONPATH:+:\$PYTHONPATH}"`,
      `exec "${pythonPath()}" -m ${module} "\$@"`,
      '',
    ].join('\n')
    writeFileSync(file, body)
    try { chmodSync(file, 0o755) } catch { /* best effort */ }
    count += 1
  }
  return count
}

function readJsonIf(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function scanBids(params = {}) {
  const rootAbs = resolveInside(params.bidsDir || 'data/bids-lite', 'bidsDir')
  if (!existsSync(rootAbs)) {
    throw Object.assign(new Error(`BIDS directory not found: ${params.bidsDir || 'data/bids-lite'}`), { code: 'bids-invalid' })
  }
  const description = readJsonIf(path.join(rootAbs, 'dataset_description.json'))
  const subjects = []
  const warnings = []
  const entries = readdirSync(rootAbs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^sub-/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const subjectDir = path.join(rootAbs, entry.name)
    const sessionNames = readdirSync(subjectDir, { withFileTypes: true })
      .filter((item) => item.isDirectory() && /^ses-/.test(item.name))
      .map((item) => item.name)
      .sort()
    const sessions = []
    for (const sessionName of (sessionNames.length ? sessionNames : [null])) {
      const base = sessionName ? path.join(subjectDir, sessionName) : subjectDir
      const funcDir = path.join(base, 'func')
      const runs = []
      if (existsSync(funcDir)) {
        for (const name of readdirSync(funcDir)) {
          const match = /_(task-[^_]+)_(?:acq-[^_]+_)?(run-([0-9]+))_bold\.nii\.gz$/.exec(name)
          if (!match) continue
          const events = path.join(funcDir, name.replace('_bold.nii.gz', '_events.tsv'))
          const sidecar = readJsonIf(path.join(funcDir, name.replace('.nii.gz', '.json')))
          runs.push({
            task: match[1].replace('task-', ''),
            run: Number(match[3]),
            bold: path.relative(PROJECT_ROOT, path.join(funcDir, name)),
            events: existsSync(events) ? path.relative(PROJECT_ROOT, events) : null,
            tr: sidecar?.RepetitionTime ?? null,
          })
          if (!existsSync(events)) warnings.push(`${entry.name}/${sessionName || ''}: missing events for ${name}`)
        }
      }
      runs.sort((a, b) => a.task.localeCompare(b.task) || a.run - b.run)
      const anatDir = path.join(base, 'anat')
      const anat = existsSync(anatDir)
        ? readdirSync(anatDir).filter((name) => /_T1w\.nii\.gz$/.test(name))
          .map((name) => path.relative(PROJECT_ROOT, path.join(anatDir, name)))
        : []
      const fmapDir = path.join(base, 'fmap')
      const fmapFiles = existsSync(fmapDir) ? readdirSync(fmapDir).length : 0
      if (!runs.length) warnings.push(`${entry.name}/${sessionName || ''}: no functional runs`)
      if (!anat.length) warnings.push(`${entry.name}/${sessionName || ''}: no T1w`)
      sessions.push({ id: sessionName, runs, anat, fmapFiles })
    }
    subjects.push({
      id: entry.name,
      sessions,
      runs: sessions.reduce((total, session) => total + session.runs.length, 0),
    })
  }
  const tasks = [...new Set(subjects.flatMap((subject) => subject.sessions.flatMap((session) => session.runs.map((run) => run.task))))].sort()
  return {
    schema: 'ffs-bids-scan/1',
    root: path.relative(PROJECT_ROOT, rootAbs),
    dataset: description ? { name: description.Name ?? null, bidsVersion: description.BIDSVersion ?? null } : null,
    subjects,
    summary: {
      subjects: subjects.length,
      sessions: subjects.reduce((total, subject) => total + subject.sessions.length, 0),
      runs: subjects.reduce((total, subject) => total + subject.runs, 0),
      tasks,
      hasFieldmaps: subjects.some((subject) => subject.sessions.some((session) => session.fmapFiles > 0)),
    },
    warnings,
  }
}

function doctorChecks() {
  const checks = []
  const python = pythonPath()
  checks.push({ id: 'python', label: 'python interpreter', ok: existsSync(python), detail: python, required: true })
  let importOk = false
  let torch = null
  try {
    torch = execFileSync(python, ['-c', 'import fastfuncstuff, torch;print(torch.__version__)'], {
      env: ffsEnv(), encoding: 'utf8', timeout: 120000,
    }).trim()
    importOk = true
  } catch (error) {
    importOk = false
  }
  checks.push({
    id: 'fastfuncstuff', label: 'fastfuncstuff + torch import', ok: importOk,
    detail: torch ? `torch ${torch}` : 'import failed', required: true,
  })
  const shims = ensureShims()
  checks.push({ id: 'shims', label: 'ffs_* command shims', ok: shims > 0, detail: `${shims} in work/bin`, required: true })
  for (const tool of ['zstd', '3dMEMA', '3dresample', '3dAutomask', 'Rscript']) {
    let ok = false
    let where = 'not found'
    try {
      where = execFileSync('which', [tool], { encoding: 'utf8' }).trim() || 'not found'
      ok = where !== 'not found'
    } catch { /* missing */ }
    checks.push({ id: `tool:${tool}`, label: tool, ok, detail: where, required: tool === 'zstd' })
  }
  const mplDir = path.join(PROJECT_ROOT, 'work', '.mpl')
  let mplOk = false
  try {
    mkdirSync(mplDir, { recursive: true })
    const probe = path.join(mplDir, '.write-probe')
    writeFileSync(probe, 'ok')
    unlinkSync(probe)
    mplOk = true
  } catch { /* not writable */ }
  checks.push({ id: 'mplconfig', label: 'MPLCONFIGDIR writable', ok: mplOk, detail: mplDir, required: true })
  try {
    const stats = statfsSync(PROJECT_ROOT)
    const freeGb = (stats.bfree * stats.bsize) / 1e9
    checks.push({ id: 'disk', label: 'free disk', ok: freeGb > 5, detail: `${freeGb.toFixed(1)} GB`, required: true })
  } catch { /* unsupported */ }
  const fixture = path.join(PROJECT_ROOT, 'data', 'bids-lite')
  checks.push({ id: 'fixture', label: 'BIDS-lite fixture', ok: existsSync(fixture), detail: path.relative(PROJECT_ROOT, fixture), required: true })
  const required = checks.filter((check) => check.required)
  return { ok: required.every((check) => check.ok), checks }
}

// ------------------------------------------------------------------ cohort / group
const DEFAULT_COHORT_ROOT = path.join(PROJECT_ROOT, 'work', 'ds005165')
const GROUP_STATE_FILE = path.join(PROJECT_ROOT, 'work', 'ffs-analysis-group.json')
const COHORT_PREFS_FILE = path.join(PROJECT_ROOT, 'work', 'ffs-cohort-include.json')

/** The cohort lives beside the current subject's work dir: work/<dataset>/<subject>. */
function currentProjectWorkDir() {
  const state = readProjectState()
  if (!state || !state.workDir) return null
  try {
    return resolveInside(state.workDir, 'workDir')
  } catch {
    return null
  }
}

function cohortRootForState(state) {
  if (!state || !state.workDir) return DEFAULT_COHORT_ROOT
  try {
    return path.dirname(resolveInside(state.workDir, 'workDir'))
  } catch {
    return DEFAULT_COHORT_ROOT
  }
}

function readCohortPrefs() {
  try {
    if (existsSync(COHORT_PREFS_FILE)) {
      const value = JSON.parse(readFileSync(COHORT_PREFS_FILE, 'utf8'))
      return value && typeof value === 'object' ? value : {}
    }
  } catch { /* empty */ }
  return {}
}

function writeCohortPrefs(prefs) {
  mkdirSync(path.dirname(COHORT_PREFS_FILE), { recursive: true })
  writeFileSync(COHORT_PREFS_FILE, `${JSON.stringify(prefs, null, 2)}\n`)
  return prefs
}

function currentCohortRoot() {
  return cohortRootForState(readProjectState())
}

function discoverCohort(workRootAbs) {
  const rootAbs = workRootAbs || DEFAULT_COHORT_ROOT
  const cohort = {
    root: path.relative(PROJECT_ROOT, rootAbs),
    status: 'empty',
    total: 0,
    included: 0,
    subjects: [],
    note: 'Run at least two subjects to enable a group analysis.',
  }
  if (!existsSync(rootAbs)) return cohort
  const bySubject = new Map()
  for (const entry of readdirSync(rootAbs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const workAbs = path.join(rootAbs, entry.name)
    let files = []
    try {
      files = readdirSync(workAbs)
    } catch {
      continue
    }
    for (const scriptName of files.filter((name) => /^proc_sub-.+\.sh$/.test(name))) {
      const subject = scriptName.replace(/^proc_sub-/, '').replace(/\.sh$/, '')
      const statsName = files.find((name) => /^stage12\.stats-reml\..*\.nii\.gz$/.test(name) && !/ffsremlvar/.test(name))
      const meanName = files.find((name) => /_mean\.nii\.gz$/.test(name))
      const statsAbs = statsName ? path.join(workAbs, statsName) : null
      let statsMtime = 0
      try {
        if (statsAbs) statsMtime = statSync(statsAbs).mtimeMs
      } catch { /* skip */ }
      const record = {
        id: `sub-${subject}`,
        subject,
        workDir: path.relative(PROJECT_ROOT, workAbs),
        script: path.relative(PROJECT_ROOT, path.join(workAbs, scriptName)),
        log: path.relative(PROJECT_ROOT, path.join(workAbs, scriptName.replace(/\.sh$/, '.log'))),
        stats: statsAbs ? path.relative(PROJECT_ROOT, statsAbs) : null,
        mean: meanName ? path.relative(PROJECT_ROOT, path.join(workAbs, meanName)) : null,
        statsMtime,
        include: true,
        status: statsAbs ? 'completed' : 'planned',
      }
      const variant = {
        id: entry.name === `sub-${subject}` ? 'canonical' : entry.name,
        workDir: record.workDir,
        stats: record.stats,
        status: record.status,
      }
      let group = bySubject.get(subject)
      if (!group) {
        group = { variants: [] }
        bySubject.set(subject, group)
      }
      group.variants.push(variant)
      if (!group.record) {
        group.record = record
      } else if (record.statsMtime > group.record.statsMtime) {
        // Keep the canonical work dir as the subject's primary record; variants stay listed.
        const currentCanonical = path.basename(group.record.workDir) === `sub-${subject}`
        if (!currentCanonical) group.record = record
      }
    }
  }
  const prefs = readCohortPrefs()[cohort.root] || {}
  const subjects = [...bySubject.values()]
    .map((group) => ({ ...group.record, variants: group.variants, include: prefs[group.record.subject] !== false }))
    .sort((a, b) => a.subject.localeCompare(b.subject))
  cohort.subjects = subjects
  cohort.total = subjects.length
  cohort.included = subjects.filter((subject) => subject.stats && subject.include !== false).length
  cohort.status = subjects.length ? (cohort.included >= 2 ? 'ready' : 'single-subject') : 'empty'
  if (cohort.included >= 2) cohort.note = `${cohort.included} subjects with a first-level fit; 3dMEMA can run.`
  return cohort
}

function groupCohortRoot(analysis) {
  if (analysis.cohortRoot) return analysis.cohortRoot
  // Legacy records predate the field; the group work dir sits under its cohort root.
  return analysis.workDir ? path.dirname(analysis.workDir) : 'work/ds005165'
}

function readGroupState() {
  try {
    if (existsSync(GROUP_STATE_FILE)) {
      const data = JSON.parse(readFileSync(GROUP_STATE_FILE, 'utf8'))
      if (Array.isArray(data.analyses)) return data
    }
  } catch { /* fall through */ }
  return { analyses: [] }
}

function writeGroupState(state) {
  mkdirSync(path.dirname(GROUP_STATE_FILE), { recursive: true })
  writeFileSync(GROUP_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`)
  return state
}

function groupSummaryRecord(analysis) {
  const workAbs = resolveInside(analysis.workDir, 'group work dir')
  const bucketAbs = resolveInside(analysis.bucket, 'group bucket')
  const summary = ensureResults(workAbs, bucketAbs)
  if (summary.error) {
    return { ...analysis, status: 'failed', error: summary.error, contrasts: [], clusters: [] }
  }
  const threshold = summary.threshold
  const contrasts = (summary.contrasts || []).map((contrast) => ({
    id: contrast.name,
    name: contrast.name,
    subBrick: contrast.subBrick,
    subBrickIndex: contrast.index,
    stat: 't',
    peak: contrast.peakT,
    peakIJK: contrast.peakIJK,
    peakMM: contrast.peakMM,
    threshold,
  }))
  const corrected = new Map(((analysis.correctionResult && analysis.correctionResult.clusters) || [])
    .map((cluster) => [cluster.ijk.join('_'), cluster]))
  const clusters = (summary.contrasts || []).flatMap((contrast) => (contrast.clusters || []).map((cluster) => {
    const fix = corrected.get(cluster.ijk.join('_'))
    return {
      id: `${contrast.name}.${cluster.ijk.join('_')}`,
      contrast: contrast.name,
      subBrick: contrast.subBrick,
      subBrickIndex: contrast.index,
      threshold,
      ...cluster,
      p: fix ? fix.p : null,
      significant: fix ? fix.significant : null,
    }
  })).slice(0, 40)
  return {
    ...analysis,
    status: 'completed',
    threshold,
    voxels: summary.voxels,
    contrasts,
    clusters,
    correction: analysis.correctionResult || null,
    statsPath: bucketAbs,
    meanPath: analysis.mean ? resolveInside(analysis.mean, 'group mean') : null,
  }
}

function validateCohort(workRootAbs) {
  const rootAbs = workRootAbs || currentCohortRoot()
  const cohort = discoverCohort(rootAbs)
  const statsSubjects = cohort.subjects.filter((subject) => subject.stats)
  let metadata = []
  if (statsSubjects.length) {
    try {
      const output = execFileSync(pythonPath(), [
        path.join(PKG_DIR, 'scripts', 'bucket_meta.py'),
        ...statsSubjects.map((subject) => resolveInside(subject.stats, 'stats')),
      ], { env: ffsEnv(), encoding: 'utf8', timeout: 180000 })
      metadata = JSON.parse(output)
    } catch (error) {
      metadata = []
    }
  }
  const byPath = new Map(metadata.map((item) => [item.path, item]))
  let reference = null
  const subjects = cohort.subjects.map((subject) => {
    const issues = []
    const workAbs = resolveInside(subject.workDir, 'workDir')
    if (!subject.stats) {
      issues.push({ code: 'missing-output', message: 'no stage12.stats-reml bucket in this work dir' })
    } else {
      const info = byPath.get(resolveInside(subject.stats, 'stats'))
      if (!info || !info.ok) {
        issues.push({ code: 'unreadable-output', message: (info && info.error) || 'bucket metadata unavailable' })
      } else if (!reference) {
        reference = info
      } else {
        const shapeDiff = JSON.stringify(info.shape) !== JSON.stringify(reference.shape)
        const affineDiff = info.affine.some((row, i) => row.some((value, j) => Math.abs(value - reference.affine[i][j]) > 1e-3))
        if (shapeDiff || affineDiff) {
          issues.push({
            code: 'grid-mismatch',
            message: `grid ${info.shape.join('x')} does not match reference ${reference.shape.join('x')}`,
          })
        }
      }
    }
    try {
      const scriptAbs = resolveInside(subject.script, 'script')
      if (!existsSync(scriptAbs)) issues.push({ code: 'missing-script', message: 'proc_sub-*.sh missing' })
      const design = readdirSync(workAbs).find((name) => /^stage11\.design\..*\.toml$/.test(name))
      if (!design) issues.push({ code: 'missing-design', message: 'stage11.design.*.toml missing' })
      if (!existsSync(path.join(workAbs, 'stimuli'))) {
        issues.push({ code: 'missing-stimuli', message: 'stimuli/ missing' })
      }
    } catch {
      issues.push({ code: 'missing-workdir', message: 'work dir unreadable' })
    }
    return {
      id: subject.id,
      workDir: subject.workDir,
      stats: subject.stats,
      status: subject.status,
      variants: subject.variants || [],
      ok: issues.length === 0,
      issues,
    }
  })
  return {
    schema: 'ffs-cohort-validation/1',
    root: path.relative(PROJECT_ROOT, rootAbs),
    ok: subjects.length > 0 && subjects.every((subject) => subject.ok),
    checkedAt: new Date().toISOString(),
    subjects,
  }
}

function walkFiles(root) {
  const files = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) files.push(absolute)
    }
  }
  visit(root)
  return files
}

function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dst, entry.name)
    if (entry.isDirectory()) copyTree(from, to)
    else if (entry.isFile()) copyFileSync(from, to)
  }
}

function subjectRunCount(workAbs) {
  try {
    const scriptName = readdirSync(workAbs).find((name) => /^proc_sub-.*\.sh$/.test(name))
    if (scriptName) {
      const text = readFileSync(path.join(workAbs, scriptName), 'utf8')
      const match = /RUN_KEYS=\(([^)]*)\)/.exec(text)
      if (match) return match[1].trim().split(/\s+/).filter(Boolean).length
    }
    return readdirSync(workAbs).filter((name) => /^stage02\.moco\..*_mean\.nii/.test(name)).length || null
  } catch {
    return null
  }
}

function yamlString(value) {
  return JSON.stringify(String(value))
}

function subjectYaml(subject, checked) {
  const lines = [
    'schema: ffs-subject/1',
    `subject: ${yamlString(subject.id)}`,
    `work_dir: ${yamlString(subject.workDir)}`,
    `runs: ${subjectRunCount(resolveInside(subject.workDir, 'workDir')) ?? 'unknown'}`,
    `status: ${yamlString(subject.status)}`,
    'variants:',
  ]
  for (const variant of subject.variants || []) {
    lines.push(`  - id: ${yamlString(variant.id)}`)
    lines.push(`    work_dir: ${yamlString(variant.workDir)}`)
    lines.push(`    status: ${yamlString(variant.status)}`)
    const variantDir = variant.id === 'canonical' ? `subjects/${subject.id}` : `subjects/${subject.id}/variants/${variant.id}`
    lines.push(`    stats: ${variant.stats ? yamlString(`${variantDir}/${path.basename(variant.stats)}`) : 'null'}`)
  }
  lines.push('validation:')
  lines.push(`  ok: ${checked ? checked.ok : false}`)
  lines.push('  issues:')
  if (checked && checked.issues.length) {
    for (const issue of checked.issues) lines.push(`    - ${yamlString(`${issue.code}: ${issue.message}`)}`)
  } else {
    lines.push('    []')
  }
  return `${lines.join('\n')}\n`
}

function cohortYaml(cohort, validation) {
  const lines = [
    'schema: ffs-cohort/1',
    `generated_at: ${yamlString(validation.checkedAt)}`,
    `dataset: ${yamlString(path.basename(validation.root))}`,
    `work_root: ${yamlString(validation.root)}`,
    'subjects:',
  ]
  for (const subject of cohort.subjects) {
    lines.push(`  - id: ${yamlString(subject.id)}`)
    lines.push(`    dir: ${yamlString(`subjects/${subject.id}`)}`)
    lines.push(`    work_dir: ${yamlString(subject.workDir)}`)
    lines.push(`    runs: ${subjectRunCount(resolveInside(subject.workDir, 'workDir')) ?? 'unknown'}`)
    lines.push(`    variants: [${(subject.variants || []).map((variant) => yamlString(variant.id)).join(', ')}]`)
  }
  lines.push('validation:')
  lines.push(`  ok: ${validation.ok}`)
  lines.push(`  checked_at: ${yamlString(validation.checkedAt)}`)
  lines.push(`  subjects: ${validation.subjects.length}`)
  return `${lines.join('\n')}\n`
}

function cohortRunScript(subjectIds) {
  return `#!/usr/bin/env bash
# Re-run every subject's frozen autoproc script with bounded parallelism.
# MAX_PARALLEL controls how many subjects run at once (default 2).
set -euo pipefail
HERE="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
MAX_PARALLEL="\${MAX_PARALLEL:-2}"
SUBJECTS=(${subjectIds.map((id) => yamlString(id)).join(' ')})

run_one() {
  local subject="$1"
  local dir="$HERE/subjects/$subject"
  echo "run: $subject"
  ( cd "$dir" && bash "proc_$subject.sh" > "proc_$subject.log" 2>&1 )
  echo "done: $subject"
}

for subject in "\${SUBJECTS[@]}"; do
  while (( $(jobs -rp | wc -l) >= MAX_PARALLEL )); do wait -n; done
  run_one "$subject" &
done
wait
echo "cohort done"
`
}

function cohortValidateScript() {
  return `#!/usr/bin/env python3
"""Validate the exported cohort: scripts, designs, stimuli and a common grid."""
from __future__ import annotations
import json, sys
from pathlib import Path
try:
    import nibabel as nib
except ImportError:
    nib = None

HERE = Path(__file__).resolve().parent
data = json.loads((HERE / "cohort.json").read_text())
issues = []
reference = None
for subject in data["subjects"]:
    sid = subject["id"]
    root = HERE / "subjects" / sid
    if not (root / f"proc_{sid}.sh").exists():
        issues.append(f"{sid}: missing proc_{sid}.sh")
    if not list(root.glob("stage11.design.*.toml")):
        issues.append(f"{sid}: missing stage11.design.*.toml")
    if not (root / "stimuli").is_dir():
        issues.append(f"{sid}: missing stimuli/")
    stats = subject.get("stats")
    if not stats:
        issues.append(f"{sid}: missing stage12 stats bucket")
        continue
    if nib is None:
        continue
    try:
        stats_path = Path(stats)
        if not stats_path.is_absolute():
            stats_path = HERE / stats_path
        image = nib.load(str(stats_path))
        shape = tuple(image.shape)
        affine = image.affine
        if reference is None:
            reference = (shape, affine)
        elif shape != reference[0]:
            issues.append(f"{sid}: grid {shape} != {reference[0]}")
    except Exception as error:
        issues.append(f"{sid}: cannot read stats ({error})")
print("cohort validation:", "ok" if not issues else "FAILED")
for issue in issues:
    print(" -", issue)
sys.exit(0 if not issues else 1)
`
}

function lintMethods(text, required = ['Methods', 'Subjects']) {
  const issues = []
  for (const token of ['undefined', 'NaN', 'TODO', 'TBD', 'Lorem ipsum']) {
    if (text.includes(token)) issues.push(`placeholder: ${token}`)
  }
  const lower = text.toLowerCase()
  for (const heading of required) {
    if (!lower.includes(heading.toLowerCase())) issues.push(`missing section: ${heading}`)
  }
  return { ok: issues.length === 0, issues }
}

function csvText(rows) {
  return `${rows.map((row) => row.map((value) => {
    const text = value == null ? '' : String(value)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }).join(',')).join('\n')}\n`
}

function exportCohortPackage(params = {}) {
  const rootAbs = params.workRoot ? resolveInside(params.workRoot, 'workRoot') : currentCohortRoot()
  const validation = validateCohort(rootAbs)
  if (!validation.subjects.length) {
    throw Object.assign(new Error('cohort has no subjects to export'), { code: 'cohort-empty' })
  }
  const failures = validation.subjects.filter((subject) => !subject.ok && exportSubjects.some((item) => item.id === subject.id))
  if (failures.length) {
    throw Object.assign(
      new Error(`cohort validation failed: ${failures.map((subject) => `${subject.id} (${subject.issues.map((issue) => issue.code).join(', ')})`).join('; ')}`),
      { code: 'cohort-invalid', issues: failures },
    )
  }
  const cohort = discoverCohort(rootAbs)
  const exportSubjects = cohort.subjects.filter((subject) => subject.include !== false)
  if (!exportSubjects.length) {
    throw Object.assign(new Error('all cohort subjects are excluded'), { code: 'cohort-empty' })
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  const dir = path.join(EXPORT_ROOT, `ffs_cohort_${path.basename(rootAbs)}_${stamp}`)
  mkdirSync(path.join(dir, 'subjects'), { recursive: true })
  let fileCount = 0
  for (const subject of exportSubjects) {
    const workAbs = resolveInside(subject.workDir, 'workDir')
    const checked = validation.subjects.find((item) => item.id === subject.id)
    for (const variant of subject.variants || []) {
      const variantWork = resolveInside(variant.workDir, 'variant work dir')
      const target = variant.id === 'canonical'
        ? path.join(dir, 'subjects', subject.id)
        : path.join(dir, 'subjects', subject.id, 'variants', variant.id)
      mkdirSync(target, { recursive: true })
      const scriptName = readdirSync(variantWork).find((name) => /^proc_sub-.*\.sh$/.test(name))
      if (scriptName) {
        const source = path.join(variantWork, scriptName)
        const text = readFileSync(source, 'utf8').replace(/^OUT=.*$/m, 'OUT="$(cd "$(dirname "$0")" && pwd)"')
        writeFileSync(path.join(target, scriptName), text)
        try { chmodSync(path.join(target, scriptName), 0o755) } catch { /* best effort */ }
      }
      for (const name of readdirSync(variantWork).filter((item) => /^stage11\.design\..*\.toml$/.test(item))) {
        copyFileSync(path.join(variantWork, name), path.join(target, name))
      }
      const stimuli = path.join(variantWork, 'stimuli')
      if (existsSync(stimuli)) copyTree(stimuli, path.join(target, 'stimuli'))
      if (variant.stats) {
        copyFileSync(resolveInside(variant.stats, 'stats'), path.join(target, path.basename(variant.stats)))
      }
    }
    const subjectRoot = path.join(dir, 'subjects', subject.id)
    writeFileSync(path.join(subjectRoot, 'subject.yaml'), subjectYaml(subject, checked))
  }
  writeFileSync(path.join(dir, 'cohort.yaml'), cohortYaml({ ...cohort, subjects: exportSubjects, included: exportSubjects.filter((subject) => subject.stats).length }, validation))
  writeFileSync(path.join(dir, 'cohort.json'), `${JSON.stringify({
    schema: 'ffs-cohort/1',
    generated_at: validation.checkedAt,
    dataset: path.basename(validation.root),
    work_root: validation.root,
    source_root: PROJECT_ROOT,
    subjects: validation.subjects.map((subject) => ({
      id: subject.id,
      work_dir: subject.workDir,
      stats: subject.stats ? `subjects/${subject.id}/${path.basename(subject.stats)}` : null,
      variants: subject.variants,
      ok: subject.ok,
      issues: subject.issues,
    })),
  }, null, 2)}\n`)
  writeFileSync(path.join(dir, 'run.sh'), cohortRunScript(exportSubjects.map((subject) => subject.id)))
  writeFileSync(path.join(dir, 'validate.py'), cohortValidateScript())
  writeFileSync(path.join(dir, 'env.sh'), `#!/usr/bin/env bash
# Environment recorded at export time (absolute paths).
export FFS_PYTHON="\${FFS_PYTHON:-${pythonPath()}}"
export PYTHONPATH="${PROJECT_ROOT}/python:${PROJECT_ROOT}/reference/fastfuncstuff\${PYTHONPATH:+:$PYTHONPATH}"
export PATH="${PROJECT_ROOT}/work/bin:\$PATH"
export MPLCONFIGDIR="\${MPLCONFIGDIR:-${PROJECT_ROOT}/work/.mpl}"
`)
  writePortableLock(dir)
  for (const file of ['env.sh', 'setup.sh']) {
    try { chmodSync(path.join(dir, file), 0o755) } catch { /* best effort */ }
  }
  try { chmodSync(path.join(dir, 'run.sh'), 0o755) } catch { /* best effort */ }
  writeFileSync(path.join(dir, 'STEPS.md'), `# Cohort rerun\n\n${cohort.included} subjects, ${validation.ok ? 'validated' : 'FAILED'}.\n\n\`\`\`bash\nMAX_PARALLEL=2 ./run.sh\npython3 validate.py\n\`\`\`\n\nEach subject directory holds its frozen autoproc script, design spec, stimuli and\n\`subject.yaml\`; non-canonical variants live under \`subjects/<id>/variants/\`.\n`)
  const groupAnalyses = readGroupState().analyses
    .filter((item) => groupCohortRoot(item) === validation.root)
    .map(groupSummaryRecord)
  let groupLint = { ok: true, issues: [] }
  if (groupAnalyses.length) {
    const groupDir = path.join(dir, 'group')
    mkdirSync(groupDir, { recursive: true })
    const groupLines = [
      'schema: ffs-group/1',
      `generated_at: ${yamlString(validation.checkedAt)}`,
      `work_root: ${yamlString(validation.root)}`,
      'analyses:',
    ]
    const allRows = [['analysis', 'contrast', 'model', 'engine', 'correction', 'cluster', 'voxels', 'peakT', 'p', 'significant', 'i', 'j', 'k']]
    for (const analysis of groupAnalyses) {
      const analysisDir = path.join(groupDir, analysis.id)
      mkdirSync(analysisDir, { recursive: true })
      const bucketAbs = resolveInside(analysis.bucket, 'group bucket')
      copyFileSync(bucketAbs, path.join(analysisDir, path.basename(analysis.bucket)))
      if (analysis.mask) copyFileSync(resolveInside(analysis.mask, 'group mask'), path.join(analysisDir, 'mask.nii.gz'))
      if (analysis.correction) writeFileSync(path.join(analysisDir, 'correction.json'), `${JSON.stringify(analysis.correction, null, 2)}\n`)
      const rows = [['contrast', 'voxels', 'peakT', 'p', 'significant', 'i', 'j', 'k']]
      for (const cluster of analysis.clusters || []) {
        rows.push([cluster.contrast, cluster.size, cluster.peakT, cluster.p, cluster.significant, ...(cluster.ijk || [])])
        allRows.push([analysis.id, analysis.contrast, analysis.model, analysis.engine, analysis.correction ? analysis.correction.method : 'none', cluster.size, cluster.peakT, cluster.p, cluster.significant, ...(cluster.ijk || [])])
      }
      writeFileSync(path.join(analysisDir, 'clusters.csv'), csvText(rows))
      writeFileSync(path.join(analysisDir, 'group.yaml'), [
        'schema: ffs-group-analysis/1',
        `id: ${yamlString(analysis.id)}`,
        `contrast: ${yamlString(analysis.contrast)}`,
        `model: ${yamlString(analysis.model)}`,
        `engine: ${yamlString(analysis.engine)}`,
        `n: ${analysis.n ?? analysis.nA ?? ''}`,
        analysis.nB ? `nB: ${analysis.nB}` : null,
        `correction: ${yamlString(analysis.correction ? analysis.correction.method : 'none')}`,
        `threshold: ${analysis.threshold ?? 3.1}`,
        'groups:',
        analysis.groups ? `  a: [${(analysis.groups.a || []).map(yamlString).join(', ')}]` : '  a: []',
        analysis.groups ? `  b: [${(analysis.groups.b || []).map(yamlString).join(', ')}]` : '  b: []',
        `bucket: ${yamlString(`group/${analysis.id}/${path.basename(analysis.bucket)}`)}`,
      ].filter(Boolean).join('\n') + '\n')
      groupLines.push(`  - id: ${yamlString(analysis.id)}`)
      groupLines.push(`    contrast: ${yamlString(analysis.contrast)}`)
      groupLines.push(`    model: ${yamlString(analysis.model)}`)
      groupLines.push(`    engine: ${yamlString(analysis.engine)}`)
      groupLines.push(`    correction: ${yamlString(analysis.correction ? analysis.correction.method : 'none')}`)
      groupLines.push(`    n: ${analysis.nA ?? analysis.n ?? ''}`)
      groupLines.push(`    clusters: ${(analysis.clusters || []).length}`)
      groupLines.push(`    dir: ${yamlString(`group/${analysis.id}`)}`)
    }
    writeFileSync(path.join(groupDir, 'group.yaml'), `${groupLines.join('\n')}\n`)
    writeFileSync(path.join(groupDir, 'results.csv'), csvText(allRows))
    const engineList = [...new Set(groupAnalyses.map((analysis) => analysis.engine))].join(', ')
    const correctionList = [...new Set(groupAnalyses.map((analysis) => (analysis.correction ? analysis.correction.method : 'none')))].join(', ')
    const groupMethods = `# Methods — group\n\nGroup-level analyses were run on the ${cohort.included} included subjects with ${engineList}. ` +
      `The design(s) were ${[...new Set(groupAnalyses.map((analysis) => analysis.model))].join(', ')}; ` +
      `correction: ${correctionList}. Cluster tables (voxels, peak t, p, IJK) are in \`group/results.csv\`, ` +
      `one directory per analysis holds the frozen bucket and correction record, and \`group.yaml\` lists the designs.\n`
    writeFileSync(path.join(groupDir, 'METHODS.md'), groupMethods)
    groupLint = lintMethods(groupMethods, ['Methods', 'Group'])
    if (!groupLint.ok) throw Object.assign(new Error(`group methods lint failed: ${groupLint.issues.join('; ')}`), { code: 'methods-lint' })
  }
  const cohortMethods = `# Methods — cohort\n\nThe cohort contains **${cohort.included} subjects** processed with the frozen autoproc\nscripts in \`subjects/\`. Each subject's \`subject.yaml\` records its variants, work dir,\nrun count and validation status. The cohort was validated before export: every subject\nhas a script, design spec, stimuli and a first-level statistics bucket, and all buckets\nshare one grid (${validation.ok ? 'checked' : 'not checked'} on ${validation.checkedAt}).` +
    (groupAnalyses.length ? `\n\nGroup analyses: ${groupAnalyses.length} (see \`group/METHODS.md\`).` : '\n\nNo group analysis was exported.\n')
  writeFileSync(path.join(dir, 'METHODS.md'), cohortMethods)
  const cohortLint = lintMethods(cohortMethods, ['Methods', 'Subjects'])
  if (!cohortLint.ok) throw Object.assign(new Error(`cohort methods lint failed: ${cohortLint.issues.join('; ')}`), { code: 'methods-lint' })
  const files = {}
  for (const absolute of walkFiles(dir)) {
    files[path.relative(dir, absolute)] = sha256File(absolute)
    fileCount += 1
  }
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({
    schema: 'ffs-cohort-package/1',
    createdAt: validation.checkedAt,
    workRoot: validation.root,
    subjects: cohort.subjects.map((subject) => subject.id),
    validation,
    methodsLint: { cohort: cohortLint, group: groupLint },
    lock: { path: 'lock.json', sha256: sha256File(path.join(dir, 'lock.json')) },
    groupAnalyses: groupAnalyses.map((analysis) => analysis.id),
    files,
  }, null, 2)}\n`)
  return {
    ok: true,
    dir: path.relative(PROJECT_ROOT, dir),
    zip: zipPackage(dir),
    subjects: cohort.subjects.length,
    files: fileCount + 1,
    validation,
  }
}

function runGroupAnalysis(params = {}) {
  const rootAbs = currentCohortRoot()
  const cohort = discoverCohort(rootAbs)
  const subjects = cohort.subjects.filter((subject) => subject.stats && subject.include !== false)
  if (subjects.length < 2) {
    throw Object.assign(new Error('need at least two completed subjects'), { code: 'cohort-too-small' })
  }
  const contrast = String(params.contrast || 'scenes')
  const model = params.model === 'two-group' ? 'two-group' : 'one-sample'
  const engine = model === 'two-group' ? '3dttest++' : (params.engine === '3dttest++' ? '3dttest++' : '3dMEMA')
  const correction = ['none', 'cluster', 'permutation'].includes(params.correction) ? params.correction : 'none'
  if (model === 'two-group' && engine !== '3dttest++') {
    throw Object.assign(new Error('two-group designs need the 3dttest++ engine'), { code: 'engine-unsupported' })
  }
  const picks = []
  for (const subject of subjects) {
    const statsAbs = resolveInside(subject.stats, 'stats')
    const summary = ensureResults(resolveInside(subject.workDir, 'work'), statsAbs)
    if (summary.error) throw new Error(`cannot read ${subject.id}: ${summary.error}`)
    const labels = summary.subBricks || []
    const coefIndex = labels.indexOf(`${contrast}#0_Coef`)
    const tIndex = labels.indexOf(`${contrast}#0_Tstat`)
    if (coefIndex < 0 || tIndex < 0) {
      throw Object.assign(new Error(`${contrast} not found in ${subject.id}`), { code: 'contrast-missing' })
    }
    picks.push({ subject, statsAbs, coefIndex, tIndex })
  }

  const normalizeIds = (value) => (Array.isArray(value) ? value : String(value || '').split(/[\s,]+/))
    .map((item) => String(item).trim().replace(/^sub-/, ''))
    .filter(Boolean)
  let groupA = []
  let groupB = []
  if (model === 'two-group') {
    const requested = params.groups || {}
    groupA = normalizeIds(requested.a)
    groupB = normalizeIds(requested.b)
    if (!groupA.length || !groupB.length) {
      const ids = subjects.map((subject) => subject.subject)
      groupA = ids.filter((_, index) => index % 2 === 0)
      groupB = ids.filter((_, index) => index % 2 === 1)
    }
    const available = new Set(subjects.map((subject) => subject.subject))
    groupA = groupA.filter((id) => available.has(id))
    groupB = groupB.filter((id) => available.has(id))
    const overlap = groupA.filter((id) => groupB.includes(id))
    if (overlap.length) throw Object.assign(new Error(`subject(s) in both groups: ${overlap.join(', ')}`), { code: 'group-overlap' })
    if (groupA.length < 2 || groupB.length < 2) {
      throw Object.assign(new Error('two-group designs need at least two subjects per group'), { code: 'group-too-small' })
    }
  }

  const id = model === 'two-group' ? `group-${contrast}-2grp` : `group-${contrast}`
  const workAbs = path.join(rootAbs, id)
  mkdirSync(workAbs, { recursive: true })
  const prefix = path.join(workAbs, `${id}.nii.gz`)
  const env = ffsEnv()
  const firstMean = subjects.map((subject) => subject.mean).find(Boolean)
  const master = firstMean ? resolveInside(firstMean, 'mean') : picks[0].statsAbs
  let mask = null
  if (firstMean) {
    const candidate = path.join(workAbs, 'group_mask.nii.gz')
    try {
      execFileSync('3dAutomask', ['-prefix', candidate, '-dilate', '2', master], {
        cwd: PROJECT_ROOT, env, timeout: 120000, stdio: 'pipe',
      })
      mask = candidate
    } catch { mask = null }
  }
  const resampled = picks.map((pick) => {
    const coefOut = path.join(workAbs, `${pick.subject.id}_${contrast}_coef.nii.gz`)
    const tstatOut = path.join(workAbs, `${pick.subject.id}_${contrast}_tstat.nii.gz`)
    try {
      execFileSync('3dresample', [
        '-overwrite', '-master', master,
        '-input', `${pick.statsAbs}[${pick.coefIndex}]`, '-prefix', coefOut,
      ], { cwd: PROJECT_ROOT, env, timeout: 180000, stdio: 'pipe' })
      execFileSync('3dresample', [
        '-overwrite', '-master', master,
        '-input', `${pick.statsAbs}[${pick.tIndex}]`, '-prefix', tstatOut,
      ], { cwd: PROJECT_ROOT, env, timeout: 180000, stdio: 'pipe' })
    } catch (error) {
      const stderr = error && error.stderr ? String(error.stderr) : ''
      throw Object.assign(new Error(`3dresample failed for ${pick.subject.id}: ${stderr.split('\n').filter(Boolean).slice(-2).join(' ')}`), { code: 'group-failed' })
    }
    return { ...pick, coefOut, tstatOut }
  })

  const pickFor = (subject) => resampled.find((item) => item.subject.subject === subject)
  for (const stale of [prefix, path.join(workAbs, 'correction.json')]) {
    try { unlinkSync(stale) } catch { /* absent */ }
  }
  try {
    if (engine === '3dttest++') {
      const args = ['-prefix', prefix]
      if (mask) args.push('-mask', mask)
      if (model === 'two-group') {
        args.push('-setA')
        for (const subject of groupA) args.push(pickFor(subject).coefOut)
        args.push('-setB')
        for (const subject of groupB) args.push(pickFor(subject).coefOut)
      } else {
        args.push('-setA')
        for (const pick of resampled) args.push(pick.coefOut)
      }
      execFileSync('3dttest++', args, { cwd: PROJECT_ROOT, env, timeout: 900000, stdio: 'pipe' })
    } else {
      const args = ['-prefix', prefix]
      if (mask) args.push('-mask', mask)
      args.push('-set', contrast)
      for (const pick of resampled) args.push(pick.subject.id, pick.coefOut, pick.tstatOut)
      args.push('-jobs', '2', '-model_outliers')
      execFileSync('3dMEMA', args, { cwd: PROJECT_ROOT, env, timeout: 900000, stdio: 'pipe' })
    }
  } catch (error) {
    const stderr = error && error.stderr ? String(error.stderr) : ''
    const detail = stderr.split('\n').filter(Boolean).slice(-3).join(' ') || (error && error.message) || 'unknown error'
    throw Object.assign(new Error(`${engine} failed: ${detail}`), { code: 'group-failed' })
  }

  const preliminary = ensureResults(workAbs, prefix)
  let correctionResult = null
  if (correction !== 'none') {
    const firstContrast = preliminary.contrasts && preliminary.contrasts[0]
    if (!firstContrast) {
      correctionResult = { method: correction, error: 'no t contrast in the group bucket', clusters: [] }
    } else {
      const indices = (ids) => ids.map((subject) => resampled.findIndex((item) => item.subject.subject === subject)).filter((index) => index >= 0)
      const designFile = path.join(workAbs, 'correction-design.json')
      const correctionFile = path.join(workAbs, 'correction.json')
      writeFileSync(designFile, `${JSON.stringify({
        method: correction,
        model,
        threshold: preliminary.threshold ?? 3.1,
        coefs: resampled.map((item) => item.coefOut),
        stats: prefix,
        stat_index: firstContrast.index,
        min_cluster: preliminary.minCluster ?? 10,
        groups: model === 'two-group' ? { a: indices(groupA), b: indices(groupB) } : undefined,
      }, null, 2)}\n`)
      try {
        execFileSync(pythonPath(), [
          path.join(PKG_DIR, 'scripts', 'group_permutation.py'),
          '--design', designFile, '--out', correctionFile,
        ], { env: ffsEnv(), cwd: PROJECT_ROOT, timeout: 600000, stdio: 'pipe' })
        correctionResult = JSON.parse(readFileSync(correctionFile, 'utf8'))
        if (correctionResult.clusters) correctionResult.clusters = correctionResult.clusters.slice(0, 50)
      } catch (error) {
        const stderr = error && error.stderr ? String(error.stderr) : ''
        correctionResult = { method: correction, error: stderr.split('\n').filter(Boolean).slice(-2).join(' ') || String(error && error.message), clusters: [] }
      }
    }
  }

  const record = {
    id,
    contrast,
    engine,
    design: model,
    model,
    correction,
    correctionResult,
    groups: model === 'two-group' ? { a: groupA, b: groupB } : null,
    n: model === 'two-group' ? Math.min(groupA.length, groupB.length) : picks.length,
    nA: model === 'two-group' ? groupA.length : picks.length,
    nB: model === 'two-group' ? groupB.length : null,
    at: new Date().toISOString(),
    workDir: path.relative(PROJECT_ROOT, workAbs),
    bucket: path.relative(PROJECT_ROOT, prefix),
    mask: mask ? path.relative(PROJECT_ROOT, mask) : null,
    space: 'native-common-grid',
    cohortRoot: path.relative(PROJECT_ROOT, rootAbs),
    mean: firstMean || null,
  }
  const state = readGroupState()
  const rootRel = path.relative(PROJECT_ROOT, rootAbs)
  state.analyses = state.analyses.filter((item) => !(item.id === id && groupCohortRoot(item) === rootRel)).concat(record)
  writeGroupState(state)
  return groupSummaryRecord(record)
}

// ------------------------------------------------------------------ M6: tool runner / replay
const TOOL_RUNS_FILE = path.join(PROJECT_ROOT, 'work', 'ffs-tool-runs.json')
const REPLAYS_FILE = path.join(PROJECT_ROOT, 'work', 'ffs-replays.json')
const TOOL_RUN_WHITELIST = /^(ffs_[a-z0-9_]+|3d[A-Za-z0-9_]+|python3?|Rscript|zstd)$/

function readProvenanceList(file) {
  try {
    if (!existsSync(file)) return []
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function appendProvenance(file, record) {
  const entries = readProvenanceList(file).slice(-199)
  entries.push(record)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`)
}

function resolveToolExecutable(name) {
  if (name === 'python' || name === 'python3') return pythonPath()
  if (name.startsWith('ffs_')) {
    const shim = path.join(PROJECT_ROOT, 'work', 'bin', name)
    return existsSync(shim) ? shim : null
  }
  const envPath = ffsEnv().PATH || ''
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function artifactHashes(paths) {
  if (!paths.length) return []
  try {
    const output = execFileSync(pythonPath(), [
      path.join(PKG_DIR, 'scripts', 'artifact_hash.py'),
      ...paths,
    ], { env: ffsEnv(), encoding: 'utf8', timeout: 300000 })
    return JSON.parse(output)
  } catch (error) {
    return paths.map((item) => ({ path: item, ok: false, error: String(error && error.message) }))
  }
}

function compareArtifacts(a, b, atol = 1e-2, rtol = 1e-2) {
  try {
    const output = execFileSync(pythonPath(), [
      path.join(PKG_DIR, 'scripts', 'artifact_compare.py'), a, b,
      '--atol', String(atol), '--rtol', String(rtol),
    ], { env: ffsEnv(), encoding: 'utf8', timeout: 300000 })
    return JSON.parse(output)
  } catch (error) {
    return { ok: false, error: String(error && error.message) }
  }
}

function ffsToolRun(params = {}) {
  const argv = Array.isArray(params.argv) ? params.argv.map((item) => String(item)) : []
  if (!argv.length) throw Object.assign(new Error('argv is required'), { code: 'tool-invalid' })
  if (!TOOL_RUN_WHITELIST.test(path.basename(argv[0]))) {
    throw Object.assign(new Error(`tool not allowed: ${argv[0]}`), { code: 'tool-not-allowed' })
  }
  const executable = resolveToolExecutable(path.basename(argv[0]))
  if (!executable) throw Object.assign(new Error(`tool not found: ${argv[0]}`), { code: 'tool-missing' })
  const cwd = params.cwd ? resolveInside(params.cwd, 'cwd') : (currentProjectWorkDir() || PROJECT_ROOT)
  const customEnv = {}
  if (params.env && typeof params.env === 'object') {
    for (const [key, value] of Object.entries(params.env)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw Object.assign(new Error(`env key not allowed: ${key}`), { code: 'tool-invalid' })
      customEnv[key] = String(value)
    }
  }
  const expect = Array.isArray(params.expect) ? params.expect.map((item) => String(item.path || item)) : []
  const timeout = Math.max(1000, Math.min(Number(params.timeoutMs) || 300000, 900000))
  const started = Date.now()
  let stdout = ''
  let stderr = ''
  let exitCode = 0
  try {
    stdout = execFileSync(executable, argv.slice(1), {
      cwd, env: { ...ffsEnv(), ...customEnv }, timeout, encoding: 'utf8', stdio: 'pipe',
    })
  } catch (error) {
    exitCode = typeof error.status === 'number' ? error.status : 1
    stdout = error.stdout ? String(error.stdout) : ''
    stderr = error.stderr ? String(error.stderr) : String(error.message || error)
  }
  const outputPaths = expect.map((item) => (path.isAbsolute(item) ? item : path.resolve(cwd, item)))
  const missing = outputPaths.filter((item) => !existsSync(item))
  const hashes = artifactHashes(outputPaths)
  const record = {
    id: `tool-${Date.now().toString(36)}`,
    at: new Date().toISOString(),
    argv,
    executable,
    cwd: path.relative(PROJECT_ROOT, cwd),
    env: customEnv,
    timeoutMs: timeout,
    exitCode,
    durationMs: Date.now() - started,
    outputs: hashes,
    missing,
    ok: exitCode === 0 && missing.length === 0,
  }
  appendProvenance(TOOL_RUNS_FILE, record)
  return {
    ...record,
    stdout: cleanLogText(stdout).split('\n').slice(-40).join('\n'),
    stderr: cleanLogText(stderr).split('\n').slice(-20).join('\n'),
  }
}

function ffsReplay(params = {}) {
  const settled = readSettled()
  const state = readProjectState()
  const sourceWork = params.workDir
    ? resolveInside(params.workDir, 'workDir')
    : resolveInside((settled && settled.project && settled.project.workDir) || (state && state.workDir) || '', 'workDir')
  if (!existsSync(sourceWork)) throw Object.assign(new Error('no work dir to replay'), { code: 'not-planned' })
  let scriptAbs
  if (params.script) {
    scriptAbs = resolveInside(params.script, 'script')
  } else {
    const localScript = readdirSync(sourceWork).find((name) => /^proc_sub-.*\.sh$/.test(name))
    if (localScript) {
      scriptAbs = path.join(sourceWork, localScript)
    } else {
      const fromSettled = settled && settled.project && settled.project.script
      const fromState = state && state.script
      scriptAbs = resolveInside(fromSettled || fromState || '', 'script')
    }
  }
  if (!existsSync(scriptAbs)) throw Object.assign(new Error('frozen script missing'), { code: 'replay-no-script' })
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  const dest = path.join(PROJECT_ROOT, 'work', `replay-${stamp}`)
  mkdirSync(dest, { recursive: true })
  const scriptName = path.basename(scriptAbs)
  const text = readFileSync(scriptAbs, 'utf8').replace(/^OUT=.*$/m, 'OUT="$(cd "$(dirname "$0")" && pwd)"')
  writeFileSync(path.join(dest, scriptName), text)
  for (const name of readdirSync(sourceWork).filter((item) => /^stage11\.design\..*\.toml$/.test(item))) {
    copyFileSync(path.join(sourceWork, name), path.join(dest, name))
  }
  if (existsSync(path.join(sourceWork, 'stimuli'))) copyTree(path.join(sourceWork, 'stimuli'), path.join(dest, 'stimuli'))
  const statsName = params.artifact && !params.artifact.includes('/')
    ? params.artifact
    : readdirSync(sourceWork).find((name) => /^stage12\.stats-reml\..*\.nii\.gz$/.test(name) && !/ffsremlvar/.test(name))
  if (!statsName) throw Object.assign(new Error('no stats artifact to compare'), { code: 'replay-no-artifact' })
  const started = Date.now()
  let log = ''
  let exitCode = 0
  try {
    execFileSync('bash', [path.join(dest, scriptName)], {
      cwd: dest, env: ffsEnv(), timeout: 900000, encoding: 'utf8', stdio: 'pipe',
    })
  } catch (error) {
    exitCode = typeof error.status === 'number' ? error.status : 1
    log = `${error.stdout || ''}${error.stderr || ''}${error.message || ''}`
  }
  writeFileSync(path.join(dest, 'replay.log'), cleanLogText(log).split('\n').slice(-80).join('\n') + '\n')
  const replayArtifact = path.join(dest, statsName)
  const [original, replay] = artifactHashes([path.join(sourceWork, statsName), replayArtifact])
  const comparison = compareArtifacts(path.join(sourceWork, statsName), replayArtifact)
  const exact = Boolean(comparison.ok && comparison.exact)
  const toleranceMatch = Boolean(comparison.ok && comparison.toleranceMatch)
  const match = Boolean(exact || toleranceMatch)
  const record = {
    id: `replay-${stamp}`,
    at: new Date().toISOString(),
    sourceWork: path.relative(PROJECT_ROOT, sourceWork),
    dest: path.relative(PROJECT_ROOT, dest),
    script: path.relative(PROJECT_ROOT, scriptAbs),
    artifact: path.relative(PROJECT_ROOT, path.join(sourceWork, statsName)),
    exitCode,
    durationMs: Date.now() - started,
    match,
    exact,
    toleranceMatch,
    comparison,
    original,
    replay,
    logTail: cleanLogText(log).split('\n').filter(Boolean).slice(-8),
  }
  appendProvenance(REPLAYS_FILE, record)
  return { ok: exitCode === 0 && match, exitCode, match, exact, toleranceMatch, ...record }
}

function verifyPackage(params = {}) {
  const dirRel = params.dir ? String(params.dir) : ''
  const dir = resolveInside(dirRel, 'package')
  if (!existsSync(dir) || !existsSync(path.join(dir, 'checksums.sha256'))) {
    throw Object.assign(new Error('not an exported package (checksums.sha256 missing)'), { code: 'verify-invalid' })
  }
  const lines = readFileSync(path.join(dir, 'checksums.sha256'), 'utf8').split('\n').filter(Boolean)
  const mismatches = []
  for (const line of lines) {
    const match = /^([0-9a-f]{64})\s+(.+)$/.exec(line)
    if (!match) continue
    const [, expected, rel] = match
    const absolute = path.join(dir, rel)
    const actual = sha256File(absolute)
    if (!actual || actual !== expected) mismatches.push({ path: rel, expected, actual })
  }
  let replay = null
  if (params.replay) {
    try {
      const output = execFileSync('bash', [path.join(dir, 'verify.sh'), '--replay'], {
        env: ffsEnv(), cwd: dir, encoding: 'utf8', timeout: 3600000,
      })
      replay = { ok: true, tail: output.split('\n').filter(Boolean).slice(-6) }
    } catch (error) {
      replay = { ok: false, error: String(error && error.message), tail: String(error && error.stdout || '').split('\n').filter(Boolean).slice(-6) }
    }
  }
  return {
    ok: mismatches.length === 0 && (!replay || replay.ok),
    dir: path.relative(PROJECT_ROOT, dir),
    checked: lines.length,
    mismatches,
    replay,
  }
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
        device: { type: 'string', enum: ['auto', 'cpu', 'mps', 'cuda'], description: 'Compute device for the run (default auto).' },
        anat: { type: 'string', description: 'Explicit anatomical image (project-relative).' },
        fsSubject: { type: 'string', description: 'FreeSurfer subject directory (surf/…; enables surface sampling).' },
        surfaceTarget: { type: 'array', items: { type: 'string' }, description: 'native or FreeSurfer-format target mesh path/name.' },
        surfaceGlm: { type: 'boolean', description: 'Fit the GLM on every surface target (stage12s).' },
        surfaceQc: { type: 'boolean', description: 'Write surface QC maps.' },
        surfaceBlur: { type: 'number', description: 'Surface GLM smoothing FWHM (mm).' },
        refFile: { type: 'string', description: 'AFNI/ANTs reference EPI image for interop.' },
        refTransforms: { type: 'array', items: { type: 'string' }, description: 'Reference-to-anat matrices/warps in nwarp order.' },
        refFileAnat: { type: 'string', description: 'Anat that -ref_file transforms land in.' },
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
    name: 'ffs_analysis_resume',
    description: 'Resume an interrupted/stopped analysis run: existing stage outputs are skipped.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute() {
      return JSON.stringify(startRun(), null, 1)
    },
  }), 'ffs-analysis: resume tool')

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
    name: 'ffs_cohort',
    description: [
      'List or validate the cohort beside the current subject work dir: per-subject stats,',
      'design/stimuli presence and grid agreement (missing-output and grid-mismatch fail',
      'clearly). Defaults to validation of the current dataset cohort.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'validate', 'export', 'include'], description: 'list, validate (default), export, or set include/exclude.' },
        subject: { type: 'string', description: 'Subject id for action=include.' },
        include: { type: 'boolean', description: 'Include (true) or exclude (false) the subject.' },
        workRoot: { type: 'string', description: 'Cohort work root, project-relative (default: current dataset).' },
      },
      required: [],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute(args) {
      const workRoot = args?.workRoot ? resolveInside(args.workRoot, 'workRoot') : currentCohortRoot()
      if (args?.action === 'include') {
        const subject = String(args.subject || '').replace(/^sub-/, '')
        if (!subject) throw new Error('subject is required for include')
        const rootRel = path.relative(PROJECT_ROOT, workRoot)
        const prefs = readCohortPrefs()
        prefs[rootRel] = prefs[rootRel] || {}
        prefs[rootRel][subject] = Boolean(args.include)
        writeCohortPrefs(prefs)
        const cohort = discoverCohort(workRoot)
        return JSON.stringify({ ok: true, cohort, validation: validateCohort(workRoot) }, null, 1)
      }
      if (args?.action === 'export') {
        return JSON.stringify(exportCohortPackage({ workRoot: path.relative(PROJECT_ROOT, workRoot) }), null, 1)
      }
      const cohort = discoverCohort(workRoot)
      if (args?.action === 'list') return JSON.stringify({ ok: true, cohort }, null, 1)
      const validation = validateCohort(workRoot)
      return JSON.stringify({ ok: validation.ok, cohort, validation }, null, 1)
    },
  }), 'ffs-analysis: cohort tool')

  ctx.effect(() => ctx.tools.register({
    name: 'ffs_project_scan',
    description: [
      'Scan a BIDS root and the FFS environment: subjects, sessions, runs, events, T1w and',
      'fieldmaps, plus doctor checks (python, fastfuncstuff import, command shims, zstd,',
      'AFNI/R, MPLCONFIGDIR, disk). Defaults to the BIDS-lite fixture.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        bidsDir: { type: 'string', description: 'BIDS root, project-relative (default data/bids-lite).' },
      },
      required: [],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute(args) {
      const bids = scanBids(args || {})
      const doctor = doctorChecks()
      return JSON.stringify({ ok: true, bids, doctor }, null, 1)
    },
  }), 'ffs-analysis: scan tool')

  ctx.effect(() => ctx.tools.register({
    name: 'ffs_analysis_results',
    description: [
      'Recompute the first-level results table with a different cluster-forming threshold or',
      'minimum cluster size, persist the view in the project state and return the summary.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        threshold: { type: 'number', description: 'Cluster-forming |t| threshold (0.5–20, default 3.1).' },
        minCluster: { type: 'number', description: 'Minimum cluster size in voxels (default 10).' },
      },
      required: [],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute(args) {
      const value = setResultsView(args || {})
      return JSON.stringify({
        ok: true,
        threshold: value.threshold,
        minCluster: value.minCluster,
        contrasts: (value.summary.contrasts || []).length,
        clusters: (value.summary.contrasts || []).reduce((total, contrast) => total + (contrast.clusters || []).length, 0),
      }, null, 1)
    },
  }), 'ffs-analysis: results tool')

  ctx.effect(() => ctx.tools.register({
    name: 'ffs_tool_run',
    description: [
      'Run one validated FFS/AFNI command as an argv array (never a shell line), inside the',
      'workspace, with recorded provenance and hashes of expected outputs. Allowed tools:',
      'ffs_*, 3d*, python, Rscript, zstd. Use as the escape hatch for bespoke CLI steps.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        argv: { type: 'array', items: { type: 'string' }, description: 'Executable and arguments, no shell.' },
        cwd: { type: 'string', description: 'Working directory, project-relative (default: current work dir).' },
        env: { type: 'object', description: 'Extra uppercase environment variables.' },
        timeoutMs: { type: 'number', description: 'Timeout in ms (1s–15min, default 5min).' },
        expect: {
          type: 'array',
          description: 'Outputs that must exist after the call; hashed into provenance.',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, kind: { type: 'string' } },
            required: ['path'],
          },
        },
      },
      required: ['argv'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute(args) { return JSON.stringify(ffsToolRun(args || {}), null, 1) },
  }), 'ffs-analysis: tool runner')

  ctx.effect(() => ctx.tools.register({
    name: 'ffs_replay',
    description: [
      'Replay a frozen analysis pipeline in a fresh work dir and compare one artifact by',
      'canonical hash (NIfTI: shape+affine+voxel data). Returns match, hashes and the log tail.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        workDir: { type: 'string', description: 'Source work dir (default: settled/current analysis).' },
        script: { type: 'string', description: 'Frozen script (default: the settled/current script).' },
        artifact: { type: 'string', description: 'Artifact to compare (basename; default: stage12 stats bucket).' },
        timeoutMs: { type: 'number', description: 'Timeout in ms (default 15min).' },
      },
      required: [],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute(args) { return JSON.stringify(ffsReplay(args || {}), null, 1) },
  }), 'ffs-analysis: replay tool')

  const groupParameters = {
    type: 'object',
    properties: {
      contrast: { type: 'string', description: 'First-level contrast name without suffixes (default "scenes").' },
      model: { type: 'string', enum: ['one-sample', 'two-group'], description: 'Group design (default one-sample).' },
      engine: { type: 'string', enum: ['3dMEMA', '3dttest++'], description: 'Engine; two-group forces 3dttest++.' },
      correction: { type: 'string', enum: ['none', 'cluster', 'permutation'], description: 'Cluster-size or permutation correction (default none).' },
      groups: {
        type: 'object',
        description: 'Two-group assignment: {a: [subject ids], b: [subject ids]}; defaults to alternating subjects.',
        properties: {
          a: { type: 'array', items: { type: 'string' } },
          b: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    required: [],
  }
  const runGroupTool = (args) => {
    const record = runGroupAnalysis(args || {})
    return JSON.stringify({
      ok: true,
      id: record.id,
      contrast: record.contrast,
      model: record.model,
      engine: record.engine,
      correction: record.correction,
      correctionClusters: record.correctionResult ? (record.correctionResult.clusters || []).length : 0,
      correctionError: record.correctionResult && record.correctionResult.error ? record.correctionResult.error : null,
      n: record.n,
      clusters: record.clusters.length,
      status: record.status,
    }, null, 1)
  }
  ctx.effect(() => ctx.tools.register({
    name: 'ffs_analysis_group',
    description: [
      'Run a group analysis across the active cohort: one-sample 3dMEMA (Coef+Tstat pairs) or',
      'two-group 3dttest++ (group A vs B on subject Coef maps), optionally with cluster-size or',
      'permutation correction. Requires at least two subjects (two per group for two-group).',
    ].join('\n'),
    parameters: groupParameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute(args) { return runGroupTool(args) },
  }), 'ffs-analysis: group tool')

  ctx.effect(() => ctx.tools.register({
    name: 'ffs_group',
    description: [
      'Alias of ffs_analysis_group: one-sample 3dMEMA or two-group 3dttest++ over the active',
      'cohort, with optional cluster/permutation correction.',
    ].join('\n'),
    parameters: groupParameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute(args) { return runGroupTool(args) },
  }), 'ffs-analysis: ffs_group alias')

  ctx.effect(() => ctx.tools.register({
    name: 'ffs_analysis_verify',
    description: [
      'Verify an exported package: check every checksum, and optionally rerun the frozen',
      'pipeline (verify.sh --replay) and compare the stats bucket numerically.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Package directory, project-relative (e.g. exports/...).' },
        replay: { type: 'boolean', description: 'Also rerun the frozen pipeline (slow).' },
      },
      required: ['dir'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute(args) { return JSON.stringify(verifyPackage(args || {}), null, 1) },
  }), 'ffs-analysis: verify tool')

  ctx.effect(() => ctx.tools.register({
    name: 'ffs_analysis_settle',
    description: [
      'Freeze the completed analysis into a settled record: plan, run times, artifacts with',
      'hashes, result summary and software versions. Required before export.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute() {
      const settled = settleProject()
      return JSON.stringify({ ok: true, id: settled.id, at: settled.at }, null, 1)
    },
  }), 'ffs-analysis: settle tool')

  ctx.effect(() => ctx.tools.register({
    name: 'ffs_analysis_export',
    description: [
      'Build the reproducible analysis package from the settled analysis: frozen script,',
      'design, stimuli, run/doctor/env scripts, STEPS.md, METHODS.md, methods.yaml, citations,',
      'CSV tables, manifest and checksums. Writes under exports/.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute() {
      return JSON.stringify(exportPackage(), null, 1)
    },
  }), 'ffs-analysis: export tool')

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

      if (rel === 'results') {
        try {
          const body = req.method === 'POST' ? await readJsonBody(req) : {}
          writeJson(res, 200, { ok: true, ...setResultsView(body) })
        } catch (error) {
          routeError(res, error)
        }
        return
      }

      if (rel === 'cohort') {
        try {
          const body = req.method === 'POST' ? await readJsonBody(req) : {}
          const workRoot = body.workRoot ? resolveInside(body.workRoot, 'workRoot') : currentCohortRoot()
          if (body.action === 'include') {
            const subject = String(body.subject || '').replace(/^sub-/, '')
            if (!subject) throw Object.assign(new Error('subject is required'), { code: 'cohort-invalid' })
            const rootRel = path.relative(PROJECT_ROOT, workRoot)
            const prefs = readCohortPrefs()
            prefs[rootRel] = prefs[rootRel] || {}
            prefs[rootRel][subject] = Boolean(body.include)
            writeCohortPrefs(prefs)
          }
          if (body.action === 'export') {
            writeJson(res, 200, { ok: true, ...exportCohortPackage({ workRoot: path.relative(PROJECT_ROOT, workRoot) }) })
            return
          }
          writeJson(res, 200, {
            ok: true,
            cohort: discoverCohort(workRoot),
            validation: validateCohort(workRoot),
          })
        } catch (error) {
          routeError(res, error)
        }
        return
      }

      if (rel === 'verify') {
        try {
          const body = req.method === 'POST' ? await readJsonBody(req) : {}
          writeJson(res, 200, { ok: true, ...verifyPackage(body) })
        } catch (error) {
          routeError(res, error)
        }
        return
      }

      if (rel === 'tool-run') {
        try {
          const body = req.method === 'POST' ? await readJsonBody(req) : {}
          writeJson(res, 200, { ok: true, ...ffsToolRun(body) })
        } catch (error) {
          routeError(res, error)
        }
        return
      }

      if (rel === 'replay') {
        try {
          const body = req.method === 'POST' ? await readJsonBody(req) : {}
          writeJson(res, 200, { ok: true, ...ffsReplay(body) })
        } catch (error) {
          routeError(res, error)
        }
        return
      }

      if (rel === 'scan') {
        try {
          const body = req.method === 'POST' ? await readJsonBody(req) : {}
          writeJson(res, 200, { ok: true, bids: scanBids(body), doctor: doctorChecks() })
        } catch (error) {
          routeError(res, error)
        }
        return
      }

      if (rel === 'group') {
        if (req.method !== 'POST') {
          writeText(res, 405, 'method not allowed')
          return
        }
        try {
          const body = await readJsonBody(req)
          writeJson(res, 200, { ok: true, ...runGroupAnalysis(body) })
        } catch (error) {
          routeError(res, error)
        }
        return
      }

      if (rel === 'settle' || rel === 'export') {
        if (req.method !== 'POST') {
          writeText(res, 405, 'method not allowed')
          return
        }
        try {
          writeJson(res, 200, rel === 'settle'
            ? { ok: true, ...settleProject() }
            : exportPackage())
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

  ctx.inject(['jobs'], (jobsCtx) => {
    try {
      JOB_SERVICE = jobsCtx.jobs
      JOBS_CONTROLLER = jobsCtx.jobs.attachController('ffs-analysis')
    } catch (error) {
      console.warn('[ffs-analysis] jobs service not attached:', error?.message || error)
    }
    jobsCtx.effect(() => () => {
      try { JOBS_CONTROLLER?.() } catch { /* already disposed */ }
      JOBS_CONTROLLER = null
      JOB_SERVICE = null
      ACTIVE_JOB = null
    }, 'ffs-analysis: jobs lifecycle')
  })
}
