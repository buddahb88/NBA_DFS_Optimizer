import db from '../src/config/database.js';

const slateId = process.argv[2] || '26155';
const stmt = db.prepare('SELECT * FROM players WHERE slate_id = ? LIMIT 1');
const row = stmt.get(slateId);
console.log('Sample row for slate', slateId, ':');
console.dir(row, { depth: null });
