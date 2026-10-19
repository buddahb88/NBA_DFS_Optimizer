import { getSiteConfig } from '../config/sites.js';

/**
 * LINEUP CSV EXPORT
 *
 * Builds a site upload CSV (header + one row per lineup) using the site's
 * csvExport rules from config/sites.js.
 *
 *   lineups: [{ players: [{ slot, playerId }] }]
 *   playersById: Map(playerId -> player row with site_player_id, name)
 *
 * Each lineup's players are matched to the site's slotOrder columns by slot
 * name, in order (FanDuel's repeated PG/PG etc. take the next unused entry).
 * Players without a site_player_id are written as their name and reported in
 * warnings, since the site will reject that cell on upload.
 */

const escapeCell = (value) => {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function formatPlayer(player, playerFormat) {
  const id = player.site_player_id;
  if (playerFormat === 'id:name') return `${id}:${player.name}`;
  return String(id);
}

export function buildLineupCsv(site, lineups, playersById) {
  const config = getSiteConfig(site);
  const { header, slotOrder, playerFormat } = config.csvExport;
  const warnings = [];
  const missingIds = new Set();
  const rows = [];

  lineups.forEach((lineup, i) => {
    const remaining = [...(lineup.players || [])];
    const cells = slotOrder.map((slot) => {
      const idx = remaining.findIndex((p) => String(p.slot).toUpperCase() === slot);
      if (idx === -1) return null;
      const [entry] = remaining.splice(idx, 1);
      return playersById.get(Number(entry.playerId)) || null;
    });

    if (cells.some((p) => !p) || remaining.length) {
      warnings.push(`Lineup ${i + 1} does not fill the ${config.name} roster (${slotOrder.join(', ')}); skipped`);
      return;
    }

    rows.push(cells.map((p) => {
      if (!p.site_player_id) {
        missingIds.add(p.name);
        return p.name;
      }
      return formatPlayer(p, playerFormat);
    }));
  });

  if (missingIds.size) {
    warnings.push(
      `No ${config.name} player ID for ${[...missingIds].join(', ')}. Import the site salary CSV for this slate, or the upload will reject those cells.`
    );
  }

  const csv = [header, ...rows].map((row) => row.map(escapeCell).join(',')).join('\r\n') + '\r\n';
  return { csv, count: rows.length, warnings };
}
