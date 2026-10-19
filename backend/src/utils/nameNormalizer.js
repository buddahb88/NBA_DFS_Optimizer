/**
 * PLAYER NAME / TEAM NORMALIZATION
 *
 * DFS sites, RotoWire and NBA stats spell names differently:
 *   "Luka Dončić" / "Luka Doncic", "Jaren Jackson Jr." / "Jaren Jackson",
 *   "P.J. Washington" / "PJ Washington", "Nic Claxton" / "Nicolas Claxton".
 * normalizeName() maps all of those to one key so imports can be matched
 * to existing projections and historical games.
 */

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

// Known alternate spellings, keyed and valued by normalized name.
// Both sides map to the same canonical key.
const NAME_ALIASES = {
  'nicolas claxton': 'nic claxton',
  'herbert jones': 'herb jones',
  'cameron thomas': 'cam thomas',
  'cameron johnson': 'cam johnson',
  'cameron reddish': 'cam reddish',
  'moe wagner': 'moritz wagner',
  'bub carrington': 'carlton carrington',
  'kenyon martin': 'kj martin',
  'gregory jackson': 'gg jackson',
  'alexandre sarr': 'alex sarr',
  'nahshon hyland': 'bones hyland',
  'mohamed bamba': 'mo bamba',
  'robert williams': 'rob williams',
  'jeffrey dowtin': 'jeff dowtin',
  'sviatoslav mykhailiuk': 'svi mykhailiuk',
  'ishmael smith': 'ish smith',
  'enes freedom': 'enes kanter',
  'jakob poltl': 'jakob poeltl',
  'dennis schroeder': 'dennis schroder',
  'vitor luiz faverani': 'vitor faverani',
  'yongxi cui': 'cui yongxi',
  'ron holland': 'ronald holland',
  'nikola djurisic': 'nikola durisic'
};

/**
 * Normalize a player name to a match key.
 * Lowercases, strips accents and punctuation, drops Jr./Sr./II/III/IV,
 * joins initials ("a j green" -> "aj green") and applies NAME_ALIASES.
 */
export function normalizeName(name) {
  if (!name) return '';
  let s = String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[đ]/g, 'd')
    .replace(/[ø]/g, 'o')
    .replace(/['’`.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  const tokens = s.split(/\s+/).filter(t => t && !SUFFIXES.has(t));
  if (tokens.length === 0) return '';

  // Join runs of single letters: "a j green" -> "aj green"
  const joined = [];
  let inInitials = false;
  for (const t of tokens) {
    if (t.length === 1 && inInitials) {
      joined[joined.length - 1] += t;
    } else {
      joined.push(t);
      inInitials = t.length === 1;
    }
  }
  s = joined.join(' ');

  return NAME_ALIASES[s] || s;
}

// Site / feed abbreviations -> standard NBA abbreviations
const TEAM_ALIASES = {
  GS: 'GSW', GSW: 'GSW',
  NO: 'NOP', NOR: 'NOP', NOP: 'NOP',
  SA: 'SAS', SAS: 'SAS',
  NY: 'NYK', NYK: 'NYK',
  PHO: 'PHX', PHX: 'PHX',
  BK: 'BKN', BRK: 'BKN', BKN: 'BKN',
  CHO: 'CHA', CHA: 'CHA',
  UTAH: 'UTA', UTA: 'UTA', UTH: 'UTA',
  WSH: 'WAS', WAS: 'WAS'
};

/** Standard NBA team abbreviation ("GS" -> "GSW", "pho" -> "PHX"). */
export function normalizeTeam(team) {
  if (!team) return '';
  const t = String(team).trim().toUpperCase();
  return TEAM_ALIASES[t] || t;
}
