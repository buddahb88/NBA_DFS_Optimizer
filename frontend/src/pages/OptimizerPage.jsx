import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { optimizerAPI, lineupsAPI, slatesAPI, playersAPI } from '../services/api';

function OptimizerPage() {
  const [activeSlate, setActiveSlate] = useState(null);
  const [mode, setMode] = useState('cash');
  const [numLineups, setNumLineups] = useState(1);
  const [minSalary, setMinSalary] = useState(49000);
  const [maxExposure, setMaxExposure] = useState(50);
  const [randomness, setRandomness] = useState(20);
  const [minMinutes, setMinMinutes] = useState(15);
  const [minProjection, setMinProjection] = useState(15);
  const [useValueFilter, setUseValueFilter] = useState(true);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);
  const [selectedLineupIndex, setSelectedLineupIndex] = useState(0);
  const [message, setMessage] = useState('');
  const [players, setPlayers] = useState([]);
  const [lockedPlayers, setLockedPlayers] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    loadActiveSlate();
  }, []);

  const loadActiveSlate = async () => {
    try {
      const response = await slatesAPI.getActiveSlate();
      setActiveSlate(response.data);
      if (response.data) {
        loadPlayers(response.data.slate_id);
      }
    } catch (error) {
      console.error('Error loading active slate:', error);
    }
  };

  const loadPlayers = async (slateId) => {
    try {
      const response = await playersAPI.getBySlateId(slateId);
      setPlayers(response.data);
    } catch (error) {
      console.error('Error loading players:', error);
    }
  };

  const togglePlayerLock = (playerId) => {
    setLockedPlayers(prev =>
      prev.includes(playerId)
        ? prev.filter(id => id !== playerId)
        : [...prev, playerId]
    );
  };

  const handleOptimize = async () => {
    if (!activeSlate) {
      setMessage('No active slate. Please go to Home to select a slate.');
      return;
    }

    setLoading(true);
    setMessage('');
    setResults(null);

    try {
      const response = await optimizerAPI.generate({
        slateId: activeSlate.slate_id,
        mode,
        numLineups,
        minSalary,
        maxExposure,
        randomness,
        minMinutes,
        minProjection,
        useValueFilter,
        useProjections: true,
        lockedPlayers
      });

      if (response.data.success) {
        setResults(response.data);
        setMessage(`✅ Generated ${response.data.count} optimal lineup(s)!`);
      } else {
        setMessage('❌ Optimization failed');
      }
    } catch (error) {
      setMessage(`❌ Error: ${error.response?.data?.error || error.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveLineup = async (lineup, index) => {
    if (!activeSlate) return;

    try {
      const players = lineup.players
        .filter(slot => slot.player)
        .map(slot => ({
          ...slot.player,
          positionSlot: slot.position
        }));

      await lineupsAPI.create({
        slateId: activeSlate.slate_id,
        name: `Optimized ${mode.toUpperCase()} #${index + 1}`,
        players
      });

      setMessage(`✅ Saved lineup #${index + 1}!`);
    } catch (error) {
      setMessage(`❌ Error saving lineup: ${error.message}`);
    }
  };

  const currentLineup = results?.lineups?.[selectedLineupIndex];

  const filteredPlayers = players.filter(player =>
    player.name.toLowerCase().includes(searchTerm.toLowerCase())
  ).sort((a, b) => (b.projected_points || 0) - (a.projected_points || 0));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
      {/* Player Pool Sidebar */}
      <div className="lg:col-span-1">
        <div className="bg-white rounded-lg shadow p-4 sticky top-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Player Pool</h2>
            {lockedPlayers.length > 0 && (
              <span className="px-2 py-1 text-xs bg-green-100 text-green-800 rounded-full font-medium">
                {lockedPlayers.length} locked
              </span>
            )}
          </div>

          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search players..."
            className="w-full px-3 py-2 mb-3 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
          />

          <div className="space-y-2 max-h-[calc(100vh-250px)] overflow-y-auto">
            {loading ? (
              <div className="text-center py-8 text-gray-500 text-sm">Loading...</div>
            ) : filteredPlayers.length > 0 ? (
              filteredPlayers.map(player => {
                const isLocked = lockedPlayers.includes(player.id);
                return (
                  <div
                    key={player.id}
                    className={`p-2 border rounded-md ${
                      isLocked
                        ? 'bg-green-50 border-green-300'
                        : 'border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm truncate">{player.name}</div>
                        <div className="text-xs text-gray-500">
                          {player.position} • {player.team}
                        </div>
                        <div className="text-xs mt-1">
                          <span className="text-gray-600">${player.salary?.toLocaleString()}</span>
                          <span className="text-gray-600"> • </span>
                          <span className={`font-medium ${
                            player.projected_points >= 40 ? 'text-green-600' :
                            player.projected_points <= 25 ? 'text-red-600' :
                            'text-gray-600'
                          }`}>
                            {player.projected_points?.toFixed(1)} pts
                          </span>
                        </div>
                        <div className="flex gap-2 mt-1 text-xs">
                          {player.projected_minutes && (
                            <span className={`font-medium ${
                              player.projected_minutes >= 32 ? 'text-green-600' :
                              player.projected_minutes <= 20 ? 'text-red-600' :
                              'text-gray-600'
                            }`}>
                              {player.projected_minutes.toFixed(0)}m
                            </span>
                          )}
                          {player.dvp_pts_allowed && (
                            <span className={`font-medium ${
                              player.dvp_pts_allowed >= 45 ? 'text-green-600' :  // High pts allowed = easier matchup
                              player.dvp_pts_allowed <= 35 ? 'text-red-600' :    // Low pts allowed = tough matchup
                              'text-gray-600'
                            }`}>
                              DVP: {player.dvp_pts_allowed.toFixed(1)}
                            </span>
                          )}
                          {player.opp_def_eff && (
                            <span className={`font-medium ${
                              player.opp_def_eff < 108 ? 'text-red-600' :    // Elite defense
                              player.opp_def_eff > 118 ? 'text-green-600' :  // Weak defense
                              'text-gray-600'
                            }`}>
                              DEF: {player.opp_def_eff.toFixed(1)}
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => togglePlayerLock(player.id)}
                        className={`flex-shrink-0 p-1.5 rounded ${
                          isLocked
                            ? 'bg-green-600 text-white hover:bg-green-700'
                            : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                        }`}
                        title={isLocked ? 'Locked - Will be in every lineup' : 'Click to lock this player'}
                      >
                        {isLocked ? (
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                          </svg>
                        ) : (
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M10 2a5 5 0 00-5 5v2a2 2 0 00-2 2v5a2 2 0 002 2h10a2 2 0 002-2v-5a2 2 0 00-2-2H7V7a3 3 0 015.905-.75 1 1 0 001.937-.5A5.002 5.002 0 0010 2z" />
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="text-center py-8 text-gray-500 text-sm">No players found</div>
            )}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="lg:col-span-3 space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Lineup Optimizer</h1>
          <p className="text-gray-600 mt-2">Generate optimal DFS lineups using advanced algorithms</p>
          {activeSlate && (
            <p className="text-sm text-gray-600 mt-1">
              Active Slate: <span className="font-medium">{activeSlate.name}</span>
            </p>
          )}
        </div>

      {/* Settings Panel */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-xl font-semibold mb-4">Optimization Settings</h2>

        {!activeSlate && (
          <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-md">
            <p className="text-yellow-800 text-sm">
              No active slate selected. Please{' '}
              <Link to="/" className="font-medium underline">
                go to Home
              </Link>{' '}
              to select a slate first.
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

          {/* Mode */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Contest Type
            </label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
            >
              <option value="cash">Cash Game (High Floor)</option>
              <option value="gpp">GPP/Tournament (High Ceiling)</option>
            </select>
          </div>

          {/* Number of Lineups */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Number of Lineups
            </label>
            <input
              type="number"
              value={numLineups}
              onChange={(e) => setNumLineups(parseInt(e.target.value))}
              min="1"
              max="150"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Min Salary */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Min Salary
            </label>
            <input
              type="number"
              value={minSalary}
              onChange={(e) => setMinSalary(parseInt(e.target.value))}
              min="40000"
              max="50000"
              step="100"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Max Exposure (for multi-lineup) */}
          {numLineups > 1 && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Max Player Exposure %
              </label>
              <input
                type="number"
                value={maxExposure}
                onChange={(e) => setMaxExposure(parseInt(e.target.value))}
                min="1"
                max="100"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}

          {/* Randomness (for GPP) */}
          {mode === 'gpp' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Randomness % (Variance)
              </label>
              <input
                type="number"
                value={randomness}
                onChange={(e) => setRandomness(parseInt(e.target.value))}
                min="0"
                max="100"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}
        </div>

        {/* Player Quality Filters */}
        <div className="mt-6 pt-6 border-t border-gray-200">
          <h3 className="text-lg font-semibold mb-4">Player Quality Filters</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Min Projected Minutes
              </label>
              <input
                type="number"
                value={minMinutes}
                onChange={(e) => setMinMinutes(parseInt(e.target.value))}
                min="0"
                max="48"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-500 mt-1">Filters out bench/inactive players</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Min Projected Points
              </label>
              <input
                type="number"
                value={minProjection}
                onChange={(e) => setMinProjection(parseInt(e.target.value))}
                min="0"
                max="100"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-500 mt-1">Removes very low floor plays</p>
            </div>

            <div>
              <label className="flex items-center space-x-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useValueFilter}
                  onChange={(e) => setUseValueFilter(e.target.checked)}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                <div>
                  <div className="text-sm font-medium text-gray-700">Use Value Filter</div>
                  <p className="text-xs text-gray-500">Only top 75% by value</p>
                </div>
              </label>
            </div>
          </div>
        </div>

        {/* Optimize Button */}
        <div className="mt-6">
          {lockedPlayers.length > 0 && (
            <div className="mb-3 p-3 bg-green-50 border border-green-200 rounded-md">
              <p className="text-sm text-green-800">
                🔒 <strong>{lockedPlayers.length} player(s) locked</strong> - Will be included in every lineup
              </p>
            </div>
          )}
          <button
            onClick={handleOptimize}
            disabled={loading || !activeSlate}
            className="w-full bg-green-600 text-white py-3 px-6 rounded-md hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed font-semibold text-lg"
          >
            {loading ? '🔄 Optimizing...' : '🚀 Generate Optimal Lineups'}
          </button>
        </div>

        {message && (
          <div className={`mt-4 p-4 rounded-md ${message.startsWith('✅') ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
            {message}
          </div>
        )}
      </div>

      {/* Results */}
      {results && results.lineups.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Lineup Selector (if multiple lineups) */}
          {results.lineups.length > 1 && (
            <div className="lg:col-span-1">
              <div className="bg-white rounded-lg shadow p-4">
                <h3 className="font-semibold mb-3">Generated Lineups ({results.count})</h3>
                <div className="space-y-2 max-h-[600px] overflow-y-auto">
                  {results.lineups.map((lineup, index) => (
                    <div
                      key={index}
                      onClick={() => setSelectedLineupIndex(index)}
                      className={`p-3 rounded-md cursor-pointer border-2 ${
                        selectedLineupIndex === index
                          ? 'border-blue-500 bg-blue-50'
                          : 'border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      <div className="font-medium">Lineup #{lineup.lineupNumber}</div>
                      <div className="text-sm text-gray-600">
                        ${lineup.totalSalary.toLocaleString()} • {lineup.projectedPoints.toFixed(1)} pts
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Exposure Stats */}
              {results.exposureStats && (
                <div className="bg-white rounded-lg shadow p-4 mt-4">
                  <h3 className="font-semibold mb-3">Player Exposure</h3>
                  <div className="space-y-2 max-h-[300px] overflow-y-auto">
                    {results.exposureStats.slice(0, 10).map((stat, index) => (
                      <div key={index} className="flex items-center justify-between text-sm">
                        <span className="truncate">{stat.name}</span>
                        <span className="font-medium text-blue-600">{stat.exposure}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Current Lineup Display */}
          <div className={results.lineups.length > 1 ? 'lg:col-span-2' : 'lg:col-span-3'}>
            <div className="bg-white rounded-lg shadow p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xl font-semibold">
                  {results.lineups.length > 1 ? `Lineup #${currentLineup.lineupNumber}` : 'Optimized Lineup'}
                </h3>
                <button
                  onClick={() => handleSaveLineup(currentLineup, selectedLineupIndex)}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
                >
                  Save Lineup
                </button>
              </div>

              {/* Lineup Summary */}
              <div className="grid grid-cols-3 gap-4 mb-6 p-4 bg-gray-50 rounded-lg">
                <div>
                  <div className="text-sm text-gray-600">Total Salary</div>
                  <div className="text-xl font-bold text-gray-900">
                    ${currentLineup.totalSalary.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-gray-600">Remaining</div>
                  <div className="text-xl font-bold text-green-600">
                    ${currentLineup.remainingSalary.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-gray-600">Projected Points</div>
                  <div className="text-xl font-bold text-gray-900">
                    {currentLineup.projectedPoints.toFixed(1)}
                  </div>
                </div>
              </div>

              {/* Players Table */}
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Position
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Player
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Team
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Salary
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Proj
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Min
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Value
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {currentLineup.players.map((slot, index) => (
                      <tr key={index} className="hover:bg-gray-50">
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-100 text-blue-800">
                            {slot.position}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center">
                            {slot.player?.headshot ? (
                              <img
                                src={slot.player.headshot}
                                alt={slot.player.name}
                                className="h-10 w-10 rounded-full object-cover mr-3"
                                onError={(e) => {
                                  e.target.onerror = null;
                                  e.target.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="gray"%3E%3Cpath d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/%3E%3C/svg%3E';
                                }}
                              />
                            ) : (
                              <div className="h-10 w-10 rounded-full bg-gray-300 flex items-center justify-center mr-3">
                                <span className="text-gray-600 font-bold text-lg">
                                  {slot.player?.name?.charAt(0)}
                                </span>
                              </div>
                            )}
                            <div>
                              <div className="text-sm font-medium text-gray-900">{slot.player?.name}</div>
                              <div className="text-xs text-gray-500">{slot.player?.position}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {slot.player?.team}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          ${slot.player?.salary?.toLocaleString()}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                          <span className={`font-semibold ${
                            slot.player?.projected_points >= 40 ? 'text-green-600' :
                            slot.player?.projected_points <= 25 ? 'text-red-600' :
                            'text-gray-700'
                          }`}>
                            {slot.player?.projected_points?.toFixed(1)}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                          <span className={`font-semibold ${
                            slot.player?.projected_minutes >= 32 ? 'text-green-600' :
                            slot.player?.projected_minutes <= 20 ? 'text-red-600' :
                            'text-gray-700'
                          }`}>
                            {slot.player?.projected_minutes?.toFixed(0)}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                          <span className={`font-semibold ${
                            (mode === 'gpp' ? slot.player?.value_gpp : slot.player?.value) >= 5.5 ? 'text-green-600' :
                            (mode === 'gpp' ? slot.player?.value_gpp : slot.player?.value) <= 4.0 ? 'text-red-600' :
                            'text-gray-700'
                          }`}>
                            {mode === 'gpp' ? slot.player?.value_gpp?.toFixed(2) : slot.player?.value?.toFixed(2)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Info Box */}
      {!results && !loading && (
        <div className="bg-blue-50 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-blue-900 mb-3">How It Works</h3>
          <ul className="list-disc list-inside space-y-2 text-blue-800">
            <li><strong>Cash Game Mode:</strong> Maximizes floor value using ownership-adjusted scores</li>
            <li><strong>GPP Mode:</strong> Maximizes ceiling with low-ownership leverage plays</li>
            <li><strong>Multi-Lineup:</strong> Generate up to 150 unique lineups with exposure control</li>
            <li><strong>Smart Constraints:</strong> Respects salary cap, positions, and DraftKings rules</li>
            <li><strong>Quality Filters:</strong> Automatically filters out bench players and poor value plays</li>
          </ul>

          <div className="mt-4 p-3 bg-blue-100 rounded">
            <p className="text-sm text-blue-900">
              💡 <strong>Tip:</strong> Lower the min minutes/projection filters if you need more player options,
              or increase them for safer, more predictable lineups.
            </p>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

export default OptimizerPage;
