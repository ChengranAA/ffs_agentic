/**
 * FFS Harness viewer — Host half.
 *
 * Owns one headless FFS viewer sidecar (authoritative ViewerSession state) and exposes
 * it through exactly two callers:
 *
 *   - the browser over an authenticated Connection RPC channel (`/ffs`)
 *   - model tools registered on `ctx.tools`
 *
 * Both call the same `Bridge` methods with the same payloads, so a pane control and an
 * agent action are one validated operation. Agent actions are recorded with
 * origin "agent"; browser actions with origin "ui".
 *
 * The sidecar speaks newline-delimited JSON over stdio; no extra ports are opened.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const name = 'ffs-viewer'

/** Tools are the only mandatory service; the RPC channel is mounted when Connection exists. */
export const inject = ['tools']

const DIAG = {
  channelRegistered: false,
  channelError: null,
  requests: [],
  lastError: null,
  routeProbe: null,
}

const PKG_DIR = path.dirname(realpathSync(fileURLToPath(import.meta.url)))

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

/** Sidecar request/response channel over stdio. */
class Sidecar {
  constructor(options) {
    this.python = options.python
    this.projectRoot = options.projectRoot
    this.stateDir = options.stateDir
    this.child = null
    this.pending = new Map()
    this.nextId = 1
    this.stderrTail = []
    this.starting = null
    this.disposed = false
    this.onExit = null
  }

  env() {
    const env = { ...process.env }
    const pythonPath = [path.join(this.projectRoot, 'python'), path.join(this.projectRoot, 'reference', 'fastfuncstuff')]
    env.PYTHONPATH = [pythonPath.join(path.delimiter), env.PYTHONPATH].filter(Boolean).join(path.delimiter)
    env.PYTHONUNBUFFERED = '1'
    env.PYTHONIOENCODING = 'utf-8'
    env.FFS_VIEWER_STATE_DIR = this.stateDir
    return env
  }

  ensure() {
    if (this.child && this.child.exitCode === null) return Promise.resolve()
    if (this.starting) return this.starting
    this.starting = new Promise((resolve, reject) => {
      const args = [
        '-u', '-m', 'ffsviewer.server',
        '--project-root', this.projectRoot,
        '--state-dir', this.stateDir,
      ]
      let child
      try {
        child = spawn(this.python, args, {
          cwd: this.projectRoot,
          env: this.env(),
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (error) {
        this.starting = null
        reject(error)
        return
      }
      this.child = child
      child.once('error', (error) => {
        this.starting = null
        reject(new Error(`could not start FFS sidecar (${this.python}): ${error.message}`))
      })
      child.once('spawn', () => {
        this.starting = null
        resolve()
      })
      const stdout = createInterface({ input: child.stdout })
      stdout.on('line', (line) => this._onLine(line))
      const stderr = createInterface({ input: child.stderr })
      stderr.on('line', (line) => {
        this.stderrTail.push(line)
        if (this.stderrTail.length > 200) this.stderrTail.shift()
      })
      child.on('exit', (code, signal) => {
        this.child = null
        this.starting = null
        // The dataset is gone with the process: make the next data call reopen.
        try { this.onExit?.() } catch { /* diagnostic hook must never throw */ }
        const reason = `FFS sidecar exited (${signal || code})`
        for (const [, record] of this.pending) {
          record.reject(new Error(reason))
        }
        this.pending.clear()
      })
    })
    return this.starting
  }

  _onLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    const record = this.pending.get(message.id)
    if (!record) return
    this.pending.delete(message.id)
    clearTimeout(record.timer)
    if (message.ok) record.resolve(message.result)
    else {
      const error = new Error(message.error?.message || 'sidecar failure')
      error.code = message.error?.code || 'ffs/error'
      error.details = message.error?.details || {}
      record.reject(error)
    }
  }

  request(method, params = {}, { timeout = 120000 } = {}) {
    if (this.disposed) return Promise.reject(new Error('FFS viewer is shutting down'))
    return this.ensure().then(() => new Promise((resolve, reject) => {
      if (!this.child || this.child.exitCode !== null) {
        reject(new Error('FFS sidecar is not running'))
        return
      }
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`FFS sidecar request ${method} timed out after ${timeout} ms`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    }))
  }

  stderr() {
    return this.stderrTail.join('\n')
  }

  async restart() {
    const child = this.child
    this.disposed = false
    if (!child) return
    try {
      await this.request('shutdown', {}, { timeout: 5000 })
    } catch { /* sidecar may already be gone */ }
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    this.child = null
    this.starting = null
    for (const [, record] of this.pending) record.reject(new Error('FFS sidecar restarting'))
    this.pending.clear()
  }

  async dispose() {
    this.disposed = true
    const child = this.child
    if (!child) return
    try {
      await this.request('shutdown', {}, { timeout: 5000 })
    } catch {
      // shutdown is best effort; the sidecar also autosaves on every 25 commands
    }
    const killer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch { /* already gone */ }
    }, 2000)
    child.once('exit', () => clearTimeout(killer))
  }
}

