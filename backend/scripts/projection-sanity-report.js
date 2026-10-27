#!/usr/bin/env node
/**
 * Backtest report for the projection sanity layer
 * (services/projections/sanityLayer.js), without lookahead. Read-only.
 *
 * 1. Blowout fit: minutes vs a 28+ minute player's season average by final
 *    margin (2024-25 + 2025-26, team_game_stats scores), integrated over a
 *    normal margin around the spread (sd MARGIN_SD), so each spread gets the
 *    expected minutes lost vs a typical game (|spread| = pivot); fitted
 *    minutes per point beyond the pivot for favorites and underdogs.
 * 2. Saved main slates (slate_catalog.is_main): every player who played,
 *    bias (projection - actual) and MAE of RotoWire raw vs the sanity layer
 *    (default = the setting's default components; sanity = both) vs
 *    enhanced (projectionService, fixed) vs O3 rate projection, per date and
 *    overall; the FPPM outlier buckets (posted FPPM vs last season's
 *    dk_fppm, player_season_profiles games >= 20) and the blowout buckets.
 * 3. Config grid on the slates (threshold x fraction, under-shrink, blowout).
 * 4. Lineups: the optimizer's cash lineup (1 and top 5) on each main slate
 *    with raw vs adjusted projections, actual totals.
 * 5. Replay 2025-26 (no posted projections that season): minutes = actual,
 *    posted FPPM proxy = L3 FPPM (a recent-form projection), own = O3 blend;
 *    MAE of the shrink by threshold x fraction, to check the slate-tuned
 *    values are not overfit to a week.
 * 6. Examples: a player's before / after and the biggest adjustments on
 *    given dates, with actual results.
 *
 * Usage: node scripts/projection-sanity-report.js [--no-enhanced] [--no-replay]
 *   [--no-lineups] [--examples=2026-10-25,2026-10-26] [--player="Rui Hachimura@2026-10-25"]
 *   [--json=path]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: db } = await import('../src/config/database.js');
const { setProjectionSanity, projectionSanityConfig } = await import('../src/config/projectionSanity.js');
const { resolveSlate, loadSlatePlayers, withActuals, scoreLineups } = await import('../src/services/slateSource.js');
const { SANITY_CONFIG } = await import('../src/services/projections/sanityLayer.js');
const { slateHistory, adjustPlayer } = await import('../src/services/projections/sanityService.js');
const { rateProjection, blendFppm } = await import('../src/services/opportunity/rateProjection.js');
const { gameEnvironment } = await import('../src/services/opportunity/teamContext.js');
const { generateLineupBatch } = await import('../src/services/optimizer/constraints/exposure.js');
const { default: projectionService } = await import('../src/services/projectionService.js');
const { seasonForDate, previousSeason } = await import('../src/utils/season.js');
const { playerKey, canonicalTeam } = await import('../src/utils/playerKey.js');
const { easternDate } = await import('../src/services/slateSnapshotService.js');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? null;
const SITE = 'draftkings';
const MARGIN_SD = 12;
const exampleDates = (opt('examples') ?? '2026-10-25,2026-10-26').split(',').filter(Boolean);
const examplePlayer = opt('player') ?? 'Rui Hachimura@2026-10-25';

// Quiet the services' progress logging; the report prints with out()
const out = console.log.bind(console);
console.log = () => {};
console.warn = () => {};
setProjectionSanity(false);

const f1 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? '   -  ' : x.toFixed(1).padStart(6));
const f2 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? '    - ' : x.toFixed(2).padStart(6));
const pad = (s, n) => String(s).padEnd(n);
const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
const stats = (rows, pred) => {
  const r = rows.filter(x => Number.isFinite(pred(x)));
  return { n: r.length, bias: mean(r.map(x => pred(x) - x.actual)), mae: mean(r.map(x => Math.abs(pred(x) - x.actual))) };
};
const report = { generatedAt: new Date().toISOString(), config: SANITY_CONFIG };

// ── 1. Blowout fit ──────────────────────────────────────────
async function fitBlowout() {
  const rows = await db.all(`
    SELECT m.margin AS margin, h.minutes - a.am AS dmin, h.dk_fantasy_points - a.ap AS dpts, (h.dk_fantasy_points - a.ap) / a.ap AS rel, a.ap / a.am AS fppm
    FROM historical_games h
    JOIN (SELECT player_key, season, AVG(minutes) AS am, AVG(dk_fantasy_points) AS ap FROM historical_games
          WHERE COALESCE(season_type, 'regular') = 'regular' AND minutes > 0
          GROUP BY player_key, season HAVING COUNT(*) >= 20) a
      ON a.player_key = h.player_key AND a.season = h.season
    JOIN (SELECT x.game_date, x.team, x.pts - y.pts AS margin FROM team_game_stats x
          JOIN team_game_stats y ON y.game_id = x.game_id AND y.team <> x.team
          WHERE COALESCE(x.season_type, 'regular') = 'regular' AND x.season IN ('2024-25', '2025-26')) m
      ON m.game_date = h.game_date AND m.team = h.team
    WHERE a.am >= ? AND h.minutes > 0 AND COALESCE(h.season_type, 'regular') = 'regular'`, SANITY_CONFIG.blowout.minMinutes);

  // f(margin): mean minutes (or DK points) vs season average in 1-point bins, clipped to +-45
  const binsOf = (field) => {
    const bins = new Map();
    for (const r of rows) {
      const m = Math.max(-45, Math.min(45, Math.round(Number(r.margin))));
      const b = bins.get(m) ?? { s: 0, n: 0 };
      b.s += Number(r[field]); b.n += 1;
      bins.set(m, b);
    }
    return bins;
  };
  const minuteBins = binsOf('dmin');
  const pointBins = binsOf('dpts');
  const relBins = binsOf('rel');
  let bins = minuteBins;
  const f = (m) => {
    const b = bins.get(Math.max(-45, Math.min(45, Math.round(m))));
    return b && b.n >= 5 ? b.s / b.n : null;
  };
  const pdf = (x, mu) => Math.exp(-0.5 * ((x - mu) / MARGIN_SD) ** 2);
  // expected minutes change for a team expected to win by `mu`
  const expected = (mu) => {
    let s = 0; let w = 0;
    for (let m = -45; m <= 45; m++) {
      const v = f(m);
      if (v === null) continue;
      s += v * pdf(m, mu); w += pdf(m, mu);
    }
    return s / w;
  };
  const { pivot, threshold } = SANITY_CONFIG.blowout;
  const fit = (sign) => {
    let num = 0; let den = 0;
    const curve = [];
    for (let s = threshold; s <= 20; s++) {
      const trim = expected(sign * pivot) - expected(sign * s);
      curve.push({ spread: s, trim });
      num += trim * (s - pivot); den += (s - pivot) ** 2;
    }
    return { perPoint: num / den, curve };
  };
  const favorite = fit(1);
  const underdog = fit(-1);
  bins = pointBins;
  const avgFppm = mean(rows.map(r => Number(r.fppm)));
  const favoritePts = fit(1);
  const underdogPts = fit(-1);
  bins = relBins;
  const favoriteRel = fit(1);
  const underdogRel = fit(-1);
  bins = minuteBins;
  out(`\n1. BLOWOUT FIT  (${rows.length} games by 28+ min players, 2024-25 + 2025-26; margin ~ N(spread, ${MARGIN_SD}); trim vs |spread| ${pivot})`);
  out('   |spread|   favorite trim   underdog trim  (minutes)');
  for (let i = 0; i < favorite.curve.length; i += 2) {
    out(`   ${String(favorite.curve[i].spread).padStart(6)}   ${f2(favorite.curve[i].trim)}         ${f2(underdog.curve[i].trim)}`);
  }
  out(`   fitted minutes per point beyond ${pivot}: favorite ${favorite.perPoint.toFixed(3)}, underdog ${underdog.perPoint.toFixed(3)}  (config: ${SANITY_CONFIG.blowout.minutesPerPoint.favorite} / ${SANITY_CONFIG.blowout.minutesPerPoint.underdog})`);
  out(`   DK points lost per point beyond ${pivot}: favorite ${favoritePts.perPoint.toFixed(3)}, underdog ${underdogPts.perPoint.toFixed(3)}`
    + ` = minutes at their FPPM ${avgFppm.toFixed(2)}: favorite ${(favoritePts.perPoint / avgFppm).toFixed(3)}, underdog ${(underdogPts.perPoint / avgFppm).toFixed(3)}`);
  out(`   share of points lost per point beyond ${pivot}: favorite ${(100 * favoriteRel.perPoint).toFixed(2)}%, underdog ${(100 * underdogRel.perPoint).toFixed(2)}%`
    + `  (config: ${(100 * SANITY_CONFIG.blowout.pointsPctPerPoint.favorite).toFixed(2)}% / ${(100 * SANITY_CONFIG.blowout.pointsPctPerPoint.underdog).toFixed(2)}%)`);
  report.blowoutFit = { games: rows.length, marginSd: MARGIN_SD, favorite, underdog, favoritePts, underdogPts, favoriteRel, underdogRel, avgFppm };
}

// ── 2. Saved main slates ───────────────────────────────────
async function mainSlates() {
  const rows = await db.all(`
    SELECT DISTINCT s.game_date, s.slate_id FROM slate_player_snapshots s
    JOIN slate_catalog c ON c.site = s.site AND c.slate_id = s.slate_id AND c.is_main = 1
    WHERE s.site = ? AND s.game_date < ? ORDER BY s.game_date`, SITE, easternDate(new Date()));
  return rows.map(r => ({ date: String(r.game_date).slice(0, 10), slateId: String(r.slate_id) }));
}

const profileCache = new Map();
async function lastSeasonFppm(date, keys) {
  const season = previousSeason(seasonForDate(date));
  if (!profileCache.has(season)) {
    const rows = await db.all(`SELECT player_key, dk_fppm FROM player_season_profiles WHERE season = ? AND games >= 20`, season);
    profileCache.set(season, new Map(rows.map(r => [r.player_key, Number(r.dk_fppm)])));
  }
  const map = profileCache.get(season);
  return new Map(keys.map(k => [k, map.get(k) ?? null]));
}

/** One slate: raw players, history, actuals, rate and enhanced projections. */
async function loadSlate({ date, slateId }) {
  const source = await resolveSlate({ slateDate: date, slateId, site: SITE });
  const all = await loadSlatePlayers(source, { includeZero: true, sanity: false });
  const projected = all.filter(p => Number(p.projected_points) > 0);
  const history = await slateHistory(source, projected, { all });
  const withAct = await withActuals(source, projected);
  const lastFppm = await lastSeasonFppm(date, projected.map(p => p.player_key));

  let enhanced = new Map();
  if (!flag('no-enhanced')) {
    projectionService.clearCache();
    const results = await projectionService.calculateSlateEnhancedProjections(projected, date, SITE, {});
    enhanced = new Map(results.map(r => [r.id, Number(r.enhanced_projection)]));
  }

  const players = withAct.map(p => {
    const entry = history.players.get(p.player_key);
    const env = gameEnvironment(p, history.teams.get(canonicalTeam(p.team)) ?? null, history.teams.get(canonicalTeam(p.opponent)) ?? null);
    const rate = entry ? rateProjection({
      fppm: entry.fppm, projectedMinutes: p.projected_minutes, projectedPoints: p.projected_points,
      impliedTotal: env.implied_total, paceProxy: env.pace_proxy, leaguePace: history.leaguePace, adjusted: entry.adjusted
    }).rate_projection : null;
    return {
      ...p,
      date,
      raw: Number(p.projected_points),
      actual: p.resultStatus === 'PLAYED' ? Number(p.actualPoints) : null,
      rate: rate === null ? null : Number(rate),
      enhanced: enhanced.has(p.id) ? enhanced.get(p.id) : null,
      lastFppm: lastFppm.get(p.player_key)
    };
  });
  return { date, source, history, players };
}

