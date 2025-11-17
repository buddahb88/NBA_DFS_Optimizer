import { useState, useEffect, useRef, useMemo, createContext, useContext } from 'react';
import { chatAPI, slatesAPI, playersAPI } from '../services/api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { AgGridReact } from 'ag-grid-react';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-alpine.css';

// Register AG Grid modules
ModuleRegistry.registerModules([AllCommunityModule]);

// Create context for player headshots
const PlayerHeadshotsContext = createContext({});

// Player cell renderer component with headshot
function PlayerCellRenderer({ value }) {
  if (!value) return null;

  const playerHeadshots = useContext(PlayerHeadshotsContext);
  const [imageError, setImageError] = useState(false);

  // Create a simple hash from player name for consistent avatar colors
  const hash = value.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const colors = ['3b82f6', 'ef4444', '10b981', 'f59e0b', '8b5cf6', 'ec4899'];
  const bgColor = colors[hash % colors.length];

  // Get initials for fallback
  const initials = value
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  // Look up headshot from database
  const headshotUrl = playerHeadshots[value];

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
      {headshotUrl && !imageError ? (
        <img
          src={headshotUrl}
          alt={value}
          onError={() => setImageError(true)}
          style={{
            width: '40px',
            height: '40px',
            borderRadius: '50%',
            objectFit: 'cover',
            border: '2px solid #e5e7eb',
            flexShrink: 0,
            backgroundColor: '#f3f4f6',
          }}
        />
      ) : (
        <div style={{
          width: '40px',
          height: '40px',
          borderRadius: '50%',
          background: `linear-gradient(135deg, #${bgColor} 0%, #${bgColor}dd 100%)`,
          color: 'white',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: '600',
          fontSize: '12px',
          flexShrink: 0,
        }}>
          {initials}
        </div>
      )}
      <span style={{ fontWeight: '500' }}>{value}</span>
    </div>
  );
}

// Interactive data table component with AG Grid
function AGGridTable({ children }) {
  // Extract table data from React children
  const { columnDefs, rowData } = useMemo(() => {
    let headers = [];
    let rows = [];

    // Parse the React children to extract table structure
    const childArray = Array.isArray(children) ? children : [children];

    // Helper function to extract text content from nested children
    const extractText = (child) => {
      if (typeof child === 'string') return child;
      if (typeof child === 'number') return String(child);
      if (!child) return '';
      if (child.props?.children) {
        if (Array.isArray(child.props.children)) {
          return child.props.children.map(extractText).join('');
        }
        return extractText(child.props.children);
      }
      return '';
    };

    childArray.forEach((child) => {
      if (!child || !child.props) return;

      // Check by key instead of type (react-markdown uses keys like 'thead-0', 'tbody-0')
      const isTheadElement = child.key && child.key.startsWith('thead');
      const isTbodyElement = child.key && child.key.startsWith('tbody');

      // Extract headers from thead
      if (isTheadElement) {
        // Access the actual thead node from props
        const theadNode = child.props.node;
        const theadChildren = Array.isArray(child.props.children)
          ? child.props.children
          : [child.props.children];

        theadChildren.forEach((tr) => {
          if (!tr || !tr.props) return;
          const thChildren = Array.isArray(tr.props.children)
            ? tr.props.children
            : [tr.props.children];

          headers = thChildren
            .filter(th => th && th.props)
            .map((th, idx) => {
              const headerText = extractText(th);
              const isPlayerColumn = headerText && (
                headerText.toLowerCase().includes('player') ||
                headerText.toLowerCase() === 'name'
              );

              return {
                field: `col_${idx}`,
                headerName: headerText || `Column ${idx + 1}`,
                sortable: true,
                filter: true,
                resizable: true,
                flex: isPlayerColumn ? 1.5 : 1,
                minWidth: isPlayerColumn ? 180 : 100,
                cellRenderer: isPlayerColumn ? PlayerCellRenderer : undefined,
              };
            });
        });
      }

      // Extract rows from tbody
      if (isTbodyElement) {
        const tbodyChildren = Array.isArray(child.props.children)
          ? child.props.children
          : [child.props.children];

        rows = tbodyChildren
          .filter(tr => tr && tr.props)
          .map((tr) => {
            const tdChildren = Array.isArray(tr.props.children)
              ? tr.props.children
              : [tr.props.children];

            const rowData = {};
            tdChildren
              .filter(td => td && td.props)
              .forEach((td, idx) => {
                const cellContent = extractText(td);
                rowData[`col_${idx}`] = cellContent;
              });

            return rowData;
          });
      }
    });

    return { columnDefs: headers, rowData: rows };
  }, [children]);

  if (!columnDefs.length || !rowData.length) {

    // Fallback to regular table rendering if parsing fails
    return (
      <div className="overflow-x-auto my-6">
        <table className="min-w-full border-collapse border border-gray-300 rounded-lg">
          {children}
        </table>
      </div>
    );
  }

  return (
    <div className="my-6 ag-theme-alpine" style={{ width: '100%' }}>
      <AgGridReact
        columnDefs={columnDefs}
        rowData={rowData}
        theme="legacy"
        defaultColDef={{
          sortable: true,
          filter: true,
          resizable: true,
        }}
        animateRows={true}
        pagination={rowData.length > 10}
        paginationPageSize={10}
        domLayout="autoHeight"
      />
    </div>
  );
}

