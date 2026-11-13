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
    const PLAN = '/ffs-analysis/plan'
    const TYPE_ID = '@local/ffs-analysis-ui'
    const KIND = 'ffs-analysis'
    const VIEWER_TAB = 'ffs-viewer'
    const LOCALE_NS = 'ffs-analysis'

    const SECTIONS = ['pipeline', 'data', 'qc', 'results', 'cohort', 'group', 'provenance', 'settings']

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
      settings: 'Settings',
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
      plan: 'Plan pipeline',
      replan: 'Re-plan',
      planning: 'Planning…',
      planDone: 'Plan generated',
      planFailed: 'Plan failed',
      run: 'Run pipeline',
      runStarted: 'Run started',
      runFailed: 'Run failed',
      cancel: 'Cancel',
      cancelRequested: 'Cancel requested',
      current: 'current',
      settle: 'Settle analysis',
      settling: 'Settling…',
      settleFailed: 'Settle failed',
      export: 'Export package',
      exporting: 'Exporting…',
      exported: 'Package exported',
      runGroup: 'Run group analysis',
      groupRunning: 'Running 3dMEMA…',
      groupFailed: 'Group analysis failed',
      validateCohort: 'Validate cohort',
      validating: 'Validating…',
      cohortOk: 'Cohort valid',
      cohortFailed: 'Cohort invalid',
      replay: 'Replay',
      replaying: 'Replaying…',
      replayMatch: 'Replay matches',
      replayMismatch: 'Replay differs',
      resume: 'Resume',
      applyResults: 'Apply threshold',
      verify: 'Verify package',
      verifying: 'Verifying…',
      exportFailed: 'Export failed',
      sourceLive: 'live',
      sourceFixture: 'fixture',
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
.ffa-btn-danger:hover { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
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
.ffa-flow { display: flex; flex-direction: column; gap: 6px; }
.ffa-flow-list { display: flex; flex-direction: column; }
.ffa-flow-step { display: flex; align-items: center; gap: 8px; width: 100%; padding: 2px 6px 2px 2px;
  border: 1px solid transparent; border-radius: 7px; background: transparent; color: inherit; font: inherit;
  text-align: left; cursor: pointer; }
.ffa-flow-step:hover { background: var(--dsw-alias-bg-layer-2); }
.ffa-flow-step.is-selected { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-brand-primary); }
.ffa-flow-rail { position: relative; width: 24px; min-height: 26px; display: flex; align-items: center;
  justify-content: center; align-self: stretch; }
.ffa-flow-rail::before { content: ''; position: absolute; top: 0; bottom: 0; width: 1px;
  background: var(--dsw-alias-border-l1); }
.ffa-flow-step:first-child .ffa-flow-rail::before { top: 50%; }
.ffa-flow-step:last-child .ffa-flow-rail::before { bottom: 50%; }
.ffa-flow-step:not(:last-child) .ffa-flow-rail::after { content: ''; position: absolute; bottom: 0;
  left: 50%; width: 4px; height: 4px; border-right: 1px solid var(--dsw-alias-border-l2);
  border-bottom: 1px solid var(--dsw-alias-border-l2); transform: translateX(-50%) rotate(45deg); }
.ffa-flow-node { position: relative; z-index: 1; width: 22px; height: 22px; border-radius: 50%;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  display: flex; align-items: center; justify-content: center;
  font: 9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--dsw-alias-label-secondary); }
