#!/usr/bin/env node

/**
 * BUILD team_archetype_defense
 *
 * Recomputes how each defense performs against each archetype and G/F/C
 * position, relative to expectation, for each season from --from (default
 * 2024-25) through the current one. The nightly historical sync refreshes
 * the seasons it loads; run this after rebuilding archetypes
 * (scripts/build-player-archetypes.js) or to backfill past seasons.
 *
 * Usage:
 *   node scripts/build-archetype-defense.js [--from 2024-25] [--season 2026-27]
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
const { refreshDefense } = await import('../src/services/archetypeDefenseService.js');
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
  console.table(await refreshDefense(seasons));
} catch (error) {
  console.error('❌ Archetype defense build failed:', error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
