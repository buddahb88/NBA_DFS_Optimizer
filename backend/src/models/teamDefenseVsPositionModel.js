import db from '../config/database.js';

class TeamDefenseVsPositionModel {
  bulkUpsert(defenseData) {
    const stmt = db.prepare(`
      INSERT INTO team_defense_vs_position (
        team, position, rank, pts_allowed, fg_pct_allowed, tpm_allowed,
        reb_allowed, ast_allowed, stl_allowed, blk_allowed, to_allowed, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(team, position) DO UPDATE SET
        rank = excluded.rank,
        pts_allowed = excluded.pts_allowed,
        fg_pct_allowed = excluded.fg_pct_allowed,
        tpm_allowed = excluded.tpm_allowed,
        reb_allowed = excluded.reb_allowed,
        ast_allowed = excluded.ast_allowed,
        stl_allowed = excluded.stl_allowed,
        blk_allowed = excluded.blk_allowed,
        to_allowed = excluded.to_allowed,
        updated_at = CURRENT_TIMESTAMP
    `);

    const insertMany = db.transaction((defenseData) => {
      for (const data of defenseData) {
        stmt.run(
          data.team,
          data.position,
          data.rank,
          data.ptsAllowed || null,
          data.fgPctAllowed || null,
          data.tpmAllowed || null,
          data.rebAllowed || null,
          data.astAllowed || null,
          data.stlAllowed || null,
          data.blkAllowed || null,
          data.toAllowed || null
        );
      }
    });

    return insertMany(defenseData);
  }

  getByTeamAndPosition(team, position) {
    const stmt = db.prepare(`
      SELECT * FROM team_defense_vs_position
      WHERE team = ? AND position = ?
    `);
    return stmt.get(team, position);
  }

  getByTeam(team) {
    const stmt = db.prepare(`
      SELECT * FROM team_defense_vs_position
      WHERE team = ?
      ORDER BY position
    `);
    return stmt.all(team);
  }

  getAll() {
    const stmt = db.prepare(`
      SELECT * FROM team_defense_vs_position
      ORDER BY position, rank
    `);
    return stmt.all();
  }

  deleteAll() {
    const stmt = db.prepare(`DELETE FROM team_defense_vs_position`);
    return stmt.run();
  }
}

export default new TeamDefenseVsPositionModel();
