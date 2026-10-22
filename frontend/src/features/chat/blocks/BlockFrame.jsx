import { cn } from '../../../components/ui';

/** Shared chrome for a chat result block: title row with optional controls, then content. */
export default function BlockFrame({ title, subtitle, meta, controls, note, className, children }) {
  return (
    <section aria-label={title} className={cn('my-3 flex flex-col gap-2', className)}>
      {(title || controls) && (
        <header className="flex flex-wrap items-end justify-between gap-2">
          <div className="min-w-0">
            {title && (
              <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
                {title}
                {meta && <span className="num text-2xs font-normal text-fg-subtle">{meta}</span>}
              </h3>
            )}
            {subtitle && <p className="text-2xs text-fg-muted">{subtitle}</p>}
          </div>
          {controls}
        </header>
      )}
      {children}
      {note && <p className="text-2xs text-fg-subtle">{note}</p>}
    </section>
  );
}
