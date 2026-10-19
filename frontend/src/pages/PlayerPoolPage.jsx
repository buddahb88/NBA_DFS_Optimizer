import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { playersAPI } from '../services/api';
import { useSlate } from '../context/SlateContext';
import SalaryImport from '../components/SalaryImport';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  IconSearch,
  IconX,
  Input,
  Select,
  Tabs,
  Toggle,
  Tooltip,
  cn,
} from '../components/ui';
import {
  DEFAULT_FILTERS,
  POSITIONS,
  QUICK_VIEWS,
  applyFilters,
  applyQuickView,
  gameKey,
  getQuickView,
  slateStats,
  toOptimizerPlayers,
  withSettings,
} from '../features/playerPool/playerPool';
import { buildColumns } from '../features/playerPool/columns';
import usePlayerSettings from '../features/playerPool/usePlayerSettings';

function FilterBar({ filters, setFilters, games, teams, salaryBounds }) {
  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const togglePos = (pos) =>
    set({ positions: filters.positions.includes(pos) ? filters.positions.filter((p) => p !== pos) : [...filters.positions, pos] });
  const dirty = JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS);

  return (
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2 rounded-md border border-line bg-surface px-3 py-2">
      <Input
        aria-label="Search players"
        placeholder="Search name or team"
        leftIcon={<IconSearch size={13} />}
        value={filters.search}
        onChange={(e) => set({ search: e.target.value })}
        className="w-52 [&_input]:h-7 [&_input]:text-xs"
      />

      <div className="flex items-center gap-1" role="group" aria-label="Positions">
        {POSITIONS.map((pos) => {
          const on = filters.positions.includes(pos);
          return (
            <button
              key={pos}
              type="button"
              aria-pressed={on}
              onClick={() => togglePos(pos)}
              className={cn(
                'h-7 rounded border px-2 text-xs font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                on ? 'border-accent/40 bg-accent-soft text-accent' : 'border-line bg-surface-sunken text-fg-muted hover:text-fg',
              )}
            >
              {pos}
            </button>
          );
        })}
      </div>

      <Select
        size="sm"
        aria-label="Game or team"
        value={filters.game}
        onChange={(e) => set({ game: e.target.value })}
        className="w-40"
      >
        <option value="">All games</option>
        {games.length > 0 && (
          <optgroup label="Games">
            {games.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </optgroup>
        )}
        {teams.length > 0 && (
          <optgroup label="Teams">
            {teams.map((t) => (
              <option key={t} value={`team:${t}`}>{t}</option>
            ))}
          </optgroup>
        )}
      </Select>

      <div className="flex items-center gap-1" role="group" aria-label="Salary range">
        <Input
          numeric
          type="number"
          step={100}
          aria-label="Minimum salary"
          placeholder={salaryBounds.min ? `$${salaryBounds.min}` : 'Min $'}
          value={filters.salaryMin}
          onChange={(e) => set({ salaryMin: e.target.value })}
          className="w-24 [&_input]:h-7 [&_input]:text-xs"
        />
        <span className="text-xs text-fg-subtle">–</span>
        <Input
          numeric
          type="number"
          step={100}
          aria-label="Maximum salary"
          placeholder={salaryBounds.max ? `$${salaryBounds.max}` : 'Max $'}
          value={filters.salaryMax}
          onChange={(e) => set({ salaryMax: e.target.value })}
          className="w-24 [&_input]:h-7 [&_input]:text-xs"
        />
      </div>

      <Toggle
        size="sm"
        checked={filters.hideInjured}
        onChange={(on) => set({ hideInjured: on })}
        label={<span className="text-xs">Hide injured</span>}
      />

      {dirty && (
        <Button size="xs" variant="ghost" leftIcon={<IconX size={12} />} onClick={() => setFilters(DEFAULT_FILTERS)}>
          Clear filters
        </Button>
      )}
    </div>
  );
}

