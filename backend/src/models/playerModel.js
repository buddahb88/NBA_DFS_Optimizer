import db from '../config/database.js';

class PlayerModel {
  createOrUpdate(playerData) {
    const stmt = db.prepare(`
      INSERT INTO players (
        slate_id, player_id, name, team, opponent, position,
        salary, projected_points, projected_minutes, value, value_gpp, game_info, injury_status,
        per, usage, rest_days, fpts_last3, fpts_last5, fpts_last7, fpts_last14,
        vegas_implied_total, vegas_spread, vegas_over_under, vegas_win_prob, rostership, headshot, raw_data
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slate_id, player_id) DO UPDATE SET
        name = excluded.name,
        team = excluded.team,
        opponent = excluded.opponent,
        position = excluded.position,
        salary = excluded.salary,
        projected_points = excluded.projected_points,
        projected_minutes = excluded.projected_minutes,
        value = excluded.value,
        value_gpp = excluded.value_gpp,
        game_info = excluded.game_info,
        injury_status = excluded.injury_status,
        per = excluded.per,
        usage = excluded.usage,
        rest_days = excluded.rest_days,
        fpts_last3 = excluded.fpts_last3,
        fpts_last5 = excluded.fpts_last5,
        fpts_last7 = excluded.fpts_last7,
        fpts_last14 = excluded.fpts_last14,
        vegas_implied_total = excluded.vegas_implied_total,
        vegas_spread = excluded.vegas_spread,
        vegas_over_under = excluded.vegas_over_under,
        vegas_win_prob = excluded.vegas_win_prob,
        rostership = excluded.rostership,
        headshot = excluded.headshot,
        raw_data = excluded.raw_data,
        updated_at = CURRENT_TIMESTAMP
    `);

    return stmt.run(
      playerData.slateId,
      playerData.playerId,
      playerData.name,
      playerData.team,
      playerData.opponent,
      playerData.position,
      playerData.salary,
      playerData.projectedPoints,
      playerData.projectedMinutes,
      playerData.value,
      playerData.valueGpp,
      playerData.gameInfo,
      playerData.injuryStatus,
      playerData.per,
      playerData.usage,
      playerData.restDays,
      playerData.fptsLast3,
      playerData.fptsLast5,
      playerData.fptsLast7,
      playerData.fptsLast14,
      playerData.vegasImpliedTotal,
      playerData.vegasSpread,
      playerData.vegasOverUnder,
      playerData.vegasWinProb,
      playerData.rostership,
      playerData.headshot,
      playerData.rawData
    );
  }

