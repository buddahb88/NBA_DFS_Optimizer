import { useMemo, useState } from 'react';
import { DataTable, EmptyState, IconGrid, IconList, cn } from '../../../components/ui';
import { formatDelta } from '../../archetypes/archetypes';
import { formatSalary } from '../../lineupStudio/lineupMath';
import { TONE_TEXT, cardPlayers, edgeTone, valuePer1k } from './blockModel';
import BlockFrame from './BlockFrame';
import { useChatBlocks } from './blocksContext';
import PlayerCard, { FlagBadges, Headshot, PlayerActions } from './PlayerCard';

const DEFAULT_TITLES = {
  player_list: 'Players',
  usage_bumps: 'Usage bumps',
  streaks: { hot: 'Hot streaks', cold: 'Cold streaks', consistency: 'Most consistent', boom_bust: 'Boom / bust' },
};

function titleFor(block) {
  if (block.title) return block.title;
  const t = DEFAULT_TITLES[block.type];
  return typeof t === 'string' ? t : t?.[block.data?.kind] ?? 'Players';
}

const VIEW_BUTTON =
  'inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50';

function ViewToggle({ view, onChange }) {
  return (
    <div role="group" aria-label="View" className="inline-flex gap-0.5 rounded-md border border-line bg-surface-sunken p-0.5">
      <button type="button" aria-label="Card view" aria-pressed={view === 'cards'} onClick={() => onChange('cards')} className={cn(VIEW_BUTTON, view === 'cards' && 'bg-surface text-fg shadow-sm')}>
        <IconGrid size={13} />
      </button>
      <button type="button" aria-label="Table view" aria-pressed={view === 'table'} onClick={() => onChange('table')} className={cn(VIEW_BUTTON, view === 'table' && 'bg-surface text-fg shadow-sm')}>
        <IconList size={13} />
      </button>
    </div>
  );
}

function useColumns(withActions) {
  const { findSlatePlayer } = useChatBlocks();
  return useMemo(() => {
    const salaryOf = (p) => p.salary ?? findSlatePlayer(p)?.salary ?? null;
    const projOf = (p) => p.projection ?? findSlatePlayer(p)?.projected_points ?? null;
    const cols = [
      {
        id: 'name',
        header: 'Player',
        accessorFn: (p) => p.name,
        cell: ({ row: { original: p } }) => (
          <span className="flex items-center gap-2">
            <Headshot name={p.name} src={p.headshot ?? findSlatePlayer(p)?.headshot} size="sm" />
            <span className="min-w-0">
              <span className="block truncate font-medium text-fg">{p.name}</span>
              <span className="block truncate text-2xs text-fg-subtle">{[p.team, p.opponent && `vs ${p.opponent}`].filter(Boolean).join(' ')}</span>
            </span>
          </span>
        ),
        meta: { className: 'min-w-[11rem]' },
      },
      { id: 'archetype', header: 'Archetype', accessorFn: (p) => p.archetypeLabel ?? '', cell: (c) => c.getValue() || '—' },
      { id: 'salary', header: 'Sal', accessorFn: salaryOf, cell: (c) => (c.getValue() != null ? formatSalary(c.getValue()) : '—'), meta: { numeric: true } },
      { id: 'proj', header: 'Proj', accessorFn: projOf, cell: (c) => (c.getValue() != null ? Number(c.getValue()).toFixed(1) : '—'), meta: { numeric: true } },
      {
        id: 'value',
        header: 'Pts/$1K',
        accessorFn: (p) => valuePer1k(projOf(p), salaryOf(p)),
        cell: (c) => (c.getValue() != null ? `${c.getValue().toFixed(2)}x` : '—'),
        meta: { numeric: true },
      },
      {
        id: 'edge',
        header: 'Edge',
        accessorFn: (p) => p.adjustedEdge ?? p.matchupEdge,
        cell: (c) => (c.getValue() != null ? <span className={TONE_TEXT[edgeTone(c.getValue())]}>{formatDelta(c.getValue())}</span> : '—'),
        meta: { numeric: true },
      },
      { id: 'min', header: 'Min', accessorFn: (p) => p.minutes, cell: (c) => (c.getValue() != null ? Number(c.getValue()).toFixed(0) : '—'), meta: { numeric: true } },
      { id: 'flags', header: 'Flags', enableSorting: false, cell: ({ row: { original: p } }) => <FlagBadges player={p} /> },
    ];
    if (withActions) cols.push({ id: 'actions', header: '', enableSorting: false, cell: ({ row: { original: p } }) => <PlayerActions player={p} compact /> });
    return cols;
  }, [findSlatePlayer, withActions]);
}

/**
 * player_list / usage_bumps / streaks: responsive card grid (a horizontal
 * scroller on phones) with a toggle to a sortable table.
 */
export default function PlayerCardList({ block }) {
  const [view, setView] = useState('cards');
  const { toggleControl, togglePin } = useChatBlocks();
  const players = useMemo(() => cardPlayers(block.type, block.data), [block.type, block.data]);
  const columns = useColumns(!!(toggleControl || togglePin));

  return (
    <BlockFrame
      title={titleFor(block)}
      meta={players.length ? `${players.length}` : null}
      note={block.note}
      controls={players.length > 0 && <ViewToggle view={view} onChange={setView} />}
    >
      {players.length === 0 ? (
        <EmptyState compact title="No players" description="Nothing matched." className="rounded-md border border-line bg-surface" />
      ) : view === 'cards' ? (
        <ul
          aria-label={`${titleFor(block)} cards`}
          className="scrollbar-thin -mx-3 flex snap-x snap-mandatory gap-3 overflow-x-auto px-3 pb-1 sm:mx-0 sm:grid sm:snap-none sm:grid-cols-2 sm:overflow-visible sm:px-0"
        >
          {players.map((p, i) => (
            <li key={`${p.name}-${i}`} className="w-[17rem] shrink-0 snap-start sm:w-auto">
              <PlayerCard player={p} className="h-full" />
            </li>
          ))}
        </ul>
      ) : (
        <DataTable data={players} columns={columns} showColumnToggle={false} maxHeight="24rem" getRowId={(p, i) => `${p.name}-${i}`} />
      )}
    </BlockFrame>
  );
}