// Code block component with copy button
function CodeBlock({ inline, className, children, ...props }) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : '';
  const code = String(children).replace(/\n$/, '');

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (inline) {
    return (
      <code className="bg-gray-100 text-red-600 px-1.5 py-0.5 rounded text-sm font-mono" {...props}>
        {children}
      </code>
    );
  }

  return (
    <div className="relative group my-4">
      <div className="absolute top-2 right-2 z-10">
        <button
          onClick={handleCopy}
          className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-white rounded opacity-0 group-hover:opacity-100 transition-opacity duration-200 font-medium"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      {language ? (
        <>
          <div className="bg-gray-800 text-gray-300 px-4 py-2 text-xs font-semibold rounded-t-lg border-b border-gray-700">
            {language}
          </div>
          <SyntaxHighlighter
            style={vscDarkPlus}
            language={language}
            PreTag="div"
            className="!mt-0 !rounded-t-none !rounded-b-lg"
            {...props}
          >
            {code}
          </SyntaxHighlighter>
        </>
      ) : (
        <SyntaxHighlighter
          style={vscDarkPlus}
          language="text"
          PreTag="div"
          className="!rounded-lg"
          {...props}
        >
          {code}
        </SyntaxHighlighter>
      )}
    </div>
  );
}

// Custom markdown components for Claude-style rendering
const MarkdownComponents = {
  code: CodeBlock,
  h1: ({ children }) => (
    <h1 className="text-2xl font-semibold mb-4 mt-6 text-gray-900">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-xl font-semibold mb-3 mt-5 text-gray-900">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-lg font-semibold mb-2 mt-4 text-gray-900">{children}</h3>
  ),
  p: ({ children }) => <p className="mb-4 leading-7 text-gray-800">{children}</p>,
  ul: ({ children }) => (
    <ul className="list-disc list-outside mb-4 space-y-2 ml-6 text-gray-800">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal list-outside mb-4 space-y-2 ml-6 text-gray-800">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-7 pl-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-blue-500 pl-4 py-2 my-4 italic text-gray-700 bg-blue-50">
      {children}
    </blockquote>
  ),
  table: ({ children }) => <AGGridTable>{children}</AGGridTable>,
  thead: ({ children }) => <thead>{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children }) => <th>{children}</th>,
  td: ({ children }) => <td>{children}</td>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-600 hover:text-blue-700 underline font-medium"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-gray-900">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  hr: () => <hr className="my-6 border-gray-300" />,
};

