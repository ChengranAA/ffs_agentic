/**
 * FFS analysis — Host half.
 *
 * UI prototype for the analysis inspection tab. It serves one snapshot projection
 * (`/ffs-analysis/snapshot`) and the fixture images (`/ffs-analysis/asset/<name>`) from
 * `./fixtures/`, plus one agent tool for diagnostics. There is no compute here yet: the
 * snapshot is a fixture built from the real ds005165 run documented in
 * `../docs/REAL_DATA_TEST.md`.
 *
 * All requests are gated with `connection.admit(req)` (host/origin fence + browser
 * cookie), the same authenticated-route pattern the FFS viewer uses.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
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

/** Resolve fixture-relative artifact paths against the project root. */
function resolveSnapshot(raw) {
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
    rev: statSync(FIXTURE_FILE).mtimeMs,
    showSeq,
    projectRoot: PROJECT_ROOT,
    assets: { base: `${ROUTE}/asset/` },
    artifacts,
  }
}

function readSnapshot() {
  return resolveSnapshot(JSON.parse(readFileSync(FIXTURE_FILE, 'utf8')))
}

function snapshotSummary() {
  const snapshot = readSnapshot()
  return {
    project: snapshot.project?.name ?? null,
    dataset: snapshot.project?.dataset ?? null,
    subject: snapshot.project?.subject ?? null,
    pipeline: {
      status: snapshot.pipeline?.status ?? null,
      recipe: snapshot.pipeline?.recipe ?? null,
      stages: Array.isArray(snapshot.pipeline?.stages) ? snapshot.pipeline.stages.length : 0,
    },
    artifacts: snapshot.artifacts.length,
    cohort: Array.isArray(snapshot.cohort?.subjects) ? snapshot.cohort.subjects.length : 0,
    groupAnalyses: Array.isArray(snapshot.group?.analyses) ? snapshot.group.analyses.length : 0,
    fixture: FIXTURE_FILE,
  }
}

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

export function apply(ctx) {
  // One agent tool: lets the agent (and a verification step) confirm the tab's data source.
  ctx.effect(() => ctx.tools.register({
    name: 'ffs_analysis_snapshot',
    description: [
      'Read the FFS analysis inspection tab snapshot (UI prototype). Returns the project,',
      'pipeline status, artifact count, cohort size and group analysis count served by the',
      'analysis Host half. It does not run any computation.',
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

  // Fixture HTTP route. `connection.rpc.handle()` is unusable in this profile (see the
  // viewer's docs/API.md), so register the authenticated envelope route directly.
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
      const asset = /^asset\/([A-Za-z0-9._-]+)$/.exec(rel)
      if (asset) {
        const name = asset[1]
        const file = path.join(FIXTURE_DIR, name)
        if (name.includes('..') || !file.startsWith(`${FIXTURE_DIR}${path.sep}`)) {
          writeText(res, 404, 'asset not found')
          return
        }
        if (!existsSync(file)) {
          writeText(res, 404, 'asset not found')
          return
        }
        try {
          const body = readFileSync(file)
          res.writeHead(200, {
            'content-type': CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'cache-control': 'no-store',
            'content-length': body.length,
          })
          res.end(body)
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
