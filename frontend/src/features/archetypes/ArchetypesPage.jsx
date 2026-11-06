import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, Card, CardBody, CardHeader, EmptyState, IconGrid, IconInfo, Spinner, Tabs } from '../../components/ui';
import { useSlate } from '../../context/SlateContext';
import { DATA_STATUS_PATH } from '../dataStatus/dataStatus';
import ArchetypeFilters from './ArchetypeFilters';
import ArchetypeHeatmap from './ArchetypeHeatmap';
import ArchetypeLegend from './ArchetypeLegend';
import CellDrilldown from './CellDrilldown';
import TonightTable from './TonightTable';
import useArchetypes from './useArchetypes';
import SlateModeSelect from '../slate/SlateModeSelect';
import useSlateVerdicts from '../playerCard/useSlateVerdicts';
import {
  TONIGHT_TEAMS,
  parseDeepLink,
  resolveTeams,
  slateCellPlayers,
  slateOpponents,
  slateTeams,
  statFor,
  teamsParam,
  tonightCardTarget,
} from './archetypes';

const TABS = [
  { value: 'heatmap', label: 'Defense heatmap' },
  { value: 'tonight', label: 'Tonight' },
];

const DataStatusLink = () => (
  <Link to={DATA_STATUS_PATH} className="text-xs font-medium text-accent hover:underline">
    Open data status &amp; sync
  </Link>
);

function SectionError({ error, onRetry }) {
  return (
    <EmptyState
      compact
      title="Something went wrong"
      description={error}
      action={<Button size="sm" variant="secondary" onClick={onRetry}>Retry</Button>}
    />
  );
}

function NoTeamsShown({ tonight, onClear }) {
  return (
    <EmptyState
      compact
      icon={<IconGrid size={18} />}
      title="No defenses match the team filter"
      description={
        tonight
          ? 'None of the teams on the selected slate have defense data for this season and window.'
          : 'None of the selected teams have defense data for this season and window.'
      }
      action={<Button size="sm" variant="secondary" onClick={onClear}>Show all teams</Button>}
    />
  );
}

function NoDefenseData({ season }) {
  return (
    <EmptyState
      icon={<IconGrid size={18} />}
      title={`No archetype defense data for ${season || 'this season'}`}
      description="The heatmap is built from synced box scores and player archetypes. Sync game logs (the archetype tables rebuild after the nightly sync), or pick an earlier season."
      action={<DataStatusLink />}
    />
  );
}

// Auto season fell back to last season because the current one is too thin
function FallbackNote({ lead, season, fallback }) {
  return (
    <div role="note" className="flex items-start gap-2 rounded-md border border-info/30 bg-info-soft px-3 py-2 text-xs text-fg">
      <IconInfo size={14} className="mt-px shrink-0 text-info" />
      <span>
        {lead} {season}: only {fallback.qualifiedDefenses} defenses have {fallback.minGames}+ games in {fallback.from} ({fallback.minDefenses} needed).
        Pick {fallback.from} under Season to use it anyway.
      </span>
    </div>
  );
}