const DEFAULT_CONFIG = projectionSanityConfig();
const withConfig = (slate, config) => slate.players.map(p => {
  const a = adjustPlayer(p, slate.history, config);
  return { ...p, sanity: Number(a.projected_points), adjusted: a, default: Number(adjustPlayer(p, slate.history, DEFAULT_CONFIG).projected_points) };
});

const line = (label, rows, preds) => {
  const cells = preds.map(([, pred]) => {
    const s = stats(rows, pred);
    return `${f2(s.bias)} ${f2(s.mae)}`;
  });
  return `   ${pad(label, 22)} n=${String(rows.length).padStart(4)}  ${cells.join('   ')}`;
};

// sanity = both components (SANITY_CONFIG); default = the components the setting enables by default
const PREDS = [
  ['raw', r => r.raw], ['default', r => r.default], ['sanity', r => r.sanity], ['enhanced', r => r.enhanced ?? NaN], ['rate', r => r.rate ?? NaN]
];
const HEADER = `   ${pad('', 22)}         ${PREDS.map(([n]) => `${pad(n, 6)} bias   MAE`.padEnd(16)).join('   ')}`;

async function slateSection(slates) {
  out('\n2. MAIN SLATES  (players who played; bias = projection - actual)');
  out(HEADER.replace(/(\w+) bias   MAE/g, '$1 bias/MAE'));
  const everything = [];
  report.slates = [];
  for (const s of slates) {
    const rows = withConfig(s, SANITY_CONFIG).filter(r => r.actual !== null);
    everything.push(...rows);
    out(line(`${s.date} (${s.source.slateId})`, rows, PREDS));
    report.slates.push({ date: s.date, slateId: s.source.slateId, ...Object.fromEntries(PREDS.map(([n, p]) => [n, stats(rows, p)])) });
  }
  out(line('ALL', everything, PREDS));
  report.overall = Object.fromEntries(PREDS.map(([n, p]) => [n, stats(everything, p)]));
  report.pairedMaeDiff = {};
  for (const key of ['default', 'sanity']) {
    const diffs = everything.map(r => Math.abs(r[key] - r.actual) - Math.abs(r.raw - r.actual));
    const d = mean(diffs);
    const se = Math.sqrt(mean(diffs.map(x => (x - d) ** 2)) / diffs.length);
    out(`   ${key} - raw MAE, paired: ${d.toFixed(3)} (se ${se.toFixed(3)}); better on ${diffs.filter(x => x < 0).length}, worse on ${diffs.filter(x => x > 0).length}`);
    report.pairedMaeDiff[key] = { mean: d, se, better: diffs.filter(x => x < 0).length, worse: diffs.filter(x => x > 0).length };
  }
  const enhancedRows = everything.filter(r => r.enhanced !== null);
  if (enhancedRows.length < everything.length) out(`   (enhanced covers ${enhancedRows.length})`);

  const ratio = (r) => (r.lastFppm > 0 && r.projected_minutes > 0 ? r.raw / r.projected_minutes / r.lastFppm - 1 : null);
  const buckets = [
    ['>= +30%', x => x >= 0.3], ['+10..30%', x => x >= 0.1 && x < 0.3], ['within 10%', x => Math.abs(x) < 0.1],
    ['-10..30%', x => x <= -0.1 && x > -0.3], ['<= -30%', x => x <= -0.3]
  ];
  out('\n   FPPM OUTLIER BUCKETS  (posted FPPM vs last season dk_fppm, profiles games >= 20)');
  out(HEADER);
  report.outlierBuckets = [];
  for (const [label, test] of buckets) {
    const rows = everything.filter(r => ratio(r) !== null && test(ratio(r)));
    out(line(label, rows, PREDS));
    report.outlierBuckets.push({ bucket: label, ...Object.fromEntries(PREDS.map(([n, p]) => [n, stats(rows, p)])) });
  }
  const own = (r) => r.adjusted.projection_own_fppm;
  const ownRatio = (r) => (own(r) > 0 && r.projected_minutes_raw > 0 ? r.raw / r.projected_minutes_raw / own(r) - 1 : null);
  out('\n   SAME BUCKETS vs OWN O3 RATE (what the layer uses)');
  out(HEADER);
  report.ownBuckets = [];
  for (const [label, test] of buckets) {
    const rows = everything.filter(r => r.adjusted && ownRatio({ ...r, projected_minutes_raw: r.projected_minutes }) !== null
      && test(ownRatio({ ...r, projected_minutes_raw: r.projected_minutes })));
    out(line(label, rows, PREDS));
    report.ownBuckets.push({ bucket: label, ...Object.fromEntries(PREDS.map(([n, p]) => [n, stats(rows, p)])) });
  }

  out('\n   BLOWOUT BUCKETS  (projected 28+ min)');
  out(HEADER);
  const big = everything.filter(r => r.projected_minutes >= 28);
  const side = [
    ['favorite |s| >= 10', r => r.vegas_spread <= -10], ['underdog |s| >= 10', r => r.vegas_spread >= 10],
    ['|s| < 10', r => Math.abs(r.vegas_spread) < 10]
  ];
  report.blowoutBuckets = [];
  for (const [label, test] of side) {
    const rows = big.filter(test);
    out(line(label, rows, PREDS));
    report.blowoutBuckets.push({ bucket: label, ...Object.fromEntries(PREDS.map(([n, p]) => [n, stats(rows, p)])) });
  }
  return everything;
}

