import db from '../src/config/database.js';
import playerModel from '../src/models/playerModel.js';
import rotowireService from '../src/services/rotowireService.js';

const slateId = process.argv[2] || '26155';

(async function repair() {
  try {
    const rows = db.prepare('SELECT id, raw_data FROM players WHERE slate_id = ?').all(slateId);
    if (!rows || rows.length === 0) {
      console.log('No rows found for slate', slateId);
      process.exit(0);
    }

    const rawObjects = rows.map(r => {
      try {
        return JSON.parse(r.raw_data);
      } catch (e) {
        return null;
      }
    }).filter(Boolean);

    console.log(`Parsed ${rawObjects.length} raw player objects for slate ${slateId}`);

    const transformed = rotowireService.transformPlayerData(rawObjects);

    console.log('Transformed players count:', transformed.length);

    // Bulk update using model
    playerModel.bulkCreateOrUpdate(slateId, transformed);

    console.log('Bulk update complete.');
  } catch (err) {
    console.error('Repair failed:', err);
    process.exit(1);
  }
})();
