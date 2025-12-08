import db, { DATABASE_TYPE } from '../config/database.js';

class SlateModel {
  async createOrUpdate(slateData) {
    if (DATABASE_TYPE === 'azuresql') {
      // Azure SQL: Use MERGE for upsert
      return db.run(`
        MERGE INTO slates AS target
        USING (SELECT @slateId AS slate_id, @name AS name, @sport AS sport, @startTime AS start_time) AS source
        ON target.slate_id = source.slate_id
        WHEN MATCHED THEN
          UPDATE SET name = source.name, start_time = source.start_time, updated_at = GETDATE()
        WHEN NOT MATCHED THEN
          INSERT (slate_id, name, sport, start_time) VALUES (source.slate_id, source.name, source.sport, source.start_time);
      `, {
        slateId: slateData.slateId,
        name: slateData.name,
        sport: slateData.sport || 'NBA',
        startTime: slateData.startTime
      });
    } else {
      // SQLite: Use ON CONFLICT
      return db.run(`
        INSERT INTO slates (slate_id, name, sport, start_time)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(slate_id) DO UPDATE SET
          name = excluded.name,
          start_time = excluded.start_time,
          updated_at = CURRENT_TIMESTAMP
      `, slateData.slateId, slateData.name, slateData.sport || 'NBA', slateData.startTime);
    }
  }

  async getAll() {
    return db.all(`SELECT * FROM slates ORDER BY created_at DESC`);
  }

  async getById(slateId) {
    return db.get(`SELECT * FROM slates WHERE slate_id = ?`, slateId);
  }

  async delete(slateId) {
    return db.run(`DELETE FROM slates WHERE slate_id = ?`, slateId);
  }

  async deleteAll() {
    return db.run(`DELETE FROM slates`);
  }
}

export default new SlateModel();
