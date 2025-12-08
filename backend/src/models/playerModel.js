import db, { DATABASE_TYPE } from '../config/database.js';

class PlayerModel {
  async createOrUpdate(playerData) {
    if (DATABASE_TYPE === 'azuresql') {
      return db.run(`
        MERGE INTO players AS target
        USING (SELECT @slateId AS slate_id, @playerId AS player_id) AS source
        ON target.slate_id = source.slate_id AND target.player_id = source.player_id
        WHEN MATCHED THEN
          UPDATE SET name = @name, team = @team, opponent = @opponent, position = @position,
            salary = @salary, projected_points = @projectedPoints, projected_minutes = @projectedMinutes,
            value = @value, value_gpp = @valueGpp, game_info = @gameInfo, injury_status = @injuryStatus,
            per = @per, [usage] = @usage, rest_days = @restDays, fpts_last3 = @fptsLast3,
            fpts_last5 = @fptsLast5, fpts_last7 = @fptsLast7, fpts_last14 = @fptsLast14,
            vegas_implied_total = @vegasImpliedTotal, vegas_spread = @vegasSpread,
            vegas_over_under = @vegasOverUnder, vegas_win_prob = @vegasWinProb,
            rostership = @rostership, headshot = @headshot, raw_data = @rawData, updated_at = GETDATE()
        WHEN NOT MATCHED THEN
          INSERT (slate_id, player_id, name, team, opponent, position, salary, projected_points,
            projected_minutes, value, value_gpp, game_info, injury_status, per, [usage], rest_days,
            fpts_last3, fpts_last5, fpts_last7, fpts_last14, vegas_implied_total, vegas_spread,
            vegas_over_under, vegas_win_prob, rostership, headshot, raw_data)
          VALUES (@slateId, @playerId, @name, @team, @opponent, @position, @salary, @projectedPoints,
            @projectedMinutes, @value, @valueGpp, @gameInfo, @injuryStatus, @per, @usage, @restDays,
            @fptsLast3, @fptsLast5, @fptsLast7, @fptsLast14, @vegasImpliedTotal, @vegasSpread,
            @vegasOverUnder, @vegasWinProb, @rostership, @headshot, @rawData);
      `, {
        slateId: playerData.slateId,
        playerId: playerData.playerId,
        name: playerData.name,
        team: playerData.team,
        opponent: playerData.opponent,
        position: playerData.position,
        salary: playerData.salary,
        projectedPoints: playerData.projectedPoints,
        projectedMinutes: playerData.projectedMinutes,
        value: playerData.value,
        valueGpp: playerData.valueGpp,
        gameInfo: playerData.gameInfo,
        injuryStatus: playerData.injuryStatus,
        per: playerData.per,
        usage: playerData.usage,
        restDays: playerData.restDays,
        fptsLast3: playerData.fptsLast3,
        fptsLast5: playerData.fptsLast5,
        fptsLast7: playerData.fptsLast7,
        fptsLast14: playerData.fptsLast14,
        vegasImpliedTotal: playerData.vegasImpliedTotal,
        vegasSpread: playerData.vegasSpread,
        vegasOverUnder: playerData.vegasOverUnder,
        vegasWinProb: playerData.vegasWinProb,
        rostership: playerData.rostership,
        headshot: playerData.headshot,
        rawData: playerData.rawData
      });
    } else {
      return db.run(`
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
      `,
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
  }

  async bulkCreateOrUpdate(slateId, playersData) {
    // Remove any existing rows that have empty player_id for this slate (cleanup stale imports)
    await db.run(`DELETE FROM players WHERE slate_id = ? AND (player_id IS NULL OR player_id = '')`, slateId);

    if (DATABASE_TYPE === 'azuresql') {
      // Azure SQL: Insert each player individually with MERGE
      for (const player of playersData) {
        const pid = player.playerId != null ? String(player.playerId).trim() : '';
        if (!pid) continue;

        await db.run(`
          MERGE INTO players AS target
          USING (SELECT @slateId AS slate_id, @playerId AS player_id) AS source
          ON target.slate_id = source.slate_id AND target.player_id = source.player_id
          WHEN MATCHED THEN
            UPDATE SET name = @name, team = @team, opponent = @opponent, position = @position,
              salary = @salary, projected_points = @projectedPoints, projected_minutes = @projectedMinutes,
              value = @value, value_gpp = @valueGpp, game_info = @gameInfo, injury_status = @injuryStatus,
              per = @per, [usage] = @usage, rest_days = @restDays, fpts_last3 = @fptsLast3,
              fpts_last5 = @fptsLast5, fpts_last7 = @fptsLast7, fpts_last14 = @fptsLast14,
              vegas_implied_total = @vegasImpliedTotal, vegas_spread = @vegasSpread,
              vegas_over_under = @vegasOverUnder, vegas_win_prob = @vegasWinProb,
              rostership = @rostership, headshot = @headshot, dvp_pts_allowed = @dvpPtsAllowed,
              opp_def_eff = @oppDefEff, floor = @floor, ceiling = @ceiling, volatility = @volatility,
              boom_probability = @boomProbability, bust_probability = @bustProbability, fppm = @fppm,
              leverage_score = @leverageScore, blowout_risk = @blowoutRisk, std_dev = @stdDev,
              raw_data = @rawData, updated_at = GETDATE()
          WHEN NOT MATCHED THEN
            INSERT (slate_id, player_id, name, team, opponent, position, salary, projected_points,
              projected_minutes, value, value_gpp, game_info, injury_status, per, [usage], rest_days,
              fpts_last3, fpts_last5, fpts_last7, fpts_last14, vegas_implied_total, vegas_spread,
              vegas_over_under, vegas_win_prob, rostership, headshot, dvp_pts_allowed, opp_def_eff,
              floor, ceiling, volatility, boom_probability, bust_probability, fppm, leverage_score,
              blowout_risk, std_dev, raw_data)
            VALUES (@slateId, @playerId, @name, @team, @opponent, @position, @salary, @projectedPoints,
              @projectedMinutes, @value, @valueGpp, @gameInfo, @injuryStatus, @per, @usage, @restDays,
              @fptsLast3, @fptsLast5, @fptsLast7, @fptsLast14, @vegasImpliedTotal, @vegasSpread,
              @vegasOverUnder, @vegasWinProb, @rostership, @headshot, @dvpPtsAllowed, @oppDefEff,
              @floor, @ceiling, @volatility, @boomProbability, @bustProbability, @fppm, @leverageScore,
              @blowoutRisk, @stdDev, @rawData);
        `, {
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
          injuryStatus: player.injuryStatus,
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
          dvpPtsAllowed: player.dvpPtsAllowed || null,
          oppDefEff: player.oppDefEff || null,
          floor: player.floor || 0,
          ceiling: player.ceiling || 0,
          volatility: player.volatility || 0,
          boomProbability: player.boomProbability || 0,
          bustProbability: player.bustProbability || 0,
          fppm: player.fppm || 0,
          leverageScore: player.leverageScore || 0,
          blowoutRisk: player.blowoutRisk || 0,
          stdDev: player.stdDev || 0,
          rawData: player.rawData
        });
      }
    } else {
      // SQLite: Use transaction for bulk insert
      const insertMany = db.transaction((players) => {
        for (const player of players) {
          const pid = player.playerId != null ? String(player.playerId).trim() : '';
          if (!pid) continue;

          db.run(`
            INSERT INTO players (
              slate_id, player_id, name, team, opponent, position,
              salary, projected_points, projected_minutes, value, value_gpp, game_info, injury_status,
              per, usage, rest_days, fpts_last3, fpts_last5, fpts_last7, fpts_last14,
              vegas_implied_total, vegas_spread, vegas_over_under, vegas_win_prob, rostership, headshot,
              dvp_pts_allowed, opp_def_eff,
              floor, ceiling, volatility, boom_probability, bust_probability, fppm, leverage_score, blowout_risk, std_dev,
              raw_data
            )
            VALUES (@slateId, @playerId, @name, @team, @opponent, @position, @salary, @projectedPoints, @projectedMinutes, @value, @valueGpp, @gameInfo, @injuryStatus, @per, @usage, @restDays, @fptsLast3, @fptsLast5, @fptsLast7, @fptsLast14, @vegasImpliedTotal, @vegasSpread, @vegasOverUnder, @vegasWinProb, @rostership, @headshot, @dvpPtsAllowed, @oppDefEff, @floor, @ceiling, @volatility, @boomProbability, @bustProbability, @fppm, @leverageScore, @blowoutRisk, @stdDev, @rawData)
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
              dvp_pts_allowed = excluded.dvp_pts_allowed,
              opp_def_eff = excluded.opp_def_eff,
              floor = excluded.floor,
              ceiling = excluded.ceiling,
              volatility = excluded.volatility,
              boom_probability = excluded.boom_probability,
              bust_probability = excluded.bust_probability,
              fppm = excluded.fppm,
              leverage_score = excluded.leverage_score,
              blowout_risk = excluded.blowout_risk,
              std_dev = excluded.std_dev,
              raw_data = excluded.raw_data,
              updated_at = CURRENT_TIMESTAMP
          `, {
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
            injuryStatus: player.injuryStatus,
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
            dvpPtsAllowed: player.dvpPtsAllowed || null,
            oppDefEff: player.oppDefEff || null,
            floor: player.floor || 0,
            ceiling: player.ceiling || 0,
            volatility: player.volatility || 0,
            boomProbability: player.boomProbability || 0,
            bustProbability: player.bustProbability || 0,
            fppm: player.fppm || 0,
            leverageScore: player.leverageScore || 0,
            blowoutRisk: player.blowoutRisk || 0,
            stdDev: player.stdDev || 0,
            rawData: player.rawData
          });
        }
      });

      insertMany(playersData);
    }
  }

  async getBySlateId(slateId, filters = {}) {
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

    query += ` ORDER BY value DESC, projected_points DESC`;

    return db.all(query, ...params);
  }

  async getById(id) {
    return db.get(`SELECT * FROM players WHERE id = ?`, id);
  }

  async deleteBySlateId(slateId) {
    return db.run(`DELETE FROM players WHERE slate_id = ?`, slateId);
  }

  async deleteAll() {
    return db.run(`DELETE FROM players`);
  }

  async updateProjection(slateId, playerId, projectionData) {
    if (DATABASE_TYPE === 'azuresql') {
      return db.run(`
        UPDATE players SET
          projected_points = @projectedPoints,
          rotowire_projection = COALESCE(rotowire_projection, projected_points),
          floor = @floor,
          ceiling = @ceiling,
          updated_at = GETDATE()
        WHERE slate_id = @slateId AND player_id = @playerId
      `, {
        projectedPoints: projectionData.adjusted_projection,
        floor: projectionData.floor || 0,
        ceiling: projectionData.ceiling || 0,
        slateId,
        playerId
      });
    } else {
      return db.run(`
        UPDATE players SET
          projected_points = ?,
          rotowire_projection = COALESCE(rotowire_projection, projected_points),
          floor = ?,
          ceiling = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE slate_id = ? AND player_id = ?
      `,
        projectionData.adjusted_projection,
        projectionData.floor || 0,
        projectionData.ceiling || 0,
        slateId,
        playerId
      );
    }
  }

  async bulkUpdateProjections(slateId, projections) {
    // First, save original projections as rotowire_projection if not already set
    if (DATABASE_TYPE === 'azuresql') {
      await db.run(`
        UPDATE players
        SET rotowire_projection = projected_points
        WHERE slate_id = @slateId AND rotowire_projection IS NULL
      `, { slateId });

      for (const proj of projections) {
        await db.run(`
          UPDATE players SET
            projected_points = @adjustedProjection,
            floor = @floor,
            ceiling = @ceiling,
            updated_at = GETDATE()
          WHERE slate_id = @slateId AND player_id = @playerId
        `, {
          adjustedProjection: proj.adjusted_projection,
          floor: proj.floor || 0,
          ceiling: proj.ceiling || 0,
          slateId,
          playerId: String(proj.player_id)
        });
      }
      return projections.length;
    } else {
      await db.run(`
        UPDATE players
        SET rotowire_projection = projected_points
        WHERE slate_id = ? AND rotowire_projection IS NULL
      `, slateId);

      const updateMany = db.transaction((projectionList) => {
        let updated = 0;
        for (const proj of projectionList) {
          const result = db.run(`
            UPDATE players SET
              projected_points = @adjustedProjection,
              floor = @floor,
              ceiling = @ceiling,
              updated_at = CURRENT_TIMESTAMP
            WHERE slate_id = @slateId AND player_id = @playerId
          `, {
            adjustedProjection: proj.adjusted_projection,
            floor: proj.floor || 0,
            ceiling: proj.ceiling || 0,
            slateId,
            playerId: String(proj.player_id)
          });
          if (result.changes > 0) updated++;
        }
        return updated;
      });

      return updateMany(projections);
    }
  }

  async getAllForProjections(slateId) {
    return db.all(`
      SELECT
        id,
        player_id,
        name,
        team,
        opponent,
        position,
        salary,
        projected_points,
        rotowire_projection,
        projected_minutes,
        rest_days,
        vegas_implied_total,
        vegas_spread,
        vegas_over_under,
        dvp_pts_allowed,
        opp_def_eff,
        rostership,
        floor,
        ceiling,
        volatility,
        std_dev
      FROM players
      WHERE slate_id = ?
    `, slateId);
  }

  async resetProjections(slateId) {
    if (DATABASE_TYPE === 'azuresql') {
      return db.run(`
        UPDATE players SET
          projected_points = COALESCE(rotowire_projection, projected_points),
          updated_at = GETDATE()
        WHERE slate_id = @slateId AND rotowire_projection IS NOT NULL
      `, { slateId });
    } else {
      return db.run(`
        UPDATE players SET
          projected_points = COALESCE(rotowire_projection, projected_points),
          updated_at = CURRENT_TIMESTAMP
        WHERE slate_id = ? AND rotowire_projection IS NOT NULL
      `, slateId);
    }
  }
}

export default new PlayerModel();
