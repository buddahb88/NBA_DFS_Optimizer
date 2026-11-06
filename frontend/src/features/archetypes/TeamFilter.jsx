import { useEffect, useRef, useState } from 'react';
import { IconChevronDown, IconX, cn } from '../../components/ui';
import { TONIGHT_TEAMS } from './archetypes';

const shortcutClass = (active) =>
  cn(
    'h-6 rounded px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40',
    active ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-surface-sunken hover:text-fg',
  );

function summary(value, tonightTeams) {
  if (value === TONIGHT_TEAMS) return tonightTeams.length ? `Tonight · ${tonightTeams.length} teams` : 'Tonight’s slate';
  if (!value?.length) return 'All teams';
  return value.length === 1 ? value[0] : `${value.length} teams`;
}

/**
 * Teams multi-select for the heatmap rows. `value` = [] (all) | 'tonight' |
 * abbreviations; `teams` = the options (A-Z); `tonightTeams` = the selected
 * slate's teams (empty disables the shortcut).
 */
export default function TeamFilter({ value, onChange, teams, tonightTeams = [] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const isTonight = value === TONIGHT_TEAMS;
  const checked = new Set(isTonight ? tonightTeams : value ?? []);
  const active = isTonight || checked.size > 0;
  // Teams picked from a link before the grid loaded still show
  const options = [...new Set([...teams, ...checked])].sort();

  const toggle = (team) => {
    const next = new Set(checked);
    if (next.has(team)) next.delete(team);
    else next.add(team);
    onChange([...next].sort());
  };

  return (
    <div ref={ref} className="relative flex flex-col gap-1">
      <span className="text-xs font-medium text-fg-muted">Teams</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="true"
          aria-label={`Teams: ${summary(value, tonightTeams)}`}
          className={cn(
            'inline-flex h-7 min-w-[7.5rem] items-center justify-between gap-1.5 rounded border border-line bg-surface-raised px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
            active ? 'text-fg' : 'text-fg-muted hover:text-fg',
          )}
        >
          <span className="num">{summary(value, tonightTeams)}</span>
          <IconChevronDown size={13} className="text-fg-subtle" />
        </button>
        {active && (
          <button
            type="button"
            onClick={() => onChange([])}
            aria-label="Clear team filter"
            title="Show all teams"
            className="inline-flex h-7 w-7 items-center justify-center rounded text-fg-subtle hover:bg-surface-sunken hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <IconX size={13} />
          </button>
        )}
      </div>
      {open && (
        <div
          role="group"
          aria-label="Pick teams"
          className="absolute left-0 top-full z-30 mt-1 w-64 rounded-md border border-line bg-surface-raised p-1.5 shadow-pop animate-fade-in"
        >
          <div className="mb-1 flex items-center gap-1 border-b border-line pb-1.5">
            <button type="button" className={shortcutClass(!active)} aria-pressed={!active} onClick={() => onChange([])}>
              All
            </button>
            <button
              type="button"
              className={shortcutClass(isTonight)}
              aria-pressed={isTonight}
              disabled={!tonightTeams.length}
              title={tonightTeams.length ? `The ${tonightTeams.length} teams on the selected slate` : 'No slate loaded'}
              onClick={() => onChange(TONIGHT_TEAMS)}
            >
              Tonight’s slate
            </button>
          </div>
          {options.length === 0 ? (
            <p className="px-2 py-1 text-xs text-fg-subtle">No teams loaded yet.</p>
          ) : (
            <div className="scrollbar-thin grid max-h-64 grid-cols-3 gap-0.5 overflow-y-auto">
              {options.map((team) => (
                <label key={team} className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-xs text-fg hover:bg-surface-sunken">
                  <input
                    type="checkbox"
                    checked={checked.has(team)}
                    onChange={() => toggle(team)}
                    className="h-3.5 w-3.5 accent-[rgb(var(--accent))]"
                  />
                  {team}
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
