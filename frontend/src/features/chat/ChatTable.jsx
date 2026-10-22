import { useContext, useMemo, useState } from 'react';
import { DataTable, cn } from '../../components/ui';
import { PlayerHeadshotsContext } from './chatFormat';
import { parseMarkdownTable, toneClass } from './markdownTable';

const AVATAR_TONES = ['bg-accent-soft text-accent', 'bg-positive-soft text-positive', 'bg-caution-soft text-caution', 'bg-info-soft text-info', 'bg-negative-soft text-negative'];

// Tables often write "Luka Doncic (DAL)" or "Luka Doncic - PG"; try the bare name too
function findHeadshot(headshots, name) {
  if (headshots[name]) return headshots[name];
  const bare = name.replace(/\s*\(.*\)\s*$/, '').replace(/\s+[-–—].*$/, '').trim();
  return headshots[bare] || null;
}

function PlayerCell({ name }) {
  const headshots = useContext(PlayerHeadshotsContext);
  const [failed, setFailed] = useState(false);
  if (!name) return null;
  const url = findHeadshot(headshots, name);
  const initials = name
    .split(/\s+/)
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
  const tone = AVATAR_TONES[[...name].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % AVATAR_TONES.length];

  return (
    <span className="flex items-center gap-2">
      {url && !failed ? (
        <img src={url} alt="" onError={() => setFailed(true)} className="h-6 w-6 shrink-0 rounded-full border border-line bg-surface-sunken object-cover" />
      ) : (
        <span aria-hidden="true" className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[0.625rem] font-semibold', tone)}>
          {initials}
        </span>
      )}
      <span className="font-medium">{name}</span>
    </span>
  );
}

function buildColumns(columns) {
  return columns.map((col, i) => ({
    id: `c${i}`,
    header: col.label,
    // Numeric columns sort on the parsed number; blanks always sink to the bottom
    accessorFn: (row) => (col.numeric ? (row.values[i] ?? undefined) : row.cells[i]),
    sortUndefined: 'last',
    cell: ({ row }) => {
      const text = row.original.cells[i];
      if (col.player) return <PlayerCell name={text} />;
      if (col.numeric) return <span className={toneClass(col.tone, row.original.values[i])}>{text}</span>;
      return text;
    },
    meta: { numeric: col.numeric, className: col.player ? 'min-w-[11rem]' : undefined },
  }));
}

/** Markdown table rendered with the app's DataTable. `node` is react-markdown's hast table node. */
export default function ChatTable({ node, children }) {
  const parsed = useMemo(() => parseMarkdownTable(node), [node]);
  const columns = useMemo(() => (parsed ? buildColumns(parsed.columns) : []), [parsed]);

  if (!parsed) {
    return (
      <div className="scrollbar-thin my-3 overflow-x-auto rounded-md border border-line">
        <table className="min-w-full text-xs">{children}</table>
      </div>
    );
  }

  return (
    <div className="my-3">
      <DataTable data={parsed.rows} columns={columns} density="compact" maxHeight="24rem" showColumnToggle={false} />
    </div>
  );
}
