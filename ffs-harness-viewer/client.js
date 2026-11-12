/**
 * FFS Harness viewer — Client half.
 *
 * One resizable workspace that consolidates the desktop viewer's separate windows into
 * docked/tabbed panes. The browser owns only ephemeral view concerns (camera pose,
 * hover, canvas size); every scientific decision comes from the sidecar through the
 * authenticated /ffs RPC channel:
 *
 *   - slice pixels, coordinate mapping, outlines and click picking  -> render/pick
 *   - surface meshes are FFS geometry; per-vertex colours are FFS sampling -> surface
 *   - graph cells are FFS PlaneLayout + ViewerSession time courses    -> series
 *
 * User controls and agent tools call the same endpoints with the same command lines.
 */
window.__ModuleLoader__.load({
  id: '@local/ffs-harness-viewer',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const BRIDGE = '/ffs'
    const TOKENS = {
      bg: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      overlay: 'var(--dsw-alias-bg-overlay)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }
    const SERIES_COLORS = ['#7aa2f7', '#f7768e', '#9ece6a', '#e0af68', '#bb9af7', '#7dcfff', '#ff9e64', '#c0caf5']
    const VIEW_KIND_PREFIX = { image: 'V', graph: 'G', surface: 'S', carpet: 'C', matrix: 'M', clusters: 'K', trace: 'T', profile: 'P', depth: 'D', chedi: 'E' }

    const CSS = `
      .ffs-root { font: 12px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: ${TOKENS.text}; pointer-events: none; }
      .ffs-root > * { pointer-events: auto; }
      .ffs-launch { position: fixed; right: 18px; bottom: 18px; z-index: 60; display: flex; align-items: center; gap: 8px;
        padding: 8px 12px; border-radius: 999px; border: 1px solid ${TOKENS.borderStrong}; background: ${TOKENS.overlay};
        color: ${TOKENS.text}; box-shadow: 0 8px 24px rgba(0,0,0,.18); cursor: pointer; font-weight: 600; }
      .ffs-launch:hover { border-color: ${TOKENS.brand}; }
      .ffs-workspace { position: fixed; z-index: 55; display: flex; flex-direction: column; min-width: 520px; min-height: 360px;
        background: ${TOKENS.bg}; border: 1px solid ${TOKENS.borderStrong}; border-radius: 10px;
        box-shadow: 0 18px 60px rgba(0,0,0,.32); overflow: hidden; color: ${TOKENS.text}; }
      .ffs-workspace.max { inset: 12px !important; width: auto !important; height: auto !important; }
      .ffs-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid ${TOKENS.border};
        background: ${TOKENS.layer1}; cursor: move; user-select: none; touch-action: none; }
      .ffs-head .title { font-weight: 700; letter-spacing: .01em; }
      .ffs-sub { color: ${TOKENS.muted}; font-size: 11px; }
      .ffs-btn { appearance: none; border: 1px solid ${TOKENS.border}; background: ${TOKENS.layer2}; color: ${TOKENS.text};
        border-radius: 6px; padding: 3px 8px; cursor: pointer; font: inherit; }
      .ffs-btn:hover { border-color: ${TOKENS.brand}; }
      .ffs-btn.active { border-color: ${TOKENS.brand}; color: ${TOKENS.brand}; }
      .ffs-btn.icon { padding: 2px 7px; line-height: 1.2; }
      .ffs-btn.danger:hover { border-color: ${TOKENS.error}; color: ${TOKENS.error}; }
      .ffs-body { flex: 1; display: flex; min-height: 0; }
      .ffs-rail input[type=checkbox] { appearance: none; -webkit-appearance: none; width: 13px; height: 13px;
        flex: 0 0 auto; border: 1px solid ${TOKENS.borderStrong}; border-radius: 4px; background: ${TOKENS.layer2};
        cursor: pointer; vertical-align: middle; }
      .ffs-rail input[type=checkbox]:checked { background-color: ${TOKENS.brand}; border-color: ${TOKENS.brand};
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='8'%3E%3Cpath d='M1 4l2.5 2.5L9 1' fill='none' stroke='white' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
        background-repeat: no-repeat; background-position: center; }
      .ffs-rail input[type=checkbox]:focus { outline: none; box-shadow: 0 0 0 2px ${TOKENS.brand}44; }
      .ffs-rail { position: relative; width: 272px; flex: 0 0 auto; overflow: hidden; border-right: 1px solid ${TOKENS.border};
        background: ${TOKENS.bg}; display: flex; flex-direction: column; min-height: 0; }
      .ffs-rail-head { display: flex; align-items: center; gap: 8px; padding: 9px 10px;
        border-bottom: 1px solid ${TOKENS.border}; background: ${TOKENS.layer1}; flex: 0 0 auto; }
      .ffs-eyebrow { font-size: 9px; letter-spacing: .16em; text-transform: uppercase; color: ${TOKENS.brand};
        font-weight: 700; line-height: 1; margin-bottom: 2px; }
      .ffs-rail-title { font-size: 13px; letter-spacing: .01em; }
      .ffs-primary { background: ${TOKENS.brand}; color: ${TOKENS.bg}; border-color: ${TOKENS.brand};
        font-weight: 600; }
      .ffs-primary:hover { filter: brightness(1.08); }
      .ffs-rail-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; display: flex;
        flex-direction: column; gap: 8px; }
      .ffs-card { border: 1px solid ${TOKENS.border}; border-radius: 9px; background: ${TOKENS.layer1};
        overflow: hidden; flex: 0 0 auto; }
      .ffs-card-head { width: 100%; display: flex; align-items: center; gap: 6px; border: 0;
        border-bottom: 1px solid transparent; background: ${TOKENS.layer2}; color: ${TOKENS.text};
        padding: 6px 8px; cursor: pointer; font: inherit; text-align: left; }
      .ffs-card-head:hover { background: ${TOKENS.layer1}; }
      .ffs-card-title { font-size: 10px; letter-spacing: .09em; text-transform: uppercase; font-weight: 700;
        color: ${TOKENS.muted}; flex: 1; }
      .ffs-card-count { font-size: 9px; color: ${TOKENS.muted}; border: 1px solid ${TOKENS.border};
        border-radius: 999px; padding: 0 5px; }
      .ffs-chevron { color: ${TOKENS.muted}; font-size: 13px; transform: rotate(0deg); transition: transform .12s ease;
        width: 10px; text-align: center; }
      .ffs-chevron.open { transform: rotate(90deg); }
      .ffs-card-body { display: flex; flex-direction: column; gap: 7px; padding: 8px; }
      .ffs-layer-row { display: flex; align-items: center; gap: 6px; padding: 5px 5px; border-radius: 7px;
        border: 1px solid transparent; cursor: pointer; }
      .ffs-layer-row:hover { background: ${TOKENS.layer2}; }
      .ffs-layer-row.active { background: ${TOKENS.layer2}; border-color: ${TOKENS.brand}; }
      .ffs-eye { width: 18px; height: 18px; flex: 0 0 auto; border: 0; border-radius: 4px; background: transparent;
        color: ${TOKENS.muted}; cursor: pointer; padding: 0; font-size: 12px; line-height: 1; }
      .ffs-eye:hover { color: ${TOKENS.text}; background: ${TOKENS.layer1}; }
      .ffs-unload { opacity: .35; }
      .ffs-layer-row:hover .ffs-unload, .ffs-layer-row.active .ffs-unload { opacity: .9; }
      .ffs-unload:hover { color: ${TOKENS.error}; }
      .ffs-swatch { width: 12px; height: 12px; flex: 0 0 auto; border-radius: 3px;
        border: 1px solid ${TOKENS.borderStrong}; }
      .ffs-layer-main { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
      .ffs-layer-name { font-size: 11px; color: ${TOKENS.text}; white-space: nowrap; overflow: hidden;
        text-overflow: ellipsis; }
      .ffs-layer-sub { font-size: 9px; color: ${TOKENS.muted}; letter-spacing: .02em; }
      .ffs-selected-head { display: flex; align-items: center; gap: 6px; padding-bottom: 2px;
        border-bottom: 1px dashed ${TOKENS.border}; }
      .ffs-selected-name { font-size: 11px; min-width: 0; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; flex: 1; }
      .ffs-key { font: 9px ui-monospace, monospace; color: ${TOKENS.muted}; border: 1px solid ${TOKENS.border};
        border-radius: 4px; padding: 0 4px; }
      .ffs-control { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
      .ffs-control-head { display: flex; align-items: center; justify-content: space-between; gap: 6px;
        font-size: 10px; color: ${TOKENS.muted}; }
      .ffs-control-value { font: 10px ui-monospace, monospace; color: ${TOKENS.text}; }
      .ffs-control input[type=range] { width: 100%; margin: 0; accent-color: ${TOKENS.brand}; }
      .ffs-number-field { width: 100%; min-width: 0; flex: 1; box-sizing: border-box; text-align: right; }
      .ffs-control input[type=number] { width: 58px; background: ${TOKENS.layer2}; color: ${TOKENS.text};
        border: 1px solid ${TOKENS.border}; border-radius: 5px; padding: 2px 4px; font: inherit;
        font-size: 10px; font-variant-numeric: tabular-nums; }
      .ffs-control input[type=number]:focus { outline: none; border-color: ${TOKENS.brand}; }
      .ffs-control input.ffs-number-field { width: 100%; flex: 1; min-width: 0; text-align: right; }
      .ffs-control input.ffs-threshold-input { width: 64px; flex: 0 0 64px; }
      .ffs-mini { border: 0; background: transparent; color: ${TOKENS.brand}; cursor: pointer;
        font: inherit; font-size: 10px; padding: 0; }
      .ffs-mini:hover { text-decoration: underline; }
      .ffs-colorbar-wrap { display: flex; flex-direction: column; gap: 2px; }
      .ffs-colorbar { position: relative; height: 16px; border: 1px solid ${TOKENS.border};
        border-radius: 4px; overflow: hidden; touch-action: none; cursor: crosshair; }
      .ffs-colorbar-handle { position: absolute; top: -2px; bottom: -2px; width: 6px; z-index: 3;
        background: rgba(255,255,255,.9); border: 1px solid rgba(0,0,0,.45); border-radius: 3px;
        cursor: ew-resize; box-shadow: 0 1px 2px rgba(0,0,0,.35); }
      .ffs-colorbar-handle.lo { left: 0; transform: translateX(-50%); }
      .ffs-colorbar-handle.hi { right: 0; transform: translateX(50%); }
      .ffs-colorbar-thr { position: absolute; top: -1px; bottom: -1px; width: 2px;
        background: #f7768e; box-shadow: 0 0 0 1px rgba(0,0,0,.45); }
      .ffs-colorbar-labels { display: flex; justify-content: space-between;
        color: ${TOKENS.muted}; font: 9px ui-monospace, monospace; }
      .ffs-select { width: 100%; appearance: none; -webkit-appearance: none; background: ${TOKENS.layer2};
        color: ${TOKENS.text}; border: 1px solid ${TOKENS.border}; border-radius: 7px;
        padding: 4px 22px 4px 7px; font: inherit; font-size: 11px; line-height: 1.3;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5'%3E%3Cpath d='M0 0l4 5 4-5z' fill='%239aa4b2'/%3E%3C/svg%3E");
        background-repeat: no-repeat; background-position: right 7px center; }
      .ffs-select:focus { outline: none; border-color: ${TOKENS.brand}; }
      .ffs-seg { display: flex; border: 1px solid ${TOKENS.border}; border-radius: 6px; overflow: hidden; }
      .ffs-seg button { flex: 1; border: 0; border-right: 1px solid ${TOKENS.border}; background: transparent;
        color: ${TOKENS.muted}; padding: 3px 2px; cursor: pointer; font: inherit; font-size: 10px;
        margin: 1px; border-radius: 5px; }
      .ffs-seg button:last-child { border-right: 0; }
      .ffs-seg button:hover { color: ${TOKENS.text}; }
      .ffs-seg button.active { background: ${TOKENS.layer1}; color: ${TOKENS.text};
        box-shadow: inset 0 0 0 1px ${TOKENS.brand}; border-radius: 5px; }
      .ffs-seg button:last-child { border-right: 0; }
      .ffs-advanced-toggle { align-self: flex-start; border: 0; background: transparent; color: ${TOKENS.brand};
        cursor: pointer; font: inherit; font-size: 10px; padding: 0; }
      .ffs-advanced-toggle:hover { text-decoration: underline; }
      .ffs-check-row { display: flex; align-items: center; gap: 6px; color: ${TOKENS.muted}; font-size: 11px; }
      .ffs-time { display: flex; align-items: center; gap: 5px; }
      .ffs-step { border: 1px solid ${TOKENS.border}; background: ${TOKENS.layer2}; color: ${TOKENS.text};
        border-radius: 5px; width: 22px; height: 20px; cursor: pointer; font: inherit; font-size: 9px; padding: 0; }
      .ffs-step:hover { border-color: ${TOKENS.brand}; }
      .ffs-time-read { font: 10px ui-monospace, monospace; color: ${TOKENS.muted}; text-align: right; }
      .ffs-code { font: 10px/1.55 ui-monospace, SFMono-Regular, monospace; color: ${TOKENS.muted};
        background: ${TOKENS.layer2}; border: 1px solid ${TOKENS.border}; border-radius: 6px;
        padding: 5px 7px; white-space: pre-wrap; }
      .ffs-readout { margin: 0; font: 10px/1.45 ui-monospace, monospace; color: ${TOKENS.muted};
        max-height: 58px; overflow: auto; white-space: pre-wrap; }
      .ffs-info-row { display: flex; align-items: baseline; gap: 6px; font-size: 11px; }
      .ffs-info-label { color: ${TOKENS.muted}; width: 52px; flex: 0 0 auto; font-size: 10px; }
      .ffs-info-value { color: ${TOKENS.text}; min-width: 0; overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; }
      .ffs-empty-note { color: ${TOKENS.muted}; font-size: 10px; line-height: 1.45; }
      .ffs-path-tip { position: absolute; left: 8px; right: 8px; bottom: 42px; z-index: 35;
        background: ${TOKENS.overlay}; border: 1px solid ${TOKENS.borderStrong}; border-radius: 7px;
        box-shadow: 0 8px 24px rgba(0,0,0,.35); color: ${TOKENS.text}; font: 10px/1.45 ui-monospace, monospace;
        padding: 6px 8px; word-break: break-all; white-space: pre-wrap; pointer-events: none;
        max-height: 92px; overflow: hidden; }
      .ffs-rail-foot { display: flex; align-items: center; gap: 5px; padding: 7px 8px;
        border-top: 1px solid ${TOKENS.border}; background: ${TOKENS.layer1}; flex: 0 0 auto; }
      .ffs-foot-status { margin-left: auto; color: ${TOKENS.muted}; font-size: 9px; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; }
      .ffs-row { display: flex; align-items: center; gap: 6px; }
      .ffs-row.wrap { flex-wrap: wrap; }
      .ffs-grow { flex: 1; min-width: 0; }
      .ffs-chip { border: 1px solid ${TOKENS.border}; border-radius: 999px; padding: 1px 7px; font-size: 10px; color: ${TOKENS.muted}; }
      .ffs-chip.ok { color: ${TOKENS.ok}; border-color: ${TOKENS.ok}; }
      .ffs-chip.warn { color: ${TOKENS.warn}; border-color: ${TOKENS.warn}; }
      .ffs-chip.err { color: ${TOKENS.error}; border-color: ${TOKENS.error}; }
      .ffs-dock { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      .ffs-split { display: flex; flex: 1; min-width: 0; min-height: 0; }
      .ffs-split.row { flex-direction: row; }
      .ffs-split.column { flex-direction: column; }
      .ffs-divider { flex: 0 0 5px; background: transparent; cursor: col-resize; position: relative; z-index: 2; }
      .ffs-split.column > .ffs-divider { cursor: row-resize; }
      .ffs-divider:hover { background: ${TOKENS.brand}; opacity: .5; }
      .ffs-group { display: flex; flex-direction: column; min-width: 0; min-height: 0; border: 1px solid ${TOKENS.border};
        border-radius: 7px; margin: 4px; background: ${TOKENS.layer1}; overflow: hidden; }
      .ffs-tabs { display: flex; align-items: center; gap: 2px; padding: 3px 4px; background: ${TOKENS.layer2};
        border-bottom: 1px solid ${TOKENS.border}; overflow-x: auto; flex: 0 0 auto; }
      .ffs-tab { border: 1px solid transparent; background: transparent; color: ${TOKENS.muted}; border-radius: 5px;
        padding: 2px 8px; cursor: pointer; font: inherit; white-space: nowrap; }
      .ffs-tab.active { background: ${TOKENS.layer1}; color: ${TOKENS.text}; border-color: ${TOKENS.border}; }
      .ffs-tab.drop { border-color: ${TOKENS.brand}; }
      .ffs-pane { flex: 1; min-height: 0; position: relative; display: flex; flex-direction: column; }
      .ffs-pane-head { display: flex; align-items: center; gap: 4px; padding: 2px 6px; border-bottom: 1px solid ${TOKENS.border};
        background: ${TOKENS.layer1}; flex: 0 0 auto; }
      .ffs-pane-title { font-size: 11px; color: ${TOKENS.muted}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ffs-canvas-pending { position: absolute; left: 50%; top: 8px; transform: translateX(-50%);
        z-index: 4; padding: 2px 8px; border-radius: 10px; background: ${TOKENS.overlay};
        border: 1px solid ${TOKENS.borderStrong}; color: ${TOKENS.muted}; font-size: 10px;
        pointer-events: none; letter-spacing: .03em; }
      .ffs-canvas-wrap { flex: 1; min-height: 0; position: relative; background: #0b0d10; touch-action: none; }
      .ffs-canvas-wrap canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
      .ffs-pop { position: absolute; right: 4px; top: 26px; z-index: 20; width: 248px; max-height: 70%; overflow: auto;
        background: ${TOKENS.overlay}; border: 1px solid ${TOKENS.borderStrong}; border-radius: 8px; padding: 8px;
        box-shadow: 0 10px 30px rgba(0,0,0,.28); display: flex; flex-direction: column; gap: 6px; }
      .ffs-field { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .ffs-field label { color: ${TOKENS.muted}; font-size: 11px; }
      .ffs-field select, .ffs-field input[type=number], .ffs-field input[type=text] {
        background: ${TOKENS.layer2}; color: ${TOKENS.text}; border: 1px solid ${TOKENS.border}; border-radius: 5px;
        padding: 2px 4px; font: inherit; max-width: 128px; }
      .ffs-field input[type=range] { width: 118px; accent-color: ${TOKENS.brand}; }
      .ffs-hint { color: ${TOKENS.muted}; font-size: 10px; line-height: 1.35; }
      .ffs-foot { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-top: 1px solid ${TOKENS.border};
        background: ${TOKENS.layer1}; flex: 0 0 auto; }
      .ffs-foot input[type=text] { flex: 1; min-width: 80px; background: ${TOKENS.layer2}; color: ${TOKENS.text};
        border: 1px solid ${TOKENS.border}; border-radius: 6px; padding: 4px 7px; font: 12px ui-monospace, monospace; }
      .ffs-log { max-height: 92px; overflow: auto; color: ${TOKENS.muted}; font: 10px/1.4 ui-monospace, monospace;
        border-top: 1px solid ${TOKENS.border}; padding: 3px 8px; background: ${TOKENS.layer1}; }
      .ffs-error { color: ${TOKENS.error}; border: 1px solid ${TOKENS.error}; border-radius: 6px; padding: 6px 8px; margin: 6px; }
      .ffs-empty { flex: 1; display: grid; place-items: center; color: ${TOKENS.muted}; padding: 24px; text-align: center; }
      .ffs-legend { display: flex; flex-wrap: wrap; gap: 8px; padding: 4px 8px; border-bottom: 1px solid ${TOKENS.border};
        background: ${TOKENS.layer1}; font-size: 10px; color: ${TOKENS.muted}; }
      .ffs-legend button { background: none; border: 0; color: inherit; font: inherit; cursor: pointer; display: flex; gap: 4px; align-items: center; }
      .ffs-swatch { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
      .ffs-modal-bg { position: fixed; inset: 0; z-index: 70; background: rgba(0,0,0,.35); }
      .ffs-center { flex: 1; display: grid; place-items: center; color: ${TOKENS.muted}; }
      .ffs-root { position: absolute; inset: 0; width: 100%; height: 100%; min-height: 0; display: flex; flex-direction: column;
        overflow: hidden; background: ${TOKENS.bg}; color: ${TOKENS.text}; pointer-events: auto;
        padding: 6px; box-sizing: border-box; }
      .ffs-header { display: flex; align-items: center; gap: 6px; padding: 4px 6px; flex: 0 0 auto;
        border-bottom: 1px solid ${TOKENS.border}; background: ${TOKENS.layer1}; font-size: 11px; }
      .ffs-brand { display: flex; align-items: center; gap: 5px; font-weight: 700; white-space: nowrap; }
      .ffs-open-btn { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px;
        border-radius: 6px; border: 1px solid ${TOKENS.border}; background: ${TOKENS.layer2}; color: ${TOKENS.text};
        cursor: pointer; font: inherit; font-size: 12px; white-space: nowrap; }
      .ffs-open-btn:hover { border-color: ${TOKENS.brand}; color: ${TOKENS.brand}; }
      .ffs-rail-overlay { position: absolute; z-index: 25; left: 4px; top: 4px; bottom: 4px; width: 300px;
        border: 1px solid ${TOKENS.borderStrong}; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.3);
        background: ${TOKENS.bg}; }
      .ffs-rail-overlay > .ffs-rail { width: 100%; border-right: 0; }
      .ffs-picker-backdrop { position: absolute; inset: 0; z-index: 60; background: rgba(0,0,0,.45);
        display: grid; place-items: center; padding: 14px; }
      .ffs-picker { position: relative; width: min(700px, 100%); max-height: 100%; display: flex; flex-direction: column;
        background: ${TOKENS.overlay}; border: 1px solid ${TOKENS.borderStrong}; border-radius: 10px;
        box-shadow: 0 18px 60px rgba(0,0,0,.4); overflow: hidden; }
      .ffs-picker-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
        border-bottom: 1px solid ${TOKENS.border}; background: ${TOKENS.layer1}; font-weight: 700; }
      .ffs-picker-path { display: flex; align-items: center; gap: 4px; padding: 6px 8px;
        border-bottom: 1px solid ${TOKENS.border}; background: ${TOKENS.layer1}; }
      .ffs-picker-path input { flex: 1; min-width: 80px; background: ${TOKENS.layer2}; color: ${TOKENS.text};
        border: 1px solid ${TOKENS.border}; border-radius: 5px; padding: 3px 6px; font: 11px ui-monospace, monospace; }
      .ffs-picker-list { overflow: auto; min-height: 140px; max-height: 46vh; background: ${TOKENS.bg}; }
      .ffs-picker-row { display: flex; align-items: center; gap: 8px; padding: 5px 9px;
        border-bottom: 1px solid ${TOKENS.border}; cursor: pointer; font-size: 12px; }
      .ffs-picker-row:hover { background: ${TOKENS.layer2}; }
      .ffs-picker-row.selected { background: ${TOKENS.layer2}; outline: 1px solid ${TOKENS.brand}; outline-offset: -1px; }
      .ffs-picker-row .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ffs-picker-row.dir .name { font-weight: 600; }
      .ffs-picker-row .meta { color: ${TOKENS.muted}; font-size: 10px; white-space: nowrap; }
      .ffs-picker-shortcuts { display: flex; gap: 6px; flex-wrap: wrap; padding: 5px 8px; border-top: 1px solid ${TOKENS.border}; background: ${TOKENS.layer1}; }
      .ffs-picker-foot { display: flex; align-items: center; gap: 6px; padding: 6px 8px;
        border-top: 1px solid ${TOKENS.border}; background: ${TOKENS.layer1}; }
      .ffs-picker-detail { flex: 1; min-width: 0; color: ${TOKENS.muted}; font-size: 10px;
        line-height: 1.4; white-space: pre-wrap; word-break: break-all; max-height: 42px;
        overflow: auto; font-family: ui-monospace, monospace; }
      .ffs-picker-foot .ffs-btn { flex: 0 0 auto; }
      .ffs-picker-error { color: ${TOKENS.error}; font-size: 11px; padding: 5px 8px; }
      .ffs-sources-body { display: flex; flex: 1; min-height: 0; }
      .ffs-sources-side { width: 262px; flex: 0 0 auto; display: flex; flex-direction: column; overflow: auto;
        border-right: 1px solid ${TOKENS.border}; background: ${TOKENS.layer1}; }
      .ffs-sources-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      .ffs-source-head { display: flex; align-items: center; gap: 4px; padding: 5px 8px;
        border-bottom: 1px solid ${TOKENS.border}; font-size: 10px; font-weight: 700;
        letter-spacing: .08em; text-transform: uppercase; color: ${TOKENS.muted}; }
      .ffs-source-row { display: flex; align-items: center; gap: 5px; padding: 4px 9px; cursor: pointer;
        font-size: 11px; border-bottom: 1px solid ${TOKENS.border}; }
      .ffs-source-row:hover { background: ${TOKENS.layer2}; }
      .ffs-source-row.active { background: ${TOKENS.layer2}; box-shadow: inset 2px 0 0 ${TOKENS.brand}; }
      .ffs-source-row .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ffs-source-row .meta { color: ${TOKENS.muted}; font-size: 9px; }
      .ffs-source-row button.mini { border: 0; background: none; color: ${TOKENS.muted}; cursor: pointer; padding: 0 2px; }
      .ffs-catalog-row { display: flex; align-items: center; gap: 8px; padding: 5px 9px;
        border-bottom: 1px solid ${TOKENS.border}; cursor: pointer; font-size: 12px; }
      .ffs-catalog-row:hover { background: ${TOKENS.layer2}; }
      .ffs-catalog-row.selected { background: ${TOKENS.layer2}; box-shadow: inset 0 0 0 1px ${TOKENS.brand};
        border-radius: 6px; }
      .ffs-catalog-main { display: flex; flex-direction: column; min-width: 0; flex: 1; gap: 1px; }
      .ffs-catalog-name { color: ${TOKENS.text}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ffs-catalog-meta { color: ${TOKENS.muted}; font-size: 10px; white-space: nowrap; overflow: hidden;
        text-overflow: ellipsis; }
      .ffs-catalog-row .ffs-kind { align-self: flex-start; margin-top: 2px; }
      .ffs-filter-row { display: flex; flex-wrap: wrap; gap: 4px; padding: 5px 8px;
        border-bottom: 1px solid ${TOKENS.border}; background: ${TOKENS.layer1}; flex: 0 0 auto; }
      .ffs-filter-chip { border: 1px solid ${TOKENS.border}; background: transparent; color: ${TOKENS.muted};
        border-radius: 999px; padding: 2px 7px; cursor: pointer; font: inherit; font-size: 10px; }
      .ffs-filter-chip:hover { color: ${TOKENS.text}; border-color: ${TOKENS.borderStrong}; }
      .ffs-filter-chip.active { background: ${TOKENS.brand}; border-color: ${TOKENS.brand}; color: ${TOKENS.bg}; font-weight: 600; }
      .ffs-filter-count { opacity: .65; margin-left: 3px; font-variant-numeric: tabular-nums; }
      .ffs-kind { border: 1px solid ${TOKENS.border}; border-radius: 4px; padding: 0 4px;
        font-size: 9px; text-transform: uppercase; color: ${TOKENS.muted}; min-width: 34px; text-align: center; }
      .ffs-empty-start { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 8px; margin: 8px; border: 1px dashed ${TOKENS.borderStrong}; border-radius: 10px;
        padding: 24px; text-align: center; color: ${TOKENS.muted}; }
      .ffs-empty-start h3 { margin: 0; color: ${TOKENS.text}; font-size: 14px; }
      .ffs-layout-menu { position: absolute; right: 8px; top: 34px; z-index: 45; width: 168px;
        display: flex; flex-direction: column; background: ${TOKENS.overlay};
        border: 1px solid ${TOKENS.borderStrong}; border-radius: 8px; padding-bottom: 4px;
        box-shadow: 0 10px 30px rgba(0,0,0,.3); }
      .ffs-layout-menu .ffs-btn { margin: 3px 6px; text-align: left; }
      .ffs-layout-menu { width: 190px; max-height: 70vh; overflow-y: auto; }
      .ffs-add-menu { width: 245px; }
      .ffs-add-menu .ffs-btn { text-align: left; }
      .ffs-add-menu .ffs-btn:disabled { opacity: .45; cursor: default; }
      .ffs-floating-host { flex: 1; min-width: 0; position: relative; overflow: hidden; }
      .ffs-floating { position: absolute; inset: 0; overflow: hidden; }
      .ffs-float { position: absolute; display: flex; flex-direction: column; min-width: 0; min-height: 0;
        background: ${TOKENS.bg}; border: 1px solid ${TOKENS.borderStrong}; border-radius: 8px;
        overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,.28); }
      .ffs-float.max { box-shadow: 0 14px 44px rgba(0,0,0,.4); }
      .ffs-float-head { display: flex; align-items: center; gap: 3px; flex: 0 0 auto; height: 24px;
        padding: 0 4px; background: ${TOKENS.layer1}; border-bottom: 1px solid ${TOKENS.border};
        cursor: move; user-select: none; touch-action: none; }
      .ffs-grip { color: ${TOKENS.muted}; font-size: 10px; line-height: 1; padding: 0 2px; }
      .ffs-float-title { font-size: 11px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ffs-float-hint { margin-left: auto; color: ${TOKENS.muted}; font-size: 9px; opacity: .65; white-space: nowrap; }
      .ffs-snap-overlay { position: absolute; inset: 0; z-index: 100; pointer-events: none; }
      .ffs-snap-cell { position: absolute; border: 2px dashed ${TOKENS.brand}; border-radius: 8px;
        background: rgba(122,162,247,.08); box-sizing: border-box; transition: background .08s ease; }
      .ffs-snap-cell.active { background: rgba(122,162,247,.22); border-style: solid;
        box-shadow: inset 0 0 0 1px ${TOKENS.brand}; }
      .ffs-resize-grip { position: absolute; right: 2px; bottom: 1px; z-index: 4;
        color: ${TOKENS.muted}; font-size: 10px; line-height: 1; cursor: nwse-resize;
        opacity: .5; user-select: none; }
      .ffs-resize-grip:hover { opacity: 1; color: ${TOKENS.brand}; }
      .ffs-float-btn { border: 0; background: none; color: ${TOKENS.muted}; cursor: pointer; width: 20px; height: 18px;
        border-radius: 4px; font-size: 11px; line-height: 1; }
      .ffs-float-btn:hover { background: ${TOKENS.layer2}; color: ${TOKENS.text}; }
      .ffs-float-btn.danger:hover { color: ${TOKENS.error}; }
      .ffs-float-body { flex: 1; min-height: 0; display: flex; }
      .ffs-float-body > .ffs-group { flex: 1; margin: 0; border: 0; border-radius: 0; }
      .ffs-resize { position: absolute; z-index: 3; }
      .ffs-resize.n { top: -3px; left: 8px; right: 8px; height: 6px; cursor: n-resize; }
      .ffs-resize.s { bottom: -3px; left: 8px; right: 8px; height: 6px; cursor: s-resize; }
      .ffs-resize.e { right: -3px; top: 8px; bottom: 8px; width: 6px; cursor: e-resize; }
      .ffs-resize.w { left: -3px; top: 8px; bottom: 8px; width: 6px; cursor: w-resize; }
      .ffs-resize.ne { right: -3px; top: -3px; width: 10px; height: 10px; cursor: ne-resize; }
      .ffs-resize.nw { left: -3px; top: -3px; width: 10px; height: 10px; cursor: nw-resize; }
      .ffs-resize.se { right: -3px; bottom: -3px; width: 10px; height: 10px; cursor: se-resize; }
      .ffs-resize.sw { left: -3px; bottom: -3px; width: 10px; height: 10px; cursor: sw-resize; }
      .ffs-taskbar { position: absolute; left: 4px; right: 4px; bottom: 2px; z-index: 60; height: 26px;
        display: flex; align-items: center; gap: 4px; padding: 0 4px; background: ${TOKENS.overlay};
        border: 1px solid ${TOKENS.borderStrong}; border-radius: 6px; overflow-x: auto; }
      .ffs-task-chip { border: 1px solid ${TOKENS.border}; background: ${TOKENS.layer2}; color: ${TOKENS.text};
        border-radius: 4px; padding: 1px 6px; font: inherit; font-size: 10px; cursor: pointer; white-space: nowrap; }
      .ffs-body { flex: 1; display: flex; min-height: 0; }
      .ffs-dock { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    `

    // ------------------------------------------------------------------ utils
    function clamp(value, lo, hi) { return Math.min(hi, Math.max(lo, value)) }
    /** A readable label for a translation key that has no dictionary entry. */
    function humanize(key) {
      const text = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
      return text.charAt(0).toUpperCase() + text.slice(1)
    }
    function toB64Bytes(base64) {
      const bin = atob(base64)
      const out = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
      return out
    }
    function decodeF32(base64) {
      const bytes = toB64Bytes(base64)
      return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
    }
    function decodeU32(base64) {
      const bytes = toB64Bytes(base64)
      return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
    }
    function decodeU8(base64) {
      return toB64Bytes(base64)
    }
    function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)) }
    function collectTabs(node, out = []) {
      if (!node) return out
      if (node.type === 'group') out.push(...(node.tabs || []))
      else for (const child of node.children || []) collectTabs(child, out)
      return out
    }
    function findGroup(node, id) {
      if (!node) return null
      if (node.type === 'group') return node.id === id ? node : null
      for (const child of node.children || []) {
        const hit = findGroup(child, id)
        if (hit) return hit
      }
      return null
    }
    function findGroupOf(node, tab, out = []) {
      if (!node) return out
      if (node.type === 'group') { if ((node.tabs || []).includes(tab)) out.push(node); return out }
      for (const child of node.children || []) findGroupOf(child, tab, out)
      return out
    }
    function removeTab(node, tab) {
      if (!node) return
      if (node.type === 'group') { node.tabs = (node.tabs || []).filter(t => t !== tab); return }
      for (const child of node.children || []) removeTab(child, tab)
    }
    function addTab(node, groupId, tab, index) {
      const group = findGroup(node, groupId)
      if (!group) return
      group.tabs = group.tabs || []
      if (group.tabs.includes(tab)) return
      if (typeof index === 'number') group.tabs.splice(index, 0, tab)
      else group.tabs.push(tab)
      group.active = tab
    }
    function viewKind(vp) { return vp ? vp.kind : 'image' }
    function planeLabel(plane) { return plane ? plane[0].toUpperCase() + plane.slice(1) : '' }
    // FFS viewport ids (V1, V2, …) are command/script identity, not labels:
    // "V1" reads as the primary visual cortex, so the UI says "Viewer 1".
    const VIEW_NOUNS = { V: 'Viewer', S: 'Surface', G: 'Graph', C: 'Carpet', M: 'Matrix', K: 'Clusters', T: 'Trace', P: 'Profiles', D: 'Depth', E: 'Chedi' }
    function viewerLabel(id) {
      const match = /^([A-Z])(\d+)$/.exec(String(id || ''))
      if (!match) return String(id || 'View')
      return `${VIEW_NOUNS[match[1]] || match[1]} ${match[2]}`
    }
    function viewTitle(vp) {
      if (!vp) return 'View'
      if (vp.kind === 'image') return `${viewerLabel(vp.id)} · ${planeLabel(vp.plane)}`
      if (vp.kind === 'graph') return `${viewerLabel(vp.id)} · time series`
      if (vp.kind === 'surface') return `${viewerLabel(vp.id)} · ${vp.shape}`
      return `${viewerLabel(vp.id)}`
    }
    function groupNode(id, tabs, size = 1) {
      return { type: 'group', id, tabs, active: tabs[0], size }
    }
    function splitNode(id, direction, children) {
      return children.length === 1
        ? children[0]
        : { type: 'split', id, direction, children }
    }
    /** Layout presets: the panel is often narrow, and MRI panes are square-ish, so
     *  the default is a 2×2 grid rather than one tall column. */
    function layoutPreset(kind, viewports) {
      const ids = viewports.map(vp => vp.id)
      const images = viewports.filter(vp => vp.kind === 'image').map(vp => vp.id)
      const surfaces = viewports.filter(vp => vp.kind === 'surface').map(vp => vp.id)
      const graphs = viewports.filter(vp => vp.kind === 'graph').map(vp => vp.id)
      const others = viewports.filter(vp => !['image', 'surface', 'graph'].includes(vp.kind)).map(vp => vp.id)
      if (!ids.length) return { version: 1, open: true, maximized: null, docks: null }
      const imageGroups = images.map(id => groupNode(`g-${id}`, [id], 1))
      const restTabs = [...surfaces, ...graphs, ...others]
      const restGroups = []
      if (surfaces.length) restGroups.push(groupNode('g-surface', surfaces, 1))
      if (graphs.length) restGroups.push(groupNode('g-graph', graphs, 1))
      if (others.length) restGroups.push(groupNode('g-other', others, 1))
      let docks
      if (kind === 'columns') {
        const children = [...imageGroups]
        if (restGroups.length) children.push(splitNode('s-rest', 'column', restGroups))
        docks = splitNode('s-root', 'row', children)
      } else if (kind === 'tabs') {
        const children = []
        if (images.length) children.push(groupNode('g-slices', images, 1.35))
        if (restTabs.length) children.push(groupNode('g-rest', restTabs, 1))
        docks = splitNode('s-root', 'column', children)
      } else {
        // 2×2 grid: the three orthogonal slices and one group for the rest.
        const cells = [...imageGroups]
        if (restTabs.length) cells.push(groupNode('g-rest', restTabs, 1))
        if (cells.length === 1) {
          docks = cells[0]
        } else if (cells.length === 2) {
          docks = splitNode('s-root', 'column', cells)
        } else {
          const rows = []
          for (let index = 0; index < cells.length; index += 2) {
            rows.push(splitNode(`s-row-${index}`, 'row', cells.slice(index, index + 2)))
          }
          docks = splitNode('s-root', 'column', rows)
        }
      }
      return { version: 1, open: true, maximized: null, docks }
    }
    function defaultLayout(viewports) {
      return layoutPreset('grid', viewports)
    }
    function visibleGroups(layout) {
      const groups = collectGroups(layout && layout.docks)
      return groups.filter(group => (group.tabs || []).length > 0)
    }
    function tileRects(count) {
      if (count <= 0) return []
      const cols = Math.ceil(Math.sqrt(count))
      const rows = Math.ceil(count / cols)
      const cellW = 1 / cols
      const cellH = 1 / rows
      const gap = 0.006
      const out = []
      for (let index = 0; index < count; index += 1) {
        out.push({
          x: (index % cols) * cellW + gap,
          y: Math.floor(index / cols) * cellH + gap,
          w: cellW - gap * 2,
          h: cellH - gap * 2,
        })
      }
      return out
    }
    function normalizeWindows(layout) {
      const groups = visibleGroups(layout)
      const current = layout.windows && typeof layout.windows === 'object' ? { ...layout.windows } : {}
      const defaults = tileRects(groups.length)
      groups.forEach((group, index) => {
        const rect = current[group.id]
        if (!rect || typeof rect !== 'object') {
          current[group.id] = {
            ...defaults[index],
            z: index + 1,
            minimized: false,
            maximized: false,
            rect: null,
          }
        } else {
          const clamp01 = value => Math.min(1, Math.max(0, Number(value) || 0))
          current[group.id] = {
            x: clamp01(rect.x), y: clamp01(rect.y),
            w: Math.min(1, Math.max(0.12, Number(rect.w) || defaults[index].w)),
            h: Math.min(1, Math.max(0.12, Number(rect.h) || defaults[index].h)),
            z: Number(rect.z) || index + 1,
            minimized: Boolean(rect.minimized),
            maximized: Boolean(rect.maximized),
            rect: rect.rect && typeof rect.rect === 'object' ? rect.rect : null,
          }
        }
      })
      const ids = new Set(groups.map(group => group.id))
      for (const key of Object.keys(current)) if (!ids.has(key)) delete current[key]
      layout.mode = 'floating'
      layout.windows = current
      return layout
    }
    function appendGroupNode(node, group) {
      if (!node) return group
      if (node.type === 'split') return { ...node, children: [...node.children, group] }
      return { type: 'split', id: 's-root', direction: 'column', children: [node, group] }
    }
    function removeGroupNode(node, groupId) {
      if (!node) return null
      if (node.type === 'group') return node.id === groupId ? null : node
      const children = (node.children || []).map(child => removeGroupNode(child, groupId)).filter(Boolean)
      if (!children.length) return null
      return { ...node, children }
    }

    function reconcileLayout(layout, viewports) {
      // Before a session is loaded there are no viewports; pruning tabs against
      // that empty set destroyed a saved layout. Leave it untouched until the
      // authoritative viewport list exists.
      if (!viewports.length) return layout && layout.docks ? clone(layout) : defaultLayout(viewports)
      const ids = viewports.map(vp => vp.id)
      let out = layout && layout.docks ? clone(layout) : defaultLayout(viewports)
      const known = new Set(ids)
      const present = new Set(collectTabs(out.docks))
      for (const tab of [...present]) {
        if (!known.has(tab)) { removeTab(out.docks, tab); present.delete(tab) }
      }
      for (const vp of viewports) {
        if (present.has(vp.id)) continue
        let target = collectGroups(out.docks).find(group => {
          const first = group.tabs && group.tabs[0]
          return first && viewports.find(v => v.id === first) && viewports.find(v => v.id === first).kind === vp.kind
        })
        if (!target && vp.kind !== 'image') {
          // A newly opened surface or graph gets its own window instead of
          // being buried as a tab in the first slice window.
          out.docks = appendGroupNode(out.docks, groupNode(`g-${vp.id}`, [vp.id]))
          present.add(vp.id)
          continue
        }
        if (!target) target = collectGroups(out.docks)[0]
        if (!target) {
          out = defaultLayout(viewports)
          break
        }
        addTab(out.docks, target.id, vp.id)
        present.add(vp.id)
      }
      for (const group of collectGroups(out.docks)) {
        group.tabs = (group.tabs || []).filter(tab => known.has(tab))
        if (!group.tabs.length) {
          const replacement = ids.find(id => !collectTabs(out.docks).includes(id))
          if (replacement) {
            const vp = viewports.find(v => v.id === replacement)
            if (vp) group.tabs.push(vp.id)
          }
        }
        if (!group.tabs.includes(group.active)) group.active = group.tabs[0]
      }
      out.maximized = out.maximized && known.has(out.maximized) ? out.maximized : null
      return normalizeWindows(out)
    }
    function collectGroups(node, out = []) {
      if (!node) return out
      if (node.type === 'group') { out.push(node); return out }
      for (const child of node.children || []) collectGroups(child, out)
      return out
    }
    function nextViewId(kind, viewports) {
      const prefix = VIEW_KIND_PREFIX[kind] || 'V'
      const used = new Set(viewports.map(vp => vp.id))
      let n = 1
      while (used.has(`${prefix}${n}`)) n += 1
      return `${prefix}${n}`
    }
    function fmt(value, digits = 1) {
      return Number.isFinite(value) ? value.toFixed(digits) : '--'
    }
    function fmtMm(mm) { return mm ? mm.map(v => fmt(v, 1)).join(', ') : '--' }
    function middleTruncate(text, limit = 38) {
      const value = String(text || '')
      if (value.length <= limit) return value
      const head = Math.ceil((limit - 1) * 0.58)
      const tail = Math.max(4, limit - 1 - head)
      return `${value.slice(0, head)}…${value.slice(-tail)}`
    }
    /** What a pane really draws: a data change must invalidate it even when the
     *  revision does not move (preview layers, device loads, direct state loads). */
    function layerSignature(layers) {
      return (layers || []).map(layer => [
        layer.key, layer.visible ? 1 : 0, layer.opacity,
        layer.colormap, layer.colormapReversed ? 1 : 0,
        layer.rangeLo, layer.rangeHi, layer.rangeMirror ? 1 : 0, layer.rangeFixed ? 1 : 0,
        layer.threshold, layer.thresholdIndex, layer.thresholdFollow, layer.thresholdP,
        layer.alphaMode, layer.boxed ? 1 : 0, layer.edges ? 1 : 0, layer.signMode,
        layer.nPanes, layer.volumeIndex, layer.nVolumes, layer.resample,
        layer.roi, layer.integerLabels, layer.colour,
      ].join(':')).join('|')
    }

    // ------------------------------------------------------------------ bridge
    function useBridge(ctx, workspaceOpen) {
      const [snapshot, setSnapshot] = useState(null)
      const openRef = useRef(false)
      openRef.current = Boolean(workspaceOpen)
      const [error, setError] = useState(null)
      const [connection, setConnection] = useState(null)
      const lastShow = useRef(0)
      const inflight = useRef(false)
      const snapshotRef = useRef(null)

      const publish = useCallback((next) => {
        if (!next || !Array.isArray(next.viewports)) return
        const current = snapshotRef.current
        // A poll that started before a command must never overwrite the newer
        // state the command response already delivered.
        if (current && typeof next.rev === 'number' && typeof current.rev === 'number' && next.rev < current.rev) return
        // The poll is a heartbeat: without this guard every 350 ms produced a
        // brand-new snapshot object and re-rendered every pane for nothing.
        if (current && next.rev === current.rev
          && next.showSeq === current.showSeq && next.notice === current.notice
          && JSON.stringify(next.workspace || null) === JSON.stringify(current.workspace || null)) return
        snapshotRef.current = next
        setSnapshot(next)
      }, [])

      const call = useCallback(async (endpoint, payload = {}) => {
        const conn = ctx.get('connection')
        if (!conn || !conn.rpc) throw new Error('Harness connection is not ready yet')
        const controller = new AbortController()
        const long = ['render', 'surface', 'surface_pick', 'series', 'save', 'restore', 'open'].includes(endpoint)
        const timer = setTimeout(() => controller.abort(), long ? 60000 : 20000)
        try {
          const result = await conn.rpc.call(BRIDGE, endpoint, payload, controller.signal)
          if (!result || result.ok !== true) {
            const err = new Error(result?.error?.message || `${endpoint} failed`)
            err.code = result?.error?.code
            throw err
          }
          return result.value
        } finally {
          clearTimeout(timer)
        }
      }, [ctx])

      const refresh = useCallback(async () => {
        if (inflight.current) return null
        inflight.current = true
        try {
          const conn = ctx.get('connection')
          if (!conn || !conn.rpc) { setConnection(false); return null }
          setConnection(true)
          const state = await call('state')
          publish(state)
          setError(null)
          return state
        } catch (err) {
          setError(err)
          return null
        } finally {
          inflight.current = false
        }
      }, [call, ctx, publish])

      useEffect(() => {
        let stop = false
        let timer = null
        const tick = async () => {
          if (stop) return
          await refresh()
          // Read the live flag: this closure used to capture the first snapshot
          // and therefore always polled at the slow rate.
          timer = setTimeout(tick, openRef.current ? 350 : 1100)
        }
        tick()
        return () => { stop = true; if (timer) clearTimeout(timer) }
      }, [refresh])

      const onShow = useCallback((seq) => {
        if (seq && seq !== lastShow.current) {
          lastShow.current = seq
          return true
        }
        return false
      }, [])

      const applyState = publish

      return { snapshot, error, connection, refresh, call, onShow, applyState }
    }

    // ------------------------------------------------------------------ layout persistence
    function useLayout(snapshot, call) {
      const [layout, setLayoutState] = useState(null)
      const localEditAt = useRef(0)
      const pendingSave = useRef(null)
      const layoutRef = useRef(null)
      const migrating = useRef(false)
      const lastRemote = useRef('')

      useEffect(() => { layoutRef.current = layout }, [layout])

      const loaded = Boolean(snapshot && (snapshot.grid || (snapshot.viewports && snapshot.viewports.length)))
      const loadedRef = useRef(false)
      loadedRef.current = loaded

      useEffect(() => {
        if (!snapshot || !snapshot.viewports) return
        if (!layout) {
          if (!loaded) {
            if (snapshot.workspace && snapshot.workspace.docks) setLayoutState(clone(snapshot.workspace))
            return
          }
          const base = snapshot.workspace && snapshot.workspace.docks
            ? snapshot.workspace
            : defaultLayout(snapshot.viewports)
          setLayoutState(reconcileLayout(base, snapshot.viewports))
          return
        }
        if (!loaded) return
        const remote = snapshot.workspace
        const remoteJson = remote ? JSON.stringify(remote) : ''
        const localJson = JSON.stringify(layout)
        if (remoteJson && remoteJson !== localJson && Date.now() - localEditAt.current > 900
          && lastRemote.current !== remoteJson) {
          lastRemote.current = remoteJson
          const adopted = reconcileLayout(remote, snapshot.viewports)
          setLayoutState(adopted)
          // Migrate an older dock-only layout to the floating schema once, so the
          // next poll sees the same shape it just adopted.
          if ((!remote.mode || !remote.windows) && !migrating.current) {
            migrating.current = true
            call('workspace', { layout: adopted }).catch(() => {}).finally(() => { migrating.current = false })
          }
          return
        }
        const reconciled = reconcileLayout(layout, snapshot.viewports)
        if (JSON.stringify(reconciled) !== localJson) setLayoutState(reconciled)
      }, [snapshot, layout])

      const commit = useCallback((next) => {
        const normalized = normalizeWindows(clone(next))
        localEditAt.current = Date.now()
        layoutRef.current = normalized
        setLayoutState(normalized)
        if (pendingSave.current) clearTimeout(pendingSave.current)
        pendingSave.current = setTimeout(() => {
          const value = layoutRef.current
          // A layout edited before the session loads is local only; saving it
          // would overwrite the saved tabs with an empty tree.
          if (value && loadedRef.current) call('workspace', { layout: value }).catch(() => {})
        }, 450)
      }, [call])

      return [layout, commit]
    }

    // ------------------------------------------------------------------ workspace
    function FfsIcon({ size = 16, className }) {
      return h('svg', {
        viewBox: '0 0 36 36', width: size, height: size, className, 'aria-hidden': true,
        style: { display: 'block', flex: '0 0 auto' },
      },
        h('path', {
          d: 'M18 5.8c-5.3 0-9.2 3.4-9.2 8.4 0 5.2 4 9.8 9.2 11.4 5.2-1.6 9.2-6.2 9.2-11.4 0-5-3.9-8.4-9.2-8.4Z',
          fill: 'none', stroke: 'currentColor', strokeWidth: 2.1, strokeLinejoin: 'round',
        }),
        h('path', { d: 'M18 8.6v15.9', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, opacity: 0.55 }),
        h('path', {
          d: 'M13.2 12.1c1.9 1 2.9 2.5 2.9 4.6 0 2.1-1 3.6-2.9 4.6M22.8 12.1c-1.9 1-2.9 2.5-2.9 4.6 0 2.1 1 3.6 2.9 4.6',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, opacity: 0.7, strokeLinecap: 'round',
        }),
        h('path', { d: 'M11.5 16.1h13M17.1 10.2v11.8', fill: 'none', stroke: '#e55934', strokeWidth: 1.1 }),
      )
    }

    // ------------------------------------------------------------------ data picker
    const PICKER_FILE = /\.(nii(\.gz|\.zst)?|mgz|mgh|HEAD|BRIK(\.gz)?|gii)$/i

    function humanSize(bytes) {
      if (!Number.isFinite(bytes)) return ''
      if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
      if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
      return `${Math.max(1, Math.round(bytes / 1024))} KB`
    }

    function DataPicker({ ctx, call, run, t, snapshot, onClose }) {
      const [sources, setSources] = useState(null)
      const [kindFilter, setKindFilter] = useState('all')
      const [pathTip, setPathTip] = useState(null)
      const [active, setActive] = useState(null)
      const [recursive, setRecursive] = useState(false)
      const [selected, setSelected] = useState(null)
      const [manual, setManual] = useState('')
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)

      const readFolder = useCallback(async (path, rec = false) => {
        setBusy(true)
        setError(null)
        try {
          const result = await call('read_folder', { path, recursive: rec })
          setSources(result.sources)
          setActive(path)
          setRecursive(Boolean(rec))
          setKindFilter('all')
          setPathTip(null)
          setSelected(null)
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }, [call])

      useEffect(() => {
        let cancelled = false
        ;(async () => {
          try {
            const result = await call('sources')
            if (cancelled) return
            setSources(result)
            const first = result.folders[0]
            if (first) {
              const read = await call('read_folder', { path: first.path, recursive: first.recursive })
              if (cancelled) return
              setSources(read.sources)
              setActive(first.path)
              setRecursive(Boolean(first.recursive))
            }
          } catch (err) {
            if (!cancelled) setError(err.message)
          }
        })()
        return () => { cancelled = true }
      }, [call])

      const close = useCallback(async () => {
        try { await run('clear_preview', {}, null, { quiet: true }) } catch (err) { /* no preview */ }
        onClose()
      }, [onClose, run])

      useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') close() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [close])

      const pickDirectory = async () => {
        const workspace = ctx.get('uiWorkspace')
        if (!workspace || !workspace.pickDirectory) throw new Error('This Harness build has no directory picker')
        return workspace.pickDirectory()
      }
      const addFolder = async (path) => {
        if (!path) return
        setBusy(true)
        setError(null)
        try {
          const result = await call('add_folder', { path, recursive })
          setSources(result.sources)
          setActive(path)
          setKindFilter('all')
          setPathTip(null)
          setSelected(null)
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }
      const chooseFolder = async () => {
        try { const path = await pickDirectory(); if (path) await addFolder(path) } catch (err) { setError(err.message) }
      }
      const addSubject = async (path) => {
        if (!path) return
        setBusy(true)
        setError(null)
        try {
          const result = await run('add_subject', { path }, `subject ${path}`)
          if (result && result.sources) setSources(result.sources)
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }
      const chooseSubject = async () => {
        try { const path = await pickDirectory(); if (path) await addSubject(path) } catch (err) { setError(err.message) }
      }
      const removeFolder = async (path) => {
        setBusy(true)
        try {
          const result = await call('remove_folder', { path })
          setSources(result.sources)
          if (active === path) { setActive(null); setSelected(null) }
        } catch (err) { setError(err.message) } finally { setBusy(false) }
      }
      const removeSubject = async (path) => {
        setBusy(true)
        try {
          const result = await call('remove_subject', { path })
          setSources(result.sources)
        } catch (err) { setError(err.message) } finally { setBusy(false) }
      }
      const addManual = async () => {
        const value = manual.trim()
        if (!value) return
        if (PICKER_FILE.test(value)) {
          setBusy(true)
          setError(null)
          try {
            const result = await call('add_files', { paths: [value] })
            setSources(result.sources)
            setKindFilter('all')
            setManual('')
          } catch (err) { setError(err.message) } finally { setBusy(false) }
        } else {
          await addFolder(value)
          setManual('')
        }
      }
      const preview = async (entry) => {
        setSelected(entry.path)
        try { await run('preview', { path: entry.path }, null, { quiet: true }) } catch (err) { setError(err.message) }
      }
      const loadEntry = async (entry, closeAfter = false) => {
        if (!entry) return
        setBusy(true)
        setError(null)
        try {
          await run('load_entry', { path: entry.path }, `loaded ${entry.name}`)
          if (closeAfter) await close()
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }
      const catalog = sources ? sources.catalog : { entries: [], path: null }
      const allEntries = catalog.entries || []
      const kindCounts = {}
      for (const item of allEntries) kindCounts[item.kind] = (kindCounts[item.kind] || 0) + 1
      const kindOrder = ['anat', 'func', 'stats', 'mask', 'other']
      const presentKinds = kindOrder.filter(kind => kindCounts[kind])
      const entries = kindFilter === 'all' ? allEntries : allEntries.filter(item => item.kind === kindFilter)
      const entry = entries.find(item => item.path === selected) || null
      const kindLabel = kind => kind.charAt(0).toUpperCase() + kind.slice(1)
      return h('div', {
        className: 'ffs-picker-backdrop', role: 'presentation',
        onMouseDown: event => { if (event.target === event.currentTarget) close() },
      },
        h('div', { className: 'ffs-picker', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('sources') },
          h('div', { className: 'ffs-picker-head' },
            h(FfsIcon, { size: 15 }),
            h('span', null, t('sources')),
            h('span', { style: { flex: 1 } }),
            h('button', { className: 'ffs-btn icon', onClick: close, title: t('cancel') }, '✕'),
          ),
          h('div', { className: 'ffs-sources-body' },
            h('div', { className: 'ffs-sources-side' },
              h('div', { className: 'ffs-source-head' },
                h('span', null, t('folders')),
                h('span', { style: { flex: 1 } }),
                h('button', { className: 'ffs-btn icon', title: t('addFolder'), disabled: busy, onClick: chooseFolder }, '＋'),
              ),
              h('div', { className: 'ffs-row', style: { padding: '4px 8px' } },
                h('input', {
                  type: 'text', value: manual, spellCheck: false, placeholder: t('folderPath'),
                  style: { flex: 1, minWidth: 0, background: TOKENS.layer2, color: TOKENS.text, border: `1px solid ${TOKENS.border}`, borderRadius: 5, padding: '3px 5px', font: '11px ui-monospace, monospace' },
                  onChange: event => setManual(event.target.value),
                  onKeyDown: event => { if (event.key === 'Enter') addManual() },
                }),
                h('button', { className: 'ffs-btn', disabled: busy, onClick: addManual }, t('add')),
              ),
              (sources ? sources.folders : []).length
                ? (sources ? sources.folders : []).map(folder => h('div', {
                  key: folder.path,
                  className: `ffs-source-row${active === folder.path ? ' active' : ''}`,
                  title: folder.path,
                  onClick: () => readFolder(folder.path, folder.recursive),
                },
                  h('span', { className: 'name' }, folder.name),
                  h('span', { className: 'meta' }, folder.recursive ? 'rec' : ''),
                  h('button', {
                    className: 'mini', title: t('remove'), disabled: busy,
                    onClick: event => { event.stopPropagation(); removeFolder(folder.path) },
                  }, '✕'),
                ))
                : h('div', { className: 'ffs-hint', style: { padding: '6px 9px' } }, t('noFolders')),
              h('div', { className: 'ffs-source-head', style: { borderTop: `1px solid ${TOKENS.border}` } },
                h('span', null, t('subjects')),
                h('span', { style: { flex: 1 } }),
                h('button', { className: 'ffs-btn icon', title: t('addSubject'), disabled: busy, onClick: chooseSubject }, '＋'),
              ),
              (sources ? sources.subjects : []).length
                ? (sources ? sources.subjects : []).map(subject => h('div', {
                  key: subject.path,
                  className: 'ffs-source-row',
                  title: subject.path,
                  onClick: () => addSubject(subject.path),
                },
                  h('span', { className: 'name' }, subject.name),
                  h('span', { className: 'meta' }, subject.valid ? 'surf' : 'missing'),
                  h('button', {
                    className: 'mini', title: t('remove'), disabled: busy,
                    onClick: event => { event.stopPropagation(); removeSubject(subject.path) },
                  }, '✕'),
                ))
                : h('div', { className: 'ffs-hint', style: { padding: '6px 9px' } }, t('noSubjects')),
            ),
            h('div', { className: 'ffs-sources-main' },
              h('div', { className: 'ffs-picker-path' },
                h('span', { className: 'ffs-hint', title: catalog.path || '', style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  catalog.files ? t('selectedFiles') : (catalog.path || t('noFolderSelected'))),
                h('label', { className: 'ffs-hint', style: { display: 'flex', alignItems: 'center', gap: 3 } },
                  h('input', {
                    type: 'checkbox', checked: recursive, disabled: busy || !active,
                    onChange: event => { setRecursive(event.target.checked); if (active) readFolder(active, event.target.checked) },
                  }),
                  t('recursive')),
                h('button', {
                  className: 'ffs-btn', disabled: busy || !active,
                  onClick: () => active && readFolder(active, recursive),
                }, t('rescan')),
              ),
              h('div', { className: 'ffs-filter-row' },
                h('button', {
                  type: 'button',
                  className: `ffs-filter-chip${kindFilter === 'all' ? ' active' : ''}`,
                  onClick: () => setKindFilter('all'),
                }, 'All', h('span', { className: 'ffs-filter-count' }, allEntries.length)),
                presentKinds.map(kind => h('button', {
                  key: kind, type: 'button',
                  className: `ffs-filter-chip${kindFilter === kind ? ' active' : ''}`,
                  onClick: () => setKindFilter(kind),
                }, kindLabel(kind), h('span', { className: 'ffs-filter-count' }, kindCounts[kind]))),
              ),
              error ? h('div', { className: 'ffs-picker-error' }, error) : null,
              h('div', { className: 'ffs-picker-list' },
                entries.length === 0
                  ? h('div', { className: 'ffs-hint', style: { padding: 14 } }, busy ? 'Reading folder…' : (allEntries.length ? t('noMatchingDatasets') : t('noDatasets')))
                  : entries.map(item => h('div', {
                    key: item.path,
                    className: `ffs-catalog-row${selected === item.path ? ' selected' : ''}`,
                    title: 'Hover for the full path; double-click to load',
                    onMouseEnter: () => setPathTip(item.path),
                    onMouseLeave: () => setPathTip(null),
                    onClick: () => preview(item),
                    onDoubleClick: () => loadEntry(item, true),
                  },
                    h('span', { className: 'ffs-kind' }, item.kind),
                    h('span', { className: 'ffs-catalog-main' },
                      h('span', { className: 'ffs-catalog-name' }, middleTruncate(item.name, 58)),
                      h('span', { className: 'ffs-catalog-meta' },
                        [
                          item.summary,
                          item.tr ? `TR ${item.tr.toFixed(2)}s` : '',
                          item.labels && item.labels.length ? item.labels.join('/') : '',
                        ].filter(Boolean).join(' · ')),
                    ),
                  )),
              ),
            ),
          ),
          h('div', { className: 'ffs-picker-foot' },
            h('span', {
              className: 'ffs-picker-detail',
              title: pathTip || (entry ? entry.path : ''),
            }, busy ? 'working…' : (pathTip || (entry ? `${entry.kind} · ${entry.name}` : `${entries.length} of ${allEntries.length} datasets`))),
            h('button', { className: 'ffs-btn', disabled: busy || !entry, onClick: () => loadEntry(entry, false) }, t('load')),
            h('button', { className: 'ffs-btn', disabled: busy || !entry, onClick: () => loadEntry(entry, true) }, t('loadClose')),
            h('button', { className: 'ffs-btn', disabled: busy, onClick: close }, t('cancel')),
          ),
        ),
      )
    }

    // ------------------------------------------------------------------ docked viewer body
    function ViewerBody({ ctx, t: injectedT }) {
      const t = (key, options) => {
        let value
        if (injectedT) {
          try { value = injectedT(key, options) } catch (error) { value = undefined }
        }
        if (typeof value === 'string' && value && value !== key) return value
        return messages[key] || humanize(key)
      }
      const { snapshot, error, connection, refresh, call, onShow, applyState } = useBridge(ctx, true)
      const [layout, setLayout] = useLayout(snapshot, call)
      const [log, setLog] = useState([])
      const [busy, setBusy] = useState(false)
      const [showLog, setShowLog] = useState(false)
      const [railPref, setRailPref] = useState(null)
      const [pickerOpen, setPickerOpen] = useState(false)
      const [addMenu, setAddMenu] = useState(false)
      const [newViewLayer, setNewViewLayer] = useState('all')
      const [width, setWidth] = useState(0)
      const [height, setHeight] = useState(0)
      const rootRef = useRef(null)
      const showTarget = useRef(null)
      const openingRef = useRef(false)
      const lastOpenAttempt = useRef(0)

      useEffect(() => {
        if (!rootRef.current) return undefined
        const observer = new ResizeObserver(entries => {
          setWidth(entries[0].contentRect.width)
          setHeight(entries[0].contentRect.height)
        })
        observer.observe(rootRef.current)
        return () => observer.disconnect()
      }, [])

      const run = useCallback(async (endpoint, payload, note, options = {}) => {
        const quiet = options.quiet === true
        if (!quiet) setBusy(true)
        try {
          const result = await call(endpoint, payload)
          if (result && result.state) applyState(result.state)
          if (note) setLog(lines => [note, ...lines].slice(0, 40))
          if (!quiet && result && result.state) {
            setLog(lines => [`rev ${result.state.rev} · ${result.state.origin}/${result.state.category}`, ...lines].slice(0, 40))
          }
          return result
        } catch (err) {
          if (err.code !== 'pick-miss') setLog(lines => [`[error] ${err.message}`, ...lines].slice(0, 40))
          throw err
        } finally {
          if (!quiet) setBusy(false)
        }
      }, [applyState, call])
      const dispatch = useCallback((line) => run('execute', { line }, line).catch(() => {}), [run])

      // Dataset recovery: load on first mount and again if a Host/sidecar restart
      // leaves the authoritative state empty.
      useEffect(() => {
        if (snapshot && snapshot.grid) return
        if (openingRef.current) return
        if (Date.now() - lastOpenAttempt.current < 2000) return
        lastOpenAttempt.current = Date.now()
        openingRef.current = true
        call('open', { preset: 'auto' })
          .then(result => { if (result && result.state) applyState(result.state) })
          .catch(() => {})
          .finally(() => { openingRef.current = false })
      }, [snapshot, call, applyState])

      useEffect(() => {
        if (!snapshot || !onShow(snapshot.showSeq)) return
        showTarget.current = snapshot.showTarget || null
        // If the viewer tab is closed the always-mounted show bridge opens it;
        // once open, this body receives the same showSeq and focuses the target.
        if (!layout || !showTarget.current) return
        const next = clone(layout)
        const group = collectGroups(next.docks).find(item => (item.tabs || []).includes(showTarget.current))
        if (group) {
          group.active = showTarget.current
          setLayout(next)
        }
        showTarget.current = null
      }, [snapshot, layout, onShow, setLayout])

      useEffect(() => {
        if (error) setLog(lines => [`[error] ${error.message}`, ...lines].slice(0, 40))
      }, [error])

      const viewports = snapshot ? snapshot.viewports : []
      const currentLayout = layout
      const addView = (kind, plane = 'axial') => {
        if (kind === 'surface' && !(snapshot.surfaces.loaded || []).length) return
        const id = nextViewId(kind, viewports)
        const line = kind === 'image'
          ? `OPEN_VIEW ${id} image ${plane}`
          : `OPEN_VIEW ${id} ${kind}`
        const lines = [line]
        if (newViewLayer !== 'all') {
          lines.push(`SELECT_LAYER ${newViewLayer}`, `SET_VIEW_SOLO ${id} 1`)
        }
        run('execute_batch', { lines }, `open ${id}`).then(result => {
          if (!result || !result.state) return
          const next = clone(currentLayout)
          next.docks = appendGroupNode(next.docks, groupNode(`g-${id}`, [id]))
          next.mode = 'floating'
          setLayout(normalizeWindows(next))
          setAddMenu(false)
          setNewViewLayer('all')
        }).catch(() => {})
      }

      if (!connection) {
        return h('div', { className: 'ffs-root', ref: rootRef },
          h('div', { className: 'ffs-center' }, t('waiting')))
      }
      if (!currentLayout) {
        return h('div', { className: 'ffs-root', ref: rootRef },
          h('div', { className: 'ffs-center' },
            error
              ? h('div', null,
                h('div', { style: { color: TOKENS.error, marginBottom: 8 } }, error.message),
                h('button', { className: 'ffs-btn', onClick: () => refresh() }, 'Retry'))
              : t('loading')))
      }
      const compact = width > 0 && width < 640
      const railVisible = railPref === null ? !compact : railPref
      const showRail = railVisible && !compact
      const surfacesLoaded = (snapshot.surfaces?.loaded || []).length > 0
      const surfaceSubjectName = snapshot.surfaces?.subject ? snapshot.surfaces.subject.split('/').pop() : null
      return h('div', { className: 'ffs-root', ref: rootRef },
        h('div', { className: 'ffs-header' },
          h('span', { className: 'ffs-brand', title: t('title') }, h(FfsIcon, { size: 15 }), 'FFS'),
          h('button', {
            type: 'button', className: 'ffs-btn icon', title: 'Add viewer',
            onClick: () => setAddMenu(value => !value),
          }, '＋'),
          h('span', { className: 'ffs-sub' },
            snapshot?.grid ? `${snapshot.grid.shape.join('×')} · ${snapshot.grid.voxelMm.toFixed(2)} mm · rev ${snapshot.rev}` : 'no dataset'),
          h('span', { style: { flex: 1 } }),
          h(CategoryChips, { snapshot }),
          h('button', {
            className: 'ffs-btn icon', title: t('openData'),
            onClick: () => setPickerOpen(true),
          }, '📂'),
          h('button', {
            className: `ffs-btn icon${railVisible ? ' active' : ''}`, title: 'Toggle controls',
            onClick: () => setRailPref(v => !(v === null ? !compact : v)),
          }, '☰'),
          h('button', {
            className: 'ffs-btn icon', title: t('save'),
            onClick: () => run('save', { note: 'user save' }, 'saved state + workspace').catch(() => {}),
          }, '💾'),
          h('button', {
            className: 'ffs-btn icon', title: t('restore'),
            onClick: () => { run('restore', {}, 'restored saved state').then(() => refresh()).catch(() => {}) },
          }, '⟲'),
          h('button', {
            className: 'ffs-btn icon', title: 'Toggle message log',
            onClick: () => setShowLog(v => !v),
          }, '▤'),
        ),
        addMenu
          ? h('div', { className: 'ffs-layout-menu ffs-add-menu' },
            h('div', { className: 'ffs-source-head' }, 'Add viewer'),
            h('div', { className: 'ffs-control', style: { padding: '4px 8px' } },
              h('span', { className: 'ffs-control-head' }, h('span', null, 'Data')),
              h('select', {
                className: 'ffs-select', value: newViewLayer,
                onChange: event => setNewViewLayer(event.target.value),
              },
                h('option', { value: 'all' }, 'All visible layers'),
                (snapshot.layers || []).map(layer => h('option', {
                  key: layer.key, value: layer.key,
                }, `${layer.key} · ${layer.name}`)),
              ),
            ),
            ...[['image', 'axial', 'Image · axial'], ['image', 'sagittal', 'Image · sagittal'], ['image', 'coronal', 'Image · coronal']].map(([kind, plane, label]) => h('button', {
              key: `${kind}-${plane}`, className: 'ffs-btn', onClick: () => addView(kind, plane),
            }, label)),
            h('button', { className: 'ffs-btn', onClick: () => addView('graph') }, 'Graph'),
            h('button', {
              className: 'ffs-btn',
              disabled: !(snapshot.surfaces.loaded || []).length,
              onClick: () => addView('surface'),
            }, 'Surface'),
            h('div', { className: 'ffs-hint', style: { padding: '4px 8px 6px' } },
              'Views share the visible layer stack. Pick a specific layer here to create a solo view; all solo views follow the selected layer.'),
          )
          : null,
        h('div', { className: 'ffs-body', style: { position: 'relative' } },
          showRail ? h(ControlRail, { snapshot, dispatch, run, busy, t, onOpenPicker: () => setPickerOpen(true) }) : null,
          compact && railVisible ? h('div', { className: 'ffs-rail-overlay' },
            h(ControlRail, {
              snapshot, dispatch, run, busy, t,
              onOpenPicker: () => { setPickerOpen(true); setRailPref(false) },
              onClose: () => setRailPref(false),
            }),
          ) : null,
          snapshot.layers.length === 0
            ? h('div', { className: 'ffs-empty-start' },
              h(FfsIcon, { size: 28 }),
              h('h3', null, t('emptyTitle')),
              h('div', null, snapshot.notice || t('emptyBody')),
              h('button', { className: 'ffs-btn', style: { marginTop: 4 }, onClick: () => setPickerOpen(true) }, t('addData')),
            )
            : h('div', { className: 'ffs-floating-host' },
              h(FloatingWorkspace, {
                layout: currentLayout, setLayout, snapshot, dispatch, run, busy,
                width, height,
              })),
        ),
        h('div', { className: 'ffs-foot' },
          h(CommandBar, { dispatch, busy }),
          h('span', { className: 'ffs-sub' }, busy ? 'working…' : 'ready'),
        ),
        showLog && log.length
          ? h('div', { className: 'ffs-log' }, log.slice(0, 12).map((line, index) => h('div', { key: index }, line)))
          : null,
        pickerOpen
          ? h(DataPicker, {
            ctx, call, run, t, snapshot,
            onClose: () => setPickerOpen(false),
          })
          : null,
      )
    }

    function CategoryChips({ snapshot }) {
      if (!snapshot) return null
      const dirty = snapshot.dirty || {}
      return h('span', { className: 'ffs-row', style: { gap: 4 } },
        h('span', { className: `ffs-chip ${dirty.display ? 'warn' : 'ok'}`, title: 'Display changes are cosmetic and replayable over any analysis' }, `display${dirty.display ? ' •' : ''}`),
        h('span', { className: `ffs-chip ${dirty.analysis ? 'warn' : 'ok'}`, title: 'Analysis changes computed new data' }, `analysis${dirty.analysis ? ' •' : ''}`),
        h('span', { className: `ffs-chip ${dirty.source ? 'warn' : 'ok'}`, title: 'Source changes altered loaded data' }, `source${dirty.source ? ' •' : ''}`),
        h('span', { className: 'ffs-chip', title: 'Authoritative state revision' }, `rev ${snapshot.rev}`),
      )
    }

    // ------------------------------------------------------------------ dock tree
    function DockView({ node, layout, snapshot, dispatch, run, busy, setLayout }) {
      if (!node) return h('div', { className: 'ffs-empty' }, 'No views. Open one with the command bar: OPEN_VIEW V1 image axial')
      if (node.type === 'group') {
        return h(GroupPane, { node, layout, snapshot, dispatch, run, busy, setLayout })
      }
      const isRow = node.direction !== 'column'
      return h('div', { className: `ffs-split ${isRow ? 'row' : 'column'}`, style: { flex: 1 } },
        node.children.map((child, index) => h(React.Fragment, { key: child.id || index },
          index > 0 ? h(Divider, {
            isRow,
            sizes: node.children.map(c => c.size || 1),
            index: index - 1,
            onResize: (fraction, index2) => {
              const next = clone(layout)
              const split = findSplit(next.docks, node.id)
              if (!split) return
              const sizes = split.children.map(c => c.size || 1)
              const total = sizes.reduce((a, b) => a + b, 0)
              const before = sizes.slice(0, index2).reduce((a, b) => a + b, 0)
              const pair = sizes[index2] + sizes[index2 + 1]
              const first = clamp(fraction * total - before, 0.15, pair - 0.15)
              sizes[index2] = first
              sizes[index2 + 1] = pair - first
              split.children.forEach((c, i) => { c.size = sizes[i] })
              setLayout(next)
            },
          }) : null,
          h('div', {
            style: {
              display: 'flex', flexGrow: child.size || 1, flexBasis: 0,
              minWidth: 0, minHeight: 0, overflow: 'hidden',
            },
          }, h(DockView, { node: child, layout, snapshot, dispatch, run, busy, setLayout })),
        )),
      )
    }
    function findSplit(node, id) {
      if (!node) return null
      if (node.type === 'split' && node.id === id) return node
      for (const child of node.children || []) {
        const hit = findSplit(child, id)
        if (hit) return hit
      }
      return null
    }
    function Divider({ isRow, sizes, index, onResize }) {
      const ref = useRef(null)
      const [drag, setDrag] = useState(null)
      return h('div', {
        className: 'ffs-divider',
        style: isRow ? { cursor: 'col-resize' } : { cursor: 'row-resize' },
        onPointerDown: event => {
          event.currentTarget.setPointerCapture(event.pointerId)
          setDrag({ start: isRow ? event.clientX : event.clientY, parent: event.currentTarget.parentElement.getBoundingClientRect() })
        },
        onPointerMove: event => {
          if (!drag) return
          const rect = drag.parent
          const now = isRow ? event.clientX : event.clientY
          const length = isRow ? rect.width : rect.height
          const position = (now - (isRow ? rect.left : rect.top)) / Math.max(1, length)
          onResize(clamp(position, 0.05, 0.95), index)
        },
        onPointerUp: () => setDrag(null),
        onPointerCancel: () => setDrag(null),
      }, h('div', { style: { position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', opacity: .35, fontSize: 9 } }, isRow ? '⋮' : '⋯'))
    }

    function GroupPane({ node, layout, snapshot, dispatch, run, busy, setLayout }) {
      const active = (node.tabs || []).includes(node.active) ? node.active : node.tabs?.[0]
      const viewports = snapshot?.viewports || []
      const vp = viewports.find(v => v.id === active)
      const [menu, setMenu] = useState(null)
      const [settings, setSettings] = useState(false)
      const [dragOver, setDragOver] = useState(false)
      if (!active) {
        return h('div', { className: 'ffs-group' }, h('div', { className: 'ffs-empty' }, 'Empty group'))
      }
      const selectTab = (id) => {
        const next = clone(layout)
        const group = findGroup(next.docks, node.id)
        if (!group) return
        group.active = id
        setLayout(next)
      }
      const closeTab = (id) => {
        const next = clone(layout)
        removeTab(next.docks, id)
        const group = findGroup(next.docks, node.id)
        if (group && !group.tabs.length) {
          // Keep the group (a split can hold an empty group) but it renders an empty state.
          group.active = null
        }
        setLayout(next)
        run('execute', { line: `CLOSE_VIEW ${id}` }, `CLOSE_VIEW ${id}`).catch(() => {})
      }
      const moveTab = (tab, targetGroupId, index) => {
        const next = clone(layout)
        removeTab(next.docks, tab)
        addTab(next.docks, targetGroupId, tab, index)
        const group = findGroup(next.docks, node.id)
        if (group && !group.tabs.includes(group.active)) group.active = group.tabs[0]
        setLayout(next)
      }
      const duplicate = async (source) => {
        if (!source) return
        const newId = nextViewId(source.kind, viewports)
        const lines = [`OPEN_VIEW ${newId} ${source.kind} ${source.plane || 'axial'}`]
        lines.push(`SET_VIEW_LOCKED ${newId} ${source.locked ? 1 : 0}`)
        if (!source.locked && source.position != null) lines.push(`SET_VIEW_POSITION ${newId} ${source.position}`)
        lines.push(`SET_ZOOM ${newId} ${source.zoom}`)
        lines.push(`SET_PAN ${newId} ${source.pan[0]} ${source.pan[1]}`)
        if (source.solo) lines.push(`SET_VIEW_SOLO ${newId} 1`)
        if (source.tiles) lines.push(`SET_VIEW_TILES ${newId} 1`)
        if (source.kind === 'surface') {
          lines.push(`SET_SURFACE_SHAPE ${newId} ${source.shape}`)
          lines.push(`SET_SURFACE_DEPTH ${newId} ${source.depth[0]} ${source.depth[1]} ${source.samples}`)
          lines.push(`SET_SURFACE_DEPTH_STAT ${newId} ${source.depthStat}`)
          lines.push(`SET_SURFACE_FOLDING ${newId} ${source.folding}`)
          lines.push(`SET_SURFACE_HEMIS ${newId} ${source.hemis} ${source.split}`)
          lines.push(`SET_SURFACE_EQUIVOLUME ${newId} ${source.equivolume ? 1 : 0}`)
        }
        if (source.kind === 'graph') {
          lines.push(`SET_VIEW_GRID ${newId} ${source.gridN}`)
          if (source.traces && source.traces.length) lines.push(`SET_VIEW_TRACES ${newId} ${source.traces.join(',')}`)
          lines.push(`SET_VIEW_DETREND ${newId} ${source.detrend}`)
        }
        try {
          await run('execute_batch', { lines }, `duplicate ${source.id} → ${newId}`)
          const next = clone(layout)
          const group = findGroup(next.docks, node.id)
          if (group) {
            const at = group.tabs.indexOf(source.id)
            group.tabs.splice(at + 1, 0, newId)
            group.active = newId
            setLayout(next)
          }
        } catch (err) { /* logged by run */ }
      }
      const splitGroup = (source, direction) => {
        const newId = nextViewId(source.kind, viewports)
        const lines = [`OPEN_VIEW ${newId} ${source.kind} ${source.plane || 'axial'}`]
        run('execute_batch', { lines }, `split ${source.id} → ${newId}`).then(() => {
          const next = clone(layout)
          const group = findGroup(next.docks, node.id)
          if (!group) return
          const fresh = { type: 'group', id: `g-${newId}`, tabs: [newId], active: newId, size: 1 }
          const parent = findParentSplit(next.docks, node.id)
          if (parent) {
            parent.children.push(fresh)
          } else {
            next.docks = { type: 'split', id: 's-root', direction, children: [next.docks, fresh] }
          }
          setLayout(next)
        }).catch(() => {})
      }
      return h('div', {
        className: 'ffs-group',
        style: dragOver ? { borderColor: TOKENS.brand } : {},
        onDragOver: event => { if (event.dataTransfer.types.includes('text/ffs-tab')) { event.preventDefault(); setDragOver(true) } },
        onDragLeave: () => setDragOver(false),
        onDrop: event => {
          event.preventDefault()
          setDragOver(false)
          const tab = event.dataTransfer.getData('text/ffs-tab')
          if (tab) moveTab(tab, node.id)
        },
      },
        h('div', { className: 'ffs-tabs' },
          (node.tabs || []).map(id => h('button', {
            key: id,
            className: `ffs-tab${id === active ? ' active' : ''}`,
            title: `${viewerLabel(id)} (FFS id ${id})`,
            draggable: true,
            onDragStart: event => event.dataTransfer.setData('text/ffs-tab', id),
            onClick: () => selectTab(id),
          }, viewerLabel(id))),
          h('span', { style: { flex: 1 } }),
        ),
        h('div', { className: 'ffs-pane-head' },
          h('span', { className: 'ffs-pane-title' }, viewTitle(vp)),
          vp?.kind === 'surface'
            ? h('button', {
              className: 'ffs-btn',
              style: { padding: '0 5px', fontSize: 10 },
              disabled: !snapshot.surfaces.flatAvailable && vp.shape !== 'flat',
              title: !snapshot.surfaces.flatAvailable && vp.shape !== 'flat'
                ? 'No flat patch in this subject'
                : vp.shape === 'flat' ? 'Switch back to the inflated surface' : 'Flatten this surface',
              onClick: () => dispatch(`SET_SURFACE_SHAPE ${vp.id} ${vp.shape === 'flat' ? 'inflated' : 'flat'}`),
            }, vp.shape === 'flat' ? 'Inflated' : 'Flatten')
            : null,
          vp?.kind === 'image' ? h('span', { className: 'ffs-chip' }, vp.locked ? 'locked' : `parked ${vp.position ?? '--'}`) : null,
          vp?.kind === 'image' && vp.zoomLinked ? h('span', { className: 'ffs-chip' }, 'zoom-linked') : null,
          h('span', { style: { flex: 1 } }),
          h('button', { className: `ffs-btn icon${settings ? ' active' : ''}`, title: 'Per-view settings', onClick: () => setSettings(v => !v) }, '⚙'),
          h('button', { className: 'ffs-btn icon danger', title: 'Close tab', onClick: () => closeTab(active) }, '✕'),
        ),
        settings && vp ? h(SettingsPopover, { vp, snapshot, dispatch, onClose: () => setSettings(false) }) : null,
        h(PaneBody, { vp, snapshot, dispatch, call: null, run }),
      )
    }
    function findParentSplit(node, childGroupId) {
      if (!node || node.type !== 'split') return null
      for (const child of node.children || []) {
        if (child.id === childGroupId) return node
        const hit = findParentSplit(child, childGroupId)
        if (hit) return hit
      }
      return null
    }

    // ------------------------------------------------------------------ per-view settings
    // ------------------------------------------------------------------ floating windows
    function FloatingWorkspace({ layout, setLayout, snapshot, dispatch, run, busy, width, height }) {
      const groups = visibleGroups(layout)
      const windows = layout.windows || {}
      const hostRef = useRef(null)
      const [box, setBox] = useState({ w: 0, h: 0 })
      const [snapRect, setSnapRect] = useState(null)
      const snapRef = useRef(null)
      const zoneRef = useRef(null)

      useEffect(() => {
        if (!hostRef.current) return undefined
        const observer = new ResizeObserver(entries => {
          setBox({ w: entries[0].contentRect.width, h: entries[0].contentRect.height })
        })
        observer.observe(hostRef.current)
        return () => observer.disconnect()
      }, [])

      const containerW = box.w || width || 1
      const containerH = box.h || height || 1
      const mutate = (fn) => {
        const next = clone(layout)
        fn(next)
        setLayout(next)
      }
      const patchWindow = (id, patch) => mutate(next => {
        if (next.windows && next.windows[id]) next.windows[id] = { ...next.windows[id], ...patch }
      })
      // Free dragging is the default. Snapping is modifier-only: hold Shift while
      // the pointer is in the edge/corner band. Without Shift, releasing anywhere
      // keeps the free position, so an ordinary drag can never snap by accident.
      const SNAP_EDGE_PX = 16
      const SNAP_CORNER_PX = 22
      const zoneFor = (px, py, width, height, shiftKey, altKey) => {
        if (!shiftKey || altKey) return null
        const nearLeft = px <= SNAP_CORNER_PX
        const nearRight = px >= width - SNAP_CORNER_PX
        const nearTop = py <= SNAP_CORNER_PX
        const nearBottom = py >= height - SNAP_CORNER_PX
        const left = px <= SNAP_EDGE_PX
        const right = px >= width - SNAP_EDGE_PX
        const top = py <= SNAP_EDGE_PX
        const bottom = py >= height - SNAP_EDGE_PX
        if (nearLeft && nearTop) return { x: 0, y: 0, w: 0.5, h: 0.5 }
        if (nearRight && nearTop) return { x: 0.5, y: 0, w: 0.5, h: 0.5 }
        if (nearLeft && nearBottom) return { x: 0, y: 0.5, w: 0.5, h: 0.5 }
        if (nearRight && nearBottom) return { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }
        if (left) return { x: 0, y: 0, w: 0.5, h: 1 }
        if (right) return { x: 0.5, y: 0, w: 0.5, h: 1 }
        if (top) return { x: 0, y: 0, w: 1, h: 0.5 }
        if (bottom) return { x: 0, y: 0.5, w: 1, h: 0.5 }
        return null
      }
      const zoneKey = rect => rect ? `${rect.x}:${rect.y}:${rect.w}:${rect.h}` : ''
      const beginDrag = (event, group) => {
        if (event.button !== 0) return
        const rect = windows[group.id]
        if (!rect) return
        event.preventDefault()
        const startX = event.clientX
        const startY = event.clientY
        let frame = 0
        setSnapRect(null)
        snapRef.current = null
        zoneRef.current = null
        const move = (moveEvent) => {
          if (frame) return
          frame = requestAnimationFrame(() => {
            frame = 0
            const x = Math.min(Math.max(0, rect.x + (moveEvent.clientX - startX) / containerW), 1 - rect.w)
            const y = Math.min(Math.max(0, rect.y + (moveEvent.clientY - startY) / containerH), 1 - rect.h)
            patchWindow(group.id, { x, y })
            const bounds = hostRef.current ? hostRef.current.getBoundingClientRect() : null
            if (!bounds) return
            const px = moveEvent.clientX - bounds.left
            const py = moveEvent.clientY - bounds.top
            const target = zoneFor(
              px, py, bounds.width, bounds.height, moveEvent.shiftKey, moveEvent.altKey,
            )
            const key = zoneKey(target)
            if (zoneRef.current && zoneRef.current.key === key) return
            zoneRef.current = { target, key }
            snapRef.current = target
            setSnapRect(target)
          })
        }
        const up = (upEvent) => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          if (frame) cancelAnimationFrame(frame)
          let target = upEvent && (!upEvent.shiftKey || upEvent.altKey) ? null : snapRef.current
          if (!target && upEvent && upEvent.shiftKey && !upEvent.altKey && hostRef.current) {
            const bounds = hostRef.current.getBoundingClientRect()
            target = zoneFor(
              upEvent.clientX - bounds.left, upEvent.clientY - bounds.top,
              bounds.width, bounds.height, true, false,
            )
          }
          snapRef.current = null
          zoneRef.current = null
          setSnapRect(null)
          if (!target) return
          mutate(next => {
            const dragged = next.windows[group.id]
            if (!dragged) return
            next.windows[group.id] = { ...dragged, x: target.x, y: target.y, w: target.w, h: target.h }
          })
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }
      const beginResize = (event, group, edge) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        const rect = windows[group.id]
        if (!rect) return
        const startX = event.clientX
        const startY = event.clientY
        const minimum = 0.15
        let frame = 0
        const move = (moveEvent) => {
          if (frame) return
          frame = requestAnimationFrame(() => {
            frame = 0
            const dx = (moveEvent.clientX - startX) / containerW
            const dy = (moveEvent.clientY - startY) / containerH
            let { x, y, w, h } = rect
            if (edge.includes('e')) w = rect.w + dx
            if (edge.includes('w')) { x = rect.x + dx; w = rect.w - dx }
            if (edge.includes('s')) h = rect.h + dy
            if (edge.includes('n')) { y = rect.y + dy; h = rect.h - dy }
            if (w < minimum) { if (edge.includes('w')) x = rect.x + rect.w - minimum; w = minimum }
            if (h < minimum) { if (edge.includes('n')) y = rect.y + rect.h - minimum; h = minimum }
            x = Math.min(Math.max(0, x), 1 - minimum)
            y = Math.min(Math.max(0, y), 1 - minimum)
            w = Math.min(w, 1 - x)
            h = Math.min(h, 1 - y)
            patchWindow(group.id, { x, y, w, h })
          })
        }
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          if (frame) cancelAnimationFrame(frame)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }
      return h('div', { className: 'ffs-floating', ref: hostRef },
        groups.map(group => {
          const rect = windows[group.id]
          const active = (group.tabs || []).includes(group.active) ? group.active : group.tabs[0]
          const title = `${viewerLabel(active)}${(group.tabs || []).length > 1 ? ` +${(group.tabs || []).length - 1}` : ''}`
          return h('div', {
            key: group.id,
            className: 'ffs-float',
            style: {
              left: `${rect.x * 100}%`, top: `${rect.y * 100}%`,
              width: `${rect.w * 100}%`, height: `${rect.h * 100}%`,
              zIndex: rect.z || 1,
            },
          },
            h('div', {
              className: 'ffs-float-head',
              title: 'Drag to move. Hold Shift near an edge/corner to snap; release otherwise to free-place.',
              onPointerDown: event => beginDrag(event, group),
            },
              h('span', { className: 'ffs-grip', 'aria-hidden': true }, '⠿'),
              h('span', { className: 'ffs-float-title' }, title),
              h('span', { className: 'ffs-float-hint' }, 'Shift + edge snaps'),
            ),
            h('div', { className: 'ffs-float-body' },
              h(GroupPane, { node: group, layout, snapshot, dispatch, run, busy, setLayout }),
            ),
            ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(edge => h('span', {
              key: edge, className: `ffs-resize ${edge}`,
              onPointerDown: event => beginResize(event, group, edge),
            })),
            h('span', {
              className: 'ffs-resize-grip', title: 'Resize',
              onPointerDown: event => beginResize(event, group, 'se'),
            }, '◢'),
          )
        }),
        snapRect
          ? h('div', { className: 'ffs-snap-overlay' },
            h('div', {
              className: 'ffs-snap-cell active',
              style: {
                left: `${snapRect.x * 100}%`, top: `${snapRect.y * 100}%`,
                width: `${snapRect.w * 100}%`, height: `${snapRect.h * 100}%`,
              },
            }))
          : null,
      )
    }

    function SettingsPopover({ vp, snapshot, dispatch, onClose }) {
      const set = (line) => dispatch(line)
      const [park, setPark] = useState(vp.position ?? Math.round((vp.positionMax ?? 0) / 2))
      const [depthLo, setDepthLo] = useState(vp.depth?.[0] ?? 0.5)
      const [depthHi, setDepthHi] = useState(vp.depth?.[1] ?? 0.5)
      useEffect(() => {
        setPark(vp.position ?? Math.round((vp.positionMax ?? 0) / 2))
      }, [vp.id, vp.position, vp.positionMax])
      useEffect(() => {
        setDepthLo(vp.depth?.[0] ?? 0.5)
        setDepthHi(vp.depth?.[1] ?? 0.5)
      }, [vp.id, vp.depth])
      const row = (label, control) => h('div', { className: 'ffs-field' }, h('label', {}, label), control)
      return h('div', { className: 'ffs-pop' },
        h('div', { className: 'ffs-row' }, h('strong', {}, 'View settings'), h('span', { style: { flex: 1 } }), h('button', { className: 'ffs-btn icon', onClick: onClose }, '✕')),
        vp.kind === 'image' ? h(React.Fragment, null,
          row('Plane', h('select', { value: vp.plane, onChange: e => set(`SET_VIEW_PLANE ${vp.id} ${e.target.value}`) },
            ['axial', 'sagittal', 'coronal'].map(plane => h('option', { key: plane, value: plane }, plane)))),
          row('Follow crosshair', h('input', { type: 'checkbox', checked: vp.locked, onChange: e => set(`SET_VIEW_LOCKED ${vp.id} ${e.target.checked ? 1 : 0} ${e.target.checked && vp.zoomLinked ? 1 : 0}`) })),
          !vp.locked ? row(`Parked slice ${park}`, h('input', {
            type: 'range', min: 0, max: vp.positionMax ?? 0, value: park,
            onChange: e => { setPark(Number(e.target.value)); set(`SET_VIEW_POSITION ${vp.id} ${e.target.value}`) },
          })) : null,
          row('Zoom-link (LOCK)', h('input', { type: 'checkbox', checked: vp.zoomLinked, onChange: e => set(`SET_VIEW_LOCKED ${vp.id} 1 ${e.target.checked ? 1 : 0}`) })),
          row('Data', h('select', {
            value: vp.solo ? snapshot.selected : 'all',
            onChange: event => {
              const value = event.target.value
              if (value === 'all') set(`SET_VIEW_SOLO ${vp.id} 0`)
              else {
                set(`SELECT_LAYER ${value}`)
                set(`SET_VIEW_SOLO ${vp.id} 1`)
              }
            },
          },
            h('option', { value: 'all' }, 'All visible'),
            (snapshot.layers || []).map(layer => h('option', { key: layer.key, value: layer.key }, `${layer.key} · ${layer.name}`)),
          )),
          h('div', { className: 'ffs-hint' }, 'Solo views show the globally selected layer; choosing Data here selects it.'),
          row('Tiled', h('input', { type: 'checkbox', checked: vp.tiles, onChange: e => set(`SET_VIEW_TILES ${vp.id} ${e.target.checked ? 1 : 0}`) })),
          row('Zoom', h('input', { type: 'number', step: 0.25, min: 1, max: 16, value: vp.zoom, onChange: e => set(`SET_ZOOM ${vp.id} ${e.target.value}`) })),
        ) : null,
        vp.kind === 'surface' ? h(React.Fragment, null,
          row('Shape', h('select', { value: vp.shape, onChange: e => set(`SET_SURFACE_SHAPE ${vp.id} ${e.target.value}`) },
            ['inflated', 'white', 'pial', 'mid', 'sphere', 'flat'].map(v => h('option', {
              key: v, value: v, disabled: v === 'flat' && !snapshot.surfaces.flatAvailable,
            }, v)))),
          row('Hemispheres', h('select', { value: vp.hemis, onChange: e => set(`SET_SURFACE_HEMIS ${vp.id} ${e.target.value} ${vp.split}`) },
            ['lh,rh', 'lh', 'rh'].map(v => h('option', { key: v, value: v }, v)))),
          row('Split mm', h('input', { type: 'number', step: 2, value: vp.split, onChange: e => set(`SET_SURFACE_HEMIS ${vp.id} ${vp.hemis} ${e.target.value}`) })),
          row(`Depth ${depthLo.toFixed(2)}–${depthHi.toFixed(2)}`, h('span', { className: 'ffs-row' },
            h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: depthLo, onChange: e => { const v = Number(e.target.value); setDepthLo(v); set(`SET_SURFACE_DEPTH ${vp.id} ${v} ${depthHi} ${vp.samples}`) } }),
            h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: depthHi, onChange: e => { const v = Number(e.target.value); setDepthHi(v); set(`SET_SURFACE_DEPTH ${vp.id} ${depthLo} ${v} ${vp.samples}`) } }),
          )),
          row('Samples', h('input', { type: 'number', min: 1, max: 16, value: vp.samples, onChange: e => set(`SET_SURFACE_DEPTH ${vp.id} ${vp.depth[0]} ${vp.depth[1]} ${e.target.value}`) })),
          row('Depth stat', h('select', { value: vp.depthStat, onChange: e => set(`SET_SURFACE_DEPTH_STAT ${vp.id} ${e.target.value}`) },
            ['mean', 'median', 'max', 'min', 'max_abs', 'nzmean'].map(v => h('option', { key: v, value: v }, v)))),
          row('Equivolume', h('input', { type: 'checkbox', checked: vp.equivolume, onChange: e => set(`SET_SURFACE_EQUIVOLUME ${vp.id} ${e.target.checked ? 1 : 0}`) })),
          row('Folding', h('select', { value: vp.folding, onChange: e => set(`SET_SURFACE_FOLDING ${vp.id} ${e.target.value}`) },
            ['curv', 'sulc', 'binary', 'off'].map(v => h('option', { key: v, value: v }, v)))),
          row('Vertex map', h('select', { value: vp.vertexMap, onChange: e => set(`SET_SURFACE_MAP ${vp.id} ${e.target.value}`) },
            ['', 'curv', 'sulc', 'thickness', 'annot'].map(v => h('option', { key: v, value: v }, v || 'none')))),
          row('Hinge °', h('input', { type: 'number', step: 15, value: vp.hinge, onChange: e => set(`SET_SURFACE_HINGE ${vp.id} ${e.target.value}`) })),
        ) : null,
        vp.kind === 'graph' ? h(React.Fragment, null,
          row(`Grid ${vp.gridN}×${vp.gridN}`, h('span', { className: 'ffs-row' },
            h('button', { className: 'ffs-btn icon', onClick: () => set(`SET_VIEW_GRID ${vp.id} ${Math.max(1, vp.gridN - 1)}`) }, '−'),
            h('button', { className: 'ffs-btn icon', onClick: () => set(`SET_VIEW_GRID ${vp.id} ${Math.min(16, vp.gridN + 1)}`) }, '+'),
          )),
          row('Shared y-scale', h('input', { type: 'checkbox', checked: vp.sharedScale, onChange: e => set(`SET_VIEW_SHARED_SCALE ${vp.id} ${e.target.checked ? 1 : 0}`) })),
          row('Tint by overlay', h('input', { type: 'checkbox', checked: vp.tint, onChange: e => set(`SET_VIEW_TINT ${vp.id} ${e.target.checked ? 1 : 0}`) })),
          row('Detrend', h('input', { type: 'number', min: -1, max: 5, value: vp.detrend, onChange: e => set(`SET_VIEW_DETREND ${vp.id} ${e.target.value}`) })),
        ) : null,
        h('div', { className: 'ffs-hint' }, `${viewerLabel(vp.id)} · FFS view id ${vp.id}. Every control here is a validated FFS command — the same interface the agent tools use.`),
      )
    }

    // ------------------------------------------------------------------ pane body
    function PaneBody({ vp, snapshot, dispatch, run }) {
      if (!vp) return h('div', { className: 'ffs-empty' }, 'Select a view')
      if (vp.kind === 'image') return h(SlicePane, { vp, snapshot, dispatch, run })
      if (vp.kind === 'surface') return h(SurfacePane, { vp, snapshot, dispatch, run })
      if (vp.kind === 'graph') return h(SeriesPane, { vp, snapshot, dispatch, run })
      return h('div', { className: 'ffs-empty' }, `${vp.kind} viewports are part of the FFS vocabulary but not implemented in this prototype.`)
    }

    // ------------------------------------------------------------------ slice pane
    function SlicePane({ vp, snapshot, dispatch, run }) {
      const wrapRef = useRef(null)
      const canvasRef = useRef(null)
      const [frame, setFrame] = useState(null)
      const [size, setSize] = useState({ width: 1, height: 1 })
      const drag = useRef(null)
      const panPending = useRef(null)
      const renderToken = useRef(null)
      const renderPending = useRef(null)
      const renderBusy = useRef(false)
      const renderScheduled = useRef(false)
      const aliveRef = useRef(true)
      const imgRef = useRef(null)
      const outlineCache = useRef({ token: null, outlines: [] })

      useEffect(() => {
        if (!wrapRef.current) return
        const observer = new ResizeObserver(entries => {
          const rect = entries[0].contentRect
          setSize({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) })
        })
        observer.observe(wrapRef.current)
        return () => observer.disconnect()
      }, [])


      useEffect(() => () => { aliveRef.current = false }, [])

      const pumpRender = useCallback(() => {
        if (renderBusy.current) return
        const job = renderPending.current
        if (!job || job.token === renderToken.current) return
        renderBusy.current = true
        run('render', { view: vp.id, outlineToken: job.outlineToken }).then(result => {
          if (!aliveRef.current) return
          renderToken.current = job.token
          const latest = !renderPending.current || renderPending.current.token === job.token
          if (!latest) return
          if (!result.outlinesUnchanged) {
            outlineCache.current = { token: result.outlineToken, outlines: result.outlines || [] }
          }
          const outlines = outlineCache.current.outlines
          const image = new Image()
          image.onload = () => {
            if (!aliveRef.current) return
            if (renderPending.current && renderPending.current.token !== job.token) return
            imgRef.current = image
            setFrame({ ...result, outlines })
          }
          image.src = `data:image/png;base64,${result.png}`
        }).catch(() => {
          if (aliveRef.current && renderPending.current && renderPending.current.token === job.token) {
            renderToken.current = null
          }
        }).finally(() => {
          renderBusy.current = false
          if (aliveRef.current && renderPending.current
            && renderPending.current.token !== renderToken.current) pumpRender()
        })
      }, [run, vp.id])

      const revision = snapshot.rev
      useEffect(() => {
        const token = `${vp.id}:${revision}:${JSON.stringify([vp.zoom, vp.pan, vp.locked, vp.position, vp.solo, vp.tiles, vp.tilt, vp.sampling])}:${layerSignature(snapshot.layers)}`
        if (renderToken.current === token) return
        renderPending.current = { token, outlineToken: outlineCache.current.token }
        if (renderBusy.current || renderScheduled.current) return
        renderScheduled.current = true
        requestAnimationFrame(() => {
          renderScheduled.current = false
          pumpRender()
        })
      }, [vp, revision, run, pumpRender])

      useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas || !wrapRef.current) return
        const dpr = window.devicePixelRatio || 1
        const width = size.width
        const height = size.height
        canvas.width = Math.max(1, Math.round(width * dpr))
        canvas.height = Math.max(1, Math.round(height * dpr))
        const ctx = canvas.getContext('2d')
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, width, height)
        ctx.fillStyle = '#0b0d10'
        ctx.fillRect(0, 0, width, height)
        const image = imgRef.current
        if (!image || !frame) return
        const scale = Math.min(width / image.width, height / image.height)
        const dw = image.width * scale
        const dh = image.height * scale
        const dx = (width - dw) / 2
        const dy = (height - dh) / 2
        ctx.imageSmoothingEnabled = false
        ctx.drawImage(image, dx, dy, dw, dh)
        ctx.save()
        ctx.beginPath()
        ctx.rect(dx, dy, dw, dh)
        ctx.clip()
        // Surface outlines: FFS pixel coordinates normalised by the drawn plane span.
        const span = frame.viewInfo?.span
        if (span && frame.outlines) {
          for (const outline of frame.outlines) {
            const seg = decodeF32(outline.segments)
            ctx.strokeStyle = `rgb(${Math.round(outline.rgb[0] * 255)},${Math.round(outline.rgb[1] * 255)},${Math.round(outline.rgb[2] * 255)})`
            ctx.lineWidth = 1
            ctx.beginPath()
            for (let i = 0; i < seg.length; i += 4) {
              ctx.moveTo(dx + seg[i + 1] * dw, dy + seg[i] * dh)
              ctx.lineTo(dx + seg[i + 3] * dw, dy + seg[i + 2] * dh)
            }
            ctx.stroke()
          }
        }
        if (frame.crosshairPx) {
          const cx = dx + frame.crosshairPx[1] * dw
          const cy = dy + frame.crosshairPx[0] * dh
          ctx.strokeStyle = 'rgba(255,80,80,.9)'
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(dx, cy); ctx.lineTo(dx + dw, cy)
          ctx.moveTo(cx, dy); ctx.lineTo(cx, dy + dh)
          ctx.stroke()
          ctx.fillStyle = 'rgba(255,80,80,.95)'
          ctx.beginPath(); ctx.arc(cx, cy, 2.2, 0, Math.PI * 2); ctx.fill()
        }
        ctx.restore()
        ctx.fillStyle = 'rgba(255,255,255,.65)'
        ctx.font = '10px ui-monospace, monospace'
        ctx.fillText(`${frame.plane} ${frame.position}`, dx + 6, dy + 12)
        if (!vp.locked) {
          ctx.fillStyle = 'rgba(255,190,60,.9)'
          ctx.fillText('PARKED', dx + 6, dy + 24)
        }
      }, [size, frame, vp.locked])

      const imageRect = () => {
        const wrap = wrapRef.current
        if (!wrap || !frame) return null
        const width = size.width
        const height = size.height
        const scale = Math.min(width / frame.width, height / frame.height)
        const dw = frame.width * scale
        const dh = frame.height * scale
        return { dx: (width - dw) / 2, dy: (height - dh) / 2, dw, dh }
      }
      const pointer = (event) => {
        const wrap = wrapRef.current
        const rect = wrap.getBoundingClientRect()
        return { x: event.clientX - rect.left, y: event.clientY - rect.top }
      }
      const panAccum = useRef({ x: 0, y: 0, queued: false })
      const zoomAccum = useRef({ factor: 1, queued: false })
      const sendPan = (dxFrac, dyFrac) => {
        // Negative because dragging the image right brings what is on the left
        // into view, exactly as the original pane's panned(-dy/scale, -dx/scale).
        // One request per animation frame: a drag must not issue one RPC per event.
        const p = panAccum.current
        p.x -= dxFrac
        p.y -= dyFrac
        if (p.queued) return
        p.queued = true
        requestAnimationFrame(() => {
          p.queued = false
          const x = p.x, y = p.y
          p.x = 0; p.y = 0
          if (x || y) run('pan', { view: vp.id, dx: x, dy: y }, null, { quiet: true }).catch(() => {})
        })
      }
      const sendZoom = (factor) => {
        const z = zoomAccum.current
        z.factor *= factor
        if (z.queued) return
        z.queued = true
        requestAnimationFrame(() => {
          z.queued = false
          const f = z.factor
          z.factor = 1
          if (f !== 1) run('zoom', { view: vp.id, factor: f }, null, { quiet: true }).catch(() => {})
        })
      }
      // Cursor drag: the original image pane emits a pick on press and then at
      // most one per painted frame while dragging, so the crosshair follows the
      // pointer. Mirror that: newest position wins, one RPC in flight at a time.
      const pickAccum = useRef({ row: 0, col: 0, action: 'crosshair', scheduled: false, busy: false })
      const flushPick = () => {
        const p = pickAccum.current
        p.scheduled = false
        if (p.busy) return
        p.busy = true
        run('pick', { view: vp.id, row: p.row, col: p.col, action: p.action }, null, { quiet: true })
          .catch(() => {})
          .finally(() => {
            p.busy = false
            if (p.scheduled) requestAnimationFrame(flushPick)
          })
      }
      const queuePick = (row, col, action) => {
        const p = pickAccum.current
        p.row = row
        p.col = col
        p.action = action
        if (p.scheduled || p.busy) { p.scheduled = true; return }
        p.scheduled = true
        requestAnimationFrame(flushPick)
      }
      const imagePoint = (point) => {
        const r = imageRect()
        if (!r || !frame) return null
        return {
          row: ((point.y - r.dy) / r.dh) * frame.height,
          col: ((point.x - r.dx) / r.dw) * frame.width,
        }
      }
      const onPointerDown = (event) => {
        const point = pointer(event)
        const seed = event.ctrlKey || event.metaKey
        let mode = 'pick'
        if (event.button === 2) mode = 'zoom'
        else if (event.button === 1 || (event.button === 0 && event.shiftKey)) mode = 'pan'
        else if (event.button !== 0) return
        if (mode === 'zoom') event.preventDefault()
        drag.current = { mode, seed, start: point, last: point, moved: false }
        event.currentTarget.setPointerCapture(event.pointerId)
        if (mode === 'pick') {
          const at = imagePoint(point)
          if (at) {
            queuePick(at.row, at.col, seed ? 'seed' : 'crosshair')
            // A press is a pick even without movement: send it now, not on release.
            flushPick()
          }
        }
      }
      const onPointerMove = (event) => {
        const record = drag.current
        if (!record) return
        const point = pointer(event)
        const dx = point.x - record.last.x
        const dy = point.y - record.last.y
        if (Math.abs(point.x - record.start.x) + Math.abs(point.y - record.start.y) > 3) record.moved = true
        if (record.mode === 'pan') {
          const r = imageRect()
          if (r) sendPan(dx / r.dw, dy / r.dh)
        } else if (record.mode === 'zoom' && record.moved) {
          sendZoom(Math.exp(-dy / 150))
        } else if (record.mode === 'pick' && record.moved) {
          const at = imagePoint(point)
          if (at) queuePick(at.row, at.col, record.seed ? 'seed' : 'crosshair')
        }
        record.last = point
      }
      const onPointerUp = (event) => {
        const record = drag.current
        drag.current = null
        if (!record || record.mode !== 'pick') return
        const at = imagePoint(pointer(event))
        if (at) queuePick(at.row, at.col, record.seed ? 'seed' : 'crosshair')
      }
      useEffect(() => {
        const element = wrapRef.current
        if (!element) return undefined
        // React registers wheel listeners passively; preventDefault must be on a
        // native non-passive listener or the page scrolls instead of stepping.
        const wheel = (event) => {
          event.preventDefault()
          const delta = event.deltaY < 0 ? 1 : -1
          run('step', { view: vp.id, delta }, null, { quiet: true }).catch(() => {})
        }
        element.addEventListener('wheel', wheel, { passive: false })
        return () => element.removeEventListener('wheel', wheel)
      }, [run, vp.id])
      return h('div', { className: 'ffs-canvas-wrap', ref: wrapRef, style: { cursor: 'crosshair' } },
        h('canvas', {
          ref: canvasRef,
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: () => { drag.current = null },
          onContextMenu: event => event.preventDefault(),
        }),
        h('div', { style: { position: 'absolute', left: 6, bottom: 4, color: 'rgba(255,255,255,.55)', fontSize: 10, pointerEvents: 'none' } },
          `${fmtMm(snapshot.crosshairMm)} mm · click/drag to move · ctrl+click seed · shift/middle drag pan · right drag zoom · wheel slice${snapshot.loading ? ' · loading' : ''}`),
      )
    }

    // ------------------------------------------------------------------ surface pane
    const SURFACE_VERT = `#version 300 es
      in vec3 aPos; in vec3 aNormal; in vec4 aColor;
      in vec3 aWhite; in vec3 aPial; in vec2 aAreas;
      uniform mat4 uMvp;
      uniform mat3 uViewRot;
      out vec3 vNormal; out vec4 vColor;
      out vec3 vWhite; out vec3 vPial; out vec2 vAreas;
      void main() {
        vNormal = uViewRot * aNormal;
        vColor = aColor;
        vWhite = aWhite;
        vPial = aPial;
        vAreas = aAreas;
        gl_Position = uMvp * vec4(aPos, 1.0);
      }`
    const SURFACE_FRAG = `#version 300 es
      precision mediump float;
      precision highp sampler3D;
      precision highp sampler2D;
      in vec3 vNormal; in vec4 vColor;
      in vec3 vWhite; in vec3 vPial; in vec2 vAreas;
      uniform sampler3D uVolume;
      uniform sampler3D uStat;
      uniform sampler2D uLut;
      uniform vec4 uCmap;       // lo, hi, threshold, opacity
      uniform mat4 uTexFromMm;
      uniform mat4 uStatFromMm;
      uniform float uDepth;
      uniform int uUseTexture;
      uniform int uHasStat;
      uniform int uEquiv;
      uniform int uSign;        // 0 both, 1 pos, 2 neg
      uniform int uAlpha;       // 0 off, 1 linear, 2 quadratic
      uniform int uPanes;
      out vec4 outColor;

      bool inside(vec3 t) {
        return all(greaterThanEqual(t, vec3(0.0))) && all(lessThanEqual(t, vec3(1.0)));
      }

      // Equivolume depth (Waehnert 2014), exactly surfacewindow.py:equivolume.
      float equivolume(float a) {
        float aw = vAreas.x, ap = vAreas.y, delta = ap - aw;
        if (abs(delta) <= 1e-4 * max(aw + ap, 1e-12)) return a;
        return (sqrt(max((1.0 - a) * aw * aw + a * ap * ap, 0.0)) - aw) / delta;
      }

      float unitOf(float v) {
        float lo = uCmap.x, hi = uCmap.y;
        float top = max(abs(hi), abs(lo));
        if (uSign == 1) return top > 0.0 ? clamp(max(v, 0.0) / top, 0.0, 1.0) : 0.0;
        if (uSign == 2) return top > 0.0 ? clamp(max(-v, 0.0) / top, 0.0, 1.0) : 0.0;
        float span = hi - lo;
        return span > 0.0 ? clamp((v - lo) / span, 0.0, 1.0) : 0.0;
      }

      float alphaOf(float s) {
        float mag = uSign == 1 ? max(s, 0.0) : (uSign == 2 ? max(-s, 0.0) : abs(s));
        float thr = abs(uCmap.z);
        if (thr <= 0.0) return (uSign == 0 || mag > 0.0) ? 1.0 : 0.0;
        if (mag >= thr) return 1.0;
        if (uAlpha == 0) return 0.0;
        float r = clamp(mag / thr, 0.0, 1.0);
        return uAlpha == 2 ? r * r : r;
      }

      vec3 lutColour(float u) {
        if (uPanes > 0) {
          u = (clamp(floor(u * float(uPanes)), 0.0, float(uPanes - 1)) + 0.5) / float(uPanes);
        }
        int idx = int(clamp(floor(u * 255.0 + 0.5), 0.0, 255.0));
        return texelFetch(uLut, ivec2(idx, 0), 0).rgb;
      }

      void main() {
        // Original shader: view-space headlight; folding/base grey full light,
        // overlays the original 40%-blended light.
        vec3 n = normalize(vNormal);
        float light = 0.35 + 0.65 * abs(n.z);
        float chroma = clamp((max(vColor.r, max(vColor.g, vColor.b))
                            - min(vColor.r, min(vColor.g, vColor.b))) * 2.0, 0.0, 1.0);
        float shade = mix(light, 0.6 + 0.4 * light, chroma);
        vec3 col = vColor.rgb * shade;
        if (uUseTexture == 1) {
          float d = uEquiv == 1 ? equivolume(uDepth) : uDepth;
          vec3 p = mix(vWhite, vPial, d);
          vec3 t = (uTexFromMm * vec4(p, 1.0)).xyz;
          if (inside(t)) {
            float value = texture(uVolume, t).r;
            float stat = uHasStat == 1 ? texture(uStat, t).r : value;
            vec3 rgb = lutColour(unitOf(value)) * (0.6 + 0.4 * light);
            col = mix(col, rgb, alphaOf(stat) * uCmap.w);
          }
        }
        outColor = vec4(col, 1.0);
      }`
    function mat4Multiply(a, b) {
      const out = new Float32Array(16)
      for (let c = 0; c < 4; c += 1) {
        for (let r = 0; r < 4; r += 1) {
          let sum = 0
          for (let k = 0; k < 4; k += 1) sum += a[k * 4 + r] * b[c * 4 + k]
          out[c * 4 + r] = sum
        }
      }
      return out
    }
    function cameraMatrix(camera, aspect) {
      const [x, y, z] = camera.target
      const r = camera.rotation
      const view = new Float32Array(16)
      view[0] = r[0]; view[1] = r[3]; view[2] = r[6]; view[3] = 0
      view[4] = r[1]; view[5] = r[4]; view[6] = r[7]; view[7] = 0
      view[8] = r[2]; view[9] = r[5]; view[10] = r[8]; view[11] = 0
      const tx = -(r[0] * x + r[1] * y + r[2] * z)
      const ty = -(r[3] * x + r[4] * y + r[5] * z)
      const tz = -(r[6] * x + r[7] * y + r[8] * z) - camera.distance
      view[12] = tx; view[13] = ty; view[14] = tz; view[15] = 1
      const f = 1 / Math.tan((camera.fovDeg * Math.PI / 180) / 2)
      const near = Math.max(camera.distance * 0.05, 1)
      const far = camera.distance * 4 + 500
      const proj = new Float32Array(16)
      proj[0] = f / Math.max(aspect, 1e-6)
      proj[5] = f
      proj[10] = (far + near) / (near - far)
      proj[11] = -1
      proj[14] = (2 * far * near) / (near - far)
      return mat4Multiply(proj, view)
    }
    function rotationAxis(axis, angle) {
      const [x, y, z] = axis
      const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c
      return [
        t * x * x + c, t * x * y - s * z, t * x * z + s * y,
        t * x * y + s * z, t * y * y + c, t * y * z - s * x,
        t * x * z - s * y, t * y * z + s * x, t * z * z + c,
      ]
    }
    function rotMultiply(a, b) {
      const out = new Array(9)
      for (let r = 0; r < 3; r += 1) {
        for (let c = 0; c < 3; c += 1) {
          out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
        }
      }
      return out
    }
    function cameraPan(camera, dx, dy) {
      // Camera.pan in FFS: screen drag in units of the view height; rows of the
      // rotation are the screen right/up axes, and dy moves the target up.
      const h = 2 * camera.distance * Math.tan((camera.fovDeg * Math.PI / 180) / 2)
      const right = [camera.rotation[0], camera.rotation[1], camera.rotation[2]]
      const up = [camera.rotation[3], camera.rotation[4], camera.rotation[5]]
      for (let i = 0; i < 3; i += 1) camera.target[i] += -dx * h * right[i] + dy * h * up[i]
    }
    function cameraZoom(camera, factor) {
      camera.distance = clamp(camera.distance * factor, 20, 3000)
    }
    function cameraOrbit(camera, dx, dy) {
      camera.rotation = rotMultiply(
        rotMultiply(rotationAxis([0, 1, 0], dx), rotationAxis([1, 0, 0], dy)),
        camera.rotation,
      )
    }
    function defaultCamera(bounds) {
      const centre = [0, 1, 2].map(i => (bounds.min[i] + bounds.max[i]) / 2)
      const radius = Math.max(1, Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]) / 2)
      return { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], distance: radius / Math.sin((30 * Math.PI / 180) / 2) * 1.05, target: centre, fovDeg: 30 }
    }
    function vertexNormals(positions, faces) {
      const normals = new Float32Array(positions.length)
      for (let f = 0; f < faces.length; f += 3) {
        const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3
        const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2]
        const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2]
        const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x
        for (const index of [a, b, c]) { normals[index] += nx; normals[index + 1] += ny; normals[index + 2] += nz }
      }
      for (let i = 0; i < normals.length; i += 3) {
        const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1
        normals[i] /= len; normals[i + 1] /= len; normals[i + 2] /= len
      }
      return normals
    }

    function easeInOutCubic(t) {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    }
    function cameraForShapeChange(camera, oldBounds, newBounds) {
      // FFS surfacewindow._camera_for: keep the zoom relative to the brain and
      // move the target proportionally, so an inflated surface does not jump.
      if (!camera || !oldBounds || !newBounds) return camera
      const centreSize = bounds => {
        const centre = [0, 1, 2].map(i => (bounds.min[i] + bounds.max[i]) / 2)
        const size = Math.hypot(
          bounds.max[0] - bounds.min[0],
          bounds.max[1] - bounds.min[1],
          bounds.max[2] - bounds.min[2],
        )
        return { centre, size }
      }
      const old = centreSize(oldBounds)
      const next = centreSize(newBounds)
      if (old.size <= 0 || next.size <= 0) return camera
      const ratio = next.size / old.size
      return {
        ...camera,
        distance: camera.distance * ratio,
        target: next.centre.map((value, index) => value + (camera.target[index] - old.centre[index]) * ratio),
      }
    }

    function decodeSurfaceMesh(mesh) {
      const buffers = []
      const positionsList = []
      const facesList = []
      const hemis = []
      for (const hemi of mesh.hemis) {
        const positions = decodeF32(hemi.positions)
        const faces = decodeU32(hemi.faces)
        const normals = vertexNormals(positions, faces)
        const buffer = { hemi: hemi.hemi, positions, faces, normals }
        if (hemi.white) buffer.white = decodeF32(hemi.white)
        if (hemi.pial) buffer.pial = decodeF32(hemi.pial)
        if (hemi.areas) buffer.areas = decodeF32(hemi.areas)
        buffers.push(buffer)
        positionsList.push(positions)
        facesList.push(faces)
        hemis.push(hemi.hemi)
      }
      return { buffers, positions: positionsList, faces: facesList, hemis, bounds: mesh.bounds }
    }

    function SurfacePane({ vp, snapshot, dispatch, run }) {
      const wrapRef = useRef(null)
      const canvasRef = useRef(null)
      const glRef = useRef(null)
      const programRef = useRef(null)
      const meshRef = useRef({ rev: null, buffers: [], positions: [], faces: [], hemis: [], shape: null, bounds: null })
      const colorsRef = useRef(new Map())
      const colorsCache = useRef({ token: null, colors: [], layer: null })
      const overlayRef = useRef({
        token: null, params: null, lut: null, lutTexture: null,
        valueData: null, statData: null, valueTexture: null, statTexture: null,
      })
      const meshCacheRef = useRef(new Map())
      const prefetchTimer = useRef(null)
      const lastLayerSig = useRef('')
      const subjectRef = useRef(null)
      const cameraRef = useRef(null)
      const morphRef = useRef(null)
      const [frame, setFrame] = useState(null)
      const [size, setSize] = useState({ width: 1, height: 1 })
      const [hover, setHover] = useState(null)
      const [morphing, setMorphing] = useState(false)
      const dragRef = useRef(null)
      const tokenRef = useRef(null)
      const [error, setError] = useState(null)

      useEffect(() => {
        if (!canvasRef.current) return
        const observer = new ResizeObserver(entries => {
          const rect = entries[0].contentRect
          setSize({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) })
        })
        observer.observe(wrapRef.current)
        return () => observer.disconnect()
      }, [])



      useEffect(() => () => {
        if (prefetchTimer.current) clearTimeout(prefetchTimer.current)
      }, [])

      useEffect(() => {
        const subject = snapshot.surfaces ? snapshot.surfaces.subject : null
        if (subjectRef.current !== subject) {
          subjectRef.current = subject
          meshCacheRef.current.clear()
        }
      }, [snapshot.surfaces])

      useEffect(() => {
        let cancelled = false
        const token = `${vp.id}:${vp.shape}:${vp.hemis}:${vp.split}:${vp.hinge}:${vp.depth}:${vp.samples}:${vp.depthStat}:${vp.folding}:${vp.vertexMap}:${vp.equivolume}:${snapshot.surfaces.loaded.join(',')}:${snapshot.surfaces.subject}:${JSON.stringify(snapshot.surfaces.versions||{})}:${snapshot.revByCategory?.source || 0}:${snapshot.revByCategory?.analysis || 0}:${layerSignature(snapshot.layers)}`
        if (tokenRef.current === token) return
        tokenRef.current = token
        if (meshRef.current.shape && meshRef.current.shape !== vp.shape) setMorphing(true)
        const layerSig = layerSignature(snapshot.layers)
        const cacheKey = shape => [
          shape, vp.hemis, vp.split, vp.hinge,
          snapshot.surfaces ? snapshot.surfaces.subject : '',
        ].join('|')
        const previous = meshRef.current
        if (previous.shape && previous.shape !== vp.shape && lastLayerSig.current === layerSig) {
          const cached = meshCacheRef.current.get(cacheKey(vp.shape))
          if (cached) {
            const oldCamera = cameraRef.current
            const targetCamera = oldCamera
              ? cameraForShapeChange(oldCamera, previous.bounds, cached.bounds)
              : oldCamera
            if (oldCamera && targetCamera) {
              cameraRef.current = { ...targetCamera, target: [...targetCamera.target] }
              meshRef.current = {
                rev: cached.meshRev || null, buffers: cached.buffers,
                positions: cached.positions || [], faces: cached.faces || [],
                hemis: cached.hemis || [], bounds: cached.bounds, shape: vp.shape,
              }
              startMorph(previous.buffers, cached.buffers, { ...oldCamera, target: [...oldCamera.target] }, targetCamera)
              lastLayerSig.current = layerSig
              setMorphing(false)
              setError(null)
              return
            }
          }
        }
        run('surface', {
          view: vp.id, meshRev: meshRef.current.rev, colorsToken: colorsCache.current.token,
          fragment: true, overlayToken: overlayRef.current.token,
        }).then(raw => {
          if (cancelled) return
          let result = raw
          if (raw.colorsUnchanged && colorsCache.current.token) {
            result = { ...raw, colors: colorsCache.current.colors, layer: colorsCache.current.layer }
          } else {
            colorsCache.current = { token: raw.colorsToken, colors: raw.colors || [], layer: raw.layer }
          }
          const overlay = result.fragment || null
          if (overlay) {
            if (overlay.value) overlayRef.current.valueData = decodeF32(overlay.value)
            if (overlay.stat) overlayRef.current.statData = decodeF32(overlay.stat)
            overlayRef.current.token = overlay.token
            overlayRef.current.params = overlay
            overlayRef.current.lut = decodeU8(overlay.lut)
          } else {
            overlayRef.current.token = null
            overlayRef.current.params = null
            overlayRef.current.valueData = null
            overlayRef.current.statData = null
            overlayRef.current.lut = null
          }
          setError(null)
          setFrame(result)
          if (result.mesh) {
            const previous = meshRef.current
            const previousCamera = cameraRef.current
            const decoded = decodeSurfaceMesh(result.mesh)
            const shapeChanged = Boolean(previous.shape && previous.shape !== result.shape)
            const targetCamera = shapeChanged && previousCamera
              ? cameraForShapeChange(previousCamera, previous.bounds, result.mesh.bounds)
              : previousCamera
            // Keep decoded geometry for the shape we are leaving (and the one we
            // arrive at) so a later Flatten/Inflated toggle is instant: the
            // 13 MB mesh does not need to cross the bridge again.
            if (previous.shape && previous.bounds) {
              meshCacheRef.current.set(cacheKey(previous.shape), {
                buffers: previous.buffers.map(buffer => ({
                  ...buffer, gl: null, displayPositions: null, displayNormals: null,
                })),
                positions: previous.positions, faces: previous.faces, hemis: previous.hemis,
                bounds: previous.bounds, meshRev: previous.rev,
              })
            }
            meshCacheRef.current.set(cacheKey(result.shape), {
              buffers: decoded.buffers.map(buffer => ({
                ...buffer, gl: null, displayPositions: null, displayNormals: null,
              })),
              positions: decoded.positions, faces: decoded.faces, hemis: decoded.hemis,
              bounds: decoded.bounds, meshRev: result.meshRev,
            })
            meshRef.current = {
              rev: result.meshRev, buffers: decoded.buffers, positions: decoded.positions,
              faces: decoded.faces, hemis: decoded.hemis, bounds: decoded.bounds,
              shape: result.shape,
            }
            lastLayerSig.current = layerSig
            if (!previousCamera) {
              cameraRef.current = defaultCamera(result.mesh.bounds)
            } else if (shapeChanged) {
              // Animate the shape like surfacewindow.py: 450 ms InOutCubic from
              // the positions currently on screen to the new shape, camera included.
              const oldCamera = { ...previousCamera, target: [...previousCamera.target] }
              cameraRef.current = { ...targetCamera, target: [...targetCamera.target] }
              startMorph(previous.buffers || [], decoded.buffers, oldCamera, targetCamera)
              colorsRef.current = new Map((result.colors || []).map(item => [item.hemi, decodeU8(item.rgba)]))
              setMorphing(false)
              return
            }
            // Fetch the other shape in the background, once, so the next toggle
            // has its mesh already decoded.
            const alternate = vp.shape === 'flat' ? 'inflated' : 'flat'
            const alternateAllowed = alternate !== 'flat' || snapshot.surfaces.flatAvailable
            if (alternateAllowed && !meshCacheRef.current.has(cacheKey(alternate))) {
              if (prefetchTimer.current) clearTimeout(prefetchTimer.current)
              prefetchTimer.current = setTimeout(() => {
                run('surface', {
                  view: vp.id, shape: alternate, colors: false, meshRev: null, fragment: true,
                }, null, { quiet: true })
                  .then(prefetch => {
                    if (!prefetch || !prefetch.mesh) return
                    const pre = decodeSurfaceMesh(prefetch.mesh)
                    meshCacheRef.current.set(cacheKey(prefetch.shape || alternate), {
                      buffers: pre.buffers.map(buffer => ({
                        ...buffer, gl: null, displayPositions: null, displayNormals: null,
                      })),
                      positions: pre.positions, faces: pre.faces, hemis: pre.hemis,
                      bounds: pre.bounds, meshRev: prefetch.meshRev,
                    })
                  })
                  .catch(() => {})
              }, 350)
            }
          }
          colorsRef.current = new Map((result.colors || []).map(item => [item.hemi, decodeU8(item.rgba)]))
          setMorphing(false)
          drawSurface()
        }).catch(err => {
          if (!cancelled) { setError(err.message); setMorphing(false); tokenRef.current = null }
        })
        return () => { cancelled = true }
      }, [vp, snapshot.rev, run])

      const gl = () => glRef.current

      useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const context = canvas.getContext('webgl2', { alpha: true, antialias: true, preserveDrawingBuffer: false })
        if (!context) { setError('WebGL2 is not available in this browser'); return }
        glRef.current = context
        const compile = (type, source) => {
          const shader = context.createShader(type)
          context.shaderSource(shader, source)
          context.compileShader(shader)
          if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) throw new Error(context.getShaderInfoLog(shader))
          return shader
        }
        try {
          const program = context.createProgram()
          context.attachShader(program, compile(context.VERTEX_SHADER, SURFACE_VERT))
          context.attachShader(program, compile(context.FRAGMENT_SHADER, SURFACE_FRAG))
          context.linkProgram(program)
          if (!context.getProgramParameter(program, context.LINK_STATUS)) throw new Error(context.getProgramInfoLog(program))
          programRef.current = program
          context.enable(context.DEPTH_TEST)
          context.enable(context.BLEND)
          context.blendFunc(context.SRC_ALPHA, context.ONE_MINUS_SRC_ALPHA)
        } catch (err) { setError(err.message) }
        drawSurface()
        return () => {
          if (morphRef.current) morphRef.current.cancel()
          context.getExtension('WEBGL_lose_context')?.loseContext()
        }
      }, [])

      const drawSurface = useCallback(() => {
        const context = gl()
        const program = programRef.current
        const canvas = canvasRef.current
        if (!context || !program || !canvas) return
        const camera = cameraRef.current
        if (!camera) return
        const dpr = window.devicePixelRatio || 1
        const width = Math.max(1, Math.round(size.width * dpr))
        const height = Math.max(1, Math.round(size.height * dpr))
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
        context.viewport(0, 0, width, height)
        context.clearColor(0.043, 0.051, 0.063, 1)
        context.clear(context.COLOR_BUFFER_BIT | context.DEPTH_BUFFER_BIT)
        const aspect = width / Math.max(height, 1)
        const mvp = cameraMatrix(camera, aspect)
        context.useProgram(program)
        const uMvp = context.getUniformLocation(program, 'uMvp')
        context.uniformMatrix4fv(uMvp, false, mvp)
        const uViewRot = context.getUniformLocation(program, 'uViewRot')
        if (uViewRot) {
          const r = camera.rotation
          context.uniformMatrix3fv(uViewRot, false, new Float32Array([
            r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8],
          ]))
        }
        const overlayParams = overlayRef.current.params
        const useTexture = Boolean(
          overlayParams && overlayParams.mode === 'texture' && overlayRef.current.valueData,
        )
        const uUseTexture = context.getUniformLocation(program, 'uUseTexture')
        const uCmap = context.getUniformLocation(program, 'uCmap')
        const uSign = context.getUniformLocation(program, 'uSign')
        const uAlpha = context.getUniformLocation(program, 'uAlpha')
        const uPanes = context.getUniformLocation(program, 'uPanes')
        const uLut = context.getUniformLocation(program, 'uLut')
        const uVolume = context.getUniformLocation(program, 'uVolume')
        const uStat = context.getUniformLocation(program, 'uStat')
        const uHasStat = context.getUniformLocation(program, 'uHasStat')
        const uTexFromMm = context.getUniformLocation(program, 'uTexFromMm')
        const uStatFromMm = context.getUniformLocation(program, 'uStatFromMm')
        const uDepth = context.getUniformLocation(program, 'uDepth')
        const uEquiv = context.getUniformLocation(program, 'uEquiv')
        context.uniform1i(uUseTexture, useTexture ? 1 : 0)
        if (useTexture) {
          context.uniform4f(
            uCmap, Number(overlayParams.lo), Number(overlayParams.hi),
            Number(overlayParams.threshold), Number(overlayParams.opacity),
          )
          context.uniform1i(uSign, Number(overlayParams.sign) || 0)
          context.uniform1i(uAlpha, Number(overlayParams.alpha) || 0)
          context.uniform1i(uPanes, Number(overlayParams.nPanes) || 0)
          context.uniform1f(uDepth, Number(overlayParams.depth) ?? 0.5)
          context.uniform1i(uEquiv, overlayParams.equivolume ? 1 : 0)
          const rowsToMat4 = rows => {
            const out = new Float32Array(16)
            for (let row = 0; row < 4; row += 1) {
              for (let col = 0; col < 4; col += 1) out[col * 4 + row] = rows[row][col]
            }
            return out
          }
          context.uniformMatrix4fv(uTexFromMm, false, rowsToMat4(overlayParams.texFromMm))
          context.uniformMatrix4fv(
            uStatFromMm, false,
            rowsToMat4(overlayParams.statFromMm || overlayParams.texFromMm),
          )
          const dims = overlayParams.dims
          const uploadVolumeTexture = (texture, data, unit) => {
            context.activeTexture(unit)
            context.bindTexture(context.TEXTURE_3D, texture)
            context.texParameteri(context.TEXTURE_3D, context.TEXTURE_MIN_FILTER, context.NEAREST)
            context.texParameteri(context.TEXTURE_3D, context.TEXTURE_MAG_FILTER, context.NEAREST)
            context.texParameteri(context.TEXTURE_3D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE)
            context.texParameteri(context.TEXTURE_3D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE)
            context.texParameteri(context.TEXTURE_3D, context.TEXTURE_WRAP_R, context.CLAMP_TO_EDGE)
            context.texImage3D(
              context.TEXTURE_3D, 0, context.R32F,
              dims[0], dims[1], dims[2], 0,
              context.RED, context.FLOAT, data,
            )
          }
          if (!overlayRef.current.valueTexture) {
            overlayRef.current.valueTexture = context.createTexture()
          }
          if (overlayRef.current.valueFor !== overlayRef.current.valueData) {
            uploadVolumeTexture(
              overlayRef.current.valueTexture, overlayRef.current.valueData, context.TEXTURE0,
            )
            overlayRef.current.valueFor = overlayRef.current.valueData
          }
          context.activeTexture(context.TEXTURE0)
          context.bindTexture(context.TEXTURE_3D, overlayRef.current.valueTexture)
          context.uniform1i(uVolume, 0)
          const hasStat = Boolean(overlayParams.hasStat && overlayRef.current.statData)
          context.uniform1i(uHasStat, hasStat ? 1 : 0)
          if (hasStat) {
            if (!overlayRef.current.statTexture) {
              overlayRef.current.statTexture = context.createTexture()
            }
            if (overlayRef.current.statFor !== overlayRef.current.statData) {
              uploadVolumeTexture(
                overlayRef.current.statTexture, overlayRef.current.statData, context.TEXTURE1,
              )
              overlayRef.current.statFor = overlayRef.current.statData
            }
            context.activeTexture(context.TEXTURE1)
            context.bindTexture(context.TEXTURE_3D, overlayRef.current.statTexture)
            context.uniform1i(uStat, 1)
          }
          const lut = overlayRef.current.lut
          if (lut) {
            if (!overlayRef.current.lutTexture) {
              overlayRef.current.lutTexture = context.createTexture()
            }
            const rgba = new Uint8Array(256 * 4)
            for (let index = 0; index < 256; index += 1) {
              rgba[index * 4] = lut[index * 3] || 0
              rgba[index * 4 + 1] = lut[index * 3 + 1] || 0
              rgba[index * 4 + 2] = lut[index * 3 + 2] || 0
              rgba[index * 4 + 3] = 255
            }
            context.activeTexture(context.TEXTURE2)
            context.bindTexture(context.TEXTURE_2D, overlayRef.current.lutTexture)
            context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST)
            context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST)
            context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE)
            context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE)
            context.texImage2D(
              context.TEXTURE_2D, 0, context.RGBA, 256, 1, 0,
              context.RGBA, context.UNSIGNED_BYTE, rgba,
            )
            context.uniform1i(uLut, 2)
          }
        }
        const aPos = context.getAttribLocation(program, 'aPos')
        const aNormal = context.getAttribLocation(program, 'aNormal')
        const aColor = context.getAttribLocation(program, 'aColor')
        const aWhite = context.getAttribLocation(program, 'aWhite')
        const aPial = context.getAttribLocation(program, 'aPial')
        const aAreas = context.getAttribLocation(program, 'aAreas')
        for (const buffer of meshRef.current.buffers) {
          const colors = colorsRef.current.get(buffer.hemi)
          if (!colors) continue
          const positions = buffer.displayPositions || buffer.positions
          const normals = buffer.displayNormals || buffer.normals
          let record = buffer.gl
          if (!record) {
            record = {
              position: context.createBuffer(), normal: context.createBuffer(),
              color: context.createBuffer(), faces: context.createBuffer(),
              white: context.createBuffer(), pial: context.createBuffer(), areas: context.createBuffer(),
            }
            buffer.gl = record
          }
          // Per-frame morph frames must refresh positions/normals, but faces and
          // colours are static: re-uploading 12+ MB of indices every frame made a
          // flatten feel frozen.
          if (buffer.displayPositions || record.positionsFor !== buffer.positions) {
            context.bindBuffer(context.ARRAY_BUFFER, record.position)
            context.bufferData(context.ARRAY_BUFFER, positions, context.DYNAMIC_DRAW)
            record.positionsFor = buffer.positions
            context.bindBuffer(context.ARRAY_BUFFER, record.normal)
            context.bufferData(context.ARRAY_BUFFER, normals, context.DYNAMIC_DRAW)
            record.normalsFor = buffer.normals
          }
          if (record.facesFor !== buffer.faces) {
            context.bindBuffer(context.ELEMENT_ARRAY_BUFFER, record.faces)
            context.bufferData(context.ELEMENT_ARRAY_BUFFER, buffer.faces, context.STATIC_DRAW)
            record.facesFor = buffer.faces
          }
          if (record.colorsFor !== colors) {
            context.bindBuffer(context.ARRAY_BUFFER, record.color)
            context.bufferData(context.ARRAY_BUFFER, colors, context.STATIC_DRAW)
            record.colorsFor = colors
          }
          if (useTexture && buffer.white && record.whiteFor !== buffer.white) {
            context.bindBuffer(context.ARRAY_BUFFER, record.white)
            context.bufferData(context.ARRAY_BUFFER, buffer.white, context.STATIC_DRAW)
            context.bindBuffer(context.ARRAY_BUFFER, record.pial)
            context.bufferData(context.ARRAY_BUFFER, buffer.pial, context.STATIC_DRAW)
            context.bindBuffer(context.ARRAY_BUFFER, record.areas)
            context.bufferData(context.ARRAY_BUFFER, buffer.areas, context.STATIC_DRAW)
            record.whiteFor = buffer.white
          }
          context.bindBuffer(context.ARRAY_BUFFER, record.position)
          context.enableVertexAttribArray(aPos)
          context.vertexAttribPointer(aPos, 3, context.FLOAT, false, 0, 0)
          context.bindBuffer(context.ARRAY_BUFFER, record.normal)
          context.enableVertexAttribArray(aNormal)
          context.vertexAttribPointer(aNormal, 3, context.FLOAT, false, 0, 0)
          context.bindBuffer(context.ARRAY_BUFFER, record.color)
          context.enableVertexAttribArray(aColor)
          context.vertexAttribPointer(aColor, 4, context.UNSIGNED_BYTE, true, 0, 0)
          if (useTexture && buffer.white) {
            context.bindBuffer(context.ARRAY_BUFFER, record.white)
            context.enableVertexAttribArray(aWhite)
            context.vertexAttribPointer(aWhite, 3, context.FLOAT, false, 0, 0)
            context.bindBuffer(context.ARRAY_BUFFER, record.pial)
            context.enableVertexAttribArray(aPial)
            context.vertexAttribPointer(aPial, 3, context.FLOAT, false, 0, 0)
            context.bindBuffer(context.ARRAY_BUFFER, record.areas)
            context.enableVertexAttribArray(aAreas)
            context.vertexAttribPointer(aAreas, 2, context.FLOAT, false, 0, 0)
          } else {
            context.disableVertexAttribArray(aWhite)
            context.disableVertexAttribArray(aPial)
            context.disableVertexAttribArray(aAreas)
          }
          context.bindBuffer(context.ELEMENT_ARRAY_BUFFER, record.faces)
          context.drawElements(context.TRIANGLES, buffer.faces.length, context.UNSIGNED_INT, 0)
        }
      }, [size])

      const startMorph = useCallback((oldBuffers, newBuffers, fromCamera, toCamera) => {
        if (morphRef.current) {
          if (morphRef.current.cancel) morphRef.current.cancel()
          morphRef.current = null
        }
        const fromByHemi = new Map(oldBuffers.map(buffer => [buffer.hemi, buffer]))
        const targetByHemi = new Map(newBuffers.map(buffer => [buffer.hemi, buffer]))
        const fromPositions = new Map()
        const fromNormals = new Map()
        for (const [hemi, buffer] of targetByHemi) {
          const old = fromByHemi.get(hemi)
          fromPositions.set(hemi, old ? (old.displayPositions || old.positions).slice() : buffer.positions.slice())
          fromNormals.set(hemi, old ? (old.displayNormals || old.normals).slice() : buffer.normals.slice())
        }
        for (const buffer of newBuffers) {
          buffer.displayPositions = new Float32Array(buffer.positions.length)
          buffer.displayNormals = new Float32Array(buffer.normals.length)
          const oldPositions = fromPositions.get(buffer.hemi)
          const oldNormals = fromNormals.get(buffer.hemi)
          if (oldPositions) buffer.displayPositions.set(oldPositions)
          if (oldNormals) buffer.displayNormals.set(oldNormals)
        }
        drawSurface()
        const duration = 450
        const started = performance.now()
        const fromTarget = [...fromCamera.target]
        const toTarget = [...toCamera.target]
        let frameId = 0
        const tick = (now) => {
          const linear = Math.min(1, Math.max(0, (now - started) / duration))
          const t = easeInOutCubic(linear)
          for (const buffer of newBuffers) {
            const oldPositions = fromPositions.get(buffer.hemi)
            const oldNormals = fromNormals.get(buffer.hemi)
            if (!oldPositions || !oldNormals) continue
            for (let index = 0; index < buffer.positions.length; index += 1) {
              buffer.displayPositions[index] = oldPositions[index] + (buffer.positions[index] - oldPositions[index]) * t
            }
            for (let index = 0; index < buffer.normals.length; index += 1) {
              buffer.displayNormals[index] = oldNormals[index] + (buffer.normals[index] - oldNormals[index]) * t
            }
          }
          if (cameraRef.current) {
            cameraRef.current.distance = fromCamera.distance * Math.pow(toCamera.distance / fromCamera.distance, t)
            cameraRef.current.target = fromTarget.map((value, index) => value + (toTarget[index] - value) * t)
          }
          drawSurface()
          if (linear < 1) {
            frameId = window.requestAnimationFrame(tick)
          } else {
            for (const buffer of newBuffers) {
              buffer.displayPositions = null
              buffer.displayNormals = null
            }
            if (cameraRef.current) {
              cameraRef.current.distance = toCamera.distance
              cameraRef.current.target = [...toCamera.target]
            }
            morphRef.current = null
            drawSurface()
          }
        }
        morphRef.current = {
          cancel: () => {
            if (frameId) window.cancelAnimationFrame(frameId)
          },
        }
        frameId = window.requestAnimationFrame(tick)
      }, [drawSurface])

      useEffect(() => { drawSurface() }, [frame, size, drawSurface])

      const toNdc = (event) => {
        const canvas = canvasRef.current
        const rect = canvas.getBoundingClientRect()
        const x = (event.clientX - rect.left) / rect.width
        const y = (event.clientY - rect.top) / rect.height
        return { xNdc: x * 2 - 1, yNdc: 1 - y * 2, aspect: rect.width / Math.max(rect.height, 1) }
      }
      const onPointerDown = (event) => {
        const camera = cameraRef.current
        if (!camera) return
        let mode = 'orbit'
        if (event.button === 2) mode = 'zoom'
        else if (event.button === 1 || (event.button === 0 && event.shiftKey)) mode = 'pan'
        else if (event.button !== 0) return
        if (mode === 'zoom') event.preventDefault()
        dragRef.current = { mode, x: event.clientX, y: event.clientY, moved: false, seed: event.ctrlKey || event.metaKey }
        event.currentTarget.setPointerCapture(event.pointerId)
      }
      const onPointerMove = (event) => {
        const record = dragRef.current
        if (!record) return
        const camera = cameraRef.current
        if (!camera) return
        const px = event.clientX - record.x
        const py = event.clientY - record.y
        const scale = Math.max(size.height, 1)
        if (Math.abs(px) + Math.abs(py) > 2) record.moved = true
        if (record.mode === 'pan') cameraPan(camera, px / scale, py / scale)
        else if (record.mode === 'zoom') cameraZoom(camera, Math.exp(py / 150))
        else cameraOrbit(camera, (px / scale) * 2 * Math.PI, (py / scale) * 2 * Math.PI)
        record.x = event.clientX
        record.y = event.clientY
        drawSurface()
      }
      const onPointerUp = (event) => {
        const record = dragRef.current
        dragRef.current = null
        if (!record || record.moved) return
        const ndc = toNdc(event)
        const action = record.seed ? 'seed' : 'crosshair'
        run('surface_pick', { view: vp.id, ...ndc, camera: cameraRef.current, action }).catch(err => {
          if (err.code !== 'pick-miss') setError(err.message)
        })
      }
      useEffect(() => {
        const element = wrapRef.current
        if (!element) return undefined
        const wheel = (event) => {
          event.preventDefault()
          const camera = cameraRef.current
          if (!camera) return
          const steps = -event.deltaY / 120
          cameraZoom(camera, 0.9 ** steps)
          drawSurface()
        }
        element.addEventListener('wheel', wheel, { passive: false })
        return () => element.removeEventListener('wheel', wheel)
      }, [drawSurface])
      const layerNote = frame?.layer || {}
      return h('div', { className: 'ffs-canvas-wrap', ref: wrapRef },
        morphing ? h('div', { className: 'ffs-canvas-pending' }, `morphing to ${vp.shape}…`) : null,
        h('canvas', {
          ref: canvasRef,
          onPointerDown, onPointerMove, onPointerUp, onPointerCancel: () => { dragRef.current = null },
          onContextMenu: event => event.preventDefault(),
        }),
        error ? h('div', { className: 'ffs-error', style: { position: 'absolute', left: 8, right: 8, top: 8 } }, error) : null,
        h('div', { style: { position: 'absolute', left: 6, bottom: 4, color: 'rgba(255,255,255,.65)', fontSize: 10, pointerEvents: 'none' } },
          `${frame ? `${frame.hemis.join('+')} · ${frame.shape} · ${layerNote.mode || 'folding'}` : 'no surfaces'} · click to pick · drag to orbit · shift-drag to pan · wheel to zoom`),
      )
    }

    // ------------------------------------------------------------------ series pane
    function SeriesPane({ vp, snapshot, dispatch, run }) {
      const wrapRef = useRef(null)
      const canvasRef = useRef(null)
      const [frame, setFrame] = useState(null)
      const [size, setSize] = useState({ width: 1, height: 1 })
      const [error, setError] = useState(null)
      const tokenRef = useRef(null)
      const [hidden, setHidden] = useState(new Set(vp.hidden || []))
      const scrubRef = useRef({ active: false, busy: false, wanted: null, sent: null, frame: 0 })

      useEffect(() => {
        if (!wrapRef.current) return
        const observer = new ResizeObserver(entries => {
          const rect = entries[0].contentRect
          setSize({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) })
        })
        observer.observe(wrapRef.current)
        return () => observer.disconnect()
      }, [])

      useEffect(() => {
        let cancelled = false
        const token = `${vp.id}:${vp.gridN}:${vp.traces}:${vp.hidden}:${vp.sharedScale}:${vp.detrend}:${vp.plane}:${vp.tint}:${snapshot.timeIndex}:${snapshot.crosshair.join(',')}:${snapshot.revByCategory?.source || 0}:${snapshot.revByCategory?.analysis || 0}:${layerSignature(snapshot.layers)}`
        if (tokenRef.current === token) return
        tokenRef.current = token
        run('series', { view: vp.id }).then(result => {
          if (cancelled) return
          setError(null); setFrame(result); setHidden(new Set(vp.hidden || []))
        }).catch(err => { if (!cancelled) { setError(err.message); tokenRef.current = null } })
        return () => { cancelled = true }
      }, [vp, snapshot.rev, run])

      useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas || !frame) return
        const dpr = window.devicePixelRatio || 1
        const width = size.width
        const height = size.height
        canvas.width = Math.round(width * dpr)
        canvas.height = Math.round(height * dpr)
        const ctx = canvas.getContext('2d')
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, width, height)
        ctx.fillStyle = '#0b0d10'
        ctx.fillRect(0, 0, width, height)
        const n = frame.gridN || 1
        const cells = frame.cells || []
        if (!cells.length) {
          ctx.fillStyle = 'rgba(255,255,255,.6)'
          ctx.font = '11px ui-sans-serif'
          ctx.fillText('No time series: load a 4-D run', 10, 22)
          return
        }
        const gap = 4
        const cellW = (width - gap * (n + 1)) / n
        const cellH = (height - gap * (n + 1)) / n
        const drawable = cells.map(cell => ({
          cell,
          traces: cell.traces.filter(trace => !hidden.has(trace.key)),
        }))
        let lo = Infinity
        let hi = -Infinity
        if (frame.sharedScale) {
          for (const item of drawable) for (const trace of item.traces) for (const value of trace.values) {
            if (!Number.isFinite(value)) continue
            lo = Math.min(lo, value); hi = Math.max(hi, value)
          }
        }
        for (let row = 0; row < n; row += 1) {
          for (let col = 0; col < n; col += 1) {
            const item = drawable[row * n + col]
            if (!item) continue
            const x = gap + col * (cellW + gap)
            const y = gap + row * (cellH + gap)
            if (item.cell.tint) {
              ctx.fillStyle = `rgba(${Math.round(item.cell.tint[0] * 255)},${Math.round(item.cell.tint[1] * 255)},${Math.round(item.cell.tint[2] * 255)},.18)`
              ctx.fillRect(x, y, cellW, cellH)
            }
            ctx.strokeStyle = item.cell.centre ? 'rgba(122,162,247,.75)' : 'rgba(255,255,255,.12)'
            ctx.lineWidth = item.cell.centre ? 1.2 : 1
            ctx.strokeRect(x + .5, y + .5, cellW - 1, cellH - 1)
            let cl = lo
            let ch = hi
            if (!Number.isFinite(cl) || !Number.isFinite(ch) || ch - cl < 1e-6) {
              cl = Infinity; ch = -Infinity
              for (const trace of item.traces) for (const value of trace.values) {
                if (!Number.isFinite(value)) continue
                cl = Math.min(cl, value); ch = Math.max(ch, value)
              }
              if (!Number.isFinite(cl)) { cl = -1; ch = 1 }
            }
            const pad = (ch - cl) * 0.08 || 0.5
            cl -= pad; ch += pad
            const toY = value => y + cellH - ((value - cl) / Math.max(ch - cl, 1e-9)) * cellH
            const maxLen = Math.max(1, ...item.traces.map(trace => trace.values.length))
            const toX = index => x + (index / Math.max(maxLen - 1, 1)) * cellW
            item.traces.forEach((trace, traceIndex) => {
              ctx.strokeStyle = SERIES_COLORS[traceIndex % SERIES_COLORS.length]
              ctx.lineWidth = item.cell.centre ? 1.1 : 0.8
              ctx.beginPath()
              const step = Math.max(1, Math.ceil(trace.values.length / Math.max(40, cellW)))
              for (let i = 0; i < trace.values.length; i += step) {
                const value = trace.values[i]
                if (!Number.isFinite(value)) continue
                const px = toX(i), py = toY(value)
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
              }
              ctx.stroke()
            })
            // Time cursor
            if (frame.timeIndex != null && maxLen > 1) {
              const cx = toX(clamp(frame.timeIndex, 0, maxLen - 1))
              ctx.strokeStyle = 'rgba(247,118,142,.9)'
              ctx.beginPath(); ctx.moveTo(cx, y + 2); ctx.lineTo(cx, y + cellH - 2); ctx.stroke()
            }
            ctx.fillStyle = 'rgba(255,255,255,.48)'
            ctx.font = '9px ui-monospace, monospace'
            ctx.fillText(`[${item.cell.ijk.join(',')}]`, x + 4, y + 11)
          }
        }
      }, [frame, size, hidden])

      const indexAt = (clientX) => {
        const canvas = canvasRef.current
        if (!canvas || !frame) return null
        const rect = canvas.getBoundingClientRect()
        const fraction = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1)
        return Math.round(fraction * Math.max(frame.maxTimeIndex || 0, 0))
      }
      const sendIndex = (index) => {
        const scrub = scrubRef.current
        if (index == null) return
        scrub.wanted = index
        if (scrub.busy) return
        const pump = () => {
          const next = scrub.wanted
          scrub.wanted = null
          if (next == null || next === scrub.sent) { scrub.busy = false; return }
          scrub.busy = true
          scrub.sent = next
          run('execute', { line: `SET_INDEX ${next}` }, null, { quiet: true })
            .catch(() => {})
            .finally(() => {
              scrub.busy = false
              if (scrub.wanted != null) pump()
            })
        }
        pump()
      }
      const scheduleIndex = (index) => {
        const scrub = scrubRef.current
        scrub.wanted = index
        if (scrub.frame) return
        scrub.frame = requestAnimationFrame(() => {
          scrub.frame = 0
          sendIndex(scrub.wanted)
        })
      }
      const onPointerDown = (event) => {
        if (!frame || event.button !== 0) return
        event.preventDefault()
        const index = indexAt(event.clientX)
        if (index == null) return
        const scrub = scrubRef.current
        scrub.active = true
        scrub.sent = frame.timeIndex
        event.currentTarget.setPointerCapture(event.pointerId)
        sendIndex(index)
      }
      const onPointerMove = (event) => {
        const scrub = scrubRef.current
        if (!scrub.active) return
        scheduleIndex(indexAt(event.clientX))
      }
      const onPointerUp = (event) => {
        const scrub = scrubRef.current
        if (!scrub.active) return
        scrub.active = false
        if (scrub.frame) { cancelAnimationFrame(scrub.frame); scrub.frame = 0 }
        sendIndex(indexAt(event.clientX))
        try { event.currentTarget.releasePointerCapture(event.pointerId) } catch (error) { /* already released */ }
      }
      const toggle = (key) => {
        const next = new Set(hidden)
        if (next.has(key)) next.delete(key); else next.add(key)
        setHidden(next)
        dispatch(`SET_VIEW_HIDDEN ${vp.id} ${[...next].join(',') || '-'}`)
      }
      const entries = frame?.entries || []
      return h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
        entries.length ? h('div', { className: 'ffs-legend' },
          entries.map((entry, index) => h('button', { key: entry.ident, onClick: () => toggle(entry.ident), style: { opacity: hidden.has(entry.ident) ? .4 : 1 } },
            h('span', { className: 'ffs-swatch', style: { background: SERIES_COLORS[index % SERIES_COLORS.length] } }),
            entry.label,
          )),
        ) : null,
        h('div', { className: 'ffs-canvas-wrap', ref: wrapRef },
          h('canvas', {
            ref: canvasRef,
            style: { cursor: 'ew-resize', touchAction: 'none' },
            onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp,
          }),
          error ? h('div', { className: 'ffs-error', style: { position: 'absolute', left: 8, right: 8, top: 8 } }, error) : null,
          h('div', { style: { position: 'absolute', right: 6, bottom: 4, color: 'rgba(255,255,255,.55)', fontSize: 10, pointerEvents: 'none' } },
            `t ${frame?.timeIndex ?? '--'}/${frame?.maxTimeIndex ?? '--'} · drag/click to scrub${frame?.secondsPerPoint ? ` · TR ${frame.secondsPerPoint}s` : ''}`),
        ),
      )
    }

    // ------------------------------------------------------------------ control rail
    function useCoalesced(dispatch, delay = 70) {
      const queue = useRef(null)
      const timer = useRef(null)
      useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
      return useCallback((line) => {
        queue.current = line
        if (timer.current) return
        timer.current = setTimeout(() => {
          timer.current = null
          const value = queue.current
          queue.current = null
          if (value) dispatch(value)
        }, delay)
      }, [delay, dispatch])
    }

    function RangeField({ layer, set }) {
      const [lo, setLo] = useState(layer.rangeLo)
      const [hi, setHi] = useState(layer.rangeHi)
      useEffect(() => {
        setLo(layer.rangeLo)
        setHi(layer.rangeHi)
      }, [layer.key, layer.rangeLo, layer.rangeHi])
      const commit = () => {
        const a = Number(lo)
        const b = Number(hi)
        if (Number.isFinite(a) && Number.isFinite(b) && a !== b) set(`SET_RANGE ${layer.key} ${a} ${b}`)
        else {
          setLo(layer.rangeLo)
          setHi(layer.rangeHi)
        }
      }
      const input = (value, onChange) => h('input', {
        type: 'number', step: 'any', value: value == null ? '' : value,
        className: 'ffs-number-field',
        onChange: e => onChange(e.target.value),
        onBlur: commit,
        onKeyDown: e => { if (e.key === 'Enter') { e.currentTarget.blur() } },
      })
      return h('span', { className: 'ffs-row' }, input(lo, setLo), input(hi, setHi))
    }

    function ThresholdInput({ layer, disabled, onCommit }) {
      const [value, setValue] = useState(Math.abs(Number(layer.threshold) || 0))
      useEffect(() => {
        setValue(Math.abs(Number(layer.threshold) || 0))
      }, [layer.key, layer.threshold])
      const commit = () => {
        const next = Number(value)
        if (Number.isFinite(next) && next >= 0) onCommit(next)
        else setValue(Math.abs(Number(layer.threshold) || 0))
      }
      return h('input', {
        type: 'number', step: 'any', min: 0, className: 'ffs-number-field ffs-threshold-input',
        value: Number.isFinite(Number(value)) ? value : '',
        disabled,
        onChange: event => setValue(event.target.value),
        onBlur: commit,
        onKeyDown: event => { if (event.key === 'Enter') event.currentTarget.blur() },
      })
    }

    function ColorBar({ layer, run, set, setSoon }) {
      const [colors, setColors] = useState(null)
      const barRef = useRef(null)
      const dragRef = useRef(null)
      const token = `${layer.colormap || 'gray'}:${layer.colormapReversed ? 1 : 0}`
      const tokenRef = useRef(null)
      useEffect(() => {
        if (tokenRef.current === token) return
        tokenRef.current = token
        run('colorbar', {
          colormap: layer.colormap || 'gray', n: 48, reverse: Boolean(layer.colormapReversed),
        }, null, { quiet: true }).then(result => {
          if (result && result.colors) setColors(result.colors)
        }).catch(() => { tokenRef.current = null })
      }, [token, layer.colormap, layer.colormapReversed, run])
      const lo = Number(layer.rangeLo ?? 0)
      const hi = Number(layer.rangeHi ?? 1)
      const span = hi - lo
      const threshold = Math.abs(Number(layer.threshold) || 0)
      const inRange = span > 0 && threshold > lo && threshold < hi
      const marker = inRange ? clamp((threshold - lo) / span, 0, 1) : null
      const gradient = colors && colors.length
        ? `linear-gradient(90deg, ${colors.map((color, index) => `rgb(${color[0]},${color[1]},${color[2]}) ${(index / Math.max(colors.length - 1, 1)) * 100}%`).join(', ')})`
        : 'linear-gradient(90deg, #222, #888)'
      const startDrag = (event, mode) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        const bar = barRef.current
        if (!bar) return
        bar.setPointerCapture(event.pointerId)
        dragRef.current = { mode, lo, hi, span }
        const move = (moveEvent) => {
          const record = dragRef.current
          if (!record) return
          const rect = bar.getBoundingClientRect()
          const fraction = clamp((moveEvent.clientX - rect.left) / Math.max(1, rect.width), 0, 1)
          const value = record.lo + fraction * record.span
          if (record.mode === 'lo') {
            const nextLo = Math.min(value, record.hi - record.span * 1e-4)
            setSoon(`SET_RANGE ${layer.key} ${nextLo.toFixed(6)} ${record.hi.toFixed(6)}`)
          } else if (record.mode === 'hi') {
            const nextHi = Math.max(value, record.lo + record.span * 1e-4)
            setSoon(`SET_RANGE ${layer.key} ${record.lo.toFixed(6)} ${nextHi.toFixed(6)}`)
          } else {
            setSoon(`SET_THRESHOLD ${layer.key} ${Math.abs(value).toFixed(6)}`)
          }
        }
        const up = (upEvent) => {
          dragRef.current = null
          bar.removeEventListener('pointermove', move)
          bar.removeEventListener('pointerup', up)
          bar.removeEventListener('pointercancel', up)
          try { bar.releasePointerCapture(upEvent.pointerId) } catch (error) { /* released */ }
        }
        bar.addEventListener('pointermove', move)
        bar.addEventListener('pointerup', up)
        bar.addEventListener('pointercancel', up)
        move(event)
      }
      return h('div', { className: 'ffs-colorbar-wrap' },
        h('div', {
          className: 'ffs-colorbar', ref: barRef,
          style: { background: gradient },
          title: 'Drag the end handles for range; click/drag the bar for threshold',
          onPointerDown: event => startDrag(event, 'threshold'),
        },
          marker != null ? h('span', {
            className: 'ffs-colorbar-thr', style: { left: `${marker * 100}%` },
            title: `threshold ${threshold}`,
            onPointerDown: event => startDrag(event, 'threshold'),
          }) : null,
          h('span', {
            className: 'ffs-colorbar-handle lo', title: `range min ${fmt(lo, 3)}`,
            onPointerDown: event => startDrag(event, 'lo'),
          }),
          h('span', {
            className: 'ffs-colorbar-handle hi', title: `range max ${fmt(hi, 3)}`,
            onPointerDown: event => startDrag(event, 'hi'),
          }),
        ),
        h('div', { className: 'ffs-colorbar-labels' },
          h('span', null, fmt(lo, 2)),
          h('span', null, fmt(hi, 2)),
        ),
      )
    }

    function ControlRail({ snapshot, dispatch, run, busy, t, onOpenPicker, onClose }) {
      // Hooks must run unconditionally: the rail renders once before the first
      // snapshot arrives, and a hook after an early return changes hook order.
      const setSoon = useCoalesced(dispatch)
      const [closed, setClosed] = useState(() => new Set())
      const [advanced, setAdvanced] = useState(false)
      const [pathTip, setPathTip] = useState(null)
      const [thresholdMemory, setThresholdMemory] = useState(2.5)
      useEffect(() => {
        if (!snapshot) return
        const layer = snapshot.layers.find(item => item.key === snapshot.selected)
        const value = layer ? Math.abs(Number(layer.threshold) || 0) : 0
        if (value > 0) setThresholdMemory(previous => Math.abs(previous - value) < 1e-9 ? previous : value)
      }, [snapshot])
      if (!snapshot) return h('div', { className: 'ffs-rail' }, h('div', { className: 'ffs-hint', style: { padding: 10 } }, 'Loading…'))
      const selected = snapshot.layers.find(layer => layer.key === snapshot.selected) || snapshot.layers[snapshot.layers.length - 1]
      const thresholdOn = selected ? Math.abs(Number(selected.threshold) || 0) > 1e-9 : false
      const thresholdMax = selected ? Math.max(0.01, selected.rangeHi != null ? Math.abs(selected.rangeHi) : 10) : 10
      const brickLabels = selected && Array.isArray(selected.labels) ? selected.labels : []
      const showBricks = Boolean(selected && selected.nVolumes > 1 && (brickLabels.length || selected.nVolumes <= 16))
      const brickLabel = index => brickLabels[index] || `vol ${index}`
      const followMode = selected?.thresholdFollow || 'same'
      const thresholdBrickValue = selected && selected.thresholdIndex != null
        ? `i:${selected.thresholdIndex}` : `f:${followMode}`
      const set = (line) => dispatch(line)
      const unload = (layer) => dispatch(`REMOVE_LAYER ${layer.key}`)
      const toggle = (id) => setClosed(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      const card = (id, title, count, ...body) => h('section', { className: 'ffs-card' },
        h('button', {
          type: 'button', className: 'ffs-card-head', 'aria-expanded': !closed.has(id),
          onClick: () => toggle(id),
        },
          h('span', { className: `ffs-chevron${closed.has(id) ? '' : ' open'}` }, '›'),
          h('span', { className: 'ffs-card-title' }, title),
          count != null ? h('span', { className: 'ffs-card-count' }, count) : null,
        ),
        closed.has(id) ? null : h('div', { className: 'ffs-card-body' }, body),
      )
      const slider = (label, value, min, max, step, line) => h('label', { className: 'ffs-control' },
        h('span', { className: 'ffs-control-head' },
          h('span', null, label),
          h('span', { className: 'ffs-control-value' }, value),
        ),
        h('input', {
          type: 'range', min, max, step, value,
          onChange: event => setSoon(`${line} ${event.target.value}`),
        }),
      )
      const copyPath = (event, text) => {
        event.stopPropagation()
        const full = String(text || '')
        setPathTip(full)
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(full).then(() => setPathTip(`Copied · ${full}`)).catch(() => {})
        }
      }
      const layerRows = snapshot.layers.map(layer => h('div', {
        key: layer.key,
        className: `ffs-layer-row${layer.key === snapshot.selected ? ' active' : ''}`,
        title: 'Hover for the full filename; double-click to copy it',
        onMouseEnter: () => setPathTip(layer.path || layer.name),
        onMouseLeave: () => setPathTip(null),
        onDoubleClick: event => copyPath(event, layer.path || layer.name),
        onClick: () => set(`SELECT_LAYER ${layer.key}`),
      },
        h('button', {
          type: 'button',
          className: 'ffs-eye',
          title: layer.visible ? 'Hide layer' : 'Show layer',
          onClick: event => { event.stopPropagation(); set(`SET_LAYER_VISIBLE ${layer.key} ${layer.visible ? 0 : 1}`) },
        }, layer.visible ? '◉' : '○'),
        h('span', { className: 'ffs-swatch', style: { background: colorFor(layer.colormap) } }),
        h('span', { className: 'ffs-layer-main' },
          h('span', { className: 'ffs-layer-name' }, middleTruncate(layer.name)),
          h('span', { className: 'ffs-layer-sub' }, `${layer.key}${layer.nVolumes > 1 ? ` · ${layer.nVolumes} vols` : ''}${layer.thresholdIndex != null ? ' · stats' : ''}`),
        ),
        h('button', {
          type: 'button', className: 'ffs-eye ffs-unload', title: `Unload ${layer.key} from the viewer`,
          onClick: event => { event.stopPropagation(); unload(layer) },
        }, '⏏'),
      ))
      return h('div', { className: 'ffs-rail' },
        h('div', { className: 'ffs-rail-head' },
          h('div', null,
            h('div', { className: 'ffs-eyebrow' }, 'FFS'),
            h('strong', { className: 'ffs-rail-title' }, 'Controls'),
          ),
          h('button', {
            type: 'button', className: 'ffs-btn ffs-primary', disabled: busy,
            title: t ? t('openData') : 'Data sources',
            onClick: onOpenPicker,
          }, h('span', { 'aria-hidden': true }, '＋'), ' Data'),
          onClose ? h('button', {
            type: 'button', className: 'ffs-btn icon', title: 'Close controls',
            onClick: onClose,
          }, '✕') : null,
        ),
        h('div', { className: 'ffs-rail-scroll' },
          card('layers', 'Layers', snapshot.layers.length,
            snapshot.layers.length
              ? layerRows
              : h('div', { className: 'ffs-empty-note' }, 'No datasets loaded. Use Data to add a folder and load a scan.'),
          ),
          selected ? card('display', 'Display', selected.key,
            h('div', { className: 'ffs-selected-head' },
              h('span', { className: 'ffs-swatch', style: { background: colorFor(selected.colormap) } }),
              h('span', {
                className: 'ffs-selected-name',
                title: 'Hover for the full filename; double-click to copy it',
                onMouseEnter: () => setPathTip(selected.path || selected.name),
                onMouseLeave: () => setPathTip(null),
                onDoubleClick: event => copyPath(event, selected.path || selected.name),
              }, middleTruncate(selected.name, 34)),
              h('span', { className: 'ffs-key' }, selected.key),
              h('button', {
                type: 'button', className: 'ffs-btn', style: { padding: '0 5px', fontSize: 10 },
                title: `Unload ${selected.key} from the viewer`,
                onClick: () => unload(selected),
              }, 'Unload'),
            ),
            showBricks ? h('div', { className: 'ffs-control' },
              h('span', { className: 'ffs-control-head' }, h('span', null, 'OLAY · shown sub-brick')),
              h('select', {
                className: 'ffs-select', value: String(selected.volumeIndex ?? 0),
                onChange: event => set(`SET_VOLUME ${selected.key} ${event.target.value}`),
              }, Array.from({ length: selected.nVolumes }, (_, index) => h('option', {
                key: index, value: String(index),
              }, `${index}: ${brickLabel(index)}`))),
            ) : null,
            showBricks ? h('div', { className: 'ffs-control' },
              h('span', { className: 'ffs-control-head' }, h('span', null, 'THR ON · threshold sub-brick')),
              h('select', {
                className: 'ffs-select', value: thresholdBrickValue,
                onChange: event => {
                  const value = event.target.value
                  if (value.startsWith('f:')) set(`SET_THRESHOLD_FOLLOW ${selected.key} ${value.slice(2)}`)
                  else set(`SET_THRESHOLD_INDEX ${selected.key} ${value.slice(2)}`)
                },
              },
                h('option', { value: 'f:same' }, 'Follow OLAY (same)'),
                h('option', { value: 'f:next' }, 'Follow +1 sub-brick'),
                h('option', { value: 'f:next2' }, 'Follow +2 sub-bricks'),
                h('option', { value: 'f:fixed' }, 'Keep current threshold brick'),
                Array.from({ length: selected.nVolumes }, (_, index) => h('option', {
                  key: `b${index}`, value: `i:${index}`,
                }, `Fixed: ${index}: ${brickLabel(index)}`)),
              ),
            ) : null,
            slider('Opacity', fmt(selected.opacity ?? 1, 2), 0, 1, 0.05, `SET_LAYER_OPACITY ${selected.key}`),
            h('label', { className: 'ffs-control' },
              h('span', { className: 'ffs-control-head' },
                h('span', { className: 'ffs-row', style: { gap: 4 } },
                  h('input', {
                    type: 'checkbox', checked: thresholdOn,
                    onChange: event => set(event.target.checked
                      ? `SET_THRESHOLD ${selected.key} ${thresholdMemory}`
                      : `SET_THRESHOLD ${selected.key} 0`),
                  }),
                  'Threshold',
                ),
                h(ThresholdInput, {
                  layer: selected, disabled: !thresholdOn,
                  onCommit: value => {
                    if (value > 0) setThresholdMemory(value)
                    set(`SET_THRESHOLD ${selected.key} ${value}`)
                  },
                }),
              ),
              h('input', {
                type: 'range', min: 0, max: thresholdMax, step: 0.05,
                value: Math.min(Math.abs(Number(selected.threshold) || 0), thresholdMax),
                disabled: !thresholdOn,
                onChange: event => {
                  const value = Number(event.target.value)
                  if (value > 0) setThresholdMemory(value)
                  setSoon(`SET_THRESHOLD ${selected.key} ${value}`)
                },
              }),
            ),
            h('div', { className: 'ffs-control' },
              h('span', { className: 'ffs-control-head' }, h('span', null, 'Colormap')),
              h('select', {
                className: 'ffs-select', value: selected.colormap || 'gray',
                onChange: event => set(`SET_COLORMAP ${selected.key} ${event.target.value}`),
              }, ['gray', 'hot', 'cool', 'redblue', 'RdBu', 'RdYlBu', 'viridis', 'plasma', 'inferno', 'magma', 'cividis', 'turbo', 'spectrum', 'hsv', 'twilight', 'red', 'twilight_shifted'].map(name => h('option', { key: name, value: name }, name)))),
            h('div', { className: 'ffs-control' },
              h('span', { className: 'ffs-control-head' },
                h('span', null, 'Range'),
                h('button', {
                  type: 'button', className: 'ffs-mini',
                  title: 'Auto-range this layer from its shown volume or sub-brick',
                  onClick: () => run('auto_range', { key: selected.key }, null, { quiet: true }).catch(() => {}),
                }, 'Auto'),
              ),
              h(RangeField, { layer: selected, set }),
              h(ColorBar, { layer: selected, run, set, setSoon }),
            ),
            h('div', { className: 'ffs-control' },
              h('span', { className: 'ffs-control-head' }, h('span', null, 'Sign')),
              h('div', { className: 'ffs-seg' },
                [['both', 'Both'], ['pos', 'Pos'], ['neg', 'Neg']].map(([value, label]) => h('button', {
                  key: value, type: 'button', className: selected.signMode === value ? 'active' : '',
                  onClick: () => set(`SET_SIGN ${selected.key} ${value}`),
                }, label)),
              ),
            ),
            h('button', {
              type: 'button', className: 'ffs-advanced-toggle', 'aria-expanded': advanced,
              onClick: () => setAdvanced(value => !value),
            }, advanced ? 'Hide advanced' : 'Advanced'),
            advanced ? h(React.Fragment, null,
              h('div', { className: 'ffs-control' },
                h('span', { className: 'ffs-control-head' }, h('span', null, 'Resample')),
                h('select', {
                  className: 'ffs-select', value: selected.resample || 'auto',
                  onChange: event => set(`SET_RESAMPLE ${selected.key} ${event.target.value}`),
                }, ['auto', 'nearest', 'linear', 'cubic'].map(value => h('option', { key: value, value }, value))),
              ),
              h('div', { className: 'ffs-control' },
                h('span', { className: 'ffs-control-head' }, h('span', null, 'Sub-threshold')),
                h('select', {
                  className: 'ffs-select', value: selected.alphaMode,
                  onChange: event => set(`SET_ALPHA ${selected.key} ${event.target.value}`),
                }, ['off', 'linear', 'quadratic'].map(value => h('option', { key: value, value }, value))),
              ),
              h('label', { className: 'ffs-check-row' },
                h('input', { type: 'checkbox', checked: selected.boxed, onChange: event => set(`SET_BOXED ${selected.key} ${event.target.checked ? 1 : 0}`) }),
                'Boxed values',
              ),
              h('div', { className: 'ffs-row', style: { flexWrap: 'wrap', gap: 8 } },
                h('label', { className: 'ffs-check-row' },
                  h('input', { type: 'checkbox', checked: selected.rangeMirror, onChange: event => set(`SET_RANGE_MIRROR ${selected.key} ${event.target.checked ? 1 : 0}`) }),
                  'Mirror range',
                ),
                h('label', { className: 'ffs-check-row' },
                  h('input', { type: 'checkbox', checked: selected.rangeFixed, onChange: event => set(`SET_RANGE_FIXED ${selected.key} ${event.target.checked ? 1 : 0}`) }),
                  'Fixed range',
                ),
                h('label', { className: 'ffs-check-row' },
                  h('input', { type: 'checkbox', checked: selected.colormapReversed, onChange: event => set(`SET_COLORMAP_REVERSED ${selected.key} ${event.target.checked ? 1 : 0}`) }),
                  'Reverse',
                ),
                h('label', { className: 'ffs-check-row' },
                  h('input', { type: 'checkbox', checked: selected.edges, onChange: event => set(`SET_EDGES ${selected.key} ${event.target.checked ? 1 : 0}`) }),
                  'Edges',
                ),
                h('label', { className: 'ffs-check-row' },
                  h('input', { type: 'checkbox', checked: selected.timeLinked, onChange: event => set(`SET_TIME_LINKED ${selected.key} ${event.target.checked ? 1 : 0}`) }),
                  'Time-linked',
                ),
              ),
              selected.timeLinked && selected.nVolumes > 1 ? h('div', { className: 'ffs-control' },
                h('span', { className: 'ffs-control-head' }, h('span', null, 'Time view')),
                h('div', { className: 'ffs-row' },
                  h('select', {
                    className: 'ffs-select', value: String(selected.timeDetrend ?? -1),
                    onChange: event => set(`SET_LAYER_TIME_VIEW ${selected.key} ${event.target.value} ${selected.timePsc ? 1 : 0}`),
                  }, [[-1, 'Raw'], [0, 'Mean'], [1, 'Linear'], [2, 'Quadratic'], [3, 'Cubic']].map(([value, label]) => h('option', { key: value, value: String(value) }, label))),
                  h('label', { className: 'ffs-check-row' },
                    h('input', {
                      type: 'checkbox', checked: Boolean(selected.timePsc),
                      onChange: event => set(`SET_LAYER_TIME_VIEW ${selected.key} ${selected.timeDetrend ?? -1} ${event.target.checked ? 1 : 0}`),
                    }),
                    'PSC',
                  ),
                ),
              ) : null,
            ) : null,
          ) : null,
          snapshot.maxTimeIndex > 0 ? card('time', 'Time', null,
            h('div', { className: 'ffs-time' },
              h('button', { type: 'button', className: 'ffs-step', title: 'Previous volume', onClick: () => set(`SET_INDEX ${Math.max(0, snapshot.timeIndex - 1)}`) }, '◀'),
              h('input', {
                type: 'range', min: 0, max: snapshot.maxTimeIndex, value: snapshot.timeIndex,
                style: { flex: 1, accentColor: TOKENS.brand },
                onChange: event => setSoon(`SET_INDEX ${event.target.value}`),
              }),
              h('button', { type: 'button', className: 'ffs-step', title: 'Next volume', onClick: () => set(`SET_INDEX ${Math.min(snapshot.maxTimeIndex, snapshot.timeIndex + 1)}`) }, '▶'),
            ),
            h('div', { className: 'ffs-time-read' }, `t ${snapshot.timeIndex} / ${snapshot.maxTimeIndex}`),
          ) : null,
          card('crosshair', 'Navigate', null,
            h('div', { className: 'ffs-code' },
              h('div', null, `ijk  ${snapshot.crosshair.join(', ')}`),
              h('div', null, `mm   ${fmtMm(snapshot.crosshairMm)}`),
            ),
            h('div', { className: 'ffs-row' },
              h('button', { type: 'button', className: 'ffs-btn', title: 'Jump back', onClick: () => set('JUMP_BACK') }, '↩ Jump back'),
              h('button', { type: 'button', className: 'ffs-btn', title: 'Inspect seed (InstaCorr)', onClick: () => set(`SET_SEED ${snapshot.crosshair.join(' ')}`) }, '◎ Seed'),
            ),
            snapshot.readout?.lines?.length
              ? h('pre', { className: 'ffs-readout' }, snapshot.readout.lines.slice(0, 4).join('\n'))
              : null,
          ),
          card('scene', 'Scene', null,
            surfacesLoaded
              ? h('div', { className: 'ffs-control' },
                h('span', { className: 'ffs-control-head' }, h('span', null, 'Surface outlines')),
                h('div', { className: 'ffs-seg' },
                  [['-', 'Off'], ['white', 'White'], ['pial', 'Pial'], ['white,pial', 'Both']].map(([value, label]) => h('button', {
                    key: value, type: 'button',
                    className: (value === '-' ? !snapshot.surfaces.shown.length : snapshot.surfaces.shown.join(',') === value) ? 'active' : '',
                    onClick: () => set(value === '-' ? "SHOW_SURFACES ''" : `SHOW_SURFACES ${value}`),
                  }, label)),
                ),
              )
              : h('div', { className: 'ffs-hint' }, 'No subject loaded. Add one from Data → Subjects.'),
            h('div', { className: 'ffs-info-row' },
              h('span', { className: 'ffs-info-label' }, 'Subject'),
              h('span', { className: 'ffs-info-value', title: snapshot.surfaces.subject || '' }, surfaceSubjectName || 'none'),
              surfacesLoaded
                ? h('button', {
                  type: 'button', className: 'ffs-btn', disabled: busy,
                  title: 'Unload the subject and hide its outlines',
                  onClick: () => run('clear_surfaces', {}, 'surfaces cleared').catch(() => {}),
                }, 'Clear')
                : null,
            ),
            h('div', { className: 'ffs-info-row' },
              h('span', { className: 'ffs-info-label' }, 'Mode'),
              h('span', { className: 'ffs-info-value' }, snapshot.mode?.name || 'plain'),
            ),
          ),
        ),
        h('div', { className: 'ffs-rail-foot' },
          h('button', {
            type: 'button', className: 'ffs-btn', disabled: busy,
            onClick: () => run('save', { note: 'rail save' }, 'saved').catch(() => {}),
          }, 'Save'),
          h('button', {
            type: 'button', className: 'ffs-btn', disabled: busy,
            onClick: () => run('restore', {}, 'restored').catch(() => {}),
          }, 'Restore'),
          h('span', { className: 'ffs-foot-status', title: snapshot.lastSavedAt || '' },
            snapshot.lastSavedAt ? `saved ${snapshot.lastSavedAt.replace('T', ' ').slice(11, 19)}` : 'unsaved'),
        ),
        pathTip ? h('div', { className: 'ffs-path-tip' }, pathTip) : null,
      )
    }
    function field(label, control) {
      return h('div', { className: 'ffs-field' }, h('label', {}, label), control)
    }
    function colorFor(colormap) {
      const map = { hot: '#e55934', redblue: '#4f7bc4', RdBu: '#4f7bc4', cool: '#2f8f9d', viridis: '#4b8b6b', plasma: '#b06ab3', inferno: '#d97706', turbo: '#2dd4bf', gray: '#9aa4b2' }
      return map[colormap] || '#9aa4b2'
    }

    // ------------------------------------------------------------------ command bar
    function CommandBar({ dispatch, busy }) {
      const [value, setValue] = useState('')
      const [history, setHistory] = useState([])
      const [cursor, setCursor] = useState(-1)
      const submit = () => {
        const line = value.trim()
        if (!line) return
        setHistory(items => [line, ...items].slice(0, 50))
        setCursor(-1)
        setValue('')
        dispatch(line)
      }
      return h('input', {
        type: 'text',
        value,
        placeholder: 'FFS command (e.g. SET_IJK 32 32 20, SET_THRESHOLD S 3, OPEN_VIEW V4 image sagittal)',
        disabled: busy,
        onChange: e => setValue(e.target.value),
        onKeyDown: e => {
          if (e.key === 'Enter') { e.preventDefault(); submit() }
          else if (e.key === 'ArrowUp' && history.length) {
            e.preventDefault()
            const next = Math.min(history.length - 1, cursor + 1)
            setCursor(next); setValue(history[next])
          } else if (e.key === 'ArrowDown' && history.length) {
            e.preventDefault()
            const next = Math.max(-1, cursor - 1)
            setCursor(next); setValue(next < 0 ? '' : history[next])
          }
        },
      })
    }

    // ------------------------------------------------------------------ plugin
    const messages = {
      title: 'FFS viewer',
      description: 'Interactive fMRI viewer workspace for FFS datasets, surfaces and linked time series.',
      open: 'FFS viewer',
      waiting: 'Waiting for the Harness connection…',
      loading: 'Opening viewer…',
      save: 'Save viewer state and workspace',
      restore: 'Restore saved viewer state',
      resetLayout: 'Reset pane layout',
      openData: 'Data sources…',
      cancel: 'Cancel',
      noDatasets: 'No supported datasets in this folder',
      noMatchingDatasets: 'No datasets match this filter',
      sources: 'Data sources',
      folders: 'Folders',
      subjects: 'FreeSurfer subjects',
      addFolder: 'Add folder…',
      addSubject: 'Add FreeSurfer subject…',
      folderPath: 'Folder or file path',
      add: 'Add',
      remove: 'Remove',
      noFolders: 'No source folders yet. Add a folder to scan for datasets.',
      noSubjects: 'No FreeSurfer subjects added.',
      recursive: 'Recursive',
      rescan: 'Rescan',
      noFolderSelected: 'Select a folder',
      selectedFiles: 'Selected files',
      noDatasets: 'No supported datasets in this folder',
      noMatchingDatasets: 'No datasets match this filter',
      load: 'Load',
      loadClose: 'Load and close',
      emptyTitle: 'No data loaded',
      emptyBody: 'Add a source folder and load a dataset to begin.',
      addData: 'Add data…',
      layout: 'Window layout',
      layoutGrid: 'Grid 2×2',
      layoutColumns: 'Three columns',
      layoutTabs: 'Tabs',
      windowMode: 'Window mode',
      floating: 'Floating windows',
      docked: 'Docked layout',
      arrange: 'Arrange',
      tile: 'Tile',
      cascade: 'Cascade',
      rows: 'Rows',
      minimizeAll: 'Minimize all',
      restoreAll: 'Restore all',
    }

    const TYPE_ID = '@local/ffs-harness-viewer'
    const KIND = 'ffs-viewer'

    function ShowBridge({ ctx }) {
      const { snapshot, onShow } = useBridge(ctx, false)
      useEffect(() => {
        if (!snapshot || !onShow(snapshot.showSeq)) return
        try {
          const sidebar = ctx.get('sidebarRight')
          if (sidebar && sidebar.openTab) sidebar.openTab(KIND)
        } catch (error) {
          // No session/controller: nothing to reveal.
        }
      }, [snapshot, onShow, ctx])
      return null
    }

    return {
      name: 'ffs-viewer',
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        let t = key => messages[key] || humanize(key)
        ctx.effect(() => {
          try {
            ctx.locale.register('ffs-viewer', { en: messages })
            const bound = ctx.locale.bind('ffs-viewer')
            t = (key, options) => {
              let value
              try { value = bound(key, options) } catch (error) { value = undefined }
              return typeof value === 'string' && value && value !== key
                ? value
                : (messages[key] || humanize(key))
            }
          } catch (error) {
            console.warn?.('ffs-viewer: locale registration failed', error)
          }
          return () => {}
        }, 'ffs-viewer: locale')

        // One namespaced stylesheet, owned by the plugin fiber.
        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {}
          const style = document.createElement('style')
          style.setAttribute('data-ffs-viewer', '')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'ffs-viewer: styles')

        const openDocked = () => {
          try {
            ctx.sidebarRight.openTab(KIND)
          } catch (error) {
            console.warn?.('ffs-viewer: could not open the docked tab', error)
          }
        }

        // Stage one: the tab type and its guide entry. The tab is a page type,
        // opened by kind (no address patterns).
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TYPE_ID,
          kind: KIND,
          title: () => t('title'),
          keepMounted: true,
          guide: [{
            id: 'ffs-viewer',
            order: 30,
            title: () => t('title'),
            description: () => t('description'),
            icon: FfsIcon,
          }],
        }), 'ffs-viewer: sidebar tab type')

        // Stage two: the body under the same id. `t` is injected by the slot
        // because the registration names the locale namespace.
        const slotT = (props, key, options) => {
          let value
          try { value = props.t ? props.t(key, options) : undefined } catch (error) { value = undefined }
          if (typeof value === 'string' && value && value !== key) return value
          return t(key, options)
        }
        const Body = props => h(ViewerBody, { ctx, t: (key, options) => slotT(props, key, options) })
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: TYPE_ID, locale: 'ffs-viewer',
        }, Body)), 'ffs-viewer: sidebar tab body')

        // The discoverable entry point in every Session header.
        const OpenButton = props => h('button', {
          type: 'button', className: 'ffs-open-btn', title: slotT(props, 'open'),
          onClick: openDocked,
        }, h(FfsIcon, { size: 15 }), h('span', null, slotT(props, 'open')))
        ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'ffs-viewer', order: 20, locale: 'ffs-viewer', label: () => t('open'),
        }, OpenButton)), 'ffs-viewer: header action')

        // Agent `ffs_viewer_show` must reveal the docked tab even when it is
        // closed (no body mounted to see showSeq). Invisible poller, no chrome.
        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'ffs-viewer.show-bridge', order: 90,
        }, () => h(ShowBridge, { ctx }))), 'ffs-viewer: show bridge')
      },
    }
  },
})
