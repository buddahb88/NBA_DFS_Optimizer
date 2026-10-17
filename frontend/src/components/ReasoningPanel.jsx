import { useState } from 'react';

/**
 * ReasoningPanel - Displays AI thinking process, tool calls, and agent activity
 */
export function ReasoningPanel({
  reasoning = [],
  toolCalls = [],
  activeAgent = null,
  iterations = { current: 0, max: 10 },
  isStreaming = false
}) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [showToolDetails, setShowToolDetails] = useState({});

  const toggleToolDetails = (index) => {
    setShowToolDetails(prev => ({
      ...prev,
      [index]: !prev[index]
    }));
  };

  // Don't render if nothing to show
  if (!isStreaming && reasoning.length === 0 && toolCalls.length === 0) {
    return null;
  }

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 mb-4 overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2 bg-gray-750 cursor-pointer hover:bg-gray-700 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-3">
          <span className="text-gray-400 text-sm font-medium">
            {isStreaming ? 'AI Thinking...' : 'AI Reasoning'}
          </span>

          {/* Active Agent Badge */}
          {activeAgent && (
            <span className="px-2 py-0.5 bg-blue-600 text-white text-xs rounded-full animate-pulse">
              {activeAgent.name} agent
            </span>
          )}

          {/* Iteration Counter */}
          {isStreaming && (
            <span className="text-gray-500 text-xs">
              Iteration {iterations.current}/{iterations.max}
            </span>
          )}

          {/* Streaming Indicator */}
          {isStreaming && (
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Stats */}
          <span className="text-gray-500 text-xs">
            {reasoning.length} thoughts, {toolCalls.length} tools
          </span>

          {/* Expand/Collapse Arrow */}
          <svg
            className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>

      {/* Content */}
      {isExpanded && (
        <div className="p-4 max-h-64 overflow-y-auto space-y-2">
          {/* Reasoning Steps */}
          {reasoning.map((thought, index) => (
            <div
              key={index}
              className={`flex items-start gap-2 text-sm ${
                thought.isAgentSpawn ? 'text-blue-400' : 'text-gray-400'
              }`}
            >
              <span className="flex-shrink-0 mt-0.5">
                {thought.isAgentSpawn ? '🚀' : '💭'}
              </span>
              <span className="break-words">{thought.text}</span>
            </div>
          ))}

          {/* Tool Calls */}
          {toolCalls.map((tc, index) => (
            <div key={index} className="border-l-2 border-gray-600 pl-3 ml-1">
              <div
                className="flex items-center gap-2 cursor-pointer hover:text-gray-300"
                onClick={() => toggleToolDetails(index)}
              >
                {/* Status Icon */}
                {tc.status === 'running' ? (
                  <svg className="w-4 h-4 text-yellow-500 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : tc.success ? (
                  <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                )}

                {/* Tool Name */}
                <span className="text-sm font-mono text-purple-400">
                  {tc.tool}
                </span>

                {/* Expand Arrow */}
                <svg
                  className={`w-3 h-3 text-gray-500 transition-transform ${showToolDetails[index] ? 'rotate-180' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>

              {/* Tool Details (expandable) */}
              {showToolDetails[index] && (
                <div className="mt-2 space-y-2">
                  {/* Arguments */}
                  {tc.args && Object.keys(tc.args).length > 0 && (
                    <div className="bg-gray-900 rounded p-2">
                      <div className="text-xs text-gray-500 mb-1">Arguments:</div>
                      <pre className="text-xs text-gray-400 overflow-x-auto">
                        {JSON.stringify(tc.args, null, 2)}
                      </pre>
                    </div>
                  )}

                  {/* Result */}
                  {tc.result && (
                    <div className="bg-gray-900 rounded p-2">
                      <div className="text-xs text-gray-500 mb-1">Result:</div>
                      <pre className="text-xs text-gray-400 overflow-x-auto max-h-32">
                        {typeof tc.result === 'string'
                          ? tc.result.substring(0, 500) + (tc.result.length > 500 ? '...' : '')
                          : JSON.stringify(tc.result, null, 2).substring(0, 500)}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {/* Empty State */}
          {reasoning.length === 0 && toolCalls.length === 0 && isStreaming && (
            <div className="text-gray-500 text-sm text-center py-2">
              Analyzing your request...
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ReasoningPanel;
