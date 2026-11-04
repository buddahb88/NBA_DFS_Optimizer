// Test fixtures shaped like GET /api/players/:slateId/card/:playerId.

const log = Array.from({ length: 10 }, (_, i) => ({
  date: `2026-10-${String(10 + i * 2).padStart(2, '0')}`,
  opponent: i % 2 ? 'BOS' : 'NYK',
  is_home: i % 2 === 0,
  is_starter: i !== 3,
  back_to_back: i === 5,
  season_type: 'regular',
  minutes: 30 + i,
  fp: 30 + i * 2,
  pts: 18, reb: 6, ast: 5, stl: 1, blk: 0, tov: 2, fg3m: 2,
  fppm: 1.1,
  salary: i > 4 ? 7000 : null,
  value: i > 4 ? (30 + i * 2) / 7 : null,
  target: i > 4 ? 35 : null,
  hit: i > 4 ? 30 + i * 2 >= 35 : null,
}))

export const fadeCard = () => ({
  slate: { slateId: 'past', slateDate: '2026-10-28', site: 'draftkings', isBacktest: true, label: 'Backtest 2026-10-28', asOf: '2026-10-28', settingsKey: 'backtest:2026-10-28:past' },
  player: {
    id: 11, player_id: 'p11', player_key: 'test guard', name: 'Test Guard', team: 'IND', opponent: 'WAS', position: 'PG,SG,G,UTIL',
    salary: 7000, headshot: null, injury_status: null, archetype: 'primary_creator', archetype_label: 'Primary Creator',
    secondary_archetype: 'scoring_guard', secondary_label: 'Scoring Guard', game_time: '2026-10-28T23:30:00.000Z', is_home: true,
  },
  projection: {
    source: 'blend', requested: 'blend', fallback: false, active: 36.2, rotowire: 39.5, ours: 33, blend: 36.2, ours_median: 32.5,
    p10: 20, p90: 47, blend_p10: 22, blend_p90: 50, p_boom: 0.08, blend_p_boom: 0.1, boom_at: 42, p_dd: 0.15,
    ours_minutes: 31.5, rotowire_minutes: 33, p_play: 0.97,
    fade: { points_diff: -6.5, hit_rate: 0.688, n: 77, text: 'Fade: ours 33.0 vs RotoWire 39.5 (-6.5).' },
    ours_diff: -6.5, floor: 22, ceiling: 50, boom_probability: 10, rostership: 12.4, leverage: 2.1, value: 5.17,
  },
  form: {
    log,
    l5: { games: 5, fp: 44, minutes: 37, fppm: 1.19, pts: 18, reb: 6, ast: 5, fg3m: 2, stocks: 1 },
    l10: { games: 10, fp: 39, minutes: 34.5, fppm: 1.13, pts: 18, reb: 6, ast: 5, fg3m: 2, stocks: 1 },
    season: { games: 10, fp: 39, minutes: 34.5, fppm: 1.13 },
    lastSeason: null,
    consistency: { std_dev: 6.1, hit_rate: 0.6, hit_games: 3, priced_games: 5, floor_game: 30, ceiling_game: 48 },
    trend: { minutes_delta_l5: 2.5, fppm_delta_l5: 0.06, fp_delta_l5: 5, baseline: 'season' },
  },
  role: {
    season: '2026-27', lastSeason: '2025-26',
    current: { usg_pct: 0.27, ast_pct: 0.31, reb_pct: 0.08, three_pa_rate: 0.4, ts_pct: 0.58, dk_fppm: 1.13, minutes_pg: 34.5 },
    previous: { usg_pct: 0.24, ast_pct: 0.28, reb_pct: 0.08, three_pa_rate: 0.38, ts_pct: 0.56, dk_fppm: 1.05, minutes_pg: 31 },
    archetype_average: { usg_pct: 0.3, ast_pct: 0.35, reb_pct: 0.09, three_pa_rate: 0.36, ts_pct: 0.6, dk_fppm: 1.39, minutes_pg: 32.6 },
    started_last_game: true, starts_l5: 5, starter_change: null,
  },
  matchup: {
    opponent: 'WAS', grouping: 'archetype', group_key: 'primary_creator', label: 'Primary Creator', season: '2026-27',
    fp_delta: 4.1, rank: 2, teams: 30, grade: 'A', games: 12, adjusted_edge: 3.2, edge_flags: [],
    stats: { pts: 1.8, reb: -0.4, ast: 0.9, fg3m: 0.3, stocks: -0.1 },
  },
  environment: {
    implied_total: 119.5, opp_implied_total: 110, spread: -9.5, over_under: 229.5, blowout: false, blowout_risk: 0,
    team: { def_eff: 112, off_eff: 117, pace: 101.2, def_rank: 12, pace_rank: 4, teams: 30 },
    opponent: { def_eff: 119.3, off_eff: 108, pace: 100.1, def_rank: 1, pace_rank: 9, teams: 30 },
  },
  context: {
    teammates_out: [{ name: 'Tyrese Haliburton', status: 'OUT', salary: 9000 }],
    split: { out_names: ['Tyrese Haliburton'], sample: 'confirmed', games_without: 9, min_delta: 5.2, usg_delta: 0.04, absorbed_pct: 0.3 },
    radar: { cash_score: 71, gpp_score: 64, reason: 'minutes up 5.2', rate_projection: 38, salary_lag: true, back_to_back: false, rest_days: 1 },
  },
  trackRecord: {
    n: 4, dnp: 0, bias: 2.4, mae: 5.1, beat_rate: 0.75,
    recent: [
      { date: '2026-10-20', projection: 34, actual: 38, salary: 6800 },
      { date: '2026-10-22', projection: 35, actual: 31, salary: 6900 },
      { date: '2026-10-24', projection: 35, actual: 40, salary: 7000 },
    ],
  },
  actual: { points: 41.5, minutes: 36, status: 'PLAYED', value: 5.93, vs_projection: 5.3, vs_rotowire: 2, vs_ours: 8.5, hit5x: true },
  verdict: {
    cash: { verdict: 'Playable', score: 58, confidence: 52 },
    gpp: { verdict: 'Core play', score: 67, confidence: 64 },
    rules: [],
    reasonsFor: ['+5.2 minutes when Tyrese Haliburton is out (9 games without)'],
    reasonsAgainst: ['Our model is 6.5 below RotoWire; that flag has hit 69% of 77'],
    notes: [],
    blurb: 'With Tyrese Haliburton out he has played +5.2 minutes (9 games without). Our model is 6.5 below RotoWire - trust the fade.',
  },
  meta: { generatedAt: '2026-10-28T12:00:00Z', cached: false, warnings: [] },
});

