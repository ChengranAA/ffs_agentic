/**
 * FFS analysis — Host half.
 *
 * Serves the analysis tab's snapshot projection, fixture assets, and the first live action:
 * `POST /ffs-analysis/plan` runs `ffs_autoproc` **without execution** for a BIDS dataset and
 * records the generated plan in `work/ffs-analysis-project.json`. Once a plan exists the
 * snapshot is built from that real script/log/work dir; otherwise the rich fixture from the
 * ds005165 run is served.
 *
 * All requests are gated with `connection.admit(req)` (host/origin fence + browser cookie),
 * the same authenticated-route pattern the FFS viewer uses. File paths are validated to stay
 * inside the project root.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'ffs-analysis'

/** The agent tool set is mandatory; the HTTP route mounts only when Host services exist. */
export const inject = ['tools']

const PKG_DIR = path.dirname(realpathSync(fileURLToPath(import.meta.url)))
const FIXTURE_DIR = path.join(PKG_DIR, 'fixtures')
const FIXTURE_FILE = path.join(FIXTURE_DIR, 'demo.json')
const ROUTE = '/ffs-analysis'

const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

const RECIPES = ['bare_bones', 'simple', 'simple_linear', 'simple_nonlin', 'complete', 'extreme']

/** Defaults for the plan action: the real ds005165 subset already downloaded for the test. */
const PLAN_DEFAULTS = {
  bidsDir: 'data/real/ds005165',
  subject: '01',
  session: '01',
  task: 'localizer',
  recipe: 'bare_bones',
  noQc: true,
  workDir: 'work/ds005165/sub-01',
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

function resolveInside(rel, label = 'path') {
  const abs = path.resolve(PROJECT_ROOT, String(rel || ''))
  if (abs !== PROJECT_ROOT && !abs.startsWith(`${PROJECT_ROOT}${path.sep}`)) {
    throw new Error(`${label} is outside the project: ${rel}`)
  }
  return abs
}

// ------------------------------------------------------------------ live snapshot
const STAGE_RE = /echo '== (stage[0-9a-z]+):\s*(.*?)\s*=='/gm

function parseStages(scriptText) {
  const seen = new Map()
  let match
  while ((match = STAGE_RE.exec(scriptText))) {
    if (!seen.has(match[1])) {
      seen.set(match[1], {
        name: match[1],
        label: match[2].replace(/\s+/g, ' ').trim(),
      })
    }
  }
  return [...seen.values()]
}

function parseLog(logText) {
  const done = new Set()
  let totalSeconds = null
  let finished = false
  const stageRe = /^== (stage[0-9a-z]+):/gm
  let match
  while ((match = stageRe.exec(logText))) done.add(match[1])
  const fin = /finished after (\d+):(\d+) \((\d+)s\)/.exec(logText)
  if (fin) {
    finished = true
    totalSeconds = Number(fin[3])
  } else if (/ffs_autoproc: FAILED/.test(logText)) {
    finished = false
  }
  return { done, totalSeconds, finished }
}

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
  for (const entry of readdirSync(workAbs, { withFileTypes: true })) {
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
  return readdirSync(qcDir)
    .filter((name) => /\.(png|jpe?g)$/i.test(name))
    .slice(0, 6)
    .map((name) => ({
      id: `qc.${name}`,
      label: name.replace(/\.(png|jpe?g)$/i, ''),
      caption: 'FFS QC (CPU)',
      asset: `qc/${name}`,
    }))
}

function tailLines(text, count) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  return lines.slice(-count)
}