// ── 3. Config grid ──────────────────────────────────────────
function grid(slates) {
  out('\n3. CONFIG GRID on the main slates  (MAE / bias of the adjusted projection; raw for reference)');
  const evalCfg = (cfg) => {
    const rows = slates.flatMap(s => withConfig(s, cfg)).filter(r => r.actual !== null);
    return { ...stats(rows, r => r.sanity), changed: rows.filter(r => r.adjusted.projection_adjustment !== 0).length };
  };
  const off = { fppm: { ...SANITY_CONFIG.fppm, enabled: false }, blowout: { ...SANITY_CONFIG.blowout, enabled: false } };
  const base = evalCfg(off);
  out(`   raw                                   MAE ${f2(base.mae)}  bias ${f2(base.bias)}`);
  report.grid = [];
  const show = (label, cfg) => {
    const r = evalCfg(cfg);
    out(`   ${pad(label, 38)}MAE ${f2(r.mae)}  bias ${f2(r.bias)}  changed ${r.changed}`);
    report.grid.push({ label, ...r });
  };
  for (const overThreshold of [0.2, 0.3, 0.4]) {
    for (const overFraction of [0.25, 0.5, 0.75, 1]) {
      show(`fppm over ${overThreshold} x ${overFraction}`, { fppm: { ...SANITY_CONFIG.fppm, overThreshold, overFraction }, blowout: off.blowout });
    }
  }
  for (const underFraction of [0.25, 0.5]) {
    show(`fppm under 0.3 x ${underFraction}`, { fppm: { ...SANITY_CONFIG.fppm, overFraction: 0, underFraction }, blowout: off.blowout });
  }
  const b = SANITY_CONFIG.blowout;
  show('blowout only (config)', { fppm: off.fppm, blowout: b });
  show('blowout underdogs only', { fppm: off.fppm, blowout: { ...b, minutesPerPoint: { ...b.minutesPerPoint, favorite: 0 }, pointsPctPerPoint: { ...b.pointsPctPerPoint, favorite: 0 } } });
  show('blowout favorites at 0.4%/pt', { fppm: off.fppm, blowout: { ...b, pointsPctPerPoint: { ...b.pointsPctPerPoint, favorite: 0.004 } } });
  show('blowout underdogs at 0.5%/pt', { fppm: off.fppm, blowout: { ...b, pointsPctPerPoint: { ...b.pointsPctPerPoint, underdog: 0.005 } } });
  show('blowout underdogs at 1.2%/pt', { fppm: off.fppm, blowout: { ...b, pointsPctPerPoint: { ...b.pointsPctPerPoint, underdog: 0.012 } } });
  show('config (both)', SANITY_CONFIG);
}

