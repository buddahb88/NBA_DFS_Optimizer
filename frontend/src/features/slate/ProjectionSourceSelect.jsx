import { useEffect, useState } from 'react';
import { Badge, Tooltip, cn } from '../../components/ui';
import { projectionsAPI } from '../../services/api';
import { SOURCE_HINTS, SOURCE_LABELS } from './projectionSource';

/**
 * "Projections: RotoWire | Ours | Blend" control (GET / PUT
 * /api/projections/source). Server-wide like the sanity switch: the
 * optimizer, portfolio, chat, radar and player tables all follow it.
 * slateParams ({ slateId } or { slateDate, slateId } for a backtest) adds
 * the slate's counts: a caution badge when players kept RotoWire.
 * onChange(source) after a switch, so the page reloads its pool. Renders
 * nothing until the server answers.
 */
export default function ProjectionSourceSelect({ slateParams = null, onChange, className }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const paramsKey = JSON.stringify(slateParams ?? {});

  useEffect(() => {
    let cancelled = false;
    const params = JSON.parse(paramsKey);
    // .then() so a client without getSource (older mocks) just hides the control
    Promise.resolve()
      .then(() => projectionsAPI.getSource(params))
      .then((res) => !cancelled && setStatus(res?.data ?? null))
      .catch(() => !cancelled && setStatus(null));
    return () => {
      cancelled = true;
    };
  }, [paramsKey]);

  if (!status) return null;

  const pick = async (source) => {
    if (source === status.source || busy) return;
    setBusy(true);
    try {
      const res = await projectionsAPI.setSource({ source });
      setStatus((s) => ({ ...res.data, slate: s?.slate?.source === res.data.source ? s.slate : undefined }));
      onChange?.(res.data.source);
      // counts for the new source (runs the own model if it is cold)
      const params = JSON.parse(paramsKey);
      if (Object.keys(params).length) {
        projectionsAPI.getSource(params).then((r) => setStatus(r.data)).catch(() => {});
      }
    } catch {
      // keep the current state; the next load shows what the server has
    } finally {
      setBusy(false);
    }
  };

  const slate = status.slate;
  const fallback = slate && slate.source === status.source && slate.fallback > 0 ? slate.fallback : 0;
  const options = status.options || Object.keys(SOURCE_LABELS);
  const hint = `${SOURCE_HINTS[status.source] ?? ''} Server-wide: optimizer, portfolio, chat, radar and player tables follow it; resets to ${
    SOURCE_LABELS[status.default] ?? status.default
  } on restart.${slate && slate.source !== 'rotowire' ? ` This slate: ${slate.applied} of ${slate.players} players on ${SOURCE_LABELS[slate.source]}, ${slate.fades} fade call${slate.fades === 1 ? '' : 's'}.` : ''}`;

  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <Tooltip content={hint}>
        <span id="projection-source-label" className="cursor-help text-xs text-fg-muted">
          Projections
        </span>
      </Tooltip>
      <span role="radiogroup" aria-labelledby="projection-source-label" className="inline-flex rounded-md border border-line bg-surface-sunken p-0.5">
        {options.map((o) => {
          const active = o === status.source;
          return (
            <button
              key={o}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={busy}
              title={SOURCE_HINTS[o]}
              onClick={() => pick(o)}
              className={cn(
                'h-6 rounded px-2 text-xs font-medium transition-colors disabled:cursor-wait',
                active ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg',
              )}
            >
              {SOURCE_LABELS[o] ?? o}
            </button>
          );
        })}
      </span>
      {fallback > 0 && (
        <Tooltip content={slate.error ? `Own model unavailable: ${slate.error}` : `${fallback} player${fallback === 1 ? '' : 's'} not in the own model kept RotoWire.`}>
          <Badge tone="caution" size="sm" data-testid="source-fallback">
            {fallback} on RotoWire
          </Badge>
        </Tooltip>
      )}
    </span>
  );
}
