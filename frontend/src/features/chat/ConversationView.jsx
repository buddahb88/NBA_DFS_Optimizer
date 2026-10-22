import { useEffect } from 'react';
import { IconArrowDown, IconBolt, IconChart, IconSearch, IconUsers } from '../../components/ui';
import { AssistantMark, ChatMessage, StreamingMessage } from './ChatMessage';
import { PlayerHeadshotsContext } from './chatFormat';
import useAutoScroll from './useAutoScroll';

const SUGGESTED_PROMPTS = [
  { icon: IconBolt, text: 'Show me top value plays under $6000' },
  { icon: IconUsers, text: 'Lock Luka Doncic and build an optimal lineup' },
  { icon: IconChart, text: 'Which games have the highest Vegas totals?' },
  { icon: IconSearch, text: 'Find high usage, low ownership players' },
];

function Welcome({ onPickPrompt }) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center px-4 py-12 text-center sm:py-16">
      <AssistantMark size={44} />
      <h2 className="mt-4 text-xl font-semibold text-fg">What are we building tonight?</h2>
      <p className="mt-1.5 max-w-md text-sm text-fg-muted">
        Ask about value plays, matchups, stacks or lineups. Specialist agents (Optimizer, Research, Analyst) dig into the slate for you.
      </p>
      <div className="mt-8 grid w-full gap-2 sm:grid-cols-2">
        {SUGGESTED_PROMPTS.map((prompt) => (
          <button
            key={prompt.text}
            type="button"
            onClick={() => onPickPrompt(prompt.text)}
            className="flex items-center gap-3 rounded-lg border border-line bg-surface p-3 text-left text-sm text-fg-muted transition-colors hover:border-line-strong hover:bg-surface-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <prompt.icon size={16} className="shrink-0 text-accent" />
            <span>{prompt.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const bar = 'rounded bg-surface-raised animate-pulse motion-reduce:animate-none';

function HistorySkeleton() {
  return (
    <div role="status" aria-label="Loading conversation" className="flex flex-col gap-6 py-4">
      <span className="sr-only">Loading conversation…</span>
      {[0, 1].map((i) => (
        <div key={i} className="flex flex-col gap-6" aria-hidden="true">
          <div className={`ml-auto h-9 w-2/5 rounded-2xl ${bar}`} />
          <div className="flex gap-3">
            <div className={`h-7 w-7 shrink-0 rounded-lg ${bar}`} />
            <div className="flex flex-1 flex-col gap-2 pt-1.5">
              <div className={`h-3 w-24 ${bar}`} />
              <div className={`h-3 w-full ${bar}`} />
              <div className={`h-3 w-11/12 ${bar}`} />
              <div className={`h-3 w-3/5 ${bar}`} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Scrollable message list. `stream` is the live agent stream
 * ({ isStreaming, content, reasoning, toolCalls, activeAgent, iterations }).
 * Follows new content until the user scrolls up, then offers "Jump to latest".
 */
export default function ConversationView({ messages, stream, showReasoning, headshots, loading = false, onPickPrompt, onRegenerate, onFeedback }) {
  const reasoning = showReasoning ? stream.reasoning : [];
  const toolCalls = showReasoning ? stream.toolCalls : [];
  const contentKey = [loading, messages.length, stream.isStreaming, stream.content?.length, reasoning?.length, toolCalls?.length].join('|');
  const { ref, onScroll, pinned, scrollToBottom } = useAutoScroll(contentKey);

  // Sending a prompt always brings the conversation back into view
  const last = messages[messages.length - 1];
  useEffect(() => {
    if (last?.role === 'user') scrollToBottom();
  }, [last, scrollToBottom]);
  useEffect(() => {
    if (loading) scrollToBottom();
  }, [loading, scrollToBottom]);

  const empty = messages.length === 0 && !stream.isStreaming && !loading;
  const lastIndex = messages.length - 1;
  const canRegenerate = !stream.isStreaming && last?.role === 'assistant';

  return (
    <div className="relative h-full">
      <div ref={ref} onScroll={onScroll} className="scrollbar-thin h-full overflow-y-auto" data-testid="conversation-scroll">
        {empty ? (
          <Welcome onPickPrompt={onPickPrompt} />
        ) : (
          <PlayerHeadshotsContext.Provider value={headshots}>
            <section className="mx-auto flex max-w-3xl flex-col px-3 pb-6 pt-2 sm:px-6" aria-label="Conversation">
              {loading ? (
                <HistorySkeleton />
              ) : (
                messages.map((msg, idx) => (
                  // Subtle rule between an answer and the next prompt
                  <div key={msg.id ?? `${msg.created_at}-${idx}`} className={idx > 0 && msg.role === 'user' ? 'mt-2 border-t border-line/60 pt-2' : undefined}>
                    <ChatMessage
                      message={msg}
                      isLast={idx === lastIndex}
                      onRegenerate={canRegenerate && idx === lastIndex ? onRegenerate : undefined}
                      onFeedback={onFeedback}
                    />
                  </div>
                ))
              )}
              {stream.isStreaming && (
                <StreamingMessage
                  content={stream.content}
                  reasoning={reasoning}
                  toolCalls={toolCalls}
                  activeAgent={stream.activeAgent}
                  iterations={stream.iterations}
                  isStreaming
                />
              )}
            </section>
          </PlayerHeadshotsContext.Provider>
        )}
      </div>
      {!pinned && !empty && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-surface-raised px-3 py-1.5 text-xs font-medium text-fg shadow-pop transition-colors animate-fade-in hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 motion-reduce:animate-none"
        >
          <IconArrowDown size={13} />
          Jump to latest
        </button>
      )}
    </div>
  );
}
