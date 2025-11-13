# Backtesting Environment

This guide explains how to use the backtesting environment to test your projection algorithms without affecting your production player data.

## Overview

The backtesting system creates a separate database (`nba_dfs_backtest.db`) that you can experiment with while keeping your main database (`nba_dfs.db`) safe.

## Quick Start

### 1. Initialize Backtest Database

First, create a snapshot of your current database and initialize the backtesting environment:

```bash
cd backend
npm run snapshot init-backtest
```

This will:
- Copy your current database to `data/nba_dfs_backtest.db`
- Create a timestamped snapshot in `data/snapshots/`

### 2. Start Server in Backtest Mode

On **Windows** (PowerShell):
```powershell
$env:BACKTESTING_MODE="true"
npm run dev
```

On **Windows** (Command Prompt):
```cmd
set BACKTESTING_MODE=true
npm run dev
```

On **Mac/Linux**:
```bash
npm run dev:backtest
```

You'll see: `🧪 BACKTESTING MODE ENABLED - Using separate database`

### 3. Run Your Backtests

Now any changes you make (importing slates, updating projections, etc.) will only affect the backtest database.

### 4. Switch Back to Production

Simply stop the server and restart without `BACKTESTING_MODE`:

```bash
npm run dev
```

## Snapshot Commands

### Create a Snapshot
Save the current state of your database:
```bash
npm run snapshot create
```

### List All Snapshots
View all saved snapshots:
```bash
npm run snapshot list
```

### Restore from Snapshot
Restore your main database from the latest snapshot:
```bash
npm run snapshot restore
```

Or restore from a specific snapshot:
```bash
npm run snapshot restore nba_dfs_2025-11-13.db
```

## Workflow Example

```bash
# 1. Save current state before backtesting
npm run snapshot create

# 2. Initialize backtest database with current data
npm run snapshot init-backtest

# 3. Start server in backtest mode (Windows PowerShell)
$env:BACKTESTING_MODE="true"
npm run dev

# 4. Run your backtests through the UI or API
# - Import historical slates
# - Test projection algorithms
# - Analyze results

# 5. When done, stop the server (Ctrl+C)

# 6. Start normal server to use production database
npm run dev
```

## Environment Variables

- `BACKTESTING_MODE=true` - Uses `nba_dfs_backtest.db` instead of `nba_dfs.db`
- `DATABASE_PATH=/custom/path.db` - Use a completely custom database path (overrides backtest mode)

## File Locations

- **Main Database**: `backend/data/nba_dfs.db`
- **Backtest Database**: `backend/data/nba_dfs_backtest.db`
- **Snapshots**: `backend/data/snapshots/nba_dfs_YYYY-MM-DD.db`

## Tips

1. **Always create a snapshot before major changes** - Use `npm run snapshot create` before experimenting
2. **Separate frontend for backtesting** - You can run the frontend with a different API URL pointing to your backtest server
3. **Compare databases** - Use SQLite tools to compare the main and backtest databases after your tests
4. **Regular backups** - Create snapshots regularly, especially before importing new data

## Safety

The backtesting system is designed to be safe:
- Backtest database is completely separate from production
- Original data is never modified when in backtest mode
- You can always restore from snapshots
- Clear visual indicator (`🧪 BACKTESTING MODE ENABLED`) in console

## Advanced: Running Both Environments Simultaneously

You can run both production and backtest servers at the same time on different ports:

Terminal 1 (Production on port 3001):
```bash
npm run dev
```

Terminal 2 (Backtest on port 3002):
```bash
$env:BACKTESTING_MODE="true"
$env:PORT="3002"
npm run dev
```

Then configure your frontend to point to `http://localhost:3002` for backtesting.
