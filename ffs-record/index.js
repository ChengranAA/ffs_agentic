/**
 * FFS record — Host half (R0).
 *
 * The append-only ledger lives in `work/ffs-record/` (see shared/record/store.js). This
 * plugin owns reading it: two agent tools and an authenticated route. Writing stays with the
 * producers — the analysis plugin appends attempt events as runs happen.
 *
 * R0 scope: attempt ledger, actors, query/rebuild, legacy import. Decisions, inspection
 * sessions and preferences are later slices (docs/RECORD.md).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  foldRuns,
  migrateLegacy,
  queryDecisions,
  queryRuns,
  readFamily,
  rebuildIndex,
  recordStats,
} from '../shared/record/store.js'
import {
  preferenceSummary,
  readPreferenceProfile,
} from '../shared/record/preferences.js'
import {
  inspectionSummary,
  readInspectionSession,
  readInspectionSessions,
} from '../shared/record/inspection.js'

export const name = 'ffs-record'
export const inject = ['tools']

const PKG_DIR = path.dirname(realpathSync(fileURLToPath(import.meta.url)))
const ROUTE = '/ffs-record'

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
const VIEWER_STATE_DIR = process.env.FFS_VIEWER_STATE_DIR || path.join(PROJECT_ROOT, '.ffs-viewer')

function pythonPath() {
  return process.env.FFS_PYTHON || path.join(PROJECT_ROOT, '.venv', 'bin', 'python')
}

function preferenceEnv() {
  const env = { ...process.env }
  const roots = [path.join(PROJECT_ROOT, 'python'), path.join(PROJECT_ROOT, 'reference', 'fastfuncstuff')]
  env.PYTHONPATH = [...roots, env.PYTHONPATH].filter(Boolean).join(path.delimiter)
  return env
}

/** Record one lifecycle event through the deterministic CLI (the CLI re-checks authority). */
function preferenceAction(body = {}) {
  const action = String(body.action || '')
  if (!['establish', 'retire', 'edit', 'delete', 'request', 'confirm'].includes(action)) {
    throw Object.assign(new Error(`unknown preference action: ${action || '(empty)'}`), { code: 'preference-action-invalid' })
  }
  const preferenceId = String(body.preferenceId || body.id || '')
  if (!/^pref-[a-z0-9-]+$/i.test(preferenceId)) {
    throw Object.assign(new Error('preferenceId is required'), { code: 'preference-invalid' })
  }
  const actor = body.actor === 'agent' ? 'agent' : 'user'
  if (actor === 'agent' && action !== 'request') {
    throw Object.assign(new Error('agents may only request preference confirmation'), { code: 'preference-user-only' })
  }
  const args = [
    '-m', 'ffsrecord.cli', 'preference', '--project', PROJECT_ROOT,
    '--action', action, '--id', preferenceId, '--actor', actor, '--json',
  ]
  if (body.reason) args.push('--reason', String(body.reason))
  if (body.payload && typeof body.payload === 'object') args.push('--payload', JSON.stringify(body.payload))
  let stdout
  try {
    stdout = execFileSync(pythonPath(), args, {
      cwd: PROJECT_ROOT, env: preferenceEnv(), encoding: 'utf8', timeout: 60000,
    })
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error).split('\n').filter(Boolean).slice(-2).join(' | ')
    const code = /preference-user-only/.test(detail) ? 'preference-user-only'
      : /preference-not-found/.test(detail) ? 'preference-not-found'
        : 'preference-failed'
    throw Object.assign(new Error(detail || 'preference action failed'), { code })
  }
  const parsed = JSON.parse(stdout)
  return { ok: true, ...parsed, summary: preferenceSummary(PROJECT_ROOT) }
}

/** Read the authoritative project policy (constraints/standards/thresholds). */
function readPolicy() {
  try {
    const stdout = execFileSync(pythonPath(), [
      '-m', 'ffsrecord.cli', 'policy', '--project', PROJECT_ROOT, '--json',
    ], { cwd: PROJECT_ROOT, env: preferenceEnv(), encoding: 'utf8', timeout: 30000 })
    return JSON.parse(stdout)
  } catch (error) {
    return { error: String(error?.message || error).split('\n')[0] }
  }
}

/** Write the project policy through the deterministic CLI (user-only authoring). */
function writePolicy(policy) {
  if (!policy || typeof policy !== 'object') {
    throw Object.assign(new Error('policy must be an object'), { code: 'policy-invalid' })
  }
  let stdout
  try {
    stdout = execFileSync(pythonPath(), [
      '-m', 'ffsrecord.cli', 'policy', '--project', PROJECT_ROOT, '--json', '--set', JSON.stringify(policy),
    ], { cwd: PROJECT_ROOT, env: preferenceEnv(), encoding: 'utf8', timeout: 30000 })
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error).split('\n').filter(Boolean).slice(-2).join(' | ')
    throw Object.assign(new Error(detail || 'policy write failed'), { code: 'policy-invalid' })
  }
  return JSON.parse(stdout)
}

