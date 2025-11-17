import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { playersAPI, slatesAPI } from '../services/api';

function PlayerPoolPage() {
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeSlate, setActiveSlate] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [positionFilter, setPositionFilter] = useState('');
  const [sortField, setSortField] = useState('salary');
  const [sortDirection, setSortDirection] = useState('desc');

  // Load active slate and players on mount
  useEffect(() => {
    loadActiveSlate();
  }, []);

  const loadActiveSlate = async () => {
    setLoading(true);
    try {
      const slateResponse = await slatesAPI.getActiveSlate();
      if (slateResponse.data) {
        setActiveSlate(slateResponse.data);
        // Load players for the active slate
        const playersResponse = await playersAPI.getBySlateId(slateResponse.data.slate_id);
        setPlayers(playersResponse.data);
      }
    } catch (error) {
      console.error('Error loading active slate:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSort = (field) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const filteredPlayers = players
    .filter((player) => {
      const matchesSearch = player.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                           player.team.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesPosition = !positionFilter || player.position.includes(positionFilter);
      return matchesSearch && matchesPosition;
    })
    .sort((a, b) => {
      let aVal = a[sortField];
      let bVal = b[sortField];

      // Handle null/undefined values - push them to the end
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;

      if (sortField === 'name' || sortField === 'team') {
        aVal = aVal.toLowerCase();
        bVal = bVal.toLowerCase();
      } else {
        aVal = parseFloat(aVal) || 0;
        bVal = parseFloat(bVal) || 0;
      }

      if (sortDirection === 'asc') {
        return aVal > bVal ? 1 : -1;
      } else {
        return aVal < bVal ? 1 : -1;
      }
    });

  return (
    <div className="space-y-6 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Player Pool</h1>
          {activeSlate && (
            <p className="text-sm text-gray-600 mt-1">
              Active Slate: <span className="font-medium">{activeSlate.name}</span>
            </p>
          )}
        </div>
        {players.length > 0 && (
          <span className="text-sm text-gray-600">
            {filteredPlayers.length} of {players.length} players
          </span>
        )}
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Search Players
            </label>
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search by name or team..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Position
            </label>
            <select
              value={positionFilter}
              onChange={(e) => setPositionFilter(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
            >
              <option value="">All Positions</option>
              <option value="PG">PG</option>
              <option value="SG">SG</option>
              <option value="SF">SF</option>
              <option value="PF">PF</option>
              <option value="C">C</option>
            </select>
          </div>
        </div>
      </div>

      {/* Players Display - Table on desktop, Cards on mobile */}
      {filteredPlayers.length > 0 ? (
        <>
          {/* Mobile Card View */}
          <div className="md:hidden space-y-4">
            {filteredPlayers.map((player) => (
              <div key={player.id} className="bg-white rounded-lg shadow p-4">
                <div className="flex items-start space-x-3">
                  {player.headshot ? (
                    <img
                      src={player.headshot}
                      alt={player.name}
                      className="h-16 w-16 rounded-full object-cover flex-shrink-0"
                      onError={(e) => {
                        e.target.onerror = null;
                        e.target.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="gray"%3E%3Cpath d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/%3E%3C/svg%3E';
                      }}
                    />
                  ) : (
                    <div className="h-16 w-16 rounded-full bg-gray-300 flex items-center justify-center flex-shrink-0">
                      <span className="text-gray-600 font-bold text-xl">
                        {player.name.charAt(0)}
                      </span>
                    </div>
                  )}

                  <div className="flex-1 min-w-0">
                    <h3 className="text-lg font-semibold text-gray-900 truncate mb-2">{player.name}</h3>

                    <div className="flex items-center space-x-2 mb-3">
                      <span className="px-2 py-1 text-xs font-semibold rounded-full bg-blue-100 text-blue-800">
                        {player.position}
                      </span>
                      <span className="text-sm text-gray-600">{player.team} vs {player.opponent}</span>
                    </div>

                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                      <div>
                        <span className="text-gray-500">Salary:</span>
                        <span className="ml-1 font-semibold text-gray-900">${player.salary?.toLocaleString()}</span>
                      </div>
                      <div>
                        <span className="text-gray-500">Proj:</span>
                        <span className={`ml-1 font-semibold ${
                          player.projected_points >= 40 ? 'text-green-600' :
                          player.projected_points <= 25 ? 'text-red-600' :
                          'text-gray-900'
                        }`}>
                          {player.projected_points?.toFixed(1)}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-500">Value:</span>
                        <span className={`ml-1 font-semibold ${
                          player.value >= 5.5 ? 'text-green-600' :
                          player.value <= 4.0 ? 'text-red-600' :
                          'text-gray-900'
                        }`}>
                          {player.value?.toFixed(2)}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-500">Min:</span>
                        <span className={`ml-1 font-semibold ${
                          player.projected_minutes >= 32 ? 'text-green-600' :
                          player.projected_minutes <= 20 ? 'text-red-600' :
                          'text-gray-900'
                        }`}>
                          {player.projected_minutes ? player.projected_minutes.toFixed(0) : '-'}
                        </span>
                      </div>
                      {player.usage && (
                        <div>
                          <span className="text-gray-500">Usg:</span>
                          <span className={`ml-1 font-semibold ${
                            player.usage >= 27 ? 'text-green-600' :
                            player.usage <= 20 ? 'text-red-600' :
                            'text-gray-900'
                          }`}>
                            {player.usage.toFixed(1)}%
                          </span>
                        </div>
                      )}
                      {player.dvp_pts_allowed && (
                        <div>
                          <span className="text-gray-500">DVP:</span>
                          <span className={`ml-1 font-semibold ${
                            player.dvp_pts_allowed >= 45 ? 'text-green-600' :  // High pts = easier
                            player.dvp_pts_allowed <= 35 ? 'text-red-600' :    // Low pts = tough
                            'text-gray-900'
                          }`}>
                            {player.dvp_pts_allowed.toFixed(1)}
                          </span>
                        </div>
                      )}
                      {player.opp_def_eff && (
                        <div>
                          <span className="text-gray-500">DEF:</span>
                          <span className={`ml-1 font-semibold ${
                            player.opp_def_eff < 108 ? 'text-red-600' :
                            player.opp_def_eff > 118 ? 'text-green-600' :
                            'text-gray-900'
                          }`}>
                            {player.opp_def_eff.toFixed(1)}
                          </span>
                        </div>
                      )}
                      {player.floor != null && player.ceiling != null && (
                        <div>
                          <span className="text-gray-500">Range:</span>
                          <span className="ml-1 font-semibold text-gray-900">
                            {player.floor.toFixed(0)}-{player.ceiling.toFixed(0)}
                          </span>
                        </div>
                      )}
                      {player.boom_probability != null && (
                        <div>
                          <span className="text-gray-500">Boom:</span>
                          <span className={`ml-1 font-semibold ${
                            player.boom_probability >= 30 ? 'text-green-600' :
                            player.boom_probability <= 10 ? 'text-red-600' :
                            'text-gray-900'
                          }`}>
                            {player.boom_probability.toFixed(0)}%
                          </span>
                        </div>
                      )}
                      {player.leverage_score != null && (
                        <div>
                          <span className="text-gray-500">Lev:</span>
                          <span className={`ml-1 font-semibold ${
                            player.leverage_score >= 3.0 ? 'text-green-600' :
                            player.leverage_score <= 1.0 ? 'text-red-600' :
                            'text-gray-900'
                          }`}>
                            {player.leverage_score.toFixed(1)}
                          </span>
                        </div>
                      )}
                      {player.volatility != null && (
                        <div>
                          <span className="text-gray-500">Vol:</span>
                          <span className={`ml-1 font-semibold ${
                            player.volatility >= 0.30 ? 'text-orange-600' :  // High variance
                            player.volatility <= 0.15 ? 'text-blue-600' :    // Consistent
                            'text-gray-900'
                          }`}>
                            {(player.volatility * 100).toFixed(0)}%
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Desktop Table View */}
          <div className="hidden md:block bg-white rounded-lg shadow overflow-hidden">
            <div className="max-h-[calc(100vh-250px)] overflow-y-auto">
              <table className="w-full divide-y divide-gray-200 table-fixed">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr>
                  <th
                    onClick={() => handleSort('name')}
                    className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100 w-40"
                  >
                    Name {sortField === 'name' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </th>
                  <th
                    onClick={() => handleSort('position')}
                    className="px-2 py-2 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100 w-20"
                  >
                    Pos {sortField === 'position' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </th>
                  <th
                    onClick={() => handleSort('team')}
                    className="px-2 py-2 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100 w-16"
                  >
                    Team {sortField === 'team' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </th>
                  <th className="px-2 py-2 text-left text-xs font-medium text-gray-500 uppercase w-16">
                    Opp
                  </th>
                  <th
                    onClick={() => handleSort('salary')}
                    className="px-2 py-2 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100 w-20"
                  >
                    Sal {sortField === 'salary' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </th>
                  <th
                    onClick={() => handleSort('projected_points')}
                    className="px-2 py-2 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100 w-16"
                  >
                    Proj {sortField === 'projected_points' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </th>
                  <th
                    onClick={() => handleSort('value')}
                    className="px-2 py-2 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100 w-16"
                  >
                    Val {sortField === 'value' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </th>
                  <th
                    onClick={() => handleSort('projected_minutes')}
                    className="px-2 py-2 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100 w-14"
                  >
                    Min {sortField === 'projected_minutes' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </th>
                  <th
                    onClick={() => handleSort('usage')}
                    className="px-2 py-2 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100 w-16"
                  >
                    Usg {sortField === 'usage' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </th>
                  <th
                    onClick={() => handleSort('floor')}
                    className="px-2 py-2 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100 w-16"
                  >
                    Flr {sortField === 'floor' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </th>
                  <th
                    onClick={() => handleSort('ceiling')}
                    className="px-2 py-2 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100 w-16"
                  >
                    Ceil {sortField === 'ceiling' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </th>
                  <th
                    onClick={() => handleSort('boom_probability')}
                    className="px-2 py-2 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100 w-16"
                  >
                    Boom {sortField === 'boom_probability' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </th>
                  <th
                    onClick={() => handleSort('volatility')}
                    className="px-2 py-2 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100 w-14"
                  >
                    Vol {sortField === 'volatility' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </th>
                  <th
                    onClick={() => handleSort('leverage_score')}
                    className="px-2 py-2 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100 w-16"
                  >
                    Lev {sortField === 'leverage_score' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredPlayers.map((player) => (
                  <tr key={player.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex items-center">
                        {player.headshot ? (
                          <img
                            src={player.headshot}
                            alt={player.name}
                            className="h-8 w-8 rounded-full object-cover mr-2"
                            onError={(e) => {
                              e.target.onerror = null;
                              e.target.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="gray"%3E%3Cpath d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/%3E%3C/svg%3E';
                            }}
                          />
                        ) : (
                          <div className="h-8 w-8 rounded-full bg-gray-300 flex items-center justify-center mr-2">
                            <span className="text-gray-600 font-bold text-sm">
                              {player.name.charAt(0)}
                            </span>
                          </div>
                        )}
                        <div className="text-sm font-medium text-gray-900 truncate">{player.name}</div>
                      </div>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <span className="px-1 inline-flex text-xs leading-5 font-semibold rounded bg-blue-100 text-blue-800">
                        {player.position.split(',')[0]}
                      </span>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm text-gray-900">
                      {player.team}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm text-gray-500">
                      {player.opponent}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm text-gray-900">
                      {(player.salary / 1000).toFixed(1)}k
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm">
                      <span className={`font-semibold ${
                        player.projected_points >= 40 ? 'text-green-600' :
                        player.projected_points <= 25 ? 'text-red-600' :
                        'text-gray-700'
                      }`}>
                        {player.projected_points?.toFixed(1)}
                      </span>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm">
                      <span className={`font-semibold ${
                        player.value >= 5.5 ? 'text-green-600' :
                        player.value <= 4.0 ? 'text-red-600' :
                        'text-gray-700'
                      }`}>
                        {player.value?.toFixed(1)}
                      </span>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm">
                      {player.projected_minutes ? (
                        <span className={`font-semibold ${
                          player.projected_minutes >= 32 ? 'text-green-600' :
                          player.projected_minutes <= 20 ? 'text-red-600' :
                          'text-gray-700'
                        }`}>
                          {player.projected_minutes.toFixed(0)}
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm">
                      {player.usage ? (
                        <span className={`font-semibold ${
                          player.usage >= 27 ? 'text-green-600' :
                          player.usage <= 20 ? 'text-red-600' :
                          'text-gray-700'
                        }`}>
                          {player.usage.toFixed(0)}
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm">
                      {player.floor != null ? (
                        <span className="font-semibold text-gray-700">
                          {player.floor.toFixed(0)}
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm">
                      {player.ceiling != null ? (
                        <span className="font-semibold text-gray-700">
                          {player.ceiling.toFixed(0)}
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm">
                      {player.boom_probability != null ? (
                        <span className={`font-semibold ${
                          player.boom_probability >= 30 ? 'text-green-600' :
                          player.boom_probability <= 10 ? 'text-red-600' :
                          'text-gray-700'
                        }`}>
                          {player.boom_probability.toFixed(0)}
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm">
                      {player.volatility != null ? (
                        <span className={`font-semibold ${
                          player.volatility >= 0.30 ? 'text-orange-600' :
                          player.volatility <= 0.15 ? 'text-blue-600' :
                          'text-gray-700'
                        }`}>
                          {(player.volatility * 100).toFixed(0)}
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-sm">
                      {player.leverage_score != null ? (
                        <span className={`font-semibold ${
                          player.leverage_score >= 3.0 ? 'text-green-600' :
                          player.leverage_score <= 1.0 ? 'text-red-600' :
                          'text-gray-700'
                        }`}>
                          {player.leverage_score.toFixed(1)}
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        </>
      ) : loading ? (
        <div className="text-center py-12 text-gray-500">Loading players...</div>
      ) : !activeSlate ? (
        <div className="text-center py-12">
          <p className="text-gray-500 mb-4">No active slate selected.</p>
          <Link
            to="/"
            className="inline-block px-6 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 font-medium"
          >
            Go to Home to Select a Slate
          </Link>
        </div>
      ) : (
        <div className="text-center py-12 text-gray-500">
          No players found for this slate.
        </div>
      )}
    </div>
  );
}

export default PlayerPoolPage;
