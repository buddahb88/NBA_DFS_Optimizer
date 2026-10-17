import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { exportAPI, lineupsAPI, optimizerAPI, playersAPI } from '../services/api';
import { useSlate } from '../context/SlateContext';
import {
  Button,
  Card,
  EmptyState,
  IconBolt,
  IconInfo,
  IconX,
  Modal,
  Select,
  Spinner,
  Stat,
  Tabs,
  cn,
} from '../components/ui';
import SettingsPanel from '../features/lineupStudio/SettingsPanel';
import LineupCard from '../features/lineupStudio/LineupCard';
import ExposurePanel from '../features/lineupStudio/ExposurePanel';
import PlayerPoolTable from '../features/lineupStudio/PlayerPoolTable';
import ManualBuilder from '../features/lineupStudio/ManualBuilder';
import { settingsFromPreset } from '../features/lineupStudio/presets';
import { validateDraftRules } from '../features/lineupStudio/stackRules';
import { buildOptimizerRequest } from '../features/lineupStudio/request';
import {
  FALLBACK_SITE,
  downloadText,
  emptySlots,
  formatSalary,
  lineupTotals,
  normalizeLineup,
  slotsFromLineup,
} from '../features/lineupStudio/lineupMath';

const SORTS = [
  { value: 'number', label: 'Lineup #' },
  { value: 'projection', label: 'Projection' },
  { value: 'ownership', label: 'Lowest ownership' },
  { value: 'salary', label: 'Salary used' },
];

const errorMessage = (err) => err.response?.data?.error || err.response?.data?.message || err.message;
const toggleIn = (set, value) => {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
};

