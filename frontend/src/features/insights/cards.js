/**
 * Card definitions for the Insights page. Each card names the useInsights
 * section it reads (`source`), how to pick its rows from that section's data,
 * a stable row key, an optional `kpi` label for the count strip, and
 * `row(r)` -> display fields for InsightRow:
 *   { name, meta, sub, metric, metricLabel, tone, badge }
 */
import { fmt, money, signed } from './insights';

const matchup = (r) => [r.team, r.opponent && `vs ${r.opponent}`, r.salary != null && money(r.salary)].filter(Boolean).join(' · ');
const slateKey = (r) => `${r.name}|${r.team}`;
const leagueKey = (r) => r.player_key ?? `${r.player_name}|${r.team}`;
const fromInsights = (field) => (data) => data?.[field] ?? [];
const CONFIDENCE_TONE = { High: 'positive', Medium: 'caution', Low: 'neutral' };

export const SLATE_CARDS = [
  {
    id: 'usageBumps',
    title: 'Usage bumps',
    subtitle: 'Slate players who score more when a regular sits',
    source: 'usageBumps',
    kpi: 'Usage bumps',
    rows: (data) => data ?? [],
    getKey: (r) => `${r.player}|${r.team}|${r.missingPlayer}`,
    row: (r) => ({
      name: r.player,
      meta: [r.position, matchup(r), r.projectedMinutes != null && `${fmt(r.projectedMinutes, 0)} min`].filter(Boolean).join(' · '),
      sub: `${fmt(r.avgWith)} → ${fmt(r.avgWithout)} pts, ${fmt(r.avgMinWith)} → ${fmt(r.avgMinWithout)} min without ${r.missingPlayer} (${r.gamesWithout} of ${r.gamesWithout + r.gamesWith} games)`,
      metric: signed(r.pctBump, '%'),
      metricLabel: `${signed(r.dkBump)} pts`,
      tone: 'positive',
      badge: r.confidence ? { label: r.confidence, tone: CONFIDENCE_TONE[r.confidence] ?? 'neutral' } : null,
    }),
    empty: 'No teammate bumps from tonight’s missing regulars.',
  },
  {
    id: 'missing',
    title: 'Missing regulars',
    subtitle: 'Rotation players not in tonight’s player pool',
    source: 'missing',
    rows: (data) => (data ?? []).flatMap((t) => (t.missingPlayers ?? []).map((p) => ({ ...p, team: t.team }))),
    getKey: (r) => `${r.team}|${r.name}`,
    row: (r) => ({
      name: r.name,
      meta: [r.team, r.games != null && `${r.games} games`, r.lastGame && `last ${r.lastGame}`].filter(Boolean).join(' · '),
      metric: fmt(r.avgDk),
      metricLabel: `pts · ${fmt(r.avgMin, 0)} min`,
    }),
    empty: 'Every regular is in tonight’s pool.',
  },
  {
    id: 'hotStreaks',
    title: 'Hot streaks',
    subtitle: 'Last 3 games vs season average',
    source: 'slate',
    kpi: 'Hot',
    rows: fromInsights('hotStreaks'),
    getKey: slateKey,
    row: (r) => ({ name: r.name, meta: matchup(r), sub: r.reason, metric: signed(r.hotStreakPct, '%'), metricLabel: `${fmt(r.last3Avg)} L3`, tone: 'positive' }),
    empty: 'Nobody on the slate is running hot.',
  },
  {
    id: 'coldStreaks',
    title: 'Cold streaks',
    subtitle: 'Last 3 games below season average',
    source: 'slate',
    kpi: 'Cold',
    rows: fromInsights('coldStreaks'),
    getKey: slateKey,
    row: (r) => ({ name: r.name, meta: matchup(r), sub: r.reason, metric: signed(r.hotStreakPct, '%'), metricLabel: `${fmt(r.last3Avg)} L3`, tone: 'negative' }),
    empty: 'Nobody on the slate is running cold.',
  },
  {
    id: 'matchupAdvantages',
    title: 'Matchup edges',
    subtitle: 'Scores 10%+ above average against tonight’s opponent',
    source: 'slate',
    kpi: 'Matchup edges',
    rows: fromInsights('matchupAdvantages'),
    getKey: slateKey,
    row: (r) => ({ name: r.name, meta: matchup(r), sub: r.reason, metric: fmt(r.matchupAvg), metricLabel: `vs opp · ${fmt(r.seasonAvg)} avg` }),
    empty: 'No matchup edges with enough history.',
  },
  {
    id: 'recentPerformers',
    title: 'Recent performers',
    subtitle: '30+ fantasy points over the last 3 games',
    source: 'slate',
    rows: fromInsights('recentPerformers'),
    getKey: slateKey,
    row: (r) => ({ name: r.name, meta: matchup(r), sub: r.last3Scores && `Last 3: ${r.last3Scores}`, metric: fmt(r.last3Avg), metricLabel: 'L3 avg' }),
    empty: 'No 30+ point runs on this slate.',
  },
  {
    id: 'consistentPlays',
    title: 'Consistent plays',
    subtitle: 'Low variance, for cash games',
    source: 'slate',
    rows: fromInsights('consistentPlays'),
    getKey: slateKey,
    row: (r) => ({ name: r.name, meta: matchup(r), sub: `${fmt(r.floor)}–${fmt(r.ceiling)} range`, metric: fmt(r.seasonAvg), metricLabel: `${fmt(r.stdDev)} SD` }),
    empty: 'No low-variance players with enough games.',
  },
  {
    id: 'boomCandidates',
    title: 'Boom candidates',
    subtitle: 'High ceiling and variance, for GPPs',
    source: 'slate',
    kpi: 'Boom',
    rows: fromInsights('boomCandidates'),
    getKey: slateKey,
    row: (r) => ({ name: r.name, meta: matchup(r), sub: `${fmt(r.seasonAvg)} avg · ${fmt(r.stdDev)} SD`, metric: fmt(r.ceiling), metricLabel: 'ceiling' }),
    empty: 'No high-variance players on this slate.',
  },
];