// ── 4. Lineups ──────────────────────────────────────────────
const COMPONENTS = [
  ['both', SANITY_CONFIG],
  ['fppm only', { fppm: SANITY_CONFIG.fppm, blowout: { ...SANITY_CONFIG.blowout, enabled: false } }],
  ['blowout only', { fppm: { ...SANITY_CONFIG.fppm, enabled: false }, blowout: SANITY_CONFIG.blowout }]
];

async function lineups(slates) {
  out('\n4. OPTIMIZER CASH LINEUPS  (actual points; 1 = the cash lineup, top-5 = mean of 5 cash lineups with minUniqueness 2)');
  out(`   ${pad('date', 12)} ${pad('raw 1 / top-5', 16)} ${COMPONENTS.map(([n]) => pad(`${n} 1 / top-5`, 22)).join(' ')}`);
  report.lineups = [];
  const totals = { raw: [0, 0], ...Object.fromEntries(COMPONENTS.map(([n]) => [n, [0, 0]])) };
  const build = async (source, players, numLineups) => {
    const result = generateLineupBatch(players, { mode: 'cash', numLineups, minUniqueness: numLineups > 1 ? 2 : 0, site: SITE });
    const scored = await scoreLineups(source, result.lineups || [], players);
    const first = scored[0]?.players ?? [];
    return {
      actual: mean(scored.map(l => l.actualPoints).filter(v => v !== null)),
      players: new Map(first.map(slot => [slot.player?.name, slot.player?.actualPoints]).filter(([n]) => n))
    };
  };
  for (const s of slates) {
    const rawPlayers = s.players.map(({ raw, actual, rate, enhanced, lastFppm, date, ...p }) => p);
    const r1 = await build(s.source, rawPlayers, 1);
    const r5 = await build(s.source, rawPlayers, 5);
    totals.raw[0] += r1.actual ?? 0; totals.raw[1] += r5.actual ?? 0;
    const entry = { date: s.date, raw: { one: r1.actual, five: r5.actual } };
    const cells = [];
    const swaps = [];
    for (const [name, cfg] of COMPONENTS) {
      const adjusted = withConfig(s, cfg).map(p => ({ ...p.adjusted }));
      const a1 = await build(s.source, adjusted, 1);
      const a5 = await build(s.source, adjusted, 5);
      totals[name][0] += a1.actual ?? 0; totals[name][1] += a5.actual ?? 0;
      cells.push(pad(`${f1(a1.actual)} / ${f1(a5.actual)}`, 22));
      const outs = [...r1.players.keys()].filter(n => !a1.players.has(n)).map(n => `${n} ${r1.players.get(n)}`);
      const ins = [...a1.players.keys()].filter(n => !r1.players.has(n)).map(n => `${n} ${a1.players.get(n)}`);
      if (outs.length) swaps.push(`${name}: out ${outs.join(', ')}; in ${ins.join(', ')}`);
      entry[name] = { one: a1.actual, five: a5.actual, swapOut: outs, swapIn: ins };
    }
    out(`   ${pad(s.date, 12)} ${pad(`${f1(r1.actual)} / ${f1(r5.actual)}`, 16)} ${cells.join(' ')}`);
    for (const line of swaps) out(`                1-lineup swap (${line})`);
    report.lineups.push(entry);
  }
  out(`   ${pad('TOTAL', 12)} ${pad(`${totals.raw[0].toFixed(1)} / ${totals.raw[1].toFixed(1)}`, 16)} ${COMPONENTS.map(([n]) => pad(`${totals[n][0].toFixed(1)} / ${totals[n][1].toFixed(1)}`, 22)).join(' ')}`);
  report.lineupTotals = totals;
}