function summarize(state) {
  if (!state) return 'no viewer state'
  const cross = state.crosshairMm ? state.crosshairMm.map(v => v.toFixed(1)).join(', ') : '--'
  const layers = state.layers.map(layer => `${layer.key}${layer.timeLinked ? '*' : ''}`).join(' ')
  const views = state.viewports.map(vp => vp.id).join(' ')
  const dirty = Object.entries(state.dirty || {})
    .filter(([, value]) => value).map(([key]) => key).join('+') || 'clean'
  const lines = state.readout?.lines?.slice(0, 3) || []
  return [
    `rev ${state.rev} · ${state.origin}/${state.category} · ${dirty}${state.loading ? ' · loading' : ''}`,
    `crosshair ijk [${(state.crosshair || []).join(', ')}] mm (${cross}) · time ${state.timeIndex}/${state.maxTimeIndex}`,
    `layers ${layers || '(none)'} · selected ${state.selected || '--'} · views ${views || '(none)'}`,
    ...lines.map(line => `  ${line}`),
  ].join('\n')
}

/** The one implementation of every viewer operation. */
class Bridge {
  constructor(sidecar) {
    this.sidecar = sidecar
    this.opened = null
    // A crash or explicit restart invalidates the "already opened" cache.
    sidecar.onExit = () => { this.opened = null }
  }

  async ensureOpen() {
    if (this.opened) return this.opened
    this.opened = this.sidecar.request('open', { preset: 'auto' }, { timeout: 180000 })
      .catch((error) => {
        this.opened = null
        throw error
      })
    return this.opened
  }

