import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { playersAPI, lineupsAPI } from '../services/api';
import { useSlate } from '../context/SlateContext';

const DK_POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL'];
const SALARY_CAP = 50000;

function LineupBuilderPage() {
  const navigate = useNavigate();
  const { slate, slateId } = useSlate();
  const [players, setPlayers] = useState([]);
  const [lineup, setLineup] = useState(Array(8).fill(null));
  const [lineupName, setLineupName] = useState('My Lineup');
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  // Start a fresh lineup and load players whenever the top-bar slate changes
  useEffect(() => {
    setPlayers([]);
    setLineup(Array(8).fill(null));
    setMessage('');
    if (!slateId) return;
    let cancelled = false;
    setLoading(true);
    playersAPI.getBySlateId(slateId)
      .then((response) => {
        if (!cancelled) setPlayers(response.data);
      })
      .catch((error) => {
        console.error('Error loading players:', error);
        if (!cancelled) setMessage('Error loading players');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slateId]);

  const addPlayerToLineup = (player, slotIndex) => {
    const newLineup = [...lineup];
    newLineup[slotIndex] = { ...player, positionSlot: DK_POSITIONS[slotIndex] };
    setLineup(newLineup);
  };

  const removePlayerFromLineup = (slotIndex) => {
    const newLineup = [...lineup];
    newLineup[slotIndex] = null;
    setLineup(newLineup);
  };

  const canPlayerFitPosition = (player, position) => {
    const pos = player.position;

    if (position === 'PG') return pos.includes('PG');
    if (position === 'SG') return pos.includes('SG');
    if (position === 'SF') return pos.includes('SF');
    if (position === 'PF') return pos.includes('PF');
    if (position === 'C') return pos.includes('C');
    if (position === 'G') return pos.includes('PG') || pos.includes('SG');
    if (position === 'F') return pos.includes('SF') || pos.includes('PF');
    if (position === 'UTIL') return true;

    return false;
  };

  const isPlayerInLineup = (playerId) => {
    return lineup.some(p => p && p.id === playerId);
  };

  const totalSalary = lineup.reduce((sum, player) => sum + (player?.salary || 0), 0);
  const totalProjected = lineup.reduce((sum, player) => sum + (player?.projected_points || 0), 0);
  const remainingSalary = SALARY_CAP - totalSalary;
  const filledSlots = lineup.filter(p => p !== null).length;

  const isLineupValid = () => {
    return filledSlots === 8 && totalSalary <= SALARY_CAP;
  };

  const handleSaveLineup = async () => {
    if (!isLineupValid()) {
      setMessage('❌ Lineup is not valid. Fill all 8 slots and stay under salary cap.');
      return;
    }

    setLoading(true);
    setMessage('');

    try {
      const response = await lineupsAPI.create({
        slateId,
        name: lineupName,
        players: lineup.map((player, index) => ({
          ...player,
          positionSlot: DK_POSITIONS[index]
        }))
      });

      setMessage('✅ Lineup saved successfully!');
      setTimeout(() => {
        navigate('/lineups');
      }, 1500);
    } catch (error) {
      setMessage(`❌ Error: ${error.response?.data?.error || error.message}`);
    } finally {
      setLoading(false);
    }
  };

  const filteredPlayers = players.filter(player =>
    player.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Lineup Builder - Left Side */}
      <div className="lg:col-span-2 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold text-gray-900">Lineup Builder</h1>
        </div>

        {/* Slate (selected in the top bar) */}
        <div className="bg-white rounded-lg shadow p-6">
          {slate ? (
            <p className="text-sm text-gray-700">
              Slate: <span className="font-medium">{slate.name}</span>
              {loading ? ' · Loading players...' : ` · ${players.length} players`}
            </p>
          ) : (
            <p className="text-sm text-gray-600">
              No slate selected. Pick one in the top bar, or{' '}
              <Link to="/" className="font-medium text-blue-600 underline">import one from Home</Link>.
            </p>
          )}
        </div>

        {/* Lineup Slots */}
        {slateId && (
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold">Your Lineup</h2>
              <div className="text-sm text-gray-600">
                {filledSlots}/8 slots filled
              </div>
            </div>

            <div className="space-y-2">
              {DK_POSITIONS.map((position, index) => {
                const player = lineup[index];
                return (
                  <div key={index} className="flex items-center gap-4 p-3 border border-gray-200 rounded-md">
                    <div className="w-16">
                      <span className="px-2 py-1 text-xs font-semibold rounded bg-blue-100 text-blue-800">
                        {position}
                      </span>
                    </div>
                    {player ? (
                      <>
                        <div className="flex-1">
                          <div className="font-medium">{player.name}</div>
                          <div className="text-sm text-gray-500">
                            {player.team} • ${player.salary?.toLocaleString()} • {player.projected_points?.toFixed(1)} pts
                          </div>
                        </div>
                        <button
                          onClick={() => removePlayerFromLineup(index)}
                          className="px-3 py-1 text-sm text-red-600 hover:bg-red-50 rounded"
                        >
                          Remove
                        </button>
                      </>
                    ) : (
                      <div className="flex-1 text-gray-400 italic">Empty slot</div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Lineup Stats */}
            <div className="mt-6 pt-6 border-t border-gray-200">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <div className="text-sm text-gray-600">Total Salary</div>
                  <div className={`text-xl font-bold ${totalSalary > SALARY_CAP ? 'text-red-600' : 'text-gray-900'}`}>
                    ${totalSalary.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-gray-600">Remaining</div>
                  <div className={`text-xl font-bold ${remainingSalary < 0 ? 'text-red-600' : 'text-green-600'}`}>
                    ${remainingSalary.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-gray-600">Projected</div>
                  <div className="text-xl font-bold text-gray-900">
                    {totalProjected.toFixed(1)}
                  </div>
                </div>
              </div>
            </div>

            {/* Save Lineup */}
            <div className="mt-6">
              <input
                type="text"
                value={lineupName}
                onChange={(e) => setLineupName(e.target.value)}
                placeholder="Lineup name"
                className="w-full px-4 py-2 mb-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={handleSaveLineup}
                disabled={!isLineupValid() || loading}
                className="w-full bg-green-600 text-white py-3 px-4 rounded-md hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed font-medium"
              >
                {loading ? 'Saving...' : 'Save Lineup'}
              </button>
              {message && (
                <div className={`mt-3 p-3 rounded-md text-sm ${message.startsWith('✅') ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
                  {message}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Player Pool - Right Side */}
      {slateId && (
        <div className="space-y-4">
          <div className="bg-white rounded-lg shadow p-4 sticky top-4">
            <h2 className="text-lg font-semibold mb-4">Available Players</h2>

            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search players..."
              className="w-full px-3 py-2 mb-4 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
            />

            <div className="space-y-2 max-h-[600px] overflow-y-auto">
              {loading ? (
                <div className="text-center py-8 text-gray-500">Loading...</div>
              ) : filteredPlayers.length > 0 ? (
                filteredPlayers.map(player => (
                  <div
                    key={player.id}
                    className={`p-3 border rounded-md ${isPlayerInLineup(player.id) ? 'bg-gray-100 border-gray-300' : 'border-gray-200 hover:bg-gray-50'}`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm truncate">{player.name}</div>
                        <div className="text-xs text-gray-500">
                          {player.position} • {player.team} vs {player.opponent}
                        </div>
                        <div className="text-xs text-gray-600 mt-1">
                          ${player.salary?.toLocaleString()} • {player.projected_points?.toFixed(1)} pts
                        </div>
                      </div>
                      {!isPlayerInLineup(player.id) && (
                        <div className="ml-2">
                          <select
                            onChange={(e) => {
                              if (e.target.value !== '') {
                                addPlayerToLineup(player, parseInt(e.target.value));
                                e.target.value = '';
                              }
                            }}
                            className="text-xs px-2 py-1 border border-gray-300 rounded"
                          >
                            <option value="">Add</option>
                            {DK_POSITIONS.map((pos, idx) => (
                              canPlayerFitPosition(player, pos) && !lineup[idx] ? (
                                <option key={idx} value={idx}>{pos}</option>
                              ) : null
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-center py-8 text-gray-500">No players found</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default LineupBuilderPage;
