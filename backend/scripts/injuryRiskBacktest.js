#!/usr/bin/env node
/**
 * Injury-tag discount backtest (read-only on the database).
 *
 * Every saved DK main slate (slate_catalog.is_main, before today), read the
 * way the app reads it (slateSource.loadSlatePlayers: sanity layer, the
 * projection source - blend by default - then the injury layer) with the
 * discount OFF vs ON. The ON read uses the table calibrated as of the slate's
 * date (nights before it only), so no slate sees its own outcomes.
 *
 *   MAE / bias incl. DNP (DNP = 0) over every projected pool player, and over
 *   tagged players only
 *   cash   1 lineup: OFF = discount off + skipQuestionable off (the app before);
 *          ON = discount on + skipQuestionable (cash default on);
 *          also discount-only (skip off) and skip-only (discount off)
 *   GPP    N lineups (minUniqueness 2, seeded randomness): skipQuestionable
 *          off (GPP default), discount off vs on; mean and best actual
 *
 * Usage: npm run backtest:injury-risk [-- --source=blend|ours|rotowire] [--gpp=10] [--json=path]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: db } = await import('../src/config/database.js');
const { resolveSlate, loadSlatePlayers, withActuals, scoreLineups } = await import('../src/services/slateSource.js');
const { generateLineupBatch } = await import('../src/services/optimizer/constraints/exposure.js');
const { easternDate } = await import('../src/services/slateSnapshotService.js');
const { computeErrorMetrics } = await import('../src/services/projectionBacktestService.js');

const args = process.argv.slice(2);
const opt = (name) => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? null;
const SITE = 'draftkings';
const SOURCE = opt('source') ?? 'blend';
const GPP_N = Number(opt('gpp') ?? 10);

const silence = console.log;
const quiet = (fn) => async (...a) => {
  console.log = () => {};
  const warn = console.warn;
  console.warn = () => {};
  try { return await fn(...a); } finally { console.log = silence; console.warn = warn; }
};
const out = (...a) => silence(...a);
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '  - ');
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : '  - ');
const pad = (s, n) => String(s).padEnd(n);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function seeded(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function mainSlates() {
  const rows = await db.all(`
    SELECT DISTINCT s.game_date, s.slate_id FROM slate_player_snapshots s
    JOIN slate_catalog c ON c.site = s.site AND c.slate_id = s.slate_id AND c.is_main = 1
    WHERE s.site = ? AND s.game_date < ? ORDER BY s.game_date`, SITE, easternDate(new Date()));
  return rows.map(r => ({ date: String(r.game_date).slice(0, 10), slateId: String(r.slate_id) }));
}

const metrics = (players) => computeErrorMetrics(players
  .filter(p => p.actualPoints !== null && p.actualPoints !== undefined)
  .map(p => ({ projected: Number(p.projected_points), actual: Number(p.actualPoints) })));

const build = quiet(async (source, players, settings) => {
  const result = generateLineupBatch(players, { site: SITE, ...settings }, { rng: seeded(7) });
  const scored = await scoreLineups(source, result.lineups || [], players);
  const actuals = scored.map(l => l.actualPoints).filter(Number.isFinite);
  return { mean: mean(actuals), best: actuals.length ? Math.max(...actuals) : null, skipped: result.skippedQuestionable?.count ?? 0, n: actuals.length,
    ids: (scored[0]?.players ?? []).map(s => s.player?.id).sort((x, y) => x - y),
    names: scored[0]?.players.map(s => `${s.player?.name}${s.player?.injury_tag ? ` (${s.player.injury_tag})` : ''} ${s.player?.actualPoints ?? '-'}`) ?? [] };
});

const load = quiet(async (source, injuryRisk) => withActuals(source, await loadSlatePlayers(source, { projectionSource: SOURCE, injuryRisk })));

const slates = await mainSlates();
out(`\nInjury-tag discount backtest: ${slates.length} DK main slates (${slates[0]?.date} .. ${slates.at(-1)?.date}), source ${SOURCE}, GPP ${GPP_N} lineups\n`);
out(`${pad('date', 11)} ${pad('tagged', 7)} ${pad('MAE off/on', 13)} ${pad('tagged MAE off/on', 19)} ${pad('cash off', 9)} ${pad('cash on', 9)} ${pad('disc only', 10)} ${pad('skip only', 10)} ${pad('GPP mean off/on', 17)} GPP best off/on`);

const report = [];
const all = { off: [], on: [] };
const tagged = { off: [], on: [] };
for (const s of slates) {
  const source = await resolveSlate({ slateDate: s.date, slateId: s.slateId, site: SITE });
  const off = await load(source, false);
  const on = await load(source, true);
  const onById = new Map(on.map(p => [p.id, p]));
  const tagIds = new Set(on.filter(p => p.injury_tag).map(p => p.id));
  all.off.push(...off); all.on.push(...on);
  tagged.off.push(...off.filter(p => tagIds.has(p.id))); tagged.on.push(...on.filter(p => tagIds.has(p.id)));
  const m = { off: metrics(off), on: metrics(on) };
  const t = { off: metrics(off.filter(p => tagIds.has(p.id))), on: metrics(on.filter(p => tagIds.has(p.id))) };
  const cash = {
    off: await build(source, off, { mode: 'cash', numLineups: 1, skipQuestionable: false }),
    on: await build(source, on, { mode: 'cash', numLineups: 1 }),
    discountOnly: await build(source, on, { mode: 'cash', numLineups: 1, skipQuestionable: false }),
    skipOnly: await build(source, off, { mode: 'cash', numLineups: 1, skipQuestionable: true })
  };
  const gpp = {
    off: await build(source, off, { mode: 'gpp', numLineups: GPP_N, minUniqueness: 2, randomness: 10 }),
    on: await build(source, on, { mode: 'gpp', numLineups: GPP_N, minUniqueness: 2, randomness: 10 })
  };
  out(`${pad(s.date, 11)} ${pad(tagIds.size, 7)} ${pad(`${f2(m.off.mae)}/${f2(m.on.mae)}`, 13)} ${pad(`${f2(t.off.mae)}/${f2(t.on.mae)}`, 19)} `
    + `${pad(f1(cash.off.mean), 9)} ${pad(`${f1(cash.on.mean)}${cash.on.skipped ? ` -${cash.on.skipped}` : ''}`, 9)} ${pad(f1(cash.discountOnly.mean), 10)} ${pad(f1(cash.skipOnly.mean), 10)} `
    + `${pad(`${f1(gpp.off.mean)}/${f1(gpp.on.mean)}`, 17)} ${f1(gpp.off.best)}/${f1(gpp.on.best)}`);
  const changed = cash.off.ids.join('|') !== cash.on.ids.join('|');
  report.push({ ...s, tagged: tagIds.size, mae: m, taggedMae: t, cash, gpp, cashChanged: changed,
    taggedPlayers: [...tagIds].map(id => { const p = onById.get(id); return { name: p.name, tag: p.injury_tag, salary: p.salary, pPlay: p.injury_play_prob, off: off.find(x => x.id === id)?.projected_points, on: p.projected_points, actual: p.actualPoints }; }) });
}

const sum = (k, side) => report.reduce((t, r) => t + (r[k][side].mean ?? 0), 0);
const sumBest = (k, side) => report.reduce((t, r) => t + (r[k][side].best ?? 0), 0);
const M = { off: metrics(all.off), on: metrics(all.on) };
const T = { off: metrics(tagged.off), on: metrics(tagged.on) };
out(`\nTOTAL (${report.length} slates)`);
out(`  MAE incl. DNP, all projected players (n=${M.off.n}): off ${f2(M.off.mae)} (bias ${f2(M.off.bias)})  on ${f2(M.on.mae)} (bias ${f2(M.on.bias)})`);
out(`  MAE incl. DNP, tagged players (n=${T.off.n}):        off ${f2(T.off.mae)} (bias ${f2(T.off.bias)})  on ${f2(T.on.mae)} (bias ${f2(T.on.bias)})`);
out(`  Cash lineup actual total: off ${f1(sum('cash', 'off'))}  on (discount + skip) ${f1(sum('cash', 'on'))}  discount only ${f1(sum('cash', 'discountOnly'))}  skip only ${f1(sum('cash', 'skipOnly'))}`);
out(`  Cash lineups changed on ${report.filter(r => r.cashChanged).length} of ${report.length} slates; Q players skipped ${report.reduce((t, r) => t + r.cash.on.skipped, 0)}`);
out(`  GPP (${GPP_N} lineups) mean actual summed over slates: off ${f1(sum('gpp', 'off'))}  on ${f1(sum('gpp', 'on'))};  best lineup summed: off ${f1(sumBest('gpp', 'off'))}  on ${f1(sumBest('gpp', 'on'))}`);

const json = opt('json');
if (json) {
  fs.writeFileSync(json, JSON.stringify({ source: SOURCE, gppLineups: GPP_N, total: { mae: M, taggedMae: T }, slates: report }, null, 2));
  out(`\nWrote ${json}`);
}
process.exit(0);
