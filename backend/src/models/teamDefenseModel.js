import db, { DATABASE_TYPE } from '../config/database.js';

class TeamDefenseModel {
  async bulkUpsert(teams) {
    if (DATABASE_TYPE === 'azuresql') {
      for (const team of teams) {
        await db.run(`
          MERGE INTO team_defense_rankings AS target
          USING (SELECT @team AS team) AS source
          ON target.team = source.team
          WHEN MATCHED THEN
            UPDATE SET def_eff = @defEff, off_eff = @offEff, pace = @pace,
              ast_ratio = @astRatio, to_ratio = @toRatio, rebr = @rebr,
              eff_fg_pct = @effFgPct, ts_pct = @tsPct, updated_at = GETDATE()
          WHEN NOT MATCHED THEN
            INSERT (team, def_eff, off_eff, pace, ast_ratio, to_ratio, rebr, eff_fg_pct, ts_pct)
            VALUES (@team, @defEff, @offEff, @pace, @astRatio, @toRatio, @rebr, @effFgPct, @tsPct);
        `, {
          team: team.team,
          defEff: team.defEff,
          offEff: team.offEff || null,
          pace: team.pace || null,
          astRatio: team.astRatio || null,
          toRatio: team.toRatio || null,
          rebr: team.rebr || null,
          effFgPct: team.effFgPct || null,
          tsPct: team.tsPct || null
        });
      }
    } else {
      const insertMany = db.transaction((teamsData) => {
        for (const team of teamsData) {
          db.run(`
            INSERT INTO team_defense_rankings (
              team, def_eff, off_eff, pace, ast_ratio, to_ratio, rebr, eff_fg_pct, ts_pct, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(team) DO UPDATE SET
              def_eff = excluded.def_eff,
              off_eff = excluded.off_eff,
              pace = excluded.pace,
              ast_ratio = excluded.ast_ratio,
              to_ratio = excluded.to_ratio,
              rebr = excluded.rebr,
              eff_fg_pct = excluded.eff_fg_pct,
              ts_pct = excluded.ts_pct,
              updated_at = CURRENT_TIMESTAMP
          `,
            team.team,
            team.defEff,
            team.offEff || null,
            team.pace || null,
            team.astRatio || null,
            team.toRatio || null,
            team.rebr || null,
            team.effFgPct || null,
            team.tsPct || null
          );
        }
      });
      insertMany(teams);
    }
  }

  async getByTeam(team) {
    return db.get(`SELECT * FROM team_defense_rankings WHERE team = ?`, team);
  }

  async getAll() {
    return db.all(`SELECT * FROM team_defense_rankings ORDER BY def_eff ASC`);
  }

  async deleteAll() {
    return db.run(`DELETE FROM team_defense_rankings`);
  }
}

export default new TeamDefenseModel();
