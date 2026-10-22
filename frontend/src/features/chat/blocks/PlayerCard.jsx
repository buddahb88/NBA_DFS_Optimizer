import { useState } from 'react';
import { Badge, IconArrowDown, IconArrowUp, IconBan, IconLock, IconPin, Tooltip, cn } from '../../../components/ui';
import { formatDelta } from '../../archetypes/archetypes';
import { formatSalary } from '../../lineupStudio/lineupMath';
import { TONE_TEXT, edgeTone, playerFlags, valuePer1k } from './blockModel';
import { useChatBlocks } from './blocksContext';

const initials = (name) =>
  String(name || '?')
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

export function Headshot({ name, src, size = 'md' }) {
  const [failed, setFailed] = useState(false);
  const box = size === 'sm' ? 'h-7 w-7 text-2xs' : 'h-10 w-10 text-xs';
  if (src && !failed) {
    return <img src={src} alt="" onError={() => setFailed(true)} className={cn(box, 'shrink-0 rounded-full border border-line bg-surface-sunken object-cover')} />;
  }
  return (
    <div aria-hidden="true" className={cn(box, 'flex shrink-0 items-center justify-center rounded-full border border-line bg-surface-sunken font-semibold text-fg-muted')}>
      {initials(name)}
    </div>
  );
}

function ActionButton({ pressed, tone, label, disabledReason, onClick, children }) {
  const button = (
    <button
      type="button"
      aria-label={label}
      aria-pressed={!!pressed}
      aria-disabled={disabledReason ? true : undefined}
      onClick={disabledReason ? undefined : onClick}
      className={cn(
        'inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded border px-1.5 text-2xs font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
        disabledReason && 'cursor-not-allowed opacity-50',
        pressed
          ? {
              positive: 'border-positive/40 bg-positive-soft text-positive',
              negative: 'border-negative/40 bg-negative-soft text-negative',
              accent: 'border-accent/40 bg-accent-soft text-accent',
            }[tone]
          : 'border-line text-fg-muted hover:border-line-strong hover:text-fg',
      )}
    >
      {children}
    </button>
  );
  return <Tooltip content={disabledReason ?? label}>{button}</Tooltip>;
}

/** Lock / Exclude (saved player controls) and Pin (context drawer) for one card player. */
export function PlayerActions({ player, compact = false }) {
  const { controlsFor, toggleControl, isPinned, togglePin } = useChatBlocks();
  if (!toggleControl && !togglePin) return null;
  const controls = controlsFor(player);
  const offSlate = controls === null ? 'Not on the current slate' : null;
  const pinned = isPinned(player);
  return (
    <div className="flex items-center gap-1">
      {toggleControl && (
        <>
          <ActionButton
            pressed={controls?.lock}
            tone="positive"
            label={`${controls?.lock ? 'Unlock' : 'Lock'} ${player.name}`}
            disabledReason={offSlate}
            onClick={() => toggleControl(player, 'lock')}
          >
            <IconLock size={12} />
            {!compact && (controls?.lock ? 'Locked' : 'Lock')}
          </ActionButton>
          <ActionButton
            pressed={controls?.exclude}
            tone="negative"
            label={`${controls?.exclude ? 'Include' : 'Exclude'} ${player.name}`}
            disabledReason={offSlate}
            onClick={() => toggleControl(player, 'exclude')}
          >
            <IconBan size={12} />
            {!compact && (controls?.exclude ? 'Excluded' : 'Exclude')}
          </ActionButton>
        </>
      )}
      {togglePin && (
        <ActionButton pressed={pinned} tone="accent" label={`${pinned ? 'Unpin' : 'Pin'} ${player.name}`} onClick={() => togglePin(player)}>
          <IconPin size={12} />
        </ActionButton>
      )}
    </div>
  );
}

