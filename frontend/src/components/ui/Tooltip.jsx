import { cloneElement, isValidElement, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';

const GAP = 6;

/**
 * Hover/focus tooltip rendered in a portal (so it is never clipped by
 * scrolling tables). Wraps a single element child; non-elements get a span.
 */
export default function Tooltip({ content, side = 'top', delay = 150, children, className }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const triggerRef = useRef(null);
  const tipRef = useRef(null);
  const timer = useRef();
  const id = useId();

  const show = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setOpen(false);
    setPos(null);
  };

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !tipRef.current) return;
    const t = triggerRef.current.getBoundingClientRect();
    const tip = tipRef.current.getBoundingClientRect();
    let top, left;
    if (side === 'bottom') {
      top = t.bottom + GAP;
      left = t.left + t.width / 2 - tip.width / 2;
    } else if (side === 'left') {
      top = t.top + t.height / 2 - tip.height / 2;
      left = t.left - tip.width - GAP;
    } else if (side === 'right') {
      top = t.top + t.height / 2 - tip.height / 2;
      left = t.right + GAP;
    } else {
      top = t.top - tip.height - GAP;
      left = t.left + t.width / 2 - tip.width / 2;
    }
    left = Math.max(4, Math.min(left, window.innerWidth - tip.width - 4));
    top = Math.max(4, Math.min(top, window.innerHeight - tip.height - 4));
    setPos({ top, left });
  }, [open, side]);

  if (!content) return children;

  const handlers = {
    ref: triggerRef,
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: show,
    onBlur: hide,
    'aria-describedby': open ? id : undefined,
  };

  const trigger = isValidElement(children) ? (
    cloneElement(children, handlers)
  ) : (
    <span tabIndex={0} {...handlers}>
      {children}
    </span>
  );

  return (
    <>
      {trigger}
      {open &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
            className={cn(
              'pointer-events-none fixed z-[100] max-w-xs rounded border border-line-strong bg-surface-raised px-2 py-1 text-xs text-fg shadow-pop animate-fade-in',
              className,
            )}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
