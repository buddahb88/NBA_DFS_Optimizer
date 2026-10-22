// Message rendering carried over from the old ChatPage, restyled with theme tokens.
// Rich tool-result cards and the agent timeline replace parts of this in later cards.
import { useContext, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { AgGridReact } from 'ag-grid-react';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-alpine.css';
import { Badge, IconBolt, cn } from '../../components/ui';
import { ReasoningPanel } from '../../components/ReasoningPanel';
import { PlayerHeadshotsContext, formatTimestamp } from './chatFormat';
import './chat.css';

ModuleRegistry.registerModules([AllCommunityModule]);

const AVATAR_COLORS = ['3b82f6', 'ef4444', '10b981', 'f59e0b', '8b5cf6', 'ec4899'];

function PlayerCellRenderer({ value }) {
  const playerHeadshots = useContext(PlayerHeadshotsContext);
  const [imageError, setImageError] = useState(false);
  if (!value) return null;

  // Consistent fallback colour per name
  const hash = value.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const bgColor = AVATAR_COLORS[hash % AVATAR_COLORS.length];
  const initials = value
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
  const headshotUrl = playerHeadshots[value];

  return (
    <div className="flex items-center gap-2.5">
      {headshotUrl && !imageError ? (
        <img
          src={headshotUrl}
          alt={value}
          onError={() => setImageError(true)}
          className="h-8 w-8 shrink-0 rounded-full border border-line bg-surface-sunken object-cover"
        />
      ) : (
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-2xs font-semibold text-white"
          style={{ background: `#${bgColor}` }}
        >
          {initials}
        </div>
      )}
      <span className="font-medium">{value}</span>
    </div>
  );
}

// Markdown table -> AG Grid. Falls back to a plain table when parsing fails.
function AGGridTable({ children }) {
  const { columnDefs, rowData } = useMemo(() => {
    let headers = [];
    let rows = [];
    const childArray = Array.isArray(children) ? children : [children];

    const extractText = (child) => {
      if (typeof child === 'string') return child;
      if (typeof child === 'number') return String(child);
      if (!child) return '';
      if (child.props?.children) {
        if (Array.isArray(child.props.children)) return child.props.children.map(extractText).join('');
        return extractText(child.props.children);
      }
      return '';
    };

    childArray.forEach((child) => {
      if (!child || !child.props) return;
      // react-markdown keys its sections 'thead-0', 'tbody-0'
      const isThead = child.key && child.key.startsWith('thead');
      const isTbody = child.key && child.key.startsWith('tbody');

      if (isThead) {
        const theadChildren = Array.isArray(child.props.children) ? child.props.children : [child.props.children];
        theadChildren.forEach((tr) => {
          if (!tr || !tr.props) return;
          const thChildren = Array.isArray(tr.props.children) ? tr.props.children : [tr.props.children];
          headers = thChildren
            .filter((th) => th && th.props)
            .map((th, idx) => {
              const headerText = extractText(th);
              const isPlayerColumn = headerText && (headerText.toLowerCase().includes('player') || headerText.toLowerCase() === 'name');
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

      if (isTbody) {
        const tbodyChildren = Array.isArray(child.props.children) ? child.props.children : [child.props.children];
        rows = tbodyChildren
          .filter((tr) => tr && tr.props)
          .map((tr) => {
            const tdChildren = Array.isArray(tr.props.children) ? tr.props.children : [tr.props.children];
            const row = {};
            tdChildren
              .filter((td) => td && td.props)
              .forEach((td, idx) => {
                row[`col_${idx}`] = extractText(td);
              });
            return row;
          });
      }
    });

    return { columnDefs: headers, rowData: rows };
  }, [children]);

  if (!columnDefs.length || !rowData.length) {
    return (
      <div className="my-4 overflow-x-auto">
        <table className="min-w-full border-collapse rounded border border-line text-sm">{children}</table>
      </div>
    );
  }

  return (
    <div className="chat-grid ag-theme-alpine my-4 w-full">
      <AgGridReact
        columnDefs={columnDefs}
        rowData={rowData}
        theme="legacy"
        defaultColDef={{ sortable: true, filter: true, resizable: true }}
        animateRows
        pagination={rowData.length > 10}
        paginationPageSize={10}
        domLayout="autoHeight"
      />
    </div>
  );
}

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
      <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[0.85em] text-fg" {...props}>
        {children}
      </code>
    );
  }

  return (
    <div className="group relative my-4">
      <div className="absolute right-2 top-2 z-10">
        <button
          type="button"
          onClick={handleCopy}
          className="rounded bg-white/10 px-2.5 py-1 text-2xs font-medium text-white opacity-0 transition-opacity hover:bg-white/20 focus-visible:opacity-100 group-hover:opacity-100"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      {language && (
        <div className="rounded-t-md border-b border-white/10 bg-[#1e1e1e] px-4 py-1.5 text-2xs font-semibold text-gray-300">{language}</div>
      )}
      <SyntaxHighlighter
        style={vscDarkPlus}
        language={language || 'text'}
        PreTag="div"
        className={language ? '!mt-0 !rounded-b-md !rounded-t-none' : '!rounded-md'}
        {...props}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

const MarkdownComponents = {
  code: CodeBlock,
  h1: ({ children }) => <h1 className="mb-3 mt-5 text-xl font-semibold text-fg">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-4 text-lg font-semibold text-fg">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-2 mt-3 text-base font-semibold text-fg">{children}</h3>,
  p: ({ children }) => <p className="mb-3 leading-7">{children}</p>,
  ul: ({ children }) => <ul className="mb-3 ml-5 list-outside list-disc space-y-1.5">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 ml-5 list-outside list-decimal space-y-1.5">{children}</ol>,
  li: ({ children }) => <li className="pl-1 leading-7">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-accent bg-accent-soft/40 py-1.5 pl-3 text-fg-muted">{children}</blockquote>
  ),
  table: ({ children }) => <AGGridTable>{children}</AGGridTable>,
  thead: ({ children }) => <thead>{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children }) => <th className="border border-line px-2 py-1 text-left">{children}</th>,
  td: ({ children }) => <td className="border border-line px-2 py-1">{children}</td>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-accent underline hover:text-accent-hover">
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  hr: () => <hr className="my-5 border-line" />,
};

export function Markdown({ children }) {
  return (
    <div className="text-sm text-fg">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MarkdownComponents}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function AssistantAvatar() {
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-accent-fg" aria-hidden="true">
      <IconBolt size={14} />
    </div>
  );
}

function UserAvatar() {
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-surface-raised text-2xs font-semibold text-fg-muted" aria-hidden="true">
      You
    </div>
  );
}

function MessageFrame({ avatar, label, extra, tone, children }) {
  return (
    <article
      className={cn(
        'flex gap-3 rounded-lg px-3 py-4 sm:px-4',
        tone === 'user' && 'bg-surface-raised',
        tone === 'error' && 'border border-negative/30 bg-negative-soft',
      )}
    >
      <div className="pt-0.5">{avatar}</div>
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-2xs font-semibold uppercase tracking-wide text-fg-subtle">{label}</span>
          {extra}
        </div>
        {children}
      </div>
    </article>
  );
}

export function ChatMessage({ message }) {
  const isUser = message.role === 'user';
  const meta = message.metadata;
  const tools = meta?.toolsUsed || [];
  const agents = meta?.agentsUsed || [];

  return (
    <MessageFrame
      avatar={isUser ? <UserAvatar /> : <AssistantAvatar />}
      label={isUser ? 'You' : 'Assistant'}
      tone={message.isError ? 'error' : isUser ? 'user' : null}
    >
      {isUser ? (
        <p className="whitespace-pre-wrap text-sm leading-7 text-fg">{message.content}</p>
      ) : (
        <Markdown>{message.content}</Markdown>
      )}

      {(tools.length > 0 || agents.length > 0) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-3 text-2xs text-fg-subtle">
          {agents.length > 0 && (
            <>
              <span>Agents</span>
              {agents.map((agent, i) => (
                <Badge key={i} tone="accent" size="sm">
                  {agent}
                </Badge>
              ))}
            </>
          )}
          {tools.length > 0 && (
            <>
              <span className={agents.length ? 'ml-2' : undefined}>Tools</span>
              {tools.slice(0, 5).map((tool, i) => (
                <Badge key={i} tone="info" size="sm">
                  {typeof tool === 'object' ? tool.name : tool}
                </Badge>
              ))}
              {tools.length > 5 && <Badge size="sm">+{tools.length - 5} more</Badge>}
            </>
          )}
        </div>
      )}

      {message.created_at && <div className="mt-2 text-2xs text-fg-subtle">{formatTimestamp(message.created_at)}</div>}
    </MessageFrame>
  );
}

export function StreamingMessage({ content, reasoning, toolCalls, activeAgent, iterations, isStreaming }) {
  return (
    <MessageFrame
      avatar={<AssistantAvatar />}
      label="Assistant"
      extra={
        isStreaming && (
          <span className="flex items-center gap-1 text-2xs text-positive">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-positive motion-reduce:animate-none" />
            Thinking…
          </span>
        )
      }
    >
      <ReasoningPanel reasoning={reasoning} toolCalls={toolCalls} activeAgent={activeAgent} iterations={iterations} isStreaming={isStreaming} />
      {/* Streaming prose is announced politely as it arrives */}
      <div aria-live="polite" aria-atomic="false">
        {content && <Markdown>{content}</Markdown>}
      </div>
    </MessageFrame>
  );
}