/** R4 deletion: evidence shards/tombstones via CLI; raw inspection files are queued for the
 * sidecar (it is the sole writer there). */
function preferenceDelete(body = {}) {
  const scope = body.scope && typeof body.scope === 'object' ? body.scope : null
  if (!scope) {
    throw Object.assign(new Error('deletion needs a scope: sessionId, preferenceId, before or project'), { code: 'preference-delete-invalid' })
  }
  if (body.actor === 'agent' && !body.dryRun) {
    throw Object.assign(new Error('deletion is a user-only action; agents may only dry-run'), { code: 'preference-user-only' })
  }
  const mode = body.mode === 'preference' ? 'preference' : 'evidence'
  const args = [
    '-m', 'ffsrecord.cli', 'delete', '--project', PROJECT_ROOT,
    '--state-dir', VIEWER_STATE_DIR, '--scope', JSON.stringify(scope), '--mode', mode, '--json',
  ]
  if (body.dryRun) args.push('--dry-run')
  if (body.reason) args.push('--reason', String(body.reason))
  let stdout
  try {
    stdout = execFileSync(pythonPath(), args, {
      cwd: PROJECT_ROOT, env: preferenceEnv(), encoding: 'utf8', timeout: 120000,
    })
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error).split('\n').filter(Boolean).slice(-2).join(' | ')
    const code = /preference-not-found/.test(detail) ? 'preference-not-found'
      : /scope-/.test(detail) ? 'preference-delete-invalid'
        : 'preference-delete-failed'
    throw Object.assign(new Error(detail || 'deletion failed'), { code })
  }
  return { ok: true, ...JSON.parse(stdout), summary: preferenceSummary(PROJECT_ROOT) }
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

async function readJsonBody(req, limit = 65536) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > limit) throw new Error('request body too large')
  }
  return raw ? JSON.parse(raw) : {}
}

function routeError(res, error) {
  const code = error?.code || 'failed'
  const status = code === 'preference-invalid' || code === 'preference-action-invalid' ? 400
    : code === 'preference-user-only' ? 403
      : code === 'preference-not-found' ? 404
        : code === 'policy-invalid' ? 400
        : code === 'preference-delete-invalid' ? 400
        : 500
  writeJson(res, status, { ok: false, error: { code, message: error?.message || String(error) } })
}

function readMatches(family, filters = {}) {
  if (family === 'runs') {
    return queryRuns(PROJECT_ROOT, filters)
  }
  if (family === 'decisions') {
    return queryDecisions(PROJECT_ROOT, filters)
  }
  if (family === 'preferences') {
    const profile = readPreferenceProfile(PROJECT_ROOT)
    let rows = profile ? (profile.preferences || []) : []
    if (filters.status) rows = rows.filter((record) => record.status === filters.status)
    if (filters.limit) rows = rows.slice(0, Math.max(1, Number(filters.limit) || 20))
    return {
      profile: profile ? {
        schema: profile.schema, generatedAt: profile.generatedAt, stats: profile.stats,
        evidence: profile.evidence, conflicts: profile.conflicts || [],
      } : null,
      preferences: rows,
      summary: preferenceSummary(PROJECT_ROOT),
    }
  }
  if (family === 'inspection') {
    const sessions = readInspectionSessions(VIEWER_STATE_DIR)
    let rows = sessions.sessions
    if (filters.sessionId) rows = rows.filter((session) => session.sessionId === filters.sessionId)
    if (filters.subject) {
      // Sessions do not carry a subject yet; leave the filter inert rather than lying.
    }
    if (filters.limit) rows = rows.slice(0, Math.max(1, Number(filters.limit) || 20))
    return {
      sessions: rows.map((session) => ({ ...session, recentFrames: undefined })),
      summary: inspectionSummary(VIEWER_STATE_DIR),
      corrupt: sessions.corrupt,
    }
  }
  const read = readFamily(PROJECT_ROOT, family)
  let events = read.events
  if (filters.type) events = events.filter((event) => event.type === filters.type)
  if (filters.limit) events = events.slice(-Math.max(1, Number(filters.limit) || 100))
  return { events, corrupt: read.corrupt, shards: read.shards.length, total: read.events.length }
}

