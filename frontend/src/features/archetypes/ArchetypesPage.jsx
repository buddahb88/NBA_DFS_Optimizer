import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, CardBody, CardHeader, EmptyState, IconGrid, IconInfo, Spinner, Tabs } from '../../components/ui';
import { useSlate } from '../../context/SlateContext';
import { DATA_STATUS_PATH } from '../dataStatus/dataStatus';
import ArchetypeFilters from './ArchetypeFilters';
import ArchetypeHeatmap from './ArchetypeHeatmap';
import ArchetypeLegend from './ArchetypeLegend';
import CellDrilldown from './CellDrilldown';
import TonightTable from './TonightTable';
import useArchetypes from './useArchetypes';
import { DEFAULT_FILTERS, statFor } from './archetypes';

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

// Tonight was tiered on last season because the current one is too thin
function FallbackNote({ season, fallback }) {
  return (
    <div role="note" className="flex items-start gap-2 rounded-md border border-info/30 bg-info-soft px-3 py-2 text-xs text-fg">
      <IconInfo size={14} className="mt-px shrink-0 text-info" />
      <span>
        Tiers use {season}: only {fallback.qualifiedDefenses} defenses have {fallback.minGames}+ games in {fallback.from} ({fallback.minDefenses} needed).
        Pick {fallback.from} under Season to tier on it anyway.
      </span>
    </div>
  );
}

export default function ArchetypesPage() {
  const { slate, slateId, site, siteConfig, loadingSlates } = useSlate();
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [tab, setTab] = useState('heatmap');

  const { definitions, seasons, defense, tonight, cell, openCell, closeCell, reload } = useArchetypes({
    site,
    // Wait for the top bar's slate list so a stored slate isn't fetched twice
    slateId: loadingSlates ? null : slateId,
    filters,
  });

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
        onCellClick={openCell}
        emptyState={<NoDefenseData season={season} />}
      />
    );

  const tonightEmpty = !loadingSlates && !slate ? (
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

      <ArchetypeFilters value={filters} onChange={setFilters} seasons={seasons.data} siteName={siteConfig?.name} />

      <Tabs tabs={TABS} value={tab} onChange={setTab} />

      {tab === 'heatmap' ? (
        <Card>
          <CardHeader
            title={`Team defense vs ${columnsLabel}`}
            subtitle={`${season ?? ''}${defense.data?.lastNGames ? ` · each defense's last ${defense.data.lastNGames} games` : ' · full season'} · click a cell for its games`}
          />
          <CardBody>{heatmapBody}</CardBody>
        </Card>
      ) : tonight.status === 'error' ? (
        <Card><SectionError error={tonight.error} onRetry={reload} /></Card>
      ) : (
        <div className="flex flex-col gap-2">
          {tonight.data?.fallback && <FallbackNote season={tonight.data.season} fallback={tonight.data.fallback} />}
          <TonightTable data={tonight.data} stat={filters.stat} loading={tonight.status === 'loading'} emptyState={tonightEmpty} />
        </div>
      )}

      <ArchetypeLegend definitions={definitions} />

      <CellDrilldown cell={cell} onClose={closeCell} onRetry={cell ? () => openCell(cell) : undefined} />
    </div>
  );
}