  bulkCreateOrUpdate(slateId, playersData) {
    // Remove any existing rows that have empty player_id for this slate (cleanup stale imports)
    const cleanupStmt = db.prepare(`DELETE FROM players WHERE slate_id = ? AND (player_id IS NULL OR player_id = '')`);
    cleanupStmt.run(slateId);

    // Prepare the statement once before the transaction
    const stmt = db.prepare(`
      INSERT INTO players (
        slate_id, player_id, name, team, opponent, position,
        salary, projected_points, projected_minutes, value, value_gpp, game_info, injury_status,
        per, usage, rest_days, fpts_last3, fpts_last5, fpts_last7, fpts_last14,
        vegas_implied_total, vegas_spread, vegas_over_under, vegas_win_prob, rostership, headshot,
        dvp_rank, opp_def_eff, raw_data
      )
      VALUES (@slateId, @playerId, @name, @team, @opponent, @position, @salary, @projectedPoints, @projectedMinutes, @value, @valueGpp, @gameInfo, @injuryStatus, @per, @usage, @restDays, @fptsLast3, @fptsLast5, @fptsLast7, @fptsLast14, @vegasImpliedTotal, @vegasSpread, @vegasOverUnder, @vegasWinProb, @rostership, @headshot, @dvpRank, @oppDefEff, @rawData)
      ON CONFLICT(slate_id, player_id) DO UPDATE SET
        name = excluded.name,
        team = excluded.team,
        opponent = excluded.opponent,
        position = excluded.position,
        salary = excluded.salary,
        projected_points = excluded.projected_points,
        projected_minutes = excluded.projected_minutes,
        value = excluded.value,
        value_gpp = excluded.value_gpp,
        game_info = excluded.game_info,
        injury_status = excluded.injury_status,
        per = excluded.per,
        usage = excluded.usage,
        rest_days = excluded.rest_days,
        fpts_last3 = excluded.fpts_last3,
        fpts_last5 = excluded.fpts_last5,
        fpts_last7 = excluded.fpts_last7,
        fpts_last14 = excluded.fpts_last14,
        vegas_implied_total = excluded.vegas_implied_total,
        vegas_spread = excluded.vegas_spread,
        vegas_over_under = excluded.vegas_over_under,
        vegas_win_prob = excluded.vegas_win_prob,
        rostership = excluded.rostership,
        headshot = excluded.headshot,
        dvp_rank = excluded.dvp_rank,
        opp_def_eff = excluded.opp_def_eff,
        raw_data = excluded.raw_data,
        updated_at = CURRENT_TIMESTAMP
    `);

    // Use named parameters with transaction
    const insertMany = db.transaction((players) => {
      for (const player of players) {
        // ensure playerId is a string and not empty; skip otherwise
        const pid = player.playerId != null ? String(player.playerId).trim() : '';
        if (!pid) continue;

        stmt.run({
          slateId,
          playerId: pid,
          name: player.name,
          team: player.team,
          opponent: player.opponent,
          position: player.position,
          salary: player.salary,
          projectedPoints: player.projectedPoints,
          projectedMinutes: player.projectedMinutes || 0,
          value: player.value,
          valueGpp: player.valueGpp,
          gameInfo: player.gameInfo,
          per: player.per || 0,
          usage: player.usage || 0,
          restDays: player.restDays || 1,
          fptsLast3: player.fptsLast3 || 0,
          fptsLast5: player.fptsLast5 || 0,
          fptsLast7: player.fptsLast7 || 0,
          fptsLast14: player.fptsLast14 || 0,
          vegasImpliedTotal: player.vegasImpliedTotal || 0,
          vegasSpread: player.vegasSpread || 0,
          vegasOverUnder: player.vegasOverUnder || 0,
          vegasWinProb: player.vegasWinProb || 0,
          rostership: player.rostership || 0,
          headshot: player.headshot || null,
          dvpRank: player.dvpRank || null,
          oppDefEff: player.oppDefEff || null,
          injuryStatus: player.injuryStatus,
          rawData: player.rawData
        });
      }
    });

    insertMany(playersData);
  }

  getBySlateId(slateId, filters = {}) {
    let query = `SELECT * FROM players WHERE slate_id = ? AND projected_points > 0`;
    const params = [slateId];

    if (filters.position) {
      query += ` AND position LIKE ?`;
      params.push(`%${filters.position}%`);
    }

    if (filters.minSalary) {
      query += ` AND salary >= ?`;
      params.push(filters.minSalary);
    }

    if (filters.maxSalary) {
      query += ` AND salary <= ?`;
      params.push(filters.maxSalary);
    }

    if (filters.team) {
      query += ` AND team = ?`;
      params.push(filters.team);
    }

    // Default sort by value (best value picks first)
    query += ` ORDER BY value DESC, projected_points DESC`;

    const stmt = db.prepare(query);
    return stmt.all(...params);
  }

  getById(id) {
    const stmt = db.prepare(`SELECT * FROM players WHERE id = ?`);
    return stmt.get(id);
  }

  deleteBySlateId(slateId) {
    const stmt = db.prepare(`DELETE FROM players WHERE slate_id = ?`);
    return stmt.run(slateId);
  }

  deleteAll() {
    const stmt = db.prepare(`DELETE FROM players`);
    return stmt.run();
  }
}

export default new PlayerModel();
