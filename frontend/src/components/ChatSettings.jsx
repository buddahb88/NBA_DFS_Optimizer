import { useState } from 'react';

/**
 * ChatSettings - Configuration panel for chat behavior
 */
export function ChatSettings({
  maxIterations = 10,
  setMaxIterations,
  showReasoning = true,
  setShowReasoning,
  isOpen = false,
  onToggle
}) {
  return (
    <div className="relative">
      {/* Settings Button */}
      <button
        onClick={onToggle}
        className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
        title="Chat Settings"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
      </button>

      {/* Settings Dropdown */}
      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-72 bg-gray-800 rounded-lg shadow-xl border border-gray-700 p-4 z-50">
          <h3 className="text-white font-medium mb-4">Chat Settings</h3>

          {/* Max Iterations Slider */}
          <div className="mb-4">
            <div className="flex justify-between items-center mb-2">
              <label className="text-sm text-gray-400">Max Iterations</label>
              <span className="text-sm text-white font-mono bg-gray-700 px-2 py-0.5 rounded">
                {maxIterations}
              </span>
            </div>
            <input
              type="range"
              min="5"
              max="30"
              value={maxIterations}
              onChange={(e) => setMaxIterations(parseInt(e.target.value))}
              className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>5</span>
              <span>30</span>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Higher values allow more tool calls but may take longer.
            </p>
          </div>

          {/* Show Reasoning Toggle */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm text-gray-400">Show Reasoning</label>
              <p className="text-xs text-gray-500">Display AI thinking process</p>
            </div>
            <button
              onClick={() => setShowReasoning(!showReasoning)}
              className={`relative w-11 h-6 rounded-full transition-colors ${
                showReasoning ? 'bg-blue-500' : 'bg-gray-600'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                  showReasoning ? 'translate-x-5' : ''
                }`}
              />
            </button>
          </div>

          {/* Agent Info */}
          <div className="mt-4 pt-4 border-t border-gray-700">
            <h4 className="text-xs text-gray-500 uppercase mb-2">Available Agents</h4>
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs">
                <span className="w-2 h-2 bg-green-500 rounded-full" />
                <span className="text-gray-400">Optimizer</span>
                <span className="text-gray-600">- Lineup building</span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="w-2 h-2 bg-blue-500 rounded-full" />
                <span className="text-gray-400">Research</span>
                <span className="text-gray-600">- Database queries</span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="w-2 h-2 bg-purple-500 rounded-full" />
                <span className="text-gray-400">Analyst</span>
                <span className="text-gray-600">- Historical data</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ChatSettings;