  async call(endpoint, payload, origin = 'ui') {
    // Starting the sidecar is lazy: polling state before anyone opens the viewer
    // must not load a dataset, import torch, or start a Python process.
    const needsData = new Set([
      'execute', 'execute_batch', 'render', 'pick', 'pan', 'zoom', 'step',
      'surface', 'surface_pick', 'series', 'save', 'restore', 'open', 'load_paths',
      'sources', 'add_folder', 'remove_folder', 'read_folder', 'add_files',
      'preview', 'clear_preview', 'load_entry', 'add_subject', 'remove_subject',
    ])
    if (needsData.has(endpoint)) await this.ensureOpen()
    else await this.sidecar.ensure()
    const params = { ...(payload || {}) }
    if (endpoint === 'execute' || endpoint === 'execute_batch' || endpoint === 'pick'
      || endpoint === 'pan' || endpoint === 'zoom' || endpoint === 'step' || endpoint === 'surface_pick') {
      params.origin = origin
    }
    switch (endpoint) {
      case 'state':
        return this.sidecar.request('state', {})
      case 'execute':
        return this.sidecar.request('execute', { line: params.line, origin })
      case 'execute_batch':
        return this.sidecar.request('execute_batch', { lines: params.lines, origin })
      case 'render':
        return this.sidecar.request('render', { view: params.view, outlineToken: params.outlineToken }, { timeout: 60000 })
      case 'pick':
        return this.sidecar.request('pick', {
          view: params.view, row: params.row, col: params.col, origin, action: params.action,
        })
      case 'pan':
        return this.sidecar.request('pan', { view: params.view, dx: params.dx, dy: params.dy, origin })
      case 'zoom':
        return this.sidecar.request('zoom', { view: params.view, factor: params.factor, origin })
      case 'step':
        return this.sidecar.request('step', { view: params.view, delta: params.delta, origin })
      case 'surface':
        return this.sidecar.request('surface', {
          view: params.view, meshRev: params.meshRev, colorsToken: params.colorsToken,
          shape: params.shape, colors: params.colors,
          fragment: params.fragment, overlayToken: params.overlayToken,
        }, { timeout: 120000 })
      case 'surface_pick':
        return this.sidecar.request('surface_pick', {
          view: params.view, xNdc: params.xNdc, yNdc: params.yNdc, aspect: params.aspect,
          camera: params.camera, action: params.action, origin,
        }, { timeout: 60000 })
      case 'series':
        return this.sidecar.request('series', { view: params.view }, { timeout: 60000 })
      case 'browse':
        return this.sidecar.request('browse', { path: params.path }, { timeout: 30000 })
      case 'load_paths':
        return this.sidecar.request('load_paths', {
          paths: params.paths, subject: params.subject,
          keep_surfaces: params.keepSurfaces ?? params.keep_surfaces, origin,
        }, { timeout: 180000 })
      case 'sources':
        return this.sidecar.request('sources', {}, { timeout: 60000 })
      case 'add_folder':
        return this.sidecar.request('add_folder', {
          path: params.path, recursive: params.recursive,
        }, { timeout: 180000 })
      case 'remove_folder':
        return this.sidecar.request('remove_folder', { path: params.path }, { timeout: 30000 })
      case 'read_folder':
        return this.sidecar.request('read_folder', {
          path: params.path, recursive: params.recursive,
        }, { timeout: 180000 })
      case 'add_files':
        return this.sidecar.request('add_files', { paths: params.paths }, { timeout: 180000 })
      case 'preview':
        return this.sidecar.request('preview', { path: params.path }, { timeout: 60000 })
      case 'auto_range':
        return this.sidecar.request('auto_range', { key: params.key, origin }, { timeout: 60000 })
      case 'colorbar':
        return this.sidecar.request('colorbar', {
          colormap: params.colormap, n: params.n, reverse: params.reverse,
          lo: params.lo, hi: params.hi, threshold: params.threshold,
          sign: params.sign, alpha: params.alpha, panes: params.panes,
        }, { timeout: 30000 })
      case 'clear_preview':
        return this.sidecar.request('clear_preview', {}, { timeout: 30000 })
      case 'load_entry':
        return this.sidecar.request('load_entry', {
          path: params.path, keep_surfaces: params.keepSurfaces ?? params.keep_surfaces, origin,
        }, { timeout: 180000 })
      case 'clear_surfaces':
        return this.sidecar.request('clear_surfaces', { origin }, { timeout: 60000 })
      case 'add_subject':
        return this.sidecar.request('add_subject', {
          path: params.path, origin,
        }, { timeout: 180000 })
      case 'remove_subject':
        return this.sidecar.request('remove_subject', { path: params.path }, { timeout: 30000 })
      case 'workspace':
        return this.sidecar.request('workspace', params.layout === undefined ? {} : { layout: params.layout })
      case 'save':
        return this.sidecar.request('save', { note: params.note }, { timeout: 60000 })
      case 'restore':
        return this.sidecar.request('restore', {}, { timeout: 180000 })
      case 'show':
        return this.sidecar.request('show', { target: params.target })
      case 'commands':
        return this.sidecar.request('commands', {})
      case 'open':
        // Idempotent by design: ensureOpen already opened the dataset once. A
        // second `open` here used to replay the saved script over live state.
        return { state: await this.sidecar.request('state', {}), opened: true }
      case 'restart':
        await this.sidecar.restart()
        this.opened = null
        return { restarting: true }
      default:
        throw new Error(`unknown FFS viewer endpoint ${JSON.stringify(endpoint)}`)
    }
  }

  async devInspect() {
    return { projectRoot: PROJECT_ROOT, python: this.sidecar.python, stateDir: this.sidecar.stateDir, stderr: this.sidecar.stderr() }
  }
}

const COMMAND_HELP = [
  'FFS command lines use the original viewer vocabulary (AFNI-flavoured). Examples:',
  '  SET_IJK 32 40 25 | SET_XYZ 4.5 -20 12 | SET_INDEX 40',
  '  OPEN_VIEW V4 image axial | SET_VIEW_LOCKED V4 0 | SET_VIEW_POSITION V4 20',
  '  SET_THRESHOLD S 3.2 | SET_COLORMAP S redblue | SET_ALPHA S linear',
  '  SET_SURFACE_SHAPE S1 inflated | SET_SURFACE_DEPTH S1 0.1 0.9 5',
  '  SET_VIEW_GRID G1 2 | SET_VIEW_TRACES G1 F',
  'Use the ffs_viewer_state tool with section="commands" for the full validated vocabulary.',
].join('\n')

