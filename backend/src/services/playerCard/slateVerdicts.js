/**
 * SLATE VERDICTS
 *
 * The player card's Cash / GPP verdict for EVERY player of a slate in one
 * pass: the slate-wide pieces (slate rows, own model, Opportunity Radar,
 * matchups, team ratings) load once (playerCardService.prepareSource), every
 * player's game log + salary history in one batched read (loadHistory), then
 * the card's own assemblePlayer + buildVerdict run per player. Same code path
 * as getPlayerCard, so the lineup column and the card can never disagree.
 *
 * Result: { slateId, slateDate, site, isBacktest, projectionSource,
 * thresholds (score cut-offs per verdict), slate (game count, size bucket,
 * ownership distribution: slateContext.js), generatedAt, dataVersion, cached, timings, warnings,
 * players: { [slate row id]: { id, player_id, player_key, name, team, salary,
 *   cash: { verdict, score, confidence }, gpp: {...}, headline } } }.
 * detail: true adds per player { projection: { active, rotowire, ours, blend,
 * source }, rules } (the backtest report, V2 optimizer weights).
 *
 * Backtest slates (past slateDate) are as of that date, like the card: the
 * history read stops the day before and the slate rows are the saved snapshot.
 *
 * Cache: per slate + date + site + projection source + data version (box
 * scores / snapshots / statuses signature, the slate's rows, the sanity
 * config), TTL as a safety net. clearSlateVerdictCache() runs on a box-score
 * sync, a slate sync and a projection source change. Concurrent requests for
 * the same key share one computation.
 */

import crypto from 'crypto';
import db from '../../config/database.js';
import { parseSource, projectionSource as activeProjectionSource } from '../../config/projectionSource.js';
import { projectionSanityConfig } from '../../config/projectionSanity.js';
import { resolveSlate, SlateSourceError } from '../slateSource.js';
import { dataSignature } from '../modelEval/modelEvalService.js';
import { prepareSource, loadHistory, assemblePlayer, slatePlayerKey } from './playerCardService.js';
import { THRESHOLDS } from './verdict.js';
import { slateContextSummary } from './slateContext.js';

const TTL_MS = { live: 10 * 60 * 1000, backtest: 6 * 60 * 60 * 1000 };
const CACHE_LIMIT = 40;

const results = new Map();   // key -> { at, ttl, value }
const inflight = new Map();  // key -> Promise
let generation = 0;

const ms = (t0) => Math.round(performance.now() - t0);

/** Drop every cached slate verdict (new box scores, a slate sync, a projection source change, tests). */
export function clearSlateVerdictCache() {
  results.clear();
  inflight.clear();
  generation += 1;
}

/** Signature of the slate's own rows (live players table or the saved snapshot). */
async function slateRowsSignature(source) {
  const r = source.isBacktest
    ? await db.get('SELECT COUNT(*) AS c, MAX(captured_at) AS m, SUM(projected_points) AS s FROM slate_player_snapshots WHERE slate_id = ? AND game_date = ?', source.slateId, source.slateDate)
    : await db.get('SELECT COUNT(*) AS c, MAX(updated_at) AS m, SUM(projected_points) AS s FROM players WHERE slate_id = ?', source.slateId);
  return `${r?.c}:${r?.m}:${r?.s ?? ''}`;
}

