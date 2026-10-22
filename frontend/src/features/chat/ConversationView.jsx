import { useEffect, useLayoutEffect } from 'react';
import { Button, EmptyState, IconAlert, IconArrowDown } from '../../components/ui';
import { ChatMessage, StreamingMessage } from './ChatMessage';
import { PlayerHeadshotsContext } from './chatFormat';
import useAutoScroll from './useAutoScroll';

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
 * ({ isStreaming, content, timeline, blocks }).
 * Follows new content until the user scrolls up, then offers "Jump to latest".
 * With no messages it shows `welcome`; `loading` shows a skeleton and
 * `historyError` an error with retry while a saved chat loads.
 */
export default function ConversationView({
  messages,
  stream,
  showReasoning,
  headshots,
  welcome = null,
  loading = false,
  historyError = null,
  onRetryHistory,
  onRegenerate,
  onFeedback,
}) {
  const contentKey = [loading, messages.length, stream.isStreaming, stream.content?.length, stream.timeline?.steps?.length, stream.blocks?.length].join('|');
  const { ref, onScroll, pinned, scrollToBottom } = useAutoScroll(contentKey);

  // Sending a prompt always brings the conversation back into view
  const last = messages[messages.length - 1];
  useEffect(() => {
    if (last?.role === 'user') scrollToBottom();
  }, [last, scrollToBottom]);
  useEffect(() => {
    if (loading) scrollToBottom();
  }, [loading, scrollToBottom]);

  const empty = messages.length === 0 && !stream.isStreaming && !loading && !historyError;
  // The welcome screen reads top-down; don't leave it pinned to the bottom
  useLayoutEffect(() => {
    if (empty && ref.current) ref.current.scrollTop = 0;
  }, [empty, ref]);
  const lastIndex = messages.length - 1;
  const canRegenerate = !stream.isStreaming && last?.role === 'assistant';

  return (
    <div className="relative h-full">
      <div ref={ref} onScroll={onScroll} className="scrollbar-thin h-full overflow-y-auto overscroll-contain" data-testid="conversation-scroll">
        {historyError ? (
          <EmptyState
            className="h-full"
            icon={<IconAlert size={18} className="text-negative" />}
            title="Couldn't load this conversation"
            description={historyError}
            action={onRetryHistory && <Button size="sm" onClick={onRetryHistory}>Try again</Button>}
          />
        ) : empty ? (
          welcome
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
                      showReasoning={showReasoning}
                      onRegenerate={canRegenerate && idx === lastIndex ? onRegenerate : undefined}
                      onFeedback={onFeedback}
                    />
                  </div>
                ))
              )}
              {stream.isStreaming && (
                <StreamingMessage content={stream.content} timeline={stream.timeline} blocks={stream.blocks} showReasoning={showReasoning} isStreaming />
              )}
            </section>
          </PlayerHeadshotsContext.Provider>
        )}
      </div>
      {!pinned && !empty && !historyError && (
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