function renderText(text) {
  return [{ type: 'text', text }]
}

function toolResultText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function makeTools(bridge, options) {
  const origin = 'agent'
  return [
    {
      name: 'ffs_viewer_command',
      description: [
        'Execute one validated FFS viewer command against the authoritative fMRI viewer state',
        'shared with the open Harness viewer workspace. Use it to navigate (crosshair/time),',
        'open/park/lock views, change display semantics (threshold, colormap, range, opacity),',
        'switch modes, or edit surfaces. Returns a compact state summary.',
        '',
        COMMAND_HELP,
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          line: { type: 'string', description: 'One FFS command line, e.g. "SET_THRESHOLD S 3.2".' },
          lines: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional batch of command lines, applied in order.',
          },
        },
        required: [],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => renderText(toolResultText(value)),
      },
      async execute(args) {
        const lines = Array.isArray(args.lines) && args.lines.length
          ? args.lines
          : (typeof args.line === 'string' && args.line.trim() ? [args.line] : [])
        if (!lines.length) throw new Error('ffs_viewer_command needs `line` or `lines`')
        const result = lines.length === 1
          ? await bridge.call('execute', { line: lines[0] }, origin)
          : await bridge.call('execute_batch', { lines }, origin)
        const state = result.state
        const applied = lines.length === 1 ? result.command : `${lines.length} commands`
        return `${applied}\n${summarize(state)}`
      },
    },
    {
      name: 'ffs_viewer_state',
      description: [
        'Read the authoritative FFS viewer state without changing it: crosshair and mm, time',
        'index, layers and their display parameters, viewports (including parked slices and',
        'locks), surface outlines, crosshair readout, or the full command vocabulary.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            enum: ['summary', 'all', 'layers', 'viewports', 'readout', 'surfaces', 'workspace', 'commands'],
            description: 'Which slice of the state to return (default summary).',
          },
        },
        required: [],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => renderText(toolResultText(value)),
      },
      async execute(args) {
        const section = args.section || 'summary'
        await bridge.ensureOpen()
        if (section === 'commands') {
          const catalog = await bridge.call('commands', {}, origin)
          return JSON.stringify({ categories: catalog.categories, commands: catalog.commands }, null, 1)
        }
        const state = await bridge.call('state', {}, origin)
        if (section === 'summary') return summarize(state)
        if (section === 'all') return JSON.stringify(state, null, 1)
        if (section === 'layers') return JSON.stringify(state.layers, null, 1)
        if (section === 'viewports') return JSON.stringify(state.viewports, null, 1)
        if (section === 'readout') return JSON.stringify(state.readout, null, 1)
        if (section === 'surfaces') return JSON.stringify(state.surfaces, null, 1)
        if (section === 'workspace') return JSON.stringify(state.workspace, null, 1)
        throw new Error(`unknown section ${JSON.stringify(section)}`)
      },
    },
    {
      name: 'ffs_viewer_workspace',
      description: [
        'Read or replace the in-tab FFS workspace layout (floating pane-slot rects, tabs, order).',
        'The layout is separate from the FFS viewer state: it never changes data, analysis, or',
        'viewer display semantics. Use ffs_viewer_show to reveal the docked tab in the browser.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set'], description: 'get (default) or set.' },
          layout: { type: 'string', description: 'JSON layout object, required for set.' },
        },
        required: [],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => renderText(toolResultText(value)),
      },
      async execute(args) {
        const action = args.action || 'get'
        if (action === 'get') {
          const result = await bridge.call('workspace', {}, origin)
          return JSON.stringify(result.layout, null, 1)
        }
        if (typeof args.layout !== 'string') throw new Error('ffs_viewer_workspace set needs `layout` JSON')
        let layout
        try {
          layout = JSON.parse(args.layout)
        } catch (error) {
          throw new Error(`layout is not JSON: ${error.message}`)
        }
        const result = await bridge.call('workspace', { layout }, origin)
        return `workspace layout updated (rev ${result.rev})`
      },
    },
    {
      name: 'ffs_viewer_show',
      description: 'Reveal the docked FFS viewer tab in the right Sidebar of the DeepSeek Harness interface. Use after changing something the user should see.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Optional viewport id to focus, e.g. V1 or S1.' },
        },
        required: [],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => renderText(toolResultText(value)),
      },
      async execute(args) {
        await bridge.ensureOpen()
        const result = await bridge.call('show', { target: args.target }, origin)
        return `viewer revealed (show #${result.showSeq}${result.target ? `, target ${result.target}` : ''})`
      },
    },
    {
      name: 'ffs_viewer_render',
      description: [
        'Render one image viewport through the FFS slice pipeline and save it as a PNG inside the',
        'viewer state directory. Returns the file path, plane, slice position and the crosshair',
        'mapping, which is useful for verifying coordinate mapping and thresholds.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          view: { type: 'string', description: 'Image viewport id, e.g. V1.' },
          save: { type: 'boolean', description: 'Write the PNG to disk (default true).' },
        },
        required: ['view'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => renderText(toolResultText(value)),
      },
      async execute(args) {
        const result = await bridge.call('render', { view: args.view }, origin)
        const summary = {
          view: result.view,
          width: result.width,
          height: result.height,
          plane: result.plane,
          position: result.position,
          crosshairPx: result.crosshairPx,
          outlines: result.outlines.length,
          rev: result.rev,
        }
        if (args.save === false) return JSON.stringify(summary, null, 1)
        const dir = path.join(options.stateDir, 'screenshots')
        mkdirSync(dir, { recursive: true })
        const file = path.join(dir, `${result.view}-rev${result.rev}.png`)
        writeFileSync(file, Buffer.from(result.png, 'base64'))
        return JSON.stringify({ ...summary, path: file }, null, 1)
      },
    },
    {
      name: 'ffs_viewer_save',
      description: [
        'Save or restore both halves of the viewer: the FFS viewer script (authoritative state)',
        'and the Harness workspace layout. Save also reports the source/analysis/display split.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['save', 'restore', 'status', 'restart'], description: 'Default save.' },
          note: { type: 'string', description: 'Optional note recorded in session.json.' },
        },
        required: [],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => renderText(toolResultText(value)),
      },
      async execute(args) {
        const action = args.action || 'save'
        if (action === 'restart') {
          await bridge.call('restart', {}, origin)
          const state = await bridge.call('state', {}, origin)
          return `sidecar restarted; viewer state restored\n${summarize(state)}`
        }
        if (action === 'restore') {
          const result = await bridge.call('restore', {}, origin)
          return `restored ${result.commands || 0} commands\n${summarize(result.state)}`
        }
        if (action === 'status') {
          await bridge.ensureOpen()
          const state = await bridge.call('state', {}, origin)
          return JSON.stringify({ lastSavedAt: state.lastSavedAt, dirty: state.dirty, rev: state.rev, stateDir: state.stateDir }, null, 1)
        }
        const result = await bridge.call('save', { note: args.note }, origin)
        const counts = result.manifest.counts
        return [
          `saved viewer state + workspace to ${result.dir}`,
          `  source ${counts.source} · analysis ${counts.analysis} · display ${counts.display} · navigation ${counts.navigation}`,
          `  script ${result.files['viewer.ffs']}`,
          `  layout ${result.files['workspace.json']}`,
        ].join('\n')
      },
    },
    {
      name: 'ffs_viewer_load',
      description: [
        'Load one or more dataset files and/or a FreeSurfer subject directory into the',
        'running viewer, through the same operation the viewer\'s data picker uses.',
        'Accepts NIfTI/AFNI/MGH volumes, GIFTI surface data, and a subject directory',
        'containing surf/?h.white. Relative paths resolve against the project root.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: 'Dataset file paths to load, in order.' },
          subject: { type: 'string', description: 'FreeSurfer subject directory to load surfaces from.' },
          keepSurfaces: {
            type: 'boolean',
            description: 'Keep the currently loaded subject when loading dataset files. Default false: a dataset-only load unloads stale surfaces.',
          },
        },
        required: [],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => renderText(toolResultText(value)),
      },
      async execute(args) {
        const paths = Array.isArray(args.paths) ? args.paths.filter(item => typeof item === 'string' && item.trim()) : []
        if (!paths.length && !args.subject) throw new Error('ffs_viewer_load needs paths and/or subject')
        const result = await bridge.call('load_paths', { paths, subject: args.subject, keepSurfaces: args.keepSurfaces === true }, origin)
        const state = result.state
        return [
          `loaded ${result.loaded.length ? result.loaded.join(', ') : '(no new layers)'}${result.subject ? ` · surfaces ${result.subject}` : ''}`,
          summarize(state),
        ].join('\n')
      },
    },
    {
      name: 'ffs_viewer_surfaces',
      description: [
        'Inspect or unload the viewer\'s FreeSurfer subject. `clear` unloads the subject and',
        'hides its slice outlines; the Scene card then reports no subject. Loading a dataset',
        '(without a subject) also clears stale surfaces automatically.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['clear'],
            description: 'clear: unload the loaded subject and its outlines.',
          },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => renderText(toolResultText(value)),
      },
      async execute(args) {
        if (args.action !== 'clear') throw new Error(`unknown action ${JSON.stringify(args.action)}`)
        const result = await bridge.call('clear_surfaces', {}, origin)
        return [`surfaces ${result.cleared ? 'cleared' : 'already empty'}`, summarize(result.state)].join('\n')
      },
    },
    {
      name: 'ffs_viewer_sources',
      description: [
        'Manage the viewer\'s data sources (the FFS DIR list): list sources, add or remove a',
        'folder, read/rescan a folder into the catalog, add a FreeSurfer subject folder, or',
        'load one catalog entry. Folder lists persist in sources.json across sessions.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'add_folder', 'remove_folder', 'read_folder', 'add_subject', 'remove_subject', 'load_entry'],
            description: 'Default list.',
          },
          path: { type: 'string', description: 'Folder, subject or dataset path (absolute or project-relative).' },
          recursive: { type: 'boolean', description: 'Read folders recursively (default false).' },
        },
        required: [],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => renderText(toolResultText(value)),
      },
      async execute(args) {
        const action = args.action || 'list'
        let result
        if (action === 'list') result = await bridge.call('sources', {}, origin)
        else if (action === 'add_folder') result = await bridge.call('add_folder', { path: args.path, recursive: args.recursive }, origin)
        else if (action === 'remove_folder') result = await bridge.call('remove_folder', { path: args.path }, origin)
        else if (action === 'read_folder') result = await bridge.call('read_folder', { path: args.path, recursive: args.recursive }, origin)
        else if (action === 'add_subject') result = await bridge.call('add_subject', { path: args.path }, origin)
        else if (action === 'remove_subject') result = await bridge.call('remove_subject', { path: args.path }, origin)
        else if (action === 'load_entry') result = await bridge.call('load_entry', { path: args.path }, origin)
        else throw new Error(`unknown sources action ${JSON.stringify(action)}`)
        if (action === 'load_entry') return `loaded ${result.key}\n${summarize(result.state)}`
        const sources = result.sources || result
        const entries = (sources.catalog && sources.catalog.entries) || []
        return [
          `folders ${sources.folders.length} · subjects ${sources.subjects.length} · catalog ${entries.length}`,
          ...sources.folders.map(item => `  folder ${item.path}${item.recursive ? ' (recursive)' : ''}${item.exists ? '' : ' [missing]'}`),
          ...sources.subjects.map(item => `  subject ${item.path}${item.valid ? '' : ' [no surf]'}`),
          ...entries.slice(0, 20).map(item => `  ${item.kind} ${item.name} (${item.summary})`),
        ].join('\n')
      },
    },
    {
      name: 'ffs_viewer_debug',
      description: 'Diagnostics for the FFS viewer transport: whether the browser /ffs channel registered, the recent browser RPC calls and errors, sidecar stderr, and saved layout/state paths. Use when the viewer stays on "Loading viewer state…" or the UI seems disconnected.',
      parameters: { type: 'object', properties: {}, required: [] },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => renderText(toolResultText(value)),
      },
      async execute() {
        const recent = DIAG.requests.slice(-20).map(item => ({
          at: new Date(item.at).toISOString(),
          endpoint: item.endpoint,
          ok: item.ok,
          error: item.error || null,
        }))
        let state = null
        try {
          state = await bridge.call('state', {}, origin)
        } catch (error) {
          state = { error: error?.message || String(error) }
        }
        return JSON.stringify({
          channelRegistered: DIAG.channelRegistered,
          channelError: DIAG.channelError,
          lastError: DIAG.lastError,
          requestCount: DIAG.requests.length,
          recent,
          sidecarStderr: bridge.sidecar.stderr(),
          projectRoot: PROJECT_ROOT,
          stateDir: options.stateDir,
          state: state && state.rev !== undefined
            ? { rev: state.rev, grid: state.grid, viewports: state.viewports.map(vp => vp.id), workspace: state.workspace, showSeq: state.showSeq }
            : state,
        }, null, 1)
      },
    },
    {
      name: 'ffs_viewer_parity',
      description: 'Report the feature parity tracker summary for the FFS viewer rebuild (implemented / partial / not implemented counts).',
      parameters: { type: 'object', properties: {}, required: [] },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => renderText(toolResultText(value)),
      },
      async execute() {
        return readParitySummary()
      },
    },
  ]
}

