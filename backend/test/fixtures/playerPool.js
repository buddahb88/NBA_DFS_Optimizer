// Small fake DraftKings slate: 4 teams (2 games), 32 players.
// Only the fields the optimizer reads are included. No DB required.
const TEAMS = [
  { team: 'AAA', opponent: 'BBB' },
  { team: 'BBB', opponent: 'AAA' },
  { team: 'CCC', opponent: 'DDD' },
  { team: 'DDD', opponent: 'CCC' },
];

// [position, salary, projected_points] per roster spot; repeated for each team
// with small offsets so teams are not identical.
const TEMPLATE = [
  ['PG', 9800, 48],
  ['SG', 7200, 35],
  ['SF', 6400, 31],
  ['PF', 5600, 28],
  ['C', 8400, 42],
  ['PG,SG', 4800, 23],
  ['SF,PF', 4200, 20],
  ['PF,C', 3600, 17],
];

export function buildPlayerPool() {
  const players = [];
  let id = 1;
  TEAMS.forEach(({ team, opponent }, teamIdx) => {
    TEMPLATE.forEach(([position, salary, projection]) => {
      const salaryAdj = salary + teamIdx * 200 - 300;
      const proj = projection + teamIdx * 0.7 - 1;
      players.push({
        id,
        name: `Player ${id}`,
        team,
        opponent,
        position,
        salary: salaryAdj,
        projected_points: proj,
        floor: proj * 0.75,
        ceiling: proj * 1.3,
        rostership: 5 + ((id * 7) % 30),
        leverage_score: (id % 5) + 1,
      });
      id++;
    });
  });
  return players;
}
