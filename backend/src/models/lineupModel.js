import db from '../config/database.js';

class LineupModel {
  create(lineupData) {
    const stmt = db.prepare(`
      INSERT INTO lineups (slate_id, name, total_salary, projected_points)
      VALUES (?, ?, ?, ?)
    `);

    const result = stmt.run(
      lineupData.slateId,
      lineupData.name,
      lineupData.totalSalary,
      lineupData.projectedPoints
    );

    return result.lastInsertRowid;
  }

  addPlayers(lineupId, players) {
    const insertPlayer = db.prepare(`
      INSERT INTO lineup_players (lineup_id, player_id, position_slot)
      VALUES (?, ?, ?)
    `);

    const insertMany = db.transaction((playersData) => {
      for (const player of playersData) {
        insertPlayer.run(lineupId, player.playerId, player.positionSlot);
      }
    });

    insertMany(players);
  }

  getAll(slateId = null) {
    let query = `
      SELECT
        l.*,
        COUNT(lp.id) as player_count
      FROM lineups l
      LEFT JOIN lineup_players lp ON l.id = lp.lineup_id
    `;

    const params = [];
    if (slateId) {
      query += ` WHERE l.slate_id = ?`;
      params.push(slateId);
    }

    query += ` GROUP BY l.id ORDER BY l.created_at DESC`;

    const stmt = db.prepare(query);
    return stmt.all(...params);
  }

  getById(id) {
    const lineupStmt = db.prepare(`SELECT * FROM lineups WHERE id = ?`);
    const lineup = lineupStmt.get(id);

    if (!lineup) return null;

    const playersStmt = db.prepare(`
      SELECT
        lp.position_slot,
        p.*
      FROM lineup_players lp
      JOIN players p ON lp.player_id = p.id
      WHERE lp.lineup_id = ?
      ORDER BY lp.position_slot
    `);

    lineup.players = playersStmt.all(id);
    return lineup;
  }

  update(id, lineupData) {
    const stmt = db.prepare(`
      UPDATE lineups
      SET name = ?, total_salary = ?, projected_points = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    return stmt.run(
      lineupData.name,
      lineupData.totalSalary,
      lineupData.projectedPoints,
      id
    );
  }

  delete(id) {
    const stmt = db.prepare(`DELETE FROM lineups WHERE id = ?`);
    return stmt.run(id);
  }
}

export default new LineupModel();
