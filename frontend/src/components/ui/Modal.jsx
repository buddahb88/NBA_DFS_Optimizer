import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';
import { IconX } from './icons';

const SIZES = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl', xl: 'max-w-6xl' };

/** Dialog rendered in a portal. Closes on Escape and backdrop click. */
export default function Modal({ open, onClose, title, description, footer, size = 'md', className, children }) {
  const titleId = useId();
  const panelRef = useRef(null);
  // Kept in a ref so an inline onClose doesn't re-run the effect (and steal focus) every render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return undefined;
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
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[1px] animate-fade-in" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={cn(
          'relative flex max-h-[90vh] w-full flex-col rounded-lg border border-line bg-surface text-fg shadow-pop animate-scale-in focus:outline-none',
          SIZES[size],
          className,
        )}
      >
        {(title || description) && (
          <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
            <div>
              {title && (
                <h2 id={titleId} className="text-base font-semibold">
                  {title}
                </h2>
              )}
              {description && <p className="mt-0.5 text-xs text-fg-muted">{description}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded p-1 text-fg-subtle hover:bg-surface-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              <IconX size={16} />
            </button>
          </div>
        )}
        <div className="scrollbar-thin overflow-y-auto px-4 py-3">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