function readParitySummary() {
  try {
    const file = path.join(PROJECT_ROOT, 'docs', 'PARITY.md')
    const text = readFileSync(file, 'utf8')
    const counts = { implemented: 0, partial: 0, 'not implemented': 0, 'not started': 0, 'out of scope': 0 }
    for (const line of text.split('\n')) {
      const match = line.match(/\|\s*(implemented|partial|not implemented|not started|out of scope)\s*\|/i)
      if (match) counts[match[1].toLowerCase()] += 1
    }
    return `parity tracker: ${Object.entries(counts).map(([key, value]) => `${key} ${value}`).join(' · ')}\n${file}`
  } catch (error) {
    return `parity tracker unavailable: ${error.message}`
  }
}

export function apply(ctx, config = {}) {
  const projectRoot = path.resolve(config.projectRoot || PROJECT_ROOT)
  const stateDir = path.resolve(config.stateDir || path.join(projectRoot, '.ffs-viewer'))
  const python = config.pythonPath
    || process.env.FFS_VIEWER_PYTHON
    || path.join(projectRoot, '.venv', 'bin', 'python')
  const sidecar = new Sidecar({ python, projectRoot, stateDir })
  const bridge = new Bridge(sidecar)
  const tools = makeTools(bridge, { stateDir })

  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `ffs-viewer: tool ${tool.name}`)
  }

  // The browser bridge. `connection.rpc.handle()` is the documented generic
  // channel, but in this profile it resolves `webServer` on the Connection
  // service's own context and throws ("cannot get property webServer without
  // inject"). Register the same authenticated envelope route directly instead:
  // `connection.admit(req)` still enforces host/origin + the browser cookie.
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    try {
      const route = {
        kind: 'prefix',
        path: '/ffs',
        handler: async (req, res) => {
          const admission = webCtx.connection.admit(req)
          if ('rejection' in admission) {
            res.writeHead(admission.rejection)
            res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
            return
          }
          let raw = ''
          try {
            for await (const chunk of req) raw += chunk
            const message = JSON.parse(raw || '{}')
            const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid'
            const method = typeof message.method === 'string' ? message.method : ''
            DIAG.requests.push({ at: Date.now(), endpoint: method, ok: null })
            const record = DIAG.requests[DIAG.requests.length - 1]
            let result
            try {
              const value = await bridge.call(method, message.payload || {}, 'ui')
              record.ok = true
              result = { ok: true, value }
            } catch (error) {
              record.ok = false
              record.error = error?.message || String(error)
              DIAG.lastError = { at: Date.now(), endpoint: method, message: record.error, code: error?.code }
              result = {
                ok: false,
                error: {
                  code: error?.code || 'ffs/failed',
                  message: error?.message || String(error),
                  details: error?.details || {},
                },
              }
            }
            const body = JSON.stringify({ type: 'server-response', rpcId, result })
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(body)
          } catch (error) {
            DIAG.lastError = { at: Date.now(), endpoint: 'transport', message: String(error && error.message || error) }
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('bad request')
          }
        },
      }
      webCtx.effect(() => webCtx.webServer.register(route), 'ffs-viewer: /ffs bridge route')
      DIAG.channelRegistered = true
      DIAG.channelError = null
    } catch (error) {
      DIAG.channelError = String(error && error.message || error)
      console.error('[ffs-viewer] /ffs route registration failed:', error)
    }
  })

  ctx.effect(() => () => {
    void sidecar.dispose()
  }, 'ffs-viewer: sidecar lifecycle')
}
