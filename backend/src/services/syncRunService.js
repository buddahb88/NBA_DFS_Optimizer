/**
 * SYNC RUN SERVICE
 *
 * historical_games sync history in sync_runs (config/syncRunMigrations.js).
 * The unfinished run, if any, is the sync in progress: manual syncs
 * (routes/historical.js) and the scheduled sync share it as their lock.
 */

import db, { DATABASE_TYPE } from '../config/database.js';
import { clearOpportunityCache } from './opportunity/metricsService.js';

const COLUMNS = 'id, source, season, started_at, finished_at, games_inserted, error';

/** sqlite stores ISO strings; Azure SQL takes and returns Date objects */
const timestamp = () => (DATABASE_TYPE === 'azuresql' ? new Date() : new Date().toISOString());
const isoString = value => (value instanceof Date ? value.toISOString() : value ?? null);

function toRun(row) {
  if (!row) return null;
  return { ...row, started_at: isoString(row.started_at), finished_at: isoString(row.finished_at) };
}

class SyncRunService {
  /** Record a new run; returns its id */
  async start({ source, season = null }) {
    const params = { source, season, started_at: timestamp() };
    if (DATABASE_TYPE === 'azuresql') {
      const row = await db.get(`
        INSERT INTO sync_runs (source, season, started_at, games_inserted)
        OUTPUT INSERTED.id
        VALUES (@source, @season, @started_at, 0)
      `, params);
      return row?.id;
    }
    const result = await db.run(
      `INSERT INTO sync_runs (source, season, started_at, games_inserted) VALUES (@source, @season, @started_at, 0)`,
      params);
    return Number(result.lastInsertRowid);
  }

  async progress(id, gamesInserted) {
    await db.run(`UPDATE sync_runs SET games_inserted = @games WHERE id = @id`, { id, games: gamesInserted });
  }

  async finish(id, { gamesInserted = 0, error = null } = {}) {
    // New box scores change every cached opportunity metric on or after them
    clearOpportunityCache();
    await db.run(
      `UPDATE sync_runs SET finished_at = @finished_at, games_inserted = @games, error = @error WHERE id = @id`,
      { id, finished_at: timestamp(), games: gamesInserted, error });
  }

  /** The run in progress, or null */
  async active() {
    const top = DATABASE_TYPE === 'azuresql' ? 'TOP 1' : '';
    const limit = DATABASE_TYPE === 'azuresql' ? '' : 'LIMIT 1';
    return toRun(await db.get(`SELECT ${top} ${COLUMNS} FROM sync_runs WHERE finished_at IS NULL ORDER BY id DESC ${limit}`));
  }

  async latest() {
    return (await this.recent(1))[0] || null;
  }

  /** Most recent runs, newest first */
  async recent(limit = 10) {
    const n = Math.max(1, Math.trunc(limit) || 10);
    const rows = DATABASE_TYPE === 'azuresql'
      ? await db.all(`SELECT TOP ${n} ${COLUMNS} FROM sync_runs ORDER BY id DESC`)
      : await db.all(`SELECT ${COLUMNS} FROM sync_runs ORDER BY id DESC LIMIT ${n}`);
    return rows.map(toRun);
  }

  /** Close runs left open by a crash or restart, so they no longer hold the lock */
  async failInterrupted() {
    const { changes } = await db.run(
      `UPDATE sync_runs SET finished_at = @finished_at, error = @error WHERE finished_at IS NULL`,
      { finished_at: timestamp(), error: 'interrupted (server restarted before the sync finished)' });
    return changes;
  }

  /** sync_runs.error for a sync's failed dates/games, or null if none failed */
  failureSummary(failed = []) {
    if (!failed.length) return null;
    const [first] = failed;
    return `${failed.length} failed (first: ${first.game_date} ${first.game_id ?? 'scoreboard'}: ${first.error})`;
  }

  /** /api/historical/sync/status progress for a run */
  toProgress(run) {
    if (!run) return null;
    const status = !run.finished_at ? 'syncing' : run.error ? 'error' : 'complete';
    const end = run.finished_at ? new Date(run.finished_at) : new Date();
    const elapsed = ((end - new Date(run.started_at)) / 1000).toFixed(1);
    const label = run.season ? `${run.source} ${run.season}` : run.source;
    const message = status === 'syncing'
      ? `Syncing ${label}: ${run.games_inserted || 0} games so far`
      : `Synced ${run.games_inserted || 0} games (${label}) in ${elapsed}s` + (run.error ? `: ${run.error}` : '');
    return {
      status,
      mode: run.source,
      season: run.season,
      games: run.games_inserted || 0,
      error: run.error,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      elapsed,
      message,
    };
  }
}

export default new SyncRunService();
