import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { slatesAPI, playersAPI } from '../services/api';

function HomePage() {
  const [availableSlates, setAvailableSlates] = useState([]);
  const [selectedSlate, setSelectedSlate] = useState(null);
  const [activeSlate, setActiveSlate] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingSlates, setLoadingSlates] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    loadAvailableSlates();
    loadActiveSlate();
  }, []);

  const loadAvailableSlates = async () => {
    setLoadingSlates(true);
    try {
      const response = await slatesAPI.getAvailableSlates();
      setAvailableSlates(response.data);

      // Auto-select the default slate if available
      const defaultSlate = response.data.find(slate => slate.isDefault);
      if (defaultSlate && !selectedSlate) {
        setSelectedSlate(defaultSlate);
      }
    } catch (error) {
      console.error('Error loading available slates:', error);
      setMessage('❌ Could not load available slates from RotoWire');
    } finally {
      setLoadingSlates(false);
    }
  };

  const loadActiveSlate = async () => {
    try {
      const response = await slatesAPI.getActiveSlate();
      setActiveSlate(response.data);
    } catch (error) {
      console.error('Error loading active slate:', error);
    }
  };

  const handleSlateChange = (e) => {
    const slateId = e.target.value;
    const slate = availableSlates.find(s => s.slateId === slateId);
    setSelectedSlate(slate);
  };

  const handleSync = async (slate = selectedSlate) => {
    if (!slate) {
      setMessage('Please select a slate');
      return;
    }

    setLoading(true);
    setMessage('');

    try {
      const response = await playersAPI.syncFromRotoWire(slate.slateId, { name: slate.name });
      setMessage(`✅ Successfully imported ${response.data.count} players for ${slate.name}! This is now your active slate.`);
      loadActiveSlate(); // Reload the active slate
    } catch (error) {
      setMessage(`❌ Error: ${error.response?.data?.error || error.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="text-center">
        <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
          NBA DFS Lineup Optimizer
        </h1>
        <p className="text-base sm:text-lg text-gray-600">
          Build and optimize DraftKings lineups with AI assistance
        </p>
      </div>

      {/* Sync Players Card */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-2xl font-semibold mb-4">Import Player Data</h2>
        <p className="text-gray-600 mb-4">
          Select a slate and click "Load Slate" to import player data and projections.
        </p>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Available Slates
            </label>
            {loadingSlates ? (
              <div className="w-full px-4 py-3 border border-gray-300 rounded-md bg-gray-50 text-gray-500">
                Loading available slates...
              </div>
            ) : availableSlates.length > 0 ? (
              <select
                value={selectedSlate?.slateId || ''}
                onChange={handleSlateChange}
                disabled={loading}
                className="w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed"
              >
                <option value="">Select a slate...</option>
                {availableSlates.map((slate) => (
                  <option key={slate.slateId} value={slate.slateId}>
                    {slate.name} - {slate.startTime} ({slate.games} games)
                  </option>
                ))}
              </select>
            ) : (
              <div className="w-full px-4 py-3 border border-gray-300 rounded-md bg-yellow-50 text-yellow-800">
                No slates available. Check your RotoWire cookie configuration.
              </div>
            )}
          </div>

          <button
            onClick={() => handleSync()}
            disabled={!selectedSlate || loading}
            className="w-full px-6 py-4 bg-blue-600 text-white rounded-md hover:bg-blue-700 font-medium text-base shadow-md disabled:bg-gray-300 disabled:cursor-not-allowed disabled:text-gray-500 transition-colors touch-manipulation active:scale-95"
          >
            {loading ? 'Loading Players...' : 'Load Slate'}
          </button>

          {selectedSlate && (
            <div className="bg-blue-50 p-4 rounded-md">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="font-medium text-blue-900">Slate ID:</span>
                  <span className="ml-2 text-blue-700">{selectedSlate.slateId}</span>
                </div>
                <div>
                  <span className="font-medium text-blue-900">Start Time:</span>
                  <span className="ml-2 text-blue-700">{selectedSlate.startTime}</span>
                </div>
                <div>
                  <span className="font-medium text-blue-900">Games:</span>
                  <span className="ml-2 text-blue-700">{selectedSlate.games}</span>
                </div>
                <div>
                  <span className="font-medium text-blue-900">Salary Cap:</span>
                  <span className="ml-2 text-blue-700">${selectedSlate.salaryCap?.toLocaleString()}</span>
                </div>
              </div>
            </div>
          )}

          {loading && (
            <div className="p-4 rounded-md bg-blue-50 text-blue-800">
              <div className="flex items-center">
                <svg className="animate-spin h-5 w-5 mr-3" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Importing players...
              </div>
            </div>
          )}

          {message && (
            <div className={`p-4 rounded-md ${message.startsWith('✅') ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
              {message}
            </div>
          )}
        </div>
      </div>

      {/* Active Slate */}
      {activeSlate && (
        <div className="bg-white rounded-lg shadow p-4 sm:p-6">
          <h2 className="text-xl sm:text-2xl font-semibold mb-4">Active Slate</h2>
          <div className="bg-gradient-to-r from-blue-50 to-green-50 border-2 border-blue-200 rounded-lg p-4 sm:p-6">
            <div className="flex flex-col space-y-4">
              <div>
                <h3 className="text-lg sm:text-xl font-bold text-gray-900 mb-2">{activeSlate.name}</h3>
                <div className="space-y-1">
                  <p className="text-sm text-gray-600">
                    <span className="font-medium">Slate ID:</span> {activeSlate.slate_id}
                  </p>
                  <p className="text-sm text-gray-600">
                    <span className="font-medium">Last updated:</span>{' '}
                    {new Date(activeSlate.updated_at).toLocaleString()}
                  </p>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-3">
                <Link
                  to={`/players?slateId=${activeSlate.slate_id}`}
                  className="flex-1 text-center px-6 py-4 bg-blue-600 text-white rounded-md hover:bg-blue-700 font-medium shadow-md touch-manipulation active:scale-95 transition-transform"
                >
                  View Players
                </Link>
                <Link
                  to={`/lineup-builder?slateId=${activeSlate.slate_id}`}
                  className="flex-1 text-center px-6 py-4 bg-green-600 text-white rounded-md hover:bg-green-700 font-medium shadow-md touch-manipulation active:scale-95 transition-transform"
                >
                  Build Lineup
                </Link>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Quick Start Guide */}
      <div className="bg-blue-50 rounded-lg p-6">
        <h3 className="text-lg font-semibold text-blue-900 mb-3">Quick Start</h3>
        <ol className="list-decimal list-inside space-y-2 text-blue-800">
          <li>Select a slate from the dropdown and click "Load Slate" to import players</li>
          <li>Only one slate can be active at a time - loading a new slate clears the previous one</li>
          <li>View the player pool, build lineups, and chat with AI using your active slate</li>
          <li>Come back here to switch slates whenever you want</li>
        </ol>
      </div>
    </div>
  );
}

export default HomePage;
