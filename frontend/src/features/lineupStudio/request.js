import { toRequestRules } from './stackRules';

/**
 * POST /api/optimizer/generate body from the studio's settings. Field names
 * follow the request contract in backend/src/services/optimizer/constraints
 * (exposure.js for exposure/uniqueness/randomness, stacking.js for stackRules).
 */
export function buildOptimizerRequest({ slateId, site, settings, locked = [], excluded = [] }) {
  const multi = settings.numLineups > 1;
  return {
    slateId,
    site,
    mode: settings.mode,
    numLineups: settings.numLineups,
    minSalary: settings.minSalary,
    randomness: settings.randomness,
    opportunityWeight: settings.opportunityWeight ?? 0,
    maxExposure: multi ? settings.maxExposure : 100,
    minUniqueness: multi ? settings.minUniqueness : 1,
    stackRules: toRequestRules(settings.stackRules),
    lockedPlayers: [...locked],
    excludedPlayers: [...excluded],
    minProjection: settings.minProjection,
    minMinutes: settings.minMinutes,
    maxRostership: settings.maxOwnership,
    filterInjured: true,
  };
}
