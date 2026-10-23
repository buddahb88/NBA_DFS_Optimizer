import { useEffect, useState } from 'react';
import { Button, Select, Spinner } from '../../components/ui';
import { slatesAPI } from '../../services/api';

/**
 * Pick a RotoWire slate and import it. Importing replaces the active slate
 * (single-active-slate model on the backend). disabledReason (e.g. backtest
 * mode) turns the import off and says why.
 */
export default function SlateLoader({ onLoad, loading, error, activeSlateId, submitLabel = 'Load slate', className, disabledReason = null }) {
  const [slates, setSlates] = useState([]);
  const [selected, setSelected] = useState('');
  const [fetching, setFetching] = useState(true);
  const [fetchError, setFetchError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    slatesAPI
      .getAvailableSlates()
      .then(({ data }) => {
        if (cancelled) return;
        const list = Array.isArray(data) ? data : [];
        setSlates(list);
        const initial = list.find((s) => s.slateId === activeSlateId) ?? list.find((s) => s.isDefault) ?? list[0];
        if (initial) setSelected(initial.slateId);
      })
      .catch(() => !cancelled && setFetchError('Could not load slates from RotoWire. Check the RotoWire cookie configuration.'))
      .finally(() => !cancelled && setFetching(false));
    return () => {
      cancelled = true;
    };
  }, [activeSlateId]);

  const slate = slates.find((s) => s.slateId === selected);

  if (fetching) {
    return (
      <div className={className}>
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <Spinner size="xs" /> Fetching available slates…
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      {fetchError || slates.length === 0 ? (
        <p className="text-xs text-caution">{fetchError ?? 'No slates available from RotoWire right now.'}</p>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Select
            label="Slate"
            className="min-w-0 flex-1"
            value={selected}
            disabled={loading}
            onChange={(e) => setSelected(e.target.value)}
            options={slates.map((s) => ({
              value: s.slateId,
              label: `${s.name} · ${s.startTime ?? ''} · ${s.games ?? '?'} games`,
            }))}
          />
          <span title={disabledReason ?? undefined}>
            <Button
              variant="primary"
              loading={loading}
              disabled={!slate || !!disabledReason}
              onClick={() => slate && onLoad({ slateId: slate.slateId, name: slate.name })}
            >
              {loading ? 'Importing…' : submitLabel}
            </Button>
          </span>
        </div>
      )}
      {disabledReason && <p className="mt-2 text-xs text-caution">{disabledReason}</p>}
      {error && <p className="mt-2 text-xs text-negative">{error}</p>}
    </div>
  );
}
