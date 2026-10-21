import { Badge, Select, Tabs } from '../../components/ui';
import { GROUPINGS, LAST_N_OPTIONS, STATS } from './archetypes';

/**
 * Grouping toggle (archetype vs G/F/C), season, last-N-games and stat. Site
 * comes from the top bar and is shown as a badge.
 */
export default function ArchetypeFilters({ value, onChange, seasons, siteName }) {
  const set = (patch) => onChange({ ...value, ...patch });
  // '' = Auto: the current season, except Tonight falls back to last season
  // while the current one is thin. Picking a season explicitly pins it.
  const seasonOptions = [
    { value: '', label: seasons?.current ? `Auto (${seasons.current})` : 'Auto' },
    ...(seasons?.seasons ?? []).map((s) => ({ value: s.value, label: s.value })),
  ];

  return (
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2 rounded-md border border-line bg-surface px-3 py-2">
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg-muted">Columns</span>
        <Tabs variant="pill" size="sm" tabs={GROUPINGS} value={value.grouping} onChange={(grouping) => set({ grouping })} />
      </div>
      <Select
        size="sm"
        label="Season"
        value={value.season}
        onChange={(e) => set({ season: e.target.value })}
        options={seasonOptions}
        className="w-36"
      />
      <Select
        size="sm"
        label="Games"
        value={value.lastNGames}
        onChange={(e) => set({ lastNGames: e.target.value })}
        options={LAST_N_OPTIONS}
        className="w-36"
      />
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg-muted">Stat</span>
        <Tabs variant="pill" size="sm" tabs={STATS} value={value.stat} onChange={(stat) => set({ stat })} />
      </div>
      {siteName && (
        <Badge tone="info" className="ml-auto self-center" title="Fantasy points are scored with this site's rules">
          {siteName} scoring
        </Badge>
      )}
    </div>
  );
}
