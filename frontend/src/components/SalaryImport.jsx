import { useRef, useState } from 'react';
import { slatesAPI } from '../services/api';
import { Badge, Button, Card, CardBody, CardHeader, Select, Spinner, cn, IconX } from './ui';

const SITE_OPTIONS = [
  { value: '', label: 'Auto-detect site' },
  { value: 'draftkings', label: 'DraftKings' },
  { value: 'fanduel', label: 'FanDuel' },
  { value: 'yahoo', label: 'Yahoo' },
];

const SITE_NAMES = { draftkings: 'DraftKings', fanduel: 'FanDuel', yahoo: 'Yahoo' };

function IconUpload(props) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m17 8-5-5-5 5M12 3v12" />
    </svg>
  );
}

function PlayerList({ title, players, tone }) {
  if (!players?.length) return null;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer select-none text-fg-muted hover:text-fg">
        <Badge tone={tone} size="sm" className="mr-1.5">{players.length}</Badge>
        {title}
      </summary>
      <ul className="mt-1.5 max-h-40 space-y-0.5 overflow-y-auto pl-1">
        {players.map((p, i) => (
          <li key={`${p.name}-${i}`} className="flex justify-between gap-3 text-fg">
            <span className="truncate">{p.name}</span>
            <span className="shrink-0 tabular-nums text-fg-subtle">
              {[p.team, p.position, p.salary != null && `$${p.salary.toLocaleString()}`].filter(Boolean).join(' · ')}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Dropzone for a site's official player/salary CSV (DKSalaries.csv, FanDuel or
 * Yahoo player list). Shows the import summary and unmatched players.
 */
export default function SalaryImport({ onImported }) {
  const inputRef = useRef(null);
  const [site, setSite] = useState('');
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const upload = async (file) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    setResult(null);
    try {
      const { data } = await slatesAPI.importSalaries(file, { site: site || undefined });
      setResult(data);
      onImported?.(data);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    upload(e.dataTransfer.files?.[0]);
  };

  return (
    <div className="flex w-full flex-col gap-2 sm:w-[26rem]">
      <div className="flex items-stretch gap-2">
        <Select
          size="sm"
          aria-label="DFS site"
          options={SITE_OPTIONS}
          value={site}
          onChange={(e) => setSite(e.target.value)}
          className="w-40 shrink-0"
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          disabled={uploading}
          className={cn(
            'flex min-h-7 flex-1 items-center justify-center gap-2 rounded border border-dashed px-3 text-xs transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
            dragging
              ? 'border-accent bg-accent-soft text-accent'
              : 'border-line-strong bg-surface-sunken text-fg-muted hover:border-accent hover:text-fg',
            uploading && 'cursor-wait opacity-70',
          )}
        >
          {uploading ? <Spinner size="xs" /> : <IconUpload />}
          {uploading ? 'Importing…' : 'Drop salary CSV or browse'}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => upload(e.target.files?.[0])}
        />
      </div>

      {error && (
        <div className="flex items-start justify-between gap-2 rounded border border-negative/30 bg-negative-soft px-2.5 py-1.5 text-xs text-negative">
          <span>{error}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setError(null)}><IconX size={14} /></button>
        </div>
      )}

      {result && (
        <Card>
          <CardHeader
            title={`Imported ${result.total} ${SITE_NAMES[result.site] || result.site} players`}
            subtitle={`Slate: ${result.slate?.name || result.slate?.slate_id}`}
            actions={
              <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={() => setResult(null)}>
                <IconX size={14} />
              </Button>
            }
          />
          <CardBody className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              <Badge tone="positive">{result.updated} updated</Badge>
              <Badge tone="info">{result.inserted} new</Badge>
              <Badge tone="accent">{result.matched.slate + result.matched.projections} with projections</Badge>
              {result.unmatched.length > 0 && <Badge tone="caution">{result.unmatched.length} unmatched</Badge>}
            </div>
            <PlayerList title="Unmatched (no projection or history found; using site average)" players={result.unmatched} tone="caution" />
            <PlayerList title="Matched by history only (using site average)" players={result.noProjection.filter(
              (p) => !result.unmatched.some((u) => u.sitePlayerId === p.sitePlayerId),
            )} tone="info" />
            <PlayerList title="On the slate but not in this file (no site ID)" players={result.missingFromCsv} tone="neutral" />
            {result.skipped?.length > 0 && (
              <p className="text-xs text-fg-muted">{result.skipped.length} row(s) skipped (missing ID, salary or position).</p>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
