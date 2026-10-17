import slateModel from '../models/slateModel.js';
import { DEFAULT_SITE, SITE_KEYS, isValidSite } from '../config/sites.js';

/**
 * Pick the DFS site for a request: explicit `site` wins, then the slate's
 * site column, then DraftKings. Returns { site } or { error } for a bad site.
 */
export async function resolveSite(requestedSite, slateId) {
  if (requestedSite !== undefined && requestedSite !== null && requestedSite !== '') {
    if (!isValidSite(requestedSite)) {
      return { error: `Unknown site "${requestedSite}". Expected one of: ${SITE_KEYS.join(', ')}` };
    }
    return { site: requestedSite.toLowerCase() };
  }

  if (slateId) {
    const slate = await slateModel.getById(slateId);
    if (slate?.site && isValidSite(slate.site)) {
      return { site: slate.site.toLowerCase() };
    }
  }

  return { site: DEFAULT_SITE };
}
