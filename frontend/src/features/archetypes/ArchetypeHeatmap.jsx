import { useMemo } from 'react';
import { Tooltip, cn } from '../../components/ui';
import { buildHeatmap, cellColor, formatDelta, statFor } from './archetypes';

function ScaleLegend({ maxAbs, unit }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-2xs text-fg-subtle">
      <span>Tougher than expected</span>
      <span
        aria-hidden="true"
        className="h-2.5 w-32 rounded-sm border border-line"
        style={{
          background:
            'linear-gradient(to right, rgb(var(--negative) / 0.8), rgb(var(--negative) / 0.08), transparent, rgb(var(--info) / 0.08), rgb(var(--info) / 0.8))',
        }}
      />
      <span>Softer than expected</span>
      <span className="num ml-1 text-fg-muted">±{maxAbs.toFixed(1)} {unit}</span>
    </div>
  );
}

/**
 * Teams (rows) x archetypes or G/F/C (columns), each cell the stat allowed
 * over expectation per player-game, on a diverging scale. Clicking a cell
 * calls onCellClick({ team, group, label }).
 */
export default function ArchetypeHeatmap({ rows, definitions, grouping, stat, onCellClick, emptyState }) {
  const map = useMemo(() => buildHeatmap(rows, { definitions, grouping, stat }), [rows, definitions, grouping, stat]);
  const { unit } = statFor(stat);

  if (map.teams.length === 0) return emptyState ?? null;

  return (
    <div className="flex flex-col gap-2">
      <div className="scrollbar-thin overflow-auto rounded-md border border-line">
        <table className="w-full border-separate border-spacing-0 text-xs">
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky left-0 top-0 z-20 border-b border-line bg-surface-sunken px-2 py-1.5 text-left text-2xs font-semibold uppercase tracking-wider text-fg-subtle"
              >
                Team
              </th>
              {map.groups.map((g) => (
                <th
                  key={g.key}
                  scope="col"
                  className="sticky top-0 z-10 min-w-[5.5rem] border-b border-line bg-surface-sunken px-1.5 py-1.5 text-center align-bottom text-2xs font-semibold leading-tight text-fg-subtle"
                >
                  {g.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {map.teams.map((team) => (
              <tr key={team}>
                <th scope="row" className="sticky left-0 z-10 border-b border-line/60 bg-surface px-2 text-left font-semibold text-fg">
                  {team}
                </th>
                {map.groups.map((g) => {
                  const c = map.cell(team, g.key);
                  if (!c || c.value == null) {
                    return (
                      <td key={g.key} className="border-b border-l border-line/60 text-center text-fg-subtle">
                        —
                      </td>
                    );
                  }
                  const text = formatDelta(c.value);
                  const games = c.row.games ?? 0;
                  return (
                    <td key={g.key} className="border-b border-l border-line/60 p-0">
                      <Tooltip
                        content={
                          <span className="num">
                            {team} vs {g.label}: {text} {unit} per player-game · {games} games
                            {c.row.player_games != null && `, ${c.row.player_games} player-games`}
                          </span>
                        }
                      >
                        <button
                          type="button"
                          onClick={() => onCellClick?.({ team, group: g.key, label: g.label })}
                          aria-label={`${team} vs ${g.label}: ${text} ${unit} over expectation, ${games} games`}
                          style={{ backgroundColor: cellColor(c.value, map.maxAbs) }}
                          className={cn(
                            'num block h-7 w-full px-1.5 text-center text-fg transition-shadow',
                            'hover:ring-2 hover:ring-inset hover:ring-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
                          )}
                        >
                          {text}
                        </button>
                      </Tooltip>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ScaleLegend maxAbs={map.maxAbs} unit={unit} />
    </div>
  );
}
