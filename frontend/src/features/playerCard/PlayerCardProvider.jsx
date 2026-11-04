import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Button, EmptyState } from '../../components/ui';
import { useSlate } from '../../context/SlateContext';
import { PlayerCardContext } from './playerCardContext';
import PlayerCardView, { PlayerCardSkeleton } from './PlayerCardView';
import usePlayerCardData from './usePlayerCardData';
import useCardControls from './useCardControls';
import { askAiPrompt } from './cardFormat';

/** Right-side drawer on desktop, full-screen sheet on phones. Escape / backdrop close. */
function Sheet({ onClose, label, children }) {
  const panelRef = useRef(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    const prevFocus = document.activeElement;
    const onKey = (e) => e.key === 'Escape' && onCloseRef.current?.();
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus?.();
    };
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-[95]">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-fade-in" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="scrollbar-thin absolute inset-0 overflow-y-auto overflow-x-hidden overscroll-contain bg-surface text-fg shadow-pop animate-slide-in-right focus:outline-none md:inset-y-0 md:left-auto md:right-0 md:w-[min(58rem,94vw)] md:border-l md:border-line"
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

function CardBody({ target, onClose }) {
  const navigate = useNavigate();
  const { status, card, error, reload } = usePlayerCardData(target);
  const controls = useCardControls(card, target.controls);
  const label = `${card?.player?.name ?? target.name ?? 'Player'} card`;

  const onAskAi = card
    ? () => {
        navigate('/chat', { state: { chatPrefill: askAiPrompt(card) } });
        onClose();
      }
    : null;

  return (
    <Sheet onClose={onClose} label={label}>
      {status === 'done' && card ? (
        <PlayerCardView card={card} onClose={onClose} controls={controls} onAskAi={onAskAi} />
      ) : status === 'error' ? (
        <div className="flex min-h-full flex-col">
          <PlayerCardSkeleton name={target.name} headshot={target.headshot} onClose={onClose} />
          <div className="absolute inset-x-0 top-28 px-4">
            <div className="rounded-lg border border-line bg-surface p-2">
              <EmptyState
                compact
                title="Couldn't load the player card"
                description={error}
                action={<Button size="sm" variant="secondary" onClick={reload}>Retry</Button>}
              />
            </div>
          </div>
        </div>
      ) : (
        <PlayerCardSkeleton name={target.name} headshot={target.headshot} onClose={onClose} />
      )}
    </Sheet>
  );
}

/**
 * App-wide player card. Any component calls usePlayerCard().open(...) (or
 * renders PlayerCardTrigger) to open the card for a slate player.
 */
export default function PlayerCardProvider({ children }) {
  const slate = useSlate();
  const [target, setTarget] = useState(null);
  const defaults = useRef({});
  defaults.current = { slateId: slate.workSlateId ?? slate.slateId, slateDate: slate.slateParams?.slateDate ?? null };

  const open = useCallback((t) => {
    if (!t || t.playerId == null) return;
    const explicit = t.slateId !== undefined && t.slateId !== null;
    setTarget({
      ...t,
      playerId: String(t.playerId),
      slateId: explicit ? String(t.slateId) : defaults.current.slateId,
      slateDate: explicit ? t.slateDate ?? null : defaults.current.slateDate,
    });
  }, []);
  const close = useCallback(() => setTarget(null), []);
  const value = useMemo(() => ({ open, close, target }), [open, close, target]);

  return (
    <PlayerCardContext.Provider value={value}>
      {children}
      {target?.slateId && <CardBody key={`${target.slateId}|${target.slateDate}|${target.playerId}`} target={target} onClose={close} />}
    </PlayerCardContext.Provider>
  );
}
