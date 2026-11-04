// Player card charts. Colours come from the theme tokens (theme.css): chart-1 /
// chart-2 are the validated series pair; positive / negative are the status
// pair for beat / miss (always with a legend or label, never colour alone).
import {
  Bar,
  BarChart,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cn } from '../../components/ui';
import { fmt, fmtPct, fmtSigned, isNum, pctAlong, shortDate } from './cardFormat';
import useChartTokens from './useChartTokens';

const axisProps = (c) => ({ stroke: c.line, tick: { fill: c['fg-subtle'], fontSize: 10 }, tickLine: false });

function TipBox({ title, rows, children }) {
  return (
    <div className="max-w-[16rem] rounded-md border border-line bg-surface-raised px-2.5 py-2 text-xs shadow-pop">
      <div className="mb-1 font-medium text-fg">{title}</div>
      {rows?.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-fg-muted">
            {r.color && <span className="inline-block h-2 w-2 rounded-sm" style={{ background: r.color }} />}
            {r.label}
          </span>
          <span className="num text-fg">{r.value}</span>
        </div>
      ))}
      {children}
    </div>
  );
}

export function LegendRow({ items }) {
  return (
    <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-fg-muted">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          {i.line ? (
            <span className="inline-block h-0 w-3.5 border-t-2" style={{ borderColor: i.color, borderStyle: i.dashed ? 'dashed' : 'solid' }} />
          ) : (
            <span className={cn('inline-block h-2.5 w-2.5', i.round ? 'rounded-full' : 'rounded-sm')} style={{ background: i.hollow ? 'transparent' : i.color, border: `2px solid ${i.color}` }} />
          )}
          {i.label}
        </li>
      ))}
    </ul>
  );
}

// NBA seasons turn over in the summer: Aug-Dec belongs to the season starting that year
const seasonOf = (date) => (Number(date.slice(5, 7)) >= 8 ? Number(date.slice(0, 4)) : Number(date.slice(0, 4)) - 1);

const ChartEmpty = ({ children }) => (
  <div className="flex h-32 items-center justify-center rounded-md border border-dashed border-line text-xs text-fg-subtle">{children}</div>
);

// ---------------------------------------------------------------------------
// 1. Game log: DK points per game, beat / miss of 5x value, projection + averages
// ---------------------------------------------------------------------------