// Message component - Claude style
function Message({ message, formatTimestamp }) {
  const isUser = message.role === 'user';
  const isError = message.isError;

  return (
    <div className={`w-full ${isUser ? 'bg-gray-50' : 'bg-white'} ${isError ? 'bg-red-50' : ''}`}>
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="flex gap-4">
          {/* Avatar */}
          <div className="flex-shrink-0 pt-1">
            {isUser ? (
              <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white font-semibold text-sm">
                U
              </div>
            ) : (
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-orange-400 to-red-500 flex items-center justify-center text-lg">
                🏀
              </div>
            )}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            {/* Role label */}
            <div className="text-xs font-semibold mb-2 text-gray-500 uppercase tracking-wide">
              {isUser ? 'You' : 'Assistant'}
            </div>

            {/* Message content */}
            <div className={isUser ? '' : 'prose prose-sm max-w-none'}>
              {isUser ? (
                <p className="text-gray-800 leading-7 whitespace-pre-wrap">
                  {message.content}
                </p>
              ) : (
                <div className="text-gray-800">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={MarkdownComponents}
                  >
                    {message.content}
                  </ReactMarkdown>
                </div>
              )}
            </div>

            {/* Tools used metadata */}
            {message.metadata?.toolsUsed && message.metadata.toolsUsed.length > 0 && (
              <div className="mt-4 pt-4 border-t border-gray-200">
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <span>Tools used:</span>
                  <div className="flex flex-wrap gap-1.5">
                    {message.metadata.toolsUsed.map((tool, i) => (
                      <span
                        key={i}
                        className="px-2 py-1 bg-blue-100 text-blue-700 rounded text-xs font-medium"
                      >
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Timestamp */}
            {message.created_at && (
              <div className="text-xs text-gray-400 mt-3">
                {formatTimestamp(message.created_at)}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Typing indicator component
function TypingIndicator() {
  return (
    <div className="w-full bg-white">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="flex gap-4">
          <div className="flex-shrink-0 pt-1">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-orange-400 to-red-500 flex items-center justify-center text-lg">
              🏀
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold mb-2 text-gray-500 uppercase tracking-wide">
              Assistant
            </div>
            <div className="flex gap-1.5 pt-2">
              <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
              <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
              <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ChatPage() {
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [showSessions, setShowSessions] = useState(false);
  const [playerHeadshots, setPlayerHeadshots] = useState({});
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // Scroll to bottom when messages change
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Load sessions and player headshots on mount
  useEffect(() => {
    loadSessions();
    loadPlayerHeadshots();
  }, []);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
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

  const loadPlayerHeadshots = async () => {
    try {
      // Get active slate
      const slateResponse = await slatesAPI.getActiveSlate();

      // The API returns the slate object directly, not wrapped in success/slate
      if (slateResponse.data && slateResponse.data.slate_id) {
        const slateId = slateResponse.data.slate_id;

        // Get all players for active slate
        const playersResponse = await playersAPI.getBySlateId(slateId);

        // The API returns the array directly
        if (Array.isArray(playersResponse.data)) {
          // Create a map of player name -> headshot URL
          const headshotsMap = {};
          playersResponse.data.forEach(player => {
            if (player.headshot) {
              headshotsMap[player.name] = player.headshot;
            }
          });
          setPlayerHeadshots(headshotsMap);
        }
      }
    } catch (error) {
      console.error('Failed to load player headshots:', error);
    }
  };

  const loadSessionHistory = async (sessionIdToLoad) => {
    try {
      const response = await chatAPI.getSessionHistory(sessionIdToLoad);
      if (response.data.success) {
        setMessages(response.data.messages);
        setSessionId(sessionIdToLoad);
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
    inputRef.current?.focus();
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
      inputRef.current?.focus();
    }
  };

  const deleteSession = async (sessionIdToDelete) => {
    if (!confirm('Delete this conversation?')) return;

    try {
      await chatAPI.deleteSession(sessionIdToDelete);
      loadSessions();
      if (sessionIdToDelete === sessionId) {
        createNewSession();
      }
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  };

  const formatTimestamp = (timestamp) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffInMs = now - date;
    const diffInMins = Math.floor(diffInMs / 60000);

    if (diffInMins < 1) return 'Just now';
    if (diffInMins < 60) return `${diffInMins}m ago`;

    const diffInHours = Math.floor(diffInMins / 60);
    if (diffInHours < 24) return `${diffInHours}h ago`;

    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  // Suggested prompts
  const suggestedPrompts = [
    { icon: '💰', text: 'Show me top value plays under $6000' },
    { icon: '🔒', text: 'Lock Luka Doncic and build an optimal lineup' },
    { icon: '📊', text: 'Which games have the highest Vegas totals?' },
    { icon: '🎯', text: 'Find high usage, low ownership players' },
    { icon: '⚔️', text: 'Analyze Lakers vs Warriors for DFS' },
  ];

  return (
    <PlayerHeadshotsContext.Provider value={playerHeadshots}>
      <div className="flex h-screen bg-white">
      {/* Sidebar - Sessions List */}
      <div
        className={`${
          showSessions ? 'w-72' : 'w-0'
        } bg-gray-900 text-white transition-all duration-300 flex flex-col overflow-hidden`}
      >
        {showSessions && (
          <>
            <div className="p-4 border-b border-gray-700">
              <button
                onClick={createNewSession}
                className="w-full px-4 py-2.5 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors text-sm font-medium flex items-center justify-center gap-2"
              >
                <span className="text-lg">+</span>
                New chat
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              {sessions.length === 0 ? (
                <div className="text-center text-gray-500 text-sm py-8">
                  No conversations yet
                </div>
              ) : (
                sessions.map((session) => (
                  <div
                    key={session.id}
                    className={`group relative mb-1 rounded-lg hover:bg-gray-800 cursor-pointer transition-colors ${
                      session.id === sessionId ? 'bg-gray-800' : ''
                    }`}
                  >
                    <button
                      className="w-full p-3 text-left flex items-center gap-3"
                      onClick={() => loadSessionHistory(session.id)}
                    >
                      <span className="text-lg">💬</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm truncate">
                          {session.title || 'Chat Session'}
                        </div>
                        <div className="text-xs text-gray-500">
                          {session.message_count} messages
                        </div>
                      </div>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteSession(session.id);
                      }}
                      className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-400 transition-opacity"
                      title="Delete conversation"
                    >
                      🗑️
                    </button>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3 shadow-sm">
          <button
            onClick={() => setShowSessions(!showSessions)}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors text-gray-600"
            title={showSessions ? 'Hide sidebar' : 'Show sidebar'}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-orange-400 to-red-500 flex items-center justify-center text-lg">
              🏀
            </div>
            <div>
              <h1 className="text-base font-semibold text-gray-900">
                NBA DFS AI Assistant
              </h1>
            </div>
          </div>
        </div>

        {/* Messages Area */}
        <div className="flex-1 overflow-y-auto px-4">
          {messages.length === 0 ? (
            <div className="max-w-3xl mx-auto py-12">
              {/* Welcome Section */}
              <div className="text-center mb-12">
                <div className="text-6xl mb-4">🏀</div>
                <h2 className="text-3xl font-semibold text-gray-900 mb-2">
                  NBA DFS AI Assistant
                </h2>
                <p className="text-gray-600">
                  Get expert insights on player analysis, lineup optimization, and matchup breakdowns
                </p>
              </div>

              {/* Suggested Prompts */}
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-gray-700 mb-3 px-1">
                  Suggested prompts
                </h3>
                {suggestedPrompts.map((prompt, index) => (
                  <button
                    key={index}
                    onClick={() => setInputMessage(prompt.text)}
                    className="w-full text-left p-4 bg-gray-50 hover:bg-gray-100 rounded-lg border border-gray-200 hover:border-gray-300 transition-all group"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-xl group-hover:scale-110 transition-transform">
                        {prompt.icon}
                      </span>
                      <span className="text-sm text-gray-700 font-medium">
                        {prompt.text}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto py-4">
              {messages.map((msg, idx) => (
                <Message
                  key={`${msg.created_at}-${idx}`}
                  message={msg}
                  formatTimestamp={formatTimestamp}
                />
              ))}

              {isLoading && <TypingIndicator />}
              
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input Area */}
        <div className="border-t border-gray-200 bg-white">
          <div className="max-w-3xl mx-auto px-4 py-3">
            <form onSubmit={handleSendMessage} className="relative">
              <input
                ref={inputRef}
                type="text"
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                placeholder="Message NBA DFS AI Assistant..."
                className="w-full px-4 py-3 pr-12 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all text-gray-900 placeholder-gray-400 bg-white shadow-sm"
                disabled={isLoading}
              />
              <button
                type="submit"
                disabled={isLoading || !inputMessage.trim()}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-gray-400 hover:text-gray-600 disabled:text-gray-300 disabled:cursor-not-allowed transition-colors"
                title="Send message"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
    </PlayerHeadshotsContext.Provider>
  );
}
