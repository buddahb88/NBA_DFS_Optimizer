import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import db, { DATABASE_TYPE } from './config/database.js';
import { createTables } from './config/schema.js';
import slatesRouter from './routes/slates.js';
import playersRouter from './routes/players.js';
import lineupsRouter from './routes/lineups.js';
import optimizerRouter from './routes/optimizer.js';
import chatRouter from './routes/chat.js';
import historicalRouter from './routes/historical.js';
import simRouter from './routes/sim.js';
import sitesRouter from './routes/sites.js';
import analyticsRouter from './routes/analytics.js';
import portfolioRouter from './routes/portfolio.js';
import projectionsRouter from './routes/projections.js';
import exportRouter from './routes/export.js';
import playerSettingsRouter from './routes/playerSettings.js';
import lateSwapRouter from './routes/lateswap.js';
import dashboardRouter from './routes/dashboard.js';
import resultsRouter from './routes/results.js';
import syncRunService from './services/syncRunService.js';
import { startHistoricalSyncScheduler } from './services/historicalSyncScheduler.js';

// Get directory paths for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from backend/.env
dotenv.config({ path: path.join(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: true }));

// Request logging
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Routes
app.use('/api/slates', slatesRouter);
app.use('/api/players', playersRouter);
app.use('/api/lineups', lineupsRouter);
app.use('/api/optimizer', optimizerRouter);
app.use('/api/chat', chatRouter);
app.use('/api/historical', historicalRouter);
app.use('/api/sim', simRouter);
app.use('/api/sites', sitesRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/portfolio', portfolioRouter);
app.use('/api/projections', projectionsRouter);
app.use('/api/export', exportRouter);
app.use('/api/player-settings', playerSettingsRouter);
app.use('/api/lateswap', lateSwapRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/results', resultsRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'NBA DFS Optimizer API is running', database: DATABASE_TYPE });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Initialize database and start server
async function startServer() {
  try {
    // Initialize database schema (async for Azure SQL)
    await createTables(db);

    // Syncs left running by a previous process would otherwise hold the sync lock
    const interrupted = await syncRunService.failInterrupted();
    if (interrupted) console.warn(`⚠️ Marked ${interrupted} interrupted historical sync run(s) as failed`);

    // Nightly ESPN catch-up of historical_games (off unless HISTORICAL_SYNC_CRON is set)
    startHistoricalSyncScheduler();

    // Start server
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`🌐 Network access: http://<your-ip>:${PORT}`);
      console.log(`📊 Database: ${DATABASE_TYPE === 'azuresql' ? 'Azure SQL' : 'SQLite'}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  if (db.close) db.close();
  process.exit(0);
});