export const rookieCard = () => {
  const c = fadeCard();
  return {
    ...c,
    slate: { ...c.slate, isBacktest: false, slateDate: null, label: 'Live', settingsKey: 's1' },
    player: { ...c.player, name: 'New Rookie', archetype: null, archetype_label: null, secondary_label: null },
    projection: { ...c.projection, fade: null, ours: null, blend: null, p10: null, p90: null, blend_p10: null, blend_p90: null, ours_diff: null, source: 'rotowire', active: 20, rotowire: 20 },
    form: { log: [], l5: null, l10: null, season: null, lastSeason: null, consistency: { std_dev: null, hit_rate: null, hit_games: 0, priced_games: 0 }, trend: { minutes_delta_l5: null, baseline: null } },
    role: { ...c.role, current: null, previous: null, archetype_average: null, started_last_game: null, starts_l5: null },
    matchup: null,
    context: { teammates_out: [], split: null, radar: null },
    trackRecord: { n: 0, dnp: 0, bias: null, mae: null, beat_rate: null, recent: [] },
    actual: null,
    verdict: { ...c.verdict, cash: { verdict: 'Pivot', score: 47, confidence: 42 }, gpp: { verdict: 'Pivot', score: 49, confidence: 40 }, reasonsFor: [], reasonsAgainst: [] },
    meta: { ...c.meta, warnings: ['own model: no rows'] },
  };
};