/** "34 min ↑ +4 vs last season" (or vs with, for usage bumps). */
export function MinutesTrend({ player }) {
  const { minutes, lastSeasonMinutes, minutesLabel } = player;
  if (minutes == null) return null;
  const diff = lastSeasonMinutes == null ? null : minutes - lastSeasonMinutes;
  const tone = diff == null || Math.abs(diff) < 2 ? 'text-fg-muted' : diff > 0 ? 'text-positive' : 'text-negative';
  return (
    <div className="flex items-center gap-2 text-2xs">
      <span className="num text-fg">{Number(minutes).toFixed(0)} min</span>
      {diff != null && (
        <span className={cn('num inline-flex items-center gap-0.5', tone)}>
          {diff > 0 ? <IconArrowUp size={10} /> : diff < 0 ? <IconArrowDown size={10} /> : null}
          {formatDelta(diff)} {minutesLabel === 'without / with' ? 'vs with' : 'vs last season'}
        </span>
      )}
    </div>
  );
}

export function FlagBadges({ player }) {
  const flags = playerFlags(player);
  if (flags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <Tooltip key={f.key} content={f.tip}>
          <span tabIndex={0} className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
            <Badge size="sm" tone={f.tone}>
              {f.label}
            </Badge>
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

function Metric({ label, children, className }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs uppercase tracking-wider text-fg-subtle">{label}</dt>
      <dd className={cn('num truncate text-sm font-semibold text-fg', className)}>{children}</dd>
    </div>
  );
}

/** One player result: identity, salary/projection/value, matchup edge, minutes, flags, actions. */
export default function PlayerCard({ player, className }) {
  const { findSlatePlayer, toggleControl, togglePin } = useChatBlocks();
  const slatePlayer = findSlatePlayer(player);
  const salary = player.salary ?? slatePlayer?.salary ?? null;
  const projection = player.projection ?? slatePlayer?.projected_points ?? null;
  const value = valuePer1k(projection, salary);
  const edge = player.adjustedEdge ?? player.matchupEdge;
  const matchup = [player.team, player.opponent && `vs ${player.opponent}`, player.position].filter(Boolean).join(' · ');

  return (
    <article aria-label={player.name} className={cn('flex flex-col gap-2.5 rounded-md border border-line bg-surface p-3 transition-colors hover:border-line-strong', className)}>
      <header className="flex items-start gap-2.5">
        <Headshot name={player.name} src={player.headshot ?? slatePlayer?.headshot} />
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-sm font-semibold text-fg">{player.name}</h4>
          {matchup && <p className="truncate text-2xs text-fg-muted">{matchup}</p>}
          {player.archetypeLabel && (
            <Badge size="sm" tone="accent" className="mt-1 max-w-full truncate">
              {player.archetypeLabel}
            </Badge>
          )}
        </div>
      </header>

      <dl className="grid grid-cols-3 gap-2">
        <Metric label="Salary">{salary != null ? formatSalary(salary) : '—'}</Metric>
        <Metric label="Proj" className="text-accent">
          {projection != null ? Number(projection).toFixed(1) : '—'}
        </Metric>
        <Metric label="Pts/$1K">{value != null ? `${value.toFixed(2)}x` : '—'}</Metric>
      </dl>

      {(player.matchupEdge != null || player.adjustedEdge != null) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
          {player.matchupEdge != null && (
            <span className="text-fg-muted">
              Matchup <span className={cn('num font-semibold', TONE_TEXT[edgeTone(player.matchupEdge)])}>{formatDelta(player.matchupEdge)}</span>
            </span>
          )}
          {player.adjustedEdge != null && (
            <span className="text-fg-muted">
              Adjusted <span className={cn('num font-semibold', TONE_TEXT[edgeTone(edge)])}>{formatDelta(player.adjustedEdge)}</span>
            </span>
          )}
        </div>
      )}

      <MinutesTrend player={player} />
      {player.note && <p className="text-2xs text-fg-muted">{player.note}</p>}
      <FlagBadges player={player} />

      {(toggleControl || togglePin) && (
        <footer className="mt-auto flex justify-end border-t border-line pt-2">
          <PlayerActions player={player} />
        </footer>
      )}
    </article>
  );
}
