/**
 * FFS record — Client half.
 *
 * A right-sidebar tab over the append-only record: recent attempts, decision history, durable
 * inspection sessions and the preference profile. User-only actions (establish/retire/delete
 * preferences, delete evidence) are buttons here; the Host routes enforce the same authority.
 */

window.__ModuleLoader__.load({
  id: '@local/ffs-record',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const TYPE_ID = '@local/ffs-record'
    const KIND = 'ffs-record'
    const LOCALE_NS = 'ffs-record'
    const SNAPSHOT = '/ffs-record/snapshot'
    const VIEWER_TAB = 'ffs-viewer'
    const PREFERENCES = '/ffs-record/preferences'
    const POLICY = '/ffs-record/policy'

    const MESSAGES = {
      title: 'Record',
      version: 'record 0.1.12',
      description: 'Runs, decisions, inspections and learned preferences from the append-only record.',
      open: 'Record',
      refresh: 'Refresh',
      loading: 'Loading record…',
      error: 'The record snapshot could not be loaded.',
      retry: 'Retry',
      runs: 'Attempts',
      decisions: 'Decisions',
      inspection: 'Inspection',
      preferences: 'Preferences',
      policy: 'Project policy',
      settings: 'Settings',
      rebuild: 'Rebuild index',
      rebuilt: 'Record index rebuilt',
      filters: 'Filters',
      clearFilters: 'Clear filters',
      anyStatus: 'any status',
      history: 'history',
      openViewer: 'Open in viewer',
      events: 'Events',
      recordDecision: 'Record decision',
      targetKind: 'Target kind',
      noRuns: 'No attempts recorded yet.',
      noDecisions: 'No decisions recorded yet.',
      noInspection: 'No inspection sessions recorded yet.',
      noPreferences: 'No preference profile yet — run the viewer, then recompute.',
      establish: 'Establish',
      retire: 'Retire',
      deleteEvidence: 'Delete evidence',
      replay: 'Replay',
      apply: 'Apply',
      confirmDelete: 'Delete the evidence for this inspection session?',
      confirmPreference: 'Confirm preference',
      reason: 'Reason (optional)',
      applied: 'Recorded',
      actor: 'actor',
      status: 'status',
      score: 'score',
      sessions: 'sessions',
      captures: 'captures',
      marks: 'marks',
      baseline: 'baseline',
      noViewer: 'Viewer sidecar is not reachable for this session.',
    }

    function humanize(key) {
      return String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase())
    }

    async function post(path, body) {
      const res = await fetch(path, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
      })
      const payload = await res.json().catch(() => null)
      if (!res.ok || !payload || payload.ok === false) {
        throw new Error(payload?.error?.message || `request failed (${res.status})`)
      }
      return payload
    }

    function statusClass(status) {
      if (status === 'completed' || status === 'established' || status === 'accept') return 'ffr-pill is-ok'
      if (status === 'failed' || status === 'reject' || status === 'retired') return 'ffr-pill is-error'
      if (status === 'candidate' || status === 'tentative' || status === 'running') return 'ffr-pill is-warn'
      return 'ffr-pill'
    }

    function RecordIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z' }),
        h('path', { d: 'M9 8h6M9 12h6M9 16h4' }))
    }

    function Section({ title, count, children }) {
      return h('section', { className: 'ffr-section' },
        h('div', { className: 'ffr-section-head' },
          h('h4', null, title),
          h('span', { className: 'ffr-small ffr-muted' }, String(count ?? ''))),
        children)
    }

    class RecordBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        console.error?.('[ffs-record] section failed', error)
      }

      render() {
        if (this.state.error) {
          return h('div', { className: 'ffr-empty' },
            h('div', null, 'The record could not be rendered.'),
            h('div', { className: 'ffr-small ffr-muted' }, String(this.state.error?.message || this.state.error)),
            h('button', { type: 'button', className: 'ffr-btn', onClick: () => window.location.reload() }, 'Reload page'))
        }
        return this.props.children
      }
    }

    function RunsSection({ runs }) {
      const emptyFilters = { status: '', mode: '', subject: '', actorKind: '' }
      const [filters, setFilters] = useState(emptyFilters)
      const [filtered, setFiltered] = useState(null)
      const [filterError, setFilterError] = useState(null)
      const active = Object.values(filters).some(Boolean)
      useEffect(() => {
        if (!active) {
          setFiltered(null)
          setFilterError(null)
          return undefined
        }
        const controller = new AbortController()
        const params = new URLSearchParams()
        for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value)
        params.set('limit', '100')
        fetch(`/ffs-record/runs?${params}`, { credentials: 'same-origin', signal: controller.signal })
          .then((res) => res.json().catch(() => null).then((payload) => ({ res, payload })))
          .then(({ res, payload }) => {
            if (!res.ok || !payload || payload.ok !== true) setFilterError(payload?.error?.message || `query failed (${res.status})`)
            else setFiltered(payload.runs || [])
          })
          .catch((error) => { if (error?.name !== 'AbortError') setFilterError(String(error?.message || error)) })
        return () => controller.abort()
      }, [filters.status, filters.mode, filters.subject, filters.actorKind])
      const rows = filtered || runs
      const set = (key) => (event) => setFilters((current) => ({ ...current, [key]: event.target.value }))
      return h(Section, { title: MESSAGES.runs, count: rows.length },
        h('div', { className: 'ffr-row ffr-filters' },
          h('span', { className: 'ffr-small ffr-muted' }, MESSAGES.filters),
          h('select', { className: 'ffr-input', value: filters.status, onChange: set('status'), 'aria-label': 'attempt status' },
            h('option', { value: '' }, 'any status'),
            ['completed', 'failed', 'stopped', 'running', 'imported'].map((status) => h('option', { key: status, value: status }, status))),
          h('select', { className: 'ffr-input', value: filters.mode, onChange: set('mode'), 'aria-label': 'attempt mode' },
            h('option', { value: '' }, 'any mode'),
            ['run', 'tool', 'replay', 'shell-history', 'imported'].map((mode) => h('option', { key: mode, value: mode }, mode))),
          h('select', { className: 'ffr-input', value: filters.actorKind, onChange: set('actorKind'), 'aria-label': 'attempt actor' },
            h('option', { value: '' }, 'any actor'),
            ['user', 'agent', 'scheduler', 'system'].map((actor) => h('option', { key: actor, value: actor }, actor))),
          h('input', {
            className: 'ffr-input', style: { width: 110 }, value: filters.subject,
            placeholder: 'subject', 'aria-label': 'attempt subject',
            onChange: set('subject'),
          }),
          active
            ? h('button', { type: 'button', className: 'ffr-btn', onClick: () => setFilters(emptyFilters) }, MESSAGES.clearFilters)
            : null),
        filterError ? h('div', { className: 'ffr-small ffr-error' }, filterError) : null,
        rows.length
          ? h('table', { className: 'ffr-table' },
            h('thead', null, h('tr', null,
              h('th', null, 'mode'), h('th', null, 'status'), h('th', null, 'actor'), h('th', null, 'subject'), h('th', null, 'started'))),
            h('tbody', null, rows.map((run) => h('tr', { key: run.runId },
              h('td', null, run.mode || '—'),
              h('td', null, h('span', { className: statusClass(run.status) }, run.status || '—')),
              h('td', { className: 'ffr-small' }, run.actor?.kind || '—', run.actor?.tool ? ` · ${run.actor.tool}` : ''),
              h('td', null, run.subject ? `sub-${run.subject}` : '—'),
              h('td', { className: 'ffr-small ffr-muted' }, (run.startedAt || '').replace('T', ' ').slice(0, 19))))))
          : h('div', { className: 'ffr-empty' }, MESSAGES.noRuns))
    }

    function DecisionComposer({ onClose, onSave }) {
      const panelRef = useRef(null)
      const onCloseRef = useRef(onClose)
      onCloseRef.current = onClose
      useEffect(() => {
        const previous = typeof document !== 'undefined' ? document.activeElement : null
        panelRef.current?.querySelector('select, input, textarea, button')?.focus?.()
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
      const [action, setAction] = useState('accept')
      const [kind, setKind] = useState('qc')
      const [ref, setRef] = useState('')
      const [path, setPath] = useState('')
      const [reason, setReason] = useState('')
      const [confidence, setConfidence] = useState('')
      const [decisionKind, setDecisionKind] = useState('preference')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const canSave = ref.trim() && !busy && (decisionKind !== 'standard' || reason.trim())
      const save = async () => {
        setBusy(true)
        setError(null)
        const ok = await onSave({
          action, target: { kind, ref: ref.trim(), ...(path.trim() ? { path: path.trim() } : {}) },
          reason, confidence: confidence || null, decisionKind,
          overrideRef: decisionKind === 'standard' ? path.trim() || ref.trim() : null,
        })
        setBusy(false)
        if (ok) onClose()
        else setError('decision was rejected by the record route')
      }
      return h('div', {
        className: 'ffr-modal-backdrop', role: 'presentation',
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
      },
      h('div', {
        className: 'ffr-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': MESSAGES.recordDecision,
        tabIndex: -1, ref: panelRef,
      },
        h('div', { className: 'ffr-row' },
          h('strong', null, MESSAGES.recordDecision),
          h('span', { className: 'ffr-spacer' }),
          h('button', { type: 'button', className: 'ffr-btn', onClick: onClose }, 'Close')),
        h('div', { className: 'ffr-row' },
          h('label', { className: 'ffr-small' }, 'action ',
            h('select', { className: 'ffr-input', value: action, onChange: (e) => setAction(e.target.value) },
              ['accept', 'tentative', 'reject', 'undecided'].map((value) => h('option', { key: value, value }, value)))),
          h('label', { className: 'ffr-small' }, `${MESSAGES.targetKind} `,
            h('select', { className: 'ffr-input', value: kind, onChange: (e) => setKind(e.target.value) },
              ['qc', 'cohort', 'artifact', 'metric', 'record'].map((value) => h('option', { key: value, value }, value)))),
          h('label', { className: 'ffr-small' }, 'ref ',
            h('input', { className: 'ffr-input', value: ref, onChange: (e) => setRef(e.target.value), placeholder: 'sub-001:qc/fd.png' }))),
        h('label', { className: 'ffr-small' }, 'path (optional, relative to the work dir) ',
          h('input', {
            className: 'ffr-input ffr-wide', value: path, onChange: (e) => setPath(e.target.value),
            placeholder: 'target path relative to the run work dir',
            title: 'The decision route resolves this inside the work dir and hashes it when possible.',
          })),
        h('label', { className: 'ffr-small' }, 'reason ',
          h('textarea', {
            className: 'ffr-input ffr-wide', rows: 2, value: reason,
            onChange: (e) => setReason(e.target.value),
            placeholder: decisionKind === 'standard' ? 'required for a standard departure' : 'optional — recorded as not stated',
          })),
        h('div', { className: 'ffr-row' },
          h('label', { className: 'ffr-small' }, 'confidence ',
            h('select', { className: 'ffr-input', value: confidence, onChange: (e) => setConfidence(e.target.value) },
              ['', 'low', 'medium', 'high'].map((value) => h('option', { key: value || 'none', value }, value || '—')))),
          h('label', { className: 'ffr-small' }, 'kind ',
            h('select', { className: 'ffr-input', value: decisionKind, onChange: (e) => setDecisionKind(e.target.value) },
              h('option', { value: 'preference' }, 'preference'),
              h('option', { value: 'standard' }, 'standard (needs reason)')))),
        error ? h('div', { className: 'ffr-small ffr-error' }, error) : null,
        h('div', { className: 'ffr-row' },
          h('span', { className: 'ffr-spacer' }),
          h('button', { type: 'button', className: 'ffr-btn', onClick: onClose }, 'Cancel'),
          h('button', { type: 'button', className: 'ffr-btn', disabled: !canSave, onClick: save },
            busy ? '…' : 'Save decision'))))
    }

    function DecisionsSection({ decisions, onRecord }) {
      const [status, setStatus] = useState('')
      const [filtered, setFiltered] = useState(null)
      const [error, setError] = useState(null)
      const [expanded, setExpanded] = useState(null)
      const [composer, setComposer] = useState(false)
      useEffect(() => {
        if (!status) { setFiltered(null); setError(null); return undefined }
        const controller = new AbortController()
        fetch(`/ffs-record/family?family=decisions&status=${encodeURIComponent(status)}&limit=100`, {
          credentials: 'same-origin', signal: controller.signal,
        })
          .then((res) => res.json().catch(() => null).then((payload) => ({ res, payload })))
          .then(({ res, payload }) => {
            if (!res.ok || !payload || payload.ok !== true) setError(payload?.error?.message || `query failed (${res.status})`)
            else setFiltered(payload.decisions || [])
          })
          .catch((e) => { if (e?.name !== 'AbortError') setError(String(e?.message || e)) })
        return () => controller.abort()
      }, [status])
      const rows = filtered || decisions
      return h(Section, { title: MESSAGES.decisions, count: rows.length },
        h('div', { className: 'ffr-row ffr-filters' },
          h('span', { className: 'ffr-small ffr-muted' }, MESSAGES.filters),
          h('select', { className: 'ffr-input', value: status, onChange: (event) => setStatus(event.target.value), 'aria-label': 'decision status' },
            h('option', { value: '' }, MESSAGES.anyStatus),
            ['recorded', 'accepted', 'withdrawn', 'superseded'].map((value) => h('option', { key: value, value }, value))),
          status ? h('button', { type: 'button', className: 'ffr-btn', onClick: () => setStatus('') }, MESSAGES.clearFilters) : null,
          h('span', { className: 'ffr-spacer' }),
          onRecord ? h('button', { type: 'button', className: 'ffr-btn', onClick: () => setComposer(true) }, MESSAGES.recordDecision) : null),
        composer ? h(DecisionComposer, { onClose: () => setComposer(false), onSave: onRecord }) : null,
        error ? h('div', { className: 'ffr-small ffr-error' }, error) : null,
        rows.length
          ? h('div', { className: 'ffr-list' }, rows.map((decision) => {
            const open = expanded === decision.id
            const events = Array.isArray(decision.events) ? decision.events : []
            return h('div', { className: 'ffr-item', key: decision.id },
              h('div', {
                className: 'ffr-row', role: 'button', tabIndex: 0, 'aria-expanded': open,
                style: { cursor: 'pointer' },
                onClick: () => setExpanded(open ? null : decision.id),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setExpanded(open ? null : decision.id) }
                },
              },
              h('span', { className: statusClass(decision.action || decision.status) }, decision.action || decision.status || '—'),
              h('span', { className: 'ffr-code' }, decision.id || ''),
              h('span', { className: 'ffr-small ffr-muted' }, decision.actor?.kind || 'unknown'),
              decision.confidence ? h('span', { className: 'ffr-tag' }, decision.confidence) : null,
              h('span', { className: 'ffr-spacer' }),
              decision.evidence?.visual?.length ? h('span', { className: 'ffr-tag' }, `${decision.evidence.visual.length} capture`) : null,
              h('span', { className: 'ffr-small ffr-muted' },
                `${events.length} ${MESSAGES.history} · ${String(decision.updatedAt || '').replace('T', ' ').slice(0, 19)}`)),
              h('div', { className: 'ffr-small' }, decision.target?.ref || decision.target?.kind || ''),
              decision.rationale?.text ? h('div', { className: 'ffr-small ffr-muted' }, decision.rationale.text) : null,
              open
                ? h('div', { className: 'ffr-history' }, events.map((event, index) => h('div', { className: 'ffr-small ffr-muted', key: `${event.at}:${index}` },
                  `${String(event.at || '').replace('T', ' ').slice(0, 19)} · ${event.type} · ${event.actor?.kind || event.payload?.decision?.actor?.kind || 'unknown'}`)))
                : null)
          }))
          : h('div', { className: 'ffr-empty' }, MESSAGES.noDecisions))
    }

    function InspectionSection({ inspection, onDeleteEvidence, onReplay, onOpenViewer, onToggleRecording, busy }) {
      const recent = inspection?.recent || []
      const [detail, setDetail] = useState(null)
      const [detailError, setDetailError] = useState(null)
      const [detailBusy, setDetailBusy] = useState(false)
      const loadEvents = async (sessionId) => {
        if (detail === sessionId) { setDetail(null); return }
        setDetailBusy(true)
        setDetailError(null)
        try {
          const res = await fetch(`/ffs-record/inspection?session=${encodeURIComponent(sessionId)}&frames=100`, { credentials: 'same-origin' })
          const payload = await res.json().catch(() => null)
          if (!res.ok || !payload?.session) throw new Error(payload?.error?.message || `session lookup failed (${res.status})`)
          setDetail({ sessionId, frames: payload.session.recentFrames || [] })
        } catch (error) {
          setDetailError(String(error?.message || error))
        } finally {
          setDetailBusy(false)
        }
      }
      return h(Section, { title: MESSAGES.inspection, count: inspection?.sessions ?? 0 },
        h('div', { className: 'ffr-row' },
          h('span', { className: inspection?.live ? 'ffr-pill is-ok' : 'ffr-pill' },
            inspection?.live ? 'live' : 'no live session'),
          h('span', { className: inspection?.paused ? 'ffr-pill is-warn' : 'ffr-pill' },
            inspection?.paused ? 'recording paused' : 'recording on'),
          h('span', { className: 'ffr-small ffr-muted' },
            `${inspection?.events ?? 0} events · ${inspection?.marks ?? 0} marks · ${inspection?.captures ?? 0} captures`),
          h('span', { className: 'ffr-spacer' }),
          onOpenViewer
            ? h('button', { type: 'button', className: 'ffr-btn', onClick: onOpenViewer }, MESSAGES.openViewer)
            : null,
          onToggleRecording
            ? h('button', {
              type: 'button', className: 'ffr-btn', disabled: busy,
              onClick: onToggleRecording,
            }, inspection?.paused ? 'Resume recording' : 'Pause recording')
            : null),
        recent.length
          ? h('div', { className: 'ffr-list' }, recent.map((session) => h('div', { className: 'ffr-item', key: session.sessionId },
            h('div', { className: 'ffr-row' },
              h('span', { className: 'ffr-code' }, session.sessionId),
              h('span', { className: 'ffr-spacer' }),
              h('button', {
                type: 'button', className: 'ffr-btn', disabled: busy,
                title: 'Replay this session’s display/navigation events in the FFS viewer',
                onClick: () => onReplay(session.sessionId),
              }, MESSAGES.replay),
              h('button', {
                type: 'button', className: 'ffr-btn', disabled: busy || detailBusy,
                onClick: () => loadEvents(session.sessionId),
              }, detail?.sessionId === session.sessionId ? 'Hide events' : MESSAGES.events),
              h('button', {
                type: 'button', className: 'ffr-btn', disabled: busy,
                onClick: () => onDeleteEvidence(session.sessionId),
              }, MESSAGES.deleteEvidence)),
            h('div', { className: 'ffr-small ffr-muted' },
              `${session.events} events · ${session.marks} marks · ${session.captures} captures · ${session.frames} frames`
              + `${session.paused ? ' · paused' : ''}${session.live ? ' · live' : ''}`),
            detail?.sessionId === session.sessionId
              ? h('div', { className: 'ffr-history' },
                detail.frames.slice(-100).map((frame, index) => h('div', { className: 'ffr-small ffr-muted', key: `${frame.seq ?? index}:${index}` },
                  `${frame.seq ?? '—'} · ${frame.frame || 'frame'}${frame.command?.line ? ` · ${frame.command.line}` : frame.command?.category ? ` · ${frame.command.category}` : ''}`)))
              : null)))
          : h('div', { className: 'ffr-empty' }, MESSAGES.noInspection),
        detailError ? h('div', { className: 'ffr-small ffr-error' }, detailError) : null,
        h('div', { className: 'ffr-small ffr-muted' }, 'Baselines and cited sessions travel with exported packages.'))
    }

    function PolicySection({ policy, onSave, busy }) {
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState('')
      if (!policy) return null
      const constraints = Array.isArray(policy.constraints) ? policy.constraints : []
      const standards = Array.isArray(policy.standards) ? policy.standards : []
      const render = (entry) => h('div', { className: 'ffr-item', key: entry.id },
        h('div', { className: 'ffr-row' },
          h('span', { className: entry.kind === 'constraint' ? 'ffr-pill is-error' : 'ffr-pill is-warn' }, entry.kind || 'standard'),
          h('span', { className: 'ffr-code' }, entry.id),
          h('span', { className: 'ffr-spacer' }),
          h('span', { className: 'ffr-small ffr-muted' }, `applies: ${(entry.appliesTo || []).join(', ') || 'all'}`)),
        h('div', { className: 'ffr-small' }, entry.text || ''),
        h('div', { className: 'ffr-small ffr-muted' }, `check: ${entry.check || '—'}`))
      return h(Section, { title: MESSAGES.policy, count: constraints.length + standards.length },
        h('div', { className: 'ffr-row' },
          h('span', { className: 'ffr-small ffr-muted' }, 'Constraints gate first; they cannot be overridden.'),
          h('span', { className: 'ffr-spacer' }),
          h('button', {
            type: 'button', className: 'ffr-btn', disabled: busy,
            onClick: () => { setEditing(!editing); setDraft(JSON.stringify(policy, null, 2)) },
          }, editing ? 'Cancel edit' : 'Edit policy')),
        editing
          ? h('div', null,
            h('textarea', {
              className: 'ffr-policy-editor', rows: 16, value: draft,
              onChange: (event) => setDraft(event.target.value),
              spellCheck: false,
            }),
            h('div', { className: 'ffr-row' },
              h('span', { className: 'ffr-small ffr-muted' }, 'The editor writes policy.yaml through the Python validator; facts/checks stay the same.'),
              h('span', { className: 'ffr-spacer' }),
              h('button', {
                type: 'button', className: 'ffr-btn', disabled: busy,
                onClick: () => onSave(draft).then((ok) => { if (ok) setEditing(false) }),
              }, 'Save policy')))
          : h('div', { className: 'ffr-list' }, [...constraints, ...standards].map(render)))
    }

    function SettingsSection({ snapshot, policy, onRebuild, busy }) {
      const families = snapshot?.families || {}
      const retention = (policy && policy.retention) || {}
      const recency = (policy && policy.recency) || {}
      const familyText = ['runs', 'decisions', 'preferences', 'inspection']
        .map((family) => `${family} ${families[family]?.events ?? 0}`)
        .join(' · ')
      return h(Section, { title: MESSAGES.settings, count: 'retention + index' },
        h('dl', { className: 'ffr-kv' },
          h('dt', null, 'record root'), h('dd', { className: 'ffr-code' }, snapshot?.root || '—'),
          h('dt', null, 'families'), h('dd', null, familyText),
          h('dt', null, 'corrupt lines'), h('dd', null, String(snapshot?.corrupt?.length ?? 0)),
          h('dt', null, 'raw retention'), h('dd', null,
            `${retention.rawDays ?? '—'} days · ${retention.rawBytes ?? '—'} bytes · keep ${retention.keepSessions ?? '—'} sessions`),
          h('dt', null, 'recency half-life'), h('dd', null, `${recency.halfLifeDays ?? '—'} days`),
          h('dt', null, 'policy file'), h('dd', { className: 'ffr-code' }, `${snapshot?.root || 'work/ffs-record'}/policy.yaml`),
          h('dt', null, 'recording'), h('dd', null, 'on by default; pause in the viewer or set FFS_RECORD=off')),
        h('div', { className: 'ffr-row' },
          h('span', { className: 'ffr-small ffr-muted' },
            'Rebuild re-derives the query index from the append-only shards; it never rewrites them.'),
          h('span', { className: 'ffr-spacer' }),
          h('button', { type: 'button', className: 'ffr-btn', disabled: busy, onClick: onRebuild },
            busy ? '…' : MESSAGES.rebuild)))
    }

    function presentationCommand(record) {
      if (!record || record.status !== 'established' || record.scientific === true || record.active === false) return null
      const family = record.recommendation?.family
      const value = record.recommendation?.value
      if (family === 'alpha') {
        const number = Number(value)
        return Number.isFinite(number) && number >= 0 && number <= 1 ? `SET_ALPHA S ${number}` : null
      }
      if (family === 'colormap' && /^[A-Za-z0-9_+-]{1,40}$/.test(String(value || ''))) {
        return `SET_COLORMAP S ${String(value).trim()}`
      }
      return null
    }

    function PreferencesSection({ profile, summary, onAction, onApply, busy }) {
      const preferences = profile?.preferences || []
      return h(Section, { title: MESSAGES.preferences, count: preferences.length },
        summary?.stats
          ? h('div', { className: 'ffr-small ffr-muted' },
            `${summary.stats.observed || 0} observed · ${summary.stats.candidate || 0} candidate · ${summary.stats.established || 0} established · ${summary.stats.retired || 0} retired`)
          : null,
        preferences.length
          ? h('div', { className: 'ffr-list' }, preferences.map((record) => h('div', { className: 'ffr-item', key: record.id },
            h('div', { className: 'ffr-row' },
              h('span', { className: statusClass(record.status) }, record.status),
              record.scientific ? h('span', { className: 'ffr-tag' }, 'scientific') : null,
              h('span', { className: 'ffr-code' }, record.id),
              h('span', { className: 'ffr-spacer' }),
              presentationCommand(record)
                ? h('button', {
                  type: 'button', className: 'ffr-btn', disabled: busy,
                  title: `Apply to the viewer: ${presentationCommand(record)}`,
                  onClick: () => onApply(record),
                }, MESSAGES.apply)
                : null,
              h('button', { type: 'button', className: 'ffr-btn', disabled: busy || record.status === 'established', onClick: () => onAction('establish', record.id) }, MESSAGES.establish),
              h('button', { type: 'button', className: 'ffr-btn', disabled: busy || record.status === 'retired', onClick: () => onAction('retire', record.id) }, MESSAGES.retire)),
            h('div', { className: 'ffr-small' }, record.recommendation?.action || ''),
            h('div', { className: 'ffr-small ffr-muted' },
              `${MESSAGES.score} ${record.evidence?.score ?? '—'} · ${MESSAGES.sessions} ${record.evidence?.sessions ?? 0} · v${record.version || 1}`,
              record.provenance ? ` · ${record.provenance}` : ''),
            record.confirmation?.requested
              ? h('div', { className: 'ffr-row' },
                h('span', { className: 'ffr-small is-warn' }, `confirmation requested by ${record.confirmation.requested.by}`),
                h('span', { className: 'ffr-spacer' }),
                h('button', {
                  type: 'button', className: 'ffr-btn', disabled: busy,
                  onClick: () => onAction('confirm', record.id),
                }, MESSAGES.confirmPreference))
              : null)))
          : h('div', { className: 'ffr-empty' }, MESSAGES.noPreferences))
    }

    function RecordBody({ ctx, t }) {
      const [snapshot, setSnapshot] = useState(null)
      const [profile, setProfile] = useState(null)
      const [policy, setPolicy] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(false)
      const [toast, setToast] = useState(null)
      const [settingsBusy, setSettingsBusy] = useState(false)

      const refresh = useCallback(async () => {
        setLoading(true)
        try {
          const res = await fetch(SNAPSHOT, { credentials: 'same-origin' })
          const payload = await res.json().catch(() => null)
          if (!res.ok || !payload) throw new Error(payload?.error?.message || `snapshot failed (${res.status})`)
          setSnapshot(payload)
          const prefRes = await fetch(PREFERENCES, { credentials: 'same-origin' })
          const prefPayload = await prefRes.json().catch(() => null)
          setProfile(prefPayload?.profile || null)
          const policyRes = await fetch(POLICY, { credentials: 'same-origin' })
          const policyPayload = await policyRes.json().catch(() => null)
          setPolicy(policyPayload?.policy || null)
          setError(null)
        } catch (e) {
          setError(String(e?.message || e))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => { refresh() }, [refresh])

      const runAction = useCallback(async (action, preferenceId) => {
        const reason = window.prompt(MESSAGES.reason) || ''
        setBusy(true)
        try {
          await post(`${PREFERENCES}/${action}`, { preferenceId, reason })
          setToast(`${MESSAGES.applied}: ${action} ${preferenceId}`)
          await refresh()
        } catch (e) {
          setToast(`${action} failed: ${e?.message || e}`)
        } finally {
          setBusy(false)
        }
      }, [refresh])

      const recordDecision = useCallback(async (body) => {
        try {
          const result = await post('/ffs-analysis/decisions', body)
          setToast(`decision recorded · ${result.decision?.id || result.id || body.action}`)
          await refresh()
          return true
        } catch (e) {
          setToast(`decision failed: ${e?.message || e}`)
          return false
        }
      }, [refresh])

      const toggleRecording = useCallback(async () => {
        setBusy(true)
        try {
          const conn = ctx.get('connection')
          if (!conn || !conn.rpc) throw new Error('Harness connection is not ready')
          const paused = !snapshot?.inspection?.paused
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 30000)
          try {
            const result = await conn.rpc.call('/ffs', 'inspection_pause', { paused }, controller.signal)
            if (!result || result.ok !== true) throw new Error(result?.error?.message || 'pause request failed')
          } finally {
            clearTimeout(timer)
          }
          setToast(paused ? 'recording paused' : 'recording resumed')
          await refresh()
        } catch (e) {
          setToast(`recording toggle failed: ${e?.message || e}`)
        } finally {
          setBusy(false)
        }
      }, [ctx, snapshot, refresh])

      const replaySession = useCallback(async (sessionId) => {
        setBusy(true)
        try {
          const res = await fetch(`/ffs-record/inspection?session=${encodeURIComponent(sessionId)}&frames=500`, {
            credentials: 'same-origin',
          })
          const payload = await res.json().catch(() => null)
          if (!res.ok || !payload?.session) throw new Error(payload?.error?.message || `session lookup failed (${res.status})`)
          const frames = Array.isArray(payload.session.recentFrames) ? payload.session.recentFrames : []
          const lines = frames
            .filter((frame) => frame.frame === 'event' && frame.command?.category
              && (frame.command.category === 'display' || frame.command.category === 'navigation'))
            .map((frame) => frame.command.line)
            .slice(0, 240)
          if (!lines.length) {
            setToast('This session has no display/navigation events to replay.')
            return
          }
          const conn = ctx.get('connection')
          if (!conn || !conn.rpc) throw new Error('Harness connection is not ready')
          const sidebar = ctx.get('sidebarRight')
          if (sidebar && sidebar.openTab) sidebar.openTab(VIEWER_TAB)
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 60000)
          try {
            const result = await conn.rpc.call('/ffs', 'execute_batch',
              { lines, origin: 'agent' }, controller.signal)
            if (!result || result.ok !== true) throw new Error(result?.error?.message || 'viewer replay failed')
          } finally {
            clearTimeout(timer)
          }
          setToast(`Replayed ${lines.length} display/navigation event(s) from ${sessionId}.`)
        } catch (e) {
          setToast(`replay failed: ${e?.message || e}`)
        } finally {
          setBusy(false)
        }
      }, [ctx])

      const applyPreference = useCallback(async (record) => {
        const command = presentationCommand(record)
        if (!command) return
        setBusy(true)
        try {
          const conn = ctx.get('connection')
          if (!conn || !conn.rpc) throw new Error('Harness connection is not ready')
          const sidebar = ctx.get('sidebarRight')
          if (sidebar && sidebar.openTab) sidebar.openTab(VIEWER_TAB)
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 30000)
          try {
            const result = await conn.rpc.call('/ffs', 'execute_batch',
              { lines: [command], origin: 'agent' }, controller.signal)
            if (!result || result.ok !== true) throw new Error(result?.error?.message || 'viewer rejected the command')
          } finally {
            clearTimeout(timer)
          }
          setToast(`Applied ${record.id} · ${command}`)
        } catch (e) {
          setToast(`apply failed: ${e?.message || e}`)
        } finally {
          setBusy(false)
        }
      }, [ctx])

      const rebuildRecord = useCallback(async () => {
        setSettingsBusy(true)
        try {
          const result = await post('/ffs-record/rebuild', {})
          const counts = (result.rebuilt && result.rebuilt.counts) || {}
          setToast(`${MESSAGES.rebuilt} · ${counts.events ?? 0} events · ${counts.runs ?? 0} runs`)
          await refresh()
        } catch (e) {
          setToast(`rebuild failed: ${e?.message || e}`)
        } finally {
          setSettingsBusy(false)
        }
      }, [refresh])

      const savePolicy = useCallback(async (draft) => {
        setBusy(true)
        try {
          const parsed = JSON.parse(draft)
          const result = await post('/ffs-record/policy', { policy: parsed })
          setToast(`policy written · ${(result.policy.constraints || []).length} constraints · ${(result.policy.standards || []).length} standards`)
          await refresh()
          return true
        } catch (e) {
          setToast(`policy write failed: ${e?.message || e}`)
          return false
        } finally {
          setBusy(false)
        }
      }, [refresh])

      const deleteEvidence = useCallback(async (sessionId) => {
        setBusy(true)
        try {
          const plan = await post('/ffs-record/preferences/delete', {
            scope: { sessionId }, dryRun: true,
          })
          const affected = (plan.sessions || []).join(', ')
          const ok = window.confirm(`${MESSAGES.confirmDelete}\n\n${affected}\n\nTombstone + exact profile recompute follow.`)
          if (!ok) return
          const result = await post('/ffs-record/preferences/delete', {
            scope: { sessionId }, reason: 'deleted from the Record tab',
          })
          setToast(`Deleted ${result.deleted} shard(s) · pending raw ${result.pendingRawDeletions}`)
          await refresh()
        } catch (e) {
          setToast(`deletion failed: ${e?.message || e}`)
        } finally {
          setBusy(false)
        }
      }, [refresh])

      const runs = snapshot?.recentRuns || []
      const decisions = snapshot?.recentDecisions || []
      const inspection = snapshot?.inspection || null
      const preferences = profile || snapshot?.preferences || null
      const summary = snapshot?.preferences || null

      return h('div', { className: 'ffr-root' },
        h('div', { className: 'ffr-head' },
          h('div', { className: 'ffr-row' },
            h('strong', null, t('title')),
            h('span', { className: 'ffr-spacer' }),
            h('button', { type: 'button', className: 'ffr-btn', onClick: refresh, disabled: loading }, t('refresh'))),
          h('div', { className: 'ffr-small ffr-muted' },
            h('span', { className: 'ffr-code' }, snapshot?.root || 'work/ffs-record'),
            ` · ${MESSAGES.version}`,
            ` · ${runs.length} recent attempts · ${decisions.length} recent decisions · ${inspection?.sessions ?? 0} sessions`)),
        toast ? h('div', { className: 'ffr-toast' }, toast) : null,
        error
          ? h('div', { className: 'ffr-empty' },
            h('div', null, t('error')),
            h('div', { className: 'ffr-small ffr-muted' }, error),
            h('button', { type: 'button', className: 'ffr-btn', onClick: refresh }, t('retry')))
          : loading && !snapshot
            ? h('div', { className: 'ffr-empty' }, t('loading'))
            : h('div', { className: 'ffr-body' },
              h(RecordBoundary, null,
              h(RunsSection, { runs }),
              h(DecisionsSection, { decisions, onRecord: recordDecision }),
              h(InspectionSection, {
                inspection, onDeleteEvidence: deleteEvidence, onReplay: replaySession, busy,
                onOpenViewer: () => { const sidebar = ctx.get('sidebarRight'); if (sidebar && sidebar.openTab) sidebar.openTab(VIEWER_TAB) },
                onToggleRecording: toggleRecording,
              }),
              h(PreferencesSection, {
                profile: preferences?.preferences ? preferences : { preferences: [] },
                summary, onAction: runAction, onApply: applyPreference, busy,
              }),
              h(PolicySection, { policy, onSave: savePolicy, busy }),
              h(SettingsSection, { snapshot, policy, onRebuild: rebuildRecord, busy: settingsBusy }))))
    }

    const CSS = `
      .ffr-root, .ffr-root * { box-sizing: border-box; }
      .ffr-root { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; font-size: 12px;
  color: var(--dsw-alias-fg-primary, inherit); flex: 1 1 auto; min-height: 0; min-width: 0;
  width: 100%; max-width: 100%; overflow-y: auto; overflow-x: hidden; }
      .ffr-head { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      .ffr-body { display: flex; flex-direction: column; gap: 12px; min-width: 0; max-width: 100%; }
      .ffr-section { border: 1px solid var(--dsw-alias-border-default, #d0d5dd); border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 6px; min-width: 0; max-width: 100%; }
      .ffr-section-head { display: flex; align-items: baseline; gap: 8px; }
      .ffr-section-head h4 { margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; opacity: .8; }
      .ffr-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ffr-history { margin-top: 4px; padding-left: 8px; border-left: 2px solid var(--dsw-alias-border-default, #d0d5dd); }
.ffr-modal-backdrop { position: fixed; inset: 0; z-index: 1200; display: flex; align-items: center;
  justify-content: center; padding: 16px; background: rgba(0,0,0,.35); }
.ffr-modal { display: flex; flex-direction: column; gap: 6px; width: min(620px, 100%); max-height: 90%;
  overflow: auto; padding: 10px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-default, #d0d5dd);
  background: var(--dsw-alias-bg-layer-1, #fff); }
.ffr-wide { width: 100%; }
textarea.ffr-input { resize: vertical; font: inherit; }
.ffr-input { border: 1px solid var(--dsw-alias-border-default, #d0d5dd); border-radius: 5px;
  background: transparent; color: inherit; font: inherit; font-size: 11px; padding: 2px 5px; }
.ffr-filters { margin-bottom: 6px; }
.ffr-error { color: var(--dsw-alias-state-error-primary, #b42318); }
      .ffr-spacer { flex: 1 1 auto; }
      .ffr-small { font-size: 11px; }
      .ffr-muted { opacity: .7; }
      .ffr-empty { padding: 12px; text-align: center; opacity: .65; }
      .ffr-list { display: flex; flex-direction: column; gap: 6px; }
      .ffr-item { border-top: 1px solid var(--dsw-alias-border-default, #e4e7ec); padding-top: 6px; }
      .ffr-table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; }
      .ffr-table th, .ffr-table td { text-align: left; padding: 2px 4px; font-size: 11px; border-bottom: 1px solid var(--dsw-alias-border-default, #eceff3); overflow-wrap: anywhere; }
      .ffr-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; overflow-wrap: anywhere; }
      .ffr-pill { display: inline-block; border-radius: 999px; padding: 0 7px; font-size: 10.5px; border: 1px solid transparent; }
      .ffr-pill.is-ok { background: rgba(46,125,50,.12); color: #2e7d32; }
      .ffr-pill.is-warn { background: rgba(237,108,2,.14); color: #b26a00; }
      .ffr-pill.is-error { background: rgba(211,47,47,.12); color: #c62828; }
      .ffr-tag { border: 1px solid var(--dsw-alias-border-default, #d0d5dd); border-radius: 4px; padding: 0 5px; font-size: 10.5px; opacity: .8; }
      .ffr-btn { border: 1px solid var(--dsw-alias-border-default, #d0d5dd); background: transparent; color: inherit; border-radius: 5px; padding: 1px 7px; font-size: 11px; cursor: pointer; }
      .ffr-btn:disabled { opacity: .45; cursor: default; }
      .ffr-toast { border-radius: 6px; padding: 4px 8px; background: rgba(46,125,50,.1); }
      .is-warn { color: #b26a00; }
      .ffr-open-btn { display: inline-flex; align-items: center; gap: 5px; }
      .ffr-policy-editor { width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-default, #d0d5dd); background: transparent; color: inherit; padding: 6px; }
    `

    return {
      name: 'ffs-record',
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'],
      // Exposed for interaction smokes; unused by the runtime.
      __test: { DecisionComposer, DecisionsSection, InspectionSection, RunsSection, SettingsSection },
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
          } catch (e) { console.warn?.('ffs-record: locale registration failed', e) }
          return () => {}
        }, 'ffs-record: locale')

        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {}
          const style = document.createElement('style')
          style.setAttribute('data-ffs-record', '')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'ffs-record: styles')

        const openTab = () => {
          try {
            const sidebar = ctx.get('sidebarRight')
            if (sidebar && sidebar.openTab) sidebar.openTab(KIND)
          } catch (e) { console.warn?.('ffs-record: could not open the docked tab', e) }
        }

        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TYPE_ID,
          kind: KIND,
          title: () => t('title'),
          keepMounted: true,
          guide: [{
            id: 'ffs-record',
            order: 32,
            title: () => t('title'),
            description: () => t('description'),
            icon: RecordIcon,
          }],
        }), 'ffs-record: sidebar tab type')

        const Body = (props) => h(RecordBody, { ctx, t: (key, options) => (props?.t ? props.t(key, options) : t(key, options)) })
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: TYPE_ID, locale: LOCALE_NS,
        }, Body)), 'ffs-record: sidebar tab body')

        const OpenButton = () => h('button', {
          type: 'button', className: 'ffr-open-btn', title: t('open'), onClick: openTab,
        }, h(RecordIcon, { size: 15 }), h('span', null, t('open')))
        ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'ffs-record',
          order: 22,
          locale: LOCALE_NS,
          label: () => t('open'),
        }, OpenButton)), 'ffs-record: header action')
      },
    }
  },
})
