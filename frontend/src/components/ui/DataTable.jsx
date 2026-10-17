import { useEffect, useRef, useState } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { cn } from './cn';
import EmptyState from './EmptyState';
import Spinner from './Spinner';
import { IconArrowDown, IconArrowUp, IconColumns, IconSort } from './icons';

const DENSITY = {
  compact: { cell: 'h-7 px-2 text-xs', head: 'h-7 px-2 text-2xs' },
  comfortable: { cell: 'h-9 px-3 text-sm', head: 'h-8 px-3 text-xs' },
};

/**
 * Thin wrapper around @tanstack/react-table with the kit's look.
 *
 * Column `meta` options:
 *   numeric: true      -> right-aligned, tabular mono digits
 *   align: 'left'|'center'|'right'
 *   className / headerClassName: extra classes for body / header cells
 *   label: string used in the column-visibility menu (defaults to header if string)
 *
 * Props:
 *   data, columns              tanstack column defs
 *   density                    'compact' (default) | 'comfortable'
 *   maxHeight                  CSS height for the scroll area (enables sticky header scroll)
 *   initialSorting             e.g. [{ id: 'proj', desc: true }]
 *   initialColumnVisibility    e.g. { ceiling: false }
 *   globalFilter               string; filters rows across all columns
 *   toolbar                    node rendered left of the column-visibility button
 *   showColumnToggle           default true
 *   onRowClick(row.original)
 *   rowClassName(row.original) -> extra classes
 *   getRowId                   passed to tanstack
 *   loading, emptyState
 */
export default function DataTable({
  data,
  columns,
  density = 'compact',
  maxHeight,
  initialSorting = [],
  initialColumnVisibility = {},
  globalFilter,
  toolbar,
  showColumnToggle = true,
  onRowClick,
  rowClassName,
  getRowId,
  loading = false,
  emptyState,
  className,
}) {
  const [sorting, setSorting] = useState(initialSorting);
  const [columnVisibility, setColumnVisibility] = useState(initialColumnVisibility);

  const table = useReactTable({
    data: data ?? [],
    columns,
    state: { sorting, columnVisibility, globalFilter },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const d = DENSITY[density] ?? DENSITY.compact;
  const rows = table.getRowModel().rows;
  const visibleColumnCount = table.getVisibleLeafColumns().length;
  const hasToolbar = toolbar || showColumnToggle;

  return (
    <div className={cn('flex flex-col overflow-hidden rounded-md border border-line bg-surface', className)}>
      {hasToolbar && (
        <div className="flex items-center justify-between gap-2 border-b border-line px-2 py-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-2">{toolbar}</div>
          {showColumnToggle && <ColumnMenu table={table} />}
        </div>
      )}
      <div className="scrollbar-thin relative overflow-auto" style={maxHeight ? { maxHeight } : undefined}>
        <table className="w-full border-separate border-spacing-0">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => {
                  const meta = header.column.columnDef.meta ?? {};
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  const align = meta.align ?? (meta.numeric ? 'right' : 'left');
                  return (
                    <th
                      key={header.id}
                      colSpan={header.colSpan}
                      scope="col"
                      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                      style={header.getSize() !== 150 ? { width: header.getSize() } : undefined}
                      className={cn(
                        'sticky top-0 z-10 whitespace-nowrap border-b border-line bg-surface-sunken font-semibold uppercase tracking-wider text-fg-subtle',
                        d.head,
                        align === 'right' && 'text-right',
                        align === 'center' && 'text-center',
                        align === 'left' && 'text-left',
                        meta.headerClassName,
                      )}
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={cn(
                            'inline-flex items-center gap-1 uppercase hover:text-fg focus-visible:text-fg focus-visible:outline-none',
                            align === 'right' && 'flex-row-reverse',
                            sorted && 'text-fg',
                          )}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {sorted === 'asc' ? (
                            <IconArrowUp size={11} className="text-accent" />
                          ) : sorted === 'desc' ? (
                            <IconArrowDown size={11} className="text-accent" />
                          ) : (
                            <IconSort size={11} className="opacity-40" />
                          )}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={visibleColumnCount} className="py-10 text-center">
                  <Spinner size="md" />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={visibleColumnCount}>{emptyState ?? <EmptyState compact title="No rows" />}</td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.id}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  className={cn(
                    'group transition-colors hover:bg-surface-raised',
                    onRowClick && 'cursor-pointer',
                    rowClassName?.(row.original),
                  )}
                >
                  {row.getVisibleCells().map((cell) => {
                    const meta = cell.column.columnDef.meta ?? {};
                    const align = meta.align ?? (meta.numeric ? 'right' : 'left');
                    return (
                      <td
                        key={cell.id}
                        className={cn(
                          'whitespace-nowrap border-b border-line/60 text-fg',
                          d.cell,
                          meta.numeric && 'num',
                          align === 'right' && 'text-right',
                          align === 'center' && 'text-center',
                          meta.className,
                        )}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ColumnMenu({ table }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const hideable = table.getAllLeafColumns().filter((c) => c.getCanHide());

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        className="inline-flex h-7 items-center gap-1.5 rounded border border-line bg-surface-raised px-2 text-xs text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <IconColumns size={13} />
        Columns
      </button>
      {open && (
        <div className="scrollbar-thin absolute right-0 top-full z-30 mt-1 max-h-72 w-48 overflow-y-auto rounded-md border border-line bg-surface-raised p-1 shadow-pop animate-fade-in">
          {hideable.map((col) => {
            const meta = col.columnDef.meta ?? {};
            const label = meta.label ?? (typeof col.columnDef.header === 'string' ? col.columnDef.header : col.id);
            return (
              <label key={col.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-fg hover:bg-surface-sunken">
                <input
                  type="checkbox"
                  checked={col.getIsVisible()}
                  onChange={col.getToggleVisibilityHandler()}
                  className="h-3.5 w-3.5 accent-[rgb(var(--accent))]"
                />
                {label}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