function recordSnapshot() {
  const stats = recordStats(PROJECT_ROOT)
  const runs = queryRuns(PROJECT_ROOT, { limit: 10 })
  const decisions = queryDecisions(PROJECT_ROOT, { limit: 5 })
  return {
    ok: true,
    root: stats.root,
    families: stats.families,
    corrupt: stats.corrupt,
    recentRuns: runs.runs,
    recentDecisions: decisions.decisions,
    inspection: inspectionSummary(VIEWER_STATE_DIR),
    preferences: preferenceSummary(PROJECT_ROOT),
    projectRoot: PROJECT_ROOT,
  }
}

function recordQuery(args = {}) {
  const family = ['runs', 'decisions', 'preferences', 'inspection'].includes(args.family) ? args.family : 'runs'
  const filters = {
    status: args.status,
    mode: args.mode,
    subject: args.subject,
    actorKind: args.actorKind,
    runId: args.runId,
    sessionId: args.sessionId,
    type: args.type,
    limit: Math.max(1, Math.min(Number(args.limit) || 20, 200)),
  }
  const result = readMatches(family, filters)
  return JSON.stringify({ ok: true, family, filters, ...result }, null, 1)
}

function recordRebuild(args = {}) {
  const migration = args.migrate === false ? { skipped: true, imported: 0 } : migrateLegacy(PROJECT_ROOT)
  const rebuilt = rebuildIndex(PROJECT_ROOT)
  return JSON.stringify({ ok: true, migration, rebuilt }, null, 1)
}

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'ffs_record_query',
    presentCall: (args) => ({ card: 'generic', kind: 'read', title: 'FFS record', rawInput: args }),
    description: [
      'Read the append-only FFS record (attempt ledger by default).',
      'families: runs | decisions | preferences | inspection. Filters: status, mode, subject,',
      'actorKind, runId, type, sessionId, limit. Read-only; never mutates the ledger.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        family: { type: 'string', enum: ['runs', 'decisions', 'preferences', 'inspection'], description: 'default runs' },
        status: { type: 'string', description: 'run status (completed/failed/stopped/imported/…)' },
        mode: { type: 'string', description: 'run mode (run/tool/replay/…)' },
        subject: { type: 'string' },
        actorKind: { type: 'string', enum: ['user', 'agent', 'scheduler', 'system', 'unknown'] },
        runId: { type: 'string' },
        sessionId: { type: 'string', description: 'inspection session id filter' },
        type: { type: 'string', description: 'event type filter for decisions/preferences' },
        limit: { type: 'number', description: 'max rows (default 20, cap 200)' },
      },
      required: [],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute(args) { return recordQuery(args || {}) },
  }), 'ffs-record: query tool')

  ctx.effect(() => ctx.tools.register({
    name: 'ffs_preference_delete',
    presentCall: (args) => ({ card: 'generic', kind: 'read', title: 'Preview preference evidence deletion', rawInput: args }),
    description: [
      'Dry-run the R4 deletion pipeline for preference evidence. Returns the sessions/shards that',
      'would be destroyed, the before aggregate and pending raw inspection deletions. It never',
      'applies: the user applies deletion through the Record tab / user route.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'object',
          description: 'One of {sessionId}, {preferenceId}, {before: ISO}, {project: true}.',
          properties: {
            sessionId: { type: 'string' },
            preferenceId: { type: 'string' },
            before: { type: 'string' },
            project: { type: 'boolean' },
          },
        },
        mode: { type: 'string', enum: ['evidence', 'preference'], description: 'Default evidence.' },
      },
      required: ['scope'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute(args) {
      return JSON.stringify(preferenceDelete({
        scope: args?.scope, mode: args?.mode, dryRun: true, actor: 'agent',
      }), null, 1)
    },
  }), 'ffs-record: preference deletion dry-run')

  ctx.effect(() => ctx.tools.register({
    name: 'ffs_preference_confirm',
    presentCall: (args) => ({ card: 'generic', kind: 'write', title: 'Request preference confirmation', rawInput: args }),
    description: [
      'Ask the user to confirm or reject a derived preference. This only appends a',
      'confirmation-requested note — it never changes status, confidence or evidence. The user',
      'establishes a scientific preference through the Record tab / user route.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        preferenceId: { type: 'string', description: 'Derived preference id, e.g. pref-threshold-2-3.' },
        note: { type: 'string', description: 'Why you are asking, shown with the request.' },
      },
      required: ['preferenceId'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute(args) {
      return JSON.stringify(preferenceAction({
        action: 'request', preferenceId: args?.preferenceId, reason: args?.note, actor: 'agent',
      }), null, 1)
    },
  }), 'ffs-record: preference confirmation request')

  ctx.effect(() => ctx.tools.register({
    name: 'ffs_record_rebuild',
    presentCall: (args) => ({ card: 'generic', kind: 'write', title: 'Rebuild FFS record index', rawInput: args }),
    description: [
      'Rebuild the derived record index from the append-only shards, importing the legacy',
      'run/tool-run/replay files once unless migrate=false. Shards stay the truth; torn',
      'lines are reported, never repaired silently.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { migrate: { type: 'boolean', description: 'import legacy files (default true)' } },
      required: [],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute(args) { return recordRebuild(args || {}) },
  }), 'ffs-record: rebuild tool')

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
          writeJson(res, 200, recordSnapshot())
        } catch (error) {
          routeError(res, error)
        }
        return
      }

      if (rel === 'runs') {
        try {
          const filters = {
            status: url.searchParams.get('status') || undefined,
            mode: url.searchParams.get('mode') || undefined,
            subject: url.searchParams.get('subject') || undefined,
            actorKind: url.searchParams.get('actorKind') || undefined,
            runId: url.searchParams.get('runId') || undefined,
            limit: url.searchParams.get('limit') || undefined,
          }
          writeJson(res, 200, { ok: true, ...queryRuns(PROJECT_ROOT, filters) })
        } catch (error) {
          routeError(res, error)
        }
        return
      }

      if (rel === 'rebuild') {
        if (req.method !== 'POST') {
          writeText(res, 405, 'method not allowed')
          return
        }
        try {
          const body = await readJsonBody(req)
          const migration = body.migrate === false ? { skipped: true, imported: 0 } : migrateLegacy(PROJECT_ROOT)
          writeJson(res, 200, { ok: true, migration, rebuilt: rebuildIndex(PROJECT_ROOT) })
        } catch (error) {
          routeError(res, error)
        }
        return
      }

      if (rel === 'policy') {
        try {
          if (req.method === 'POST') {
            const body = await readJsonBody(req)
            const result = writePolicy(body.policy || body)
            writeJson(res, 200, { ok: true, ...result })
            return
          }
          writeJson(res, 200, { ok: true, policy: readPolicy() })
        } catch (error) {
          routeError(res, error)
        }
        return
      }

      if (rel === 'preferences') {
        try {
          if (req.method === 'POST') {
            const body = await readJsonBody(req)
            writeJson(res, 200, preferenceAction(body))
            return
          }
          const profile = readPreferenceProfile(PROJECT_ROOT)
          writeJson(res, 200, profile
            ? { ok: true, profile }
            : { ok: true, profile: null, summary: preferenceSummary(PROJECT_ROOT) })
        } catch (error) {
          routeError(res, error)
        }
        return
      }

      if (rel === 'preferences/establish' || rel === 'preferences/retire' || rel === 'preferences/edit'
        || rel === 'preferences/delete' || rel === 'preferences/confirm') {
        if (req.method !== 'POST') {
          writeText(res, 405, 'method not allowed')
          return
        }
        try {
          const body = await readJsonBody(req)
          if (rel === 'preferences/delete' && body.scope) {
            writeJson(res, 200, preferenceDelete(body))
            return
          }
          writeJson(res, 200, preferenceAction({ ...body, action: rel.split('/')[1] }))
        } catch (error) {
          routeError(res, error)
        }
        return
      }

      if (rel === 'inspection') {
        try {
          const sessionId = url.searchParams.get('session')
          if (sessionId) {
            const session = readInspectionSession(VIEWER_STATE_DIR, sessionId, {
              maxFrames: Number(url.searchParams.get('frames')) || 500,
            })
            if (!session) {
              writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `no inspection session: ${sessionId}` } })
              return
            }
            writeJson(res, 200, { ok: true, session })
            return
          }
          writeJson(res, 200, { ok: true, ...readInspectionSessions(VIEWER_STATE_DIR), summary: inspectionSummary(VIEWER_STATE_DIR) })
        } catch (error) {
          routeError(res, error)
        }
        return
      }

      if (rel === 'family') {
        try {
          const family = url.searchParams.get('family') || 'decisions'
          writeJson(res, 200, { ok: true, family, ...readMatches(family, {
            type: url.searchParams.get('type') || undefined,
            limit: url.searchParams.get('limit') || undefined,
          }) })
        } catch (error) {
          routeError(res, error)
        }
        return
      }

      writeText(res, 404, 'not found')
    }

    try {
      webCtx.effect(
        () => webCtx.webServer.register({ kind: 'prefix', path: ROUTE, handler }),
        'ffs-record: route',
      )
    } catch (error) {
      console.error('[ffs-record] route registration failed:', error)
    }
  })
}

export { PROJECT_ROOT }