// ── 5. Replay 2025-26 ───────────────────────────────────────
async function replay() {
  const games = await db.all(`
    SELECT player_key, season, game_date, minutes, dk_fantasy_points AS fp FROM historical_games
    WHERE COALESCE(season_type, 'regular') = 'regular' AND minutes > 0 AND dk_fantasy_points IS NOT NULL
      AND season IN ('2024-25', '2025-26')
    ORDER BY player_key, game_date DESC`);
  const byKey = new Map();
  for (const g of games) {
    const row = { ...g, game_date: String(g.game_date).slice(0, 10), minutes: Number(g.minutes), fp: Number(g.fp) };
    if (!byKey.has(row.player_key)) byKey.set(row.player_key, []);
    byKey.get(row.player_key).push(row);
  }
  const cases = [];
  for (const list of byKey.values()) {
    list.forEach((g, i) => {
      if (g.season !== '2025-26' || g.minutes < SANITY_CONFIG.fppm.minMinutes) return;
      const prior = list.slice(i + 1);
      if (prior.length < 10) return;
      const own = blendFppm(prior, { season: '2025-26' });
      if (own.fppm === null || own.l10_minutes < SANITY_CONFIG.fppm.minSampleMinutes) return;
      const l3 = prior.slice(0, 3);
      const posted = l3.reduce((s, x) => s + x.fp, 0) / l3.reduce((s, x) => s + x.minutes, 0);
      cases.push({ minutes: g.minutes, actual: g.fp, posted, own: own.fppm });
    });
  }
  out(`\n5. REPLAY 2025-26  (n=${cases.length}; minutes = actual, posted FPPM proxy = L3 FPPM, own = O3 blend)`);
  const shrunk = (c, thr, frac, under = false) => {
    const ratio = c.posted / c.own;
    const ramp = SANITY_CONFIG.fppm.ramp;
    if (!under && ratio > 1 + thr) return c.posted - frac * Math.min(1, (ratio - 1 - thr) / ramp) * (c.posted - c.own);
    if (under && ratio < 1 - thr) return c.posted + frac * Math.min(1, (1 - thr - ratio) / ramp) * (c.own - c.posted);
    return c.posted;
  };
  report.replay = [];
  for (const [side, under] of [['over', false], ['under', true]]) {
    for (const thr of [0.2, 0.3, 0.4]) {
      const hit = cases.filter(c => (under ? c.posted / c.own < 1 - thr : c.posted / c.own > 1 + thr));
      const cells = [0, 0.25, 0.5, 0.75, 1].map(frac => {
        const m = mean(hit.map(c => Math.abs(shrunk(c, thr, frac, under) * c.minutes - c.actual)));
        report.replay.push({ side, threshold: thr, fraction: frac, n: hit.length, mae: m });
        return `${frac}: ${f2(m)}`;
      });
      const actualRatio = mean(hit.map(c => (c.actual / c.minutes - c.own) / (c.posted - c.own)));
      out(`   ${side} ${thr}  n=${String(hit.length).padStart(5)}  MAE by fraction ${cells.join('  ')}   share of the gap that held: ${f2(actualRatio)}`);
    }
  }
}

