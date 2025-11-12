import db from '../src/config/database.js';
import rotowireService from '../src/services/rotowireService.js';

const slateId = process.argv[2] || '26155';
const row = db.prepare('SELECT raw_data FROM players WHERE slate_id = ? LIMIT 1').get(slateId);
if (!row) { console.log('No row found'); process.exit(0); }
const obj = JSON.parse(row.raw_data);
const transformed = rotowireService.transformPlayerData([obj]);
console.log('Transformed:');
console.dir(transformed, { depth: null });
