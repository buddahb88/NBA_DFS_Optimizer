import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { playersAPI, slatesAPI, historicalAPI } from '../services/api';

// Helper to format date for input
const formatDateForInput = (date) => {
  if (!date) return '';
  const d = new Date(date);
  return d.toISOString().split('T')[0];
};

// Get yesterday's date as default end date
const getYesterday = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return formatDateForInput(d);
};

function InsightCard({ title, icon, children, color = 'blue' }) {
  const colorClasses = {
    blue: 'bg-blue-50 border-blue-200',
    green: 'bg-green-50 border-green-200',
    red: 'bg-red-50 border-red-200',
    yellow: 'bg-yellow-50 border-yellow-200',
    purple: 'bg-purple-50 border-purple-200',
    orange: 'bg-orange-50 border-orange-200',
  };

  return (
    <div className={`rounded-lg border-2 ${colorClasses[color]} p-4`}>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xl">{icon}</span>
        <h3 className="font-semibold text-gray-900">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function PlayerRow({ player, showReason = true }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-gray-900 truncate">{player.name}</span>
          <span className="text-xs text-gray-500">{player.team}</span>
          {player.opponent && (
            <span className="text-xs text-gray-400">vs {player.opponent}</span>
          )}
        </div>
        {showReason && player.reason && (
          <div className="text-xs text-gray-600 mt-0.5">{player.reason}</div>
        )}
      </div>
      <div className="flex items-center gap-3 text-sm">
        {player.salary && (
          <span className="text-gray-500">${(player.salary / 1000).toFixed(1)}k</span>
        )}
        {player.last3Avg && (
          <span className="font-semibold text-gray-900">{player.last3Avg}</span>
        )}
        {player.hotStreakPct !== undefined && (
          <span className={`font-semibold ${player.hotStreakPct >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {player.hotStreakPct >= 0 ? '+' : ''}{player.hotStreakPct}%
          </span>
        )}
      </div>
    </div>
  );
}

function InsightsPage() {
  const [activeSlate, setActiveSlate] = useState(null);
  const [players, setPlayers] = useState([]);
  const [insights, setInsights] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('slate'); // 'slate' or 'league'
  const [leagueData, setLeagueData] = useState(null);
  const [usageBumps, setUsageBumps] = useState([]);
  const [missingPlayers, setMissingPlayers] = useState([]);

  // Date filter state for backtesting
  const [startDate, setStartDate] = useState('2025-10-21'); // Season start
  const [endDate, setEndDate] = useState(getYesterday());
  const [dateFilterEnabled, setDateFilterEnabled] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async (useFilters = false) => {
    setLoading(true);
    try {
      // Build date filter params
      const dateParams = useFilters && dateFilterEnabled
        ? { startDate, endDate }
        : {};

      // Load historical summary
      const summaryRes = await historicalAPI.getSummary(dateParams);
      if (summaryRes.data?.summary) {
        setSummary(summaryRes.data.summary);
      }

      // Load active slate and players
      const slateRes = await slatesAPI.getActiveSlate();
      if (slateRes.data) {
        setActiveSlate(slateRes.data);
        const playersRes = await playersAPI.getBySlateId(slateRes.data.slate_id);
        setPlayers(playersRes.data || []);

        // Get slate-specific insights
        if (playersRes.data?.length > 0) {
          const [insightsRes, usageBumpsRes, missingRes] = await Promise.all([
            historicalAPI.getSlateInsights(playersRes.data, dateParams),
            historicalAPI.getUsageBumps(playersRes.data),
            historicalAPI.getMissingPlayers(playersRes.data),
          ]);

          if (insightsRes.data?.insights) {
            setInsights(insightsRes.data.insights);
          }
          if (usageBumpsRes.data?.usageBumps) {
            setUsageBumps(usageBumpsRes.data.usageBumps);
          }
          if (missingRes.data?.report) {
            setMissingPlayers(missingRes.data.report);
          }
        }
      }

      // Load league-wide data
      const [hotRes, coldRes, consistentRes, boomRes] = await Promise.all([
        historicalAPI.getHotStreaks(15, 5, dateParams),
        historicalAPI.getColdStreaks(15, 5, dateParams),
        historicalAPI.getConsistencyLeaders(15, 8, dateParams),
        historicalAPI.getBoomBustPlayers(15, 8, dateParams),
      ]);

      setLeagueData({
        hotStreaks: hotRes.data?.hotStreaks || [],
        coldStreaks: coldRes.data?.coldStreaks || [],
        consistencyLeaders: consistentRes.data?.leaders || [],
        boomBustPlayers: boomRes.data?.players || [],
      });
    } catch (error) {
      console.error('Error loading insights:', error);
    } finally {
      setLoading(false);
    }
  };

  // Reload when date filters change
  const applyDateFilter = () => {
    loadData(true);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Analyzing historical data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Historical Insights</h1>
          {summary && (
            <p className="text-sm text-gray-600 mt-1">
              Analyzing {summary.totalGames?.toLocaleString()} games from {summary.uniquePlayers} players
              <span className="text-gray-400 ml-2">
                ({summary.dateRange?.earliest} to {summary.dateRange?.latest})
              </span>
            </p>
          )}
        </div>
        <button
          onClick={() => loadData(dateFilterEnabled)}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
        >
          Refresh Data
        </button>
      </div>

      {/* Backtesting Date Filter */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={dateFilterEnabled}
              onChange={(e) => setDateFilterEnabled(e.target.checked)}
              className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
            />
            <span className="text-sm font-medium text-gray-700">Backtest Mode</span>
          </label>

          {dateFilterEnabled && (
            <>
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-600">From:</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="px-2 py-1 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-600">To:</label>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="px-2 py-1 border border-gray-300 rounded text-sm focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <button
                onClick={applyDateFilter}
                className="px-3 py-1 bg-green-600 text-white rounded text-sm font-medium hover:bg-green-700"
              >
                Apply Filter
              </button>
              <span className="text-xs text-gray-500 italic">
                Shows insights based only on games within this date range
              </span>
            </>
          )}

          {!dateFilterEnabled && (
            <span className="text-xs text-gray-500">
              Enable to filter historical data for backtesting past slates
            </span>
          )}
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-4">
          <button
            onClick={() => setActiveTab('slate')}
            className={`pb-3 px-1 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'slate'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Tonight's Slate
          </button>
          <button
            onClick={() => setActiveTab('league')}
            className={`pb-3 px-1 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'league'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            League-Wide Trends
          </button>
        </nav>
      </div>

      {/* Slate Insights Tab */}
      {activeTab === 'slate' && (
        <>
          {!activeSlate ? (
            <div className="text-center py-12 bg-white rounded-lg shadow">
              <p className="text-gray-500 mb-4">No active slate selected.</p>
              <Link
                to="/"
                className="inline-block px-6 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 font-medium"
              >
                Go to Home to Select a Slate
              </Link>
            </div>
          ) : !insights ? (
            <div className="text-center py-12 bg-white rounded-lg shadow">
              <p className="text-gray-500">No historical data available for players in this slate.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {/* Usage Bumps - Most Valuable! */}
              {usageBumps?.length > 0 && (
                <InsightCard title="🔥 Usage Bump Opportunities" icon="📊" color="purple">
                  <div className="space-y-3 max-h-96 overflow-y-auto">
                    {usageBumps.map((player, i) => (
                      <div key={i} className="py-2 px-2 border border-purple-100 rounded-lg bg-purple-50/30 hover:bg-purple-50/50 transition-colors">
                        {/* Row 1: Name, Position, Team, Opponent */}
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-gray-900">{player.player}</span>
                            {player.position && (
                              <span className="text-xs px-1.5 py-0.5 bg-gray-200 text-gray-700 rounded">{player.position}</span>
                            )}
                            <span className="text-xs text-gray-500">{player.team}</span>
                            {player.opponent && (
                              <span className="text-xs text-gray-400">vs {player.opponent}</span>
                            )}
                          </div>
                          <span className="font-bold text-purple-600 text-lg">+{player.pctBump}%</span>
                        </div>

                        {/* Row 2: Key Stats */}
                        <div className="flex flex-wrap items-center gap-3 text-xs mb-1">
                          {player.salary > 0 && (
                            <span className="text-gray-600">
                              <span className="font-medium">${(player.salary / 1000).toFixed(1)}k</span>
                            </span>
                          )}
                          {player.projectedMinutes && (
                            <span className="text-green-700 font-medium">
                              {player.projectedMinutes} min
                            </span>
                          )}
                          {player.projection > 0 && (
                            <span className="text-gray-600">
                              Proj: <span className="font-medium">{player.projection}</span>
                              {player.bumpedProjection && (
                                <span className="text-purple-600"> → {player.bumpedProjection}</span>
                              )}
                            </span>
                          )}
                          {player.valueScore > 0 && (
                            <span className="text-blue-600 font-medium" title="Value Score (bumped proj / salary × 1000)">
                              {player.valueScore}x value
                            </span>
                          )}
                          {player.confidence && (
                            <span className={`px-1.5 py-0.5 rounded text-xs ${
                              player.confidence === 'High' ? 'bg-green-100 text-green-700' :
                              player.confidence === 'Medium' ? 'bg-yellow-100 text-yellow-700' :
                              'bg-gray-100 text-gray-600'
                            }`}>
                              {player.confidence}
                            </span>
                          )}
                        </div>

                        {/* Row 3: Missing Player Info */}
                        <div className="text-xs text-gray-600">
                          <span className="font-medium">{player.avgWith}</span> → <span className="font-medium text-purple-700">{player.avgWithout}</span> DK pts
                          <span className="text-gray-400 mx-1">|</span>
                          <span className="font-medium">{player.avgMinWith}</span> → <span className="font-medium text-green-700">{player.avgMinWithout}</span> min
                          <span className="text-gray-400 mx-1">when</span>
                          <span className="font-medium text-red-600">{player.missingPlayer}</span>
                          <span className="text-gray-400"> OUT</span>
                        </div>

                        {/* Row 4: Sample Size */}
                        <div className="text-xs text-gray-400 mt-0.5">
                          ({player.gamesWithout} games without, {player.gamesWith} with)
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="text-xs text-gray-400 mt-2 italic">
                    Sorted by projected minutes + value score. Lock in high-minute players with strong bumps!
                  </div>
                </InsightCard>
              )}

              {/* Missing Players Report */}
              {missingPlayers?.length > 0 && (
                <InsightCard title="Missing High-Usage Players" icon="🚨" color="red">
                  <div className="space-y-3 max-h-72 overflow-y-auto">
                    {missingPlayers.map((team, i) => (
                      <div key={i} className="border-b border-gray-100 last:border-0 pb-2">
                        <div className="font-medium text-gray-900 mb-1">{team.team}</div>
                        {team.missingPlayers.map((player, j) => (
                          <div key={j} className="flex items-center justify-between text-sm pl-2">
                            <span className="text-red-600">{player.name}</span>
                            <span className="text-gray-500">{player.avgDk} avg DK</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                  <div className="text-xs text-gray-400 mt-2 italic">
                    These players typically play but are not on tonight's slate
                  </div>
                </InsightCard>
              )}

              {/* Hot Streaks */}
              {insights.hotStreaks?.length > 0 && (
                <InsightCard title="Hot Streaks" icon="🔥" color="green">
                  <div className="space-y-1 max-h-64 overflow-y-auto">
                    {insights.hotStreaks.map((player, i) => (
                      <PlayerRow key={i} player={player} />
                    ))}
                  </div>
                </InsightCard>
              )}

              {/* Cold Streaks */}
              {insights.coldStreaks?.length > 0 && (
                <InsightCard title="Cold Streaks (Avoid)" icon="🥶" color="red">
                  <div className="space-y-1 max-h-64 overflow-y-auto">
                    {insights.coldStreaks.map((player, i) => (
                      <PlayerRow key={i} player={player} />
                    ))}
                  </div>
                </InsightCard>
              )}

              {/* Matchup Advantages */}
              {insights.matchupAdvantages?.length > 0 && (
                <InsightCard title="Matchup Advantages" icon="🎯" color="purple">
                  <div className="space-y-1 max-h-64 overflow-y-auto">
                    {insights.matchupAdvantages.map((player, i) => (
                      <PlayerRow key={i} player={player} />
                    ))}
                  </div>
                </InsightCard>
              )}

              {/* Recent Performers */}
              {insights.recentPerformers?.length > 0 && (
                <InsightCard title="Recent Performers (30+ L3)" icon="📈" color="blue">
                  <div className="space-y-1 max-h-64 overflow-y-auto">
                    {insights.recentPerformers.map((player, i) => (
                      <PlayerRow key={i} player={player} />
                    ))}
                  </div>
                </InsightCard>
              )}

              {/* Consistent Plays (Cash Games) */}
              {insights.consistentPlays?.length > 0 && (
                <InsightCard title="Consistent Plays (Cash)" icon="💰" color="yellow">
                  <div className="space-y-1 max-h-64 overflow-y-auto">
                    {insights.consistentPlays.map((player, i) => (
                      <PlayerRow key={i} player={player} />
                    ))}
                  </div>
                </InsightCard>
              )}

              {/* Boom Candidates (GPP) */}
              {insights.boomCandidates?.length > 0 && (
                <InsightCard title="Boom Candidates (GPP)" icon="💥" color="orange">
                  <div className="space-y-1 max-h-64 overflow-y-auto">
                    {insights.boomCandidates.map((player, i) => (
                      <PlayerRow key={i} player={player} />
                    ))}
                  </div>
                </InsightCard>
              )}
            </div>
          )}

          {/* Quick Stats Summary */}
          {activeSlate && insights && (
            <div className="bg-white rounded-lg shadow p-4">
              <h3 className="font-semibold text-gray-900 mb-3">Slate Quick Stats</h3>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-center">
                <div>
                  <div className="text-2xl font-bold text-purple-600">{usageBumps?.length || 0}</div>
                  <div className="text-xs text-gray-500">Usage Bumps</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-green-600">{insights.hotStreaks?.length || 0}</div>
                  <div className="text-xs text-gray-500">Hot Players</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-red-600">{insights.coldStreaks?.length || 0}</div>
                  <div className="text-xs text-gray-500">Cold Players</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-blue-600">{insights.matchupAdvantages?.length || 0}</div>
                  <div className="text-xs text-gray-500">Matchup Edges</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-orange-600">{insights.boomCandidates?.length || 0}</div>
                  <div className="text-xs text-gray-500">Boom Candidates</div>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* League-Wide Tab */}
      {activeTab === 'league' && leagueData && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* League Hot Streaks */}
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-xl">🔥</span>
              <h3 className="font-semibold text-gray-900">League-Wide Hot Streaks</h3>
            </div>
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {leagueData.hotStreaks.map((player, i) => (
                <div key={i} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                  <div>
                    <span className="font-medium text-gray-900">{player.player_name}</span>
                    <span className="text-xs text-gray-500 ml-2">{player.team}</span>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-gray-500">{player.season_avg} avg</span>
                    <span className="font-semibold text-gray-900">{player.last3_avg} L3</span>
                    <span className="font-semibold text-green-600">+{player.hot_streak_pct}%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* League Cold Streaks */}
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-xl">🥶</span>
              <h3 className="font-semibold text-gray-900">League-Wide Cold Streaks</h3>
            </div>
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {leagueData.coldStreaks.map((player, i) => (
                <div key={i} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                  <div>
                    <span className="font-medium text-gray-900">{player.player_name}</span>
                    <span className="text-xs text-gray-500 ml-2">{player.team}</span>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-gray-500">{player.season_avg} avg</span>
                    <span className="font-semibold text-gray-900">{player.last3_avg} L3</span>
                    <span className="font-semibold text-red-600">{player.cold_streak_pct}%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Consistency Leaders */}
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-xl">💰</span>
              <h3 className="font-semibold text-gray-900">Most Consistent (Cash Plays)</h3>
            </div>
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {leagueData.consistencyLeaders.map((player, i) => (
                <div key={i} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                  <div>
                    <span className="font-medium text-gray-900">{player.player_name}</span>
                    <span className="text-xs text-gray-500 ml-2">{player.team}</span>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-gray-500">{player.floor}-{player.ceiling}</span>
                    <span className="font-semibold text-gray-900">{player.avg_dk} avg</span>
                    <span className="font-semibold text-yellow-600">{player.consistency_score} CS</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Boom/Bust Players */}
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-xl">💥</span>
              <h3 className="font-semibold text-gray-900">Highest Variance (GPP Plays)</h3>
            </div>
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {leagueData.boomBustPlayers.map((player, i) => (
                <div key={i} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                  <div>
                    <span className="font-medium text-gray-900">{player.player_name}</span>
                    <span className="text-xs text-gray-500 ml-2">{player.team}</span>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-gray-500">{player.floor}-{player.ceiling}</span>
                    <span className="font-semibold text-gray-900">{player.avg_dk} avg</span>
                    <span className="font-semibold text-orange-600">{player.std_dev} SD</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Data Info */}
      {summary && (
        <div className="text-center text-xs text-gray-400">
          Historical data: {summary.totalGames?.toLocaleString()} games | {summary.uniquePlayers} players |
          Avg DK: {summary.averages?.dkPoints} | Last updated: {summary.dateRange?.latest}
        </div>
      )}
    </div>
  );
}

export default InsightsPage;
