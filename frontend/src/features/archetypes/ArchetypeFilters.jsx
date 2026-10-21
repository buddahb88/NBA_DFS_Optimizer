import { Badge, Select, Tabs } from '../../components/ui';
import { GROUPINGS, LAST_N_OPTIONS, STATS } from './archetypes';

/**
 * Grouping toggle (archetype vs G/F/C), season, last-N-games and stat. Site
 * comes from the top bar and is shown as a badge.
 */
export default function ArchetypeFilters({ value, onChange, seasons, siteName }) {
  const set = (patch) => onChange({ ...value, ...patch });
  const seasonOptions = (seasons?.seasons ?? []).map((s) => ({ value: s.value, label: s.current ? `${s.value} (current)` : s.value }));
  // '' = server default (current season); show it as the current season
  const season = value.season || seasons?.current || '';

  return (
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2 rounded-md border border-line bg-surface px-3 py-2">
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg-muted">Columns</span>
        <Tabs variant="pill" size="sm" tabs={GROUPINGS} value={value.grouping} onChange={(grouping) => set({ grouping })} />
      </div>
      <Select
        size="sm"
        label="Season"
        value={season}
        onChange={(e) => set({ season: e.target.value })}
        options={seasonOptions.length ? seasonOptions : [{ value: season, label: season || 'Current' }]}
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
