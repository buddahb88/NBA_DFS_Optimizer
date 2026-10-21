/**
 * PLAYER ARCHETYPE SERVICE
 *
 * Classifies each player_season_profiles row into one archetype (plus an
 * optional secondary) using the rules in config/archetypes.js, and stores the
 * result in player_archetypes with a JSON rule_trace explaining why.
 */

import db, { DATABASE_TYPE } from '../config/database.js';
import * as defaultConfig from '../config/archetypes.js';

const COMPARE = {
  '>=': (a, b) => a >= b,
  '>': (a, b) => a > b,
  '<=': (a, b) => a <= b,
  '<': (a, b) => a < b,
  in: (a, b) => b.includes(a),
  not_in: (a, b) => !b.includes(a),
};

function evaluate(rule, profile) {
  if (rule.any) {
    const conditions = rule.any.map(r => evaluate(r, profile));
    return { any: conditions, pass: conditions.some(c => c.pass) };
  }
  const compare = COMPARE[rule.op];
  if (!compare) throw new Error(`Unknown archetype rule op: ${rule.op}`);
  const actual = profile[rule.stat] ?? null;
  return { stat: rule.stat, op: rule.op, value: rule.value, actual, pass: actual != null && compare(actual, rule.value) };
}

// Actual values to 3 decimals; thresholds as configured
const fmt = (v) => (typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(3) : String(v));
const fmtThreshold = (v) => (Array.isArray(v) ? `[${v.join(',')}]` : String(v));

function describe(condition) {
  if (condition.any) return `(${condition.any.filter(c => c.pass).map(describe).join(' or ')})`;
  return `${condition.stat} ${fmt(condition.actual)} ${condition.op} ${fmtThreshold(condition.value)}`;
}

/**
 * Classify one profile. Pure; pass a config to override config/archetypes.js.
 * Returns { archetype, secondary_archetype, rule_trace } (archetype keys).
 */
export function classifyProfile(profile, config = defaultConfig) {
  const { MIN_SAMPLE, ARCHETYPES, DEFAULT_ARCHETYPE } = config;
  const unclassifiedKey = config.UNCLASSIFIED_ARCHETYPE?.key ?? 'unclassified';

  const sampleCheck = (stat) => {
    const value = Number(profile[stat]) || 0;
    return { value, min: MIN_SAMPLE[stat], pass: value >= MIN_SAMPLE[stat] };
  };
  const sample = { games: sampleCheck('games'), minutes: sampleCheck('minutes') };
  sample.pass = sample.games.pass && sample.minutes.pass;

  if (!sample.pass) {
    const failed = ['games', 'minutes'].filter(s => !sample[s].pass)
      .map(s => `${s} ${fmt(sample[s].value)} < ${sample[s].min}`);
    return {
      archetype: unclassifiedKey,
      secondary_archetype: null,
      rule_trace: { sample, rules: [], reason: `Below minimum sample: ${failed.join(', ')}` },
    };
  }

  const rules = ARCHETYPES.map(a => {
    const conditions = a.rules.map(r => evaluate(r, profile));
    return { archetype: a.key, matched: conditions.every(c => c.pass), conditions };
  });
  const matches = rules.filter(r => r.matched);
  const primary = matches[0];

  let reason;
  if (primary) {
    const label = ARCHETYPES.find(a => a.key === primary.archetype).label;
    reason = `${label}: ${primary.conditions.map(describe).join(', ')}`;
  } else {
    reason = `${DEFAULT_ARCHETYPE.label}: no archetype rule matched`;
  }

  return {
    archetype: primary?.archetype ?? DEFAULT_ARCHETYPE.key,
    secondary_archetype: matches[1]?.archetype ?? null,
    rule_trace: { sample, rules, reason },
  };
}

const PROFILES_SQL = 'SELECT * FROM player_season_profiles WHERE season = ? ORDER BY player_key';
const INSERT_SQL = `INSERT INTO player_archetypes (season, player_key, archetype, secondary_archetype, rule_trace)
  VALUES (@season, @player_key, @archetype, @secondary_archetype, @rule_trace)`;
const DELETE_SQL = 'DELETE FROM player_archetypes WHERE season = @season';

function countBy(rows) {
  const counts = Object.fromEntries(defaultConfig.ALL_ARCHETYPES.map(a => [a.key, 0]));
  for (const row of rows) counts[row.archetype] = (counts[row.archetype] || 0) + 1;
  return counts;
}

/**
 * Reclassify and replace every archetype for one season.
 * Returns { season, players, distribution: { [archetypeKey]: count } }.
 */
export async function refreshSeasonArchetypes(season) {
  const profiles = await db.all(PROFILES_SQL, season);
  const rows = profiles.map(p => {
    const result = classifyProfile(p);
    return { season, player_key: p.player_key, ...result, rule_trace: JSON.stringify(result.rule_trace) };
  });

  if (DATABASE_TYPE === 'azuresql') {
    await db.run(DELETE_SQL, { season });
    for (const row of rows) await db.run(INSERT_SQL, row);
  } else {
    const sqlite = db.sqliteDb;
    const insert = sqlite.prepare(INSERT_SQL);
    db.transaction(() => {
      sqlite.prepare(DELETE_SQL).run({ season });
      for (const row of rows) insert.run(row);
    })();
  }

  return { season, players: rows.length, distribution: countBy(rows) };
}

/** Refresh several seasons in order. */
export async function refreshArchetypes(seasons) {
  const results = [];
  for (const season of seasons) results.push(await refreshSeasonArchetypes(season));
  return results;
}

const PLAYERS_SQL = `
  SELECT a.season, a.player_key, a.archetype, a.secondary_archetype, a.rule_trace,
         p.player_name, p.team, p.position, p.games, p.minutes, p.minutes_pg,
         p.usg_pct, p.ast_pct, p.reb_pct, p.three_pa_rate, p.dk_fppm
  FROM player_archetypes a
  JOIN player_season_profiles p ON p.season = a.season AND p.player_key = a.player_key
  WHERE a.season = ?
  ORDER BY p.minutes DESC, a.player_key
`;

/**
 * Stored archetypes for a season with profile context, labels and the
 * per-archetype distribution (every archetype listed, zero counts included).
 */
export async function getPlayerArchetypes(season) {
  const labels = Object.fromEntries(defaultConfig.ALL_ARCHETYPES.map(a => [a.key, a.label]));
  const players = (await db.all(PLAYERS_SQL, season)).map(row => ({
    ...row,
    archetype_label: labels[row.archetype] ?? row.archetype,
    secondary_archetype_label: row.secondary_archetype ? (labels[row.secondary_archetype] ?? row.secondary_archetype) : null,
    rule_trace: row.rule_trace ? JSON.parse(row.rule_trace) : null,
  }));

  const counts = countBy(players);
  const distribution = Object.entries(counts).map(([archetype, count]) => ({
    archetype, label: labels[archetype] ?? archetype, count,
  }));

  return { season, players, distribution };
}