// ── 6. Examples ─────────────────────────────────────────────
function examples(slates) {
  const [name, date] = examplePlayer.split('@');
  const slate = slates.find(s => s.date === date);
  report.examples = {};
  if (slate) {
    const p = withConfig(slate, SANITY_CONFIG).find(r => r.player_key === playerKey(name));
    if (p) {
      out(`\n6. ${p.name} ${date} (${p.team} vs ${p.opponent}, spread ${p.vegas_spread}, implied ${p.vegas_implied_total})`);
      out(`   RotoWire ${p.raw} on ${p.projected_minutes} min (${(p.raw / p.projected_minutes).toFixed(2)}/min)  ->  adjusted ${p.adjusted.projected_points} on ${p.adjusted.projected_minutes} min`);
      out(`   own rate ${p.adjusted.projection_own_fppm}  reasons: ${p.adjusted.projection_reasons.join('; ') || 'none'}`);
      out(`   O3 rate ${p.rate}  enhanced ${p.enhanced}  actual ${p.actual} in ${p.actualMinutes} min`);
      report.examples.player = { name: p.name, date, raw: p.raw, adjusted: p.adjusted.projected_points, reasons: p.adjusted.projection_reasons, rate: p.rate, enhanced: p.enhanced, actual: p.actual, actualMinutes: p.actualMinutes };
    }
  }
  for (const d of exampleDates) {
    const s = slates.find(x => x.date === d);
    if (!s) continue;
    const rows = withConfig(s, SANITY_CONFIG)
      .filter(r => r.adjusted.projection_adjustment !== 0)
      .sort((a, b) => Math.abs(b.adjusted.projection_adjustment) - Math.abs(a.adjusted.projection_adjustment))
      .slice(0, 10);
    out(`\n   BIGGEST ADJUSTMENTS ${d}`);
    out(`   ${pad('player', 24)} ${pad('team', 9)} spread   raw   adj  actual  min   reasons`);
    report.examples[d] = rows.map(r => {
      out(`   ${pad(r.name, 24)} ${pad(`${r.team}-${r.opponent}`, 9)} ${f1(Number(r.vegas_spread))} ${f1(r.raw)} ${f1(r.sanity)} ${f1(r.actual)} ${f1(r.actualMinutes)}   ${r.adjusted.projection_reasons.join('; ')}`);
      return { name: r.name, team: r.team, spread: r.vegas_spread, raw: r.raw, adjusted: r.sanity, actual: r.actual, actualMinutes: r.actualMinutes, reasons: r.adjusted.projection_reasons };
    });
  }
}

// ── Run ─────────────────────────────────────────────────────
await fitBlowout();
const list = await mainSlates();
const slates = [];
for (const s of list) slates.push(await loadSlate(s));
await slateSection(slates);
grid(slates);
if (!flag('no-lineups')) await lineups(slates);
if (!flag('no-replay')) await replay();
examples(slates);

const jsonPath = opt('json');
if (jsonPath) {
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  out(`\nJSON: ${jsonPath}`);
}
db.close();
