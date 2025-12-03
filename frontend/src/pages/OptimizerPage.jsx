import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { optimizerAPI, lineupsAPI, slatesAPI, playersAPI } from '../services/api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function OptimizerPage() {
  const [activeSlate, setActiveSlate] = useState(null);
  const [players, setPlayers] = useState([]);
  const [lockedPlayers, setLockedPlayers] = useState([]);
  const [excludedPlayers, setExcludedPlayers] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);
  const [selectedLineupIndex, setSelectedLineupIndex] = useState(0);
  const [message, setMessage] = useState('');

  // Core Settings
  const [mode, setMode] = useState('gpp');
  const [numLineups, setNumLineups] = useState(1);
  const [minSalary, setMinSalary] = useState(49000);

  // Simple Filters (the only ones that matter)
  const [minProjection, setMinProjection] = useState(20);
  const [minMinutes, setMinMinutes] = useState(20);
  const [maxOwnership, setMaxOwnership] = useState(100);

  // GPP Settings
  const [randomness, setRandomness] = useState(15);

  // Projection recalculation
  const [recalculating, setRecalculating] = useState(false);
  const [projectionResult, setProjectionResult] = useState(null);

  // AI features
  const [loadingBreakdown, setLoadingBreakdown] = useState(false);
  const [slateBreakdown, setSlateBreakdown] = useState(null);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [reviewingLineup, setReviewingLineup] = useState(false);
  const [lineupReview, setLineupReview] = useState(null);

  useEffect(() => {
    loadActiveSlate();
  }, []);

  useEffect(() => {
    // Update defaults when mode changes
    if (mode === 'cash') {
      setMinSalary(49000);
      setMinProjection(25);
      setMinMinutes(28);
      setMaxOwnership(100);
    } else {
      setMinSalary(47000);
      setMinProjection(20);
      setMinMinutes(20);
      setMaxOwnership(40);
    }
  }, [mode]);

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
    setExcludedPlayers(prev => prev.filter(id => id !== playerId));
  };

  const togglePlayerExclude = (playerId) => {
    setExcludedPlayers(prev =>
      prev.includes(playerId)
        ? prev.filter(id => id !== playerId)
        : [...prev, playerId]
    );
    setLockedPlayers(prev => prev.filter(id => id !== playerId));
  };

  const handleRecalculateProjections = async () => {
    if (!activeSlate) return;

    setRecalculating(true);
    setProjectionResult(null);
    setMessage('');

    try {
      const response = await playersAPI.recalculateProjections(activeSlate.slate_id);
      setProjectionResult(response.data);
      setMessage(`✅ ${response.data.message}`);
      // Reload players to get updated projections
      await loadPlayers(activeSlate.slate_id);
    } catch (error) {
      setMessage(`❌ Error: ${error.response?.data?.error || error.message}`);
    } finally {
      setRecalculating(false);
    }
  };

  const handleResetProjections = async () => {
    if (!activeSlate) return;

    try {
      const response = await playersAPI.resetProjections(activeSlate.slate_id);
      setMessage(`✅ ${response.data.message}`);
      setProjectionResult(null);
      await loadPlayers(activeSlate.slate_id);
    } catch (error) {
      setMessage(`❌ Error: ${error.response?.data?.error || error.message}`);
    }
  };

  const handleSlateBreakdown = async () => {
    if (!activeSlate) {
      setMessage('No active slate. Please go to Home to select a slate.');
      return;
    }

    setLoadingBreakdown(true);
    setSlateBreakdown(null);

    try {
      const response = await optimizerAPI.slateBreakdown(activeSlate.slate_id, mode);

      if (response.data.success) {
        setSlateBreakdown(response.data);
        setShowBreakdown(true);
        setMessage(`✅ AI Slate Breakdown Generated!`);
      } else {
        setMessage('❌ Breakdown generation failed');
      }
    } catch (error) {
      setMessage(`❌ Breakdown error: ${error.response?.data?.error || error.message}`);
    } finally {
      setLoadingBreakdown(false);
    }
  };

  const handleReviewLineup = async (lineup) => {
    if (!activeSlate || !lineup) return;

    setReviewingLineup(true);
    setLineupReview(null);

    try {
      const response = await optimizerAPI.reviewLineup(activeSlate.slate_id, lineup, mode);
      if (response.data.success) {
        setLineupReview(response.data);
      } else {
        setMessage('❌ Lineup review failed');
      }
    } catch (error) {
      setMessage(`❌ Review error: ${error.response?.data?.error || error.message}`);
    } finally {
      setReviewingLineup(false);
    }
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
      const settings = {
        slateId: activeSlate.slate_id,
        mode,
        numLineups,
        lockedPlayers,
        excludedPlayers,
        minSalary,
        minProjection,
        minMinutes,
        maxRostership: maxOwnership,
        randomness: mode === 'gpp' ? randomness : 0,
        filterInjured: true,
      };

      const response = await optimizerAPI.generate(settings);

      if (response.data.lineups && response.data.lineups.length > 0) {
        setResults(response.data);
        setMessage(`✅ Generated ${response.data.lineups.length} optimal lineup(s)!`);
      } else {
        setMessage('❌ No lineups generated. Try relaxing your filters.');
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
      const playersData = lineup.players
        .filter(slot => slot.player)
        .map(slot => ({
          ...slot.player,
          positionSlot: slot.position
        }));

      await lineupsAPI.create({
        slateId: activeSlate.slate_id,
        name: `${mode.toUpperCase()} #${index + 1}`,
        players: playersData
      });

      setMessage(`✅ Saved lineup #${index + 1}!`);
    } catch (error) {
      setMessage(`❌ Error saving lineup: ${error.message}`);
    }
  };

  const currentLineup = results?.lineups?.[selectedLineupIndex];

  // Filter and sort players
  const filteredPlayers = players.filter(player =>
    player.name.toLowerCase().includes(searchTerm.toLowerCase())
  ).sort((a, b) => (b.projected_points || 0) - (a.projected_points || 0));

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Player Pool Sidebar */}
        <div className="lg:col-span-1">
          <div className="bg-white rounded-lg shadow p-4 sticky top-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Player Pool</h2>
              <div className="flex gap-2">
                {lockedPlayers.length > 0 && (
                  <span className="px-2 py-1 text-xs bg-green-100 text-green-800 rounded-full font-medium">
                    {lockedPlayers.length} locked
                  </span>
                )}
                {excludedPlayers.length > 0 && (
                  <span className="px-2 py-1 text-xs bg-red-100 text-red-800 rounded-full font-medium">
                    {excludedPlayers.length} excluded
                  </span>
                )}
              </div>
            </div>

            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search players..."
              className="w-full px-3 py-2 mb-3 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
            />

            <div className="space-y-2 max-h-[calc(100vh-250px)] overflow-y-auto">
              {filteredPlayers.length > 0 ? (
                filteredPlayers.map(player => {
                  const isLocked = lockedPlayers.includes(player.id);
                  const isExcluded = excludedPlayers.includes(player.id);

                  return (
                    <div
                      key={player.id}
                      className={`p-2 border rounded-md ${
                        isLocked
                          ? 'bg-green-50 border-green-300'
                          : isExcluded
                          ? 'bg-red-50 border-red-300'
                          : 'border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm truncate">{player.name}</div>
                          <div className="text-xs text-gray-500">
                            {player.position} | {player.team} vs {player.opponent}
                          </div>
                          <div className="text-xs mt-1 flex gap-2">
                            <span className="font-bold text-blue-600">
                              {player.projected_points?.toFixed(1)} pts
                            </span>
                            <span className="text-gray-500">
                              ${(player.salary / 1000).toFixed(1)}k
                            </span>
                            {player.rostership > 0 && (
                              <span className={`${player.rostership > 25 ? 'text-red-500' : 'text-green-600'}`}>
                                {player.rostership.toFixed(0)}% own
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex flex-col gap-1">
                          <button
                            onClick={() => togglePlayerLock(player.id)}
                            className={`flex-shrink-0 p-1.5 rounded text-xs ${
                              isLocked
                                ? 'bg-green-600 text-white'
                                : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                            }`}
                            title={isLocked ? 'Unlock' : 'Lock'}
                          >
                            {isLocked ? 'Locked' : 'Lock'}
                          </button>
                          <button
                            onClick={() => togglePlayerExclude(player.id)}
                            className={`flex-shrink-0 p-1.5 rounded text-xs ${
                              isExcluded
                                ? 'bg-red-600 text-white'
                                : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                            }`}
                            title={isExcluded ? 'Include' : 'Exclude'}
                          >
                            {isExcluded ? 'Excluded' : 'Exclude'}
                          </button>
                        </div>
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
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-3xl font-bold text-gray-900">NBA DFS Optimizer</h1>
                <p className="text-gray-600 mt-1">Projections are the filter. Simple is better.</p>
                {activeSlate && (
                  <p className="text-sm text-blue-600 font-medium mt-1">
                    Slate: {activeSlate.name} ({players.length} players)
                  </p>
                )}
              </div>
              <button
                onClick={handleSlateBreakdown}
                disabled={loadingBreakdown || !activeSlate}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:bg-gray-400 font-medium"
              >
                {loadingBreakdown ? 'Analyzing...' : 'AI Breakdown'}
              </button>
            </div>
          </div>

          {/* Projection Recalculation Panel */}
          <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border-2 border-blue-200 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-blue-900">Projection Engine</h3>
                <p className="text-sm text-blue-700">
                  Apply our adjustments (defense, pace, DVP, rest, Vegas) to RotoWire baseline
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleRecalculateProjections}
                  disabled={recalculating || !activeSlate}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 font-medium"
                >
                  {recalculating ? 'Calculating...' : 'Recalculate Projections'}
                </button>
                <button
                  onClick={handleResetProjections}
                  disabled={!activeSlate}
                  className="px-4 py-2 bg-gray-500 text-white rounded-lg hover:bg-gray-600 disabled:bg-gray-400 font-medium"
                >
                  Reset to RotoWire
                </button>
              </div>
            </div>

            {/* Projection Results */}
            {projectionResult && (
              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-white rounded-lg p-3 border border-green-200">
                  <h4 className="font-semibold text-green-800 mb-2">Top Adjusted UP</h4>
                  <div className="space-y-1 text-sm">
                    {projectionResult.topAdjustmentsUp?.slice(0, 5).map((p, i) => (
                      <div key={i} className="flex justify-between">
                        <span>{p.name} ({p.team} vs {p.opponent})</span>
                        <span className="text-green-600 font-medium">
                          {p.baseline} → {p.adjusted} (+{p.adjustment.toFixed(1)})
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="bg-white rounded-lg p-3 border border-red-200">
                  <h4 className="font-semibold text-red-800 mb-2">Top Adjusted DOWN</h4>
                  <div className="space-y-1 text-sm">
                    {projectionResult.topAdjustmentsDown?.slice(0, 5).map((p, i) => (
                      <div key={i} className="flex justify-between">
                        <span>{p.name} ({p.team} vs {p.opponent})</span>
                        <span className="text-red-600 font-medium">
                          {p.baseline} → {p.adjusted} ({p.adjustment.toFixed(1)})
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* AI Slate Breakdown Modal */}
          {slateBreakdown && showBreakdown && (
            <div className="fixed inset-0 z-50 flex items-start justify-center p-4 bg-black bg-opacity-50 overflow-y-auto">
              <div className="bg-white rounded-lg shadow-2xl w-full max-w-4xl my-8">
                <div className="sticky top-0 z-10 px-6 py-4 border-b flex items-center justify-between bg-purple-100 rounded-t-lg">
                  <h2 className="text-xl font-bold text-purple-900">AI Slate Breakdown</h2>
                  <button
                    onClick={() => setShowBreakdown(false)}
                    className="text-purple-600 hover:text-purple-800 text-2xl"
                  >
                    ×
                  </button>
                </div>
                <div className="p-6 max-h-[calc(100vh-8rem)] overflow-y-auto">
                  <div className="prose prose-sm max-w-none">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {slateBreakdown.aiAnalysis}
                    </ReactMarkdown>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Settings Panel */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-semibold mb-4">Optimizer Settings</h2>

            {!activeSlate && (
              <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-md">
                <p className="text-yellow-800 text-sm">
                  No active slate. <Link to="/" className="font-medium underline">Go to Home</Link> to select one.
                </p>
              </div>
            )}

            {/* Core Settings */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Contest Type</label>
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                >
                  <option value="cash">Cash Game</option>
                  <option value="gpp">GPP Tournament</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2"># Lineups</label>
                <input
                  type="number"
                  value={numLineups}
                  onChange={(e) => setNumLineups(parseInt(e.target.value) || 1)}
                  min="1"
                  max="150"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Min Salary</label>
                <input
                  type="number"
                  value={minSalary}
                  onChange={(e) => setMinSalary(parseInt(e.target.value) || 45000)}
                  min="40000"
                  max="50000"
                  step="500"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </div>

              {mode === 'gpp' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Randomness %</label>
                  <input
                    type="number"
                    value={randomness}
                    onChange={(e) => setRandomness(parseInt(e.target.value) || 0)}
                    min="0"
                    max="30"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  />
                </div>
              )}
            </div>

            {/* Simple Filters - Sliders */}
            <div className="mb-6 p-4 bg-gray-50 rounded-lg">
              <h3 className="text-md font-semibold mb-4 text-gray-800">Player Pool Filters</h3>

              <div className="space-y-4">
                {/* Min Projection */}
                <div>
                  <div className="flex justify-between mb-1">
                    <label className="text-sm font-medium text-gray-700">Min Projection</label>
                    <span className="text-sm font-bold text-blue-600">{minProjection} pts</span>
                  </div>
                  <input
                    type="range"
                    value={minProjection}
                    onChange={(e) => setMinProjection(parseInt(e.target.value))}
                    min="0"
                    max="40"
                    step="1"
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                  />
                  <div className="flex justify-between text-xs text-gray-400">
                    <span>0</span>
                    <span>40</span>
                  </div>
                </div>

                {/* Min Minutes */}
                <div>
                  <div className="flex justify-between mb-1">
                    <label className="text-sm font-medium text-gray-700">Min Minutes</label>
                    <span className="text-sm font-bold text-green-600">{minMinutes} min</span>
                  </div>
                  <input
                    type="range"
                    value={minMinutes}
                    onChange={(e) => setMinMinutes(parseInt(e.target.value))}
                    min="0"
                    max="35"
                    step="1"
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-green-600"
                  />
                  <div className="flex justify-between text-xs text-gray-400">
                    <span>0</span>
                    <span>35</span>
                  </div>
                </div>

                {/* Max Ownership (GPP only) */}
                {mode === 'gpp' && (
                  <div>
                    <div className="flex justify-between mb-1">
                      <label className="text-sm font-medium text-gray-700">Max Ownership</label>
                      <span className="text-sm font-bold text-purple-600">{maxOwnership}%</span>
                    </div>
                    <input
                      type="range"
                      value={maxOwnership}
                      onChange={(e) => setMaxOwnership(parseInt(e.target.value))}
                      min="5"
                      max="100"
                      step="5"
                      className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-purple-600"
                    />
                    <div className="flex justify-between text-xs text-gray-400">
                      <span>5%</span>
                      <span>100%</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Quick summary */}
              <div className="mt-4 p-2 bg-blue-50 rounded text-sm text-blue-800">
                Pool: ~{players.filter(p =>
                  p.projected_points >= minProjection &&
                  (p.projected_minutes || 30) >= minMinutes &&
                  (mode !== 'gpp' || (p.rostership || 0) <= maxOwnership)
                ).length} players will be considered
              </div>
            </div>

            {/* Optimize Button */}
            <div className="mt-6">
              {lockedPlayers.length > 0 && (
                <div className="mb-3 p-3 bg-green-50 border border-green-200 rounded-md">
                  <p className="text-sm text-green-800">
                    <strong>{lockedPlayers.length} player(s) locked</strong> - Will be in every lineup
                  </p>
                </div>
              )}

              <button
                onClick={handleOptimize}
                disabled={loading || !activeSlate}
                className="w-full bg-gradient-to-r from-blue-600 to-purple-600 text-white py-4 px-6 rounded-lg hover:from-blue-700 hover:to-purple-700 disabled:from-gray-400 disabled:to-gray-400 font-bold text-lg"
              >
                {loading ? 'Optimizing...' : `Generate ${numLineups === 1 ? 'Lineup' : `${numLineups} Lineups`}`}
              </button>
            </div>

            {message && (
              <div className={`mt-4 p-4 rounded-md ${message.startsWith('✅') ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
                {message}
              </div>
            )}
          </div>

          {/* Results */}
          {results && results.lineups && results.lineups.length > 0 && (
            <div className="bg-white rounded-lg shadow p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xl font-semibold">
                  {results.lineups.length > 1 ? `Lineup #${currentLineup.lineupNumber}` : 'Optimized Lineup'}
                </h3>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleReviewLineup(currentLineup)}
                    disabled={reviewingLineup}
                    className="px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 font-medium disabled:opacity-50"
                  >
                    {reviewingLineup ? 'Analyzing...' : 'AI Review'}
                  </button>
                  <button
                    onClick={() => handleSaveLineup(currentLineup, selectedLineupIndex)}
                    className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 font-medium"
                  >
                    Save Lineup
                  </button>
                </div>
              </div>

              {/* Lineup Summary */}
              <div className="grid grid-cols-4 gap-4 mb-4 p-3 bg-gray-50 rounded-lg">
                <div>
                  <div className="text-xs text-gray-500">Salary</div>
                  <div className="font-bold">${currentLineup.totalSalary.toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Projection</div>
                  <div className="font-bold text-blue-600">{currentLineup.projectedPoints.toFixed(1)} pts</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Remaining</div>
                  <div className="font-bold">${currentLineup.remainingSalary}</div>
                </div>
                {currentLineup.analytics && (
                  <div>
                    <div className="text-xs text-gray-500">Ownership</div>
                    <div className="font-bold text-purple-600">{currentLineup.analytics.avgOwnership}%</div>
                  </div>
                )}
              </div>

              {/* Lineup Selector for Multi-Lineup */}
              {results.lineups.length > 1 && (
                <div className="mb-4 flex gap-2 flex-wrap">
                  {results.lineups.map((lineup, index) => (
                    <button
                      key={index}
                      onClick={() => setSelectedLineupIndex(index)}
                      className={`px-3 py-1 text-sm rounded ${
                        selectedLineupIndex === index
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                      }`}
                    >
                      #{lineup.lineupNumber} ({lineup.projectedPoints.toFixed(1)})
                    </button>
                  ))}
                </div>
              )}

              {/* Players Table */}
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Pos</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Player</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Salary</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Proj</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Own%</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {currentLineup.players.map((slot, index) => (
                      <tr key={index} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <span className="px-2 py-1 text-xs font-bold rounded bg-blue-100 text-blue-800">
                            {slot.position}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-sm">{slot.player?.name}</div>
                          <div className="text-xs text-gray-500">{slot.player?.team} vs {slot.player?.opponent}</div>
                        </td>
                        <td className="px-4 py-3 text-sm">${slot.player?.salary?.toLocaleString()}</td>
                        <td className="px-4 py-3 text-sm font-bold">{slot.player?.projected_points?.toFixed(1)}</td>
                        <td className="px-4 py-3 text-sm">
                          <span className={slot.player?.rostership > 25 ? 'text-red-600' : 'text-green-600'}>
                            {slot.player?.rostership?.toFixed(0) || 0}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* AI Lineup Review */}
              {lineupReview && (
                <div className="mt-6 p-4 bg-purple-50 rounded-lg border border-purple-200">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-lg font-semibold text-purple-800">AI Lineup Review</h4>
                    <button onClick={() => setLineupReview(null)} className="text-gray-500 hover:text-gray-700 text-xl">×</button>
                  </div>
                  <div className="prose prose-sm max-w-none text-gray-700 whitespace-pre-wrap">
                    {lineupReview.review}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Info Box when no results */}
          {!results && !loading && (
            <div className="bg-blue-50 rounded-lg p-6 border border-blue-200">
              <h3 className="text-lg font-bold text-blue-900 mb-3">How This Works</h3>
              <ol className="list-decimal list-inside space-y-2 text-sm text-blue-800">
                <li><strong>Recalculate Projections</strong> - Apply our matchup adjustments to RotoWire baseline</li>
                <li><strong>Set your filters</strong> - Min projection and minutes to trim the pool</li>
                <li><strong>Lock/Exclude players</strong> - Force your reads into the lineup</li>
                <li><strong>Generate</strong> - Let the optimizer find the best combination</li>
              </ol>
              <p className="mt-4 text-sm text-blue-700">
                <strong>Philosophy:</strong> The projection IS the filter. Good projections account for matchups,
                pace, rest, and Vegas lines. Don't over-filter - trust the numbers.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export default OptimizerPage;
