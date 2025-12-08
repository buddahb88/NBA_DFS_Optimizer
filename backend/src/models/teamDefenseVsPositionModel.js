import db, { DATABASE_TYPE } from '../config/database.js';

class TeamDefenseVsPositionModel {
  async bulkUpsert(defenseData) {
    if (DATABASE_TYPE === 'azuresql') {
      for (const data of defenseData) {
        await db.run(`
          MERGE INTO team_defense_vs_position AS target
          USING (SELECT @team AS team, @position AS position) AS source
          ON target.team = source.team AND target.position = source.position
          WHEN MATCHED THEN
            UPDATE SET rank = @rank, pts_allowed = @ptsAllowed, fg_pct_allowed = @fgPctAllowed,
              tpm_allowed = @tpmAllowed, reb_allowed = @rebAllowed, ast_allowed = @astAllowed,
              stl_allowed = @stlAllowed, blk_allowed = @blkAllowed, to_allowed = @toAllowed,
              updated_at = GETDATE()
          WHEN NOT MATCHED THEN
            INSERT (team, position, rank, pts_allowed, fg_pct_allowed, tpm_allowed,
              reb_allowed, ast_allowed, stl_allowed, blk_allowed, to_allowed)
            VALUES (@team, @position, @rank, @ptsAllowed, @fgPctAllowed, @tpmAllowed,
              @rebAllowed, @astAllowed, @stlAllowed, @blkAllowed, @toAllowed);
        `, {
          team: data.team,
          position: data.position,
          rank: data.rank,
          ptsAllowed: data.ptsAllowed || null,
          fgPctAllowed: data.fgPctAllowed || null,
          tpmAllowed: data.tpmAllowed || null,
          rebAllowed: data.rebAllowed || null,
          astAllowed: data.astAllowed || null,
          stlAllowed: data.stlAllowed || null,
          blkAllowed: data.blkAllowed || null,
          toAllowed: data.toAllowed || null
        });
      }
    } else {
      const insertMany = db.transaction((defData) => {
        for (const data of defData) {
          db.run(`
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
          `,
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
      insertMany(defenseData);
    }
  }

  async getByTeamAndPosition(team, position) {
    return db.get(`
      SELECT * FROM team_defense_vs_position
      WHERE team = ? AND position = ?
    `, team, position);
  }

  async getByTeam(team) {
    return db.all(`
      SELECT * FROM team_defense_vs_position
      WHERE team = ?
      ORDER BY position
    `, team);
  }

  async getAll() {
    return db.all(`
      SELECT * FROM team_defense_vs_position
      ORDER BY position, rank
    `);
  }

  async deleteAll() {
    return db.run(`DELETE FROM team_defense_vs_position`);
  }
}

export default new TeamDefenseVsPositionModel();