function Notice({ notice, onDismiss }) {
  const tone = {
    positive: 'border-positive/40 bg-positive-soft text-positive',
    negative: 'border-negative/40 bg-negative-soft text-negative',
    caution: 'border-caution/40 bg-caution-soft text-caution',
    info: 'border-info/40 bg-info-soft text-info',
  }[notice.tone];
  return (
    <div role={notice.tone === 'negative' ? 'alert' : 'status'} className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-sm', tone)}>
      <IconInfo size={15} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p>{notice.text}</p>
        {notice.details?.length > 0 && (
          <ul className="mt-1 list-disc pl-4 text-xs opacity-90">
            {notice.details.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        )}
      </div>
      <button type="button" aria-label="Dismiss" onClick={onDismiss} className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100">
        <IconX size={14} />
      </button>
    </div>
  );
}

function CenteredState({ children }) {
  return <Card className="flex min-h-[320px] items-center justify-center">{children}</Card>;
}

/**
 * Lineup Studio: optimizer settings + results, and a manual click-to-fill
 * builder (?mode=manual). Site and slate come from the top bar (SlateContext).
 */
export default function LineupStudioPage() {
  const { slate, slateId, site, siteConfig: contextSiteConfig, loadingSlates } = useSlate();
  const siteConfig = contextSiteConfig || FALLBACK_SITE;
  const salaryCap = siteConfig.salaryCap;
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get('mode') === 'manual' ? 'manual' : 'optimize';
  const setView = (v) => setSearchParams(v === 'manual' ? { mode: 'manual' } : {}, { replace: true });

  // Player pool
  const [pool, setPool] = useState({ status: 'idle', players: [], error: null });
  const [poolVersion, setPoolVersion] = useState(0);
  const slateRef = useRef(slateId);

  // Optimizer
  const [settings, setSettings] = useState(() => settingsFromPreset('cash', salaryCap));
  const [locked, setLocked] = useState(() => new Set());
  const [excluded, setExcluded] = useState(() => new Set());
  const [run, setRun] = useState({ status: 'idle' });
  const [tab, setTab] = useState('lineups');
  const [selected, setSelected] = useState(() => new Set());
  const [saved, setSaved] = useState(() => new Set());
  const [savingKeys, setSavingKeys] = useState(() => new Set());
  const [sortBy, setSortBy] = useState('number');
  const [exporting, setExporting] = useState(false);

  // Manual builder
  const [manualSlots, setManualSlots] = useState(() => emptySlots(siteConfig));
  const [manualSaving, setManualSaving] = useState(false);

  // Header actions / AI
  const [notice, setNotice] = useState(null);
  const [projectionBusy, setProjectionBusy] = useState(false);
  const [breakdown, setBreakdown] = useState({ open: false, loading: false, text: '' });
  const [review, setReview] = useState({ key: null, loading: false, text: '' });

  // New slate: drop everything slate-specific and load its players
  useEffect(() => {
    slateRef.current = slateId;
    setLocked(new Set());
    setExcluded(new Set());
    setRun({ status: 'idle' });
    setSelected(new Set());
    setSaved(new Set());
    setNotice(null);
    setBreakdown({ open: false, loading: false, text: '' });
  }, [slateId]);

  useEffect(() => {
    if (!slateId) {
      setPool({ status: 'idle', players: [], error: null });
      return undefined;
    }
    let cancelled = false;
    setPool((p) => ({ status: 'loading', players: p.players, error: null }));
    playersAPI
      .getBySlateId(slateId)
      .then((res) => !cancelled && setPool({ status: 'ready', players: res.data || [], error: null }))
      .catch((err) => !cancelled && setPool({ status: 'error', players: [], error: errorMessage(err) }));
    return () => {
      cancelled = true;
    };
  }, [slateId, poolVersion]);

  // Site switch: new roster shape and salary scale
  const prevCap = useRef(salaryCap);
  useEffect(() => {
    setManualSlots(emptySlots(siteConfig));
    if (prevCap.current !== salaryCap) {
      const ratio = salaryCap / prevCap.current;
      const step = salaryCap >= 10000 ? 100 : 1;
      setSettings((s) => ({ ...s, minSalary: Math.floor((s.minSalary * ratio) / step) * step }));
      prevCap.current = salaryCap;
    }
  }, [siteConfig, salaryCap]);

  const players = pool.players;
  const stackErrors = useMemo(() => validateDraftRules(settings.stackRules), [settings.stackRules]);
  const hasStackErrors = Object.keys(stackErrors).length > 0;

  const updateSettings = useCallback((patch) => setSettings((s) => ({ ...s, ...patch, preset: 'custom' })), []);
  const applyPreset = (key) => key !== 'custom' && setSettings(settingsFromPreset(key, salaryCap));

  const toggleLock = useCallback((id) => {
    setLocked((s) => toggleIn(s, id));
    setExcluded((s) => (s.has(id) ? toggleIn(s, id) : s));
  }, []);
  const toggleExclude = useCallback((id) => {
    setExcluded((s) => toggleIn(s, id));
    setLocked((s) => (s.has(id) ? toggleIn(s, id) : s));
  }, []);

  const generate = async () => {
    const requestSlate = slateId;
    setRun({ status: 'loading', requested: settings.numLineups });
    setSelected(new Set());
    setSaved(new Set());
    setTab('lineups');
    setNotice(null);
    try {
      const res = await optimizerAPI.generate(
        buildOptimizerRequest({ slateId, site, settings, locked, excluded }),
      );
      if (slateRef.current !== requestSlate) return;
      const stamp = Date.now();
      const lineups = (res.data.lineups || []).map((l, i) => ({
        key: `${stamp}-${i}`,
        number: l.lineupNumber ?? i + 1,
        slots: normalizeLineup(l),
        raw: l,
      }));
      const warnings = res.data.warnings || [];
      if (lineups.length === 0) {
        setRun({
          status: 'error',
          error: res.data.error || 'The optimizer found no valid lineups.',
          details: [...warnings, 'Try relaxing pool filters, stack rules or locks.'],
        });
      } else {
        setRun({ status: 'done', lineups, warnings, requested: settings.numLineups, maxExposure: settings.maxExposure });
      }
    } catch (err) {
      if (slateRef.current !== requestSlate) return;
      setRun({ status: 'error', error: errorMessage(err), details: err.response?.data?.details || [] });
    }
  };

  const lineups = useMemo(() => (run.status === 'done' ? run.lineups : []), [run]);
  const sortedLineups = useMemo(() => {
    if (sortBy === 'number') return lineups;
    const metric = (l) => {
      const t = lineupTotals(l.slots, salaryCap);
      return sortBy === 'projection' ? -t.projection : sortBy === 'ownership' ? t.ownership : -t.salary;
    };
    return [...lineups].sort((a, b) => metric(a) - metric(b));
  }, [lineups, sortBy, salaryCap]);
  const lineupSlots = useMemo(() => lineups.map((l) => l.slots), [lineups]);
  const target = selected.size ? lineups.filter((l) => selected.has(l.key)) : lineups;

  const summary = useMemo(() => {
    if (!lineups.length) return null;
    const totals = lineups.map((l) => lineupTotals(l.slots, salaryCap));
    const avg = (f) => totals.reduce((s, t) => s + f(t), 0) / totals.length;
    return {
      avgProj: avg((t) => t.projection),
      topProj: Math.max(...totals.map((t) => t.projection)),
      avgOwn: avg((t) => t.ownership),
      avgSalary: avg((t) => t.salary),
    };
  }, [lineups, salaryCap]);

  const saveLineup = (slots, name) =>
    lineupsAPI.create({
      slateId,
      site,
      name,
      players: slots.map(({ slot, player }) => ({ ...player, positionSlot: slot, projectedPoints: player.projected_points })),
    });

  const saveLineups = async (list) => {
    const keys = list.map((l) => l.key);
    setSavingKeys((s) => new Set([...s, ...keys]));
    const prefix = settings.mode === 'cash' ? 'Cash' : 'GPP';
    let ok = 0;
    const failures = [];
    for (const l of list) {
      try {
        await saveLineup(l.slots, `${prefix} #${l.number}`);
        ok += 1;
        setSaved((s) => new Set(s).add(l.key));
      } catch (err) {
        failures.push(`#${l.number}: ${errorMessage(err)}`);
      }
    }
    setSavingKeys((s) => new Set([...s].filter((k) => !keys.includes(k))));
    setNotice(
      failures.length
        ? { tone: 'negative', text: `Saved ${ok} of ${list.length} lineups.`, details: failures }
        : { tone: 'positive', text: `Saved ${ok} lineup${ok === 1 ? '' : 's'}. Find them on the Lineups page.` },
    );
  };

  const exportLineups = async (slotLists) => {
    setExporting(true);
    try {
      const res = await exportAPI.lineups({
        site,
        slateId,
        lineups: slotLists.map((slots) => ({ players: slots.map(({ slot, player }) => ({ slot, playerId: player.id })) })),
      });
      downloadText(res.data.filename, res.data.csv);
      const warnings = res.data.warnings || [];
      setNotice({
        tone: warnings.length ? 'caution' : 'positive',
        text: `Exported ${res.data.count} lineup${res.data.count === 1 ? '' : 's'} for ${siteConfig.name} upload.`,
        details: warnings,
      });
    } catch (err) {
      setNotice({ tone: 'negative', text: `Export failed: ${errorMessage(err)}`, details: err.response?.data?.details });
    } finally {
      setExporting(false);
    }
  };

  const manualEntries = () => siteConfig.rosterSlots.map((s, i) => ({ slot: s.slot, player: manualSlots[i] }));

  const saveManual = async (name) => {
    setManualSaving(true);
    try {
      await saveLineup(manualEntries(), name);
      setNotice({ tone: 'positive', text: `Saved "${name}". Find it on the Lineups page.` });
    } catch (err) {
      setNotice({ tone: 'negative', text: `Save failed: ${errorMessage(err)}`, details: err.response?.data?.details });
    } finally {
      setManualSaving(false);
    }
  };

  const editInBuilder = (lineup) => {
    setManualSlots(slotsFromLineup(siteConfig, lineup.slots));
    setView('manual');
  };

  const reviewLineup = async (lineup) => {
    setReview({ key: lineup.key, loading: true, text: '' });
    try {
      const res = await optimizerAPI.reviewLineup(slateId, lineup.raw, settings.mode);
      setReview({ key: lineup.key, loading: false, text: res.data.review || 'No review returned.', number: lineup.number });
    } catch (err) {
      setReview({ key: null, loading: false, text: '' });
      setNotice({ tone: 'negative', text: `AI review failed: ${errorMessage(err)}` });
    }
  };

  const runBreakdown = async () => {
    setBreakdown({ open: true, loading: true, text: '' });
    try {
      const res = await optimizerAPI.slateBreakdown(slateId, settings.mode);
      setBreakdown({ open: true, loading: false, text: res.data.aiAnalysis || 'No analysis returned.' });
    } catch (err) {
      setBreakdown({ open: false, loading: false, text: '' });
      setNotice({ tone: 'negative', text: `AI breakdown failed: ${errorMessage(err)}` });
    }
  };

  const projections = async (action) => {
    setProjectionBusy(true);
    try {
      const res = action === 'reset' ? await playersAPI.resetProjections(slateId) : await playersAPI.recalculateProjections(slateId);
      setNotice({ tone: 'positive', text: res.data.message || 'Projections updated.' });
      setPoolVersion((v) => v + 1);
    } catch (err) {
      setNotice({ tone: 'negative', text: `Projection update failed: ${errorMessage(err)}` });
    } finally {
      setProjectionBusy(false);
    }
  };

  const generateBlocker = !slateId
    ? 'Pick a slate in the top bar.'
    : pool.status !== 'ready'
      ? 'Waiting for the player pool.'
      : hasStackErrors
        ? 'Fix the stack rule errors above.'
        : settings.minSalary > salaryCap
          ? `Min salary is above the ${formatSalary(salaryCap)} cap.`
          : null;

  // ---- render -------------------------------------------------------------

  let body;
  if (!slateId) {
    body = loadingSlates ? (
      <CenteredState>
        <Spinner size="md" />
      </CenteredState>
    ) : (
      <CenteredState>
        <EmptyState
          title="No slate selected"
          description="Pick a site and slate in the top bar, or import today's slate from the dashboard."
          action={
            <Link to="/">
              <Button variant="primary" size="sm">
                Go to dashboard
              </Button>
            </Link>
          }
        />
      </CenteredState>
    );
  } else if (pool.status === 'loading' && players.length === 0) {
    body = (
      <CenteredState>
        <div className="flex flex-col items-center gap-2 text-sm text-fg-muted">
          <Spinner size="md" />
          Loading player pool…
        </div>
      </CenteredState>
    );
  } else if (pool.status === 'error') {
    body = (
      <CenteredState>
        <EmptyState
          title="Couldn't load players"
          description={pool.error}
          action={
            <Button size="sm" onClick={() => setPoolVersion((v) => v + 1)}>
              Retry
            </Button>
          }
        />
      </CenteredState>
    );
  } else if (pool.status === 'ready' && players.length === 0) {
    body = (
      <CenteredState>
        <EmptyState
          title="No projected players on this slate"
          description="Sync players and projections for this slate from the dashboard or Player Pool, then come back."
        />
      </CenteredState>
    );
  } else if (view === 'manual') {
    body = (
      <ManualBuilder
        siteConfig={siteConfig}
        players={players}
        slots={manualSlots}
        onSlotsChange={setManualSlots}
        onSave={saveManual}
        onExport={() => exportLineups([manualEntries()])}
        saving={manualSaving}
        exporting={exporting}
      />
    );
  } else {
    body = (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside>
          <Card className="scrollbar-thin overflow-y-auto lg:sticky lg:top-4 lg:max-h-[calc(100vh-8rem)]">
            <SettingsPanel
              settings={settings}
              onChange={updateSettings}
              onPreset={applyPreset}
              stackErrors={stackErrors}
              players={players}
              siteConfig={siteConfig}
              lockedCount={locked.size}
              excludedCount={excluded.size}
              onGenerate={generate}
              generating={run.status === 'loading'}
              canGenerate={!generateBlocker && run.status !== 'loading'}
              disabledReason={generateBlocker}
            />
          </Card>
        </aside>

        <section className="min-w-0">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'lineups', label: 'Lineups', count: lineups.length || undefined },
              { value: 'exposure', label: 'Exposure', disabled: lineups.length === 0 },
              { value: 'pool', label: 'Player pool', count: locked.size + excluded.size || undefined },
            ]}
          />
          <div className="pt-3">
            {tab === 'pool' && (
              <PlayerPoolTable
                players={players}
                locked={locked}
                excluded={excluded}
                onToggleLock={toggleLock}
                onToggleExclude={toggleExclude}
                onClear={() => {
                  setLocked(new Set());
                  setExcluded(new Set());
                }}
              />
            )}

            {tab === 'exposure' && <ExposurePanel lineups={lineupSlots} maxExposure={run.maxExposure} />}

            {tab === 'lineups' && run.status === 'idle' && (
              <CenteredState>
                <EmptyState
                  icon={<IconBolt size={18} />}
                  title="No lineups yet"
                  description="Pick a contest type, tune the settings and stack rules, then Generate. Lock or exclude players on the Player pool tab."
                />
              </CenteredState>
            )}

            {tab === 'lineups' && run.status === 'loading' && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2 text-sm text-fg-muted" role="status">
                  <Spinner size="sm" />
                  Solving {run.requested} lineup{run.requested === 1 ? '' : 's'}…
                  {run.requested > 20 && <span className="text-xs text-fg-subtle">Large batches can take a minute.</span>}
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3" aria-hidden="true">
                  {Array.from({ length: Math.min(run.requested, 6) }, (_, i) => (
                    <div key={i} className="h-80 animate-pulse rounded-md border border-line bg-surface" />
                  ))}
                </div>
              </div>
            )}

            {tab === 'lineups' && run.status === 'error' && (
              <Card className="border-negative/50 p-4">
                <h3 className="text-sm font-semibold text-negative">Optimization failed</h3>
                <p className="mt-1 text-sm text-fg">{run.error}</p>
                {run.details?.length > 0 && (
                  <ul className="mt-2 list-disc pl-5 text-xs text-fg-muted">
                    {run.details.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                )}
                <Button className="mt-3" size="sm" onClick={generate} disabled={!!generateBlocker}>
                  Try again
                </Button>
              </Card>
            )}

            {tab === 'lineups' && run.status === 'done' && (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  <Stat label="Lineups" value={lineups.length} hint={lineups.length < run.requested ? `of ${run.requested} requested` : undefined} />
                  <Stat label="Avg projection" value={summary.avgProj.toFixed(1)} hint={`Top ${summary.topProj.toFixed(1)}`} />
                  <Stat label="Avg ownership Σ" value={`${summary.avgOwn.toFixed(0)}%`} />
                  <Stat label="Avg salary" value={formatSalary(summary.avgSalary)} hint={`of ${formatSalary(salaryCap)}`} />
                </div>

                {run.warnings.length > 0 && (
                  <Notice notice={{ tone: 'caution', text: 'The optimizer reported:', details: run.warnings }} onDismiss={() => setRun({ ...run, warnings: [] })} />
                )}

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-fg-muted">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-[rgb(var(--accent))]"
                        checked={selected.size === lineups.length}
                        ref={(el) => el && (el.indeterminate = selected.size > 0 && selected.size < lineups.length)}
                        onChange={() => setSelected(selected.size === lineups.length ? new Set() : new Set(lineups.map((l) => l.key)))}
                        aria-label="Select all lineups"
                      />
                      {selected.size ? `${selected.size} selected` : 'Select all'}
                    </label>
                    <Select size="sm" aria-label="Sort lineups" value={sortBy} onChange={(e) => setSortBy(e.target.value)} options={SORTS} className="w-40" />
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => saveLineups(target.filter((l) => !saved.has(l.key)))}
                      disabled={target.every((l) => saved.has(l.key)) || savingKeys.size > 0}
                      loading={savingKeys.size > 1}
                    >
                      Save {selected.size ? 'selected' : 'all'}
                    </Button>
                    <Button variant="primary" size="sm" onClick={() => exportLineups(target.map((l) => l.slots))} loading={exporting}>
                      Export {target.length} for {siteConfig.name}
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
                  {sortedLineups.map((l) => (
                    <LineupCard
                      key={l.key}
                      lineup={l}
                      salaryCap={salaryCap}
                      selected={selected.has(l.key)}
                      onToggleSelect={() => setSelected((s) => toggleIn(s, l.key))}
                      saved={saved.has(l.key)}
                      saving={savingKeys.has(l.key)}
                      onSave={() => saveLineups([l])}
                      onEdit={() => editInBuilder(l)}
                      onReview={() => reviewLineup(l)}
                      reviewing={review.loading && review.key === l.key}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-4 px-4 py-5 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-fg">Lineup Studio</h1>
          <p className="truncate text-xs text-fg-muted">
            {slate ? (
              <>
                {slate.name} · {siteConfig.name} · {pool.status === 'ready' ? `${players.length} players` : 'loading players'}
                {pool.status === 'loading' && players.length > 0 && <Spinner size="xs" className="ml-1.5 align-middle" />}
              </>
            ) : (
              'No slate selected'
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tabs
            variant="pill"
            value={view}
            onChange={setView}
            tabs={[
              { value: 'optimize', label: 'Optimizer' },
              { value: 'manual', label: 'Manual builder' },
            ]}
          />
          <Button size="sm" variant="ghost" disabled={!slateId} loading={projectionBusy} onClick={() => projections('recalculate')}>
            Recalculate projections
          </Button>
          <Button size="sm" variant="ghost" disabled={!slateId || projectionBusy} onClick={() => projections('reset')}>
            Reset to RotoWire
          </Button>
          <Button size="sm" variant="ghost" disabled={!slateId} loading={breakdown.loading} onClick={runBreakdown}>
            AI breakdown
          </Button>
        </div>
      </header>

      {notice && <Notice notice={notice} onDismiss={() => setNotice(null)} />}

      {body}

      <Modal open={breakdown.open} onClose={() => setBreakdown((b) => ({ ...b, open: false }))} title="AI slate breakdown" size="xl">
        {breakdown.loading ? (
          <div className="flex justify-center py-12">
            <Spinner size="md" />
          </div>
        ) : (
          <div className="space-y-2 text-sm text-fg [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_strong]:font-semibold [&_table]:text-xs [&_td]:border [&_td]:border-line [&_td]:px-2 [&_th]:border [&_th]:border-line [&_th]:px-2 [&_ul]:list-disc [&_ul]:pl-5">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{breakdown.text}</ReactMarkdown>
          </div>
        )}
      </Modal>

      <Modal
        open={!!review.key && !review.loading}
        onClose={() => setReview({ key: null, loading: false, text: '' })}
        title={`AI review · lineup #${review.number ?? ''}`}
        size="lg"
      >
        <div className="whitespace-pre-wrap text-sm text-fg">{review.text}</div>
      </Modal>
    </div>
  );
}
