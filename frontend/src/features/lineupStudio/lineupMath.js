// Pure lineup helpers for the Lineup Studio: slot eligibility per site,
// lineup totals, and exposure across a set of lineups.

// Used until GET /api/sites answers (mirrors backend/src/config/sites.js)
export const FALLBACK_SITE = {
  key: 'draftkings',
  name: 'DraftKings',
  salaryCap: 50000,
  rosterSlots: [
    { slot: 'PG', eligible: ['PG'] },
    { slot: 'SG', eligible: ['SG'] },
    { slot: 'SF', eligible: ['SF'] },
    { slot: 'PF', eligible: ['PF'] },
    { slot: 'C', eligible: ['C'] },
    { slot: 'G', eligible: ['PG', 'SG'] },
    { slot: 'F', eligible: ['SF', 'PF'] },
    { slot: 'UTIL', eligible: ['PG', 'SG', 'SF', 'PF', 'C'] },
  ],
};

/** Base positions a player is listed at ("PG/SG" -> ['PG', 'SG']). */
export function playerPositions(player) {
  const raw = player?.position || '';
  return String(raw)
    .split(/[,/]/)
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);
}

const slotEligible = (slotDef) => slotDef.eligible || [slotDef.slot];

export function canFillSlot(player, slotDef) {
  const positions = playerPositions(player);
  return slotEligible(slotDef).some((p) => positions.includes(p));
}

/** Indexes of the site's roster slots this player can fill. */
export function eligibleSlotIndexes(siteConfig, player) {
  return siteConfig.rosterSlots.flatMap((s, i) => (canFillSlot(player, s) ? [i] : []));
}

/**
 * Best open slot for a player: the most restrictive eligible slot that is
 * empty (PG before G before UTIL), so flexible slots stay open. -1 if none.
 */
export function pickSlot(siteConfig, slots, player) {
  let best = -1;
  for (const i of eligibleSlotIndexes(siteConfig, player)) {
    if (slots[i]) continue;
    if (best === -1 || slotEligible(siteConfig.rosterSlots[i]).length < slotEligible(siteConfig.rosterSlots[best]).length) {
      best = i;
    }
  }
  return best;
}

export const emptySlots = (siteConfig) => siteConfig.rosterSlots.map(() => null);

/** Optimizer response lineup -> [{ slot, player }] */
export function normalizeLineup(lineup) {
  return (lineup.players || []).map((s) => ({ slot: s.position ?? s.slot, player: s.player }));
}

/**
 * Lineup [{ slot, player }] -> players aligned with siteConfig.rosterSlots,
 * matching by slot name in order (for opening a lineup in the manual builder).
 */
export function slotsFromLineup(siteConfig, entries) {
  const remaining = [...entries];
  return siteConfig.rosterSlots.map(({ slot }) => {
    const idx = remaining.findIndex((e) => e.slot === slot);
    return idx === -1 ? null : remaining.splice(idx, 1)[0].player ?? null;
  });
}

/** Totals for [{ slot, player }] or a plain player array (nulls skipped). */
export function lineupTotals(entries, salaryCap) {
  const players = entries.map((e) => (e && 'player' in e ? e.player : e)).filter(Boolean);
  const salary = players.reduce((s, p) => s + (Number(p.salary) || 0), 0);
  return {
    salary,
    remaining: salaryCap - salary,
    projection: players.reduce((s, p) => s + (Number(p.projected_points) || 0), 0),
    ownership: players.reduce((s, p) => s + (Number(p.rostership) || 0), 0),
    filled: players.length,
  };
}

/**
 * Exposure across lineups ([{ slot, player }][]).
 * players: [{ id, player, count, exposure }] by count desc
 * teams:   [{ team, lineups, exposure, slots }] by lineups desc
 */
export function computeExposure(lineups) {
  const n = lineups.length;
  const byPlayer = new Map();
  const byTeam = new Map();

  for (const lineup of lineups) {
    const teamsInLineup = new Set();
    for (const { player } of lineup) {
      if (!player) continue;
      const row = byPlayer.get(player.id) || { id: player.id, player, count: 0 };
      row.count += 1;
      byPlayer.set(player.id, row);
      if (player.team) {
        const team = byTeam.get(player.team) || { team: player.team, lineups: 0, slots: 0 };
        team.slots += 1;
        byTeam.set(player.team, team);
        teamsInLineup.add(player.team);
      }
    }
    teamsInLineup.forEach((t) => (byTeam.get(t).lineups += 1));
  }

  const pct = (c) => (n ? (c / n) * 100 : 0);
  return {
    players: [...byPlayer.values()]
      .map((r) => ({ ...r, exposure: pct(r.count) }))
      .sort((a, b) => b.count - a.count || (b.player.projected_points || 0) - (a.player.projected_points || 0)),
    teams: [...byTeam.values()]
      .map((r) => ({ ...r, exposure: pct(r.lineups) }))
      .sort((a, b) => b.lineups - a.lineups || b.slots - a.slots),
  };
}

export function formatSalary(value) {
  return `$${Math.round(Number(value) || 0).toLocaleString()}`;
}

/** Trigger a browser download of text content. */
export function downloadText(filename, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