const leagueMeta = (r, games) => [r.team, games != null && `${games} games`].filter(Boolean).join(' · ');

export const LEAGUE_CARDS = [
  {
    id: 'hotStreaks',
    title: 'Hot streaks',
    subtitle: 'League-wide, last 3 games vs season average',
    getKey: leagueKey,
    row: (r) => ({
      name: r.player_name,
      meta: leagueMeta(r, r.total_games),
      metric: signed(r.hot_streak_pct, '%'),
      metricLabel: `${fmt(r.last3_avg)} L3 · ${fmt(r.season_avg)} avg`,
      tone: 'positive',
    }),
    empty: 'No hot streaks in this window.',
  },
  {
    id: 'coldStreaks',
    title: 'Cold streaks',
    subtitle: 'League-wide, last 3 games below season average',
    getKey: leagueKey,
    row: (r) => ({
      name: r.player_name,
      meta: leagueMeta(r, r.total_games),
      metric: signed(r.cold_streak_pct, '%'),
      metricLabel: `${fmt(r.last3_avg)} L3 · ${fmt(r.season_avg)} avg`,
      tone: 'negative',
    }),
    empty: 'No cold streaks in this window.',
  },
  {
    id: 'consistencyLeaders',
    title: 'Most consistent',
    subtitle: 'Lowest variation relative to average (cash)',
    getKey: leagueKey,
    row: (r) => ({
      name: r.player_name,
      meta: leagueMeta(r, r.games),
      sub: `${fmt(r.avg_dk)} avg · ${fmt(r.floor)}–${fmt(r.ceiling)} range`,
      metric: fmt(r.consistency_score, 0),
      metricLabel: 'consistency',
    }),
    empty: 'Not enough games in this window.',
  },
  {
    id: 'boomBustPlayers',
    title: 'Highest variance',
    subtitle: 'Biggest standard deviation (GPP)',
    getKey: leagueKey,
    row: (r) => ({
      name: r.player_name,
      meta: leagueMeta(r, r.games),
      sub: `${fmt(r.avg_dk)} avg · ${fmt(r.boom_rate, 0)}% boom · ${fmt(r.bust_rate, 0)}% bust`,
      metric: fmt(r.std_dev),
      metricLabel: 'SD',
    }),
    empty: 'Not enough games in this window.',
  },
];
