import { useCallback, useEffect, useRef, useState } from 'react';
import { IconCheck, IconInfo, IconX, cn } from '../../../components/ui';
import { ToastContext } from './toastContext';

const TONE = {
  positive: 'border-positive/40 text-positive',
  negative: 'border-negative/40 text-negative',
  info: 'border-line-strong text-info',
};

const DISMISS_MS = 4000;

/** Small stack of status toasts for chat card actions, announced politely. */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(0);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback(
    ({ text, tone = 'info' }) => {
      const id = ++nextId.current;
      setToasts((list) => [...list.slice(-2), { id, text, tone }]);
      timers.current.set(id, setTimeout(() => dismiss(id), DISMISS_MS));
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-20 right-4 z-[90] flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex items-start gap-2 rounded-md border bg-surface-raised px-3 py-2 text-xs shadow-pop animate-fade-in motion-reduce:animate-none',
              TONE[t.tone] ?? TONE.info,
            )}
          >
            {t.tone === 'positive' ? <IconCheck size={14} className="mt-px shrink-0" /> : <IconInfo size={14} className="mt-px shrink-0" />}
            <span className="min-w-0 flex-1 text-fg">{t.text}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
              className="shrink-0 rounded text-fg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              <IconX size={12} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