function buildLiveSnapshot(state) {
  const workAbs = resolveInside(state.workDir, 'work dir')
  const scriptAbs = resolveInside(state.script, 'script')
  const logAbs = state.log ? resolveInside(state.log, 'log') : scriptAbs.replace(/\.sh$/, '.log')
  const scriptText = existsSync(scriptAbs) ? readFileSync(scriptAbs, 'utf8') : ''
  const logText = existsSync(logAbs) ? readFileSync(logAbs, 'utf8') : ''
  const scriptMtime = existsSync(scriptAbs) ? statSync(scriptAbs).mtimeMs : 0
  const logMtime = existsSync(logAbs) ? statSync(logAbs).mtimeMs : 0
  // A regenerated script makes an older log stale: the plan is not a run.
  const logFresh = logMtime > 0 && logMtime >= scriptMtime
  const logInfo = logFresh ? parseLog(logText) : { done: new Set(), totalSeconds: null, finished: false }
  const parsedStages = parseStages(scriptText)
  // The GLM stage is a commented block in the emitted script, not an `echo '== stage12'`
  // banner, so detect it from the section marker.
  if (!parsedStages.some((stage) => stage.name === 'stage12') && /stage12:\s*GLM/.test(scriptText)) {
    parsedStages.push({ name: 'stage12', label: 'GLM (ffs_reml)' })
  }
  const stages = parsedStages.map((stage) => ({
    ...stage,
    status: logInfo.done.has(stage.name) ? 'done' : 'pending',
  }))
  const artifacts = existsSync(workAbs) ? listArtifacts(workAbs) : []
  const figures = existsSync(workAbs) ? listQcFigures(workAbs) : []
  const pipelineStatus = !stages.length ? 'empty' : logInfo.finished ? 'completed' : 'planned'
  const subjectId = `sub-${state.params.subject}`
  const analyzed = logInfo.finished

  return {
    schema: 'ffs-analysis-live/1',
    source: 'live',
    note: logFresh
      ? 'Live project state, built from the generated script, its log and the work directory.'
      : 'Planned from BIDS: the flow is the new plan. The work directory may still contain outputs from an earlier run until M2 executes this plan.',
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
      status: pipelineStatus,
      recipe: state.params.recipe,
      elapsedSeconds: logInfo.totalSeconds ?? null,
      finishedAt: analyzed ? state.plannedAt : null,
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
      stages,
      logExcerpt: logFresh ? tailLines(logText, 10) : [],
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
      model: artifacts.some((artifact) => artifact.kind === 'stats') ? 'GLM bucket present' : '—',
      voxelsInMask: null,
      meanR2: null,
      subBricks: null,
      contrasts: [],
      clusters: [],
      clusterNote: artifacts.some((artifact) => artifact.kind === 'stats')
        ? 'A GLM bucket exists in the work directory; contrast and cluster inspection lands with M3.'
        : 'No GLM yet. Plan the pipeline, then run it (M2) to produce a stats bucket.',
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
          stage02: logInfo.done.has('stage02') ? 'done' : 'pending',
          stage10: logInfo.done.has('stage10') ? 'done' : 'pending',
          firstLevel: logInfo.done.has('stage12') ? 'done' : 'pending',
          qc: figures.length ? 'done' : 'pending',
        },
        variants: [state.params.recipe],
        note: pipelineStatus,
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
    },
    artifacts: snapshot.artifacts?.length ?? 0,
    cohort: Array.isArray(snapshot.cohort?.subjects) ? snapshot.cohort.subjects.length : 0,
    groupAnalyses: Array.isArray(snapshot.group?.analyses) ? snapshot.group.analyses.length : 0,
    fixture: FIXTURE_FILE,
    state: PROJECT_STATE_FILE,
  }
}

// ------------------------------------------------------------------ plan action
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

function runPlan(overrides = {}) {
  let params
  let paths
  try {
    params = planParams(overrides)
    paths = autoprocArgs(params)
  } catch (error) {
    return Promise.reject(error)
  }
  const python = process.env.FFS_PYTHON || path.join(PROJECT_ROOT, '.venv', 'bin', 'python')
  const env = {
    ...process.env,
    PYTHONPATH: [
      path.join(PROJECT_ROOT, 'python'),
      path.join(PROJECT_ROOT, 'reference', 'fastfuncstuff'),
      process.env.PYTHONPATH || '',
    ].filter(Boolean).join(path.delimiter),
    PYTHONUNBUFFERED: '1',
  }
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(python, paths.args, { cwd: PROJECT_ROOT, env })
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
          showSeq,
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

function serveFile(res, file, headers = { 'cache-control': 'no-store' }) {
  if (!existsSync(file)) {
    writeText(res, 404, 'not found')
    return
  }
  const body = readFileSync(file)
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': body.length,
    ...headers,
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

export function apply(ctx) {
  // One agent tool: lets the agent (and a verification step) confirm the tab's data source.
  ctx.effect(() => ctx.tools.register({
    name: 'ffs_analysis_snapshot',
    description: [
      'Read the FFS analysis inspection tab snapshot. Returns the source (fixture or the live',
      'project plan), project, pipeline status, artifact count, cohort size and group count.',
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

  // Generate an autoproc plan (script only, no execution).
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
      const summary = await runPlan(args || {})
      return JSON.stringify(summary, null, 1)
    },
  }), 'ffs-analysis: plan tool')

  // Reveal the tab: bump showSeq; the Client half polls and calls openTab.
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

  // Fixture + live HTTP routes. `connection.rpc.handle()` is unusable in this profile (see
  // the viewer's docs/API.md), so register the authenticated envelope route directly.
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
          const summary = await runPlan(body)
          writeJson(res, 200, summary)
        } catch (error) {
          writeJson(res, 500, { ok: false, error: { code: error?.code || 'plan-failed', message: error?.message || String(error) } })
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
