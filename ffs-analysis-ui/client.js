/**
 * FFS analysis — Client half.
 *
 * A right-sidebar tab that inspects one FFS analysis: pipeline stage timeline, artifact
 * table, QC figures, results, cohort matrix, group analyses and provenance. It is an
 * artifact of the UI-first milestone: the data comes from the Host half's fixture snapshot
 * (built from the real ds005165 run), and the only live integration is "Load in viewer",
 * which calls the FFS viewer's `/ffs` channel and then reveals its tab.
 *
 * The tab is a sibling of the FFS viewer tab; the viewer keeps its own workspace.
 */

window.__ModuleLoader__.load({
  id: '@local/ffs-analysis-ui',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const SNAPSHOT = '/ffs-analysis/snapshot'
    const TYPE_ID = '@local/ffs-analysis-ui'
    const KIND = 'ffs-analysis'
    const VIEWER_TAB = 'ffs-viewer'
    const LOCALE_NS = 'ffs-analysis'

    const SECTIONS = ['pipeline', 'data', 'qc', 'results', 'cohort', 'group', 'provenance']

    const MESSAGES = {
      title: 'FFS analysis',
      description: 'Inspect pipeline stages, artifacts, QC, results, cohort and group analyses.',
      open: 'Analysis',
      refresh: 'Refresh',
      openViewer: 'Open viewer',
      load: 'Load in viewer',
      loading: 'Loading analysis snapshot…',
      empty: 'No analysis snapshot yet.',
      error: 'The analysis snapshot could not be loaded.',
      retry: 'Retry',
      pipeline: 'Pipeline',
      data: 'Data',
      qc: 'QC',
      results: 'Results',
      cohort: 'Cohort',
      group: 'Group',
      provenance: 'Provenance',
      run: 'run',
      stages: 'stages',
      status: 'status',
      elapsed: 'elapsed',
      recipe: 'recipe',
      script: 'script',
      command: 'command',
      log: 'log',
      recentArtifacts: 'recent artifacts',
      artifact: 'Artifact',
      kind: 'kind',
      space: 'space',
      stage: 'stage',
      size: 'size',
      path: 'path',
      copyPath: 'Copy path',
      qcNote: 'QC figures',
      model: 'Model',
      contrasts: 'Contrasts',
      clusters: 'Clusters',
      peak: 'peak',
      preview: 'Preview',
      inspect: 'Inspect in viewer',
      cohortNote: 'Cohort',
      variants: 'variants',
      groupAnalyses: 'Group analyses',
      settled: 'settled',
      notSettled: 'not settled',
      export: 'Export package',
      exportDisabled: 'Available after settle/export lands (M3).',
      prototype: 'UI prototype · fixture snapshot from the ds005165 run',
      loaded: 'loaded in the viewer',
      loadFailed: 'Load failed',
      notDataset: 'Only imaging artifacts can be loaded into the viewer.',
      copied: 'Path copied',
    }

    const CSS = `
.ffa-root, .ffa-root *, .ffa-root *::before, .ffa-root *::after { box-sizing: border-box; }
.ffa-root { position: absolute; inset: 0; display: flex; flex-direction: column; overflow: hidden; padding: 6px;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font: 12px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.ffa-head { display: flex; align-items: center; gap: 6px; padding: 4px 6px; flex: 0 0 auto;
  border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); font-size: 11px; }
.ffa-brand { display: flex; align-items: center; gap: 5px; font-weight: 700; white-space: nowrap; }
.ffa-sub { color: var(--dsw-alias-label-secondary); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ffa-spacer { flex: 1 1 auto; }
.ffa-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 3px 8px; cursor: pointer; font: inherit; }
.ffa-btn:hover { border-color: var(--dsw-alias-brand-primary); }
.ffa-btn:disabled { opacity: .5; cursor: not-allowed; }
.ffa-btn-primary { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base);
  border-color: var(--dsw-alias-brand-primary); font-weight: 600; }
.ffa-btn-primary:hover { filter: brightness(1.08); }
.ffa-open-btn { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary); cursor: pointer; font: inherit; font-size: 12px; white-space: nowrap; }
.ffa-open-btn:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.ffa-main { display: flex; flex: 1 1 auto; min-height: 0; margin-top: 6px; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 9px; overflow: hidden; background: var(--dsw-alias-bg-base); }
.ffa-rail { width: 176px; flex: 0 0 176px; padding: 6px; border-right: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base); overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.ffa-rail-item { display: flex; align-items: center; gap: 7px; width: 100%; padding: 5px 7px;
  border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 11px; cursor: pointer; text-align: left; }
.ffa-rail-item:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.ffa-rail-item.is-active { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary); font-weight: 600; }
.ffa-rail-count { margin-left: auto; font-size: 9px; color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 0 5px; }
.ffa-content { flex: 1 1 auto; min-width: 0; overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
.ffa-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-1);
  overflow: hidden; min-width: 0; }
.ffa-card-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px;
  background: var(--dsw-alias-bg-layer-2); border-bottom: 1px solid transparent; }
.ffa-card-title { margin: 0; font-size: 10px; letter-spacing: .09em; text-transform: uppercase; font-weight: 700;
  color: var(--dsw-alias-label-secondary); }
.ffa-card-sub { margin-left: auto; font-size: 9px; color: var(--dsw-alias-label-secondary); }
.ffa-card-body { padding: 8px; display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.ffa-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ffa-muted { color: var(--dsw-alias-label-secondary); }
.ffa-small { font-size: 10px; }
.ffa-mono { font: 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
.ffa-pill { display: inline-flex; align-items: center; gap: 4px; height: 16px; border-radius: 999px; padding: 0 6px;
  font-size: 9px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.ffa-pill.is-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.ffa-pill.is-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.ffa-pill.is-error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.ffa-pill.is-running { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.ffa-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); display: inline-block; }
.ffa-dot.is-ok { background: var(--dsw-alias-state-success-primary); }
.ffa-dot.is-warn { background: var(--dsw-alias-state-warn-primary); }
.ffa-dot.is-error { background: var(--dsw-alias-state-error-primary); }
.ffa-dot.is-running { background: var(--dsw-alias-brand-primary); }
.ffa-progress { height: 6px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.ffa-progress > span { display: block; height: 100%; background: var(--dsw-alias-brand-primary); }
.ffa-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.ffa-chip { display: inline-flex; flex-direction: column; gap: 0; min-width: 64px; padding: 3px 7px;
  border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.ffa-chip-name { font-size: 10px; font-weight: 600; }
.ffa-chip-label { color: var(--dsw-alias-label-secondary); font-size: 9px; }
.ffa-chip.is-done { border-color: var(--dsw-alias-state-success-primary); }
.ffa-chip.is-running { border-color: var(--dsw-alias-brand-primary); }
.ffa-chip.is-failed { border-color: var(--dsw-alias-state-error-primary); }
.ffa-chip.is-pending { opacity: .65; }
.ffa-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.ffa-table th { text-align: left; font-weight: 500; color: var(--dsw-alias-label-secondary); font-size: 10px;
  padding: 4px 6px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.ffa-table td { padding: 5px 6px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: middle; }
.ffa-table tbody tr { cursor: pointer; }
.ffa-table tbody tr:hover td { background: var(--dsw-alias-bg-layer-2); }
.ffa-table tr.is-selected td { background: var(--dsw-alias-bg-layer-2); }
.ffa-name { font-weight: 600; overflow-wrap: anywhere; }
.ffa-split { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 8px; align-items: start; }
.ffa-kv { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 3px 8px; font-size: 10px; margin: 0; }
.ffa-kv dt { color: var(--dsw-alias-label-secondary); }
.ffa-kv dd { margin: 0; overflow-wrap: anywhere; }
.ffa-pre { margin: 0; padding: 7px 8px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1); font: 10px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap; overflow-wrap: anywhere; max-height: 170px; overflow: auto; }
.ffa-tag { display: inline-block; padding: 0 5px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary); font-size: 9px; margin: 1px 4px 1px 0; border: 1px solid var(--dsw-alias-border-l1); }
.ffa-img { display: block; width: 100%; height: auto; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base); }
.ffa-figure { margin: 0; }
.ffa-figure figcaption { font-size: 10px; color: var(--dsw-alias-label-secondary); margin-top: 4px; }
.ffa-empty { padding: 16px 8px; color: var(--dsw-alias-label-secondary); font-size: 10px; line-height: 1.45;
  text-align: center; }
.ffa-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.ffa-foot { flex: 0 0 auto; padding: 5px 8px; border-top: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font-size: 9px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ffa-toast { position: absolute; right: 10px; bottom: 34px; max-width: calc(100% - 20px); padding: 7px 10px;
  border-radius: 8px; background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2); font-size: 11px; box-shadow: 0 10px 30px rgba(0,0,0,.28); z-index: 5; }
@media (max-width: 620px) { .ffa-split { grid-template-columns: 1fr; } .ffa-rail { width: 140px; flex-basis: 140px; } }
`

    // ---------------------------------------------------------------- helpers
    function humanize(key) {
      const last = String(key).split('.').pop() || key
      const words = last.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ')
      return words.charAt(0).toUpperCase() + words.slice(1)
    }

    function formatBytes(n) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
      if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
      if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
      if (n >= 1024) return `${Math.round(n / 1024)} KB`
      return `${n} B`
    }

    function formatSeconds(n) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
      const m = Math.floor(n / 60)
      const s = Math.round(n % 60)
      return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
    }

    function statusClass(status) {
      if (status === 'completed' || status === 'done') return 'ok'
      if (status === 'running') return 'running'
      if (status === 'failed' || status === 'error') return 'error'
      if (status === 'warn' || status === 'warning' || status === 'draft') return 'warn'
      return 'idle'
    }

    function StatusPill({ status }) {
      return h('span', { className: `ffa-pill is-${statusClass(status)}` },
        h('span', { className: `ffa-dot is-${statusClass(status)}` }),
        status || 'unknown')
    }

    function Card({ title, subtitle, children }) {
      return h('section', { className: 'ffa-card' },
        title
          ? h('div', { className: 'ffa-card-head' },
            h('h3', { className: 'ffa-card-title' }, title),
            subtitle ? h('span', { className: 'ffa-card-sub' }, subtitle) : null)
          : null,
        h('div', { className: 'ffa-card-body' }, children))
    }

    function useSnapshot() {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)
      const [refreshing, setRefreshing] = useState(false)

      const read = useCallback(async () => {
        const res = await fetch(SNAPSHOT, { cache: 'no-store', credentials: 'same-origin' })
        if (!res.ok) throw new Error(`snapshot ${res.status}`)
        return res.json()
      }, [])

      const refresh = useCallback(async () => {
        setRefreshing(true)
        try {
          setData(await read())
          setError(null)
        } catch (e) {
          setError(String(e && e.message || e))
        } finally {
          setRefreshing(false)
          setLoading(false)
        }
      }, [read])

      useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const next = await read()
            if (alive) {
              setData(next)
              setError(null)
            }
          } catch (e) {
            if (alive) setError(String(e && e.message || e))
          } finally {
            if (alive) setLoading(false)
          }
        }
        tick()
        const timer = setInterval(tick, 10000)
        return () => { alive = false; clearInterval(timer) }
      }, [read])

      return { data, error, loading, refreshing, refresh }
    }

    // Always-mounted bridge: the tab body only mounts while the tab is open, so this
    // overlay watches `showSeq` and reveals the tab when `ffs_analysis_show` asks.
    function ShowBridge({ ctx, openAnalysis }) {
      const seen = useRef(null)
      useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const res = await fetch(SNAPSHOT, { cache: 'no-store', credentials: 'same-origin' })
            if (!res.ok) return
            const snap = await res.json()
            if (!alive) return
            const seq = typeof snap.showSeq === 'number' ? snap.showSeq : 0
            if (seen.current === null) { seen.current = seq; return }
            if (seq !== seen.current) { seen.current = seq; openAnalysis() }
          } catch {
            // Host half not ready yet.
          }
        }
        tick()
        const timer = setInterval(tick, 1500)
        return () => { alive = false; clearInterval(timer) }
      }, [openAnalysis])
      return null
    }

    // ---------------------------------------------------------------- icons
    function Icon({ kind, size = 14 }) {
      const paths = {
        pipeline: h('g', null,
          h('rect', { x: 2, y: 4, width: 3, height: 10, rx: 1 }),
          h('rect', { x: 6.5, y: 7, width: 3, height: 7, rx: 1 }),
          h('rect', { x: 11, y: 2, width: 3, height: 12, rx: 1 })),
        data: h('g', null,
          h('rect', { x: 2, y: 2, width: 12, height: 12, rx: 2 }),
          h('path', { d: 'M2 7h12M7 2v12' })),
        qc: h('path', { d: 'M2 8h3l2-5 2 10 2-5h3' }),
        results: h('g', null,
          h('path', { d: 'M3 13V8M8 13V4M13 13V6' }),
          h('path', { d: 'M2 15h12' })),
        cohort: h('g', null,
          h('circle', { cx: 5.5, cy: 6, r: 2.2 }),
          h('circle', { cx: 11, cy: 6.5, r: 1.8 }),
          h('path', { d: 'M2 13c.6-2.2 2-3.3 3.7-3.3S8.8 10.8 9.4 13M9 13c.4-1.7 1.4-2.6 2.6-2.6 1 0 1.9.8 2.3 2.2' })),
        group: h('g', null,
          h('rect', { x: 2, y: 3, width: 12, height: 3.5, rx: 1 }),
          h('rect', { x: 2, y: 8, width: 12, height: 3.5, rx: 1 })),
        provenance: h('g', null,
          h('path', { d: 'M5 4l-3 4 3 4M11 4l3 4-3 4' }),
          h('path', { d: 'M9 2L7 14' })),
        refresh: h('path', { d: 'M13 8a5 5 0 1 1-1.5-3.5M13 2v3h-3' }),
      }
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, paths[kind] || paths.pipeline)
    }

    function AnalysisIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M4 19V9M9 19V5M14 19v-6M19 19V7' }),
        h('path', { d: 'M3 21h18' }))
    }

    // ---------------------------------------------------------------- sections
    function PipelineSection({ snap, t }) {
      const pipeline = snap.pipeline || {}
      const stages = Array.isArray(pipeline.stages) ? pipeline.stages : []
      const completion = stages.length
        ? Math.round(100 * stages.filter((s) => s.status === 'done').length / stages.length)
        : 0
      return h(React.Fragment, null,
        h(Card, { title: t('run'), subtitle: `${snap.project?.subject || ''} · ${pipeline.recipe || ''}` },
          h('div', { className: 'ffa-row' },
            h(StatusPill, { status: pipeline.status }),
            h('span', { className: 'ffa-muted ffa-small' }, `${t('elapsed')} ${formatSeconds(pipeline.elapsedSeconds)}`),
            h('span', { className: 'ffa-muted ffa-small' }, `${stages.length} ${t('stages')}`)),
          h('div', { className: 'ffa-progress' }, h('span', { style: { width: `${completion}%` } })),
          h('div', { className: 'ffa-chips' }, stages.map((stage) => h('div', {
            key: stage.name,
            className: `ffa-chip is-${stage.status || 'pending'}`,
            title: `${stage.label || ''}${stage.seconds ? ` · ${formatSeconds(stage.seconds)}` : ''}`,
          }, h('span', { className: 'ffa-chip-name' }, stage.name), h('span', { className: 'ffa-chip-label' }, stage.label || ''))))),
        h(Card, { title: t('script') },
          h('dl', { className: 'ffa-kv' },
            h('dt', null, t('script')),
            h('dd', { className: 'ffa-mono' }, pipeline.script || '—'),
            h('dt', null, t('log')),
            h('dd', { className: 'ffa-mono' }, pipeline.log || '—')),
          h('div', { className: 'ffa-small ffa-muted' }, t('command')),
          h('pre', { className: 'ffa-pre' }, pipeline.command || '—'),
          Array.isArray(pipeline.logExcerpt) && pipeline.logExcerpt.length
            ? h(React.Fragment, null,
              h('div', { className: 'ffa-small ffa-muted', style: { marginTop: 8 } }, 'log tail'),
              h('pre', { className: 'ffa-pre' }, pipeline.logExcerpt.join('\n')))
            : null))
    }

    function ArtifactDetail({ artifact, onLoad, onCopy, busy, t }) {
      if (!artifact) {
        return h(Card, { title: t('artifact') }, h('div', { className: 'ffa-empty' }, 'Select an artifact in the table.'))
      }
      const hint = artifact.hint || {}
      const loadable = ['anat', 'func', 'stats', 'params', 'mask', 'warp', 'surface'].includes(artifact.kind)
      return h(Card, { title: t('artifact') },
        h('div', { className: 'ffa-name' }, artifact.name),
        h('dl', { className: 'ffa-kv' },
          h('dt', null, t('kind')), h('dd', null, artifact.kind || '—'),
          h('dt', null, t('space')), h('dd', null, artifact.space || '—'),
          h('dt', null, t('stage')), h('dd', null, artifact.stage || '—'),
          h('dt', null, t('size')), h('dd', null, formatBytes(artifact.bytes)),
          h('dt', null, t('path')), h('dd', { className: 'ffa-mono' }, artifact.path || '—')),
        Object.keys(hint).length
          ? h('div', null, Object.entries(hint).map(([key, value]) => h('span', { key, className: 'ffa-tag' }, `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)))
          : null,
        h('div', { className: 'ffa-actions' },
          loadable
            ? h('button', { className: 'ffa-btn ffa-btn-primary', disabled: busy, onClick: () => onLoad(artifact) }, busy ? '…' : t('load'))
            : h('span', { className: 'ffa-small ffa-muted' }, 'Text artifact — not a dataset.'),
          h('button', { className: 'ffa-btn', onClick: () => onCopy(artifact.path) }, t('copyPath'))))
    }

    function DataSection({ snap, t, onLoad, onCopy, busy }) {
      const [selected, setSelected] = useState(null)
      const artifacts = Array.isArray(snap.artifacts) ? snap.artifacts : []
      return h('div', { className: 'ffa-split' },
        h(Card, { title: `${t('recentArtifacts')} · ${artifacts.length}` },
          h('table', { className: 'ffa-table' },
            h('thead', null, h('tr', null,
              h('th', null, 'name'), h('th', null, t('kind')), h('th', null, t('stage')), h('th', null, t('size')))),
            h('tbody', null, artifacts.map((artifact) => h('tr', {
              key: artifact.id || artifact.name,
              className: selected && selected.id === artifact.id ? 'is-selected' : '',
              onClick: () => setSelected(artifact),
            },
            h('td', { className: 'ffa-name' }, artifact.name),
            h('td', null, h('span', { className: 'ffa-tag' }, artifact.kind || '—')),
            h('td', { className: 'ffa-muted' }, artifact.stage || '—'),
            h('td', { className: 'ffa-muted' }, formatBytes(artifact.bytes))))))),
        h(ArtifactDetail, { artifact: selected, onLoad, onCopy, busy, t }))
    }

    function QcSection({ snap, t }) {
      const qc = snap.qc || {}
      const figures = Array.isArray(qc.figures) ? qc.figures : []
      return h(Card, { title: t('qcNote'), subtitle: qc.status || '' },
        qc.note ? h('div', { className: 'ffa-small ffa-muted' }, qc.note) : null,
        figures.length
          ? h('div', { style: { display: 'grid', gap: 12, marginTop: 10 } }, figures.map((figure) => h('figure', { key: figure.id || figure.asset, className: 'ffa-figure' },
            h('img', { className: 'ffa-img', src: `${snap.assets?.base || '/ffs-analysis/asset/'}${figure.asset}`, alt: figure.label || 'QC figure', loading: 'lazy' }),
            h('figcaption', null, `${figure.label || ''}${figure.caption ? ` · ${figure.caption}` : ''}`))))
          : h('div', { className: 'ffa-empty' }, 'No QC figures in the snapshot.'))
    }

    function ResultsSection({ snap, t, onOpenViewer }) {
      const results = snap.results || {}
      const contrasts = Array.isArray(results.contrasts) ? results.contrasts : []
      const clusters = Array.isArray(results.clusters) ? results.clusters : []
      const preview = results.preview ? `${snap.assets?.base || '/ffs-analysis/asset/'}${results.preview}` : null
      return h(React.Fragment, null,
        h(Card, { title: t('model') },
          h('dl', { className: 'ffa-kv' },
            h('dt', null, 'model'), h('dd', null, results.model || '—'),
            h('dt', null, 'voxels'), h('dd', null, results.voxelsInMask ?? '—'),
            h('dt', null, 'mean R²'), h('dd', null, results.meanR2 ?? '—'),
            h('dt', null, 'sub-bricks'), h('dd', null, results.subBricks ?? '—'))),
        h('div', { className: 'ffa-split' },
          h(Card, { title: t('contrasts') },
            contrasts.length
              ? h('table', { className: 'ffa-table' },
                h('thead', null, h('tr', null, h('th', null, 'contrast'), h('th', null, 'peak'), h('th', null, 'IJK'))),
                h('tbody', null, contrasts.map((contrast) => h('tr', { key: contrast.id || contrast.name },
                  h('td', null, h('div', { className: 'ffa-name' }, contrast.name), h('div', { className: 'ffa-small ffa-muted' }, contrast.subBrick || '')),
                  h('td', null, contrast.peak ?? '—'),
                  h('td', { className: 'ffa-mono' }, Array.isArray(contrast.peakIJK) ? contrast.peakIJK.join(', ') : '—')))))
              : h('div', { className: 'ffa-empty' }, 'No contrasts in the snapshot.'),
            h('div', { className: 'ffa-actions' }, h('button', { className: 'ffa-btn', onClick: onOpenViewer }, t('inspect')))),
          h(Card, { title: t('clusters') },
            clusters.length
              ? h('ul', null, clusters.map((cluster, index) => h('li', { key: index }, JSON.stringify(cluster))))
              : h('div', { className: 'ffa-empty' }, results.clusterNote || 'No cluster table yet.'))),
        preview
          ? h(Card, { title: t('preview') },
            h('img', { className: 'ffa-img', src: preview, alt: 'Analysis preview', loading: 'lazy' }),
            h('div', { className: 'ffa-small ffa-muted', style: { marginTop: 6 } }, `${results.model || ''} · scenes > baseline, t=3.1, hot`))
          : null)
    }

    function CohortSection({ snap, t }) {
      const cohort = snap.cohort || {}
      const subjects = Array.isArray(cohort.subjects) ? cohort.subjects : []
      return h(Card, { title: t('cohortNote'), subtitle: cohort.status || '' },
        h('div', { className: 'ffa-row ffa-small ffa-muted' },
          h('span', null, `${cohort.total ?? subjects.length} total`),
          h('span', null, `· ${cohort.included ?? subjects.length} included`),
          (cohort.variants || []).map((variant) => h('span', { key: variant, className: 'ffa-tag' }, variant))),
        cohort.note ? h('div', { className: 'ffa-small ffa-muted', style: { marginTop: 6 } }, cohort.note) : null,
        subjects.length
          ? h('table', { className: 'ffa-table', style: { marginTop: 10 } },
            h('thead', null, h('tr', null,
              h('th', null, 'subject'), h('th', null, 'S02'), h('th', null, 'S10'), h('th', null, '1st level'), h('th', null, 'QC'), h('th', null, t('variants')))),
            h('tbody', null, subjects.map((subject) => h('tr', { key: subject.id },
              h('td', { className: 'ffa-name' }, subject.id),
              h('td', null, h('span', { className: `ffa-dot is-${statusClass(subject.stages?.stage02)}`, title: subject.stages?.stage02 || '' })),
              h('td', null, h('span', { className: `ffa-dot is-${statusClass(subject.stages?.stage10)}`, title: subject.stages?.stage10 || '' })),
              h('td', null, h('span', { className: `ffa-dot is-${statusClass(subject.stages?.firstLevel)}`, title: subject.stages?.firstLevel || '' })),
              h('td', null, h('span', { className: `ffa-dot is-${statusClass(subject.stages?.qc)}`, title: subject.stages?.qc || '' })),
              h('td', null, (subject.variants || []).map((variant) => h('span', { key: variant, className: 'ffa-tag' }, variant)),
                subject.note ? h('div', { className: 'ffa-small ffa-muted' }, subject.note) : null)))))
          : h('div', { className: 'ffa-empty' }, 'No cohort yet.'))
    }

    function GroupSection({ snap, t }) {
      const group = snap.group || {}
      const analyses = Array.isArray(group.analyses) ? group.analyses : []
      return h(Card, { title: t('groupAnalyses'), subtitle: group.status || '' },
        group.note ? h('div', { className: 'ffa-small ffa-muted' }, group.note) : null,
        analyses.length
          ? analyses.map((analysis) => h('div', {
            key: analysis.id,
            style: {
              marginTop: 8,
              padding: 8,
              background: 'var(--dsw-alias-bg-base)',
              border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: 7,
            },
          },
            h('div', { className: 'ffa-row' },
              h('span', { className: 'ffa-name' }, `${analysis.id} · ${analysis.contrast}`),
              h('span', { className: 'ffa-spacer' }),
              h(StatusPill, { status: analysis.status })),
            h('div', { className: 'ffa-small ffa-muted', style: { marginTop: 4 } },
              `${analysis.design || ''} · ${analysis.engine || ''} · N=${analysis.n ?? '—'} · ${analysis.correction || ''}`)))
          : h('div', { className: 'ffa-empty' }, 'No group analyses yet.'))
    }

    function ProvenanceSection({ snap, t }) {
      const provenance = snap.provenance || {}
      return h(Card, { title: t('provenance') },
        h('div', { className: 'ffa-row' },
          h(StatusPill, { status: provenance.settled ? 'done' : 'draft' }),
          h('span', { className: 'ffa-small ffa-muted' }, provenance.settled ? t('settled') : t('notSettled'))),
        h('dl', { className: 'ffa-kv' },
          h('dt', null, 'artifacts'), h('dd', null, provenance.artifacts ?? '—'),
          h('dt', null, 'script'), h('dd', { className: 'ffa-mono' }, snap.pipeline?.script || '—'),
          h('dt', null, 'log'), h('dd', { className: 'ffa-mono' }, snap.pipeline?.log || '—')),
        h('div', { className: 'ffa-actions' },
          h('button', { className: 'ffa-btn', disabled: true, title: provenance.exportDisabled || '' }, t('export')),
          h('span', { className: 'ffa-small ffa-muted' }, provenance.settledNote || t('exportDisabled'))))
    }

    // ---------------------------------------------------------------- shell
    function AnalysisBody({ ctx, t }) {
      const { data: snap, error, loading, refreshing, refresh } = useSnapshot()
      const [section, setSection] = useState('pipeline')
      const [busy, setBusy] = useState(null)
      const [toast, setToast] = useState(null)

      useEffect(() => {
        if (!toast) return undefined
        const timer = setTimeout(() => setToast(null), 4200)
        return () => clearTimeout(timer)
      }, [toast])

      const openViewer = useCallback(() => {
        try {
          const sidebar = ctx.get('sidebarRight')
          if (sidebar && sidebar.openTab) sidebar.openTab(VIEWER_TAB)
        } catch {
          // no session/controller: nothing to reveal
        }
      }, [ctx])

      const loadIntoViewer = useCallback(async (artifact) => {
        setBusy(artifact.id || artifact.name)
        try {
          const conn = ctx.get('connection')
          if (!conn || !conn.rpc) throw new Error('Harness connection is not ready')
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 60000)
          let result
          try {
            result = await conn.rpc.call('/ffs', 'load_paths', { paths: [artifact.path] }, controller.signal)
          } finally {
            clearTimeout(timer)
          }
          if (!result || result.ok !== true) {
            throw new Error(result?.error?.message || 'the viewer rejected the load')
          }
          setToast(`${artifact.name} ${t('loaded')}`)
          openViewer()
        } catch (e) {
          setToast(`${t('loadFailed')}: ${e && e.message || e}`)
        } finally {
          setBusy(null)
        }
      }, [ctx, openViewer, t])

      const copyPath = useCallback(async (value) => {
        try {
          await navigator.clipboard.writeText(value || '')
          setToast(t('copied'))
        } catch {
          setToast('Clipboard unavailable')
        }
      }, [t])

      if (loading) {
        return h('div', { className: 'ffa-root' }, h('div', { className: 'ffa-content' }, h('div', { className: 'ffa-empty' }, t('loading'))))
      }
      if (error && !snap) {
        return h('div', { className: 'ffa-root' },
          h('div', { className: 'ffa-content' },
            h('div', { className: 'ffa-empty' }, `${t('error')} ${error}`),
            h('div', { className: 'ffa-actions' }, h('button', { className: 'ffa-btn', onClick: refresh }, t('retry')))))
      }

      const pipeline = snap.pipeline || {}
      const counts = {
        pipeline: Array.isArray(pipeline.stages) ? pipeline.stages.length : 0,
        data: Array.isArray(snap.artifacts) ? snap.artifacts.length : 0,
        qc: Array.isArray(snap.qc?.figures) ? snap.qc.figures.length : 0,
        results: Array.isArray(snap.results?.contrasts) ? snap.results.contrasts.length : 0,
        cohort: Array.isArray(snap.cohort?.subjects) ? snap.cohort.subjects.length : 0,
        group: Array.isArray(snap.group?.analyses) ? snap.group.analyses.length : 0,
      }

      let content
      if (section === 'pipeline') content = h(PipelineSection, { snap, t })
      else if (section === 'data') content = h(DataSection, { snap, t, onLoad: loadIntoViewer, onCopy: copyPath, busy })
      else if (section === 'qc') content = h(QcSection, { snap, t })
      else if (section === 'results') content = h(ResultsSection, { snap, t, onOpenViewer: openViewer })
      else if (section === 'cohort') content = h(CohortSection, { snap, t })
      else if (section === 'group') content = h(GroupSection, { snap, t })
      else content = h(ProvenanceSection, { snap, t })

      return h('div', { className: 'ffa-root' },
        h('header', { className: 'ffa-head' },
          h('span', { className: 'ffa-brand', title: t('title') }, h(AnalysisIcon, { size: 15 }), t('title')),
          h('span', { className: 'ffa-sub' }, `${snap.project?.dataset || ''} · ${snap.project?.subject || ''}`),
          h('span', { className: 'ffa-spacer' }),
          h(StatusPill, { status: pipeline.status }),
          h('button', { className: 'ffa-btn', onClick: refresh, disabled: refreshing, title: t('refresh') }, refreshing ? '…' : t('refresh')),
          h('button', { className: 'ffa-btn ffa-btn-primary', onClick: openViewer }, t('openViewer'))),
        h('div', { className: 'ffa-main' },
          h('nav', { className: 'ffa-rail' }, SECTIONS.map((name) => h('button', {
            key: name,
            type: 'button',
            className: `ffa-rail-item${section === name ? ' is-active' : ''}`,
            onClick: () => setSection(name),
          }, h(Icon, { kind: name }), h('span', { className: 'ffa-rail-label' }, t(name)),
          counts[name] !== undefined ? h('span', { className: 'ffa-rail-count' }, counts[name]) : null))),
          h('div', { className: 'ffa-content' }, content)),
        error ? h('div', { className: 'ffa-small', style: { padding: '0 14px 6px', color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
        h('footer', { className: 'ffa-foot' }, `${t('prototype')} · fixtures/demo.json · ${snap.project?.device || ''}`),
        toast ? h('div', { className: 'ffa-toast', role: 'status' }, toast) : null)
    }

    // ---------------------------------------------------------------- plugin
    function slotT(props, t, key, options) {
      try {
        const value = props && props.t ? props.t(key, options) : undefined
        if (typeof value === 'string' && value && value !== key) return value
      } catch {
        // fall through
      }
      return t(key, options)
    }

    return {
      name: 'ffs-analysis',
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        let t = (key) => MESSAGES[key] || humanize(key)
        ctx.effect(() => {
          try {
            ctx.locale.register(LOCALE_NS, { en: MESSAGES })
            const bound = ctx.locale.bind(LOCALE_NS)
            t = (key, options) => {
              let value
              try { value = bound(key, options) } catch { value = undefined }
              return typeof value === 'string' && value && value !== key ? value : (MESSAGES[key] || humanize(key))
            }
          } catch (e) {
            console.warn?.('ffs-analysis: locale registration failed', e)
          }
          return () => {}
        }, 'ffs-analysis: locale')

        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {}
          const style = document.createElement('style')
          style.setAttribute('data-ffs-analysis', '')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'ffs-analysis: styles')

        const openTab = () => {
          try {
            const sidebar = ctx.get('sidebarRight')
            if (sidebar && sidebar.openTab) sidebar.openTab(KIND)
          } catch (e) {
            console.warn?.('ffs-analysis: could not open the docked tab', e)
          }
        }

        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TYPE_ID,
          kind: KIND,
          title: () => t('title'),
          keepMounted: true,
          guide: [{
            id: 'ffs-analysis',
            order: 31,
            title: () => t('title'),
            description: () => t('description'),
            icon: AnalysisIcon,
          }],
        }), 'ffs-analysis: sidebar tab type')

        const Body = (props) => h(AnalysisBody, {
          ctx,
          t: (key, options) => slotT(props, t, key, options),
        })
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: TYPE_ID, locale: LOCALE_NS,
        }, Body)), 'ffs-analysis: sidebar tab body')

        const OpenButton = (props) => h('button', {
          type: 'button',
          className: 'ffa-open-btn',
          title: slotT(props, t, 'open'),
          onClick: openTab,
        }, h(AnalysisIcon, { size: 15 }), h('span', null, slotT(props, t, 'open')))
        ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'ffs-analysis',
          order: 21,
          locale: LOCALE_NS,
          label: () => t('open'),
        }, OpenButton)), 'ffs-analysis: header action')

        // Agent `ffs_analysis_show` must reveal the tab even when it is closed.
        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'ffs-analysis.show-bridge', order: 91,
        }, () => h(ShowBridge, { ctx, openAnalysis: openTab }))), 'ffs-analysis: show bridge')
      },
    }
  },
})
