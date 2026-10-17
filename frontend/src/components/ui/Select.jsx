import { forwardRef, useId } from 'react';
import { cn } from './cn';
import { fieldBase } from './fieldBase';
import { IconChevronDown } from './icons';

/**
 * Native <select> styled to match the kit. `options` may be strings or
 * { value, label, disabled } objects; children are used if options is omitted.
 */
const Select = forwardRef(function Select({ label, options, size = 'md', className, id, children, ...rest }, ref) {
  const autoId = useId();
  const selectId = id || autoId;
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {label && (
        <label htmlFor={selectId} className="text-xs font-medium text-fg-muted">
          {label}
        </label>
      )}
      <span className="relative flex items-center">
        <select
          ref={ref}
          id={selectId}
          className={cn(fieldBase, 'cursor-pointer appearance-none pr-7', size === 'sm' && 'h-7 text-xs')}
          {...rest}
        >
          {options
            ? options.map((o) => {
                const opt = typeof o === 'object' ? o : { value: o, label: o };
                return (
                  <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                    {opt.label}
                  </option>
                );
              })
            : children}
        </select>
        <IconChevronDown size={14} className="pointer-events-none absolute right-2 text-fg-subtle" />
      </span>
    </div>
  );
});

export default Select;
