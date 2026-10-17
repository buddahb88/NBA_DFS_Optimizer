import { useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

// SVG presentation attributes can't read CSS variables, so resolve the design
// tokens to colors and re-read them when the theme class on <html> flips.
const TOKENS = ['chart-1', 'chart-2', 'line', 'fg', 'fg-muted', 'fg-subtle', 'surface'];

function readTokens() {
  const style = typeof window !== 'undefined' ? getComputedStyle(document.documentElement) : null;
  return Object.fromEntries(
    TOKENS.map((t) => {
      const v = style?.getPropertyValue(`--${t}`).trim();
      return [t, v ? `rgb(${v})` : 'currentColor'];
    }),
  );
}

function useChartTokens() {
  const [tokens, setTokens] = useState(readTokens);
  useEffect(() => {
    const observer = new MutationObserver(() => setTokens(readTokens()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return tokens;
}

const axisProps = (c) => ({
  stroke: c.line,
  tick: { fill: c['fg-subtle'], fontSize: 11 },
  tickLine: false,
});

function TooltipBox({ title, rows }) {
  return (
    <div className="rounded-md border border-line bg-surface-raised px-2.5 py-2 text-xs shadow-pop">
      <div className="mb-1 font-medium text-fg">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-fg-muted">
            {r.color && <span className="inline-block h-2 w-2 rounded-sm" style={{ background: r.color }} />}
            {r.label}
          </span>
          <span className="num text-fg">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

const LegendText = (value) => <span className="text-xs text-fg-muted">{value}</span>;

/** Grouped horizontal bars: optimal % (how often the player is in the sim-optimal lineup) vs projected ownership. */
export function LeverageChart({ rows }) {
  const c = useChartTokens();
  return (
    <div style={{ height: Math.max(160, rows.length * 30 + 56) }} role="img" aria-label="Optimal percentage versus ownership by player">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 4 }} barGap={2} barCategoryGap="22%">
          <CartesianGrid horizontal={false} stroke={c.line} strokeDasharray="2 4" />
          <XAxis type="number" {...axisProps(c)} tickFormatter={(v) => `${v}%`} />
          <YAxis type="category" dataKey="name" width={118} {...axisProps(c)} axisLine={false} tick={{ fill: c['fg-muted'], fontSize: 11 }} />
          <Tooltip
            cursor={{ fill: c.line, fillOpacity: 0.35 }}
            content={({ active, payload }) =>
              active && payload?.length ? (
                <TooltipBox
                  title={`${payload[0].payload.name} · ${payload[0].payload.team}`}
                  rows={[
                    { label: 'Optimal', value: `${payload[0].payload.optimal.toFixed(1)}%`, color: c['chart-1'] },
                    { label: 'Ownership', value: `${payload[0].payload.ownership.toFixed(1)}%`, color: c['chart-2'] },
                    { label: 'Leverage', value: `${payload[0].payload.leverage > 0 ? '+' : ''}${payload[0].payload.leverage.toFixed(1)}` },
                  ]}
                />
              ) : null
            }
          />
          <Legend verticalAlign="top" align="right" height={24} iconType="square" iconSize={9} formatter={LegendText} />
          <Bar dataKey="optimal" name="Optimal %" fill={c['chart-1']} radius={[0, 4, 4, 0]} maxBarSize={11} isAnimationActive={false} />
          <Bar dataKey="ownership" name="Ownership %" fill={c['chart-2']} radius={[0, 4, 4, 0]} maxBarSize={11} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Histogram of simulated lineup scores (share of sims per bin). `rows` from
 * histogramRows(); when rows carry `focus`, that lineup is overlaid as a line.
 */
export function ScoreHistogram({ rows, focusLabel, focusMedian }) {
  const c = useChartTokens();
  const hasFocus = rows.some((r) => r.focus !== undefined);
  const fmt = (v) => (Number.isInteger(v) ? v : v.toFixed(1));
  return (
    <div className="h-64" role="img" aria-label="Distribution of simulated scores for the selected lineups">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 4, right: 12, bottom: 4, left: 0 }} barCategoryGap={1}>
          <CartesianGrid vertical={false} stroke={c.line} strokeDasharray="2 4" />
          <XAxis dataKey="from" {...axisProps(c)} tickFormatter={fmt} minTickGap={18} />
          <YAxis {...axisProps(c)} axisLine={false} width={40} tickFormatter={(v) => `${v.toFixed(v < 1 ? 1 : 0)}%`} />
          <Tooltip
            cursor={{ fill: c.line, fillOpacity: 0.35 }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const r = payload[0].payload;
              return (
                <TooltipBox
                  title={`${fmt(r.from)}–${fmt(r.to)} pts`}
                  rows={[
                    { label: 'Selected lineups', value: `${r.all.toFixed(1)}%`, color: c['chart-1'] },
                    ...(r.focus !== undefined ? [{ label: focusLabel, value: `${r.focus.toFixed(1)}%`, color: c['chart-2'] }] : []),
                  ]}
                />
              );
            }}
          />
          {hasFocus && <Legend verticalAlign="top" align="right" height={24} iconSize={9} formatter={LegendText} />}
          <Bar dataKey="all" name="Selected lineups" fill={c['chart-1']} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          {hasFocus && (
            <Line
              dataKey="focus"
              name={focusLabel}
              type="monotone"
              stroke={c['chart-2']}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, stroke: c.surface, strokeWidth: 2 }}
              isAnimationActive={false}
            />
          )}
          {hasFocus && focusMedian != null && (
            <ReferenceLine
              x={rows.reduce((best, r) => (Math.abs(r.mid - focusMedian) < Math.abs(best.mid - focusMedian) ? r : best), rows[0]).from}
              stroke={c['chart-2']}
              strokeDasharray="3 3"
              label={{ value: `p50 ${focusMedian}`, position: 'insideTopLeft', fill: c['fg-muted'], fontSize: 11 }}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
