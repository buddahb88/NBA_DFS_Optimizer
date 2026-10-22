import { forwardRef } from 'react';
import { IconArrowUp, IconStop } from '../../components/ui';

/** Single-line message input. Enter sends; while streaming the stop button cancels. */
const Composer = forwardRef(function Composer({ value, onChange, onSubmit, onCancel, isStreaming, maxIterations }, ref) {
  const canSend = !isStreaming && value.trim().length > 0;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (canSend) onSubmit(value);
  };

  return (
    <div className="shrink-0 border-t border-line bg-surface px-3 py-3 sm:px-4">
      <form onSubmit={handleSubmit} className="mx-auto max-w-3xl">
        <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-sunken p-1.5 pl-3 transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30">
          <input
            ref={ref}
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Ask about tonight's slate…"
            aria-label="Message"
            disabled={isStreaming}
            className="min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-subtle focus:outline-none disabled:opacity-60"
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Stop generating"
              className="flex h-8 w-8 items-center justify-center rounded-md bg-negative-soft text-negative transition-colors hover:bg-negative hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-negative/50"
            >
              <IconStop size={14} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              aria-label="Send message"
              className="flex h-8 w-8 items-center justify-center rounded-md bg-accent text-accent-fg transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <IconArrowUp size={16} />
            </button>
          )}
        </div>
        <p className="mt-1.5 text-center text-2xs text-fg-subtle">
          Enter to send · up to {maxIterations} agent steps
        </p>
      </form>
    </div>
  );
});

export default Composer;