export function GameLogChart({ log = [], projection, l5, season }) {
  const c = useChartTokens();
  if (!log.length) return <ChartEmpty>No games yet this season or last</ChartEmpty>;
  const data = log.map((g) => ({ ...g, label: shortDate(g.date) }));
  const color = (g) => (g.hit === true ? c.positive : g.hit === false ? c.negative : c['chart-1']);
  const priced = log.some((g) => g.hit !== null);
  // The log reaches back into last season early on: mark where this one starts
  const firstNew = data.findIndex((g, i) => i > 0 && seasonOf(g.date) !== seasonOf(data[i - 1].date));
  const seasonStart = firstNew > 0 ? data[firstNew].label : null;
  return (
    <div>
      <div className="h-44 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 10, right: 8, left: -6, bottom: 0 }}>
            <XAxis dataKey="label" {...axisProps(c)} interval="preserveStartEnd" minTickGap={6} />
            <YAxis {...axisProps(c)} width={40} />
            <Tooltip
              cursor={{ fill: c.line, opacity: 0.35 }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const g = payload[0].payload;
                return (
                  <TipBox
                    title={`${g.date} ${g.is_home === false ? '@' : 'vs'} ${g.opponent ?? ''}${g.back_to_back ? ' · B2B' : ''}`}
                    rows={[
                      { label: 'DK points', value: fmt(g.fp, 2), color: color(g) },
                      { label: 'Minutes', value: `${fmt(g.minutes, 0)}${g.is_starter === false ? ' (bench)' : ''}` },
                      ...(g.salary ? [{ label: `Value ($${(g.salary / 1000).toFixed(1)}K)`, value: `${fmt(g.value, 2)}x` }] : []),
                    ]}
                  >
                    <div className="num mt-1 border-t border-line pt-1 text-2xs text-fg-muted">
                      {g.pts ?? 0} pts · {g.reb ?? 0} reb · {g.ast ?? 0} ast · {g.fg3m ?? 0} 3pm · {g.stl ?? 0} stl · {g.blk ?? 0} blk · {g.tov ?? 0} tov
                    </div>
                  </TipBox>
                );
              }}
            />
            <Bar dataKey="fp" radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false}>
              {data.map((g) => (
                <Cell key={g.date} fill={color(g)} fillOpacity={g.hit === null ? 0.55 : 0.85} />
              ))}
            </Bar>
            {isNum(season) && <ReferenceLine y={season} stroke={c['fg-subtle']} strokeDasharray="2 3" />}
            {isNum(l5) && <ReferenceLine y={l5} stroke={c['chart-2']} strokeDasharray="5 3" strokeWidth={1.5} />}
            {isNum(projection) && <ReferenceLine y={projection} stroke={c.fg} strokeWidth={2} />}
            {seasonStart && (
              <ReferenceLine x={seasonStart} stroke={c['fg-subtle']} strokeDasharray="3 3" label={{ value: 'new season', position: 'insideTopLeft', fill: c['fg-subtle'], fontSize: 10 }} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <LegendRow
        items={[
          ...(priced ? [{ label: 'Beat 5x', color: c.positive }, { label: 'Missed 5x', color: c.negative }] : []),
          { label: priced ? 'No salary that night' : 'DK points', color: c['chart-1'] },
          ...(isNum(projection) ? [{ label: `Tonight ${fmt(projection)}`, color: c.fg, line: true }] : []),
          ...(isNum(l5) ? [{ label: `L5 ${fmt(l5)}`, color: c['chart-2'], line: true, dashed: true }] : []),
          ...(isNum(season) ? [{ label: `Season ${fmt(season)}`, color: c['fg-subtle'], line: true, dashed: true }] : []),
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Minutes trend: started (filled) / bench (hollow), tonight's projections
// ---------------------------------------------------------------------------

export function MinutesChart({ log = [], oursMinutes, rotowireMinutes }) {
  const c = useChartTokens();
  if (!log.length) return <ChartEmpty>No minutes history</ChartEmpty>;
  const data = [
    ...log.map((g) => ({ label: shortDate(g.date), minutes: g.minutes, starter: g.is_starter, date: g.date, opponent: g.opponent })),
    { label: 'Tonight', ours: isNum(oursMinutes) ? Number(oursMinutes) : null, rw: isNum(rotowireMinutes) ? Number(rotowireMinutes) : null, tonight: true },
  ];
  const Dot = ({ cx, cy, payload }) => {
    if (!isNum(cy) || payload.minutes == null) return null;
    const bench = payload.starter === false;
    return <circle cx={cx} cy={cy} r={4} fill={bench ? c.surface : c['chart-1']} stroke={c['chart-1']} strokeWidth={2} />;
  };
  return (
    <div>
      <div className="h-36 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 10, right: 10, left: -6, bottom: 0 }}>
            <XAxis dataKey="label" {...axisProps(c)} interval="preserveStartEnd" minTickGap={6} />
            <YAxis {...axisProps(c)} width={40} domain={[(min) => Math.max(0, Math.floor(min - 4)), (max) => Math.ceil(max + 2)]} />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload;
                if (p.tonight) {
                  return <TipBox title="Tonight (projected)" rows={[{ label: 'Ours', value: fmt(p.ours), color: c['chart-2'] }, { label: 'RotoWire', value: fmt(p.rw), color: c['fg-muted'] }]} />;
                }
                return <TipBox title={`${p.date} vs ${p.opponent ?? ''}`} rows={[{ label: p.starter === false ? 'Minutes (bench)' : 'Minutes (started)', value: fmt(p.minutes, 0) }]} />;
              }}
            />
            <Line dataKey="minutes" stroke={c['chart-1']} strokeWidth={2} dot={<Dot />} activeDot={{ r: 6 }} isAnimationActive={false} connectNulls={false} />
            <Line dataKey="rw" stroke="none" dot={{ r: 7, fill: 'none', stroke: c['fg-muted'], strokeWidth: 2 }} isAnimationActive={false} legendType="none" />
            <Line dataKey="ours" stroke="none" dot={{ r: 4, fill: c['chart-2'], stroke: c.surface, strokeWidth: 1.5 }} isAnimationActive={false} legendType="none" />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <LegendRow
        items={[
          { label: 'Started', color: c['chart-1'], round: true },
          { label: 'Bench', color: c['chart-1'], round: true, hollow: true },
          { label: `Ours tonight ${fmt(oursMinutes)}`, color: c['chart-2'], round: true },
          { label: `RotoWire ${fmt(rotowireMinutes)}`, color: c['fg-muted'], round: true, hollow: true },
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Outcome range: p10 - median - p90 bands, boom marker, actual (backtest)
// ---------------------------------------------------------------------------

export function OutcomeRange({ projection, actual }) {
  const rows = [
    { key: 'blend', label: 'Blend', lo: projection.blend_p10, mid: projection.blend, hi: projection.blend_p90, tone: 'chart-1' },
    { key: 'ours', label: 'Ours', lo: projection.p10, mid: projection.ours_median ?? projection.ours, hi: projection.p90, tone: 'chart-2' },
  ].filter((r) => isNum(r.lo) && isNum(r.hi));
  if (!rows.length && isNum(projection.floor) && isNum(projection.ceiling)) {
    rows.push({ key: 'posted', label: 'Range', lo: projection.floor, mid: projection.active, hi: projection.ceiling, tone: 'chart-1' });
  }
  if (!rows.length) return <ChartEmpty>No outcome range for this player</ChartEmpty>;
  const boom = projection.boom_at;
  const values = rows.flatMap((r) => [r.lo, r.hi]).concat([boom, actual, projection.rotowire].filter(isNum));
  const lo = Math.max(0, Math.floor(Math.min(...values) * 0.85));
  const hi = Math.ceil(Math.max(...values) * 1.06);
  const at = (x) => pctAlong(Number(x), lo, hi);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(lo + t * (hi - lo)));
  return (
    <div className="space-y-3 pt-1">
      <div className="relative space-y-4">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-2xs font-medium text-fg-muted">{r.label}</span>
            <div className="relative h-6 flex-1">
              <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line" />
              <div
                className="absolute top-1 h-4 rounded"
                style={{
                  left: `${at(r.lo)}%`,
                  width: `${Math.max(1, at(r.hi) - at(r.lo))}%`,
                  background: `linear-gradient(90deg, rgb(var(--${r.tone}) / 0.15), rgb(var(--${r.tone}) / 0.55) 50%, rgb(var(--${r.tone}) / 0.15))`,
                  border: `1px solid rgb(var(--${r.tone}) / 0.6)`,
                }}
                title={`${r.label}: p10 ${fmt(r.lo)} · median ${fmt(r.mid)} · p90 ${fmt(r.hi)}`}
              />
              {isNum(r.mid) && <div className="absolute top-0 h-6 w-0.5 rounded bg-fg" style={{ left: `${at(r.mid)}%` }} />}
              <span className="num absolute -bottom-3.5 -translate-x-1/2 text-[10px] text-fg-subtle" style={{ left: `${at(r.lo)}%` }}>{fmt(r.lo, 0)}</span>
              <span className="num absolute -bottom-3.5 -translate-x-1/2 text-[10px] text-fg-subtle" style={{ left: `${at(r.hi)}%` }}>{fmt(r.hi, 0)}</span>
              {isNum(r.mid) && (
                <span className="num absolute -top-3.5 -translate-x-1/2 text-[10px] font-semibold text-fg" style={{ left: `${at(r.mid)}%` }}>{fmt(r.mid)}</span>
              )}
            </div>
          </div>
        ))}
        {/* Boom threshold and actual run through every row */}
        <div className="pointer-events-none absolute inset-y-0 left-14 right-0">
          {isNum(boom) && (
            <div className="absolute inset-y-[-6px] border-l-2 border-dashed border-caution" style={{ left: `${at(boom)}%` }}>
              <span className={cn('absolute -top-4 whitespace-nowrap text-[10px] font-semibold text-caution', at(boom) > 80 ? 'right-1' : 'left-1')}>Boom {fmt(boom, 0)}</span>
            </div>
          )}
          {isNum(actual) && (
            <div className="absolute inset-y-[-6px] border-l-2 border-accent" style={{ left: `${at(actual)}%` }}>
              <span className={cn('absolute -bottom-5 whitespace-nowrap rounded bg-accent px-1 text-[10px] font-semibold text-accent-fg', at(actual) > 80 ? 'right-1' : 'left-1')}>Actual {fmt(actual)}</span>
            </div>
          )}
        </div>
      </div>
      <div className="ml-14 flex justify-between pt-2 text-[10px] text-fg-subtle">
        {ticks.map((t) => <span key={t} className="num">{t}</span>)}
      </div>
      <p className="text-2xs text-fg-muted">
        Bands run 10th to 90th percentile, the tick is the median.
        {isNum(projection.p_boom) && <> Boom (6x salary) chance: <span className="num font-semibold text-fg">{fmtPct(projection.p_boom)}</span>.</>}
        {isNum(projection.p_dd) && <> Double-double: <span className="num font-semibold text-fg">{fmtPct(projection.p_dd)}</span>.</>}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Matchup: opponent per-stat deltas vs his archetype (diverging bars)
// ---------------------------------------------------------------------------

const STAT_LABELS = [
  ['pts', 'Points'],
  ['reb', 'Rebounds'],
  ['ast', 'Assists'],
  ['fg3m', 'Threes'],
  ['stocks', 'Stl + Blk'],
];

export function MatchupBars({ stats, fp }) {
  if (!stats) return <ChartEmpty>No per-stat matchup data</ChartEmpty>;
  const rows = [['fp', 'Fantasy pts', fp], ...STAT_LABELS.map(([k, l]) => [k, l, stats[k]])].filter(([, , v]) => isNum(v));
  const max = Math.max(1, ...rows.map(([, , v]) => Math.abs(v)));
  return (
    <div className="space-y-1.5" role="table" aria-label="Opponent allowed vs expectation">
      {rows.map(([key, label, v]) => {
        const w = (Math.abs(v) / max) * 50;
        const up = v >= 0;
        return (
          <div key={key} role="row" className={cn('grid grid-cols-[5.5rem_1fr_3rem] items-center gap-2 text-2xs', key === 'fp' && 'font-semibold')}>
            <span role="cell" className="text-fg-muted">{label}</span>
            <div role="cell" className="relative h-3.5">
              <div className="absolute inset-y-0 left-1/2 w-px bg-line-strong" />
              <div
                className={cn('absolute top-0 h-3.5', up ? 'rounded-r bg-positive/70' : 'rounded-l bg-negative/70')}
                style={up ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }}
              />
            </div>
            <span role="cell" className="num text-right text-fg">{fmtSigned(v, key === 'fp' ? 1 : 2)}</span>
          </div>
        );
      })}
      <div className="grid grid-cols-[5.5rem_1fr_3rem] gap-2 text-[10px] text-fg-subtle">
        <span />
        <span className="flex justify-between"><span>Allows less</span><span>Allows more</span></span>
        <span />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. Role radar: this season vs last season vs archetype average
// ---------------------------------------------------------------------------

const ROLE_AXES = [
  ['usg_pct', 'Usage'],
  ['ast_pct', 'Assist %'],
  ['reb_pct', 'Rebound %'],
  ['three_pa_rate', '3PA rate'],
  ['ts_pct', 'True shooting'],
];

export function RoleRadar({ current, previous, average, labels }) {
  const c = useChartTokens();
  const series = [
    ['current', current, c['chart-1'], labels.current],
    ['previous', previous, c['chart-2'], labels.previous],
    ['average', average, c['fg-subtle'], labels.average],
  ].filter(([, s]) => s);
  if (!series.length) return <ChartEmpty>No role profile yet</ChartEmpty>;
  // Each axis is scaled to its own max so rates of different size share the radar
  const data = ROLE_AXES.map(([key, label]) => {
    const max = Math.max(...series.map(([, s]) => Number(s[key]) || 0)) || 1;
    return Object.fromEntries([
      ['axis', label],
      ['key', key],
      ...series.flatMap(([name, s]) => [[name, ((Number(s[key]) || 0) / max) * 100], [`${name}_raw`, s[key]]]),
    ]);
  });
  return (
    <div>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={data} outerRadius="72%" margin={{ top: 4, right: 24, bottom: 4, left: 24 }}>
            <PolarGrid stroke={c.line} />
            <PolarAngleAxis dataKey="axis" tick={{ fill: c['fg-muted'], fontSize: 10 }} />
            {series.map(([name, , color]) => (
              <Radar
                key={name}
                dataKey={name}
                stroke={color}
                strokeWidth={2}
                strokeDasharray={name === 'average' ? '4 3' : undefined}
                fill={color}
                fillOpacity={name === 'current' ? 0.25 : 0.06}
                isAnimationActive={false}
              />
            ))}
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const row = payload[0].payload;
                return (
                  <TipBox
                    title={row.axis}
                    rows={series.map(([name, , color, label]) => ({ label, value: fmtPct(row[`${name}_raw`], 1), color }))}
                  />
                );
              }}
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>
      <LegendRow items={series.map(([name, , color, label]) => ({ label, color, line: true, dashed: name === 'average' }))} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 6. Ownership vs value: where he sits on the leverage map
// ---------------------------------------------------------------------------

export function LeverageMap({ value, ownership }) {
  if (!isNum(value) || !isNum(ownership)) return null;
  const x = pctAlong(Math.min(Number(ownership), 50), 0, 50);
  const y = 100 - pctAlong(Math.max(3, Math.min(Number(value), 7)), 3, 7);
  const quadrant = value >= 5 ? (ownership < 15 ? 'Leverage' : 'Chalk') : ownership < 15 ? 'Contrarian dart' : 'Overowned';
  return (
    <figure className="w-full" aria-label={`Ownership ${fmt(ownership)}% vs value ${fmt(value, 2)}x: ${quadrant}`}>
      <div className="relative aspect-[5/3] w-full overflow-hidden rounded-md border border-line bg-surface-sunken">
        <div className="absolute inset-y-0 left-[30%] w-px bg-line-strong" />
        <div className="absolute inset-x-0 top-1/2 h-px bg-line-strong" />
        <span className="absolute left-1.5 top-1 text-[10px] font-semibold text-positive">Leverage</span>
        <span className="absolute right-1.5 top-1 text-[10px] font-semibold text-info">Chalk</span>
        <span className="absolute bottom-1 left-1.5 text-[10px] text-fg-subtle">Dart</span>
        <span className="absolute bottom-1 right-1.5 text-[10px] text-negative">Overowned</span>
        <div
          className="absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-accent shadow-pop ring-4 ring-accent/25"
          style={{ left: `${x}%`, top: `${y}%` }}
        />
      </div>
      <figcaption className="mt-1 flex justify-between text-[10px] text-fg-subtle">
        <span>Own 0% → 50%</span>
        <span>Value 3x ↑ 7x</span>
      </figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Track record sparkline: past projections vs actual
// ---------------------------------------------------------------------------

export function TrackRecordChart({ recent = [] }) {
  const c = useChartTokens();
  if (recent.length < 2) return null;
  const data = recent.map((r) => ({ ...r, label: shortDate(r.date) }));
  return (
    <div>
      <div className="h-28 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 4, left: -6, bottom: 0 }} barGap={2}>
            <XAxis dataKey="label" {...axisProps(c)} interval="preserveStartEnd" />
            <YAxis {...axisProps(c)} width={36} />
            <Tooltip
              cursor={{ fill: c.line, opacity: 0.35 }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const r = payload[0].payload;
                return (
                  <TipBox
                    title={r.date}
                    rows={[
                      { label: 'Projected', value: fmt(r.projection), color: c['fg-subtle'] },
                      { label: 'Actual', value: fmt(r.actual), color: c['chart-1'] },
                      { label: 'Error', value: fmtSigned(r.actual - r.projection) },
                    ]}
                  />
                );
              }}
            />
            <Bar dataKey="projection" fill={c['fg-subtle']} fillOpacity={0.45} radius={[3, 3, 0, 0]} maxBarSize={12} isAnimationActive={false} />
            <Bar dataKey="actual" fill={c['chart-1']} radius={[3, 3, 0, 0]} maxBarSize={12} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <LegendRow items={[{ label: 'Projected', color: c['fg-subtle'] }, { label: 'Actual', color: c['chart-1'] }]} />
    </div>
  );
}

/** Small ring showing a 0-100 confidence. */
export function ConfidenceRing({ value, tone = 'accent', size = 34 }) {
  const r = (size - 5) / 2;
  const circ = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(var(--line))" strokeWidth={3.5} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={`rgb(var(--${tone}))`}
        strokeWidth={3.5}
        strokeLinecap="round"
        strokeDasharray={`${(v / 100) * circ} ${circ}`}
      />
    </svg>
  );
}

/** Horizontal 0-100 meter (Opportunity Radar scores). */
export function ScoreMeter({ label, value, tone = 'accent' }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-2xs">
        <span className="text-fg-muted">{label}</span>
        <span className="num font-semibold text-fg">{isNum(value) ? Math.round(value) : '–'}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
        <div className="h-full rounded-full" style={{ width: `${isNum(value) ? Math.max(2, Math.min(100, value)) : 0}%`, background: `rgb(var(--${tone}))` }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Minutes band: our p10-p90 minutes, ours (and before the RotoWire correction),
// RotoWire's minutes, the actual on a backtest night
// ---------------------------------------------------------------------------

export function MinutesBand({ upside, actual }) {
  const u = upside ?? {};
  const marks = [
    { key: 'ours', label: 'Ours', value: u.ours, className: 'bg-fg', solid: true },
    { key: 'raw', label: 'Before correction', value: isNum(u.ours_raw) && isNum(u.ours) && Math.abs(u.ours_raw - u.ours) >= 0.5 ? u.ours_raw : null, className: 'border-l-2 border-dashed border-fg-muted' },
    { key: 'rw', label: 'RotoWire', value: u.rotowire, className: 'border-l-2', style: { borderColor: 'rgb(var(--chart-1))' } },
  ].filter((m) => isNum(m.value));
  const hasBand = isNum(u.p10) && isNum(u.p90);
  if (!hasBand && !marks.length) return <ChartEmpty>No minutes projection</ChartEmpty>;
  const values = [u.p10, u.p90, actual, ...marks.map((m) => m.value)].filter(isNum).map(Number);
  const lo = Math.max(0, Math.floor((Math.min(...values) - 3) / 5) * 5);
  const hi = Math.min(48, Math.ceil((Math.max(...values) + 3) / 5) * 5);
  const at = (x) => pctAlong(Number(x), lo, hi);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(lo + t * (hi - lo)));
  return (
    <div className="space-y-2 pt-4" role="img" aria-label={`Minutes: ours ${fmt(u.ours)}${hasBand ? `, p10 ${fmt(u.p10)} to p90 ${fmt(u.p90)}` : ''}, RotoWire ${fmt(u.rotowire)}`}>
      <div className="relative h-8">
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line" />
        {hasBand && (
          <div
            className="absolute top-1.5 h-5 rounded"
            style={{
              left: `${at(u.p10)}%`,
              width: `${Math.max(1, at(u.p90) - at(u.p10))}%`,
              background: 'linear-gradient(90deg, rgb(var(--chart-2) / 0.15), rgb(var(--chart-2) / 0.5) 50%, rgb(var(--chart-2) / 0.15))',
              border: '1px solid rgb(var(--chart-2) / 0.6)',
            }}
            title={`Our minutes p10 ${fmt(u.p10)} · p90 ${fmt(u.p90)}`}
          />
        )}
        {marks.map((m) => (
          <div key={m.key} className={cn('absolute top-0 h-8', m.solid ? 'w-0.5 rounded' : 'w-0', m.className)} style={{ ...m.style, left: `${at(m.value)}%` }} title={`${m.label} ${fmt(m.value)}`} />
        ))}
        {isNum(actual) && (
          <div className="absolute inset-y-[-4px] border-l-2 border-accent" style={{ left: `${at(actual)}%` }}>
            <span className={cn('absolute -top-4 whitespace-nowrap rounded bg-accent px-1 text-[10px] font-semibold text-accent-fg', at(actual) > 80 ? 'right-1' : 'left-1')}>Actual {fmt(actual, 0)}</span>
          </div>
        )}
      </div>
      <div className="flex justify-between text-[10px] text-fg-subtle">
        {ticks.map((t) => <span key={t} className="num">{t}</span>)}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-fg-muted">
        {hasBand && (
          <li className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-3.5 rounded-sm" style={{ background: 'rgb(var(--chart-2) / 0.45)', border: '1px solid rgb(var(--chart-2) / 0.7)' }} />
            Ours p10–p90 <span className="num text-fg">{fmt(u.p10, 0)}–{fmt(u.p90, 0)}</span>
          </li>
        )}
        {marks.map((m) => (
          <li key={m.key} className="flex items-center gap-1.5">
            <span className={cn('inline-block h-3', m.solid ? 'w-0.5 bg-fg' : 'w-0', !m.solid && m.className)} style={m.style} />
            {m.label} <span className="num text-fg">{fmt(m.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
