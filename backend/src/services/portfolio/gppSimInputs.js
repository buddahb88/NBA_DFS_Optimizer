/**
 * GPP SIM INPUTS (main thread: DB reads only, never writes)
 *
 * The sim's players for a slate: the own-model blend (GET /api/projections/:slateId/own-model,
 * calibrated, as of the slate's date) joined by id to the slate rows for projected ownership,
 * positions and injury tags. OUT-tagged players are always ruled out (both from our pool and
 * from the field). At lock (`atLock`) also everyone ruled out since the last sync:
 *   live slate  - RotoWire's current payload (read-only fetch, nothing is stored): players now
 *                 tagged OUT or no longer projected. A failed fetch keeps the synced tags (warning).
 *   past slate  - players who did not play (the box scores), i.e. a perfect final news check,
 *                 as the 10/20-11/7 backtests' "lock" mode
 * plus any `ruledOut` ids / names from the request.
 */

import { loadActuals, loadSlatePlayers, resolveSlate } from '../slateSource.js';
import { isOutStatus } from '../minutesModel.js';
import { playerKey } from '../../utils/playerKey.js';

const OUT_RE = /^(OUT|O)$/i;
const isOut = (status) => isOutStatus(status) || OUT_RE.test(String(status ?? '').trim());
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Default fresh-tag fetch: RotoWire's current payload for the slate (no DB writes). */
async function fetchRotowireOuts(slateId) {
  const { default: rotowireService } = await import('../rotowireService.js');
  const raw = await rotowireService.fetchRawPlayers(slateId);
  const list = Array.isArray(raw) ? raw : [];
  const kept = new Set(rotowireService.transformPlayerData(list.map(({ stats, ...p }) => p)).map((t) => String(t.playerId)));
  const out = new Map();
  for (const p of list) {
    const name = `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() || p.name;
    const key = name ? playerKey(name) : null;
    if (!key) continue;
    const id = String(p.rwID ?? p.rwid ?? p.id ?? p.player_id ?? p.pid ?? '');
    const status = p.injuryStatus ?? p.injury_status ?? null;
    if (isOut(typeof status === 'object' && status ? status.status ?? '' : status)) out.set(key, `RotoWire: ${typeof status === 'string' ? status : 'OUT'}`);
    else if (id && !kept.has(id)) out.set(key, 'RotoWire: no longer projected');
  }
  return out;
}

/**
 * Own-model rows (by slate player id) -> sim player rows.
 * @param rows - slate rows (players-table shape)
 * @param ownModel - projectSlateOwnModel result (null: fall back to the slate projections)
 */
export function mergeSimPlayers(rows, ownModel) {
  const byId = new Map((ownModel?.players ?? []).map((p) => [String(p.id), p]));
  return rows
    .filter((r) => Number(r.salary) > 0)
    .map((r) => {
      const o = byId.get(String(r.id));
      const blend = num(o?.blend_point);
      const out = isOut(r.injury_status) || isOut(o?.injury_status);
      return {
        id: r.id,
        player_id: r.player_id ?? null,
        player_key: r.player_key ?? playerKey(r.name),
        name: r.name,
        team: r.team,
        opponent: r.opponent,
        position: r.position,
        salary: Number(r.salary),
        proj: blend ?? (ownModel ? null : num(r.projected_points)),
        p10: blend != null ? num(o.blend_p10) : num(r.floor),
        p90: blend != null ? num(o.blend_p90) : num(r.ceiling),
        pPlay: num(o?.p_play),
        minutes: num(o?.ours_minutes) ?? num(r.projected_minutes),
        own: num(r.rostership) ?? 0,
        injury_status: r.injury_status ?? null,
        out,
        outReason: out ? `tagged ${r.injury_status ?? o?.injury_status ?? 'OUT'}` : null
      };
    });
}

/**
 * Load a slate's sim inputs.
 * @param request - { slateId, slateDate }
 * @param options - { atLock, ruledOut: [id|name], fetchOuts?: (slateId) => Map(player_key -> reason),
 *   projectOwnModel?: (slateId, {source}) => result, now }
 * @returns {{ source, players, actuals: Map|null, notes: string[], ownModel: {generatedAt, calibration}|null }}
 */
export async function loadGppSimInputs({ slateId = null, slateDate = null } = {}, {
  atLock = false, ruledOut = [], fetchOuts = fetchRotowireOuts, projectOwnModel = null, now = new Date()
} = {}) {
  const source = await resolveSlate({ slateId, slateDate, now });
  if (!source) throw Object.assign(new Error('No slate synced'), { status: 404 });
  const rows = await loadSlatePlayers(source, { includeZero: true, sanity: false, projectionSource: 'rotowire', injuryRisk: false, now });
  if (!rows.length) throw Object.assign(new Error('No players found for this slate'), { status: 404 });
  const notes = [];

  let ownModel = null;
  try {
    const project = projectOwnModel ?? (await import('../modelEval/ownModelService.js')).projectSlateOwnModel;
    ownModel = await project(source.slateId, { source });
    if (!ownModel?.players?.some((p) => num(p.blend_point) != null)) {
      notes.push('Own-model blend unavailable (no blend weights); using the slate projections and floor / ceiling');
      ownModel = null;
    }
  } catch (err) {
    notes.push(`Own-model blend failed (${err.message}); using the slate projections and floor / ceiling`);
    ownModel = null;
  }
  const players = mergeSimPlayers(rows, ownModel);
  const actuals = source.isBacktest ? await loadActuals(source, rows) : null;

  const markOut = (p, reason) => {
    if (p.out) return;
    p.out = true;
    p.outReason = reason;
  };
  if (atLock) {
    if (source.isBacktest) {
      for (const p of players) {
        const a = actuals?.get(p.id);
        if (a && a.resultStatus && a.resultStatus !== 'PLAYED' && a.resultStatus !== 'PENDING') markOut(p, 'did not play');
      }
    } else {
      try {
        const outs = await fetchOuts(source.slateId);
        for (const p of players) if (outs.has(p.player_key)) markOut(p, outs.get(p.player_key));
        notes.push(`Refreshed injury tags from RotoWire (${outs.size} out / unprojected)`);
      } catch (err) {
        notes.push(`Could not refresh injury tags (${err.message}); used the last sync's tags`);
      }
    }
  }
  const refs = new Set((ruledOut ?? []).map(String));
  for (const p of players) {
    if ([p.id, p.player_id, p.name].some((r) => r != null && refs.has(String(r)))) markOut(p, 'ruled out (request)');
  }

  return {
    source,
    players,
    actuals,
    notes,
    ownModel: ownModel ? { generatedAt: ownModel.generatedAt, calibration: ownModel.calibration ?? null, weights: ownModel.weights?.name ?? null } : null
  };
}
