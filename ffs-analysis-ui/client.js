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
    const PIPELINE = '/ffs-analysis/pipeline'
    const PIPELINE_GENERATE = '/ffs-analysis/pipeline/generate'
    const SCRATCH = '/ffs-analysis/tool-run'
    const DECISIONS = '/ffs-analysis/decisions'
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
/* The Harness tab body is display:flex / flex-direction:column / height:100% / overflow:hidden.
   The panel must be a normal flex child of that body: an absolutely positioned root can be
   sized against a different containing block and then clipped by the body, which ends the
   root's scrollbar below the visible area. */
.ffa-root { position: relative; flex: 1 1 auto; min-height: 0; min-width: 0; width: 100%;
  display: flex; flex-direction: column; overflow-y: auto; overflow-x: auto;
  overscroll-behavior: contain; scrollbar-gutter: stable; padding: 6px;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font: 12px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.ffa-head { display: flex; align-items: center; gap: 6px; padding: 4px 6px; flex: 0 0 auto;
  position: sticky; top: 0; z-index: 2;
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
.ffa-main { display: flex; flex: 0 0 auto; min-height: 0; margin-top: 6px; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 9px; overflow: visible; background: var(--dsw-alias-bg-base); }
.ffa-rail { width: 176px; flex: 0 0 176px; padding: 6px; border-right: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base); overflow: auto; display: flex; flex-direction: column; gap: 2px;
  position: sticky; top: 6px; align-self: flex-start; max-height: calc(100vh - 24px); }
.ffa-rail-item { display: flex; align-items: center; gap: 7px; width: 100%; padding: 5px 7px;
  border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 11px; cursor: pointer; text-align: left; }
.ffa-rail-item:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.ffa-rail-item:focus-visible, .ffa-content:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.ffa-rail-item.is-active { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary); font-weight: 600; }
.ffa-run-chip { font-size: 10px; color: var(--dsw-alias-brand-primary); white-space: nowrap;
  border: 1px solid var(--dsw-alias-brand-primary); border-radius: 999px; padding: 0 6px; }
.ffa-rail-count { margin-left: auto; font-size: 9px; color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 0 5px; }
.ffa-content { flex: 1 1 auto; min-width: 0; min-height: 0; overflow: visible;
  padding: 8px; display: flex; flex-direction: column; gap: 8px; }
.ffa-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-1);
  overflow: hidden; min-width: 0; }
.ffa-card-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px;
  background: var(--dsw-alias-bg-layer-2); border-bottom: 1px solid transparent; }
.ffa-card-title { margin: 0; font-size: 10px; letter-spacing: .09em; text-transform: uppercase; font-weight: 700;
  color: var(--dsw-alias-label-secondary); }
.ffa-card-sub { margin-left: auto; font-size: 9px; color: var(--dsw-alias-label-secondary); }
.ffa-card-body { padding: 8px; display: flex; flex-direction: column; gap: 7px; min-width: 0; overflow-x: auto; }
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
.ffa-name { font-weight: 600; overflow-wrap: anywhere; min-width: 0; }
.ffa-split { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 8px; align-items: start; }
.ffa-kv { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 3px 8px; font-size: 10px; margin: 0; }
.ffa-kv dt { color: var(--dsw-alias-label-secondary); }
.ffa-kv dd { margin: 0; overflow-wrap: anywhere; }
.ffa-pre { margin: 0; padding: 7px 8px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1); font: 10px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap; overflow-wrap: anywhere; max-height: 170px; overflow: auto; }
.ffa-pre-log { max-height: 150px; margin-top: 4px; }
.ffa-pre-preview { max-height: 240px; margin-top: 4px; overflow: auto; white-space: pre; }
.ffa-history { display: flex; flex-direction: column; gap: 3px; }
.ffa-history-row { display: flex; align-items: center; gap: 8px; padding: 2px 0; border-bottom: 1px solid var(--dsw-alias-border-default, #eceff3); }
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
.ffa-toast { position: sticky; bottom: 8px; align-self: flex-end; margin-left: auto; z-index: 5;
  max-width: calc(100% - 20px); padding: 7px 10px;
  border-radius: 8px; background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2); font-size: 11px; box-shadow: 0 10px 30px rgba(0,0,0,.28); z-index: 5; }

.ffa-stage-board { height: auto; width: 100%; padding-bottom: 6px; }
.ffa-scroll.ffa-stage-board { max-height: none; overflow: visible; }
.ffa-stage-board-wrap { position: relative; min-width: 0; }
.ffa-stage-board-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin-top: 4px; font-size: 10px; color: var(--dsw-alias-label-secondary); }
.ffa-scroll { max-height: 340px; overflow: auto; padding-right: 2px; }
.ffa-chip { appearance: none; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 2px 8px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font: inherit; font-size: 10px; cursor: pointer; }
.ffa-chip:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); }
.ffa-chip.is-on { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base); font-weight: 600; }
.ffa-phase { font-size: 9px; letter-spacing: .08em; text-transform: uppercase; color: var(--dsw-alias-label-secondary);
  margin: 7px 0 2px; }
.ffa-stage { display: flex; align-items: center; gap: 6px; width: 100%; padding: 2px 5px; border: 1px solid transparent;
  border-radius: 6px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.ffa-stage:hover { background: var(--dsw-alias-bg-layer-2); }
.ffa-stage.is-selected { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-brand-primary); }
.ffa-stage.is-off { opacity: .55; }
.ffa-stage.is-changed .ffa-stage-num { color: var(--dsw-alias-brand-primary); font-weight: 700; }
.ffa-stage-num { width: 40px; flex: 0 0 40px; font: 9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--dsw-alias-label-secondary); }
.ffa-stage-label { flex: 1 1 auto; min-width: 0; font-size: 11px; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; }
.ffa-stage-state { flex: 0 0 auto; font-size: 9px; color: var(--dsw-alias-label-secondary); max-width: 45%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ffa-field { display: grid; grid-template-columns: minmax(96px, 150px) minmax(0, 1fr) auto; gap: 4px 8px;
  align-items: center; font-size: 10px; margin-bottom: 3px; }
.ffa-field > label { color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; line-height: 1.25; }
.ffa-field-default { grid-column: 2 / 4; font-size: 9px; color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere; }
.ffa-input { width: 100%; border: 1px solid var(--dsw-alias-border-l1); border-radius: 5px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); padding: 3px 6px;
  font: inherit; font-size: 10px; }
.ffa-input:focus { outline: 1px solid var(--dsw-alias-brand-primary); }
.ffa-chip-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ffa-chip-list { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; min-height: 16px; }
.ffa-chip-value { display: inline-flex; align-items: center; gap: 3px; padding: 1px 4px 1px 7px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; background: var(--dsw-alias-bg-layer-2);
  font: 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ffa-chip-remove { border: none; background: none; color: var(--dsw-alias-label-secondary); cursor: pointer;
  font: inherit; line-height: 1; padding: 0 2px; }
.ffa-chip-remove:hover { color: var(--dsw-alias-state-error-primary); }
.ffa-chip-editable { padding: 1px 3px 1px 7px; }
.ffa-chip-input { border: none; background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; width: 150px; min-width: 90px; padding: 0; }
.ffa-chip-input:focus { outline: 1px solid var(--dsw-alias-brand-primary); border-radius: 3px; }
.ffa-path-field { display: flex; align-items: center; gap: 4px; min-width: 0; }
.ffa-path-field > .ffa-input { flex: 1 1 auto; min-width: 0; }
.ffa-path-backdrop { position: fixed; inset: 0; z-index: 1100; display: flex; align-items: center;
  justify-content: center; padding: 16px; background: color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent); }
.ffa-path-panel { display: flex; flex-direction: column; width: min(560px, 100%); max-height: min(640px, 100%);
  min-height: 0; overflow: hidden; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-panel, 0 8px 30px rgba(0,0,0,.25)); }
.ffa-path-bar { display: flex; align-items: center; gap: 6px; padding: 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.ffa-path-list { flex: 1 1 auto; min-height: 120px; overflow: auto; padding: 4px 8px; }
.ffa-path-entry { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; border: none;
  background: none; color: var(--dsw-alias-label-primary); font: inherit; font-size: 11px; padding: 4px 6px;
  border-radius: 6px; cursor: pointer; overflow-wrap: anywhere; }
.ffa-path-entry:hover { background: var(--dsw-alias-bg-layer-2); }
.ffa-path-icon { width: 10px; color: var(--dsw-alias-label-secondary); }
.ffa-path-foot { display: flex; align-items: center; gap: 8px; padding: 8px; border-top: 1px solid var(--dsw-alias-border-l1); }
.ffa-warn { color: var(--dsw-alias-state-warn-primary); font-size: 10px; }
.ffa-error { color: var(--dsw-alias-state-error-primary); font-size: 10px; }
.ffa-planner-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }



.ffa-qc-grid { display: grid; gap: 12px; margin-top: 6px; }
.ffa-qc-figure { padding: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2); }
.ffa-qc-actions { display: flex; gap: 6px; margin-top: 6px; }
.ffa-qc-modal { width: min(560px, 100%); height: auto; max-height: min(90vh, 100%); }
.ffa-qc-modal-body { display: flex; flex-direction: column; gap: 6px; }
.ffa-empty-banner { margin: 4px 4px 8px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px; background: var(--dsw-alias-bg-layer-2); font-size: 11px; color: var(--dsw-alias-label-secondary); }
.ffa-empty-banner strong { color: var(--dsw-alias-label-primary); margin-right: 4px; }
.ffa-guide { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
.ffa-guide-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ffa-guide-steps { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.ffa-guide-step { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 5px 6px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-layer-1); }
.ffa-guide-step.is-next { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary) inset; }
.ffa-guide-step.is-done { opacity: .75; }
.ffa-guide-dot { width: 18px; height: 18px; flex: 0 0 18px; border-radius: 50%; display: inline-flex; align-items: center;
  justify-content: center; font-size: 10px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.ffa-guide-step.is-done .ffa-guide-dot { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.ffa-guide-step.is-next .ffa-guide-dot { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.ffa-guide-text { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.ffa-guide-label { font-size: 10px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ffa-guide-hint { font-size: 9px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.ffa-qc-summary { margin-top: 6px; gap: 4px; }
.ffa-qc-verdict { display: flex; align-items: center; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
.ffa-qc-composer { margin-top: 6px; display: flex; flex-direction: column; gap: 6px;
  padding: 7px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px;
  background: var(--dsw-alias-bg-layer-1); }
.ffa-decision { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 10px; min-width: 0; }
.ffa-cmd-section { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l1); }
.ffa-cmd-row { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 10px; min-width: 0; flex-wrap: wrap; }
.ffa-cmd-row > .ffa-small, .ffa-cmd-row > .ffa-name { min-width: 0; overflow-wrap: anywhere; }
.ffa-cmd-form { margin-top: 6px; padding: 7px 8px; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 7px; background: var(--dsw-alias-bg-layer-2); }
.ffa-textarea { resize: vertical; min-height: 38px; font: 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ffa-options { display: grid; grid-template-columns: minmax(170px, 220px) minmax(0, 1fr); gap: 10px; align-items: start; }
.ffa-options-groups { display: flex; flex-direction: column; gap: 2px; }
.ffa-options-fields { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.ffa-options-scroll { max-height: none; overflow: visible; }
.ffa-option-group { border-bottom: 1px solid var(--dsw-alias-border-l1); padding: 2px 0; }
.ffa-option-group-summary { display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 4px 2px;
  font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.ffa-option-group-summary:hover { color: var(--dsw-alias-label-primary); }
.ffa-option-group-title { min-width: 0; overflow-wrap: anywhere; }
.ffa-option-group-fields { padding: 4px 2px 8px; }
/* All-options is a full-height overlay drawer with its own scroll region, so every option is
   reachable regardless of the panel's own scroll position or the sidebar height. */
/* Fixed (not absolute) so no ancestor overflow/clipping can cut the drawer bottom; this is a
   modal over the app, which is appropriate for the 172-flag surface. */
.ffa-drawer-backdrop { position: fixed; inset: 0; z-index: 1000; display: flex; justify-content: flex-end;
  padding: 16px; background: color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent); }
.ffa-drawer-panel { display: flex; flex-direction: column; width: min(760px, 100%); height: 100%;
  min-height: 0; overflow: hidden; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-panel, 0 8px 30px rgba(0,0,0,.25)); }
.ffa-drawer-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; flex: 0 0 auto; padding: 8px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.ffa-drawer-head > strong { min-width: 0; overflow-wrap: anywhere; }
.ffa-drawer-body { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 8px; }
.ffa-drawer-foot { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--dsw-alias-border-l1); }
.ffa-group { display: flex; align-items: center; gap: 6px; border: 1px solid transparent; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 10px;
  padding: 3px 6px; text-align: left; cursor: pointer; }
.ffa-group:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.ffa-group.is-active { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary); font-weight: 600; }
.ffa-group-label { flex: 1 1 auto; min-width: 0; white-space: normal; overflow-wrap: anywhere; line-height: 1.2; }
.ffa-group-count { flex: 0 0 auto; font-size: 9px; color: var(--dsw-alias-label-secondary); }
.ffa-link { border: none; background: none; color: var(--dsw-alias-brand-primary); font: inherit; font-size: 9px;
  padding: 0; cursor: pointer; }
.ffa-flag-meta { white-space: nowrap; min-width: 24px; }
@media (max-width: 760px) { .ffa-options { grid-template-columns: 1fr; } }
@media (max-width: 900px) { .ffa-guide-steps { grid-template-columns: repeat(2, minmax(0, 1fr)); } }


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
      if (status === 'running' || status === 'stopping' || status === 'running-commands') return 'running'
      if (status === 'commands-failed') return 'error'
      if (status === 'failed' || status === 'error' || status === 'stopped') return 'error'
      if (status === 'warn' || status === 'warning' || status === 'draft') return 'warn'
      return 'idle'
    }

    function StatusPill({ status }) {
      return h('span', { className: `ffa-pill is-${statusClass(status)}` },
        h('span', { className: `ffa-dot is-${statusClass(status)}` }),
        status || 'unknown')
    }

    function Card({ title, subtitle, children, ...rest }) {
      return h('section', { className: 'ffa-card', ...rest },
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


    // ---------------------------------------------------------------- autoproc planner
    const FLAG_LABELS = {
      device: 'Device', no_qc: 'QC diagnostics', do_mni: 'MNI output', surface_glm: 'Surface GLM',
      anat: 'Anatomical image', surface_target: 'Surface targets',
      no_glm: 'GLM', no_anat: 'Anatomical space', no_distortion: 'Distortion correction',
      no_phase_drift: 'Phase drift correction',
    }

    function flagLabel(dest) {
      if (FLAG_LABELS[dest]) return FLAG_LABELS[dest]
      if (dest.startsWith('no_')) {
        const words = dest.slice(3).replace(/_/g, ' ')
        return `${words.charAt(0).toUpperCase()}${words.slice(1)}`
      }
      return dest
    }
    const COMMON_DESTS = ['device', 'no_qc', 'do_mni', 'surface_glm', 'anat', 'surface_target']

    function cloneJson(value) { return JSON.parse(JSON.stringify(value)) }

    function PathPicker({ initial, onPick, onClose }) {
      const [path, setPath] = useState(initial || '')
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const panelRef = useRef(null)
      const onCloseRef = useRef(onClose)
      onCloseRef.current = onClose
      // Capture-phase key handling: Escape closes only the picker (not the parent drawer) and
      // Tab stays inside the picker. onClose is held in a ref so parent re-renders don't
      // re-run focus setup.
      useEffect(() => {
        const previous = typeof document !== 'undefined' ? document.activeElement : null
        panelRef.current?.querySelector('input')?.focus?.()
        const handler = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopImmediatePropagation()
            onCloseRef.current?.()
            return
          }
          if (event.key !== 'Tab' || !panelRef.current) return
          const items = [...panelRef.current.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          )].filter((node) => !node.disabled)
          if (!items.length) return
          const first = items[0]
          const last = items[items.length - 1]
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }
        window.addEventListener('keydown', handler, true)
        return () => {
          window.removeEventListener('keydown', handler, true)
          previous?.focus?.()
        }
      }, [])
      useEffect(() => {
        let alive = true
        setError(null)
        fetch(`/ffs-analysis/browse?path=${encodeURIComponent(path)}`, { credentials: 'same-origin' })
          .then((res) => res.json().catch(() => null).then((payload) => ({ res, payload })))
          .then(({ res, payload }) => {
            if (!alive) return
            if (!res.ok || !payload || payload.ok !== true) setError(payload?.error?.message || `browse failed (${res.status})`)
            else setData(payload)
          })
          .catch((e) => { if (alive) setError(String(e?.message || e)) })
        return () => { alive = false }
      }, [path])
      return h('div', {
        className: 'ffa-path-backdrop', role: 'presentation',
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose?.() },
      },
      h('div', {
        className: 'ffa-path-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Choose path',
        tabIndex: -1, ref: panelRef,
      },
        h('div', { className: 'ffa-drawer-head' },
          h('strong', null, 'Choose path'),
          h('span', { className: 'ffa-small ffa-muted' }, 'project or external data (read-only input)'),
          h('span', { className: 'ffa-spacer' }),
          h('button', { type: 'button', className: 'ffa-btn', onClick: onClose }, 'Close')),
        h('div', { className: 'ffa-path-bar' },
          h('button', {
            type: 'button', className: 'ffa-btn', disabled: !data?.parent,
            onClick: () => setPath(data.parent),
          }, '↑ up'),
          h('input', {
            className: 'ffa-input', value: path, placeholder: 'project-relative path',
            onChange: (event) => setPath(event.target.value),
          })),
        error
          ? h('div', { className: 'ffa-error' }, error)
          : h('div', { className: 'ffa-path-list' },
            (data?.entries || []).map((entry) => h('button', {
              key: entry.path, type: 'button', className: 'ffa-path-entry',
              onClick: () => (entry.dir ? setPath(entry.path) : onPick(entry.path)),
            }, h('span', { className: 'ffa-path-icon' }, entry.dir ? '▸' : '·'), entry.name))),
        h('div', { className: 'ffa-path-foot' },
          h('span', { className: 'ffa-mono ffa-small' }, path || '.'),
          h('span', { className: 'ffa-spacer' }),
          h('button', { type: 'button', className: 'ffa-btn ffa-btn-primary', onClick: () => onPick(path) }, 'Use this path'))))
    }

    function FlagField({ dest, info, overrides, onChange }) {
      const [pickerOpen, setPickerOpen] = useState(false)
      if (!info) return null
      const explicit = overrides?.[dest]
      const has = explicit !== undefined
      const label = flagLabel(dest)
      const title = [info.flag, info.help].filter(Boolean).join(' — ')
      const reset = has
        ? h('button', { type: 'button', className: 'ffa-link', onClick: () => onChange(dest, undefined) }, 'reset')
        : null
      let control
      if (info.kind === 'bool') {
        // `no_*` destinations are inverted flags: the checkbox shows the feature state, not
        // the raw argparse value (checked = QC on, not "pass -no_qc").
        const negated = dest.startsWith('no_')
        const raw = has ? Boolean(explicit) : Boolean(info.default)
        const shown = negated ? !raw : raw
        control = h('input', {
          type: 'checkbox',
          checked: shown,
          title,
          onChange: (e) => {
            const value = negated ? !e.target.checked : e.target.checked
            onChange(dest, value === Boolean(info.default) ? undefined : value)
          },
        })
      } else if (info.action === 'append') {
        // Repeatable autoproc flags (`-family rest 4 -family nback 5`) are rows of
        // occurrences; each row becomes one flag occurrence in the argv.
        const rawRows = has
          ? (Array.isArray(explicit) ? explicit : [explicit]).map((item) => (Array.isArray(item) ? item.join(' ') : String(item)))
          : []
        const rows = rawRows.length ? rawRows : ['']
        const commit = (next) => {
          const occurrences = next
            .map((text) => String(text).trim())
            .filter(Boolean)
            .map((text) => text.split(/[\s,]+/).filter(Boolean))
          onChange(dest, occurrences.length ? occurrences : undefined)
        }
        const hint = Number.isInteger(info.nargs) && info.nargs > 0
          ? `${info.nargs} value${info.nargs === 1 ? '' : 's'}, space separated`
          : 'space separated values'
        control = h('div', { className: 'ffa-chip-field' },
          h('div', { className: 'ffa-chip-list' },
            rows.map((text, index) => h('span', { key: index, className: 'ffa-chip-value ffa-chip-editable' },
              h('input', {
                className: 'ffa-chip-input', value: text, title, placeholder: hint,
                onChange: (e) => {
                  const next = [...rows]
                  next[index] = e.target.value
                  commit(next)
                },
              }),
              h('button', {
                type: 'button', className: 'ffa-chip-remove', 'aria-label': 'remove occurrence',
                onClick: () => commit(rows.filter((_, itemIndex) => itemIndex !== index)),
              }, '×')))),
          h('button', {
            type: 'button', className: 'ffa-link',
            onClick: () => commit([...rows, '']),
          }, '+ occurrence'))
      } else if (info.kind === 'list') {
        const values = has ? (Array.isArray(explicit) ? explicit : String(explicit).split(/[\s,]+/)).filter(Boolean) : []
        const add = (text) => {
          const parts = String(text || '').trim().split(/[\s,]+/).filter(Boolean)
          if (parts.length) onChange(dest, [...values, ...parts])
        }
        control = h('div', { className: 'ffa-chip-field' },
          h('div', { className: 'ffa-chip-list' },
            values.length
              ? values.map((value, index) => h('span', { key: `${value}:${index}`, className: 'ffa-chip-value' },
                h('span', null, value),
                h('button', {
                  type: 'button', className: 'ffa-chip-remove', 'aria-label': `remove ${value}`,
                  onClick: () => {
                    const next = values.filter((_, itemIndex) => itemIndex !== index)
                    onChange(dest, next.length ? next : undefined)
                  },
                }, '×')))
              : h('span', { className: 'ffa-small ffa-muted' }, info.default == null ? 'no values' : `default: ${info.default}`)),
          h('input', {
            className: 'ffa-input', title,
            placeholder: info.choices ? `add (${info.choices.join(', ')}) · Enter` : 'type a value · Enter',
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              add(event.currentTarget.value)
              event.currentTarget.value = ''
            },
          }))
      } else if (info.choices) {
        const current = has ? String(explicit) : ''
        const fallback = info.default == null || info.default === false ? 'default' : `default (${info.default})`
        control = h('select', {
          className: 'ffa-input', value: current, title,
          onChange: (e) => onChange(dest, e.target.value === '' ? undefined : e.target.value),
        },
        h('option', { value: '' }, fallback),
        info.choices.map((choice) => h('option', { key: String(choice), value: String(choice) }, String(choice))))
      } else if (info.type === 'int' || info.type === 'float') {
        control = h('input', {
          className: 'ffa-input', type: 'number', title,
          value: has ? String(explicit) : '',
          placeholder: info.default == null ? 'auto' : String(info.default),
          onChange: (e) => {
            if (e.target.value === '') { onChange(dest, undefined); return }
            const numeric = Number(e.target.value)
            onChange(dest, Number.isFinite(numeric) ? numeric : undefined)
          },
        })
      } else if (info.path) {
        control = h('div', { className: 'ffa-path-field' },
          h('input', {
            className: 'ffa-input', title,
            value: has ? String(explicit) : '',
            placeholder: info.default == null ? 'project-relative path' : String(info.default),
            onChange: (e) => onChange(dest, e.target.value === '' ? undefined : e.target.value),
          }),
          h('button', {
            type: 'button', className: 'ffa-btn', onClick: () => setPickerOpen(true),
          }, 'Browse…'),
          pickerOpen
            ? h(PathPicker, {
              initial: has ? String(explicit) : '',
              onPick: (value) => { onChange(dest, value || undefined); setPickerOpen(false) },
              onClose: () => setPickerOpen(false),
            })
            : null)
      } else {
        control = h('input', {
          className: 'ffa-input', title,
          value: has ? String(explicit) : '',
          placeholder: info.default == null ? 'auto' : String(info.default),
          onChange: (e) => onChange(dest, e.target.value === '' ? undefined : e.target.value),
        })
      }
      const defaultText = info.default === undefined || info.default === null
        ? null
        : Array.isArray(info.default) ? info.default.join(' ') : String(info.default)
      const showDefault = has && defaultText !== null && String(explicit) !== defaultText
      return h('div', { className: 'ffa-field' },
        h('label', null, label), control, h('span', { className: 'ffa-flag-meta' }, reset),
        showDefault ? h('div', { className: 'ffa-field-default' }, `default: ${defaultText}`) : null)
    }

    function PlannerScope({ draft, detection, updateScope }) {
      const subjectControl = h('select', {
        className: 'ffa-input',
        value: draft.scope.subject,
        onChange: (e) => {
          const subject = e.target.value
          updateScope('subject', subject)
          const dataset = String(draft.scope.bidsDir).split('/').filter(Boolean).pop() || 'dataset'
          updateScope('workDir', `work/${dataset}/sub-${subject}`)
        },
      }, (detection.subjects || []).map((subject) => h('option', { key: subject, value: subject }, subject)))
      const rows = [
        ['Dataset', h('input', {
          className: 'ffa-input', value: draft.scope.bidsDir,
          title: 'BIDS root; absolute paths are allowed for real data (read-only input).',
          placeholder: 'data/bids or /absolute/path/to/bids',
          onChange: (e) => updateScope('bidsDir', e.target.value),
        })],
        ['Subject', subjectControl],
        ['Sessions', h('input', {
          className: 'ffa-input', placeholder: 'all sessions', value: (draft.scope.session || []).join(' '),
          onChange: (e) => updateScope('session', e.target.value.trim() ? e.target.value.trim().split(/[\s,]+/) : []),
        })],
        ['Tasks', h('input', {
          className: 'ffa-input', placeholder: 'all tasks', value: (draft.scope.task || []).join(' '),
          onChange: (e) => updateScope('task', e.target.value.trim() ? e.target.value.trim().split(/[\s,]+/) : []),
        })],
        ['Work dir', h('input', {
          className: 'ffa-input', value: draft.scope.workDir,
          onChange: (e) => updateScope('workDir', e.target.value),
        })],
        ['Output script', h('input', {
          className: 'ffa-input', value: draft.scope.out || '',
          placeholder: `${draft.scope.workDir.replace(/\/$/, '')}/proc_sub-${draft.scope.subject}.sh (derived)`,
          onChange: (e) => updateScope('out', e.target.value),
        })],
      ]
      return h('div', { className: 'ffa-field' }, rows.map(([label, control]) => h(React.Fragment, { key: label },
        h('label', null, label), control, h('span', null))))
    }

    function RecipePicker({ view, draft, setRecipe, onReset }) {
      const selected = (view.recipes || []).find((recipe) => recipe.id === draft.recipe)
      const coverage = view.coverage || {}
      const selectedCoverage = draft.recipe ? coverage[draft.recipe] : null
      const overrideCount = Object.keys(draft.overrides || {}).length
      return h(React.Fragment, null,
        h('div', { className: 'ffa-row', role: 'group', 'aria-label': 'recipe' },
          h('span', { className: 'ffa-small ffa-muted' }, 'Recipe'),
          h('button', {
            type: 'button', className: `ffa-chip${draft.recipe === null ? ' is-on' : ''}`,
            onClick: () => setRecipe(null),
          }, 'no preset'),
          (view.recipes || []).map((recipe) => h('button', {
            key: recipe.id, type: 'button',
            title: `${recipe.description}${coverage[recipe.id] ? ` — ${coverage[recipe.id].included}/${coverage[recipe.id].total} stages` : ''}`,
            className: `ffa-chip${draft.recipe === recipe.id ? ' is-on' : ''}`,
            onClick: () => setRecipe(recipe.id),
          }, recipe.id))),
        h('div', { className: 'ffa-row', style: { marginTop: 2 } },
          h('div', { className: 'ffa-small ffa-muted' },
            selected ? selected.description : 'parser defaults apply',
            selectedCoverage ? ` · ${selectedCoverage.included}/${selectedCoverage.total} stages` : ''),
          h('span', { className: 'ffa-spacer' }),
          h('button', {
            type: 'button', className: 'ffa-btn', disabled: !overrideCount,
            title: 'Clear every explicit override and return to the selected recipe/defaults',
            onClick: () => {
              if (window.confirm(`Clear all ${overrideCount} explicit override(s) and return to the selected recipe?`)) {
                onReset(Object.keys(draft.overrides || {}))
              }
            },
          }, `reset recipe${overrideCount ? ` (${overrideCount})` : ''}`)))
    }

    function StageBoard({ view, selected, onSelect, changed, runStageById = {} }) {
      const boardRef = useRef(null)
      useEffect(() => {
        const node = boardRef.current?.querySelector('.is-selected')
        node?.scrollIntoView?.({ block: 'nearest' })
      }, [selected?.id])
      const phases = []
      for (const stage of view.stages || []) {
        let group = phases.find((entry) => entry.phase === stage.phase)
        if (!group) { group = { phase: stage.phase, stages: [] }; phases.push(group) }
        group.stages.push(stage)
      }
      const isChanged = (stage) => [...(stage.flags || []), ...(stage.opts || [])].some((dest) => changed(dest))
      const stages = view.stages || []
      const included = stages.filter((stage) => stage.included).length
      return h('div', { className: 'ffa-stage-board-wrap' },
        h('div', { className: 'ffa-scroll ffa-stage-board', ref: boardRef },
          phases.map((phase) => h('div', { key: phase.phase },
            h('div', { className: 'ffa-phase' }, phase.phase),
            phase.stages.map((stage) => {
              const run = runStageById[stage.id]
              const toolText = (stage.tools || []).join(' ')
              const stateText = isChanged(stage)
                ? 'changed'
                : run && run.status === 'done'
                  ? `done · ${stageTime(run)}`
                  : (stage.included ? (toolText || 'on') : (stage.reason || 'off'))
              return h('button', {
                key: stage.id, type: 'button',
                title: [stage.reason || (stage.included ? 'will run' : 'off'), toolText].filter(Boolean).join(' · '),
                className: `ffa-stage${selected && selected.id === stage.id ? ' is-selected' : ''}${stage.included ? '' : ' is-off'}${isChanged(stage) ? ' is-changed' : ''}`,
                onClick: () => onSelect(stage.id),
              },
              h('span', { className: 'ffa-stage-num' }, stage.id === 'preflight' ? '—' : stage.id.replace('stage', '')),
              h('span', { className: 'ffa-stage-label' }, stage.label),
              h('span', { className: 'ffa-stage-state' }, stateText))
            })))),
        h('div', { className: 'ffa-stage-board-foot' },
          h('span', null, `${included}/${stages.length} stages included`),
          h('span', { className: 'ffa-muted' }, 'scroll the list · click a stage to edit its options')))
    }

    function useDialogFocus(onClose, panelRef) {
      const closeRef = useRef(null)
      // onClose is inline in both dialogs; keeping it in a ref prevents every keystroke (which
      // re-renders the parent and creates a new callback) from re-running focus setup.
      const onCloseRef = useRef(onClose)
      onCloseRef.current = onClose
      useEffect(() => {
        const previous = typeof document !== 'undefined' ? document.activeElement : null
        closeRef.current?.focus?.()
        const handler = (event) => {
          if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current?.(); return }
          if (event.key !== 'Tab' || !panelRef.current) return
          const items = [...panelRef.current.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          )].filter((node) => !node.disabled)
          if (!items.length) return
          const first = items[0]
          const last = items[items.length - 1]
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }
        window.addEventListener('keydown', handler)
        return () => {
          window.removeEventListener('keydown', handler)
          previous?.focus?.()
        }
      }, [panelRef])
      return closeRef
    }

    function StageOptionsDialog({ current, draft, flagInfo, updateOverride, onReset, onClose, runStage }) {
      const panelRef = useRef(null)
      const closeRef = useDialogFocus(onClose, panelRef)
      if (!current) return null
      const fields = (dests, title) => (dests || []).length
        ? h('div', { style: { marginTop: '8px' } },
          h('div', { className: 'ffa-phase' }, title),
          dests.map((dest) => h(FlagField, {
            key: dest, dest, info: flagInfo[dest], overrides: draft.overrides, onChange: updateOverride,
          })))
        : null
      return h('div', {
        className: 'ffa-drawer-backdrop', role: 'presentation',
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose?.() },
      },
      h('div', {
        className: 'ffa-drawer-panel', role: 'dialog', 'aria-modal': 'true', tabIndex: -1,
        'aria-label': `${current.id} ${current.label} options`, ref: panelRef,
      },
      h('div', { className: 'ffa-drawer-head' },
        h('strong', null, `${current.id} · ${current.label}`),
        h('span', { className: `ffa-pill ${current.included ? 'is-ok' : ''}` }, current.included ? 'runs' : 'off'),
        h('span', { className: 'ffa-spacer' }),
        h('button', {
          type: 'button', className: 'ffa-btn',
          disabled: ![...(current.flags || []), ...(current.opts || [])].some((dest) => Object.prototype.hasOwnProperty.call(draft.overrides || {}, dest)),
          onClick: () => {
            const dests = [...(current.flags || []), ...(current.opts || [])]
            if (window.confirm(`Reset overrides for ${current.id}?`)) onReset(dests)
          },
        }, 'Reset stage'),
        h('button', { type: 'button', className: 'ffa-btn', onClick: onClose, ref: closeRef }, 'Close')),
      h('div', { className: 'ffa-drawer-body' },
        h('div', { className: 'ffa-small ffa-muted' },
          current.included
            ? `tools: ${(current.tools || []).join(', ') || 'no tool call'}`
            : `not applicable · ${current.reason || 'off'}`),
        current.explanation
          ? h('div', { className: 'ffa-small ffa-muted', style: { marginTop: 4 } },
            h('div', null, `why: ${current.explanation.why}`),
            h('div', null, `failure: ${current.explanation.failure}`))
          : null,
        h('div', { className: 'ffa-small ffa-muted' },
          `outputs: ${(current.outputs || []).join(', ') || '—'}`),
        h('div', { className: 'ffa-small ffa-muted' },
          `last run: ${runStage ? `${runStage.status}${runStage.seconds != null ? ` · ${stageTime(runStage)}` : ''}` : 'not recorded'}`),
        h('div', { className: 'ffa-small ffa-muted' },
          're-run: the script skips stages whose outputs already exist; -batch_overwrite forces a rerun.'),
        (current.inherited || []).length
          ? h('div', { className: 'ffa-small ffa-muted', style: { marginTop: 6 } },
            h('div', { className: 'ffa-phase' }, 'Inherited from recipe'),
            current.inherited.map((entry) => h('div', { key: entry.dest, className: 'ffa-mono ffa-small' },
              `${entry.dest} = ${Array.isArray(entry.value) ? entry.value.join(' ') : entry.value === true ? 'yes' : entry.value === false ? 'no' : String(entry.value)}`)))
          : null,
        fields(current.flags, 'Stage flags'),
        fields(current.opts, 'Op strings'),
        fields(COMMON_DESTS, 'Common flags'))))
    }

    function OptionsDrawer({ view, draft, flagInfo, updateOverride, changed, onReset, onClose }) {
      const [groupTitle, setGroupTitle] = useState(null)
      const [openGroups, setOpenGroups] = useState({})
      const [search, setSearch] = useState('')
      const [changedOnly, setChangedOnly] = useState(false)
      const panelRef = useRef(null)
      const closeRef = useDialogFocus(onClose, panelRef)
      const groups = view.groups || []
      const active = groups.find((group) => group.title === groupTitle) || groups[0] || { title: '', flags: [] }
      const query = search.trim().toLowerCase()
      const matches = (dest) => {
        if (changedOnly && !changed(dest)) return false
        if (!query) return true
        const info = flagInfo[dest] || {}
        return `${dest} ${info.flag || ''} ${info.help || ''}`.toLowerCase().includes(query)
      }
      const visible = (active.flags || []).filter(matches)
      // Search spans every group, otherwise searching from the wrong group silently reports 0.
      const searchResults = query
        ? groups.map((group) => ({ ...group, flags: (group.flags || []).filter(matches) })).filter((group) => group.flags.length)
        : []
      const matchTotal = searchResults.reduce((total, group) => total + group.flags.length, 0)
      const changedTotal = (groups.flatMap((group) => group.flags || [])).filter((dest) => changed(dest)).length
      return h('div', {
        className: 'ffa-drawer-backdrop', role: 'presentation',
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose?.() },
      },
      h('div', {
        className: 'ffa-drawer-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'All options',
        tabIndex: -1, ref: panelRef,
      },
      h('div', { className: 'ffa-drawer-head' },
        h('strong', null, 'All options'),
        h('span', { className: 'ffa-small ffa-muted' }, `${view.totals.flags} flags · ${groups.length} groups`),
        h('span', { className: 'ffa-spacer' }),
        h('button', { type: 'button', className: 'ffa-btn', onClick: onClose, ref: closeRef }, 'Close')),
      h('div', { className: 'ffa-drawer-body' },
      h('div', { className: 'ffa-options' },
        h('div', { className: 'ffa-options-groups' }, groups.map((group) => {
          const changedInGroup = (group.flags || []).filter((dest) => changed(dest)).length
          return h('button', {
            key: group.title, type: 'button', title: group.title,
            className: `ffa-group${active.title === group.title ? ' is-active' : ''}`,
            onClick: () => {
              setGroupTitle(group.title)
              setOpenGroups((current) => ({ ...current, [group.title]: true }))
            },
          },
          h('span', { className: 'ffa-group-label' }, group.title),
          h('span', { className: 'ffa-group-count' },
            query
              ? `${(group.flags || []).filter(matches).length}`
              : (changedInGroup ? `${changedInGroup}/${group.flags.length}` : group.flags.length)))
        })),
        h('div', { className: 'ffa-options-fields' },
          h('div', { className: 'ffa-row' },
            h('input', {
              className: 'ffa-input', style: { flex: '1 1 180px' },
              placeholder: 'search flag or help…', value: search,
              onChange: (e) => setSearch(e.target.value),
            }),
            h('label', { className: 'ffa-row ffa-small' },
              h('input', {
                type: 'checkbox', checked: changedOnly,
                onChange: (e) => setChangedOnly(e.target.checked),
              }),
              `changed only (${changedTotal})`),
            h('button', {
              className: 'ffa-btn',
              onClick: () => { if (window.confirm(`Reset ${active.title}?`)) onReset(active.flags) },
            }, 'reset group'),
            h('button', {
              className: 'ffa-btn',
              onClick: () => { if (window.confirm('Reset every explicit override?')) onReset(Object.keys(draft.overrides || {})) },
            }, 'reset all')),
          h('div', { className: 'ffa-small ffa-muted' },
            query ? `${matchTotal} matches in ${searchResults.length} groups` : `${visible.length} of ${active.flags.length} flags · ${active.title}`),
          h('div', { className: 'ffa-options-scroll' },
            groups.map((group) => {
              const flags = (group.flags || []).filter(matches)
              if (!flags.length) return null
              const changedInGroup = flags.filter((dest) => changed(dest)).length
              const open = query ? true : Boolean(openGroups[group.title]) || group.title === active.title
              return h('details', {
                key: group.title, className: 'ffa-option-group', open,
                onToggle: (event) => {
                  const isOpen = Boolean(event.currentTarget.open)
                  setOpenGroups((current) => ({ ...current, [group.title]: isOpen }))
                  if (isOpen) setGroupTitle(group.title)
                },
              },
              h('summary', { className: 'ffa-option-group-summary' },
                h('span', { className: 'ffa-option-group-title' }, group.title),
                h('span', { className: 'ffa-group-count' },
                  changedInGroup ? `${changedInGroup}/${flags.length}` : `${flags.length}`)),
              h('div', { className: 'ffa-option-group-fields' },
                flags.map((dest) => h(FlagField, {
                  key: dest, dest, info: flagInfo[dest], overrides: draft.overrides, onChange: updateOverride,
                }))))
            })),
        ),
      ),
      h('div', { className: 'ffa-drawer-foot ffa-small ffa-muted' },
        'These are the ffs_autoproc flags themselves; the generated script uses exactly these values.'))))
    }

    function splitArgv(text) {
      const parts = []
      let current = ''
      let quote = null
      let escaped = false
      for (const char of String(text || '')) {
        if (escaped) { current += char; escaped = false; continue }
        if (char === '\\') { escaped = true; continue }
        if (quote) {
          if (char === quote) quote = null
          else current += char
          continue
        }
        if (char === '"' || char === "'") { quote = char; continue }
        if (/\s/.test(char)) {
          if (current) { parts.push(current); current = '' }
          continue
        }
        current += char
      }
      if (current) parts.push(current)
      return parts
    }

    function CommandForm({ initial, onSave, onCancel }) {
      const [form, setForm] = useState({ name: '', argv: '', scriptPath: '', cwd: '', expect: '', ...initial })
      const update = (key) => (e) => setForm((current) => ({ ...current, [key]: e.target.value }))
      return h('div', { className: 'ffa-cmd-form' },
        h('div', { className: 'ffa-field' },
          h('label', null, 'Name'), h('input', { className: 'ffa-input', value: form.name, onChange: update('name') }), h('span', null),
          h('label', null, 'Argv'), h('textarea', {
            className: 'ffa-input ffa-textarea', rows: 2, value: form.argv,
            onChange: update('argv'), placeholder: 'ffs_util_change_header -input …',
          }), h('span', null),
          h('label', null, 'or script'), h('input', {
            className: 'ffa-input', value: form.scriptPath, onChange: update('scriptPath'),
            placeholder: 'scripts/step.sh (frozen by sha256)',
          }), h('span', null),
          h('label', null, 'cwd'), h('input', {
            className: 'ffa-input', value: form.cwd, onChange: update('cwd'), placeholder: 'work dir',
          }), h('span', null),
          h('label', null, 'expect'), h('input', {
            className: 'ffa-input', value: form.expect, onChange: update('expect'), placeholder: 'outputs to hash',
          }), h('span', null)),
        h('div', { className: 'ffa-row' },
          h('span', { className: 'ffa-small ffa-muted' }, 'argv and script are mutually exclusive; the script hash is frozen on save.'),
          h('span', { className: 'ffa-spacer' }),
          h('button', { className: 'ffa-btn', onClick: onCancel }, 'Cancel'),
          h('button', { className: 'ffa-btn ffa-btn-primary', onClick: () => onSave(form) }, 'Save step')))
    }

    function CommandsPanel({ view, draft, snap, onAdd, onUpdate, onRemove, onRefreeze, refreezeNeeded }) {
      const [editing, setEditing] = useState(null)
      const runStatus = Object.fromEntries(((snap && snap.pipeline && snap.pipeline.commands) || []).map((command) => [command.id, command]))
      const commands = draft.commands || []
      const errors = (view.commandValidation && view.commandValidation.errors) || []
      const commit = (form) => {
        const argv = splitArgv(form.argv)
        const command = {
          id: form.id || `cmd-${Date.now().toString(36)}`,
          name: form.name || (form.scriptPath ? form.scriptPath.split('/').pop() : argv[0] || 'command'),
          argv,
          scriptPath: String(form.scriptPath || '').trim() || null,
          cwd: String(form.cwd || '').trim() || null,
          expect: splitArgv(form.expect),
          env: {},
          origin: form.origin || { kind: 'user' },
        }
        if (form.id) onUpdate(form.id, command)
        else onAdd(command)
        setEditing(null)
      }
      return h('div', { className: 'ffa-cmd-section' },
        h('div', { className: 'ffa-row' },
          h('span', { className: 'ffa-phase' }, `After autoproc · ${commands.length} command${commands.length === 1 ? '' : 's'}`),
          h('span', { className: 'ffa-spacer' }),
          refreezeNeeded
            ? h('button', { className: 'ffa-btn ffa-btn-danger', onClick: onRefreeze }, 'Re-freeze scripts & save')
            : null,
          h('button', {
            className: 'ffa-btn',
            onClick: () => setEditing({ name: '', argv: '', scriptPath: '', cwd: '', expect: '' }),
          }, '+ Add command')),
        errors.length
          ? h('div', null, errors.map((error) => h('div', { key: `${error.code}:${error.message}`, className: 'ffa-error' }, `✕ ${error.message}`)))
          : null,
        commands.length
          ? h('div', null, commands.map((command) => {
            const status = runStatus[command.id]
            return h('div', { key: command.id, className: 'ffa-cmd-row' },
              h('span', { className: 'ffa-mono ffa-small' }, command.id),
              h('span', { className: 'ffa-name ffa-small' }, command.name),
              h('span', { className: 'ffa-small ffa-muted ffa-mono' },
                command.scriptPath ? `bash ${command.scriptPath}` : command.argv.join(' ')),
              command.scriptPath && command.frozen && command.frozen.sha256
                ? h('span', { className: 'ffa-tag' }, `sha ${command.frozen.sha256.slice(0, 8)}`)
                : null,
              status
                ? h('span', { className: `ffa-pill is-${status.status === 'ok' ? 'ok' : status.status === 'failed' ? 'error' : 'idle'}` },
                  `run · ${status.status}${status.exitCode != null ? ` (${status.exitCode})` : ''}`)
                : null,
              h('span', { className: 'ffa-spacer' }),
              h('button', {
                className: 'ffa-link',
                onClick: () => setEditing({
                  ...command, argv: command.argv.join(' '), expect: (command.expect || []).join(' '),
                }),
              }, 'edit'),
              h('button', { className: 'ffa-link', onClick: () => onRemove(command.id) }, 'remove'))
          }))
          : h('div', { className: 'ffa-small ffa-muted' }, 'No post-processing steps. Commands run after the autoproc script, in order.'),
        editing
          ? h(CommandForm, { initial: editing, onSave: commit, onCancel: () => setEditing(null) })
          : null)
    }

    function ScratchPanel({ draft, view, onAdd, onToast }) {
      const [command, setCommand] = useState('')
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState(null)
      const run = async () => {
        setBusy(true)
        try {
          const argv = splitArgv(command)
          if (!argv.length) throw new Error('type a command first')
          const res = await fetch(SCRATCH, {
            method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ argv, cwd: draft.scope.workDir }),
          })
          const payload = await res.json().catch(() => null)
          if (!res.ok || !payload || payload.ok !== true) throw new Error(payload?.error?.message || `scratch ${res.status}`)
          setResult(payload)
          onToast?.(`scratch exit ${payload.exitCode} · ${payload.durationMs} ms`)
        } catch (e) {
          setResult({ error: String(e?.message || e), stdout: '', stderr: '' })
        } finally {
          setBusy(false)
        }
      }
      const asStep = (record) => onAdd({
        id: `cmd-${Date.now().toString(36)}`,
        name: String(record.argv[0]).split('/').pop(),
        argv: record.argv,
        scriptPath: null,
        cwd: record.cwd || null,
        expect: [],
        env: {},
        origin: { kind: 'scratch', toolRunId: record.id },
      })
      return h('div', { className: 'ffa-cmd-section' },
        h('div', { className: 'ffa-phase' }, 'Scratch'),
        h('div', { className: 'ffa-row' },
          h('input', {
            className: 'ffa-input', style: { flex: '1 1 280px' }, value: command,
            placeholder: 'ffs_info -nv stage10.final.*', onChange: (e) => setCommand(e.target.value),
          }),
          h('button', { className: 'ffa-btn', onClick: run, disabled: busy }, busy ? '…' : 'Run'),
          result && !result.error && result.exitCode === 0
            ? h('button', { className: 'ffa-btn ffa-btn-primary', onClick: () => asStep(result) }, 'Add as step')
            : null),
        result && result.outputTruncated
          ? h('div', { className: 'ffa-small ffa-muted' },
            `output truncated · showing last ${Math.min(result.stdoutLines ?? 0, 40)} of ${result.stdoutLines ?? '?'} stdout / ` +
            `${Math.min(result.stderrLines ?? 0, 20)} of ${result.stderrLines ?? '?'} stderr lines`)
          : null,
        result
          ? h('pre', { className: 'ffa-pre ffa-pre-log' },
            result.error || `${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`.trim() || '(no output)')
          : null,
        (view.scratch || []).length
          ? h('div', null,
            h('div', { className: 'ffa-small ffa-muted' }, 'Recent scratch runs'),
            (view.scratch || []).map((record) => h('div', { key: record.id, className: 'ffa-cmd-row' },
              h('span', { className: 'ffa-mono ffa-small' }, record.id),
              h('span', { className: 'ffa-small ffa-mono', title: (record.argv || []).join(' ') }, (record.argv || []).join(' ')),
              h('span', { className: `ffa-pill is-${record.ok ? 'ok' : 'error'}` }, `exit ${record.exitCode}`),
              h('button', { className: 'ffa-link', onClick: () => asStep(record) }, 'add as step'))))
          : null)
    }

    class PlannerBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        console.error?.('[ffs-analysis] autoproc planner failed', error)
      }

      render() {
        if (this.state.error) {
          return h(Card, { title: 'Autoproc planner' },
            h('div', { className: 'ffa-error' }, String(this.state.error?.message || this.state.error)),
            h('div', { className: 'ffa-small ffa-muted' }, 'The planner failed to render; the rest of the tab is unaffected.'))
        }
        return this.props.children
      }
    }


    class SectionBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        console.error?.('[ffs-analysis] section failed', error)
      }

      render() {
        if (this.state.error) {
          return h(Card, { title: 'Section failed' },
            h('div', { className: 'ffa-error' }, String(this.state.error?.message || this.state.error)),
            h('div', { className: 'ffa-small ffa-muted' }, 'Other sections are unaffected; switch tabs or refresh to retry.'))
        }
        return this.props.children
      }
    }

    function PlannerGuide({ draft, validationErrors, validationWarnings, dirty, generated, snap, generateError, showValidation }) {
      const scriptReady = Boolean(generated || snap.pipeline?.script)
      const completed = snap.pipeline?.status === 'completed'
      const displayErrors = validationErrors.length
        ? validationErrors
        : (generateError ? [{ code: 'generate', message: generateError }] : [])
      const needsGenerate = !scriptReady || dirty
      const activeId = displayErrors.length ? 'blockers' : needsGenerate ? 'generate' : (!completed ? 'run' : 'review')
      const steps = [
        { id: 'blockers', label: 'Resolve blockers', hint: displayErrors.length ? displayErrors[0].message : 'none', done: !displayErrors.length },
        { id: 'generate', label: 'Generate script', hint: dirty ? 'changes need a fresh script — Generate script auto-saves' : (scriptReady ? 'script generated' : 'writes the ffs_autoproc script'), done: scriptReady && !dirty },
        { id: 'run', label: 'Run script', hint: completed ? 'last run completed' : 'executes the generated script', done: completed },
        { id: 'review', label: 'Review', hint: 'Data · QC · Results', done: false },
      ]
      const active = steps.find((step) => step.id === activeId)
      return h('div', { className: 'ffa-guide', 'aria-label': 'next steps' },
        h('div', { className: 'ffa-guide-head' },
          h('strong', null, activeId === 'review' ? 'Ready to review' : `Next: ${active?.label || 'configure'}`),
          h('span', { className: 'ffa-small ffa-muted' },
            activeId === 'blockers'
              ? 'Fix blockers below, then use Generate script in the header.'
              : activeId === 'generate'
                ? 'Use Generate script in the header — it saves the pipeline for you.'
                : activeId === 'run'
                  ? 'Use Run in the header (Resume appears after a failed/stopped run).'
                  : 'Open Data / QC / Results from the section rail.')),
        h('div', { className: 'ffa-guide-steps' },
          steps.map((step, index) => h('div', {
            key: step.id, className: `ffa-guide-step${step.id === activeId ? ' is-next' : ''}${step.done ? ' is-done' : ''}`,
          },
          h('span', { className: 'ffa-guide-dot', 'aria-hidden': true }, step.done ? '✓' : String(index + 1)),
          h('div', { className: 'ffa-guide-text' },
            h('span', { className: 'ffa-guide-label' }, step.label),
            h('span', { className: 'ffa-guide-hint' }, step.hint || '')),
          step.id === 'blockers' && displayErrors.length
            ? h('button', { type: 'button', className: 'ffa-btn', onClick: showValidation }, `Review (${displayErrors.length})`)
            : null)))
      )
    }

    function PlannerSection({ snap, t, onToast, onRefresh, onRun, busyRun, runningNow }) {
      const [view, setView] = useState(null)
      const [draft, setDraft] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(null)
      const [selected, setSelected] = useState('stage02')
      const [generated, setGenerated] = useState(null)
      const [drawer, setDrawer] = useState(false)
      const [stageOpen, setStageOpen] = useState(false)
      const [remoteVersion, setRemoteVersion] = useState(null)
      const [generateError, setGenerateError] = useState(null)
      const dirtyRef = useRef(false)
      const [refreezeNeeded, setRefreezeNeeded] = useState(false)
      const versionRef = useRef(null)
      const validationRef = useRef(null)
      const draftDirty = Boolean(view && draft && JSON.stringify(draft) !== JSON.stringify(view.pipeline))
      useEffect(() => {
        if (draftDirty) setGenerateError(null)
      }, [draftDirty])

      const load = useCallback(async () => {
        const res = await fetch(PIPELINE, { cache: 'no-store', credentials: 'same-origin' })
        const payload = await res.json().catch(() => null)
        if (!res.ok || !payload || payload.ok !== true) {
          throw new Error(payload?.error?.message || `pipeline ${res.status}`)
        }
        setView(payload)
        setDraft(cloneJson(payload.pipeline))
        setError(null)
        setRemoteVersion(null)
        versionRef.current = payload.version
      }, [])

      useEffect(() => { load().catch((e) => setError(String(e?.message || e))) }, [load])
      useEffect(() => {
        const version = snap && snap.pipelineVersion
        if (version === undefined || version === null || versionRef.current === null) return
        if (versionRef.current !== version) {
          if (dirtyRef.current) setRemoteVersion(version)
          else load().catch(() => {})
        }
      }, [snap && snap.pipelineVersion, load])

      const updateScope = (key, value) => setDraft((current) => (current ? ({ ...current, scope: { ...current.scope, [key]: value } }) : current))
      const updateOverride = (key, value) => setDraft((current) => {
        if (!current) return current
        const overrides = { ...current.overrides }
        const empty = value === undefined || value === null || value === ''
          || (Array.isArray(value) && value.length === 0)
        if (empty) delete overrides[key]
        else overrides[key] = value
        return { ...current, overrides }
      })
      const setRecipe = (recipe) => setDraft((current) => (current ? { ...current, recipe } : current))
      const addCommand = (command) => setDraft((current) => (current ? { ...current, commands: [...(current.commands || []), command] } : current))
      const updateCommand = (id, patch) => setDraft((current) => (current
        ? { ...current, commands: (current.commands || []).map((item) => (item.id === id ? patch : item)) }
        : current))
      const removeCommand = (id) => setDraft((current) => (current
        ? { ...current, commands: (current.commands || []).filter((item) => item.id !== id) }
        : current))
      const onReset = (dests) => setDraft((current) => {
        if (!current) return current
        const overrides = { ...current.overrides }
        for (const dest of dests) delete overrides[dest]
        return { ...current, overrides }
      })

      const persist = useCallback(async (options = {}) => {
        if (!draft) return null
        const res = await fetch(PIPELINE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pipeline: draft, refreeze: Boolean(options.refreeze) }),
        })
        const payload = await res.json().catch(() => null)
        if (!res.ok || !payload || payload.ok !== true) {
          throw Object.assign(new Error(payload?.error?.message || `save failed (${res.status})`), { payload })
        }
        setView(payload)
        setDraft(cloneJson(payload.pipeline))
        versionRef.current = payload.version
        setRefreezeNeeded(false)
        setGenerated(null)
        return payload
      }, [draft])

      const save = useCallback(async () => {
        setBusy('save')
        try {
          const payload = await persist()
          onToast?.(`pipeline saved · v${payload.version}`)
          onRefresh?.()
        } catch (e) {
          const details = e?.payload?.error?.details
          const stale = (details?.errors || []).some((item) => item.code === 'command-script-changed')
          if (stale) setRefreezeNeeded(true)
          onToast?.(String(e?.message || e))
        } finally {
          setBusy(null)
        }
      }, [persist, onToast, onRefresh])

      const refreeze = useCallback(async () => {
        setBusy('refreeze')
        try {
          const payload = await persist({ refreeze: true })
          onToast?.(`scripts re-frozen · v${payload.version}`)
          onRefresh?.()
        } catch (e) {
          onToast?.(String(e?.message || e))
        } finally {
          setBusy(null)
        }
      }, [persist, onToast, onRefresh])

      const copyCommand = useCallback(async () => {
        try {
          await navigator.clipboard.writeText(view?.command || '')
          onToast?.('Resolved command copied')
        } catch {
          onToast?.('Clipboard unavailable')
        }
      }, [view, onToast])

      const generate = useCallback(async () => {
        setBusy('generate')
        try {
          const saved = await persist()
          const res = await fetch(PIPELINE_GENERATE, {
            method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}',
          })
          const payload = await res.json().catch(() => null)
          if (!res.ok || !payload || payload.ok !== true) {
            throw new Error(payload?.error?.message || `generate failed (${res.status})`)
          }
          setGenerated({ ...payload, pipelineVersion: saved.version })
          setGenerateError(null)
          onToast?.(`script generated · ${payload.script}`)
          onRefresh?.()
        } catch (e) {
          setGenerateError(String(e?.message || e))
          onToast?.(`generation failed: ${String(e?.message || e)}`)
        } finally {
          setBusy(null)
        }
      }, [persist, onToast, onRefresh])

      if (error) {
        return h(Card, { title: 'Autoproc planner' },
          h('div', { className: 'ffa-empty' }, error),
          h('div', { className: 'ffa-actions' },
            h('button', { className: 'ffa-btn', onClick: () => load().catch((e) => setError(String(e?.message || e))) }, 'Retry')))
      }
      if (!view || !draft) {
        return h(Card, { title: 'Autoproc planner' }, h('div', { className: 'ffa-empty' }, 'Loading the ffs_autoproc model…'))
      }

      const detection = view.detection || {}
      const current = (view.stages || []).find((stage) => stage.id === selected) || (view.stages || [])[0]
      const changed = (dest) => Object.prototype.hasOwnProperty.call(draft.overrides || {}, dest)
      const dirty = JSON.stringify(draft) !== JSON.stringify(view.pipeline)
      const validationErrors = Array.isArray(view.validation?.errors) ? view.validation.errors : []
      const validationWarnings = Array.isArray(view.validation?.warnings) ? view.validation.warnings : []
      const showValidation = () => validationRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
      dirtyRef.current = dirty
      const changedCount = Object.keys(draft.overrides || {}).length
      const canResume = (snap.pipeline?.status === 'failed' || snap.pipeline?.status === 'stopped' || snap.pipeline?.status === 'cancelled') && Boolean(snap.pipeline?.script)
      const blockers = validationErrors.length
        ? validationErrors
        : (generateError ? [{ code: 'generate', message: generateError }] : [])
      const runStageById = Object.fromEntries((snap.pipeline?.stages || []).map((stage) => [stage.name, stage]))
      const currentRun = current ? runStageById[current.id] : null
      const flyover = detection.fieldmaps
        ? `${detection.fieldmapGroups} fmap group${detection.fieldmapGroups === 1 ? '' : 's'}`
        : 'no fieldmaps'

      const plannerCard = h(Card, {
        title: 'Autoproc planner',
        subtitle: `v${view.version}${view.migrated ? ' · imported' : ''} · ${view.totals.flags} flags · ${view.totals.groups} groups`,
      },
      h('div', { className: 'ffa-planner-head' },
        h('span', { className: `ffa-pill ${dirty ? 'is-warn' : 'is-ok'}` }, dirty ? 'unsaved changes' : 'saved'),
        blockers.length
          ? h('button', {
            type: 'button', className: 'ffa-pill is-error', style: { cursor: 'pointer' },
            title: blockers.map((item) => item.message).slice(0, 4).join('\n'),
            onClick: showValidation,
          }, `${blockers.length} error${blockers.length === 1 ? '' : 's'}`)
          : null,
        validationWarnings.length
          ? h('button', {
            type: 'button', className: 'ffa-pill is-warn', style: { cursor: 'pointer' },
            title: validationWarnings.map((item) => item.message).slice(0, 4).join('\n'),
            onClick: showValidation,
          }, `${validationWarnings.length} warning${validationWarnings.length === 1 ? '' : 's'}`)
          : null,
        remoteVersion !== null
          ? h('span', { className: 'ffa-row' },
            h('span', { className: 'ffa-pill is-warn' }, 'pipeline changed on disk'),
            h('button', {
              className: 'ffa-btn', onClick: () => {
                if (window.confirm('Discard your unsaved edits and load the newer pipeline?')) load().catch((e) => setError(String(e?.message || e)))
              },
            }, 'Reload'))
          : null,
        h('span', { className: 'ffa-small ffa-muted' },
          `${detection.runs || 0} runs · ${detection.sessions || 0} sessions · ${flyover} · ${detection.sliceTiming ? 'SliceTiming' : 'no SliceTiming'} · ${detection.phase ? 'phase' : 'no phase'}`),
        h('span', { className: 'ffa-spacer' }),
        h('span', { className: 'ffa-small ffa-muted' }, `${changedCount} changed`),
        h('button', { className: 'ffa-btn', onClick: () => setDrawer((value) => !value) }, `All options (${view.totals.flags})`),
        h('button', { className: 'ffa-btn', onClick: save, disabled: busy !== null || !dirty }, busy === 'save' ? '…' : 'Save'),
        h('button', {
          className: 'ffa-btn', onClick: generate,
          disabled: busy !== null || validationErrors.length > 0,
          title: validationErrors.length
            ? `Fix ${validationErrors.length} validation error(s) before generating`
            : 'Generate the ffs_autoproc script',
        }, busy === 'generate' ? 'Generating…' : 'Generate script'),
        h('button', {
          className: 'ffa-btn ffa-btn-primary', onClick: onRun,
          disabled: busy !== null || busyRun || runningNow || blockers.length > 0 || dirty,
          title: blockers.length
            ? `Fix ${blockers.length} blocker(s) before running`
            : dirty ? 'Generate a fresh script after your changes before running'
              : runningNow ? 'The pipeline is running'
                : canResume ? 'Resume: stages with existing outputs are skipped' : 'Run the generated script',
        }, runningNow ? 'Running…' : busyRun ? '…' : (canResume ? 'Resume' : 'Run'))),
      h(PlannerGuide, {
        draft, validationErrors, validationWarnings, dirty, generated, snap, generateError, showValidation,
      }),
      h(PlannerScope, { draft, detection, updateScope }),
      h(RecipePicker, { view, draft, setRecipe, onReset }),
      h(StageBoard, {
        view, selected: current, changed, runStageById,
        onSelect: (id) => { setSelected(id); setStageOpen(true) },
      }),
      stageOpen && current
        ? h(StageOptionsDialog, {
          current, draft, flagInfo: view.flags || {}, updateOverride, onReset, runStage: currentRun,
          onClose: () => setStageOpen(false),
        })
        : null,
      blockers.length || validationWarnings.length
        ? h('div', { ref: validationRef, className: 'ffa-validation' },
          generateError ? h('div', { className: 'ffa-error' }, `✕ Script generation failed: ${generateError}`) : null,
          validationErrors.map((item) => h('div', { key: `${item.code}:${item.message}`, className: 'ffa-error' }, `✕ ${item.message}`)),
          validationWarnings.map((item) => h('div', { key: `${item.code}:${item.message}`, className: 'ffa-warn' }, `⚠ ${item.message}`)))
        : null,
      h('div', { className: 'ffa-row' },
        h('div', { className: 'ffa-small ffa-muted' }, 'Resolved command'),
        h('span', { className: 'ffa-spacer' }),
        h('button', { className: 'ffa-btn', onClick: copyCommand, disabled: !view.command }, 'Copy')),
      h('pre', { className: 'ffa-pre' }, view.command || '—'),
      generated
        ? h('details', { className: 'ffa-log', open: true },
          h('summary', { className: 'ffa-log-summary' },
            `Generated ${generated.script} · ${generated.stages} script stages · sha ${String(generated.scriptSha256 || '').slice(0, 12)}`),
          h('pre', { className: 'ffa-pre ffa-pre-log' }, generated.scriptHead || ''))
        : null,
      h(CommandsPanel, {
        view, draft, snap,
        onAdd: addCommand, onUpdate: updateCommand, onRemove: removeCommand,
        onRefreeze: refreeze, refreezeNeeded,
      }),
      h(ScratchPanel, { view, draft, onAdd: addCommand, onToast }),
)

      return h(React.Fragment, null, plannerCard,
        Array.isArray(view.history) && view.history.length
          ? h(Card, { title: 'Pipeline history', subtitle: `${view.history.length} recent save(s)` },
            h('div', { className: 'ffa-history' }, view.history.map((entry) => h('div', { key: `${entry.version}:${entry.at}`, className: 'ffa-history-row' },
              h('span', { className: 'ffa-tag' }, `v${entry.version}`),
              h('span', { className: 'ffa-small ffa-muted' }, (entry.at || '').replace('T', ' ').slice(0, 19)),
              h('span', { className: 'ffa-small' }, entry.summary || 'saved')))))
          : null,
        drawer
          ? h(OptionsDrawer, {
            view, draft, flagInfo: view.flags || {}, updateOverride, changed, onReset,
            onClose: () => setDrawer(false),
          })
          : null)
    }

    function PipelineSection({ snap, t, onCancel, runningNow, busyRun }) {
      const pipeline = snap.pipeline || {}
      const stages = Array.isArray(pipeline.stages) ? pipeline.stages : []
      const completion = stages.length
        ? Math.round(100 * stages.filter((s) => s.status === 'done').length / stages.length)
        : 0
      return h(React.Fragment, null,
        h(Card, { title: t('run'), subtitle: `${snap.project?.subject || ''} · ${pipeline.recipe || ''}`, id: 'ffa-pipeline-run' },
          h('div', { className: 'ffa-row' },
            h(StatusPill, { status: pipeline.status }),
            h('span', { className: 'ffa-muted ffa-small' }, `${t('elapsed')} ${formatSeconds(pipeline.elapsedSeconds)}`),
            h('span', { className: 'ffa-muted ffa-small' }, `${stages.length} ${t('stages')}`),
            snap.job?.dshId ? h('span', { className: 'ffa-tag', title: 'DSH background job' }, snap.job.dshId) : null,
            h('span', { className: 'ffa-spacer' }),
            runningNow
              ? h('button', {
                className: 'ffa-btn ffa-btn-danger',
                onClick: onCancel,
                disabled: busyRun,
              }, busyRun ? '…' : t('cancel'))
              : h('span', { className: 'ffa-small ffa-muted' }, 'Generate and Run are in the planner header above.')),
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

    function TextArtifactPreview({ artifact, t }) {
      const [preview, setPreview] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(false)
      useEffect(() => {
        setPreview(null)
        setError(null)
        if (!artifact || !artifact.path) return undefined
        let cancelled = false
        setLoading(true)
        fetch(`/ffs-analysis/artifact-text?path=${encodeURIComponent(artifact.path)}`, { credentials: 'same-origin' })
          .then((res) => res.json().catch(() => null).then((payload) => ({ res, payload })))
          .then(({ res, payload }) => {
            if (cancelled) return
            if (!res.ok || !payload || payload.ok !== true) {
              setError(payload?.error?.message || `preview failed (${res.status})`)
            } else {
              setPreview(payload)
            }
          })
          .catch((err) => { if (!cancelled) setError(String(err?.message || err)) })
          .finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
      }, [artifact?.path, artifact?.kind])
      if (!artifact) return null
      if (loading) return h('div', { className: 'ffa-small ffa-muted', style: { marginTop: 6 } }, 'Loading preview…')
      if (error) return h('div', { className: 'ffa-small', style: { marginTop: 6, color: 'var(--dsw-alias-state-error-primary)' } }, `Preview: ${error}`)
      if (!preview) return null
      return h('div', { style: { marginTop: 6 } },
        h('div', { className: 'ffa-small ffa-muted' }, `${preview.lines} line(s) · ${formatBytes(preview.bytes)} · ${preview.path}`),
        h('pre', { className: 'ffa-pre ffa-pre-preview' }, preview.text))
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
          h('dt', null, 'status'), h('dd', null, artifact.status || 'recorded'),
          h('dt', null, t('path')), h('dd', { className: 'ffa-mono' }, artifact.path || '—')),
        artifact.explanation
          ? h('div', { className: 'ffa-small ffa-muted', style: { marginTop: 6 } }, artifact.explanation)
          : null,
        Object.keys(hint).length
          ? h('div', null, Object.entries(hint).map(([key, value]) => h('span', { key, className: 'ffa-tag' }, `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)))
          : null,
        h('div', { className: 'ffa-actions' },
          loadable
            ? h('button', { className: 'ffa-btn ffa-btn-primary', disabled: busy, onClick: () => onLoad(artifact) }, busy ? '…' : t('load'))
            : h(TextArtifactPreview, { artifact, t }),
          h('button', { className: 'ffa-btn', onClick: () => onCopy(artifact.path) }, t('copyPath'))))
    }

    function DataSection({ snap, t, onLoad, onCopy, busy }) {
      const [selected, setSelected] = useState(null)
      const artifacts = Array.isArray(snap.artifacts) ? snap.artifacts : []
      const artifactKey = (artifact) => artifact?.id || artifact?.name || ''
      return h('div', { className: 'ffa-split' },
        h(Card, { title: `${t('recentArtifacts')} · ${artifacts.length}` },
          h('table', { className: 'ffa-table' },
            h('thead', null, h('tr', null,
              h('th', null, 'name'), h('th', null, t('kind')), h('th', null, 'status'), h('th', null, t('stage')), h('th', null, t('size')))),
            h('tbody', null, artifacts.map((artifact) => h('tr', {
              key: artifactKey(artifact),
              className: selected && artifactKey(selected) === artifactKey(artifact) ? 'is-selected' : '',
              onClick: () => setSelected(artifact),
            },
            h('td', { className: 'ffa-name' }, artifact.name),
            h('td', null, h('span', { className: 'ffa-tag' }, artifact.kind || '—')),
            h('td', null, h('span', { className: 'ffa-tag' }, artifact.status || 'recorded')),
            h('td', { className: 'ffa-muted' }, artifact.stage || '—'),
            h('td', { className: 'ffa-muted' }, formatBytes(artifact.bytes))))))),
        h(ArtifactDetail, { artifact: selected, onLoad, onCopy, busy, t }))
    }

    function QcSection({ snap, t, onDecision, recordingDecision, onCapture }) {
      const qc = snap.qc || {}
      const figures = Array.isArray(qc.figures) ? qc.figures : []
      const review = qc.review
      const decisions = Array.isArray(snap.decisions) ? snap.decisions : []
      const qcDecisions = decisions.filter((decision) => decision.target && decision.target.kind === 'qc')
      const subject = snap.project?.subject || 'subject'
      const verdictFor = (figure) => {
        const ref = `${subject}:${figure.id || figure.asset}`
        return [...qcDecisions].reverse().find((decision) => (
          decision.target?.ref === ref || (decision.target?.path && decision.target.path === figure.asset)
        )) || null
      }
      const verdictClass = (action) => action === 'accept' ? 'is-ok' : action === 'reject' ? 'is-error' : 'is-warn'
      const verdictLabel = (action) => action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : action === 'tentative' ? 'tentative' : action
      const verdictCounts = qcDecisions.reduce((counts, decision) => {
        const key = verdictLabel(decision.action)
        counts[key] = (counts[key] || 0) + 1
        return counts
      }, {})
      const [pending, setPending] = useState(null)
      const [reason, setReason] = useState('')
      const [confidence, setConfidence] = useState('')
      const [capture, setCapture] = useState(null)
      const [capturing, setCapturing] = useState(false)
      const [decisionKind, setDecisionKind] = useState('preference')
      const [composerError, setComposerError] = useState(null)
      const figureKey = (figure) => figure?.id || figure?.asset || figure?.label || ''
      const cancelComposer = () => {
        setPending(null)
        setReason('')
        setConfidence('')
        setCapture(null)
        setDecisionKind('preference')
        setComposerError(null)
      }
      useEffect(() => {
        if (!pending) return undefined
        const handler = (event) => { if (event.key === 'Escape') { event.preventDefault(); cancelComposer() } }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
      }, [pending])
      const openComposer = (figure, action) => {
        setPending({ figure, action })
        setReason('')
        setConfidence('')
        setCapture(null)
        setDecisionKind('preference')
        setComposerError(null)
      }
      const captureViewer = async () => {
        if (!onCapture) return
        setCapturing(true)
        const next = await onCapture('decision evidence')
        setCapturing(false)
        if (next) setCapture(next)
      }
      const targetFor = (figure) => ({
        kind: 'qc',
        ref: `${subject}:${figure.id || figure.asset}`,
        path: figure.asset,
      })
      const save = async (action) => {
        if (!pending) return
        if (decisionKind === 'standard' && !reason.trim()) {
          setComposerError('departing from a standard needs a reason')
          return
        }
        const result = await onDecision({
          action,
          target: targetFor(pending.figure),
          reason,
          confidence: confidence || null,
          decisionKind,
          overrideRef: decisionKind === 'standard' ? (pending.figure?.asset || null) : null,
          evidence: { visual: capture ? [capture] : [] },
        })
        if (!result) {
          setComposerError('decision was not recorded — see the toast for details')
          return
        }
        setPending(null)
        setReason('')
        setConfidence('')
        setCapture(null)
        setDecisionKind('preference')
        setComposerError(null)
      }
      const renderComposer = (figure) => {
        // Snapshot polling recreates figure objects; compare stable keys so the open composer
        // survives a refresh instead of disappearing mid-edit.
        if (!pending || figureKey(pending.figure) !== figureKey(figure)) return null
        return h('div', {
          className: 'ffa-drawer-backdrop', role: 'presentation',
          onMouseDown: (event) => { if (event.target === event.currentTarget) cancelComposer() },
        },
        h('div', {
          className: 'ffa-drawer-panel ffa-qc-modal', role: 'dialog', 'aria-modal': 'true',
          'aria-label': `${pending.action} QC decision`,
        },
        h('div', { className: 'ffa-drawer-head' },
          h('strong', null, `${pending.action} · ${pending.figure?.label || figureKey(pending.figure)}`),
          h('span', { className: `ffa-pill is-${pending.action === 'accept' ? 'ok' : pending.action === 'reject' ? 'error' : 'warn'}` }, pending.action),
          h('span', { className: 'ffa-spacer' }),
          h('button', { type: 'button', className: 'ffa-btn', onClick: cancelComposer }, 'Close')),
        h('div', { className: 'ffa-drawer-body ffa-qc-modal-body' },
          h('div', { className: 'ffa-small ffa-muted' }, pending.figure?.asset || ''),
          h('div', { className: 'ffa-small ffa-muted' }, 'Record a verdict for this figure; the target figure and its sha256 travel with the decision.'),
          h('input', {
            className: 'ffa-input', autoFocus: true,
            placeholder: 'reason (optional — records “not stated”)',
            value: reason, onChange: (e) => setReason(e.target.value),
          }),
          h('div', { className: 'ffa-row' },
            h('label', { className: 'ffa-small ffa-muted' }, 'changes ',
              h('select', {
                className: 'ffa-input', value: decisionKind,
                title: 'Constraints cannot be overridden; standards need a recorded reason.',
                onChange: (e) => { setDecisionKind(e.target.value); setComposerError(null) },
              },
              h('option', { value: 'preference' }, 'preference'),
              h('option', { value: 'standard' }, 'standard (needs reason)'))),
            onCapture
              ? h('button', { className: 'ffa-btn', disabled: capturing, onClick: captureViewer }, capturing ? 'Capturing…' : 'Capture viewer state')
              : null,
            capture
              ? h('span', { className: 'ffa-tag', title: capture.stateSha256 }, `${capture.sessionId} · seq ${capture.seq} · sha ${String(capture.stateSha256).slice(0, 8)}`)
              : h('span', { className: 'ffa-small ffa-muted' }, 'no viewer capture')),
          h('div', { className: 'ffa-row' },
            h('label', { className: 'ffa-small ffa-muted' }, 'confidence',
              h('select', {
                className: 'ffa-input', value: confidence,
                onChange: (e) => setConfidence(e.target.value),
              },
              h('option', { value: '' }, '—'),
              h('option', { value: 'low' }, 'low'),
              h('option', { value: 'medium' }, 'medium'),
              h('option', { value: 'high' }, 'high'))),
            h('span', { className: 'ffa-spacer' })),
          composerError
            ? h('div', { className: 'ffa-error' }, composerError)
            : null),
        h('div', { className: 'ffa-drawer-foot ffa-row' },
          h('span', { className: 'ffa-spacer' }),
          h('button', { type: 'button', className: 'ffa-btn', onClick: cancelComposer }, 'Cancel'),
          h('button', {
            type: 'button', className: 'ffa-btn ffa-btn-primary',
            disabled: recordingDecision || (decisionKind === 'standard' && !reason.trim()),
            title: decisionKind === 'standard' && !reason.trim() ? 'a standard departure needs a reason' : '',
            onClick: () => save(pending.action),
          }, recordingDecision ? '…' : 'Save decision'))))
      }
      return h(Card, {
        title: t('qcNote'),
        subtitle: `${qc.status || ''}${qcDecisions.length ? ` · ${qcDecisions.length} verdict(s)` : ' · no verdicts'}`,
      },
        qc.note ? h('div', { className: 'ffa-small ffa-muted' }, qc.note) : null,
        h('div', { className: 'ffa-row ffa-qc-summary' },
          qcDecisions.length
            ? Object.entries(verdictCounts).map(([label, count]) => h('span', {
              key: label, className: `ffa-pill ${verdictClass(label === 'accepted' ? 'accept' : label === 'rejected' ? 'reject' : 'tentative')}`,
            }, `${label} ${count}`))
            : h('span', { className: 'ffa-small ffa-muted' }, 'No verdicts recorded — Accept/Tentative/Reject writes one.'),
          h('span', { className: 'ffa-spacer' }),
          h('span', { className: 'ffa-small ffa-muted' }, 'Verdicts are stored as decisions with the figure target + sha256.')),
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
          ? h('div', { className: 'ffa-qc-grid' }, figures.map((figure) => h('figure', { key: figure.id || figure.asset, className: 'ffa-figure ffa-qc-figure' },
            h('img', { className: 'ffa-img', src: `${snap.assets?.base || '/ffs-analysis/asset/'}${figure.asset}`, alt: figure.label || 'QC figure', loading: 'lazy' }),
            h('figcaption', null,
              `${figure.label || ''}${figure.caption ? ` · ${figure.caption}` : ''}`,
              figure.help
                ? h('div', { className: 'ffa-small ffa-muted' },
                  h('div', null, `why: ${figure.help.why}`),
                  h('div', null, `failure: ${figure.help.failure}`))
                : null),
            h('div', { className: 'ffa-qc-actions' },
              h('button', {
                className: 'ffa-btn', disabled: recordingDecision,
                onClick: () => openComposer(figure, 'accept'),
              }, 'Accept'),
              h('button', {
                className: 'ffa-btn', disabled: recordingDecision,
                onClick: () => openComposer(figure, 'tentative'),
              }, 'Tentative'),
              h('button', {
                className: 'ffa-btn ffa-btn-danger', disabled: recordingDecision,
                onClick: () => openComposer(figure, 'reject'),
              }, 'Reject')),
            (() => {
              const verdict = verdictFor(figure)
              return h('div', { className: 'ffa-qc-verdict' },
                verdict
                  ? h('span', { className: `ffa-pill ${verdictClass(verdict.action)}` }, `${verdictLabel(verdict.action)} · ${String(verdict.at || '').replace('T', ' ').slice(0, 19)}`)
                  : h('span', { className: 'ffa-small ffa-muted' }, 'not judged yet'),
                verdict?.confidence ? h('span', { className: 'ffa-tag' }, verdict.confidence) : null,
                verdict?.rationale?.text ? h('span', { className: 'ffa-small ffa-muted' }, verdict.rationale.text) : null)
            })(),
            renderComposer(figure))))
          : h('div', { className: 'ffa-empty' }, 'No QC figures in the snapshot.'),
        Array.isArray(qc.screenshots) && qc.screenshots.length
          ? h('div', { style: { marginTop: 12 } },
            h('div', { className: 'ffa-label' }, 'viewer screenshots'),
            h('div', { className: 'ffa-qc-grid' }, qc.screenshots.map((shot) => h('figure', { key: shot.id || shot.asset, className: 'ffa-figure' },
              h('img', { className: 'ffa-img', src: `${snap.assets?.base || '/ffs-analysis/project-asset/'}${shot.asset}`, alt: shot.label || 'viewer screenshot', loading: 'lazy' }),
              h('figcaption', null, shot.label || '')))))
          : null,
        qcDecisions.length
          ? h('div', { style: { marginTop: 12 } },
            h('div', { className: 'ffa-label' }, `decisions · ${qcDecisions.length}`),
            h('div', null, qcDecisions.slice(-12).reverse().map((decision) => h('div', { key: decision.id, className: 'ffa-decision' },
              h('span', { className: `ffa-pill is-${decision.action === 'accept' ? 'ok' : decision.action === 'reject' ? 'error' : 'warn'}` }, decision.action),
              h('span', { className: 'ffa-small ffa-mono' }, decision.target?.ref || ''),
              h('span', { className: 'ffa-small' }, decision.rationale?.unknown ? 'not stated' : (decision.rationale?.text || '')),
              h('span', { className: 'ffa-small ffa-muted' }, decision.confidence || '—'),
              decision.evidence?.visual?.length ? h('span', { className: 'ffa-tag' }, `${decision.evidence.visual.length} capture`) : null,
              h('span', { className: 'ffa-spacer' }),
              h('span', { className: 'ffa-small ffa-muted' }, `${decision.actor?.kind || 'unknown'} · ${String(decision.at || '').replace('T', ' ').slice(0, 19)}`)))))
          : h('div', { className: 'ffa-small ffa-muted', style: { marginTop: 10 } },
            'No verdict recorded yet. Accept/Tentative/Reject writes a decision with the target figure and its sha256.'),
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
      const [threshold, setThreshold] = useStoredState('ffs-results-threshold', () => results.threshold ?? 3.1)
      const [minCluster, setMinCluster] = useStoredState('ffs-results-min', () => results.minCluster ?? 10)
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
            h('div', { className: 'ffa-small ffa-muted', style: { marginTop: 6 } },
              `${results.model || 'model'} · ${(results.contrasts && results.contrasts[0] && (results.contrasts[0].name || results.contrasts[0].id)) || 'contrast'} · t ≥ ${results.threshold ?? '—'} · hot`))
          : null)
    }

    function CohortSection({ snap, t, onValidate, validating, validation, onToggleInclude, onExport, exporting, onCopy }) {
      const cohort = snap.cohort || snap.group?.cohort || {}
      const subjects = Array.isArray(cohort.subjects) ? cohort.subjects : []
      const checked = new Map((validation?.subjects || []).map((item) => [item.id, item]))
      const includedCount = subjects.filter((subject) => subject.include !== false).length
      const issueCount = (validation?.subjects || []).filter((item) => (item.issues || []).length).length
      const [detail, setDetail] = React.useState(null)
      const [lastExport, setLastExport] = React.useState(null)
      return h(Card, { title: t('cohortNote'), subtitle: cohort.status || '' },
        h('div', { className: 'ffa-row' },
          h('span', { className: 'ffa-small ffa-muted' },
            `${subjects.length} subject(s) · ${includedCount} included`),
          h('span', { className: 'ffa-spacer' }),
          validation
            ? h(StatusPill, { status: validation.ok ? 'completed' : 'failed' })
            : null,
          h('button', {
            className: 'ffa-btn',
            onClick: onValidate,
            disabled: validating || !subjects.length,
            title: !subjects.length ? 'No subjects discovered under the cohort work root.' : 'Check scripts, stats and include state for every subject.',
          }, validating ? t('validating') : t('validateCohort')),
          h('button', {
            className: 'ffa-btn ffa-btn-primary',
            onClick: async () => {
              const result = await onExport()
              if (result) setLastExport(result)
            },
            disabled: exporting || !subjects.length,
            title: 'Validate and build the reproducible cohort package (scripts, subjects, methods, hashes).',
          }, exporting ? 'Exporting…' : 'Export cohort')),
        lastExport
          ? h('div', { className: 'ffa-row', style: { marginTop: 4 } },
            h('span', { className: 'ffa-small ffa-muted' }, 'package'),
            h('span', { className: 'ffa-mono ffa-small' }, lastExport.dir || ''),
            h('span', { className: 'ffa-small ffa-muted' }, `${lastExport.files ?? '—'} files · ${lastExport.subjects ?? '—'} subj`),
            onCopy ? h('button', { className: 'ffa-btn', onClick: () => onCopy(lastExport.dir, 'Cohort package path copied') }, 'Copy') : null)
          : null,
        validation
          ? h('div', { className: 'ffa-small', style: { marginTop: 4, color: validation.ok ? 'var(--dsw-alias-state-success-primary, #2e7d32)' : 'var(--dsw-alias-state-error-primary)' } },
            `${validation.ok ? t('cohortOk') : t('cohortFailed')} · ${subjects.length - issueCount} ok · ${issueCount} issue(s) · ${validation.checkedAt}`)
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

    function useStoredState(key, initial) {
      const [value, setValue] = useState(() => {
        try {
          const raw = window.localStorage.getItem(key)
          return raw === null ? (typeof initial === 'function' ? initial() : initial) : JSON.parse(raw)
        } catch {
          return typeof initial === 'function' ? initial() : initial
        }
      })
      useEffect(() => {
        try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* ignore */ }
      }, [key, value])
      return [value, setValue]
    }

    function GroupSection({ snap, t, onRunGroup, runningGroup, onInspectGroup, onCopy }) {
      const group = snap.group || {}
      const cohort = group.cohort || snap.cohort || {}
      const analyses = Array.isArray(group.analyses)
        ? [...group.analyses].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
        : []
      const subjects = Array.isArray(cohort.subjects) ? cohort.subjects : []
      const [model, setModel] = useStoredState('ffs-group-model', 'one-sample')
      const [engine, setEngine] = useStoredState('ffs-group-engine', '3dMEMA')
      const [correction, setCorrection] = useStoredState('ffs-group-correction', 'none')
      const contrastNames = [...new Set((snap.results?.contrasts || [])
        .map((item) => (typeof item === 'string' ? item : (item.name || item.id)))
        .filter(Boolean))]
      const [contrast, setContrast] = useStoredState('ffs-group-contrast', () => contrastNames[0] || 'scenes')
      React.useEffect(() => {
        if (contrastNames.length && !contrastNames.includes(contrast)) setContrast(contrastNames[0])
      }, [contrastNames.join('|')])
      const suggestedA = subjects.filter((_, index) => index % 2 === 0).map((subject) => subject.subject).join(', ')
      const suggestedB = subjects.filter((_, index) => index % 2 === 1).map((subject) => subject.subject).join(', ')
      const [groupA, setGroupA] = useStoredState('ffs-group-a', '')
      const [groupB, setGroupB] = useStoredState('ffs-group-b', '')
      const parseIds = (value) => String(value || '').split(/[\s,]+/).map((item) => item.trim().replace(/^sub-/, '')).filter(Boolean)
      const effectiveEngine = model === 'two-group' ? '3dttest++' : engine
      const a = parseIds(groupA || suggestedA)
      const b = parseIds(groupB || suggestedB)
      const overlap = a.filter((id) => b.includes(id))
      const splitOk = model !== 'two-group' || (a.length >= 2 && b.length >= 2 && overlap.length === 0)
      const canRun = (cohort.included || 0) >= 2 && !runningGroup && splitOk
      const runHint = (cohort.included || 0) < 2
        ? 'Need at least 2 included subjects (Cohort section).'
        : model === 'two-group' && a.length < 2
          ? 'Group A needs at least 2 subject ids.'
          : model === 'two-group' && b.length < 2
            ? 'Group B needs at least 2 subject ids.'
            : model === 'two-group' && overlap.length
              ? `Subject(s) in both groups: ${overlap.join(', ')}`
              : 'Run the group analysis'
      const run = () => onRunGroup({
        contrast,
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
          h('label', { className: 'ffa-small' }, 'contrast ',
            contrastNames.length
              ? h('select', { className: 'ffa-input', value: contrast, onChange: (event) => setContrast(event.target.value) },
                contrastNames.map((name) => h('option', { key: name, value: name }, name)))
              : h('input', {
                className: 'ffa-input', style: { width: 130 }, value: contrast,
                onChange: (event) => setContrast(event.target.value),
              })),
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
          h('button', {
            className: 'ffa-btn ffa-btn-primary', onClick: run, disabled: !canRun, title: runHint,
          }, runningGroup ? t('groupRunning') : t('runGroup'))),
        model === 'two-group'
          ? h('div', { className: 'ffa-row', style: { marginTop: 6, gap: 6 } },
            h('label', { className: 'ffa-small' }, 'A ',
              h('input', { className: 'ffa-input', value: groupA, placeholder: suggestedA, onChange: (event) => setGroupA(event.target.value) })),
            h('label', { className: 'ffa-small' }, 'B ',
              h('input', { className: 'ffa-input', value: groupB, placeholder: suggestedB, onChange: (event) => setGroupB(event.target.value) })),
            h('span', { className: `ffa-small ${splitOk ? 'ffa-muted' : 'ffa-warn'}` },
              `${a.length} vs ${b.length} (ids without sub-)${overlap.length ? ` · overlap: ${overlap.join(', ')}` : ''}`),
            splitOk ? null : h('span', { className: 'ffa-small ffa-warn' }, 'need 2+ per group, no overlap'))
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
              h(StatusPill, { status: analysis.error ? 'failed' : (analysis.status || 'completed') }),
              onCopy
                ? h('button', {
                  className: 'ffa-btn',
                  onClick: () => onCopy([
                    `${analysis.id} · ${analysis.contrast}`,
                    `${analysis.model || analysis.design || ''} · ${analysis.engine || ''} · n=${(analysis.nA || analysis.n) ?? '—'}${analysis.nB ? ` vs ${analysis.nB}` : ''}`,
                    `correction: ${correctionText(analysis)}`,
                    analysis.at ? `run: ${analysis.at}` : '',
                    analysis.workDir ? `work dir: ${analysis.workDir}` : '',
                    `clusters: ${(analysis.clusters || []).length}`,
                  ].filter(Boolean).join('\n'), 'Group summary copied'),
                }, 'Copy summary')
                : null),
            h('div', { className: 'ffa-small ffa-muted', style: { marginTop: 4 } },
              `${analysis.model || analysis.design || ''} · ${analysis.engine || ''} · ${(analysis.nA || analysis.n) ?? '—'}${analysis.nB ? ` vs ${analysis.nB}` : ''} · ${correctionText(analysis)}${analysis.at ? ` · ${String(analysis.at).replace('T', ' ').slice(0, 19)}` : ''}`),
            analysis.workDir || analysis.bucket
              ? h('div', { className: 'ffa-small ffa-mono ffa-muted', style: { marginTop: 2 } },
                analysis.workDir || '', analysis.bucket && analysis.bucket !== analysis.workDir ? ` · ${analysis.bucket}` : '')
              : null,
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
      const [threshold, setThreshold] = useStoredState('ffs-default-threshold', () => snap.results?.threshold ?? 3.1)
      const [minCluster, setMinCluster] = useStoredState('ffs-default-min', () => snap.results?.minCluster ?? 10)
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
      const provenanceBusy = busyAction !== null || replaying || verifying
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
            disabled: !completed || provenance.settled || provenanceBusy,
            title: completed ? 'Freeze plan, run, artifacts and results' : 'Run the plan to completion first',
          }, busyAction === 'settle' ? t('settling') : (provenance.settled ? t('settled') : t('settle'))),
          h('button', {
            className: 'ffa-btn',
            onClick: onExport,
            disabled: !provenance.settled || provenanceBusy,
            title: 'Build the reproducible package (scripts, STEPS.md, METHODS.md)',
          }, busyAction === 'export' ? t('exporting') : t('export')),
          h('button', {
            className: 'ffa-btn',
            onClick: onReplay,
            disabled: !completed || provenanceBusy,
            title: 'Replay the frozen pipeline in a fresh work dir and compare the stats bucket',
          }, replaying ? t('replaying') : t('replay')),
          h('button', {
            className: 'ffa-btn',
            onClick: onVerify,
            disabled: !provenance.exportPath || provenanceBusy,
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
      const [section, setSection] = useState(() => {
        try {
          const saved = window.localStorage.getItem('ffs-analysis-section')
          return SECTIONS.includes(saved) ? saved : 'pipeline'
        } catch {
          return 'pipeline'
        }
      })
      const tabRefs = useRef({})
      const rootRef = useRef(null)

      // A section switch starts at the top of the panel; otherwise the previous scroll offset
      // can leave the new section's heading/first controls off-screen. Persist the selection so
      // reopening the tab resumes where the user was.
      useEffect(() => {
        const root = rootRef.current
        if (root) root.scrollTop = 0
        try { window.localStorage.setItem('ffs-analysis-section', section) } catch { /* ignore */ }
      }, [section])

      // Layout self-diagnostic: samples after mount (planner loads async), after load, and after
      // clicks (stage selection / All options) so the failing state is captured. Writes
      // work/ffs-analysis-client-diag.json. Geometry/class names only.
      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        // Layout diagnostics are opt-in: add ?ffs-diag=1 to the page URL to record them.
        try {
          if (!new URLSearchParams(window.location.search).has('ffs-diag')) return undefined
        } catch {
          return undefined
        }
        const timers = []
        const clickTimers = []
        const describe = (element) => {
          const style = window.getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return {
            tag: element.tagName,
            className: String(element.className || '').slice(0, 140),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            overflowY: style.overflowY,
            overflowX: style.overflowX,
            position: style.position,
            display: style.display,
            flex: style.flex,
            minHeight: style.minHeight,
            maxHeight: style.maxHeight,
          }
        }
        const send = (label) => {
          const root = rootRef.current
          if (!root) return
          const chain = []
          let node = root
          while (node && chain.length < 8) {
            chain.push(describe(node))
            node = node.parentElement
          }
          const metrics = (selector) => {
            const element = root.querySelector(selector) || document.querySelector(selector)
            return element ? describe(element) : null
          }
          const content = root.querySelector('.ffa-content')
          fetch('/ffs-analysis/client-diag', {
            method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              label,
              clientVersion: '0.1.62',
              lastClick,
              viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
              root: describe(root),
              chain,
              content: content ? { ...describe(content), scrollTop: content.scrollTop } : null,
              main: metrics('.ffa-main'),
              rail: metrics('.ffa-rail'),
              board: metrics('.ffa-stage-board'),
              drawerPanel: metrics('.ffa-drawer-panel'),
              drawerBody: metrics('.ffa-drawer-body'),
            }),
          }).catch(() => {})
        }
        for (const delay of [500, 2500, 6000]) timers.push(setTimeout(() => send(`mount+${delay}`), delay))
        const root = rootRef.current
        const onClick = (event) => {
          for (const timer of clickTimers) clearTimeout(timer)
          clickTimers.length = 0
          const target = event.target
          lastClick = {
            tag: target?.tagName || null,
            className: String(target?.className || '').slice(0, 120),
            text: String(target?.textContent || '').trim().slice(0, 60),
          }
          for (const delay of [60, 500, 1500]) {
            clickTimers.push(setTimeout(() => send(`after-click+${delay}`), delay))
          }
        }
        const observer = new MutationObserver(() => {
          if (root?.querySelector('.ffa-drawer-panel')) {
            setTimeout(() => send('dialog-open'), 150)
          }
        })
        if (root) observer.observe(root, { childList: true, subtree: true })
        root?.addEventListener('click', onClick, true)
        return () => {
          for (const timer of timers) clearTimeout(timer)
          for (const timer of clickTimers) clearTimeout(timer)
          observer.disconnect()
          root?.removeEventListener('click', onClick, true)
        }
      }, [])
      const [busy, setBusy] = useState(null)
      const [busyRun, setBusyRun] = useState(false)
      const [busyAction, setBusyAction] = useState(null)
      const [busyGroup, setBusyGroup] = useState(false)
      const [busyCohort, setBusyCohort] = useState(false)
      const [busyCohortExport, setBusyCohortExport] = useState(false)
      const [replaying, setReplaying] = useState(false)
      const [replayResult, setReplayResult] = useState(null)
      const [applyingResults, setApplyingResults] = useState(false)
      const [verifying, setVerifying] = useState(false)
      const [verifyResult, setVerifyResult] = useState(null)
      const [cohortValidation, setCohortValidation] = useState(null)
      const [recordingDecision, setRecordingDecision] = useState(false)
      const [toast, setToast] = useState(null)
      const [clearing, setClearing] = useState(false)

      useEffect(() => {
        if (!toast) return undefined
        const timer = setTimeout(() => setToast(null), 4200)
        return () => clearTimeout(timer)
      }, [toast])

      const clearAnalysis = useCallback(async () => {
        const confirmed = window.confirm(
          'Clear this analysis?\n\nThis removes the project state, pipeline, run and results from the panel.\n' +
          'Everything is backed up under work/ffs-analysis-clear-* first. The record ledger is not touched.')
        if (!confirmed) return
        setClearing(true)
        try {
          const res = await fetch('/ffs-analysis/reset', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }),
          })
          const payload = await res.json().catch(() => null)
          if (!res.ok || !payload || payload.ok !== true) {
            throw new Error(payload?.error?.message || `clear failed (${res.status})`)
          }
          setToast(`analysis cleared · backup ${payload.backup}`)
          await refresh()
        } catch (e) {
          setToast(`clear failed: ${String(e?.message || e)}`)
        } finally {
          setClearing(false)
        }
      }, [refresh])

      const recordDecision = useCallback(async (body) => {
        setRecordingDecision(true)
        try {
          const res = await fetch(DECISIONS, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          const payload = await res.json().catch(() => null)
          if (!res.ok || !payload || payload.ok !== true) {
            throw new Error(payload?.error?.message || `decision failed (${res.status})`)
          }
          setToast(`decision recorded · ${payload.decision.action} · ${payload.decision.target?.ref || ''}`)
          await refresh()
          return payload
        } catch (e) {
          setToast(String(e?.message || e))
          return null
        } finally {
          setRecordingDecision(false)
        }
      }, [refresh])

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
          setTimeout(() => {
            document.getElementById('ffa-pipeline-run')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
          }, 150)
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

      const captureViewer = useCallback(async (label) => {
        try {
          const capture = await callViewer('inspection_capture', { label: label || 'decision evidence' })
          setToast(`capture recorded · ${capture.sessionId} seq ${capture.seq}`)
          return capture
        } catch (e) {
          setToast(`viewer capture unavailable: ${e?.message || e}`)
          return null
        }
      }, [callViewer])

      const settleAnalysis = useCallback(async () => {
        setBusyAction('settle')
        const postSettle = async (body) => {
          const res = await fetch('/ffs-analysis/settle', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          })
          const payload = await res.json().catch(() => null)
          return { res, payload }
        }
        try {
          let { res, payload } = await postSettle({})
          if (res.status === 409 && payload?.error?.code === 'standard-departure') {
            const standard = payload.error.details?.standard || 'standard'
            const reason = window.prompt(
              `${standard}: ${payload.error.message}\n\nReason for settling without a QC judgment (recorded as a standard departure):`)
            if (!reason || !reason.trim()) {
              setToast('Settle cancelled — record a judgment or give a reason for the standard departure.')
              return
            }
            ;({ res, payload } = await postSettle({ standardOverride: { reason: reason.trim() } }))
          }
          if (res.status === 409 && payload?.error?.code === 'open-decisions') {
            const open = payload.error.details?.open || []
            const summary = open.map((decision) => `- ${decision.action}: ${decision.target?.ref || ''}`).join('\n')
            const proceed = window.confirm(`${open.length} open decision(s) remain:\n${summary}\n\nAcknowledge them and settle?`)
            if (!proceed) {
              setToast('Settle cancelled — resolve or acknowledge the open decisions.')
              return
            }
            ({ res, payload } = await postSettle({ acknowledge: true, note: 'acknowledged in the analysis tab' }))
          }
          if (!res.ok || !payload || payload.ok !== true) {
            throw new Error(payload?.error?.message || `settle failed (${res.status})`)
          }
          const acknowledged = payload.decisions?.open || 0
          setToast(`Settled · ${payload.id || ''}${acknowledged ? ` · acknowledged ${acknowledged} open decision(s)` : ''}`)
          await refresh()
        } catch (e) {
          setToast(`${t('settleFailed')}: ${e && e.message || e}`)
        } finally {
          setBusyAction(null)
        }
      }, [refresh, t])

      const exportCohort = useCallback(async () => {
        setBusyCohortExport(true)
        try {
          const res = await fetch('/ffs-analysis/cohort', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'export' }),
          })
          const payload = await res.json().catch(() => null)
          if (!res.ok || !payload || payload.ok !== true) {
            throw new Error(payload?.error?.message || `cohort export failed (${res.status})`)
          }
          setToast(`Cohort package: ${payload.dir || payload.zip || ''}`)
          await refresh()
          return payload
        } catch (e) {
          setToast(`Cohort export failed: ${e?.message || e}`)
        } finally {
          setBusyCohortExport(false)
        }
      }, [refresh])

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

      const copyPath = useCallback(async (value, label) => {
        try {
          await navigator.clipboard.writeText(value || '')
          setToast(label || t('copied'))
        } catch {
          setToast('Clipboard unavailable')
        }
      }, [t])

      if (loading) {
        return h('div', { className: 'ffa-root', ref: rootRef }, h('div', { className: 'ffa-content' }, h('div', { className: 'ffa-empty' }, t('loading'))))
      }
      if (error && !snap) {
        return h('div', { className: 'ffa-root', ref: rootRef },
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
      if (section === 'pipeline') content = h(PipelineSection, { snap, t, onCancel: cancelPipeline, runningNow, busyRun })
      else if (section === 'data') content = h(DataSection, { snap, t, onLoad: loadIntoViewer, onCopy: copyPath, busy })
      else if (section === 'qc') content = h(QcSection, { snap, t, onDecision: recordDecision, recordingDecision, onCapture: captureViewer })
      else if (section === 'results') content = h(ResultsSection, { snap, t, onInspect: inspectResults, onApplyResults: applyResultsView, applyingResults })
      else if (section === 'cohort') content = h(CohortSection, {
          snap, t, onValidate: validateCohortUi, validating: busyCohort, validation: cohortValidation,
          onToggleInclude: toggleCohortInclude, onExport: exportCohort, exporting: busyCohortExport,
          onCopy: copyPath,
        })
      else if (section === 'group') content = h(GroupSection, { snap, t, onRunGroup: runGroup, runningGroup: busyGroup, onInspectGroup: inspectGroup, onCopy: copyPath })
      else if (section === 'settings') content = h(SettingsSection, { snap, t, onApplyResults: applyResultsView, applyingResults })
      else content = h(ProvenanceSection, { snap, t, onSettle: settleAnalysis, onExport: exportAnalysis, onReplay: replayPipeline, onVerify: verifyPackageUi, busyAction, replaying, replayResult, verifying, verifyResult, onCopy: copyPath })

      return h('div', { className: 'ffa-root', ref: rootRef },
        h('header', { className: 'ffa-head' },
          h('span', { className: 'ffa-brand', title: t('title') }, h(AnalysisIcon, { size: 15 }), t('title')),
          h('span', { className: 'ffa-sub' }, `${snap.project?.dataset || ''} · ${snap.project?.subject || ''}`),
          h('span', { className: 'ffa-tag' }, snap.source === 'live' ? t('sourceLive') : snap.source === 'empty' ? (snap.cleared ? 'cleared' : 'empty') : t('sourceFixture')),
          h('span', { className: 'ffa-spacer' }),
          h(StatusPill, { status: pipeline.status }),
          runningNow
            ? h('span', { className: 'ffa-run-chip', title: 'Run progress' },
              `running · ${typeof pipeline.progress === 'number' ? `${pipeline.progress}%` : '…'}${pipeline.currentStage ? ` · ${pipeline.currentStage}` : ''}`)
            : null,
          runningNow
            ? h('button', {
              className: 'ffa-btn',
              onClick: () => document.getElementById('ffa-pipeline-run')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }),
              title: 'Scroll to the run pipeline',
            }, 'Watch')
            : null,
          runningNow
            ? h('button', { className: 'ffa-btn ffa-btn-danger', onClick: cancelPipeline, disabled: busyRun }, busyRun ? '…' : 'Cancel')
            : null,
          h('button', {
            className: 'ffa-btn ffa-btn-danger', onClick: clearAnalysis,
            disabled: clearing || runningNow,
            title: runningNow ? 'Cannot clear while a run is active' : 'Clear analysis (backs up state first)',
          }, clearing ? 'Clearing…' : 'Clear'),
          h('button', { className: 'ffa-btn', onClick: refresh, disabled: refreshing, title: t('refresh') }, refreshing ? '…' : t('refresh')),
          h('button', { className: 'ffa-btn ffa-btn-primary', onClick: openViewer }, t('openViewer'))),
        h('div', { className: 'ffa-main' },
          h('nav', { className: 'ffa-rail', role: 'tablist', 'aria-label': 'analysis sections', 'aria-orientation': 'vertical' },
            SECTIONS.map((name, index) => h('button', {
              key: name,
              id: `ffa-tab-${name}`,
              type: 'button',
              className: `ffa-rail-item${section === name ? ' is-active' : ''}`,
              role: 'tab',
              'aria-selected': section === name,
              'aria-controls': `ffa-panel-${name}`,
              tabIndex: section === name ? 0 : -1,
              ref: (node) => { tabRefs.current[name] = node },
              onClick: () => setSection(name),
              onKeyDown: (event) => {
                const last = SECTIONS.length - 1
                let next = null
                if (event.key === 'ArrowDown') next = index === last ? 0 : index + 1
                else if (event.key === 'ArrowUp') next = index === 0 ? last : index - 1
                else if (event.key === 'Home') next = 0
                else if (event.key === 'End') next = last
                if (next === null) return
                event.preventDefault()
                setSection(SECTIONS[next])
                requestAnimationFrame(() => tabRefs.current[SECTIONS[next]]?.focus())
              },
            }, h(Icon, { kind: name }), h('span', { className: 'ffa-rail-label' }, t(name)),
            counts[name] !== undefined ? h('span', { className: 'ffa-rail-count' }, counts[name]) : null))),
          h('div', {
            className: 'ffa-content', role: 'tabpanel', id: `ffa-panel-${section}`,
            'aria-labelledby': `ffa-tab-${section}`, tabIndex: 0,
          },
          snap.source === 'empty'
            ? h('div', { className: 'ffa-empty-banner' },
              h('strong', null, snap.cleared ? 'Analysis cleared.' : 'No analysis loaded.'),
              snap.cleared
                ? ' Set a Dataset, choose a recipe, then Generate script. The previous state is backed up under work/ffs-analysis-clear-*.'
                : ' Set a Dataset, choose a recipe, then Generate script to start an analysis.')
            : null,
          h('div', {
            className: 'ffa-planner-mount', key: snap.project?.workDir || 'default',
            style: section === 'pipeline' ? { display: 'contents' } : { display: 'none' },
          }, h(PlannerBoundary, null, h(PlannerSection, {
            snap, t, onToast: setToast, onRefresh: refresh,
            onRun: runPipeline, busyRun, runningNow,
          }))),
          h(SectionBoundary, { key: section }, content))),
        error ? h('div', { className: 'ffa-small', style: { padding: '0 14px 6px', color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
        h('footer', { className: 'ffa-foot' },
          `${t('prototype')} · client 0.1.62 · ${snap.source === 'live' ? 'live project state' : snap.source === 'empty' ? (snap.cleared ? 'cleared · no analysis' : 'empty · no analysis') : 'fixtures/demo.json'} · ${snap.project?.device || ''}`),
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
      // Exposed for the interaction smoke test; not used by the runtime.
      __test: { AnalysisBody, DataSection, QcSection, ResultsSection, CohortSection, GroupSection, SettingsSection, ProvenanceSection, PipelineSection, PlannerGuide, QcDecisionModal: null },
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
