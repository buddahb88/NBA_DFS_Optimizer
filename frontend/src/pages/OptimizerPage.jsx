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
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Core Settings
  const [mode, setMode] = useState('cash');
  const [numLineups, setNumLineups] = useState(1);
  const [minSalary, setMinSalary] = useState(49000);

  // Cash Game Settings
  const [minFloor, setMinFloor] = useState(30);
  const [maxVolatility, setMaxVolatility] = useState(0.20);
  const [maxBustProbability, setMaxBustProbability] = useState(25);
  const [minProjectedMinutes, setMinProjectedMinutes] = useState(28);
  const [avoidBlowouts, setAvoidBlowouts] = useState(true);

  // GPP Settings
  const [gppMode, setGppMode] = useState('balanced');
  const [minLeverageScore, setMinLeverageScore] = useState(2.5);
  const [minBoomProbability, setMinBoomProbability] = useState(20);
  const [minCeiling, setMinCeiling] = useState(50);
  const [maxChalkPlayers, setMaxChalkPlayers] = useState(2);
  const [randomness, setRandomness] = useState(15);

  // Exposure Settings
  const [maxExposureChalk, setMaxExposureChalk] = useState(30);
  const [maxExposureMid, setMaxExposureMid] = useState(50);
  const [maxExposureLeverage, setMaxExposureLeverage] = useState(70);
  const [minExposure, setMinExposure] = useState(0);

  // Advanced Filters
  const [minRestDays, setMinRestDays] = useState(0);
  const [minUsage, setMinUsage] = useState(0);
  const [minProjection, setMinProjection] = useState(mode === 'cash' ? 25 : 20);
  const [autoTuning, setAutoTuning] = useState(false);
  const [autoTuneResult, setAutoTuneResult] = useState(null);
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
      setMinProjectedMinutes(28);
    } else {
      setMinSalary(47000);
      setMinProjection(20);
      setMinProjectedMinutes(20);
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
    // Remove from excluded if locking
    setExcludedPlayers(prev => prev.filter(id => id !== playerId));
  };

  const togglePlayerExclude = (playerId) => {
    setExcludedPlayers(prev =>
      prev.includes(playerId)
        ? prev.filter(id => id !== playerId)
        : [...prev, playerId]
    );
    // Remove from locked if excluding
    setLockedPlayers(prev => prev.filter(id => id !== playerId));
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
      console.error('Breakdown error:', error);
    } finally {
      setLoadingBreakdown(false);
    }
  };

  const handleAutoTune = async () => {
    if (!activeSlate) {
      setMessage('No active slate. Please go to Home to select a slate.');
      return;
    }

    setAutoTuning(true);
    setMessage('');
    setAutoTuneResult(null);

    try {
      const response = await optimizerAPI.autoTune(activeSlate.slate_id, mode);

      if (response.data.success) {
        const rec = response.data.recommendations;
        setAutoTuneResult(response.data);

        // Apply recommendations based on mode
        if (mode === 'cash') {
          setMinFloor(rec.minFloor);
          setMaxVolatility(rec.maxVolatility);
          setMaxBustProbability(rec.maxBustProbability);
          setMinProjectedMinutes(rec.minProjectedMinutes);
          setMinProjection(rec.minProjection);
          setMinSalary(rec.minSalary);
          setAvoidBlowouts(rec.avoidBlowouts);
        } else {
          setMinLeverageScore(rec.minLeverageScore);
          setMinBoomProbability(rec.minBoomProbability);
          setMinCeiling(rec.minCeiling);
          setMinProjection(rec.minProjection);
          setMaxChalkPlayers(rec.maxChalkPlayers);
          setRandomness(rec.randomness);
          setMinSalary(rec.minSalary);
          setGppMode(rec.gppMode);

          // Exposure settings
          setMaxExposureChalk(rec.maxExposureChalk);
          setMaxExposureMid(rec.maxExposureMid);
          setMaxExposureLeverage(rec.maxExposureLeverage);
          setMinExposure(rec.minExposure || 0);

          // Advanced filters
          setMinUsage(rec.minUsage || 0);
          setMinRestDays(rec.minRestDays || 0);
        }

        setMessage(`✅ Auto-Tune Complete! AI has optimized your settings.`);
      } else {
        setMessage('❌ Auto-tune failed');
      }
    } catch (error) {
      setMessage(`❌ Auto-tune error: ${error.response?.data?.error || error.message}`);
      console.error('Auto-tune error:', error);
    } finally {
      setAutoTuning(false);
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
      console.error('Review error:', error);
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

        // Cash settings
        minFloor: mode === 'cash' ? minFloor : 0,
        maxVolatility: mode === 'cash' ? maxVolatility : 1,
        maxBustProbability: mode === 'cash' ? maxBustProbability : 100,
        minProjectedMinutes: mode === 'cash' ? minProjectedMinutes : 20,
        avoidBlowouts: mode === 'cash' ? avoidBlowouts : false,

        // GPP settings
        gppMode: mode === 'gpp' ? gppMode : 'balanced',
        minLeverageScore: mode === 'gpp' ? minLeverageScore : 0,
        minBoomProbability: mode === 'gpp' ? minBoomProbability : 0,
        minCeiling: mode === 'gpp' ? minCeiling : 0,
        maxChalkPlayers: mode === 'gpp' ? maxChalkPlayers : 8,
        randomness: mode === 'gpp' ? randomness : 0,

        // Exposure (multi-lineup)
        maxExposureChalk,
        maxExposureMid,
        maxExposureLeverage,
        minExposure,

        // Advanced filters
        minRestDays,
        minUsage,
        minProjection,
        filterInjured: true,
        usePaceBoost: true,

        gameStacks: [],
        teamStacks: [],
        maxPlayersPerTeam: 3,
        minDifferentTeams: 6,
        minGamesRepresented: 3,
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
      console.error('Optimization error:', error);
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

  const filteredPlayers = players.filter(player =>
    player.name.toLowerCase().includes(searchTerm.toLowerCase())
  ).sort((a, b) => {
    // Sort by leverage score for GPP, value for cash
    if (mode === 'gpp') {
      return (b.leverage_score || 0) - (a.leverage_score || 0);
    }
    return (b.value || 0) - (a.value || 0);
  });

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
                  {lockedPlayers.length} 🔒
                </span>
              )}
              {excludedPlayers.length > 0 && (
                <span className="px-2 py-1 text-xs bg-red-100 text-red-800 rounded-full font-medium">
                  {excludedPlayers.length} ❌
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
                          {player.position} • {player.team} • ${(player.salary / 1000).toFixed(1)}k
                        </div>
                        <div className="text-xs mt-1">
                          <span
                            className={`font-medium cursor-help ${
                              player.projected_points >= 45 ? 'text-green-600' :
                              player.projected_points <= 25 ? 'text-red-600' :
                              'text-gray-600'
                            }`}
                            title="Projected Fantasy Points: Expected points based on matchup, pace, usage, and recent performance"
                          >
                            {player.projected_points?.toFixed(1)} pts
                          </span>
                        </div>

                        {/* Show different metrics based on mode */}
                        <div className="flex gap-2 mt-1 text-xs flex-wrap">
                          {mode === 'cash' ? (
                            <>
                              {player.floor && (
                                <span
                                  className={`font-medium cursor-help ${
                                    player.floor >= 35 ? 'text-green-600' :
                                    player.floor <= 25 ? 'text-red-600' :
                                    'text-gray-600'
                                  }`}
                                  title="Floor: 25th percentile projection - the worst-case scenario if the player underperforms. Higher is safer for cash games."
                                >
                                  Floor: {player.floor.toFixed(1)}
                                </span>
                              )}
                              {player.volatility !== null && (
                                <span
                                  className={`font-medium cursor-help ${
                                    player.volatility < 0.15 ? 'text-green-600' :
                                    player.volatility > 0.25 ? 'text-red-600' :
                                    'text-gray-600'
                                  }`}
                                  title="Volatility: Standard deviation of recent performance. Lower values = more consistent. Cash games prefer <0.20."
                                >
                                  Vol: {player.volatility.toFixed(2)}
                                </span>
                              )}
                            </>
                          ) : (
                            <>
                              {player.leverage_score && (
                                <span
                                  className={`font-medium cursor-help ${
                                    player.leverage_score >= 4.0 ? 'text-green-600 font-bold' :
                                    player.leverage_score >= 3.0 ? 'text-green-600' :
                                    player.leverage_score <= 2.0 ? 'text-red-600' :
                                    'text-gray-600'
                                  }`}
                                  title="Leverage Score: (boom_probability × 100) / (ownership + 1). Measures upside vs ownership. Higher = better GPP value. Elite plays are 4.0+."
                                >
                                  Lev: {player.leverage_score.toFixed(1)} {player.leverage_score >= 4.0 ? '⭐' : ''}
                                </span>
                              )}
                              {player.ceiling && (
                                <span
                                  className={`font-medium cursor-help ${
                                    player.ceiling >= 55 ? 'text-green-600' :
                                    player.ceiling <= 40 ? 'text-red-600' :
                                    'text-gray-600'
                                  }`}
                                  title="Ceiling: 75th percentile projection - the upside if everything clicks. Critical for GPP tournaments."
                                >
                                  Ceil: {player.ceiling.toFixed(1)}
                                </span>
                              )}
                              {player.rostership !== null && (
                                <span
                                  className={`font-medium cursor-help ${
                                    player.rostership >= 25 ? 'text-red-600' :
                                    player.rostership <= 10 ? 'text-green-600' :
                                    'text-gray-600'
                                  }`}
                                  title="Ownership %: Projected percentage of lineups rostering this player. <10% = low-owned leverage, >25% = chalk."
                                >
                                  Own: {player.rostership.toFixed(0)}%
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-col gap-1">
                        <button
                          onClick={() => togglePlayerLock(player.id)}
                          className={`flex-shrink-0 p-1.5 rounded ${
                            isLocked
                              ? 'bg-green-600 text-white hover:bg-green-700'
                              : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                          }`}
                          title={isLocked ? 'Locked' : 'Lock player'}
                        >
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                          </svg>
                        </button>
                        <button
                          onClick={() => togglePlayerExclude(player.id)}
                          className={`flex-shrink-0 p-1.5 rounded ${
                            isExcluded
                              ? 'bg-red-600 text-white hover:bg-red-700'
                              : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                          }`}
                          title={isExcluded ? 'Excluded' : 'Exclude player'}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
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
              <h1 className="text-3xl font-bold text-gray-900">Elite NBA DFS Optimizer</h1>
              <p className="text-gray-600 mt-2">Professional-grade lineup optimizer with advanced analytics</p>
              {activeSlate && (
                <p className="text-sm text-gray-600 mt-1">
                  Active Slate: <span className="font-medium">{activeSlate.name}</span>
                </p>
              )}
            </div>
            <button
              onClick={handleSlateBreakdown}
              disabled={loadingBreakdown || !activeSlate}
              className="px-6 py-3 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-lg hover:from-purple-700 hover:to-pink-700 disabled:from-gray-400 disabled:to-gray-400 disabled:cursor-not-allowed font-bold shadow-lg flex items-center gap-2"
            >
              {loadingBreakdown ? (
                <>
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Analyzing...
                </>
              ) : (
                <>
                  🤖 AI Slate Breakdown
                </>
              )}
            </button>
          </div>
        </div>

        {/* AI Slate Breakdown Panel - Modal Overlay */}
        {slateBreakdown && showBreakdown && (
          <div className="fixed inset-0 z-50 flex items-start justify-center p-4 bg-black bg-opacity-50 overflow-y-auto">
            <div className="bg-white rounded-lg shadow-2xl w-full max-w-6xl my-8 animate-in fade-in slide-in-from-top-4 duration-200">
              {/* Header */}
              <div className="sticky top-0 z-10 px-6 py-4 border-b border-purple-200 flex items-center justify-between bg-gradient-to-r from-purple-100 to-pink-100 rounded-t-lg">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">🤖</span>
                  <div>
                    <h2 className="text-xl font-bold text-purple-900">
                      AI Slate Breakdown - {mode === 'cash' ? 'CASH GAMES' : 'GPP TOURNAMENTS'}
                    </h2>
                    <p className="text-sm text-purple-700">
                      {slateBreakdown.stats.totalPlayers} Players Analyzed • {slateBreakdown.stats.studCount} Studs • {slateBreakdown.stats.midCount} Mids • {slateBreakdown.stats.valueCount} Values
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setShowBreakdown(false)}
                  className="text-purple-600 hover:text-purple-800 hover:bg-purple-200 rounded-full p-2 transition-colors"
                  title="Close"
                >
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Content */}
              <div className="p-6 space-y-6 max-h-[calc(100vh-8rem)] overflow-y-auto">
                {/* AI Analysis */}
                <div className="bg-gradient-to-br from-purple-50 to-pink-50 rounded-lg p-6 border border-purple-200">
                  <h3 className="text-lg font-bold text-purple-900 mb-4 flex items-center gap-2">
                    <span>📝</span> Expert Analysis
                  </h3>
                  <div className="prose prose-sm max-w-none text-gray-700 leading-relaxed">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        table: ({ children }) => (
                          <div className="overflow-x-auto my-4 rounded-lg border border-gray-300 shadow-sm">
                            <table className="min-w-full border-collapse bg-white">
                              {children}
                            </table>
                          </div>
                        ),
                        thead: ({ children }) => (
                          <thead className="bg-gradient-to-r from-purple-200 to-pink-200">{children}</thead>
                        ),
                        tbody: ({ children }) => <tbody className="bg-white divide-y divide-gray-200">{children}</tbody>,
                        tr: ({ children }) => (
                          <tr className="hover:bg-purple-50 transition-colors">
                            {children}
                          </tr>
                        ),
                        th: ({ children }) => (
                          <th className="px-3 py-3 text-left text-xs font-bold text-purple-900 uppercase tracking-wider border-b-2 border-purple-300 whitespace-nowrap">
                            {children}
                          </th>
                        ),
                        td: ({ children }) => (
                          <td className="px-3 py-3 text-sm text-gray-800 border-b border-gray-200">
                            {children}
                          </td>
                        ),
                        h1: ({ children }) => (
                          <h1 className="text-2xl font-bold mb-4 mt-6 text-purple-900 border-b-2 border-purple-300 pb-2">
                            {children}
                          </h1>
                        ),
                        h2: ({ children }) => (
                          <h2 className="text-xl font-semibold mb-3 mt-5 text-purple-800">
                            {children}
                          </h2>
                        ),
                        h3: ({ children }) => (
                          <h3 className="text-lg font-semibold mb-2 mt-4 text-purple-700">
                            {children}
                          </h3>
                        ),
                        ul: ({ children }) => (
                          <ul className="list-disc list-inside space-y-2 my-3 ml-2">
                            {children}
                          </ul>
                        ),
                        ol: ({ children }) => (
                          <ol className="list-decimal list-inside space-y-2 my-3 ml-2">
                            {children}
                          </ol>
                        ),
                        li: ({ children }) => (
                          <li className="text-gray-700 leading-relaxed">{children}</li>
                        ),
                        p: ({ children }) => (
                          <p className="my-3 text-gray-700 leading-relaxed">
                            {children}
                          </p>
                        ),
                        strong: ({ children }) => (
                          <strong className="font-bold text-gray-900">
                            {children}
                          </strong>
                        ),
                        em: ({ children }) => (
                          <em className="italic text-gray-700">{children}</em>
                        ),
                        blockquote: ({ children }) => (
                          <blockquote className="border-l-4 border-purple-500 pl-4 py-2 my-4 italic text-gray-700 bg-purple-50 rounded-r">
                            {children}
                          </blockquote>
                        ),
                        code: ({ inline, children }) =>
                          inline ? (
                            <code className="bg-purple-100 text-purple-800 px-2 py-0.5 rounded text-sm font-mono">
                              {children}
                            </code>
                          ) : (
                            <code className="block bg-gray-900 text-gray-100 p-4 rounded-lg text-sm font-mono overflow-x-auto my-3">
                              {children}
                            </code>
                          ),
                      }}
                    >
                      {slateBreakdown.aiAnalysis}
                    </ReactMarkdown>
                  </div>
                </div>

                {/* Quick Stats Grid */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="bg-white rounded-lg p-4 border border-purple-200 shadow-sm">
                    <div className="text-xs text-gray-600 font-medium uppercase tracking-wide">Avg Projection</div>
                    <div className="text-2xl font-bold text-purple-600 mt-1">
                      {(slateBreakdown.stats.avgProjection || 0).toFixed(1)}
                    </div>
                  </div>
                  <div className="bg-white rounded-lg p-4 border border-pink-200 shadow-sm">
                    <div className="text-xs text-gray-600 font-medium uppercase tracking-wide">Avg Ownership</div>
                    <div className="text-2xl font-bold text-pink-600 mt-1">
                      {(slateBreakdown.stats.avgOwnership || 0).toFixed(1)}%
                    </div>
                  </div>
                  <div className="bg-white rounded-lg p-4 border border-green-200 shadow-sm">
                    <div className="text-xs text-gray-600 font-medium uppercase tracking-wide">Leverage Plays</div>
                    <div className="text-2xl font-bold text-green-600 mt-1">
                      {slateBreakdown.stats.leveragePlayCount || 0}
                    </div>
                  </div>
                  <div className="bg-white rounded-lg p-4 border border-red-200 shadow-sm">
                    <div className="text-xs text-gray-600 font-medium uppercase tracking-wide">Chalk Plays</div>
                    <div className="text-2xl font-bold text-red-600 mt-1">
                      {slateBreakdown.stats.highOwnershipCount || 0}
                    </div>
                  </div>
                </div>

              {/* Top Plays by Category */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Studs */}
                <div className="bg-white rounded-lg p-4 border border-purple-200">
                  <h4 className="font-bold text-purple-900 mb-3 flex items-center gap-2">
                    <span>💎</span> Top Studs
                  </h4>
                  <div className="space-y-2 text-sm">
                    {slateBreakdown.categories.studs.slice(0, 5).map((p, i) => (
                      <div key={i} className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{p.name}</div>
                          <div className="text-xs text-gray-500">
                            ${((p.salary || 0) / 1000).toFixed(1)}k • {(p.projection || 0).toFixed(1)} pts
                          </div>
                        </div>
                        <div className="ml-2 text-xs">
                          <span className={`font-bold ${(p.leverage || 0) >= 2.0 ? 'text-green-600' : 'text-gray-600'}`}>
                            L: {(p.leverage || 0).toFixed(1)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Mids */}
                <div className="bg-white rounded-lg p-4 border border-purple-200">
                  <h4 className="font-bold text-purple-900 mb-3 flex items-center gap-2">
                    <span>🎯</span> Top Mids
                  </h4>
                  <div className="space-y-2 text-sm">
                    {slateBreakdown.categories.mids.slice(0, 5).map((p, i) => (
                      <div key={i} className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{p.name}</div>
                          <div className="text-xs text-gray-500">
                            ${((p.salary || 0) / 1000).toFixed(1)}k • {(p.projection || 0).toFixed(1)} pts
                          </div>
                        </div>
                        <div className="ml-2 text-xs">
                          <span className={`font-bold ${(p.leverage || 0) >= 3.0 ? 'text-green-600' : 'text-gray-600'}`}>
                            L: {(p.leverage || 0).toFixed(1)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Values */}
                <div className="bg-white rounded-lg p-4 border border-purple-200">
                  <h4 className="font-bold text-purple-900 mb-3 flex items-center gap-2">
                    <span>💰</span> Top Values
                  </h4>
                  <div className="space-y-2 text-sm">
                    {slateBreakdown.categories.values.slice(0, 5).map((p, i) => (
                      <div key={i} className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{p.name}</div>
                          <div className="text-xs text-gray-500">
                            ${((p.salary || 0) / 1000).toFixed(1)}k • {(p.projection || 0).toFixed(1)} pts
                          </div>
                        </div>
                        <div className="ml-2 text-xs">
                          <span className={`font-bold ${(p.leverage || 0) >= 4.0 ? 'text-green-600 font-extrabold' : 'text-gray-600'}`}>
                            L: {(p.leverage || 0).toFixed(1)} {(p.leverage || 0) >= 4.0 && '⭐'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Leverage & Chalk Plays */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-green-50 rounded-lg p-4 border border-green-300">
                  <h4 className="font-bold text-green-900 mb-3 flex items-center gap-2">
                    <span>⚡</span> Elite Leverage Plays
                  </h4>
                  <div className="space-y-1 text-sm">
                    {slateBreakdown.leveragePlays.slice(0, 5).map((p, i) => (
                      <div key={i} className="flex items-center justify-between text-green-900">
                        <span className="font-medium">{p.name}</span>
                        <span className="text-xs">
                          Lev: <span className="font-bold">{(p.leverage || 0).toFixed(1)}</span> ({(p.ownership || 0).toFixed(0)}% own)
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="bg-red-50 rounded-lg p-4 border border-red-300">
                  <h4 className="font-bold text-red-900 mb-3 flex items-center gap-2">
                    <span>🔥</span> Chalk Plays (Fade or Play?)
                  </h4>
                  <div className="space-y-1 text-sm">
                    {slateBreakdown.chalkPlays.slice(0, 5).map((p, i) => (
                      <div key={i} className="flex items-center justify-between text-red-900">
                        <span className="font-medium">{p.name}</span>
                        <span className="text-xs">
                          <span className="font-bold">{(p.ownership || 0).toFixed(0)}%</span> owned
                        </span>
                      </div>
                    ))}
                    {slateBreakdown.chalkPlays.length === 0 && (
                      <div className="text-gray-600 text-xs">No high-owned plays identified</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
          </div>
        )}

        {/* Settings Panel */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-xl font-semibold mb-4">Optimization Settings</h2>

          {!activeSlate && (
            <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-md">
              <p className="text-yellow-800 text-sm">
                No active slate selected. Please{' '}
                <Link to="/" className="font-medium underline">go to Home</Link>{' '}
                to select a slate first.
              </p>
            </div>
          )}

          {/* Auto-Tune Banner */}
          <div className="mb-6 p-4 bg-gradient-to-r from-green-50 to-blue-50 border-2 border-green-300 rounded-lg">
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                  🤖 AI-Powered Auto-Tune
                </h3>
                <p className="text-sm text-gray-700 mt-1">
                  Let AI analyze your {players.length} players and automatically set optimal filters for {mode === 'cash' ? 'cash games' : 'GPP tournaments'}
                </p>
              </div>
              <button
                onClick={handleAutoTune}
                disabled={autoTuning || !activeSlate}
                className="ml-4 px-6 py-3 bg-gradient-to-r from-green-600 to-blue-600 text-white rounded-lg hover:from-green-700 hover:to-blue-700 disabled:from-gray-400 disabled:to-gray-400 disabled:cursor-not-allowed font-bold shadow-lg flex items-center gap-2"
              >
                {autoTuning ? (
                  <>
                    <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Analyzing...
                  </>
                ) : (
                  <>
                    ⚡ Auto-Tune Settings
                  </>
                )}
              </button>
            </div>

            {/* Auto-Tune Result - AI Analysis */}
            {autoTuneResult && autoTuneResult.aiAnalysis && (
              <div className="mt-4 p-3 bg-white rounded-md border border-green-300">
                <h4 className="text-sm font-semibold text-green-700 mb-2">🤖 AI Strategic Analysis</h4>
                <div className="text-xs text-gray-700 whitespace-pre-wrap prose prose-sm max-w-none">
                  {autoTuneResult.aiAnalysis}
                </div>
              </div>
            )}
          </div>

          {/* Core Settings */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Contest Type
              </label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
              >
                <option value="cash">💵 Cash Game (Safety/Floor)</option>
                <option value="gpp">🏆 GPP/Tournament (Leverage/Ceiling)</option>
              </select>
            </div>

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
                step="500"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* Cash Game Specific Settings */}
          {mode === 'cash' && (
            <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <h3 className="text-md font-semibold mb-3 text-blue-900">💵 Cash Game Filters</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Min Floor
                  </label>
                  <input
                    type="number"
                    value={minFloor}
                    onChange={(e) => setMinFloor(parseFloat(e.target.value))}
                    min="0"
                    max="60"
                    step="5"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">25th percentile projection</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Max Volatility
                  </label>
                  <input
                    type="number"
                    value={maxVolatility}
                    onChange={(e) => setMaxVolatility(parseFloat(e.target.value))}
                    min="0"
                    max="1"
                    step="0.05"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">Consistency (lower = safer)</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Max Bust %
                  </label>
                  <input
                    type="number"
                    value={maxBustProbability}
                    onChange={(e) => setMaxBustProbability(parseInt(e.target.value))}
                    min="0"
                    max="100"
                    step="5"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">Failure probability limit</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Min Minutes
                  </label>
                  <input
                    type="number"
                    value={minProjectedMinutes}
                    onChange={(e) => setMinProjectedMinutes(parseInt(e.target.value))}
                    min="0"
                    max="48"
                    step="2"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">Guaranteed playing time</p>
                </div>
              </div>

              <div className="mt-4">
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={avoidBlowouts}
                    onChange={(e) => setAvoidBlowouts(e.target.checked)}
                    className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <div>
                    <div className="text-sm font-medium text-gray-700">Avoid Blowout Risk</div>
                    <p className="text-xs text-gray-500">Exclude players in games with spread &gt;10</p>
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* GPP Specific Settings */}
          {mode === 'gpp' && (
            <div className="mb-6 p-4 bg-purple-50 border border-purple-200 rounded-lg">
              <h3 className="text-md font-semibold mb-3 text-purple-900">🏆 GPP/Tournament Filters</h3>

              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  GPP Strategy
                </label>
                <select
                  value={gppMode}
                  onChange={(e) => setGppMode(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-purple-500"
                >
                  <option value="max_leverage">⚡ Max Leverage (Pure Contrarian)</option>
                  <option value="balanced">⚖️ Balanced (Mix Chalk + Leverage)</option>
                  <option value="contrarian">🎲 Contrarian Chaos (Ultra Low-Owned)</option>
                </select>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Min Leverage Score
                  </label>
                  <input
                    type="number"
                    value={minLeverageScore}
                    onChange={(e) => setMinLeverageScore(parseFloat(e.target.value))}
                    min="0"
                    max="10"
                    step="0.5"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-purple-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">boom% / (own% + 1)</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Min Boom %
                  </label>
                  <input
                    type="number"
                    value={minBoomProbability}
                    onChange={(e) => setMinBoomProbability(parseInt(e.target.value))}
                    min="0"
                    max="100"
                    step="5"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-purple-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">Upside probability</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Min Ceiling
                  </label>
                  <input
                    type="number"
                    value={minCeiling}
                    onChange={(e) => setMinCeiling(parseInt(e.target.value))}
                    min="0"
                    max="100"
                    step="5"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-purple-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">75th percentile projection</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Max Chalk Players
                  </label>
                  <input
                    type="number"
                    value={maxChalkPlayers}
                    onChange={(e) => setMaxChalkPlayers(parseInt(e.target.value))}
                    min="0"
                    max="8"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-purple-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">Max players &gt;25% owned</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Randomness %
                  </label>
                  <input
                    type="number"
                    value={randomness}
                    onChange={(e) => setRandomness(parseInt(e.target.value))}
                    min="0"
                    max="30"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-purple-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">Variance injection (0-30)</p>
                </div>
              </div>
            </div>
          )}

          {/* Exposure Settings (Multi-Lineup) */}
          {numLineups > 1 && (
            <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
              <h3 className="text-md font-semibold mb-3 text-green-900">📊 Exposure Limits</h3>

              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Minimum Exposure % (All Players)
                </label>
                <input
                  type="number"
                  value={minExposure}
                  onChange={(e) => setMinExposure(parseInt(e.target.value))}
                  min="0"
                  max="100"
                  step="5"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-green-500"
                />
                <p className="text-xs text-gray-500 mt-1">
                  If a player appears in any lineup, guarantee at least {minExposure}% usage (0 = disabled)
                </p>
              </div>

              <h4 className="text-sm font-semibold mb-2 text-gray-700">Maximum Exposure by Ownership Tier:</h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Chalk (&gt;25% own)
                  </label>
                  <input
                    type="number"
                    value={maxExposureChalk}
                    onChange={(e) => setMaxExposureChalk(parseInt(e.target.value))}
                    min="0"
                    max="100"
                    step="5"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-green-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">Max {maxExposureChalk}% in lineups</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Mid (10-25% own)
                  </label>
                  <input
                    type="number"
                    value={maxExposureMid}
                    onChange={(e) => setMaxExposureMid(parseInt(e.target.value))}
                    min="0"
                    max="100"
                    step="5"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-green-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">Max {maxExposureMid}% in lineups</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Leverage (&lt;10% own)
                  </label>
                  <input
                    type="number"
                    value={maxExposureLeverage}
                    onChange={(e) => setMaxExposureLeverage(parseInt(e.target.value))}
                    min="0"
                    max="100"
                    step="5"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-green-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">Max {maxExposureLeverage}% in lineups</p>
                </div>
              </div>
            </div>
          )}

          {/* Advanced Filters Toggle */}
          <div className="mb-4">
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-sm text-blue-600 hover:text-blue-800 font-medium flex items-center gap-2"
            >
              {showAdvanced ? '▼' : '▶'} Advanced Filters
            </button>
          </div>

          {showAdvanced && (
            <div className="mb-6 p-4 bg-gray-50 border border-gray-200 rounded-lg">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Min Rest Days
                  </label>
                  <input
                    type="number"
                    value={minRestDays}
                    onChange={(e) => setMinRestDays(parseInt(e.target.value))}
                    min="0"
                    max="7"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-gray-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">0 = back-to-back OK</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Min Usage %
                  </label>
                  <input
                    type="number"
                    value={minUsage}
                    onChange={(e) => setMinUsage(parseInt(e.target.value))}
                    min="0"
                    max="40"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-gray-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">Team play % threshold</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Min Projection
                  </label>
                  <input
                    type="number"
                    value={minProjection}
                    onChange={(e) => setMinProjection(parseInt(e.target.value))}
                    min="0"
                    max="100"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-gray-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">Minimum fantasy points</p>
                </div>
              </div>
            </div>
          )}

          {/* Optimize Button */}
          <div className="mt-6">
            {lockedPlayers.length > 0 && (
              <div className="mb-3 p-3 bg-green-50 border border-green-200 rounded-md">
                <p className="text-sm text-green-800">
                  🔒 <strong>{lockedPlayers.length} player(s) locked</strong> - Will be included in every lineup
                </p>
              </div>
            )}
            {excludedPlayers.length > 0 && (
              <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-md">
                <p className="text-sm text-red-800">
                  ❌ <strong>{excludedPlayers.length} player(s) excluded</strong> - Will not be in any lineup
                </p>
              </div>
            )}
            <button
              onClick={handleOptimize}
              disabled={loading || !activeSlate}
              className="w-full bg-gradient-to-r from-blue-600 to-purple-600 text-white py-4 px-6 rounded-lg hover:from-blue-700 hover:to-purple-700 disabled:from-gray-400 disabled:to-gray-400 disabled:cursor-not-allowed font-bold text-lg shadow-lg"
            >
              {loading ? '🔄 Optimizing...' : `🚀 Generate ${numLineups === 1 ? 'Optimal Lineup' : `${numLineups} Lineups`}`}
            </button>
          </div>

          {message && (
            <div className={`mt-4 p-4 rounded-md ${message.startsWith('✅') ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
              {message}
            </div>
          )}
        </div>

        {/* Results */}
        {results && results.lineups && results.lineups.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Lineup Selector */}
            {results.lineups.length > 1 && (
              <div className="lg:col-span-1">
                <div className="bg-white rounded-lg shadow p-4">
                  <h3 className="font-semibold mb-3">Generated Lineups ({results.lineups.length})</h3>
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
                        {lineup.analytics && (
                          <div className="text-xs text-gray-500 mt-1">
                            Floor: {lineup.analytics.totalFloor} • Ceil: {lineup.analytics.totalCeiling}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Exposure Stats */}
                {results.exposureStats && (
                  <div className="bg-white rounded-lg shadow p-4 mt-4">
                    <h3 className="font-semibold mb-3">Player Exposure</h3>
                    <div className="space-y-2 max-h-[300px] overflow-y-auto">
                      {results.exposureStats.slice(0, 15).map((stat, index) => (
                        <div key={index} className="flex items-center justify-between text-sm">
                          <div className="flex-1 min-w-0">
                            <div className="truncate font-medium">{stat.name}</div>
                            <div className="text-xs text-gray-500">
                              Own: {stat.ownership.toFixed(0)}% • Lev: {stat.leverage.toFixed(1)}
                            </div>
                          </div>
                          <span className={`ml-2 font-bold ${
                            parseFloat(stat.exposure) >= 50 ? 'text-red-600' :
                            parseFloat(stat.exposure) >= 30 ? 'text-yellow-600' :
                            'text-green-600'
                          }`}>
                            {stat.exposure}%
                          </span>
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
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleReviewLineup(currentLineup)}
                      disabled={reviewingLineup}
                      className="px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 font-medium disabled:opacity-50"
                    >
                      {reviewingLineup ? '🤖 Analyzing...' : '🤖 AI Review'}
                    </button>
                    <button
                      onClick={() => handleSaveLineup(currentLineup, selectedLineupIndex)}
                      className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 font-medium"
                    >
                      💾 Save Lineup
                    </button>
                  </div>
                </div>

                {/* Enhanced Lineup Summary */}
                {currentLineup.analytics && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6 p-4 bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg border border-blue-200">
                    <div>
                      <div className="text-xs text-gray-600 font-medium">Salary</div>
                      <div className="text-lg font-bold text-gray-900">
                        ${currentLineup.totalSalary.toLocaleString()}
                      </div>
                      <div className="text-xs text-gray-500">${currentLineup.remainingSalary} left</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-600 font-medium">Projection</div>
                      <div className="text-lg font-bold text-blue-600">
                        {currentLineup.projectedPoints.toFixed(1)} pts
                      </div>
                      <div className="text-xs text-gray-500">Floor/Ceil: {currentLineup.analytics.totalFloor}/{currentLineup.analytics.totalCeiling}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-600 font-medium">Ownership</div>
                      <div className="text-lg font-bold text-purple-600">
                        {currentLineup.analytics.avgOwnership}%
                      </div>
                      <div className="text-xs text-gray-500">Leverage: {currentLineup.analytics.totalLeverage}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-600 font-medium">Volatility</div>
                      <div className="text-lg font-bold text-gray-700">
                        {currentLineup.analytics.avgVolatility}
                      </div>
                      <div className="text-xs text-gray-500">Boom: {currentLineup.analytics.avgBoomProb}%</div>
                    </div>
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
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Floor</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Ceil</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Own%</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Lev</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {currentLineup.players.map((slot, index) => (
                        <tr key={index} className="hover:bg-gray-50">
                          <td className="px-4 py-3 whitespace-nowrap">
                            <span className="px-2 py-1 text-xs font-bold rounded bg-blue-100 text-blue-800">
                              {slot.position}
                            </span>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <div className="font-medium text-sm">{slot.player?.name}</div>
                            <div className="text-xs text-gray-500">{slot.player?.team} vs {slot.player?.opponent}</div>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm">${slot.player?.salary?.toLocaleString()}</td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm font-bold text-gray-900">
                            {slot.player?.projected_points?.toFixed(1)}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-green-600">
                            {slot.player?.floor?.toFixed(1) || '-'}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-purple-600">
                            {slot.player?.ceiling?.toFixed(1) || '-'}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm">
                            <span className={`font-medium ${
                              (slot.player?.rostership || 0) >= 25 ? 'text-red-600' :
                              (slot.player?.rostership || 0) <= 10 ? 'text-green-600' :
                              'text-gray-600'
                            }`}>
                              {slot.player?.rostership?.toFixed(0) || 0}%
                            </span>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm">
                            <span className={`font-bold ${
                              (slot.player?.leverage_score || 0) >= 4.0 ? 'text-green-600' :
                              (slot.player?.leverage_score || 0) >= 3.0 ? 'text-blue-600' :
                              'text-gray-600'
                            }`}>
                              {slot.player?.leverage_score?.toFixed(1) || '-'}
                              {(slot.player?.leverage_score || 0) >= 4.0 && ' ⭐'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* AI Lineup Review */}
                {lineupReview && (
                  <div className="mt-6 p-4 bg-gradient-to-r from-purple-50 to-pink-50 rounded-lg border border-purple-200">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-lg font-semibold text-purple-800">🤖 AI Lineup Review</h4>
                      <button
                        onClick={() => setLineupReview(null)}
                        className="text-gray-500 hover:text-gray-700 text-xl"
                      >
                        ×
                      </button>
                    </div>
                    <div className="prose prose-sm max-w-none text-gray-700 whitespace-pre-wrap">
                      {lineupReview.review}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Info Box */}
        {!results && !loading && (
          <div className="bg-gradient-to-br from-blue-50 to-purple-50 rounded-lg p-6 border border-blue-200">
            <h3 className="text-lg font-bold text-gray-900 mb-3">🚀 Elite Features</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <h4 className="font-semibold text-blue-900 mb-2">💵 Cash Game Mode</h4>
                <ul className="list-disc list-inside space-y-1 text-sm text-gray-700">
                  <li>Maximizes floor (25th percentile)</li>
                  <li>Filters by low volatility & bust%</li>
                  <li>Avoids blowout risk players</li>
                  <li>Prioritizes consistency & safety</li>
                </ul>
              </div>
              <div>
                <h4 className="font-semibold text-purple-900 mb-2">🏆 GPP/Tournament Mode</h4>
                <ul className="list-disc list-inside space-y-1 text-sm text-gray-700">
                  <li>Maximizes leverage score</li>
                  <li>Targets boom probability & ceiling</li>
                  <li>Limits chalk (high ownership)</li>
                  <li>3 strategies: Max Leverage, Balanced, Contrarian</li>
                </ul>
              </div>
            </div>
            <div className="mt-4 p-3 bg-blue-100 rounded border border-blue-300">
              <p className="text-sm text-blue-900">
                💡 <strong>Pro Tip:</strong> Use player locks (🔒) to force specific players into every lineup,
                or exclude (❌) to remove them entirely. Adjust filters based on your risk tolerance!
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
    </>
  );
}

export default OptimizerPage;
