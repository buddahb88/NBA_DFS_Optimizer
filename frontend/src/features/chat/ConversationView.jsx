import { useEffect, useRef } from 'react';
import { IconBolt, IconChart, IconSearch, IconUsers } from '../../components/ui';
import { ChatMessage, StreamingMessage } from './ChatMessage';
import { PlayerHeadshotsContext } from './chatFormat';

const SUGGESTED_PROMPTS = [
  { icon: IconBolt, text: 'Show me top value plays under $6000' },
  { icon: IconUsers, text: 'Lock Luka Doncic and build an optimal lineup' },
  { icon: IconChart, text: 'Which games have the highest Vegas totals?' },
  { icon: IconSearch, text: 'Find high usage, low ownership players' },
];

function Welcome({ onPickPrompt }) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center px-4 py-12 text-center sm:py-16">
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-lg bg-accent text-accent-fg">
        <IconBolt size={20} />
      </div>
      <h2 className="text-xl font-semibold text-fg">What are we building tonight?</h2>
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

/**
 * Scrollable message list. `stream` is the live agent stream
 * ({ isStreaming, content, reasoning, toolCalls, activeAgent, iterations }).
 */
export default function ConversationView({ messages, stream, showReasoning, headshots, onPickPrompt }) {
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [messages, stream.content, stream.reasoning]);

  if (messages.length === 0 && !stream.isStreaming) {
    return <Welcome onPickPrompt={onPickPrompt} />;
  }

  return (
    <PlayerHeadshotsContext.Provider value={headshots}>
      <div className="mx-auto flex max-w-3xl flex-col gap-1 px-3 py-4 sm:px-4" role="log" aria-label="Conversation">
        {messages.map((msg, idx) => (
          <ChatMessage key={`${msg.created_at}-${idx}`} message={msg} />
        ))}
        {stream.isStreaming && (
          <StreamingMessage
            content={stream.content}
            reasoning={showReasoning ? stream.reasoning : []}
            toolCalls={showReasoning ? stream.toolCalls : []}
            activeAgent={stream.activeAgent}
            iterations={stream.iterations}
            isStreaming
          />
        )}
        <div ref={endRef} />
      </div>
    </PlayerHeadshotsContext.Provider>
  );
}
