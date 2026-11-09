import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, IconX, Input, Spinner, Toggle } from '../../components/ui';
import { pickLogAPI } from '../../services/api';
import {
  cashResult,
  errorMessage,
  fmtPct,
  fmtPts,
  fmtSalary,
  isBackfill,
  nightLabel,
  parseScore,
  pickStatus,
  sourceLabel,
} from './modelLog';

const NOTICE_TONES = {
  positive: 'border-positive/30 bg-positive-soft text-positive',
  negative: 'border-negative/30 bg-negative-soft text-negative',
  info: 'border-info/30 bg-info-soft text-info',
};

function Notice({ notice, onDismiss }) {
  if (!notice) return null;
  return (
    <div
      role={notice.tone === 'negative' ? 'alert' : 'status'}
      className={`flex items-start justify-between gap-3 rounded border px-3 py-2 text-xs ${NOTICE_TONES[notice.tone]}`}
    >
      <span className="break-words">{notice.text}</span>
      <button type="button" aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100" onClick={onDismiss}>
        <IconX size={12} />
      </button>
    </div>
  );
}

function SummaryCard({ summary }) {
  return (
    <Card>
      <CardHeader
        title="Running totals by source"
        subtitle="Forward picks were logged before lock; backfill picks were built after the fact and may be in-sample."
      />
      <CardBody className="overflow-x-auto p-0">
        {summary.length === 0 ? (
          <EmptyState compact title="No picks logged yet" description="Picks are logged automatically shortly before the DraftKings main slate locks." />
        ) : (
          <table className="w-full text-xs" aria-label="Running totals">
            <thead className="text-2xs uppercase tracking-wider text-fg-subtle">
              <tr className="border-b border-line">
                <th className="px-3 py-1.5 text-left">Source</th>
                <th className="px-2 py-1.5 text-right">Nights</th>
                <th className="px-2 py-1.5 text-right">Avg score</th>
                <th className="px-2 py-1.5 text-right">Avg proj</th>
                <th className="px-2 py-1.5 text-right">Best</th>
                <th className="px-2 py-1.5 text-right">Worst</th>
                <th className="px-2 py-1.5 text-right">Avg DNPs</th>
                <th className="px-2 py-1.5 text-right" title="Estimated: percentile in an ownership-sampled field">Est. field %ile</th>
                <th className="px-3 py-1.5 text-right" title="Nights cashed / nights with an entered cash line">Cashed</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((s) => (
                <tr key={s.source} className="border-b border-line last:border-0" data-testid={`summary-${s.source}`}>
                  <td className="px-3 py-1.5">
                    <span className="flex items-center gap-1.5">
                      {sourceLabel(s.source)}
                      {s.isForward ? <Badge tone="positive" size="sm">Forward</Badge> : <Badge tone="caution" size="sm">Backfill</Badge>}
                    </span>
                  </td>
                  <td className="num px-2 py-1.5 text-right">
                    {s.nights}
                    {s.logged > s.nights && <span className="text-fg-subtle"> (+{s.logged - s.nights} pending)</span>}
                  </td>
                  <td className="num px-2 py-1.5 text-right font-semibold">{fmtPts(s.avgActual)}</td>
                  <td className="num px-2 py-1.5 text-right text-fg-muted">{fmtPts(s.avgProjected)}</td>
                  <td className="num px-2 py-1.5 text-right">{s.best ? `${fmtPts(s.best.actualPoints)} (${nightLabel(s.best.gameDate)})` : '—'}</td>
                  <td className="num px-2 py-1.5 text-right">{s.worst ? `${fmtPts(s.worst.actualPoints)} (${nightLabel(s.worst.gameDate)})` : '—'}</td>
                  <td className="num px-2 py-1.5 text-right">{fmtPts(s.avgDnp)}</td>
                  <td className="num px-2 py-1.5 text-right">{fmtPct(s.avgFieldPercentile)}</td>
                  <td className="num px-3 py-1.5 text-right">{s.nightsWithCashLine ? `${s.cashed}/${s.nightsWithCashLine}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardBody>
    </Card>
  );
}

function PickLineup({ pick }) {
  return (
    <table className="mt-1 w-full text-2xs" aria-label={`${sourceLabel(pick.source)} lineup`}>
      <tbody>
        {pick.lineup.map((p) => (
          <tr key={p.player_key} className="border-t border-line/60">
            <td className="w-10 py-0.5 text-fg-subtle">{p.slot ?? p.position}</td>
            <td className="py-0.5">
              {p.name}
              {p.status && p.status !== 'PLAYED' && (
                <Badge tone="negative" size="sm" className="ml-1">DNP</Badge>
              )}
            </td>
            <td className="num py-0.5 text-right text-fg-muted">{fmtSalary(p.salary)}</td>
            <td className="num py-0.5 text-right text-fg-muted">{fmtPts(p.projected_points)}</td>
            <td className="num py-0.5 text-right">{p.actual_points !== undefined ? fmtPts(p.actual_points) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PickRow({ pick, contest }) {
  const [open, setOpen] = useState(false);
  const status = pickStatus(pick);
  const cash = cashResult(pick, contest);
  return (
    <li className="rounded border border-line px-2.5 py-2" data-testid={`pick-${pick.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          {sourceLabel(pick.source)}
          {isBackfill(pick.source) && <Badge tone="caution" size="sm">Not forward</Badge>}
        </span>
        <span className="flex flex-wrap items-center gap-3 text-xs">
          <span className="text-fg-muted">proj <span className="num text-fg">{fmtPts(pick.projectedPoints)}</span></span>
          {status === 'scored' ? (
            <>
              <span className="text-fg-muted">actual <span className="num font-semibold text-fg">{fmtPts(pick.actualPoints)}</span></span>
              <span className="text-fg-muted">DNPs <span className={`num ${pick.dnpCount ? 'text-negative' : 'text-fg'}`}>{pick.dnpCount ?? 0}</span></span>
              <span className="text-fg-muted" title="Estimated percentile in an ownership-sampled field">
                est. %ile <span className="num text-fg">{fmtPct(pick.fieldPercentile)}</span>
              </span>
              {cash && <Badge tone={cash === 'cashed' ? 'positive' : 'negative'} size="sm">{cash === 'cashed' ? 'Cashed' : 'Missed cash'}</Badge>}
            </>
          ) : (
            <Badge tone="info" size="sm">Awaiting box scores</Badge>
          )}
          <Button size="xs" variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? 'Hide lineup' : 'Lineup'}
          </Button>
        </span>
      </div>
      {open && <PickLineup pick={pick} />}
    </li>
  );
}

function ContestForm({ night, onSave }) {
  const [cashLine, setCashLine] = useState(night.contest?.cashLine ?? '');
  const [winningScore, setWinningScore] = useState(night.contest?.winningScore ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    const cash = parseScore(cashLine);
    const win = parseScore(winningScore);
    if (Number.isNaN(cash) || Number.isNaN(win)) {
      setError('Enter scores as positive numbers');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave({ site: night.site, slateId: night.slateId, gameDate: night.gameDate, cashLine: cash, winningScore: win });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2" aria-label={`Contest results ${night.gameDate}`}>
      <Input label="Cash line" numeric inputMode="decimal" value={cashLine} onChange={(e) => setCashLine(e.target.value)} className="w-24" />
      <Input label="Winning score" numeric inputMode="decimal" value={winningScore} onChange={(e) => setWinningScore(e.target.value)} className="w-28" />
      <Button type="submit" size="sm" loading={saving}>Save</Button>
      {error && <span role="alert" className="text-2xs text-negative">{error}</span>}
    </form>
  );
}

function NightCard({ night, onSaveContest }) {
  const entered = night.contest && (night.contest.cashLine !== null || night.contest.winningScore !== null);
  return (
    <Card data-testid={`night-${night.gameDate}`}>
      <CardHeader
        title={`${nightLabel(night.gameDate)} · slate ${night.slateId}`}
        subtitle={
          entered
            ? `Entered: cash line ${fmtPts(night.contest.cashLine)}, winning score ${fmtPts(night.contest.winningScore)}`
            : 'Cash line not entered: field percentiles are estimates'
        }
      />
      <CardBody className="flex flex-col gap-3">
        <ul className="flex flex-col gap-2">
          {night.picks.map((p) => <PickRow key={p.id} pick={p} contest={night.contest} />)}
        </ul>
        <ContestForm night={night} onSave={onSaveContest} />
      </CardBody>
    </Card>
  );
}

/**
 * Model Log: per night the lineups our pickers logged before lock, what they
 * scored, DNPs, and running totals per source. Backfill picks (built after
 * the fact) are flagged and can be hidden.
 */
export default function ModelLogPage() {
  const [report, setReport] = useState({ status: 'loading', data: null, error: null });
  const [showBackfill, setShowBackfill] = useState(true);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    setReport((r) => ({ ...r, status: 'loading', error: null }));
    try {
      const { data } = await pickLogAPI.getReport(showBackfill ? {} : { forward: true });
      setReport({ status: 'ready', data, error: null });
    } catch (err) {
      setReport({ status: 'error', data: null, error: errorMessage(err) });
    }
  }, [showBackfill]);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (kind) => {
    setBusy(kind);
    setNotice(null);
    try {
      if (kind === 'log') {
        const { data } = await pickLogAPI.logNow();
        const parts = (data.results ?? []).map((r) => `${sourceLabel(r.source)}: ${r.status}${r.error ? ` (${r.error})` : ''}`);
        const failed = (data.results ?? []).some((r) => r.status === 'error');
        setNotice({ tone: failed ? 'negative' : 'positive', text: `Slate ${data.slateId} (${data.slateDate}) — ${parts.join(', ')}` });
      } else {
        const { data } = await pickLogAPI.score();
        setNotice({ tone: 'info', text: `Scored ${data.scored}, still pending ${data.pending}${data.errors?.length ? `, ${data.errors.length} errors` : ''}` });
      }
      await load();
    } catch (err) {
      setNotice({ tone: 'negative', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const saveContest = async (body) => {
    await pickLogAPI.saveNight(body);
    setNotice({ tone: 'positive', text: `Saved contest results for ${body.gameDate}` });
    await load();
  };

  const data = report.data;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-fg">Model log</h1>
          <p className="max-w-2xl text-xs text-fg-muted">
            Lineups our models picked before lock, scored from the box scores the next day. Field percentiles are
            estimates from an ownership-sampled field; enter a night’s real cash line and winning score to calibrate them.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Toggle checked={showBackfill} onChange={setShowBackfill} label="Show backfill" />
          <Button size="sm" variant="secondary" loading={busy === 'score'} disabled={busy !== null} onClick={() => run('score')}>
            Score now
          </Button>
          <Button size="sm" variant="primary" loading={busy === 'log'} disabled={busy !== null} onClick={() => run('log')}>
            Log picks now
          </Button>
        </div>
      </div>

      <Notice notice={notice} onDismiss={() => setNotice(null)} />

      {report.status === 'loading' && !data && (
        <div className="flex justify-center py-16"><Spinner size="md" /></div>
      )}
      {report.status === 'error' && (
        <p role="alert" className="rounded border border-negative/30 bg-negative-soft px-3 py-2 text-xs text-negative">
          Couldn’t load the model log: {report.error}
        </p>
      )}
      {data && (
        <>
          <SummaryCard summary={data.summary ?? []} />
          {(data.nights ?? []).map((night) => (
            <NightCard key={`${night.site}-${night.slateId}-${night.gameDate}`} night={night} onSaveContest={saveContest} />
          ))}
        </>
      )}
    </div>
  );
}