export default function ArchetypesPage() {
  const { slate, slateId: liveSlateId, site, siteConfig, loadingSlates, backtest = null, workSlateId } = useSlate();
  // Tonight follows the slate selector: a backtest ranks that saved night (no lookahead)
  const slateId = workSlateId ?? liveSlateId;
  const [searchParams, setSearchParams] = useSearchParams();
  const [deepLink] = useState(() => parseDeepLink(searchParams));
  const [filters, setFilters] = useState(deepLink.filters);
  const [tab, setTab] = useState('heatmap');
  // Deep-linked cell, opened once the grid and labels have loaded
  const pendingCell = useRef(deepLink.cell);

  const { definitions, seasons, defense, tonight, cell, openCell, closeCell, reload } = useArchetypes({
    site,
    // Wait for the top bar's slate list so a stored slate isn't fetched twice
    slateId: loadingSlates ? null : slateId,
    slateDate: backtest?.slateDate ?? null,
    filters,
  });

  useEffect(() => {
    const target = pendingCell.current;
    if (!target || defense.status !== 'ready' || definitions.status === 'loading' || definitions.status === 'idle') return;
    pendingCell.current = null;
    const defs = (filters.grouping === 'position' ? definitions.data?.positions : definitions.data?.archetypes) ?? [];
    openCell({ ...target, label: defs.find((d) => d.key === target.group)?.label });
  }, [defense.status, definitions, filters.grouping, openCell]);

  // Team filter lives in the URL (?teams=BOS,NYK or ?teams=tonight) so the view can be shared
  const teamsValue = teamsParam(filters.teams);
  useEffect(() => {
    if ((searchParams.get('teams') ?? '') === teamsValue) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (teamsValue) next.set('teams', teamsValue);
        else next.delete('teams');
        return next;
      },
      { replace: true },
    );
  }, [teamsValue, searchParams, setSearchParams]);

  // Drill-down names link to the card when the player is on the slate Tonight loaded
  const tonightData = tonight.data;
  const rosterByKey = useMemo(
    () => new Map((tonightData?.roster ?? []).filter((p) => p.player_key).map((p) => [p.player_key, p])),
    [tonightData],
  );
  const drilldownCardTarget = useCallback(
    (key) => {
      const p = key ? rosterByKey.get(key) : null;
      return p ? tonightCardTarget(p, tonightData) : null;
    },
    [rosterByKey, tonightData],
  );

  // Team filter: options from the loaded grid, the slate shortcut from Tonight's roster.
  // Filtering is client-side; the color scale stays computed over every team.
  const defenseRows = defense.data?.rows;
  const gridTeams = useMemo(() => [...new Set((defenseRows ?? []).map((r) => r.team))].sort(), [defenseRows]);
  const tonightTeams = useMemo(() => slateTeams(tonightData), [tonightData]);
  const opponents = useMemo(() => slateOpponents(tonightData), [tonightData]);
  const shownTeams = useMemo(() => resolveTeams(filters.teams, tonightTeams), [filters.teams, tonightTeams]);
  const clearTeams = useCallback(() => setFilters((f) => ({ ...f, teams: [] })), []);

  // Hover popover: tonight's roster placed in heatmap cells (opponent x archetype / G/F/C)
  const gridGrouping = defense.data?.grouping ?? filters.grouping;
  const byCell = useMemo(() => slateCellPlayers(tonightData, gridGrouping), [tonightData, gridGrouping]);
  const hasSlate = Boolean(slateId) && !loadingSlates;
  // Card verdict pills in the popover: one cached request per slate (nice-to-have; absent on error)
  const verdicts = useSlateVerdicts({
    slateId: tonightData?.slateId ?? null,
    slateDate: tonightData?.isBacktest ? tonightData.slateDate ?? null : null,
    enabled: tab === 'heatmap' && byCell.size > 0,
  });
  const verdictLookup = verdicts.lookup;
  const verdictsReady = verdicts.status === 'done';
  const heatmapSlate = useMemo(() => {
    const status = !hasSlate
      ? 'none'
      : tonight.status === 'error'
        ? 'error'
        : tonight.status === 'ready' && tonightData && tonightData.grouping === gridGrouping
          ? 'ready'
          : 'loading';
    return {
      status,
      byCell: status === 'ready' ? byCell : null,
      teams: new Set(tonightTeams),
      isBacktest: Boolean(tonightData?.isBacktest),
      cardTarget: (p) => tonightCardTarget(p, tonightData),
      verdictFor: verdictsReady ? (p) => verdictLookup({ player_id: p.player_id }) : null,
    };
  }, [hasSlate, tonight.status, tonightData, gridGrouping, byCell, tonightTeams, verdictsReady, verdictLookup]);

  const season = defense.data?.season || filters.season || seasons.data?.current;
  const { label: statLabel } = statFor(filters.stat);
  const columnsLabel = filters.grouping === 'position' ? 'G/F/C' : 'archetype';

  const heatmapBody =
    defense.status === 'error' ? (
      <SectionError error={defense.error} onRetry={reload} />
    ) : defense.status === 'loading' && !defense.data ? (
      <div className="flex justify-center py-16"><Spinner size="md" /></div>
    ) : (
      <ArchetypeHeatmap
        rows={defense.data?.rows ?? []}
        definitions={definitions.data}
        grouping={filters.grouping}
        stat={filters.stat}
        teams={shownTeams}
        opponents={opponents}
        slate={heatmapSlate}
        onCellClick={openCell}
        emptyState={<NoDefenseData season={season} />}
        filteredEmptyState={<NoTeamsShown tonight={filters.teams === TONIGHT_TEAMS} onClear={clearTeams} />}
      />
    );

  const tonightEmpty = !loadingSlates && !slate && !backtest ? (
    <EmptyState
      compact
      title="No slate selected"
      description="Pick or load a slate in the top bar to match tonight's players against weak defenses."
    />
  ) : tonight.data && tonight.data.slatePlayers === 0 ? (
    <EmptyState compact title="This slate has no players" description="Load the slate's players from the Dashboard first." />
  ) : tonight.data && (tonight.data.defenseRows === 0 || tonight.data.matchedPlayers === 0) ? (
    <EmptyState
      compact
      icon={<IconGrid size={18} />}
      title={tonight.data.defenseRows === 0 ? `No archetype defense data for ${tonight.data.season}` : 'No slate players have an archetype yet'}
      description="Archetypes and defense splits come from synced box scores. Sync game logs, or switch the season."
      action={<DataStatusLink />}
    />
  ) : (
    <EmptyState compact title="No weak-tier matchups" description={`No slate player faces a bottom-third defense by ${statLabel} for their ${columnsLabel}.`} />
  );

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-4 px-4 py-4 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-fg">Archetypes</h2>
          <p className="text-xs text-fg-muted">
            How each defense handles each {columnsLabel}: {statLabel} allowed per player-game over the player’s own expectation, shrunk toward 0 on small samples.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link to={DATA_STATUS_PATH} className="text-xs font-medium text-fg-muted hover:text-fg hover:underline">
            Data status &amp; sync
          </Link>
          <Button variant="secondary" size="sm" onClick={reload}>
            Refresh
          </Button>
        </div>
      </div>

      <ArchetypeFilters
        value={filters}
        onChange={setFilters}
        seasons={seasons.data}
        siteName={siteConfig?.name}
        teams={gridTeams}
        tonightTeams={tonightTeams}
      />

      <Tabs tabs={TABS} value={tab} onChange={setTab} />

      {tab === 'heatmap' ? (
        <div className="flex flex-col gap-2">
          {defense.data?.fallback && <FallbackNote lead="Showing" season={defense.data.season} fallback={defense.data.fallback} />}
          <Card>
            <CardHeader
              title={`Team defense vs ${columnsLabel}`}
              subtitle={`${season ?? ''}${defense.data?.lastNGames ? ` · each defense's last ${defense.data.lastNGames} games` : ' · full season'} · hover a cell for tonight’s players, click for its games`}
            />
            <CardBody>{heatmapBody}</CardBody>
          </Card>
        </div>
      ) : tonight.status === 'error' ? (
        <Card><SectionError error={tonight.error} onRetry={reload} /></Card>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <SlateModeSelect />
            {shownTeams && (
              <span className="text-xs text-fg-subtle">The team filter applies to the heatmap only.</span>
            )}
            {tonight.data?.isBacktest && (
              <span className="text-xs text-fg-muted">
                Defense through {tonight.data.endDate}, minutes as of {tonight.data.slateDate}; Actual = DK points scored that night.
              </span>
            )}
          </div>
          {tonight.data?.fallback && <FallbackNote lead="Tiers use" season={tonight.data.season} fallback={tonight.data.fallback} />}
          <TonightTable data={tonight.data} stat={filters.stat} loading={tonight.status === 'loading'} emptyState={tonightEmpty} />
        </div>
      )}

      <ArchetypeLegend definitions={definitions} />

      <CellDrilldown
        cell={cell}
        onClose={closeCell}
        onRetry={cell ? () => openCell(cell) : undefined}
        cardTarget={drilldownCardTarget}
      />
    </div>
  );
}
