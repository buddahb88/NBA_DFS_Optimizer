import db from '../config/database.js';
import lineupModel from '../models/lineupModel.js';
import playerModel from '../models/playerModel.js';

/**
 * Loads lineups for POST /api/lineups/export from the database, in the shape
 * buildLineupExport() expects: { lineupId, name, slateSite, players }.
 * Player rows always come from the DB so salary, positions and
 * site_player_id are the imported values, not whatever the client sent.
 */

const MAX_LINEUPS = 1000;

async function slateSiteLookup() {
  const cache = new Map();
  return async (slateId) => {
    if (!slateId) return null;
    if (!cache.has(slateId)) {
      const row = await db.get(`SELECT site FROM slates WHERE slate_id = ?`, slateId);
      cache.set(slateId, row?.site || null);
    }
    return cache.get(slateId);
  };
}

/** Saved lineups by id. Unknown ids come back as lineups with an error. */
export async function loadSavedLineups(lineupIds) {
  if (lineupIds.length > MAX_LINEUPS) throw Object.assign(new Error(`Export at most ${MAX_LINEUPS} lineups at a time`), { status: 400 });
  const siteOf = await slateSiteLookup();
  const lineups = [];
  for (const id of lineupIds) {
    const lineup = await lineupModel.getById(id);
    if (!lineup) {
      lineups.push({ lineupId: id, name: `Lineup ${id}`, players: [], missing: true });
      continue;
    }
    lineups.push({
      lineupId: lineup.id,
      name: lineup.name,
      slateSite: await siteOf(lineup.slate_id),
      players: lineup.players
    });
  }
  return lineups;
}

/**
 * Unsaved lineups (e.g. optimizer results): [{ name?, players: [{ id, positionSlot? }] }]
 * where id is players.id. Also accepts optimizer output ({ position, player }).
 */
export async function loadInlineLineups(inline) {
  if (inline.length > MAX_LINEUPS) throw Object.assign(new Error(`Export at most ${MAX_LINEUPS} lineups at a time`), { status: 400 });
  const siteOf = await slateSiteLookup();
  const playerCache = new Map();
  const getPlayer = async (id) => {
    if (!playerCache.has(id)) playerCache.set(id, (await playerModel.getById(id)) || null);
    return playerCache.get(id);
  };

  const lineups = [];
  for (const [i, lineup] of inline.entries()) {
    const players = [];
    const unknown = [];
    for (const entry of lineup?.players || []) {
      const ref = entry?.player ?? entry;
      const slot = entry?.positionSlot ?? entry?.position_slot ?? (entry?.player ? entry.position : undefined);
      if (!ref) continue;
      const row = ref.id !== undefined && ref.id !== null ? await getPlayer(ref.id) : null;
      if (!row) {
        unknown.push(ref.name || ref.id);
        continue;
      }
      players.push({ ...row, position_slot: slot ?? null });
    }
    lineups.push({
      lineupId: lineup?.id ?? null,
      name: lineup?.name || `Lineup ${i + 1}`,
      slateSite: await siteOf(players[0]?.slate_id),
      players,
      unknownPlayers: unknown
    });
  }
  return lineups;
}
