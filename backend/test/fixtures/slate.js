/**
 * Deterministic synthetic slate for optimizer tests (no DB needed).
 * Salaries are DraftKings-scale; scaleSalaries() rescales for other sites.
 */

// Small seeded PRNG (mulberry32) so fixtures and randomness are repeatable
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C', 'PG,SG', 'SG,SF', 'SF,PF', 'PF,C'];
const GAMES = [['BOS', 'NYK'], ['LAL', 'GSW'], ['DEN', 'PHX'], ['MIA', 'MIL'], ['DAL', 'OKC']];

export function makeSlate({ seed = 42, perTeam = 9 } = {}) {
  const rand = seededRandom(seed);
  const players = [];
  let id = 1;
  for (const [home, away] of GAMES) {
    for (const [team, opponent] of [[home, away], [away, home]]) {
      for (let i = 0; i < perTeam; i++) {
        const salary = Math.round((3000 + rand() * 8000) / 100) * 100;
        const projected = salary / 1000 * (4 + rand() * 2.5);
        players.push({
          id: id++,
          name: `${team} Player ${i + 1}`,
          team,
          opponent,
          position: POSITIONS[Math.floor(rand() * POSITIONS.length)],
          salary,
          projected_points: Number(projected.toFixed(2)),
          floor: Number((projected * (0.6 + rand() * 0.15)).toFixed(2)),
          ceiling: Number((projected * (1.3 + rand() * 0.4)).toFixed(2)),
          rostership: Number((rand() * 40).toFixed(1)),
          leverage_score: Number((rand() * 10).toFixed(2)),
          projected_minutes: Math.round(15 + rand() * 22),
          usage: Number((12 + rand() * 20).toFixed(1))
        });
      }
    }
  }
  return players;
}

export function scaleSalaries(players, factor, round = 100) {
  return players.map(p => ({ ...p, salary: Math.round((p.salary * factor) / round) * round || round }));
}

/**
 * Run fn with Math.random replaced by a seeded PRNG
 */
export function withSeed(seed, fn) {
  const original = Math.random;
  Math.random = seededRandom(seed);
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

export const lineupIds = (lineup) => lineup.players.map(s => s.player?.id ?? null);
