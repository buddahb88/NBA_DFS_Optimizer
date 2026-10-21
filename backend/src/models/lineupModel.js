import db, { DATABASE_TYPE } from '../config/database.js';
import { playerKey } from '../utils/playerKey.js';

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

  // Stores each player as saved alongside players.id, so the lineup survives
  // a slate resync deleting and re-inserting the players rows
  async addPlayers(lineupId, players) {
    const rows = [];
    for (const player of players) {
      const p = (await db.get(`SELECT * FROM players WHERE id = ?`, player.playerId)) || {};
      rows.push([
        lineupId, player.playerId, player.positionSlot,
        p.player_id ?? null, p.site_player_id ?? null, p.name ? playerKey(p.name) : null, p.name ?? null,
        p.team ?? null, p.opponent ?? null, p.position ?? null, p.roster_positions ?? null,
        p.salary ?? null, p.projected_points ?? null
      ]);
    }

    const insert = `
      INSERT INTO lineup_players (lineup_id, player_id, position_slot, player_external_id, site_player_id,
        player_key, name, team, opponent, position, roster_positions, salary, projected_points)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    if (DATABASE_TYPE === 'azuresql') {
      for (const row of rows) {
        await db.run(insert, ...row);
      }
    } else {
      const insertMany = db.transaction((rowsData) => {
        for (const row of rowsData) {
          db.run(insert, ...row);
        }
      });
      insertMany(rows);
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

    // Live players row when the player is still on the slate (matched by the
    // stable players.player_id; players.id changes on every resync), else the
    // details saved with the lineup
    lineup.players = await db.all(`
      SELECT
        lp.position_slot,
        COALESCE(p.id, lp.player_id) AS id,
        COALESCE(p.slate_id, ?) AS slate_id,
        COALESCE(p.player_id, lp.player_external_id) AS player_id,
        COALESCE(p.site_player_id, lp.site_player_id) AS site_player_id,
        lp.player_key,
        COALESCE(p.name, lp.name) AS name,
        COALESCE(p.team, lp.team) AS team,
        COALESCE(p.opponent, lp.opponent) AS opponent,
        COALESCE(p.position, lp.position) AS position,
        COALESCE(p.roster_positions, lp.roster_positions) AS roster_positions,
        COALESCE(p.salary, lp.salary) AS salary,
        COALESCE(p.projected_points, lp.projected_points) AS projected_points,
        p.projected_minutes, p.floor, p.ceiling, p.rostership, p.injury_status, p.game_info, p.headshot,
        CASE WHEN p.id IS NULL THEN 0 ELSE 1 END AS on_slate
      FROM lineup_players lp
      LEFT JOIN players p ON p.id = (
        SELECT MIN(p2.id) FROM players p2
        WHERE (lp.player_external_id IS NOT NULL AND p2.slate_id = ? AND p2.player_id = lp.player_external_id)
           OR (lp.player_external_id IS NULL AND p2.id = lp.player_id)
      )
      WHERE lp.lineup_id = ?
      ORDER BY lp.position_slot
    `, lineup.slate_id, lineup.slate_id, id);

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
