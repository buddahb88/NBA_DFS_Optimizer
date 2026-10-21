import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { historicalAPI } from '../services/api';
import { toSeasonOptions } from './insights/seasonOptions';

/**
 * TEMPORARY: the historical-data sync banner moved here unchanged from the
 * old Insights page so sync stays reachable. It is replaced by the Data
 * Status panel in a later card.
 */
function DataStatusPage() {
  // Data sync state
  const [dataStatus, setDataStatus] = useState(null);
  const [syncProgress, setSyncProgress] = useState(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [selectedSeasons, setSelectedSeasons] = useState([]); // Defaults to current season once loaded

  // Available seasons (most recent first), served by the backend season util
  const [availableSeasons, setAvailableSeasons] = useState([]);
  const [currentSeason, setCurrentSeason] = useState(null);

  useEffect(() => {
    checkDataStatus();
    loadSeasons();
  }, []);

  // Poll for sync status if syncing
  useEffect(() => {
    let interval;
    if (isSyncing) {
      interval = setInterval(async () => {
        try {
          const res = await historicalAPI.getSyncStatus();
          setSyncProgress(res.data?.progress);
          if (res.data?.progress?.status === 'complete' || res.data?.progress?.status === 'error') {
            setIsSyncing(false);
            checkDataStatus(); // Refresh status after sync
          }
        } catch (e) {
          console.error('Error checking sync status:', e);
        }
      }, 3000);
    }
    return () => clearInterval(interval);
  }, [isSyncing]);

  const loadSeasons = async () => {
    try {
      const res = await historicalAPI.getSeasons();
      setAvailableSeasons(toSeasonOptions(res.data));
      setCurrentSeason(res.data?.current || null);
      if (res.data?.current) setSelectedSeasons(prev => (prev.length ? prev : [res.data.current]));
    } catch (e) {
      console.error('Error loading seasons:', e);
    }
  };

  const checkDataStatus = async () => {
    try {
      const res = await historicalAPI.getStatus();
      setDataStatus(res.data);
    } catch (e) {
      console.error('Error checking data status:', e);
    }
  };

  const startDataSync = async (forceFullSync = false) => {
    try {
      setIsSyncing(true);
      setSyncProgress({ status: 'starting', mode: forceFullSync ? 'full' : 'auto', seasons: selectedSeasons });
      await historicalAPI.startSync(forceFullSync, selectedSeasons);
    } catch (e) {
      console.error('Error starting sync:', e);
      setIsSyncing(false);
    }
  };

  // Direct NBA API sync - bypasses blob storage, syncs from last known date
  const startNbaApiSync = async () => {
    try {
      setIsSyncing(true);
      setSyncProgress({ status: 'starting', mode: 'nba-api', message: 'Connecting to NBA Stats API...' });
      await historicalAPI.startNbaApiSync(currentSeason || undefined, dataStatus.latestGame);
    } catch (e) {
      console.error('Error starting NBA API sync:', e);
      setIsSyncing(false);
    }
  };

  const toggleSeason = (season) => {
    setSelectedSeasons(prev => {
      if (prev.includes(season)) {
        // Don't allow deselecting all seasons
        if (prev.length === 1) return prev;
        return prev.filter(s => s !== season);
      }
      return [...prev, season].sort().reverse(); // Keep sorted, newest first
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Data Status</h1>
        <Link to="/insights" className="text-sm font-medium text-blue-600 hover:underline">
          Back to Insights
        </Link>
      </div>

      {/* Data Sync Status */}
      {dataStatus && (
        <div className={`rounded-lg shadow p-4 ${
          dataStatus.needsFullSync ? 'bg-yellow-50 border border-yellow-200' :
          dataStatus.needsUpdate ? 'bg-blue-50 border border-blue-200' :
          'bg-green-50 border border-green-200'
        }`}>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-lg">
                  {dataStatus.needsFullSync ? '⚠️' : dataStatus.needsUpdate ? '🔄' : '✅'}
                </span>
                <span className="font-medium text-gray-900">
                  {dataStatus.needsFullSync ? 'No Historical Data' :
                   dataStatus.needsUpdate ? 'Update Available' :
                   'Data Up to Date'}
                </span>
              </div>
              <p className="text-sm text-gray-600 mt-1">
                {dataStatus.hasData ? (
                  <>
                    {dataStatus.totalGames?.toLocaleString()} games from {dataStatus.uniquePlayers} players
                    <span className="text-gray-400 ml-2">
                      ({dataStatus.earliestGame} to {dataStatus.latestGame})
                    </span>
                  </>
                ) : (
                  'Select seasons and click sync to populate historical game data'
                )}
              </p>
            </div>

            <div className="flex items-center gap-2">
              {isSyncing ? (
                <div className="flex items-center gap-3">
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
                  <div className="text-sm">
                    <div className="font-medium text-gray-900">
                      {syncProgress?.mode === 'nba-api' ? '🏀 NBA API Sync' :
                       syncProgress?.mode === 'incremental' ? 'Updating' : 'Syncing'}...
                      {syncProgress?.percent ? ` ${syncProgress.percent}%` : ''}
                      {syncProgress?.currentSeason && ` (${syncProgress.currentSeason})`}
                      {syncProgress?.season && syncProgress?.mode === 'nba-api' && ` (${syncProgress.season})`}
                    </div>
                    {syncProgress?.message && (
                      <div className="text-gray-500">{syncProgress.message}</div>
                    )}
                    {syncProgress?.processed && (
                      <div className="text-gray-500">
                        {syncProgress.processed}/{syncProgress.total} players | {syncProgress.games} games
                      </div>
                    )}
                    {syncProgress?.current && syncProgress?.playerName && (
                      <div className="text-gray-500">
                        {syncProgress.current}/{syncProgress.total} players - {syncProgress.playerName}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <button
                    onClick={() => startDataSync(dataStatus.needsFullSync)}
                    className={`px-4 py-2 text-white rounded-lg text-sm font-medium ${
                      dataStatus.needsFullSync
                        ? 'bg-yellow-600 hover:bg-yellow-700'
                        : 'bg-blue-600 hover:bg-blue-700'
                    }`}
                  >
                    {dataStatus.needsFullSync ? 'Sync Selected Seasons' :
                     dataStatus.needsUpdate ? 'Update Data' : 'Sync Selected Seasons'}
                  </button>
                  {!dataStatus.needsFullSync && (
                    <button
                      onClick={() => startDataSync(true)}
                      className="px-3 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 text-sm"
                      title="Force full re-sync of all selected seasons"
                    >
                      Force Full Sync
                    </button>
                  )}
                  <button
                    onClick={startNbaApiSync}
                    className="px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-medium"
                    title="Sync directly from NBA.com API - bypasses blob storage"
                  >
                    🏀 NBA API Sync
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Season Selector */}
          {!isSyncing && (
            <div className="mt-3 pt-3 border-t border-gray-200">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-gray-700">Seasons to sync:</span>
                {availableSeasons.map(season => (
                  <button
                    key={season.value}
                    onClick={() => toggleSeason(season.value)}
                    className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
                      selectedSeasons.includes(season.value)
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {season.label}
                  </button>
                ))}
                <span className="text-xs text-gray-400 ml-2">
                  ({selectedSeasons.length} season{selectedSeasons.length !== 1 ? 's' : ''} selected)
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                Each season adds ~15-20 minutes of sync time due to NBA.com rate limits
              </p>
            </div>
          )}

          {/* Sync Complete Message */}
          {syncProgress?.status === 'complete' && (
            <div className="mt-3 p-2 bg-green-100 border border-green-200 rounded text-sm text-green-800">
              ✅ Sync complete! {syncProgress.games} games synced in {syncProgress.elapsed}s
            </div>
          )}
          {syncProgress?.status === 'error' && (
            <div className="mt-3 p-2 bg-red-100 border border-red-200 rounded text-sm text-red-800">
              ❌ Error: {syncProgress.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default DataStatusPage;