/** Data version of a slate's verdicts: anything that changes an input changes it. */
export async function verdictDataVersion(source) {
  const parts = [await dataSignature(), await slateRowsSignature(source), JSON.stringify(projectionSanityConfig())];
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

/** The blurb's first sentence: the strongest driver(s) with their numbers. */
export function headlineOf(verdict) {
  const blurb = String(verdict?.blurb ?? '');
  const first = blurb.split(/(?<=[.!?])\s+(?=[A-Z])/)[0] ?? '';
  return first.trim() || null;
}

const pick = ({ verdict, score, confidence }) => ({ verdict, score, confidence });

/** One player's entry; detail adds the projection numbers and the rule list. */
function entryFor(p, a, detail) {
  const entry = {
    id: p.id,
    player_id: p.player_id ?? null,
    player_key: a.key,
    name: p.name,
    team: a.team,
    salary: a.salary,
    cash: pick(a.verdict.cash),
    gpp: pick(a.verdict.gpp),
    headline: headlineOf(a.verdict),
    // Set only when the slate size changed the call (verdict.slate.note)
    slate_note: a.verdict.slate?.note ?? null,
  };
  if (detail) {
    entry.projection = {
      source: a.projection.source,
      active: a.projection.active,
      rotowire: a.projection.rotowire,
      ours: a.projection.ours,
      blend: a.projection.blend,
      rostership: a.projection.rostership,
    };
    entry.injury_status = p.injury_status ?? null;
    entry.rules = a.verdict.rules.map(({ blurb, ...r }) => r);
  }
  return entry;
}

const compact = ({ projection, injury_status, rules, ...e }) => e;

/** Compute every player's verdict for a resolved source (no cache). */
export async function computeSlateVerdicts(source, { projectionSource = null, now = new Date() } = {}) {
  const t0 = performance.now();
  const prep = await prepareSource(source, { projectionSource, now });
  const prepMs = ms(t0);
  const t1 = performance.now();
  const keys = prep.players.map(slatePlayerKey);
  let history = null;
  try {
    history = await loadHistory(keys, { asOf: prep.asOf, season: prep.season, site: source.site });
  } catch (error) {
    prep.warnings.push(`game log: ${error.message}`);
  }
  const historyMs = ms(t1);
  const t2 = performance.now();
  const rows = prep.players.map(p => ({ p, a: assemblePlayer(p, prep, history) }));
  return {
    prep,
    rows,
    timings: { prepMs, historyMs, assembleMs: ms(t2), totalMs: ms(t0), players: rows.length },
  };
}

/**
 * Verdicts for every player of a slate (see the header). Throws
 * SlateSourceError (404 when no slate matches).
 */
export async function getSlateVerdicts({
  slateId = null, slateDate = null, projectionSource = null, detail = false, refresh = false, now = new Date(),
} = {}) {
  const t0 = performance.now();
  const source = await resolveSlate({ slateId, slateDate: slateDate || null, now });
  if (!source) throw new SlateSourceError('No slate synced', 404);
  const chosen = parseSource(projectionSource) ?? activeProjectionSource();
  const version = await verdictDataVersion(source);
  const key = [source.slateId, source.slateDate ?? '', source.site, chosen, version].join('|');

  const hit = results.get(key);
  let full;
  let cached = false;
  if (!refresh && hit && Date.now() - hit.at < hit.ttl) {
    full = hit.value;
    cached = true;
  } else {
    let pending = refresh ? null : inflight.get(key);
    if (!pending) {
      const gen = generation;
      pending = (async () => {
        const { prep, rows, timings } = await computeSlateVerdicts(source, { projectionSource: chosen, now });
        const value = {
          slateId: source.slateId,
          slateDate: source.slateDate ?? null,
          site: source.site,
          isBacktest: Boolean(source.isBacktest),
          asOf: prep.asOf,
          projectionSource: chosen,
          thresholds: THRESHOLDS,
          slate: slateContextSummary(prep.slate),
          generatedAt: new Date().toISOString(),
          dataVersion: version,
          timings,
          warnings: prep.warnings,
          // Detail entries only: the assembled form / logs are not kept in memory
          rows: rows.map(({ p, a }) => entryFor(p, a, true)),
        };
        // Only a clean result (every slate-wide piece loaded) from the current generation is cached
        if (!prep.warnings.length && gen === generation) {
          results.delete(key);
          results.set(key, { at: Date.now(), ttl: source.isBacktest ? TTL_MS.backtest : TTL_MS.live, value });
          while (results.size > CACHE_LIMIT) results.delete(results.keys().next().value);
        }
        return value;
      })().finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    full = await pending;
  }

  const players = {};
  for (const e of full.rows) players[String(e.id)] = detail ? e : compact(e);
  const { rows, ...meta } = full;
  return { ...meta, cached, timings: cached ? { totalMs: ms(t0), players: rows.length } : { ...meta.timings, totalMs: ms(t0) }, players };
}

export default { getSlateVerdicts, computeSlateVerdicts, clearSlateVerdictCache, verdictDataVersion, headlineOf };
