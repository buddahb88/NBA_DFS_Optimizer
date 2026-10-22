// Chat turns: user prompts as compact right-aligned bubbles, assistant answers full-width
// with the assistant mark. Rich tool-result cards and the agent timeline come in later cards.
import { useDeferredValue, useState } from 'react';
import { Badge, IconCheck, IconCopy, IconRefresh, IconThumbDown, IconThumbUp, Tooltip, cn } from '../../components/ui';
import { ReasoningPanel } from '../../components/ReasoningPanel';
import { formatTimestamp } from './chatFormat';
import Markdown from './Markdown';
import useCopy from './useCopy';
import './chat.css';

/** Assistant mark: a basketball glyph on the accent tile. */
export function AssistantMark({ size = 28 }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg shadow-sm ring-1 ring-inset ring-white/10"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 3v18M3 12h18" />
        <path d="M5.6 5.6c2.6 2.4 2.6 10.4 0 12.8M18.4 5.6c-2.6 2.4-2.6 10.4 0 12.8" />
      </svg>
    </div>
  );
}

// Hidden until the turn is hovered or focused; always shown on touch screens and when `pinned`
const revealOnHover = 'opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 motion-reduce:transition-none';

function ActionButton({ label, onClick, pressed, children }) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={pressed}
        className={cn(
          'flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
          pressed && 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent',
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function CopyAction({ text, label = 'Copy message' }) {
  const { copied, copy } = useCopy();
  return (
    <ActionButton label={copied ? 'Copied' : label} onClick={() => copy(text)}>
      {copied ? <IconCheck size={14} className="text-positive" /> : <IconCopy size={14} />}
    </ActionButton>
  );
}

function FeedbackActions({ message, onFeedback }) {
  const [rating, setRating] = useState(message.feedback ?? null);

  const rate = async (next) => {
    if (next === rating) return;
    const previous = rating;
    setRating(next);
    const ok = await onFeedback(message, next);
    if (ok === false) setRating(previous);
  };

  return (
    <>
      <ActionButton label="Good response" pressed={rating === 'up'} onClick={() => rate('up')}>
        <IconThumbUp size={14} />
      </ActionButton>
      <ActionButton label="Bad response" pressed={rating === 'down'} onClick={() => rate('down')}>
        <IconThumbDown size={14} />
      </ActionButton>
    </>
  );
}

function Timestamp({ value, className }) {
  if (!value) return null;
  return (
    <time dateTime={value} title={new Date(value).toLocaleString()} className={cn('text-2xs text-fg-subtle', className)}>
      {formatTimestamp(value)}
    </time>
  );
}

function UsageBadges({ metadata }) {
  const tools = metadata?.toolsUsed || [];
  const agents = metadata?.agentsUsed || [];
  if (!tools.length && !agents.length) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-2xs text-fg-subtle">
      {agents.map((agent, i) => (
        <Badge key={`a${i}`} tone="accent" size="sm">
          {agent}
        </Badge>
      ))}
      {tools.slice(0, 5).map((tool, i) => (
        <Badge key={`t${i}`} tone="info" size="sm">
          {typeof tool === 'object' ? tool.name : tool}
        </Badge>
      ))}
      {tools.length > 5 && <Badge size="sm">+{tools.length - 5} more</Badge>}
    </div>
  );
}

function UserMessage({ message }) {
  return (
    <article className="group flex flex-col items-end py-2" aria-label="You">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent-soft px-3.5 py-2 text-sm leading-relaxed text-fg sm:max-w-[75%]">
        {message.content}
      </div>
      <div className={cn('mt-1 flex items-center gap-1', revealOnHover)}>
        <Timestamp value={message.created_at} className="px-1" />
        <CopyAction text={message.content} />
      </div>
    </article>
  );
}

function AssistantFrame({ header, children }) {
  return (
    <article className="group flex gap-3 py-4" aria-label="Assistant">
      <AssistantMark />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex h-7 items-center gap-2">
          <span className="text-xs font-semibold text-fg">DFS Assistant</span>
          {header}
        </div>
        {children}
      </div>
    </article>
  );
}

/**
 * One finished turn. Assistant answers get copy / feedback actions; `isLast`
 * keeps them visible and enables regenerate.
 */
export function ChatMessage({ message, isLast = false, onRegenerate, onFeedback }) {
  if (message.role === 'user') return <UserMessage message={message} />;

  if (message.isError) {
    return (
      <AssistantFrame header={<Timestamp value={message.created_at} className={revealOnHover} />}>
        <div role="alert" className="rounded-md border border-negative/30 bg-negative-soft px-3 py-2 text-sm text-negative">
          {message.content}
        </div>
        {isLast && onRegenerate && (
          <div className="mt-2 flex items-center gap-0.5">
            <ActionButton label="Regenerate response" onClick={onRegenerate}>
              <IconRefresh size={14} />
            </ActionButton>
          </div>
        )}
      </AssistantFrame>
    );
  }

  return (
    <AssistantFrame header={<Timestamp value={message.created_at} className={revealOnHover} />}>
      <Markdown>{message.content}</Markdown>
      <UsageBadges metadata={message.metadata} />
      <div className={cn('mt-2 flex items-center gap-0.5', !isLast && revealOnHover)}>
        <CopyAction text={message.content} />
        {isLast && onRegenerate && (
          <ActionButton label="Regenerate response" onClick={onRegenerate}>
            <IconRefresh size={14} />
          </ActionButton>
        )}
        {onFeedback && <FeedbackActions message={message} onFeedback={onFeedback} />}
      </div>
    </AssistantFrame>
  );
}

export function TypingIndicator({ label = 'Thinking' }) {
  return (
    <div role="status" className="flex h-6 items-center gap-2 text-xs text-fg-muted">
      <span className="flex items-center gap-1" aria-hidden="true">
        <span className="chat-typing-dot h-1.5 w-1.5 rounded-full bg-accent" />
        <span className="chat-typing-dot h-1.5 w-1.5 rounded-full bg-accent" />
        <span className="chat-typing-dot h-1.5 w-1.5 rounded-full bg-accent" />
      </span>
      <span>{label}…</span>
    </div>
  );
}

export function StreamingMessage({ content, reasoning, toolCalls, activeAgent, iterations, isStreaming }) {
  // Lets React drop intermediate markdown renders when chunks arrive faster than it can paint
  const deferred = useDeferredValue(content);
  const agentName = typeof activeAgent === 'string' ? activeAgent : activeAgent?.name;
  return (
    <AssistantFrame>
      <ReasoningPanel reasoning={reasoning} toolCalls={toolCalls} activeAgent={activeAgent} iterations={iterations} isStreaming={isStreaming} />
      {!deferred && <TypingIndicator label={agentName ? `${agentName} agent is working` : 'Thinking'} />}
      {/* Streaming prose is announced politely as it arrives */}
      <div aria-live="polite" aria-atomic="false">
        {deferred && <Markdown streaming={isStreaming}>{deferred}</Markdown>}
      </div>
    </AssistantFrame>
  );
}
