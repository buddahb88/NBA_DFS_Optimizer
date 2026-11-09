import { useState } from 'react'
import { exportAPI } from '../../services/api'
import { Badge, Button, Card, Input, Stat, Tabs, Toggle, cn } from '../../components/ui'
import { downloadText, formatSalary } from '../lineupStudio/lineupMath'
import { BACKTEST_DISABLED, formatActual } from '../slate/backtest'
import { PORTFOLIO_SITE, lineupNames, toExportLineups } from './portfolioMath'
import {
  GPP_SIM_DEFAULTS,
  GPP_STAGE_LABELS,
  GPP_STAGE_ORDER,
  buildGppSimRequest,
  formError,
  isSmallSingleEntry,
  ratePct,
} from './gppSimMath'

const errorMessage = (err) => err.response?.data?.error || err.response?.data?.message || err.message
const SHARPER_FIELD = 'Single-entry fields are sharper than modeled: treat the simulated win and cash rates as optimistic.'

function Caveat({ children }) {
  return (
    <p role="note" className="rounded-md border border-caution/40 bg-caution-soft px-3 py-2 text-xs text-caution">
      {children}
    </p>
  )
}

function SimForm({ form, setForm, onRun, running, disabledReason }) {
  const error = formError(form)
  const blocked = disabledReason || error
  const set = (patch) => setForm((f) => ({ ...f, ...patch }))
  return (
    <Card className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-end gap-3">
        <Input
          label="Contest size"
          type="number"
          numeric
          min={100}
          step={100}
          value={form.contestSize}
          onChange={(e) => set({ contestSize: e.target.value })}
          className="w-32"
        />
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg-muted">Entries</span>
          <Tabs
            variant="pill"
            value={form.mode}
            onChange={(mode) => set({ mode })}
            tabs={[
              { value: 'single', label: 'Single' },
              { value: 'multi', label: 'Multi' },
            ]}
          />
        </div>
        {form.mode === 'multi' && (
          <Input
            label="Lineups"
            type="number"
            numeric
            min={2}
            max={150}
            value={form.entries}
            onChange={(e) => set({ entries: e.target.value })}
            className="w-24"
          />
        )}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Toggle
          size="sm"
          checked={form.chalkCap}
          onChange={(chalkCap) => set({ chalkCap })}
          label="Chalk cap"
          description="At most 1 of the 3 highest-owned on 4-7 games, none on 8+"
        />
        <Toggle
          size="sm"
          checked={form.cheapMinutesFloor}
          onChange={(cheapMinutesFloor) => set({ cheapMinutesFloor })}
          label="Cheap-player minutes floor"
          description="No under-$5K player projected under 20 minutes"
        />
      </div>
      {isSmallSingleEntry(form) && <Caveat>{SHARPER_FIELD}</Caveat>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" disabled={!!blocked || running} loading={running} onClick={() => onRun(false)}>
          Run GPP sim
        </Button>
        <Button size="sm" disabled={!!blocked || running} onClick={() => onRun(true)} title="Drops players tagged OUT and anyone ruled out since the last sync (refreshes injury tags first)">
          Re-run at lock
        </Button>
        {blocked && <span className="text-xs text-fg-subtle">{blocked}</span>}
      </div>
      <p className="text-2xs text-fg-subtle">
        Picks the lineup with the best simulated win rate against a {Number(form.contestSize || 0).toLocaleString()}-entry field
        (own-model outcomes, common simulated nights). Runs take a few seconds to a few minutes.
      </p>
    </Card>
  )
}

function Progress({ state, onCancel }) {
  const progress = Math.round((state.progress || 0) * 100)
  const current = GPP_STAGE_ORDER.indexOf(state.stage)
  return (
    <Card className="flex flex-col gap-2 p-4" role="status" aria-live="polite">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg">
          {GPP_STAGE_LABELS[state.stage] || state.message || 'Working'}…{state.request?.atLock && ' (at lock)'}
        </h3>
        <span className="num text-xs text-fg-muted">{progress}%</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-surface-sunken"
        role="progressbar"
        aria-label="GPP sim progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(2, progress)}%` }} />
      </div>
      <ol className="flex flex-wrap gap-x-3 gap-y-1 text-2xs">
        {GPP_STAGE_ORDER.map((s, i) => (
          <li key={s} className={cn(i < current ? 'text-fg-muted' : i === current ? 'font-medium text-fg' : 'text-fg-subtle')}>
            {GPP_STAGE_LABELS[s]}
          </li>
        ))}
      </ol>
      <div>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  )
}

function LineupResult({ lineup, title, isBacktest, muted = false }) {
  const m = lineup.metrics
  return (
    <Card className={cn('flex flex-col gap-2 p-3', muted && 'opacity-80')} data-testid="gpp-lineup">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        <span className="num text-xs text-fg-muted">
          {formatSalary(lineup.totalSalary)} · {lineup.projectedPoints.toFixed(1)} proj · {m.totalOwnership.toFixed(0)}% own
          {m.dupes >= 0.5 && ` · ~${m.dupes.toFixed(1)} dupes`}
        </span>
      </div>
      <div className={cn('grid grid-cols-2 gap-2', isBacktest ? 'sm:grid-cols-5' : 'sm:grid-cols-4')}>
        {isBacktest && <Stat label="Actual" value={formatActual(lineup.actualPoints)} />}
        <Stat label="Win" value={ratePct(m.winRate)} />
        <Stat label="Top 1%" value={ratePct(m.top1Rate)} />
        <Stat label="Cash" value={ratePct(m.cashRate)} />
        <Stat label="Mean" value={m.meanScore.toFixed(1)} />
      </div>
      {lineup.why && <p className="text-xs text-fg-muted">{lineup.why}</p>}
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-x-4 gap-y-1 text-xs">
        {lineup.players.map((slot) => (
          <li key={slot.position} className="flex items-center gap-2">
            <Badge size="sm" className="w-10 justify-center">
              {slot.position}
            </Badge>
            <span className="min-w-0 flex-1 truncate text-fg">{slot.player.name}</span>
            <span className="num shrink-0 text-fg-muted">
              {formatSalary(slot.player.salary)} · {slot.player.rostership}%
            </span>
            {isBacktest && <span className="num shrink-0 font-medium text-fg">{formatActual(slot.player.actualPoints)}</span>}
          </li>
        ))}
      </ul>
    </Card>
  )
}

function Results({ state, slateId, onNotice }) {
  const { result } = state
  const isBacktest = !!state.request?.slateDate
  const [exporting, setExporting] = useState(false)
  const s = result.settings
  const lineups = result.lineups

  const exportLineups = async () => {
    setExporting(true)
    try {
      const res = await exportAPI.lineups({ site: PORTFOLIO_SITE, slateId, lineups: toExportLineups(lineups) })
      downloadText(res.data.filename, res.data.csv)
      const warnings = res.data.warnings || []
      onNotice?.({
        tone: warnings.length ? 'caution' : 'positive',
        text: `Exported ${res.data.count} GPP sim lineup${res.data.count === 1 ? '' : 's'} for DraftKings upload.`,
        details: warnings,
      })
    } catch (err) {
      onNotice?.({ tone: 'negative', text: `Export failed: ${errorMessage(err)}`, details: err.response?.data?.details })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-fg-muted">
          {s.contestSize.toLocaleString()} entries · {s.mode === 'multi' ? `${lineups.length} of ${s.entries} lineups` : 'single entry'} ·{' '}
          {result.candidateCount.toLocaleString()} candidates · {s.evalNights.toLocaleString()} nights · {result.slate.games} games
          {s.atLock && ' · at lock'}
          {s.chalkCap && ' · chalk cap'}
          {s.cheapMinutesFloor && ' · minutes floor'}
          {result.cached && ' · cached'}
        </p>
        <span title={isBacktest ? BACKTEST_DISABLED : undefined}>
          <Button size="sm" variant="primary" onClick={exportLineups} loading={exporting} disabled={isBacktest || lineups.length === 0}>
            Export {lineups.length} for DraftKings
          </Button>
        </span>
      </div>

      {result.caveat && <Caveat>{result.caveat}</Caveat>}
      {result.warnings?.length > 0 && (
        <div role="status" className="rounded-md border border-caution/40 bg-caution-soft px-3 py-2 text-xs text-caution">
          {result.warnings.join(' ')}
        </div>
      )}
      {result.slate.ruledOut?.length > 0 && (
        <p className="text-xs text-fg-muted">
          Ruled out ({result.slate.ruledOut.length}): {result.slate.ruledOut.map((p) => `${p.name} (${p.reason})`).join(', ')}
        </p>
      )}

      {lineups.map((l) => (
        <LineupResult
          key={l.lineupNumber}
          lineup={l}
          isBacktest={isBacktest}
          title={lineups.length > 1 ? `Lineup #${l.lineupNumber} · ${lineupNames(l.players)}` : 'Win-rate pick'}
        />
      ))}
      {result.maxProjection && (
        <LineupResult lineup={result.maxProjection} isBacktest={isBacktest} title="Max projection (comparison)" muted />
      )}
    </div>
  )
}

/**
 * GPP sim mode: form, background run (usePortfolioJob with portfolioAPI.gppSim), results with
 * export. job: the hook's return value. slateParams: { slateDate, ranges } in a backtest.
 */
export default function GppSimPanel({ job, slateId, slateParams, excluded, disabledReason, onNotice }) {
  const [form, setForm] = useState(GPP_SIM_DEFAULTS)
  const { state } = job
  const run = (atLock) => job.start(buildGppSimRequest(form, { slateId, slateParams, excluded, atLock }))

  return (
    <div className="flex flex-col gap-3">
      <SimForm form={form} setForm={setForm} onRun={run} running={job.running} disabledReason={disabledReason} />
      {job.running && <Progress state={state} onCancel={job.cancel} />}
      {state.status === 'failed' && (
        <div role="alert" className="rounded-md border border-negative/40 bg-negative-soft px-3 py-2 text-sm text-negative">
          GPP sim failed: {state.error}
        </div>
      )}
      {state.status === 'cancelled' && <p className="text-xs text-fg-muted">GPP sim cancelled.</p>}
      {state.status === 'completed' && state.result && <Results state={state} slateId={slateId} onNotice={onNotice} />}
    </div>
  )
}
