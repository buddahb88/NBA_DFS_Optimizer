import db from '../config/database.js';

class TeamDefenseModel {
  bulkUpsert(teams) {
    const stmt = db.prepare(`
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
    `);

    const insertMany = db.transaction((teams) => {
      for (const team of teams) {
        stmt.run(
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

    return insertMany(teams);
  }

  getByTeam(team) {
    const stmt = db.prepare(`SELECT * FROM team_defense_rankings WHERE team = ?`);
    return stmt.get(team);
  }

  getAll() {
    const stmt = db.prepare(`SELECT * FROM team_defense_rankings ORDER BY def_eff ASC`);
    return stmt.all();
  }

  deleteAll() {
    const stmt = db.prepare(`DELETE FROM team_defense_rankings`);
    return stmt.run();
  }
}

export default new TeamDefenseModel();
