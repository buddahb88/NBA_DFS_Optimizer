import { useId, useRef, useState } from 'react';
import { cn } from './cn';

/**
 * Tabs. `tabs` = [{ value, label, count?, content? }]. Controlled via
 * value/onChange or uncontrolled via defaultValue. If tabs carry `content`,
 * the active panel is rendered below the list.
 * variant: 'underline' (page sections) | 'pill' (compact segmented control)
 */
export default function Tabs({ tabs, value, defaultValue, onChange, variant = 'underline', size = 'md', className }) {
  const [internal, setInternal] = useState(defaultValue ?? tabs[0]?.value);
  const active = value ?? internal;
  const baseId = useId();
  const listRef = useRef(null);

  const select = (v) => {
    if (value === undefined) setInternal(v);
    onChange?.(v);
  };

  const onKeyDown = (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const enabled = tabs.filter((t) => !t.disabled);
    const idx = enabled.findIndex((t) => t.value === active);
    const next = enabled[(idx + (e.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length];
    select(next.value);
    listRef.current?.querySelector(`[data-value="${CSS.escape(String(next.value))}"]`)?.focus();
  };

  const activeTab = tabs.find((t) => t.value === active);
  const small = size === 'sm';

  return (
    <div className={className}>
      <div
        ref={listRef}
        role="tablist"
        onKeyDown={onKeyDown}
        className={cn(
          'flex items-center',
          variant === 'underline' ? 'gap-4 border-b border-line' : 'inline-flex gap-0.5 rounded-md border border-line bg-surface-sunken p-0.5',
        )}
      >
        {tabs.map((t) => {
          const selected = t.value === active;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              data-value={t.value}
              id={`${baseId}-tab-${t.value}`}
              aria-selected={selected}
              aria-controls={t.content !== undefined ? `${baseId}-panel-${t.value}` : undefined}
              tabIndex={selected ? 0 : -1}
              disabled={t.disabled}
              onClick={() => select(t.value)}
              className={cn(
                'inline-flex items-center gap-1.5 whitespace-nowrap font-medium transition-colors focus-visible:outline-none disabled:opacity-40',
                small ? 'text-xs' : 'text-sm',
                variant === 'underline'
                  ? cn(
                      '-mb-px border-b-2 focus-visible:text-fg',
                      small ? 'py-1.5' : 'py-2',
                      selected ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg',
                    )
                  : cn(
                      'rounded focus-visible:ring-2 focus-visible:ring-accent/50',
                      small ? 'h-6 px-2' : 'h-7 px-3',
                      selected ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted hover:text-fg',
                    ),
              )}
            >
              {t.label}
              {t.count != null && (
                <span className={cn('num rounded px-1 text-2xs', selected ? 'bg-accent-soft text-accent' : 'bg-surface-raised text-fg-subtle')}>
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {activeTab?.content !== undefined && (
        <div role="tabpanel" id={`${baseId}-panel-${active}`} aria-labelledby={`${baseId}-tab-${active}`} className="pt-3">
          {activeTab.content}
        </div>
      )}
    </div>
  );
}