function ControlsSummary({ settings, optimizerPlayers, onReset }) {
  const all = Object.values(settings);
  const count = (pred) => all.filter(pred).length;
  const locked = count((s) => s.lock);
  const excluded = count((s) => s.exclude);
  const overrides = count((s) => s.projectionOverride != null);
  const exposure = count((s) => s.minExposure != null || s.maxExposure != null);
  // Saved controls for players no longer in the pool (e.g. ruled out and dropped on resync)
  const stale = all.length - optimizerPlayers.length;

  if (!all.length) {
    return (
      <p className="text-xs text-fg-subtle">
        Lock, exclude, set exposure or override projections per player. Changes save to this slate and apply to the optimizer.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {locked > 0 && <Badge tone="positive">{locked} locked</Badge>}
      {excluded > 0 && <Badge tone="negative">{excluded} excluded</Badge>}
      {exposure > 0 && <Badge tone="accent">{exposure} exposure rules</Badge>}
      {overrides > 0 && <Badge tone="info">{overrides} projection overrides</Badge>}
      {stale > 0 && (
        <Tooltip content="Saved for players who are not in the current pool; ignored by the optimizer">
          <Badge tone="neutral">{stale} not in pool</Badge>
        </Tooltip>
      )}
      <span className="text-fg-subtle">
        Applied to <Link to="/optimizer" className="text-accent hover:underline">the optimizer</Link>
      </span>
      <Button size="xs" variant="ghost" onClick={onReset} className="ml-auto">
        Reset all
      </Button>
    </div>
  );
}

function PlayerPoolPage() {
  // The slate comes from the top-bar site/slate switcher
  const { slate: activeSlate, slateId, site, setSite, refreshSlates, loadingSlates } = useSlate();
  const [players, setPlayers] = useState([]);
  const [loadingPlayers, setLoadingPlayers] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [view, setView] = useState('all');
  // Bumped after a salary import so the same slate's players reload
  const [importCount, setImportCount] = useState(0);
  const navigate = useNavigate();
  const loading = loadingSlates || loadingPlayers;

  const { settings, error: settingsError, update, clearAll, dismissError } = usePlayerSettings(slateId);

  // Load players whenever the top-bar slate changes
  useEffect(() => {
    setPlayers([]);
    setLoadError(null);
    if (!slateId) return;
    let cancelled = false;
    setLoadingPlayers(true);
    playersAPI.getBySlateId(slateId)
      .then(({ data }) => {
        if (!cancelled) setPlayers(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.response?.data?.error || err.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingPlayers(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slateId, importCount]);

  // Show the imported slate: switch the top bar to its site, or reload this site's slates
  const handleImported = (result) => {
    if (result?.site && result.site !== site) {
      setSite(result.site);
      return;
    }
    refreshSlates(result?.slate?.slate_id);
    setImportCount((n) => n + 1);
  };

  const rows = useMemo(() => players.map((p) => withSettings(p, settings[String(p.player_id)])), [players, settings]);
  const stats = useMemo(() => slateStats(rows), [rows]);
  const visibleRows = useMemo(() => applyQuickView(applyFilters(rows, filters), view, stats), [rows, filters, view, stats]);
  const optimizerPlayers = useMemo(() => toOptimizerPlayers(players, settings), [players, settings]);
  const columns = useMemo(() => buildColumns({ stats, onUpdate: update }), [stats, update]);

  const { games, teams, salaryBounds } = useMemo(() => {
    const salaries = players.map((p) => p.salary).filter(Boolean);
    return {
      games: [...new Set(players.map(gameKey).filter(Boolean))].sort(),
      teams: [...new Set(players.map((p) => p.team).filter(Boolean))].sort(),
      salaryBounds: { min: salaries.length ? Math.min(...salaries) : null, max: salaries.length ? Math.max(...salaries) : null },
    };
  }, [players]);

  const onReset = () => {
    if (window.confirm('Clear every lock, exclusion, exposure rule and override on this slate?')) clearAll();
  };

  const currentView = getQuickView(view);

  return (
    <div className="mx-auto max-w-[1600px] space-y-3 px-4 py-4 sm:px-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-fg">Player Pool</h1>
          <p className="text-xs text-fg-muted">
            {activeSlate ? (
              <>
                <span className="font-medium text-fg">{activeSlate.name}</span>
                {players.length > 0 && <> · {visibleRows.length} of {players.length} players</>}
              </>
            ) : (
              'No active slate'
            )}
          </p>
        </div>
        <SalaryImport onImported={handleImported} />
      </header>

      {(loadError || settingsError) && (
        <div className="flex items-start justify-between gap-2 rounded border border-negative/30 bg-negative-soft px-3 py-2 text-xs text-negative">
          <span>{loadError || settingsError}</span>
          {settingsError && !loadError && (
            <button type="button" aria-label="Dismiss" onClick={dismissError}>
              <IconX size={14} />
            </button>
          )}
        </div>
      )}

      {!activeSlate && !loading ? (
        <div className="rounded-md border border-line bg-surface">
          <EmptyState
            title="No active slate"
            description="Pick a slate in the top bar, or sync one from the home page, to load its player pool."
            action={
              <Button variant="primary" size="sm" onClick={() => navigate('/')}>
                Select a slate
              </Button>
            }
          />
        </div>
      ) : (
        <>
          <ControlsSummary settings={settings} optimizerPlayers={optimizerPlayers} onReset={onReset} />
          <FilterBar filters={filters} setFilters={setFilters} games={games} teams={teams} salaryBounds={salaryBounds} />
          {/* key: remount on view change so the view's default sort applies */}
          <DataTable
            key={view}
            data={visibleRows}
            columns={columns}
            getRowId={(p) => String(p.player_id)}
            initialSorting={currentView.sort}
            maxHeight="calc(100vh - 290px)"
            loading={loading}
            rowClassName={(p) => cn(p.settings?.lock && 'bg-positive-soft/40', p.settings?.exclude && 'opacity-60')}
            toolbar={
              <>
                <Tabs variant="pill" size="sm" tabs={QUICK_VIEWS.map(({ value, label }) => ({ value, label }))} value={view} onChange={setView} />
                <span className="hidden truncate text-2xs text-fg-subtle md:inline">{currentView.description}</span>
              </>
            }
            emptyState={
              <EmptyState
                compact
                title={players.length ? 'No players match' : 'No players on this slate'}
                description={players.length ? 'Loosen the filters or switch quick view.' : 'Sync the slate from the home page.'}
              />
            }
          />
        </>
      )}
    </div>
  );
}

export default PlayerPoolPage;
