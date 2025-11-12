import db from '../src/config/database.js';
const rows = db.prepare('SELECT id, slate_id, player_id, name, team, opponent, position, salary, projected_points, value, game_info FROM players WHERE slate_id = ?').all('26155');
console.dir(rows, { depth: null });
