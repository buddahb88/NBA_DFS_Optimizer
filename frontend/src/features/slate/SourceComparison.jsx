import { useEffect, useState } from 'react';
import { Badge, Button, Card, Spinner, Tooltip, cn } from '../../components/ui';
import { optimizerAPI } from '../../services/api';
import { formatActual } from './backtest';
import { SOURCE_LABELS } from './projectionSource';

const fmt = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(d));
const signed = (v) => (v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}`);
const errorMessage = (err) => err?.response?.data?.error || err?.message || 'Comparison failed';

/** Index of the best row by `score` (higher better unless low), null when no row has a value. */
function bestIndex(rows, score, { low = false } = {}) {
  let best = null;
  rows.forEach((r, i) => {
    const v = score(r);
    if (v === null || v === undefined || !Number.isFinite(v)) return;
    if (best === null || (low ? v < score(rows[best]) : v > score(rows[best]))) best = i;
  });
  return best;
}

/**
 * Backtest panel: the last optimizer request run once per projection source
 * (POST /api/optimizer/compare-sources) - lineup projected / actual totals and
 * the pool's projection MAE (incl. DNP, and played only) side by side, the
 * best of each column marked. request: the generate body (null disables).
 */
export default function SourceComparison({ request, className }) {
  const [state, setState] = useState({ status: 'idle' });
  const requestKey = JSON.stringify(request ?? null);

  // A new request (or slate) makes an old comparison stale
  useEffect(() => setState({ status: 'idle' }), [requestKey]);

  const run = async () => {
    setState({ status: 'loading' });
    try {
      const res = await optimizerAPI.compareSources(JSON.parse(requestKey));
      setState({ status: 'done', data: res.data });
    } catch (err) {
      setState({ status: 'error', error: errorMessage(err) });
    }
  };

  const rows = state.data?.sources ?? [];
  const bestActual = bestIndex(rows, (r) => r.bestActual);
  const bestAvg = bestIndex(rows, (r) => r.avgActual);
  const bestMae = bestIndex(rows, (r) => r.accuracy?.mae, { low: true });
  const bestPlayed = bestIndex(rows, (r) => r.accuracy?.playedMae, { low: true });
  const mark = (i, best) => (i === best ? 'font-semibold text-positive' : undefined);

  return (
    <Card className={cn('p-3', className)} data-testid="source-comparison">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-fg">Compare projection sources</h3>
          <p className="text-xs text-fg-muted">The same settings with RotoWire, our model and the blend: lineup actuals and projection error on this night.</p>
        </div>
        <Button size="sm" onClick={run} disabled={!request || state.status === 'loading'} loading={state.status === 'loading'}>
          {state.status === 'done' ? 'Re-run' : 'Compare sources'}
        </Button>
      </div>

      {state.status === 'loading' && (
        <div className="mt-2 flex items-center gap-2 text-xs text-fg-muted" role="status">
          <Spinner size="xs" /> Running the optimizer three times…
        </div>
      )}
      {state.status === 'error' && <p className="mt-2 text-xs text-negative">{state.error}</p>}

      {state.status === 'done' && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-fg-muted">
              <tr className="border-b border-line text-right">
                <th className="py-1 text-left font-medium">Source</th>
                <th className="py-1 font-medium">Lineups</th>
                <th className="py-1 font-medium">Top proj</th>
                <th className="py-1 font-medium">Best actual</th>
                <th className="py-1 font-medium">Avg actual</th>
                <th className="py-1 font-medium">MAE (incl. DNP)</th>
                <th className="py-1 font-medium">MAE played</th>
                <th className="py-1 font-medium">Bias</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.source} className="border-b border-line/60 text-right tabular-nums" data-testid={`source-row-${r.source}`}>
                  <td className="py-1 text-left">
                    <span className="font-medium text-fg">{SOURCE_LABELS[r.source] ?? r.source}</span>
                    {r.summary?.fallback > 0 && (
                      <Tooltip content={r.summary.error ? `Own model unavailable: ${r.summary.error}` : `${r.summary.fallback} player(s) kept RotoWire`}>
                        <Badge tone="caution" size="sm" className="ml-1">{r.summary.fallback} RW</Badge>
                      </Tooltip>
                    )}
                  </td>
                  <td>{r.lineups}</td>
                  <td>{fmt(r.topProjected)}</td>
                  <td className={mark(i, bestActual)}>
                    {r.topLineup ? (
                      <Tooltip content={r.topLineup.players.map((p) => `${p.position} ${p.name} ${fmt(p.projected)} → ${formatActual(p.actual)}`).join(' · ')}>
                        <span className="cursor-help underline decoration-dotted underline-offset-2">{formatActual(r.bestActual)}</span>
                      </Tooltip>
                    ) : (
                      formatActual(r.bestActual)
                    )}
                  </td>
                  <td className={mark(i, bestAvg)}>{formatActual(r.avgActual)}</td>
                  <td className={mark(i, bestMae)}>{fmt(r.accuracy?.mae, 2)}</td>
                  <td className={mark(i, bestPlayed)}>{fmt(r.accuracy?.playedMae, 2)}</td>
                  <td>{signed(r.accuracy?.bias)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-2xs text-fg-subtle">
            MAE over the {rows[0]?.accuracy?.n ?? 0} pool players with a result (DNP scores 0). One night is noisy: the M4 backtest over 8 slates is the evidence.
          </p>
        </div>
      )}
    </Card>
  );
}
