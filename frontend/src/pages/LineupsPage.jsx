import { useState, useEffect } from 'react';
import { lineupsAPI } from '../services/api';
import ExportLineupsModal from '../components/ExportLineupsModal';
import { useSlate } from '../context/SlateContext';
import { Tabs } from '../components/ui';
import LateSwapPanel from '../components/lateSwap/LateSwapPanel';
import { BACKTEST_DISABLED } from '../features/slate/backtest';

function LineupsPage() {
  const { site, slateId, loadingSlates, isBacktest = false } = useSlate();
  const [lineups, setLineups] = useState([]);
  const [selectedLineup, setSelectedLineup] = useState(null);
  const [loading, setLoading] = useState(false);
  const [checkedIds, setCheckedIds] = useState([]);
  // Lineup ids the export dialog is open for (null = closed)
  const [exportIds, setExportIds] = useState(null);
  // Lineups for slates that have since been replaced stay reachable via "All slates"
  const [showAllSlates, setShowAllSlates] = useState(false);
  const filterSlateId = showAllSlates ? null : slateId;
  const [tab, setTab] = useState('saved');

  useEffect(() => {
    if (loadingSlates) return;
    setSelectedLineup(null);
    setCheckedIds([]);
    loadLineups();
  }, [filterSlateId, loadingSlates]);

  const loadLineups = async () => {
    setLoading(true);
    try {
      const response = await lineupsAPI.getAll(filterSlateId);
      setLineups(response.data);
    } catch (error) {
      console.error('Error loading lineups:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleViewLineup = async (lineupId) => {
    try {
      const response = await lineupsAPI.getById(lineupId);
      setSelectedLineup(response.data);
    } catch (error) {
      console.error('Error loading lineup details:', error);
    }
  };

  const handleDeleteLineup = async (lineupId) => {
    if (!confirm('Are you sure you want to delete this lineup?')) {
      return;
    }

    try {
      await lineupsAPI.delete(lineupId);
      setLineups(lineups.filter(l => l.id !== lineupId));
      setCheckedIds(ids => ids.filter(id => id !== lineupId));
      if (selectedLineup && selectedLineup.id === lineupId) {
        setSelectedLineup(null);
      }
    } catch (error) {
      console.error('Error deleting lineup:', error);
    }
  };

  const toggleChecked = (lineupId) => {
    setCheckedIds(ids => (ids.includes(lineupId) ? ids.filter(id => id !== lineupId) : [...ids, lineupId]));
  };

  const allChecked = lineups.length > 0 && checkedIds.length === lineups.length;

  // Export the checked lineups, or all of them when none are checked
  const openBulkExport = () => {
    setExportIds(checkedIds.length > 0 ? lineups.filter(l => checkedIds.includes(l.id)).map(l => l.id) : lineups.map(l => l.id));
  };

  return (
    <div className="space-y-4">
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'saved', label: 'Saved lineups' },
          { value: 'lateswap', label: 'Late Swap' },
        ]}
      />
      {tab === 'lateswap' ? (
        // Late swap edits live entries; a backtest is a past night
        isBacktest ? <p role="status" className="text-sm text-caution">{BACKTEST_DISABLED}</p> : <LateSwapPanel />
      ) : (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Lineups List */}
      <div className="lg:col-span-1 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">My Lineups</h1>
          <div className="flex gap-2">
            <button
              onClick={openBulkExport}
              disabled={lineups.length === 0}
              className="px-3 py-1 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
            >
              {checkedIds.length > 0 ? `Export ${checkedIds.length}` : 'Export all'}
            </button>
            <button
              onClick={loadLineups}
              className="px-3 py-1 text-sm bg-gray-200 rounded-md hover:bg-gray-300"
            >
              Refresh
            </button>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={showAllSlates || !slateId}
            disabled={!slateId}
            onChange={(e) => setShowAllSlates(e.target.checked)}
          />
          Show lineups from all slates
        </label>

        {lineups.length > 0 && (
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={allChecked}
              onChange={() => setCheckedIds(allChecked ? [] : lineups.map(l => l.id))}
            />
            Select all
          </label>
        )}

        {loading ? (
          <div className="bg-white rounded-lg shadow p-6 text-center text-gray-500">
            Loading lineups...
          </div>
        ) : lineups.length > 0 ? (
          <div className="space-y-3">
            {lineups.map(lineup => (
              <div
                key={lineup.id}
                className={`bg-white rounded-lg shadow p-4 cursor-pointer border-2 ${
                  selectedLineup && selectedLineup.id === lineup.id
                    ? 'border-blue-500'
                    : 'border-transparent'
                } hover:border-blue-300`}
                onClick={() => handleViewLineup(lineup.id)}
              >
                <div className="flex items-center justify-between mb-2">
                  <label className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={checkedIds.includes(lineup.id)}
                      onChange={() => toggleChecked(lineup.id)}
                      aria-label={`Select ${lineup.name}`}
                    />
                    <h3 className="font-semibold text-gray-900">{lineup.name}</h3>
                  </label>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteLineup(lineup.id);
                    }}
                    className="text-red-600 hover:text-red-800 text-sm"
                  >
                    Delete
                  </button>
                </div>
                <div className="text-sm text-gray-600">
                  <div>Slate: {lineup.slate_id}</div>
                  <div>Salary: ${lineup.total_salary?.toLocaleString()}</div>
                  <div>Projected: {lineup.projected_points?.toFixed(1)} pts</div>
                  <div className="text-xs text-gray-400 mt-2">
                    {new Date(lineup.created_at).toLocaleString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow p-6 text-center text-gray-500">
            No lineups saved yet. Create one in the Lineup Builder!
          </div>
        )}
      </div>

      {/* Lineup Details */}
      <div className="lg:col-span-2">
        {selectedLineup ? (
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-bold text-gray-900">{selectedLineup.name}</h2>
              <button
                onClick={() => setExportIds([selectedLineup.id])}
                className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700"
              >
                Export CSV
              </button>
            </div>

            {/* Lineup Summary */}
            <div className="grid grid-cols-3 gap-4 mb-6 p-4 bg-gray-50 rounded-lg">
              <div>
                <div className="text-sm text-gray-600">Total Salary</div>
                <div className="text-xl font-bold text-gray-900">
                  ${selectedLineup.total_salary?.toLocaleString()}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-600">Remaining</div>
                <div className="text-xl font-bold text-green-600">
                  ${(50000 - selectedLineup.total_salary)?.toLocaleString()}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-600">Projected Points</div>
                <div className="text-xl font-bold text-gray-900">
                  {selectedLineup.projected_points?.toFixed(1)}
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
                      Opponent
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Salary
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Projected
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {selectedLineup.players && selectedLineup.players.map((player, index) => (
                    <tr key={index} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-blue-100 text-blue-800">
                          {player.position_slot}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900">{player.name}</div>
                        <div className="text-xs text-gray-500">{player.position}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {player.team}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {player.opponent}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        ${player.salary?.toLocaleString()}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {player.projected_points?.toFixed(1)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Lineup Info */}
            <div className="mt-6 pt-6 border-t border-gray-200">
              <div className="text-sm text-gray-600">
                <div>Slate ID: {selectedLineup.slate_id}</div>
                <div>Created: {new Date(selectedLineup.created_at).toLocaleString()}</div>
                <div>Last Updated: {new Date(selectedLineup.updated_at).toLocaleString()}</div>
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow p-12 text-center text-gray-500">
            <div className="text-4xl mb-4">👈</div>
            <div>Select a lineup from the list to view details</div>
          </div>
        )}
      </div>

      <ExportLineupsModal
        open={exportIds !== null}
        onClose={() => setExportIds(null)}
        lineupIds={exportIds || []}
        defaultSite={site}
      />
    </div>
      )}
    </div>
  );
}

export default LineupsPage;
