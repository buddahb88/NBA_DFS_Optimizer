// Pure helpers behind SlateContext (no React, so node --test can import them).

export const SLATE_STORAGE_KEY = 'nba-dfs:slate-selection';
export const DEFAULT_SITE = 'draftkings';

/** Persisted { site, slateId }; missing or unreadable storage yields nulls. */
export function readStoredSelection(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage.getItem(SLATE_STORAGE_KEY) || '{}');
    return {
      site: typeof parsed.site === 'string' ? parsed.site : null,
      slateId: parsed.slateId == null ? null : String(parsed.slateId),
    };
  } catch {
    return { site: null, slateId: null };
  }
}

export function writeStoredSelection({ site, slateId }, storage = globalThis.localStorage) {
  try {
    storage.setItem(SLATE_STORAGE_KEY, JSON.stringify({ site, slateId }));
  } catch {
    // storage unavailable (private mode); selection still works for this session
  }
}

/** Keep the wanted site if the server knows it, else DraftKings, else the first site. */
export function resolveSite(sites, wanted) {
  const keys = Object.keys(sites || {});
  if (wanted && keys.includes(wanted)) return wanted;
  if (keys.includes(DEFAULT_SITE) || keys.length === 0) return DEFAULT_SITE;
  return keys[0];
}

/**
 * Keep the wanted slate if it is still in the list, else the first one
 * (GET /api/slates is newest first, same as the old "active slate").
 */
export function resolveSlateId(slates, wanted) {
  if (!slates?.length) return null;
  if (wanted != null && slates.some((s) => String(s.slate_id) === String(wanted))) return String(wanted);
  return String(slates[0].slate_id);
}

/** 50000 -> "$50K", 200 -> "$200" */
export function formatSalaryCap(cap) {
  if (typeof cap !== 'number') return '';
  return cap >= 1000 && cap % 1000 === 0 ? `$${cap / 1000}K` : `$${cap.toLocaleString('en-US')}`;
}

/** Roster slots grouped in order: FanDuel -> "2PG 2SG 2SF 2PF C". */
export function formatRosterSlots(rosterSlots = []) {
  const counts = new Map();
  for (const { slot } of rosterSlots) counts.set(slot, (counts.get(slot) || 0) + 1);
  return [...counts].map(([slot, n]) => (n > 1 ? `${n}${slot}` : slot)).join(' ');
}

/** Team-construction rules as short phrases, e.g. ["Max 4 per team", "Min 3 teams"]. */
export function describeTeamRules(site) {
  if (!site) return [];
  const rules = [];
  if (site.maxPlayersPerTeam) rules.push(`Max ${site.maxPlayersPerTeam} per team`);
  if (site.minTeams) rules.push(`Min ${site.minTeams} teams`);
  if (site.minGames) rules.push(`Min ${site.minGames} games`);
  return rules;
}