.ffa-flow-node.is-done { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.ffa-flow-node.is-running { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 2px var(--dsw-alias-bg-base), 0 0 0 3px var(--dsw-alias-brand-primary); }
.ffa-flow-node.is-failed { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.ffa-flow-node.is-pending { opacity: .65; }
.ffa-flow-text { display: flex; flex-direction: column; min-width: 0; gap: 0; }
.ffa-flow-name { font-size: 11px; font-weight: 600; }
.ffa-flow-label { font-size: 9px; color: var(--dsw-alias-label-secondary); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; }
.ffa-flow-time { margin-left: auto; font: 9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.ffa-flow-detail { display: flex; align-items: center; gap: 6px; padding: 6px 8px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); }
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
.ffa-pre-log { max-height: 150px; margin-top: 4px; }
.ffa-log { margin-top: 8px; }
.ffa-log-summary { cursor: pointer; font-size: 10px; color: var(--dsw-alias-label-secondary); }
.ffa-log-summary:hover { color: var(--dsw-alias-label-primary); }
.ffa-activity { white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  font: 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
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

    function stageTime(stage) {
      if (!stage || typeof stage.seconds !== 'number') return '—'
      return `${stage.estimated ? '~' : ''}${formatSeconds(stage.seconds)}`
    }

    function statusClass(status) {
      if (status === 'completed' || status === 'done') return 'ok'
      if (status === 'running' || status === 'stopping') return 'running'
      if (status === 'failed' || status === 'error' || status === 'stopped') return 'error'
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
        const timer = setInterval(tick, 2000)
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
    function StageFlow({ stages, t }) {
      const [pickedName, setPickedName] = useState(null)
      const fallback = stages.find((stage) => stage.status === 'running') || stages[stages.length - 1] || null
      const selected = stages.find((stage) => stage.name === pickedName) || fallback
      return h('div', { className: 'ffa-flow' },
        h('div', { className: 'ffa-flow-list' }, stages.map((stage, index) => h('button', {
          key: stage.name,
          type: 'button',
          className: `ffa-flow-step${selected && selected.name === stage.name ? ' is-selected' : ''}`,
          'aria-pressed': Boolean(selected && selected.name === stage.name),
          onClick: () => setPickedName(stage.name),
        },
        h('span', { className: 'ffa-flow-rail', 'aria-hidden': true },
          h('span', { className: `ffa-flow-node is-${stage.status || 'pending'}` }, String(index + 1).padStart(2, '0'))),
        h('span', { className: 'ffa-flow-text' },
          h('span', { className: 'ffa-flow-name' }, stage.name),
          h('span', { className: 'ffa-flow-label' }, stage.label || '')),
        h('span', { className: 'ffa-flow-time' }, stageTime(stage))))),
        selected
          ? h('div', { className: 'ffa-flow-detail' },
            h(StatusPill, { status: selected.status }),
            h('span', { className: 'ffa-small' }, selected.label || ''),
            h('span', { className: 'ffa-small ffa-muted' }, stageTime(selected)),
            h('span', { className: 'ffa-spacer' }),
            h('span', { className: 'ffa-small ffa-muted' }, selected.name))
          : null)
    }

    function PipelineSection({ snap, t, onPlan, planning, onRun, onCancel, runningNow, busyRun }) {
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
            h('span', { className: 'ffa-muted ffa-small' }, `${stages.length} ${t('stages')}`),
            snap.job?.dshId ? h('span', { className: 'ffa-tag', title: 'DSH background job' }, snap.job.dshId) : null,
            h('span', { className: 'ffa-spacer' }),
            h('button', {
              className: 'ffa-btn',
              onClick: onPlan,
              disabled: planning || runningNow,
              title: 'Generate a new ffs_autoproc plan (script only, no execution)',
            }, planning ? t('planning') : (snap.source === 'live' ? t('replan') : t('plan'))),
            runningNow
              ? h('button', {
                className: 'ffa-btn ffa-btn-danger',
                onClick: onCancel,
                disabled: busyRun,
              }, busyRun ? '…' : t('cancel'))
              : (() => {
                const canResume = (pipeline.status === 'failed' || pipeline.status === 'stopped' || pipeline.status === 'cancelled') && Boolean(pipeline.script)
                return h('button', {
                  className: 'ffa-btn ffa-btn-primary',
                  onClick: onRun,
                  disabled: planning || busyRun,
                  title: canResume ? 'Resume: stages with existing outputs are skipped' : 'Execute the generated script',
                }, busyRun ? '…' : (canResume ? t('resume') : t('run')))
              })()),
          pipeline.currentStage || pipeline.error
            ? h('div', { className: 'ffa-small ffa-muted', style: pipeline.error ? { color: 'var(--dsw-alias-state-error-primary)' } : null },
              pipeline.error || `${t('current')} · ${pipeline.currentStage}`)
            : null,
          h('div', { className: 'ffa-progress' }, h('span', { style: { width: `${typeof pipeline.progress === 'number' ? pipeline.progress : completion}%` } })),
          pipeline.activity
            ? h('div', { className: 'ffa-small ffa-muted ffa-activity', title: pipeline.activity }, pipeline.activity)
            : null,
          h(StageFlow, { stages, t }),
          snap.note ? h('div', { className: 'ffa-small ffa-muted' }, snap.note) : null),
        h(Card, { title: t('script') },
          h('dl', { className: 'ffa-kv' },
            h('dt', null, t('script')),
            h('dd', { className: 'ffa-mono' }, pipeline.script || '—'),
            h('dt', null, t('log')),
            h('dd', { className: 'ffa-mono' }, pipeline.log || '—')),
          h('div', { className: 'ffa-small ffa-muted' }, t('command')),
          h('pre', { className: 'ffa-pre' }, pipeline.command || '—'),
          Array.isArray(pipeline.logExcerpt) && pipeline.logExcerpt.length
            ? h('details', { className: 'ffa-log' },
              h('summary', { className: 'ffa-log-summary' }, `Log · last ${pipeline.logExcerpt.length} lines`),
              h('pre', { className: 'ffa-pre ffa-pre-log' }, pipeline.logExcerpt.join('\n')))
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
      const review = qc.review
      return h(Card, { title: t('qcNote'), subtitle: qc.status || '' },
        qc.note ? h('div', { className: 'ffa-small ffa-muted' }, qc.note) : null,
        review && Array.isArray(review.columns) && review.rows?.length
          ? h('div', { style: { marginTop: 10 } },
            h('div', { className: 'ffa-label' }, `${review.path} · ${review.rowsCount} row(s) · ${review.columns.length} columns`),
            (() => {
              const preferred = ['label', 'moco.fd_mean', 'moco.fd_max', 'moco.tsnr_median', 'moco.outlier_mean', 'reml.fstat_frac_sig', 'reml.tsnr_gain']
              const picked = preferred.map((name) => review.columns.indexOf(name)).filter((index) => index >= 0)
              const indices = picked.length ? picked : review.columns.map((_, index) => index).slice(0, 7)
              return h('div', { style: { overflowX: 'auto' } },
                h('table', { className: 'ffa-table' },
                  h('thead', null, h('tr', null, indices.map((index) => h('th', { key: index }, review.columns[index])))),
                  h('tbody', null, review.rows.slice(0, 12).map((row, rowIndex) => h('tr', { key: rowIndex },
                    indices.map((index) => h('td', { key: index, className: 'ffa-mono ffa-small' }, row[index] ?? '')))))))
            })())
          : null,
        figures.length
          ? h('div', { style: { display: 'grid', gap: 12, marginTop: 10 } }, figures.map((figure) => h('figure', { key: figure.id || figure.asset, className: 'ffa-figure' },
            h('img', { className: 'ffa-img', src: `${snap.assets?.base || '/ffs-analysis/asset/'}${figure.asset}`, alt: figure.label || 'QC figure', loading: 'lazy' }),
            h('figcaption', null, `${figure.label || ''}${figure.caption ? ` · ${figure.caption}` : ''}`))))
          : h('div', { className: 'ffa-empty' }, 'No QC figures in the snapshot.'),
        Array.isArray(qc.screenshots) && qc.screenshots.length
          ? h('div', { style: { marginTop: 12 } },
            h('div', { className: 'ffa-label' }, 'viewer screenshots'),
            h('div', { style: { display: 'grid', gap: 12, marginTop: 6 } }, qc.screenshots.map((shot) => h('figure', { key: shot.id || shot.asset, className: 'ffa-figure' },
              h('img', { className: 'ffa-img', src: `${snap.assets?.base || '/ffs-analysis/project-asset/'}${shot.asset}`, alt: shot.label || 'viewer screenshot', loading: 'lazy' }),
              h('figcaption', null, shot.label || '')))))
          : null,
        snap.surface && snap.surface.available
          ? h('div', { style: { marginTop: 12 } },
            h('div', { className: 'ffa-label' }, 'surface GLM · fsaverage'),
            snap.surface.screenshot
              ? h('figure', { className: 'ffa-figure' },
                h('img', { className: 'ffa-img', src: `${snap.assets?.base || '/ffs-analysis/project-asset/'}${snap.surface.screenshot}`, alt: 'fsaverage surface GLM', loading: 'lazy' }))
              : null,
            h('div', { className: 'ffa-small ffa-muted' },
              `${(snap.surface.hemis || []).join(', ')} · ${(snap.surface.labels || []).join(', ')} · ${(snap.surface.files || []).length} GIFTI`))
          : null)
    }

    function ResultsSection({ snap, t, onInspect, onApplyResults, applyingResults }) {
      const results = snap.results || {}
      const [threshold, setThreshold] = React.useState(results.threshold ?? 3.1)
      const [minCluster, setMinCluster] = React.useState(results.minCluster ?? 10)
      const contrasts = Array.isArray(results.contrasts) ? results.contrasts : []
      const clusters = Array.isArray(results.clusters) ? results.clusters : []
      const preview = results.preview ? `${snap.assets?.base || '/ffs-analysis/asset/'}${results.preview}` : null
      const inspectCluster = (cluster) => onInspect({
        name: cluster.contrast,
        subBrickIndex: cluster.subBrickIndex,
        threshold: cluster.threshold,
        peakIJK: cluster.ijk,
      }, cluster.ijk)
      return h(React.Fragment, null,
        h(Card, { title: t('model'), subtitle: results.threshold ? `t ≥ ${results.threshold}` : '' },
          h('dl', { className: 'ffa-kv' },
            h('dt', null, 'model'), h('dd', null, results.model || '—'),
            h('dt', null, 'voxels'), h('dd', null, results.voxelsInMask ?? '—'),
            h('dt', null, 'sub-bricks'), h('dd', null, results.subBricks ?? '—'),
            h('dt', null, 'threshold'), h('dd', null, results.threshold ?? '—'),
            h('dt', null, 'min cluster'), h('dd', null, results.minCluster ?? '—')),
          h('div', { className: 'ffa-row', style: { marginTop: 6 } },
            h('label', { className: 'ffa-small' }, 't ≥ ',
              h('input', { className: 'ffa-input', type: 'number', min: 0.5, max: 20, step: 0.1, value: threshold,
                onChange: (event) => setThreshold(Number(event.target.value)) })),
            h('label', { className: 'ffa-small' }, 'min vox ',
              h('input', { className: 'ffa-input', type: 'number', min: 1, max: 500, step: 1, value: minCluster,
                onChange: (event) => setMinCluster(Number(event.target.value)) })),
            h('button', { className: 'ffa-btn', onClick: () => onApplyResults({ threshold, minCluster }), disabled: applyingResults },
              applyingResults ? '…' : t('applyResults')))),
        h('div', { className: 'ffa-split' },
          h(Card, { title: t('contrasts'), subtitle: `${contrasts.length}` },
            contrasts.length
              ? h('table', { className: 'ffa-table' },
                h('thead', null, h('tr', null,
                  h('th', null, 'contrast'), h('th', null, 'peak t'), h('th', null, 'IJK'), h('th', null, ''))),
                h('tbody', null, contrasts.map((contrast) => h('tr', { key: contrast.id || contrast.name },
                  h('td', null, h('div', { className: 'ffa-name' }, contrast.name), h('div', { className: 'ffa-small ffa-muted' }, contrast.subBrick || '')),
                  h('td', null, contrast.peak ?? '—'),
                  h('td', { className: 'ffa-mono' }, Array.isArray(contrast.peakIJK) ? contrast.peakIJK.join(', ') : '—'),
                  h('td', null, h('button', {
                    className: 'ffa-btn',
                    onClick: (event) => { event.stopPropagation(); onInspect(contrast) },
                  }, t('inspect')))))))
              : h('div', { className: 'ffa-empty' }, 'No contrasts in the snapshot.'),
            h('div', { className: 'ffa-actions' },
              h('span', { className: 'ffa-small ffa-muted' }, 'Loads the mean + bucket in the viewer and sets the overlay.'))),
          h(Card, { title: t('clusters'), subtitle: `${clusters.length}` },
            clusters.length
              ? h('table', { className: 'ffa-table' },
                h('thead', null, h('tr', null,
                  h('th', null, 'contrast'), h('th', null, 'vox'), h('th', null, 'peak t'), h('th', null, 'IJK'), h('th', null, 'mm'))),
                h('tbody', null, clusters.map((cluster) => h('tr', { key: cluster.id, onClick: () => inspectCluster(cluster) },
                  h('td', { className: 'ffa-name' }, cluster.contrast),
                  h('td', null, cluster.size),
                  h('td', null, cluster.peakT),
                  h('td', { className: 'ffa-mono' }, Array.isArray(cluster.ijk) ? cluster.ijk.join(', ') : '—'),
                  h('td', { className: 'ffa-mono ffa-small' }, Array.isArray(cluster.mm) ? cluster.mm.join(', ') : '—')))))
              : h('div', { className: 'ffa-empty' }, results.clusterNote || 'No cluster table yet.'))),
        preview
          ? h(Card, { title: t('preview') },
            h('img', { className: 'ffa-img', src: preview, alt: 'Analysis preview', loading: 'lazy' }),
            h('div', { className: 'ffa-small ffa-muted', style: { marginTop: 6 } }, `${results.model || ''} · scenes > baseline, t=3.1, hot`))
          : null)
    }

    function CohortSection({ snap, t, onValidate, validating, validation, onToggleInclude }) {
      const cohort = snap.cohort || snap.group?.cohort || {}
      const subjects = Array.isArray(cohort.subjects) ? cohort.subjects : []
      const checked = new Map((validation?.subjects || []).map((item) => [item.id, item]))
      const [detail, setDetail] = React.useState(null)
      return h(Card, { title: t('cohortNote'), subtitle: cohort.status || '' },
        h('div', { className: 'ffa-row' },
          h('span', { className: 'ffa-small ffa-muted' },
            `${cohort.total ?? subjects.length} subject(s) · ${cohort.included ?? '—'} included`),
          h('span', { className: 'ffa-spacer' }),
          validation
            ? h(StatusPill, { status: validation.ok ? 'completed' : 'failed' })
            : null,
          h('button', {
            className: 'ffa-btn',
            onClick: onValidate,
            disabled: validating || !subjects.length,
          }, validating ? t('validating') : t('validateCohort'))),
        validation
          ? h('div', { className: 'ffa-small', style: { marginTop: 4, color: validation.ok ? 'var(--dsw-alias-state-success-primary, #2e7d32)' : 'var(--dsw-alias-state-error-primary)' } },
            `${validation.ok ? t('cohortOk') : t('cohortFailed')} · ${validation.checkedAt}`)
          : (cohort.note ? h('div', { className: 'ffa-small ffa-muted' }, cohort.note) : null),
        subjects.length
          ? h('table', { className: 'ffa-table', style: { marginTop: 8 } },
            h('thead', null, h('tr', null,
              h('th', null, 'in'), h('th', null, 'subject'), h('th', null, 'status'), h('th', null, 'variants'), h('th', null, 'work dir'))),
            h('tbody', null, subjects.map((subject) => {
              const check = checked.get(subject.id)
              const issues = check?.issues || []
              return h(React.Fragment, { key: subject.id },
                h('tr', {
                  onClick: () => setDetail(detail === subject.id ? null : subject.id),
                  style: { cursor: 'pointer' },
                  title: 'Show subject details',
                },
                h('td', null, h('input', {
                  type: 'checkbox', checked: subject.include !== false,
                  'aria-label': `include ${subject.id}`,
                  onClick: (event) => event.stopPropagation(),
                  onChange: (event) => onToggleInclude(subject.subject, event.target.checked),
                })),
                h('td', { className: 'ffa-name' }, subject.id),
                h('td', null, h(StatusPill, { status: issues.length ? 'failed' : subject.status })),
                h('td', { className: 'ffa-small' }, (subject.variants || []).map((variant) => variant.id).join(', ') || 'canonical'),
                h('td', null,
                  h('div', { className: 'ffa-mono ffa-small' }, subject.workDir || '—'),
                  issues.length
                    ? h('div', { className: 'ffa-small', style: { color: 'var(--dsw-alias-state-error-primary)' } },
                      issues.map((issue) => issue.code).join(', '))
                    : null)),
                detail === subject.id
                  ? h('tr', { key: 'detail' },
                    h('td', { colSpan: 5, style: { background: 'var(--dsw-alias-bg-base)', padding: 8 } },
                      h('div', { className: 'ffa-small' },
                        h('div', null, h('strong', null, 'work dir '), h('span', { className: 'ffa-mono' }, subject.workDir || '—')),
                        h('div', null, h('strong', null, 'stats '), h('span', { className: 'ffa-mono' }, subject.stats || '—')),
                        h('div', { style: { marginTop: 4 } }, h('strong', null, 'variants')),
                        (subject.variants || []).map((variant) => h('div', { key: variant.id, className: 'ffa-mono ffa-small' },
                          `${variant.id} · ${variant.status} · ${variant.workDir || '—'} · ${variant.stats || 'no stats'}`)),
                        check?.issues?.length
                          ? h('div', { style: { marginTop: 4, color: 'var(--dsw-alias-state-error-primary)' } },
                            check.issues.map((issue) => `${issue.code}: ${issue.message}`).join(' · '))
                          : h('div', { className: 'ffa-small ffa-muted', style: { marginTop: 4 } }, 'validation: ok'))))
                  : null)
            })))
          : h('div', { className: 'ffa-empty' }, 'No subjects discovered under the cohort work root.'))
    }

    function GroupSection({ snap, t, onRunGroup, runningGroup, onInspectGroup }) {
      const group = snap.group || {}
      const cohort = group.cohort || snap.cohort || {}
      const analyses = Array.isArray(group.analyses) ? group.analyses : []
      const subjects = Array.isArray(cohort.subjects) ? cohort.subjects : []
      const [model, setModel] = React.useState('one-sample')
      const [engine, setEngine] = React.useState('3dMEMA')
      const [correction, setCorrection] = React.useState('none')
      const suggestedA = subjects.filter((_, index) => index % 2 === 0).map((subject) => subject.subject).join(', ')
      const suggestedB = subjects.filter((_, index) => index % 2 === 1).map((subject) => subject.subject).join(', ')
      const [groupA, setGroupA] = React.useState('')
      const [groupB, setGroupB] = React.useState('')
      const parseIds = (value) => String(value || '').split(/[\s,]+/).map((item) => item.trim().replace(/^sub-/, '')).filter(Boolean)
      const effectiveEngine = model === 'two-group' ? '3dttest++' : engine
      const a = parseIds(groupA || suggestedA)
      const b = parseIds(groupB || suggestedB)
      const splitOk = model !== 'two-group' || (a.length >= 2 && b.length >= 2)
      const canRun = (cohort.included || 0) >= 2 && !runningGroup && splitOk
      const run = () => onRunGroup({
        contrast: 'scenes',
        model,
        engine: effectiveEngine,
        correction,
        groups: model === 'two-group' ? { a, b } : undefined,
      })
      const correctionText = (analysis) => {
        const fix = analysis.correction
        if (!fix) return 'uncorrected'
        if (fix.error) return `${fix.method}: ${fix.error}`
        return `${fix.method} · n=${fix.nPerm} · cluster≥${fix.clusterThreshold}`
      }
      return h(Card, { title: t('groupAnalyses'), subtitle: `${analyses.length}` },
        h('div', { className: 'ffa-small ffa-muted', style: { marginBottom: 8 } },
          `${cohort.included || 0} subjects · fixed effects: one-sample 3dMEMA / two-group 3dttest++`),
        h('div', { className: 'ffa-row', style: { flexWrap: 'wrap', gap: 6 } },
          h('label', { className: 'ffa-small' }, 'design ',
            h('select', { className: 'ffa-input', value: model, onChange: (event) => setModel(event.target.value) },
              h('option', { value: 'one-sample' }, 'one-sample'),
              h('option', { value: 'two-group' }, 'two-group'))),
          h('label', { className: 'ffa-small' }, 'engine ',
            h('select', {
              className: 'ffa-input', value: effectiveEngine,
              disabled: model === 'two-group',
              title: model === 'two-group' ? 'two-group designs use 3dttest++ only' : '',
              onChange: (event) => setEngine(event.target.value),
            },
              h('option', { value: '3dMEMA' }, '3dMEMA'),
              h('option', { value: '3dttest++' }, '3dttest++'))),
          h('label', { className: 'ffa-small' }, 'correction ',
            h('select', { className: 'ffa-input', value: correction, onChange: (event) => setCorrection(event.target.value) },
              h('option', { value: 'none' }, 'none'),
              h('option', { value: 'cluster' }, 'cluster size'),
              h('option', { value: 'permutation' }, 'permutation FWE'))),
          h('span', { className: 'ffa-spacer' }),
          h('button', { className: 'ffa-btn ffa-btn-primary', onClick: run, disabled: !canRun },
            runningGroup ? t('groupRunning') : t('runGroup'))),
        model === 'two-group'
          ? h('div', { className: 'ffa-row', style: { marginTop: 6, gap: 6 } },
            h('label', { className: 'ffa-small' }, 'A ',
              h('input', { className: 'ffa-input', value: groupA, placeholder: suggestedA, onChange: (event) => setGroupA(event.target.value) })),
            h('label', { className: 'ffa-small' }, 'B ',
              h('input', { className: 'ffa-input', value: groupB, placeholder: suggestedB, onChange: (event) => setGroupB(event.target.value) })),
            h('span', { className: 'ffa-small ffa-muted' }, `${a.length} vs ${b.length} (ids without sub-)`))
          : null,
        group.note ? h('div', { className: 'ffa-small ffa-muted', style: { marginTop: 6 } }, group.note) : null,
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
              h(StatusPill, { status: analysis.status || analysis.error ? 'failed' : 'completed' })),
            h('div', { className: 'ffa-small ffa-muted', style: { marginTop: 4 } },
              `${analysis.model || analysis.design || ''} · ${analysis.engine || ''} · ${(analysis.nA || analysis.n) ?? '—'}${analysis.nB ? ` vs ${analysis.nB}` : ''} · ${correctionText(analysis)}`),
            analysis.correction && analysis.correction.error
              ? h('div', { className: 'ffa-small', style: { color: 'var(--dsw-alias-state-error-primary)', marginTop: 4 } }, analysis.correction.error)
              : null,
            analysis.clusters?.length
              ? h('table', { className: 'ffa-table', style: { marginTop: 6 } },
                h('thead', null, h('tr', null,
                  h('th', null, 'vox'), h('th', null, 'peak t'), h('th', null, 'p'), h('th', null, 'IJK'), h('th', null, ''))),
                h('tbody', null, analysis.clusters.slice(0, 10).map((cluster) => h('tr', {
                  key: cluster.id,
                  onClick: () => onInspectGroup(analysis, cluster.ijk),
                },
                h('td', null, cluster.size),
                h('td', null, cluster.peakT),
                h('td', { className: 'ffa-mono' }, cluster.p == null ? '—' : Number(cluster.p).toFixed(3)),
                h('td', { className: 'ffa-mono' }, Array.isArray(cluster.ijk) ? cluster.ijk.join(', ') : '—'),
                h('td', null, h('button', {
                  className: 'ffa-btn',
                  onClick: (event) => { event.stopPropagation(); onInspectGroup(analysis, cluster.ijk) },
                }, t('inspect')))))))
              : h('div', { className: 'ffa-small ffa-muted', style: { marginTop: 4 } }, analysis.error || 'no clusters')))
          : h('div', { className: 'ffa-empty' }, 'No group analyses yet.'))
    }

    function SettingsSection({ snap, t, onApplyResults, applyingResults }) {
      const project = snap.project || {}
      const [threshold, setThreshold] = React.useState(snap.results?.threshold ?? 3.1)
      const [minCluster, setMinCluster] = React.useState(snap.results?.minCluster ?? 10)
      return h(Card, { title: t('settings') },
        h('dl', { className: 'ffa-kv' },
          h('dt', null, 'dataset'), h('dd', null, project.dataset || '—'),
          h('dt', null, 'subject'), h('dd', null, project.subject || '—'),
          h('dt', null, 'bids root'), h('dd', { className: 'ffa-mono' }, project.root || '—'),
          h('dt', null, 'project state'), h('dd', { className: 'ffa-mono' }, snap.state || '—'),
          h('dt', null, 'run state'), h('dd', { className: 'ffa-mono' }, snap.runState || '—')),
        h('div', { className: 'ffa-label', style: { marginTop: 8 } }, 'result defaults'),
        h('div', { className: 'ffa-row' },
          h('label', { className: 'ffa-small' }, 't ≥ ',
            h('input', { className: 'ffa-input', type: 'number', min: 0.5, max: 20, step: 0.1,
              'aria-label': 'default cluster threshold', value: threshold,
              onChange: (event) => setThreshold(Number(event.target.value)) })),
          h('label', { className: 'ffa-small' }, 'min vox ',
            h('input', { className: 'ffa-input', type: 'number', min: 1, max: 500, step: 1,
              'aria-label': 'default minimum cluster size', value: minCluster,
              onChange: (event) => setMinCluster(Number(event.target.value)) })),
          h('button', { className: 'ffa-btn', onClick: () => onApplyResults({ threshold, minCluster }), disabled: applyingResults },
            applyingResults ? '…' : t('applyResults'))),
        h('div', { className: 'ffa-small ffa-muted', style: { marginTop: 8 } },
          'Tools: ffs_tool_run (argv escape hatch), ffs_replay, ffs_analysis_verify; cohort and group settings live in their sections.'))
    }

    function ProvenanceSection({ snap, t, onSettle, onExport, onReplay, onVerify, busyAction, replaying, replayResult, verifying, verifyResult, onCopy }) {
      const provenance = snap.provenance || {}
      const completed = snap.pipeline?.status === 'completed'
      return h(Card, { title: t('provenance') },
        h('div', { className: 'ffa-row' },
          h(StatusPill, { status: provenance.settled ? 'done' : 'draft' }),
          h('span', { className: 'ffa-small ffa-muted' }, provenance.settled ? t('settled') : t('notSettled')),
          provenance.settledId ? h('span', { className: 'ffa-tag' }, provenance.settledId) : null),
        h('dl', { className: 'ffa-kv' },
          h('dt', null, 'artifacts'), h('dd', null, provenance.artifacts ?? '—'),
          h('dt', null, 'script'), h('dd', { className: 'ffa-mono' }, snap.pipeline?.script || '—'),
          h('dt', null, 'log'), h('dd', { className: 'ffa-mono' }, snap.pipeline?.log || '—')),
        provenance.exportPath
          ? h('div', { className: 'ffa-row' },
            h('span', { className: 'ffa-small ffa-muted' }, 'package'),
            h('span', { className: 'ffa-mono ffa-small' }, provenance.exportPath),
            h('button', { className: 'ffa-btn', onClick: () => onCopy(provenance.exportPath) }, t('copyPath')))
          : null,
        h('div', { className: 'ffa-actions' },
          h('button', {
            className: 'ffa-btn ffa-btn-primary',
            onClick: onSettle,
            disabled: !completed || provenance.settled || busyAction === 'settle',
            title: completed ? 'Freeze plan, run, artifacts and results' : 'Run the plan to completion first',
          }, busyAction === 'settle' ? t('settling') : (provenance.settled ? t('settled') : t('settle'))),
          h('button', {
            className: 'ffa-btn',
            onClick: onExport,
            disabled: !provenance.settled || busyAction === 'export',
            title: 'Build the reproducible package (scripts, STEPS.md, METHODS.md)',
          }, busyAction === 'export' ? t('exporting') : t('export')),
          h('button', {
            className: 'ffa-btn',
            onClick: onReplay,
            disabled: !completed || replaying,
            title: 'Replay the frozen pipeline in a fresh work dir and compare the stats bucket',
          }, replaying ? t('replaying') : t('replay')),
          h('button', {
            className: 'ffa-btn',
            onClick: onVerify,
            disabled: !provenance.exportPath || verifying,
            title: 'Check every package checksum',
          }, verifying ? t('verifying') : t('verify')),
          h('span', { className: 'ffa-small ffa-muted' }, provenance.settledNote || '')),
        replayResult
          ? h('div', { className: 'ffa-small', style: { marginTop: 4 } },
            `${replayResult.match ? t('replayMatch') : t('replayMismatch')} · exact=${replayResult.exact ? 'yes' : 'no'} · ` +
            `${replayResult.comparison && replayResult.comparison.maxAbsDiff != null ? `max Δ=${Number(replayResult.comparison.maxAbsDiff).toExponential(2)}` : ''} · ` +
            `${replayResult.dest || ''}`)
          : null,
        verifyResult
          ? h('div', { className: 'ffa-small', style: { marginTop: 4 } },
            `${verifyResult.ok ? 'package ok' : 'package FAILED'} · checked ${verifyResult.checked} · mismatches ${(verifyResult.mismatches || []).length}`)
          : null,
        provenance.settledAt
          ? h('div', { className: 'ffa-small ffa-muted' }, `settled ${provenance.settledAt}`)
          : null)
    }

    // ---------------------------------------------------------------- shell
    function AnalysisBody({ ctx, t }) {
      const { data: snap, error, loading, refreshing, refresh } = useSnapshot()
      const [section, setSection] = useState('pipeline')
      const [busy, setBusy] = useState(null)
      const [planning, setPlanning] = useState(false)
      const [busyRun, setBusyRun] = useState(false)
      const [busyAction, setBusyAction] = useState(null)
      const [busyGroup, setBusyGroup] = useState(false)
      const [busyCohort, setBusyCohort] = useState(false)
      const [replaying, setReplaying] = useState(false)
      const [replayResult, setReplayResult] = useState(null)
      const [applyingResults, setApplyingResults] = useState(false)
      const [verifying, setVerifying] = useState(false)
      const [verifyResult, setVerifyResult] = useState(null)
      const [cohortValidation, setCohortValidation] = useState(null)
      const [toast, setToast] = useState(null)

      useEffect(() => {
        if (!toast) return undefined
        const timer = setTimeout(() => setToast(null), 4200)
        return () => clearTimeout(timer)
      }, [toast])

      const planPipeline = useCallback(async () => {
        setPlanning(true)
        try {
          const res = await fetch(PLAN, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          })
          const payload = await res.json().catch(() => null)
          if (!res.ok || !payload || payload.ok !== true) {
            throw new Error(payload?.error?.message || `plan failed (${res.status})`)
          }
          setToast(`${t('planDone')} · ${payload.stages ?? '?'} stages`)
          await refresh()
        } catch (e) {
          setToast(`${t('planFailed')}: ${e && e.message || e}`)
        } finally {
          setPlanning(false)
        }
      }, [refresh, t])

      const runPipeline = useCallback(async () => {
        setBusyRun(true)
        try {
          const res = await fetch('/ffs-analysis/run', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          const payload = await res.json().catch(() => null)
          if (!res.ok || !payload || payload.ok !== true) {
            throw new Error(payload?.error?.message || `run failed (${res.status})`)
          }
          setToast(t('runStarted'))
          await refresh()
        } catch (e) {
          setToast(`${t('runFailed')}: ${e && e.message || e}`)
        } finally {
          setBusyRun(false)
        }
      }, [refresh, t])

      const cancelPipeline = useCallback(async () => {
        setBusyRun(true)
        try {
          const res = await fetch('/ffs-analysis/cancel', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          const payload = await res.json().catch(() => null)
          if (!res.ok || !payload || payload.ok !== true) {
            throw new Error(payload?.error?.message || `cancel failed (${res.status})`)
          }
          setToast(t('cancelRequested'))
          await refresh()
        } catch (e) {
          setToast(`${t('runFailed')}: ${e && e.message || e}`)
        } finally {
          setBusyRun(false)
        }
      }, [refresh, t])

      const callViewer = useCallback(async (endpoint, payload) => {
        const conn = ctx.get('connection')
        if (!conn || !conn.rpc) throw new Error('Harness connection is not ready')
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 60000)
        try {
          const result = await conn.rpc.call('/ffs', endpoint, payload, controller.signal)
          if (!result || result.ok !== true) throw new Error(result?.error?.message || `${endpoint} failed`)
          return result.value
        } finally {
          clearTimeout(timer)
        }
      }, [ctx])

      const settleAnalysis = useCallback(async () => {
        setBusyAction('settle')
        try {
          const res = await fetch('/ffs-analysis/settle', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' }, body: '{}',
          })
          const payload = await res.json().catch(() => null)
          if (!res.ok || !payload || payload.ok !== true) {
            throw new Error(payload?.error?.message || `settle failed (${res.status})`)
          }
          setToast(`Settled · ${payload.id || ''}`)
          await refresh()
        } catch (e) {
          setToast(`${t('settleFailed')}: ${e && e.message || e}`)
        } finally {
          setBusyAction(null)
        }
      }, [refresh, t])

      const exportAnalysis = useCallback(async () => {
        setBusyAction('export')
        try {
          const res = await fetch('/ffs-analysis/export', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' }, body: '{}',
          })
          const payload = await res.json().catch(() => null)
          if (!res.ok || !payload || payload.ok !== true) {
            throw new Error(payload?.error?.message || `export failed (${res.status})`)
          }
          setToast(`${t('exported')} · ${payload.path || ''}`)
          await refresh()
        } catch (e) {
          setToast(`${t('exportFailed')}: ${e && e.message || e}`)
        } finally {
          setBusyAction(null)
        }
      }, [refresh, t])

      const verifyPackageUi = useCallback(async () => {
        setVerifying(true)
        try {
          const dir = snap?.provenance?.exportPath
          if (!dir) throw new Error('export the package first')
          const res = await fetch('/ffs-analysis/verify', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ dir }),
          })
          const payload = await res.json().catch(() => null)
          if (!res.ok || !payload) throw new Error(payload?.error?.message || `verify failed (${res.status})`)
          setVerifyResult(payload)
          setToast(payload.ok ? 'package verified' : 'package has mismatches')
        } catch (e) {
          setToast(`verify failed: ${e && e.message || e}`)
        } finally {
          setVerifying(false)
        }
      }, [snap])

      const applyResultsView = useCallback(async (options) => {
        setApplyingResults(true)
        try {
          const res = await fetch('/ffs-analysis/results', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(options),
          })
          const payload = await res.json().catch(() => null)
          if (!res.ok || !payload) throw new Error(payload?.error?.message || `results failed (${res.status})`)
          setToast(`results: t ≥ ${payload.threshold} · min ${payload.minCluster} vox`)
          await refresh()
        } catch (e) {
          setToast(`results failed: ${e && e.message || e}`)
        } finally {
          setApplyingResults(false)
        }
      }, [refresh])

      const toggleCohortInclude = useCallback(async (subject, include) => {
        try {
          const res = await fetch('/ffs-analysis/cohort', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'include', subject, include }),
          })
          if (!res.ok) throw new Error(`include failed (${res.status})`)
          await refresh()
        } catch (e) {
          setToast(`cohort: ${e && e.message || e}`)
        }
      }, [refresh])

      const replayPipeline = useCallback(async () => {
        setReplaying(true)
        try {
          const res = await fetch('/ffs-analysis/replay', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          })
          const payload = await res.json().catch(() => null)
          if (!res.ok || !payload) throw new Error(payload?.error?.message || `replay failed (${res.status})`)
          setReplayResult(payload)
          setToast(payload.match ? t('replayMatch') : t('replayMismatch'))
        } catch (e) {
          setToast(`${t('replayMismatch')}: ${e && e.message || e}`)
        } finally {
          setReplaying(false)
        }
      }, [t])

      const validateCohortUi = useCallback(async () => {
        setBusyCohort(true)
        try {
          const res = await fetch('/ffs-analysis/cohort', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'validate' }),
          })
          const payload = await res.json().catch(() => null)
          if (!res.ok || !payload || !payload.validation) {
            throw new Error(payload?.error?.message || `validation failed (${res.status})`)
          }
          setCohortValidation(payload.validation)
          setToast(payload.validation.ok ? t('cohortOk') : t('cohortFailed'))
        } catch (e) {
          setToast(`${t('cohortFailed')}: ${e && e.message || e}`)
        } finally {
          setBusyCohort(false)
        }
      }, [t])

      const runGroup = useCallback(async (options = {}) => {
        setBusyGroup(true)
        try {
          const res = await fetch('/ffs-analysis/group', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ contrast: 'scenes', ...options }),
          })
          const payload = await res.json().catch(() => null)
          if (!res.ok || !payload || payload.ok !== true) {
            throw new Error(payload?.error?.message || `group failed (${res.status})`)
          }
          setToast(`Group · ${payload.n} subjects · ${Array.isArray(payload.clusters) ? payload.clusters.length : 0} clusters`)
          await refresh()
        } catch (e) {
          setToast(`${t('groupFailed')}: ${e && e.message || e}`)
        } finally {
          setBusyGroup(false)
        }
      }, [refresh, t])

      const openViewer = useCallback(() => {
        try {
          const sidebar = ctx.get('sidebarRight')
          if (sidebar && sidebar.openTab) sidebar.openTab(VIEWER_TAB)
        } catch {
          // no session/controller: nothing to reveal
        }
      }, [ctx])

      const loadResultInViewer = useCallback(async ({ statsPath, meanPath, contrast, ijk }) => {
        if (!statsPath) {
          setToast('No stats bucket yet')
          openViewer()
          return
        }
        try {
          const display = []
          if (meanPath) display.push(`SET_UNDERLAY ${meanPath}`)
          display.push(`SET_OVERLAY ${statsPath}`)
          await callViewer('execute_batch', { lines: display })
          const state = await callViewer('state', {})
          const layers = Array.isArray(state?.layers) ? state.layers : []
          const overlay = [...layers].reverse().find((layer) => layer.path === statsPath && /^O/.test(layer.key))
            || [...layers].reverse().find((layer) => layer.path === statsPath)
          const lines = []
          if (overlay) {
            lines.push(`SET_VOLUME ${overlay.key} ${contrast.subBrickIndex ?? 0}`)
            lines.push(`SET_THRESHOLD ${overlay.key} ${contrast.threshold ?? 3.1}`)
            lines.push(`SET_SIGN ${overlay.key} pos`)
            lines.push(`SET_COLORMAP ${overlay.key} hot`)
          }
          const target = ijk || contrast.peakIJK
          if (Array.isArray(target) && target.length === 3) lines.push(`SET_IJK ${target.join(' ')}`)
          if (lines.length) await callViewer('execute_batch', { lines })
          const duplicates = layers
            .filter((layer) => layer.path === statsPath || (meanPath && layer.path === meanPath))
            .filter((layer) => !/^[UO]/.test(layer.key))
          if (duplicates.length) {
            await callViewer('execute_batch', {
              lines: duplicates.map((layer) => `REMOVE_LAYER ${layer.key}`),
            }).catch(() => {})
          }
          openViewer()
          setToast(`Viewer · ${contrast.name || 'results'}`)
        } catch (e) {
          setToast(`Viewer failed: ${e && e.message || e}`)
        }
      }, [callViewer, openViewer])

      const inspectResults = useCallback((contrast, jumpIJK) => loadResultInViewer({
        statsPath: snap?.results?.statsPath,
        meanPath: snap?.results?.meanPath,
        contrast,
        ijk: jumpIJK,
      }), [loadResultInViewer, snap])

      const inspectGroup = useCallback((analysis, jumpIJK) => {
        const first = (analysis.contrasts && analysis.contrasts[0]) || {
          name: analysis.contrast,
          subBrickIndex: 0,
          threshold: analysis.threshold,
        }
        return loadResultInViewer({
          statsPath: analysis.statsPath,
          meanPath: analysis.meanPath,
          contrast: first,
          ijk: jumpIJK || first.peakIJK,
        })
      }, [loadResultInViewer])

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
      const runningNow = pipeline.status === 'running' || pipeline.status === 'stopping'
      const counts = {
        pipeline: Array.isArray(pipeline.stages) ? pipeline.stages.length : 0,
        data: Array.isArray(snap.artifacts) ? snap.artifacts.length : 0,
        qc: Array.isArray(snap.qc?.figures) ? snap.qc.figures.length : 0,
        results: Array.isArray(snap.results?.contrasts) ? snap.results.contrasts.length : 0,
        cohort: Array.isArray(snap.cohort?.subjects) ? snap.cohort.subjects.length : 0,
        group: Array.isArray(snap.group?.analyses) ? snap.group.analyses.length : 0,
      }

      let content
      if (section === 'pipeline') content = h(PipelineSection, { snap, t, onPlan: planPipeline, planning, onRun: runPipeline, onCancel: cancelPipeline, runningNow, busyRun })
      else if (section === 'data') content = h(DataSection, { snap, t, onLoad: loadIntoViewer, onCopy: copyPath, busy })
      else if (section === 'qc') content = h(QcSection, { snap, t })
      else if (section === 'results') content = h(ResultsSection, { snap, t, onInspect: inspectResults, onApplyResults: applyResultsView, applyingResults })
      else if (section === 'cohort') content = h(CohortSection, { snap, t, onValidate: validateCohortUi, validating: busyCohort, validation: cohortValidation, onToggleInclude: toggleCohortInclude })
      else if (section === 'group') content = h(GroupSection, { snap, t, onRunGroup: runGroup, runningGroup: busyGroup, onInspectGroup: inspectGroup })
      else if (section === 'settings') content = h(SettingsSection, { snap, t, onApplyResults: applyResultsView, applyingResults })
      else content = h(ProvenanceSection, { snap, t, onSettle: settleAnalysis, onExport: exportAnalysis, onReplay: replayPipeline, onVerify: verifyPackageUi, busyAction, replaying, replayResult, verifying, verifyResult, onCopy: copyPath })

      return h('div', { className: 'ffa-root' },
        h('header', { className: 'ffa-head' },
          h('span', { className: 'ffa-brand', title: t('title') }, h(AnalysisIcon, { size: 15 }), t('title')),
          h('span', { className: 'ffa-sub' }, `${snap.project?.dataset || ''} · ${snap.project?.subject || ''}`),
          h('span', { className: 'ffa-tag' }, snap.source === 'live' ? t('sourceLive') : t('sourceFixture')),
          h('span', { className: 'ffa-spacer' }),
          h(StatusPill, { status: pipeline.status }),
          h('button', { className: 'ffa-btn', onClick: refresh, disabled: refreshing, title: t('refresh') }, refreshing ? '…' : t('refresh')),
          h('button', { className: 'ffa-btn ffa-btn-primary', onClick: openViewer }, t('openViewer'))),
        h('div', { className: 'ffa-main' },
          h('nav', { className: 'ffa-rail', role: 'tablist', 'aria-label': 'analysis sections' }, SECTIONS.map((name) => h('button', {
            key: name,
            type: 'button',
            className: `ffa-rail-item${section === name ? ' is-active' : ''}`,
            role: 'tab',
            'aria-selected': section === name,
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
