import db, { DATABASE_TYPE } from '../config/database.js';

class LineupModel {
  async create(lineupData) {
    if (DATABASE_TYPE === 'azuresql') {
      // Azure SQL: Use OUTPUT to get the inserted ID
      const result = await db.get(`
        INSERT INTO lineups (slate_id, name, total_salary, projected_points)
        OUTPUT INSERTED.id
        VALUES (@slateId, @name, @totalSalary, @projectedPoints)
      `, {
        slateId: lineupData.slateId,
        name: lineupData.name,
        totalSalary: lineupData.totalSalary,
        projectedPoints: lineupData.projectedPoints
      });
      return result?.id;
    } else {
      const result = await db.run(`
        INSERT INTO lineups (slate_id, name, total_salary, projected_points)
        VALUES (?, ?, ?, ?)
      `,
        lineupData.slateId,
        lineupData.name,
        lineupData.totalSalary,
        lineupData.projectedPoints
      );
      return result.lastInsertRowid;
    }
  }

  async addPlayers(lineupId, players) {
    if (DATABASE_TYPE === 'azuresql') {
      for (const player of players) {
        await db.run(`
          INSERT INTO lineup_players (lineup_id, player_id, position_slot)
          VALUES (@lineupId, @playerId, @positionSlot)
        `, {
          lineupId,
          playerId: player.playerId,
          positionSlot: player.positionSlot
        });
      }
    } else {
      const insertMany = db.transaction((playersData) => {
        for (const player of playersData) {
          db.run(`
            INSERT INTO lineup_players (lineup_id, player_id, position_slot)
            VALUES (?, ?, ?)
          `, lineupId, player.playerId, player.positionSlot);
        }
      });
      insertMany(players);
    }
  }

  async getAll(slateId = null) {
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

    return db.all(query, ...params);
  }

  async getById(id) {
    const lineup = await db.get(`SELECT * FROM lineups WHERE id = ?`, id);

    if (!lineup) return null;

    lineup.players = await db.all(`
      SELECT
        lp.position_slot,
        p.*
      FROM lineup_players lp
      JOIN players p ON lp.player_id = p.id
      WHERE lp.lineup_id = ?
      ORDER BY lp.position_slot
    `, id);

    return lineup;
  }

  async update(id, lineupData) {
    if (DATABASE_TYPE === 'azuresql') {
      return db.run(`
        UPDATE lineups
        SET name = @name, total_salary = @totalSalary, projected_points = @projectedPoints, updated_at = GETDATE()
        WHERE id = @id
      `, {
        name: lineupData.name,
        totalSalary: lineupData.totalSalary,
        projectedPoints: lineupData.projectedPoints,
        id
      });
    } else {
      return db.run(`
        UPDATE lineups
        SET name = ?, total_salary = ?, projected_points = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
        lineupData.name,
        lineupData.totalSalary,
        lineupData.projectedPoints,
        id
      );
    }
  }

  async delete(id) {
    return db.run(`DELETE FROM lineups WHERE id = ?`, id);
  }
}

export default new LineupModel();
