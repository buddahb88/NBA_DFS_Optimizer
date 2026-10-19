import { getSiteConfig } from '../../config/sites.js';
import { defaultMinSalary } from './scoring.js';

/**
 * Request-level optimizer context: site rules plus normalized settings.
 * buildSolveContext() extends it per solve with the player pool and the
 * bookkeeping maps constraint modules share.
 */
export function buildRequestContext(settings = {}) {
  const site = getSiteConfig(settings.site);

  const slotCounts = new Map();
  site.rosterSlots.forEach(({ slot }) => slotCounts.set(slot, (slotCounts.get(slot) || 0) + 1));

  let minSalary = settings.minSalary ?? defaultMinSalary(site);
  if (minSalary > site.salaryCap) {
    // e.g. a DK-sized minSalary sent for a Yahoo ($200) slate
    console.warn(`⚠️  minSalary ${minSalary} exceeds ${site.name} cap ${site.salaryCap}; using ${defaultMinSalary(site)}`);
    minSalary = defaultMinSalary(site);
  }

  return {
    site,
    settings,
    mode: settings.mode || 'cash',
    rosterSize: site.rosterSlots.length,
    slotCounts,
    minSalary,
    minUniqueness: Math.max(0, Math.floor(Number(settings.minUniqueness) || 0)),
    lockedPlayers: new Set(settings.lockedPlayers || []),
    requestExcluded: new Set(settings.excludedPlayers || []),
    excludedPlayers: new Set(settings.excludedPlayers || [])
  };
}

export function buildSolveContext(requestCtx, players, extra = {}) {
  return {
    ...requestCtx,
    players,
    playersById: new Map(players.map(p => [p.id, p])),
    varMeta: new Map(),      // varName -> { playerId, slot }
    varsByPlayer: new Map(), // playerId -> [varName]
    priorLineups: [],
    ...extra
  };
}
