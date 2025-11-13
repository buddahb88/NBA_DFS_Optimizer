#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.join(__dirname, '../data');
const sourceDb = path.join(dataDir, 'nba_dfs.db');
const backupDir = path.join(dataDir, 'snapshots');
const backtestDb = path.join(dataDir, 'nba_dfs_backtest.db');

// Ensure directories exist
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}

// Get command argument
const command = process.argv[2];

if (command === 'create') {
  // Create a timestamped snapshot
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
  const snapshotPath = path.join(backupDir, `nba_dfs_${timestamp}.db`);

  if (!fs.existsSync(sourceDb)) {
    console.error('Error: Source database does not exist at', sourceDb);
    process.exit(1);
  }

  // Copy the database file
  fs.copyFileSync(sourceDb, snapshotPath);
  console.log(`✓ Snapshot created: ${snapshotPath}`);

  // Also copy to backtesting database
  fs.copyFileSync(sourceDb, backtestDb);
  console.log(`✓ Backtest database initialized: ${backtestDb}`);

} else if (command === 'restore') {
  // Restore from latest snapshot or specified file
  const snapshotFile = process.argv[3];

  if (snapshotFile) {
    // Restore from specific snapshot
    const snapshotPath = path.join(backupDir, snapshotFile);
    if (!fs.existsSync(snapshotPath)) {
      console.error('Error: Snapshot file does not exist:', snapshotPath);
      process.exit(1);
    }
    fs.copyFileSync(snapshotPath, sourceDb);
    console.log(`✓ Restored from snapshot: ${snapshotFile}`);
  } else {
    // Restore from latest snapshot
    const snapshots = fs.readdirSync(backupDir)
      .filter(f => f.endsWith('.db'))
      .sort()
      .reverse();

    if (snapshots.length === 0) {
      console.error('Error: No snapshots found');
      process.exit(1);
    }

    const latestSnapshot = path.join(backupDir, snapshots[0]);
    fs.copyFileSync(latestSnapshot, sourceDb);
    console.log(`✓ Restored from latest snapshot: ${snapshots[0]}`);
  }

} else if (command === 'list') {
  // List all snapshots
  if (!fs.existsSync(backupDir)) {
    console.log('No snapshots found');
    process.exit(0);
  }

  const snapshots = fs.readdirSync(backupDir)
    .filter(f => f.endsWith('.db'))
    .sort()
    .reverse();

  if (snapshots.length === 0) {
    console.log('No snapshots found');
  } else {
    console.log('\nAvailable snapshots:');
    snapshots.forEach((snapshot, i) => {
      const stats = fs.statSync(path.join(backupDir, snapshot));
      const size = (stats.size / 1024).toFixed(2);
      console.log(`  ${i + 1}. ${snapshot} (${size} KB)`);
    });
  }

} else if (command === 'init-backtest') {
  // Initialize backtest database from main database
  if (!fs.existsSync(sourceDb)) {
    console.error('Error: Source database does not exist at', sourceDb);
    process.exit(1);
  }

  fs.copyFileSync(sourceDb, backtestDb);
  console.log(`✓ Backtest database initialized from current database`);
  console.log(`  Location: ${backtestDb}`);
  console.log(`\nTo use backtest mode, set environment variable:`);
  console.log(`  BACKTESTING_MODE=true`);

} else {
  console.log(`
NBA DFS Database Snapshot Manager

Usage:
  npm run snapshot create           - Create a new snapshot of the current database
  npm run snapshot restore [file]   - Restore from latest snapshot or specified file
  npm run snapshot list             - List all available snapshots
  npm run snapshot init-backtest    - Initialize backtest database from current data

Examples:
  npm run snapshot create
  npm run snapshot list
  npm run snapshot restore nba_dfs_2025-11-13.db
  npm run snapshot init-backtest
  `);
}
