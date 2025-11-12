import { useState, useEffect, useRef } from 'react';
import { chatAPI } from '../services/api';

export default function ChatPage() {
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [showSessions, setShowSessions] = useState(false);
  const messagesEndRef = useRef(null);

  // Scroll to bottom when messages change
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Load sessions on mount
  useEffect(() => {
    loadSessions();
  }, []);

  const loadSessions = async () => {
    try {
      const response = await chatAPI.getSessions();
      if (response.data.success) {
        setSessions(response.data.sessions);
      }
    } catch (error) {
      console.error('Failed to load sessions:', error);
    }
  };

  const loadSessionHistory = async (sessionId) => {
    try {
      const response = await chatAPI.getSessionHistory(sessionId);
      if (response.data.success) {
        setMessages(response.data.messages);
        setSessionId(sessionId);
        setShowSessions(false);
      }
    } catch (error) {
      console.error('Failed to load session history:', error);
    }
  };

  const createNewSession = async () => {
    setMessages([]);
    setSessionId(null);
    setShowSessions(false);
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();

    if (!inputMessage.trim() || isLoading) return;

    const userMessage = {
      role: 'user',
      content: inputMessage,
      created_at: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputMessage('');
    setIsLoading(true);

    try {
      const response = await chatAPI.sendMessage(inputMessage, sessionId);

      if (response.data.success) {
        const assistantMessage = {
          role: 'assistant',
          content: response.data.message,
          metadata: { toolsUsed: response.data.toolsUsed },
          created_at: new Date().toISOString(),
        };

        setMessages((prev) => [...prev, assistantMessage]);

        // Update session ID if it was a new session
        if (!sessionId && response.data.sessionId) {
          setSessionId(response.data.sessionId);
          loadSessions(); // Refresh sessions list
        }
      } else {
        throw new Error(response.data.error || 'Failed to get response');
      }
    } catch (error) {
      console.error('Chat error:', error);
      const errorMessage = {
        role: 'assistant',
        content: 'Sorry, I encountered an error. Please try again.',
        created_at: new Date().toISOString(),
        isError: true,
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const deleteSession = async (sessionId) => {
    if (!confirm('Delete this conversation?')) return;

    try {
      await chatAPI.deleteSession(sessionId);
      loadSessions();
      if (sessionId === sessionId) {
        createNewSession();
      }
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  };

  const formatTimestamp = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar - Sessions List */}
      <div
        className={`${
          showSessions ? 'w-64' : 'w-12'
        } bg-white border-r border-gray-200 transition-all duration-300 flex flex-col`}
      >
        <button
          onClick={() => setShowSessions(!showSessions)}
          className="p-3 hover:bg-gray-100 text-gray-600 border-b border-gray-200"
          title={showSessions ? 'Hide sessions' : 'Show sessions'}
        >
          {showSessions ? '◀' : '☰'}
        </button>

        {showSessions && (
          <>
            <button
              onClick={createNewSession}
              className="m-2 p-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors text-sm"
            >
              + New Chat
            </button>

            <div className="flex-1 overflow-y-auto">
              {sessions.map((session) => (
                <div
                  key={session.id}
                  className={`p-3 border-b border-gray-100 hover:bg-gray-50 cursor-pointer ${
                    session.id === sessionId ? 'bg-blue-50' : ''
                  }`}
                  onClick={() => loadSessionHistory(session.id)}
                >
                  <div className="flex justify-between items-start">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 truncate">
                        {session.title || 'Chat Session'}
                      </div>
                      <div className="text-xs text-gray-500">
                        {session.message_count} messages
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteSession(session.id);
                      }}
                      className="ml-2 text-gray-400 hover:text-red-500 text-xs"
                      title="Delete"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="bg-white border-b border-gray-200 p-4">
          <h1 className="text-2xl font-bold text-gray-800">
            NBA DFS AI Assistant
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            Ask me about players, build lineups, analyze matchups, or get betting insights
          </p>
        </div>

        {/* Messages Area */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && (
            <div className="text-center py-12">
              <div className="text-6xl mb-4">🏀</div>
              <h2 className="text-xl font-semibold text-gray-700 mb-2">
                Welcome to NBA DFS AI Assistant
              </h2>
              <p className="text-gray-600 mb-6 max-w-2xl mx-auto">
                I can help you with player analysis, lineup construction, betting insights, and more.
              </p>

              <div className="max-w-2xl mx-auto text-left space-y-3">
                <div className="bg-white p-4 rounded-lg border border-gray-200">
                  <p className="font-semibold text-gray-800 mb-1">Try asking:</p>
                  <ul className="text-sm text-gray-600 space-y-1 list-disc list-inside">
                    <li>"Show me the top value plays under $6000"</li>
                    <li>"Lock Luka Doncic and build an optimal GPP lineup"</li>
                    <li>"Which games have the highest Vegas totals tonight?"</li>
                    <li>"Find players with high usage and low ownership"</li>
                    <li>"Analyze the Lakers vs Warriors matchup for DFS"</li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {messages.map((msg, idx) => (
            <div
              key={idx}
              className={`flex ${
                msg.role === 'user' ? 'justify-end' : 'justify-start'
              }`}
            >
              <div
                className={`max-w-3xl rounded-lg p-4 ${
                  msg.role === 'user'
                    ? 'bg-blue-500 text-white'
                    : msg.isError
                    ? 'bg-red-50 border border-red-200 text-red-800'
                    : 'bg-white border border-gray-200 text-gray-800'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className="text-2xl">
                    {msg.role === 'user' ? '👤' : '🤖'}
                  </div>
                  <div className="flex-1">
                    <div className="whitespace-pre-wrap break-words">
                      {msg.content}
                    </div>
                    {msg.metadata?.toolsUsed &&
                      msg.metadata.toolsUsed.length > 0 && (
                        <div className="mt-2 text-xs opacity-75">
                          Tools used: {msg.metadata.toolsUsed.join(', ')}
                        </div>
                      )}
                    {msg.created_at && (
                      <div className="text-xs opacity-75 mt-2">
                        {formatTimestamp(msg.created_at)}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}

          {isLoading && (
            <div className="flex justify-start">
              <div className="max-w-3xl rounded-lg p-4 bg-white border border-gray-200">
                <div className="flex items-center gap-3">
                  <div className="text-2xl">🤖</div>
                  <div className="flex gap-1">
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-100"></div>
                    <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-200"></div>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="bg-white border-t border-gray-200 p-4">
          <form onSubmit={handleSendMessage} className="flex gap-2">
            <input
              type="text"
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              placeholder="Ask me anything about NBA DFS..."
              className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              disabled={isLoading}
            />
            <button
              type="submit"
              disabled={isLoading || !inputMessage.trim()}
              className="px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors font-medium"
            >
              {isLoading ? 'Sending...' : 'Send'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
