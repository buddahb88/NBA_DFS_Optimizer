import db from './database.js';
import { createTables } from './schema.js';

console.log('🔄 Initializing database...');

try {
  await createTables(db);
  console.log('✅ Database initialization complete!');
} catch (error) {
  console.error('❌ Database initialization failed:', error);
  process.exit(1);
}

db.close();
