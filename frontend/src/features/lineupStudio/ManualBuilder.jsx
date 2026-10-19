import { useMemo, useState } from 'react';
import { Badge, Button, Card, CardHeader, DataTable, IconSearch, IconX, Input, Stat, Tabs, cn } from '../../components/ui';
import { canFillSlot, eligibleSlotIndexes, formatSalary, lineupTotals, pickSlot, playerPositions } from './lineupMath';

const slotHint = (slotDef) => (slotDef.eligible || [slotDef.slot]).join('/');

/**
 * Click-to-fill lineup builder. `slots` is an array aligned with
 * siteConfig.rosterSlots (player or null); the page owns it so generated
 * lineups can be opened here for editing.
 */
export default function ManualBuilder({ siteConfig, players, slots, onSlotsChange, onSave, onExport, saving, exporting }) {
  const [search, setSearch] = useState('');
  const [position, setPosition] = useState('ALL');
  const [targetSlot, setTargetSlot] = useState(null); // slot index the next click fills
  const [name, setName] = useState('My lineup');

  const { rosterSlots, salaryCap } = siteConfig;
  const totals = lineupTotals(slots, salaryCap);
  const open = rosterSlots.length - totals.filled;
  const complete = open === 0;
  const overCap = totals.remaining < 0;
  const inLineup = useMemo(() => new Set(slots.filter(Boolean).map((p) => p.id)), [slots]);

  const positions = useMemo(
    () => ['ALL', ...new Set(rosterSlots.flatMap((s) => s.eligible || [s.slot]))],
    [rosterSlots],
  );

  /** Where a click on this player would go, or why it can't. */
  const placement = (player) => {
    if (inLineup.has(player.id)) return { reason: 'In lineup' };
    if (targetSlot != null) {
      if (!canFillSlot(player, rosterSlots[targetSlot])) return { reason: `Not ${rosterSlots[targetSlot].slot}-eligible` };
      if (player.salary > totals.remaining) return { reason: 'Over budget' };
      return { index: targetSlot };
    }
    if (eligibleSlotIndexes(siteConfig, player).length === 0) return { reason: 'No eligible slot' };
    const index = pickSlot(siteConfig, slots, player);
    if (index === -1) return { reason: 'No open slot' };
    if (player.salary > totals.remaining) return { reason: 'Over budget' };
    return { index };
  };

  const place = (player) => {
    const { index } = placement(player);
    if (index == null) return;
    onSlotsChange(slots.map((p, i) => (i === index ? player : p)));
    setTargetSlot(null);
  };

  const remove = (index) => onSlotsChange(slots.map((p, i) => (i === index ? null : p)));

  const visible = useMemo(
    () =>
      players.filter((p) => {
        if (position !== 'ALL' && !playerPositions(p).includes(position)) return false;
        return targetSlot == null || canFillSlot(p, rosterSlots[targetSlot]);
      }),
    [players, position, targetSlot, rosterSlots],
  );

  const columns = [
    {
      id: 'add',
      header: '',
      enableSorting: false,
      size: 96,
      cell: ({ row }) => {
        const where = placement(row.original);
        return where.index != null ? (
          <Button
            size="xs"
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              place(row.original);
            }}
          >
            + {rosterSlots[where.index].slot}
          </Button>
        ) : (
          <span className="text-2xs text-fg-subtle">{where.reason}</span>
        );
      },
    },
    { id: 'name', header: 'Player', accessorKey: 'name', meta: { className: 'font-medium' } },
    { id: 'pos', header: 'Pos', accessorKey: 'position', size: 70 },
    { id: 'team', header: 'Team', accessorFn: (p) => `${p.team ?? ''} v ${p.opponent ?? ''}`, size: 90 },
    { id: 'salary', header: 'Salary', accessorKey: 'salary', cell: (c) => formatSalary(c.getValue()), meta: { numeric: true } },
    { id: 'proj', header: 'Proj', accessorFn: (p) => p.projected_points || 0, cell: (c) => c.getValue().toFixed(1), meta: { numeric: true } },
    {
      id: 'value',
      header: 'Value',
      accessorFn: (p) => (p.salary ? ((p.projected_points || 0) / p.salary) * 1000 : 0),
      cell: (c) => c.getValue().toFixed(2),
      meta: { numeric: true },
    },
    { id: 'own', header: 'Own', accessorFn: (p) => p.rostership || 0, cell: (c) => `${c.getValue().toFixed(1)}%`, meta: { numeric: true } },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
      <Card className="self-start">
        <CardHeader
          title="Your lineup"
          subtitle={`${totals.filled}/${rosterSlots.length} filled · ${siteConfig.name}`}
          actions={
            <Button
              variant="ghost"
              size="xs"
              disabled={totals.filled === 0}
              onClick={() => {
                onSlotsChange(slots.map(() => null));
                setTargetSlot(null);
              }}
            >
              Clear
            </Button>
          }
        />
        <div className="grid grid-cols-2 gap-2 p-3">
          <Stat
            label="Remaining"
            value={formatSalary(totals.remaining)}
            hint={open > 0 && !overCap ? `${formatSalary(totals.remaining / open)} / open slot` : `of ${formatSalary(salaryCap)}`}
            className={cn(overCap && 'border-negative/60')}
          />
          <Stat label="Projection" value={totals.projection.toFixed(1)} hint={`Own Σ ${totals.ownership.toFixed(0)}%`} />
        </div>
        <ul className="divide-y divide-line border-y border-line" aria-label="Roster slots">
          {rosterSlots.map((slotDef, i) => {
            const player = slots[i];
            const targeted = targetSlot === i;
            return (
              <li key={i}>
                <div
                  className={cn(
                    'flex h-11 items-center gap-2 px-3 text-sm',
                    targeted && 'bg-accent-soft',
                    !player && 'cursor-pointer hover:bg-surface-raised',
                  )}
                  {...(!player && {
                    role: 'button',
                    tabIndex: 0,
                    'aria-pressed': targeted,
                    onClick: () => setTargetSlot(targeted ? null : i),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setTargetSlot(targeted ? null : i);
                      }
                    },
                  })}
                >
                  <Badge tone={player ? 'accent' : 'neutral'} className="w-12 justify-center">
                    {slotDef.slot}
                  </Badge>
                  {player ? (
                    <>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-fg">{player.name}</div>
                        <div className="text-2xs text-fg-subtle">
                          {player.position} · {player.team} · {player.projected_points?.toFixed(1)} pts
                        </div>
                      </div>
                      <span className="num text-xs text-fg-muted">{formatSalary(player.salary)}</span>
                      <Button variant="ghost" size="icon-sm" aria-label={`Remove ${player.name}`} onClick={() => remove(i)}>
                        <IconX size={13} />
                      </Button>
                    </>
                  ) : (
                    <span className="flex-1 text-xs text-fg-subtle">
                      {targeted ? `Pick a ${slotHint(slotDef)} player →` : `Empty · ${slotHint(slotDef)}`}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-col gap-2 p-3">
          {overCap && <p className="text-xs text-negative">Over the {formatSalary(salaryCap)} cap by {formatSalary(-totals.remaining)}.</p>}
          <Input aria-label="Lineup name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Lineup name" />
          <div className="grid grid-cols-2 gap-2">
            <Button variant="primary" className="justify-center" disabled={!complete || overCap || !name.trim()} loading={saving} onClick={() => onSave(name.trim())}>
              Save lineup
            </Button>
            <Button variant="secondary" className="justify-center" disabled={!complete || overCap} loading={exporting} onClick={onExport}>
              Export CSV
            </Button>
          </div>
          {!complete && <p className="text-2xs text-fg-subtle">Fill all {rosterSlots.length} slots to save or export.</p>}
        </div>
      </Card>

      <DataTable
        data={visible}
        columns={columns}
        getRowId={(p) => String(p.id)}
        globalFilter={search}
        initialSorting={[{ id: 'proj', desc: true }]}
        maxHeight="calc(100vh - 260px)"
        onRowClick={place}
        rowClassName={(p) => (placement(p).index == null ? 'opacity-45' : '')}
        emptyState={<div className="py-8 text-center text-xs text-fg-subtle">No players match these filters.</div>}
        toolbar={
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <Input
              aria-label="Search players"
              placeholder="Search players…"
              leftIcon={<IconSearch size={13} />}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-48"
            />
            <Tabs
              variant="pill"
              size="sm"
              value={position}
              onChange={setPosition}
              tabs={positions.map((p) => ({ value: p, label: p === 'ALL' ? 'All' : p }))}
            />
            {targetSlot != null && (
              <Badge tone="accent">
                Filling {rosterSlots[targetSlot].slot}
                <button type="button" aria-label="Stop filling slot" onClick={() => setTargetSlot(null)} className="ml-0.5">
                  <IconX size={10} />
                </button>
              </Badge>
            )}
          </div>
        }
      />
    </div>
  );
}
