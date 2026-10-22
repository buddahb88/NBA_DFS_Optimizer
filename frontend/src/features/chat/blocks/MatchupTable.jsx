import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, Tabs, Tooltip, cn } from '../../../components/ui';
import { cellColor, formatDelta } from '../../archetypes/archetypes';
import { LOW_SAMPLE_GAMES, drilldownPath } from './blockModel';
import BlockFrame from './BlockFrame';

const maxAbsOf = (rows, key) => Math.max(0, ...rows.map((r) => Math.abs(Number(r[key]) || 0)));

function HeatCell({ value, maxAbs, label }) {
  return (
    <td className="border-b border-l border-line/60 p-0">
      <span
        aria-label={label}
        style={{ backgroundColor: cellColor(value, maxAbs) }}
        className="num block h-7 px-2 text-right leading-7 text-fg"
      >
        {formatDelta(value)}
      </span>
    </td>
  );
}

function GamesCell({ games }) {
  const low = (Number(games) || 0) < LOW_SAMPLE_GAMES;
  return (
    <td className={cn('num border-b border-l border-line/60 px-2 text-right', low ? 'text-fg-subtle' : 'text-fg-muted')}>
      {low ? (
        <Tooltip content={`Only ${games ?? 0} games: values are mostly shrunk to 0`}>
          <span tabIndex={0} className="underline decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
            {games ?? 0}
          </span>
        </Tooltip>
      ) : (
        games
      )}
    </td>
  );
}

const TH = 'sticky top-0 z-10 whitespace-nowrap border-b border-line bg-surface-sunken px-2 py-1.5 text-2xs font-semibold uppercase tracking-wider text-fg-subtle';
const LINK = 'rounded font-medium text-fg hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50';

function HeatTable({ head, children }) {
  return (
    <div className="scrollbar-thin max-h-96 overflow-auto rounded-md border border-line bg-surface">
      <table className="w-full border-separate border-spacing-0 text-xs">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h} scope="col" className={cn(TH, i === 0 ? 'text-left' : 'text-right')}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const DEFENSE_STATS = [
  { key: 'fp_over_expectation', label: 'FP' },
  { key: 'pts_delta', label: 'PTS' },
  { key: 'reb_delta', label: 'REB' },
  { key: 'ast_delta', label: 'AST' },
  { key: 'fg3m_delta', label: '3PM' },
  { key: 'stocks_delta', label: 'STK' },
];

// Like the Archetypes heatmap, Unclassified is never a row
const visibleRows = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => r && r.group_key !== 'unclassified');

/** Defense rows (uiBlocks.js groupRow): one team vs archetypes or G/F/C. */
function DefenseRows({ rows, season, grouping }) {
  const scales = useMemo(() => Object.fromEntries(DEFENSE_STATS.map((s) => [s.key, maxAbsOf(rows, s.key)])), [rows]);
  return (
    <HeatTable head={[grouping === 'position' ? 'Position' : 'Archetype', ...DEFENSE_STATS.map((s) => s.label), 'Rank', 'Games']}>
      {rows.map((r) => {
        const low = r.low_sample ?? (Number(r.games) || 0) < LOW_SAMPLE_GAMES;
        const label = r.label ?? r.group_key;
        const path = drilldownPath({ season, grouping, team: r.team, group: r.group_key });
        return (
          <tr key={`${r.team}-${r.group_key}`} className={cn(low && 'opacity-60')} data-low-sample={low || undefined}>
            <th scope="row" className="border-b border-line/60 px-2 py-1 text-left">
              {path ? (
                <Link to={path} className={LINK}>
                  {label}
                </Link>
              ) : (
                <span className="font-medium text-fg">{label}</span>
              )}
            </th>
            {DEFENSE_STATS.map((s) => (
              <HeatCell key={s.key} value={r[s.key]} maxAbs={scales[s.key]} label={`${r.team} vs ${label}: ${formatDelta(r[s.key])} ${s.label}`} />
            ))}
            <td className="num border-b border-l border-line/60 px-2 text-right text-fg-muted">{r.rank != null ? `${r.rank}/${r.teams ?? 30}` : '—'}</td>
            <GamesCell games={r.games} />
          </tr>
        );
      })}
    </HeatTable>
  );
}

const SUBTITLE = 'FP allowed over expectation per player-game';
const subtitleFor = (context) => [context?.season, SUBTITLE].filter(Boolean).join(' · ');
const groupingLabel = (g) => (g === 'position' ? 'G/F/C' : 'Archetype');

/** team_defense: where one defense is weakest and strongest, by archetype and/or G/F/C (get_team_defense_profile). */
export function TeamDefenseBlock({ block }) {
  const d = block.data ?? {};
  const groups = (Array.isArray(d.groups) ? d.groups : []).filter((g) => g?.weakest?.length || g?.strongest?.length);
  const [grouping, setGrouping] = useState(groups[0]?.group_by);
  const group = groups.find((g) => g.group_by === grouping) ?? groups[0];
  const weakest = visibleRows(group?.weakest);
  const strongest = visibleRows(group?.strongest);

  return (
    <BlockFrame
      title={block.title ?? `${d.team ?? 'Team'} defense`}
      subtitle={subtitleFor(d.context)}
      note={block.note}
      controls={
        groups.length > 1 && (
          <Tabs variant="pill" size="sm" value={group.group_by} onChange={setGrouping} tabs={groups.map((g) => ({ value: g.group_by, label: groupingLabel(g.group_by) }))} />
        )
      }
    >
      {!group ? (
        <EmptyState compact title="No defense data" className="rounded-md border border-line bg-surface" />
      ) : (
        <>
          {weakest.length > 0 && (
            <div className="flex flex-col gap-1">
              <h4 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">Weakest vs (attack)</h4>
              <DefenseRows rows={weakest} season={d.context?.season} grouping={group.group_by} />
            </div>
          )}
          {strongest.length > 0 && (
            <div className="flex flex-col gap-1">
              <h4 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">Strongest vs (avoid)</h4>
              <DefenseRows rows={strongest} season={d.context?.season} grouping={group.group_by} />
            </div>
          )}
        </>
      )}
    </BlockFrame>
  );
}

/** matchup_table: one defense vs every archetype or G/F/C as a heat table (get_team_defense_profile). */
export function MatchupTableBlock({ block }) {
  const d = block.data ?? {};
  const rows = visibleRows(d.rows);
  return (
    <BlockFrame title={block.title ?? 'Matchups'} subtitle={subtitleFor(d.context)} note={block.note}>
      {rows.length === 0 ? (
        <EmptyState compact title="No matchups" className="rounded-md border border-line bg-surface" />
      ) : (
        <DefenseRows rows={rows} season={d.context?.season} grouping={d.group_by} />
      )}
    </BlockFrame>
  );
}
