#!/usr/bin/env node

/**
 * CLASSIFY player_season_profiles INTO ARCHETYPES
 *
 * Re-runs the rules in src/config/archetypes.js over every profile for each
 * season from --from (default 2024-25) through the current one, replaces
 * that season's player_archetypes rows and prints the distribution.
 * Run after scripts/build-player-profiles.js (which also calls this step).
 *
 * Usage:
 *   node scripts/build-player-archetypes.js [--from 2024-25] [--season 2026-27]
 *
 * Works with SQLite (default) or Azure SQL (DATABASE_TYPE=azuresql in backend/.env).
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load env before the database module reads DATABASE_TYPE
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: db } = await import('../src/config/database.js');
const { createTables } = await import('../src/config/schema.js');
const { refreshArchetypes } = await import('../src/services/archetypeService.js');
const { ALL_ARCHETYPES } = await import('../src/config/archetypes.js');
const { FIRST_PROFILE_SEASON } = await import('../src/services/playerProfileService.js');
const { listSeasons } = await import('../src/utils/season.js');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const only = arg('season');
const seasons = only ? [only] : listSeasons(arg('from') || FIRST_PROFILE_SEASON).reverse();

try {
  await createTables(db);

  const results = await refreshArchetypes(seasons);
  console.log('\nArchetype distribution by season:');
  console.table(ALL_ARCHETYPES.map(a => ({
    archetype: a.label,
    ...Object.fromEntries(results.map(r => [r.season, r.distribution[a.key] ?? 0])),
  })));
} catch (error) {
  console.error('❌ Archetype build failed:', error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
