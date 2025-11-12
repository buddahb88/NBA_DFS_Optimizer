import db from '../config/database.js';

class SlateModel {
  createOrUpdate(slateData) {
    const stmt = db.prepare(`
      INSERT INTO slates (slate_id, name, sport, start_time)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(slate_id) DO UPDATE SET
        name = excluded.name,
        start_time = excluded.start_time,
        updated_at = CURRENT_TIMESTAMP
    `);

    return stmt.run(
      slateData.slateId,
      slateData.name,
      slateData.sport || 'NBA',
      slateData.startTime
    );
  }

  getAll() {
    const stmt = db.prepare(`
      SELECT * FROM slates
      ORDER BY created_at DESC
    `);
    return stmt.all();
  }

  getById(slateId) {
    const stmt = db.prepare(`
      SELECT * FROM slates WHERE slate_id = ?
    `);
    return stmt.get(slateId);
  }

  delete(slateId) {
    const stmt = db.prepare(`
      DELETE FROM slates WHERE slate_id = ?
    `);
    return stmt.run(slateId);
  }

  deleteAll() {
    const stmt = db.prepare(`DELETE FROM slates`);
    return stmt.run();
  }
}

export default new SlateModel();
