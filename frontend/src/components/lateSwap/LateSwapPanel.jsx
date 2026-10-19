import { useEffect, useMemo, useState } from 'react';
import { slatesAPI, lateSwapAPI } from '../../services/api';
import {
  Badge, Button, Card, CardBody, CardHeader, EmptyState, Input, Select, Stat, Tabs, Toggle,
  IconChevronDown, IconChevronRight, IconBolt, IconInfo,
} from '../ui';
import { cn } from '../ui/cn';
import {
  REASON_TONES, FLAG_TONES, FLAG_LABELS, filterEntries, buildRequest, outputFileName, downloadText,
} from './lateSwapUtils';

const fmtSalary = (n) => (n == null ? '—' : `$${Number(n).toLocaleString()}`);
const fmtPts = (n) => (n == null ? '—' : Number(n).toFixed(1));
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'no time');

function PlayerCell({ player, muted }) {
  if (!player) return <span className="text-fg-subtle">empty</span>;
  return (
    <div className={cn('min-w-0', muted && 'opacity-60')}>
      <div className="flex items-center gap-1.5">
        <span className="truncate text-sm text-fg">{player.name ?? player.siteId}</span>
        {player.status === 'OUT' && <Badge tone="negative" size="sm">OUT</Badge>}
        {player.status === 'Q' && <Badge tone="caution" size="sm">GTD</Badge>}
      </div>
      <div className="num text-2xs text-fg-subtle">
        {player.team ?? '—'} · {fmtSalary(player.salary)} · {fmtPts(player.projection)} pts
      </div>
    </div>
  );
}

function EntryDiff({ entry, open, onToggle }) {
  return (
    <div className="border-b border-line last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-raised"
      >
        {open ? <IconChevronDown size={14} className="text-fg-subtle" /> : <IconChevronRight size={14} className="text-fg-subtle" />}
        <span className="num w-28 shrink-0 truncate text-xs text-fg-muted">{entry.entryId}</span>
        <span className="hidden min-w-0 flex-1 truncate text-xs text-fg-muted sm:block">{entry.contestName}</span>
        <span className="flex flex-wrap items-center gap-1">
          {entry.flags.map((f, i) => (
            <Badge key={i} tone={FLAG_TONES[f.type] ?? 'info'} size="sm" title={f.message}>
              {FLAG_LABELS[f.type] ?? f.type}
            </Badge>
          ))}
        </span>
        <span className="num ml-auto shrink-0 text-xs text-fg-muted">
          {entry.swaps} swap{entry.swaps === 1 ? '' : 's'} · {fmtPts(entry.before.projection)} → {fmtPts(entry.after.projection)}
        </span>
        <span className={cn('num w-14 shrink-0 text-right text-xs font-medium', entry.gain > 0 ? 'text-positive' : entry.gain < 0 ? 'text-negative' : 'text-fg-subtle')}>
          {entry.gain > 0 ? '+' : ''}{fmtPts(entry.gain)}
        </span>
      </button>
      {open && (
        <div className="overflow-x-auto px-3 pb-3">
          <table className="w-full text-left">
            <thead>
              <tr className="text-2xs uppercase tracking-wider text-fg-subtle">
                <th className="w-14 py-1 font-medium">Slot</th>
                <th className="py-1 font-medium">Before</th>
                <th className="w-6" />
                <th className="py-1 font-medium">After</th>
                <th className="w-24 py-1 font-medium" />
              </tr>
            </thead>
            <tbody>
              {entry.slots.map((s, i) => (
                <tr key={i} className={cn('border-t border-line', s.changed && 'bg-surface-raised/60')}>
                  <td className="py-1.5 text-xs font-semibold text-fg-muted">{s.slot}</td>
                  <td className="py-1.5 pr-2"><PlayerCell player={s.before} muted={s.changed} /></td>
                  <td className="py-1.5 text-fg-subtle">{s.changed ? '→' : ''}</td>
                  <td className="py-1.5 pr-2">{s.changed ? <PlayerCell player={s.after} /> : <span className="text-2xs text-fg-subtle">same</span>}</td>
                  <td className="py-1.5 text-right">
                    {REASON_TONES[s.reason] && <Badge tone={REASON_TONES[s.reason]} size="sm">{s.reason}</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="num mt-2 text-2xs text-fg-subtle">
            Salary {fmtSalary(entry.before.salary)} → {fmtSalary(entry.after.salary)} ({fmtSalary(entry.after.remainingSalary)} left)
          </div>
        </div>
      )}
    </div>
  );
}

export default function LateSwapPanel() {
  const [slates, setSlates] = useState([]);
  const [slateId, setSlateId] = useState('');
  const [file, setFile] = useState(null); // { name, text }
  const [mode, setMode] = useState('optimize');
  const [maxExposure, setMaxExposure] = useState('100');
  const [swapQuestionable, setSwapQuestionable] = useState(false);
  const [unique, setUnique] = useState(true);
  const [outPlayers, setOutPlayers] = useState('');
  const [lockedTeams, setLockedTeams] = useState('');
  const [now, setNow] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [filter, setFilter] = useState('changed');
  const [expanded, setExpanded] = useState(() => new Set());

  useEffect(() => {
    slatesAPI.getAll()
      .then(({ data }) => {
        const list = Array.isArray(data) ? data : [];
        setSlates(list);
        if (list.length) setSlateId((cur) => cur || list[0].slate_id);
      })
      .catch(() => setSlates([]));
  }, []);

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    setResult(null);
    setError(null);
    setFile(f ? { name: f.name, text: await f.text() } : null);
  };

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await lateSwapAPI.run(buildRequest({
        slateId, csv: file.text, mode, maxExposure, swapQuestionable, unique, outPlayers, lockedTeams, now,
      }));
      setResult(data);
      setExpanded(new Set());
      setFilter(data.summary.changedEntries > 0 ? 'changed' : 'all');
    } catch (err) {
      setResult(null);
      setError(err.response?.data?.message || err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  const shown = useMemo(() => filterEntries(result?.entries, filter), [result, filter]);
  const flaggedCount = result ? result.entries.filter((e) => e.flags.length > 0).length : 0;
  const toggle = (id) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Late swap"
          subtitle="Upload your entries file. Players whose games have started stay put; open slots are re-optimized with the latest projections and news."
        />
        <CardBody className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Select
            label="Slate (projections)"
            value={slateId}
            onChange={(e) => setSlateId(e.target.value)}
            options={slates.length
              ? slates.map((s) => ({ value: s.slate_id, label: `${s.name}${s.site ? ` · ${s.site}` : ''}` }))
              : [{ value: '', label: 'No slates loaded' }]}
          />
          <div className="flex flex-col gap-1">
            <label htmlFor="lateswap-file" className="text-xs font-medium text-fg-muted">Entries CSV (DKEntries / FanDuel)</label>
            <input
              id="lateswap-file"
              type="file"
              accept=".csv,text/csv"
              onChange={onFile}
              className="block w-full text-xs text-fg-muted file:mr-2 file:h-8 file:cursor-pointer file:rounded file:border file:border-line file:bg-surface-raised file:px-3 file:text-xs file:text-fg"
            />
          </div>
          <Select
            label="Mode"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            options={[
              { value: 'optimize', label: 'Re-optimize all open slots' },
              { value: 'outOnly', label: 'Only swap OUT players' },
            ]}
          />
          <Input label="Max exposure %" numeric type="number" min="0" max="100" value={maxExposure} onChange={(e) => setMaxExposure(e.target.value)} />
          <Input
            label="Mark OUT (late news)"
            placeholder="Names or IDs, comma separated"
            value={outPlayers}
            onChange={(e) => setOutPlayers(e.target.value)}
          />
          <Input
            label="Force-lock teams"
            placeholder="e.g. LAL, BOS"
            hint="For games without a start time"
            value={lockedTeams}
            onChange={(e) => setLockedTeams(e.target.value)}
          />
          <Input
            label="Evaluate locks at"
            type="datetime-local"
            hint="Leave empty for now"
            value={now}
            onChange={(e) => setNow(e.target.value)}
          />
          <div className="flex flex-col justify-center gap-2">
            <Toggle size="sm" checked={swapQuestionable} onChange={setSwapQuestionable} label="Swap GTD/Q players too" />
            <Toggle size="sm" checked={unique} onChange={setUnique} label="Keep lineups unique" />
          </div>
        </CardBody>
        <div className="flex items-center justify-end gap-2 border-t border-line px-3 py-2">
          {error && <span role="alert" className="mr-auto text-xs text-negative">{error}</span>}
          <Button variant="primary" leftIcon={<IconBolt size={14} />} loading={loading} disabled={!file || !slateId || loading} onClick={run}>
            Run late swap
          </Button>
        </div>
      </Card>

      {!result && !loading && (
        <EmptyState
          title="No late swap run yet"
          description="Download your entries from the contest lobby (Edit entries / Late swap), upload it here, and run."
        />
      )}

      {result && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Entries changed" value={`${result.summary.changedEntries}/${result.summary.entries}`} />
            <Stat label="Players swapped in" value={result.summary.swaps} />
            <Stat
              label="Projection"
              value={fmtPts(result.summary.projectionAfter)}
              delta={Math.round((result.summary.projectionAfter - result.summary.projectionBefore) * 10) / 10}
              deltaLabel={`from ${fmtPts(result.summary.projectionBefore)}`}
            />
            <Stat
              label="Locked OUT"
              value={result.summary.lockedOut}
              hint={result.summary.lockedOut ? 'Already started, cannot swap' : 'None'}
            />
          </div>

          {result.warnings.length > 0 && (
            <div className="space-y-1 rounded-md border border-caution/30 bg-caution-soft px-3 py-2">
              {result.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2 text-xs text-caution">
                  <IconInfo size={14} className="mt-0.5 shrink-0" /> {w}
                </div>
              ))}
            </div>
          )}

          <Card>
            <CardHeader
              title={`Games (${result.site}, as of ${new Date(result.now).toLocaleString()})`}
              actions={(
                <Button
                  variant="positive"
                  size="sm"
                  onClick={() => downloadText(result.csv, outputFileName(file?.name))}
                >
                  Download upload CSV
                </Button>
              )}
            />
            <CardBody className="flex flex-wrap gap-1.5">
              {result.locks.map((l) => (
                <Badge key={l.team} tone={l.locked ? 'neutral' : 'positive'} title={l.startTime ?? 'No start time'}>
                  {l.locked ? '🔒 ' : ''}{l.team} · {fmtTime(l.startTime)}
                </Badge>
              ))}
            </CardBody>
          </Card>

          <Card>
            <div className="flex items-center justify-between gap-3 border-b border-line px-3 pt-2">
              <Tabs
                value={filter}
                onChange={setFilter}
                size="sm"
                tabs={[
                  { value: 'changed', label: 'Changed', count: result.summary.changedEntries },
                  { value: 'flagged', label: 'Flagged', count: flaggedCount },
                  { value: 'all', label: 'All', count: result.summary.entries },
                ]}
                className="-mb-px"
              />
              <div className="flex gap-1 pb-2">
                <Button size="xs" variant="ghost" onClick={() => setExpanded(new Set(shown.map((e) => e.entryId)))}>Expand all</Button>
                <Button size="xs" variant="ghost" onClick={() => setExpanded(new Set())}>Collapse</Button>
              </div>
            </div>
            {shown.length === 0 ? (
              <EmptyState compact title="Nothing in this view" />
            ) : (
              shown.map((entry) => (
                <EntryDiff key={entry.entryId} entry={entry} open={expanded.has(entry.entryId)} onToggle={() => toggle(entry.entryId)} />
              ))
            )}
          </Card>

          {result.exposures.length > 0 && (
            <Card>
              <CardHeader title="Exposure" subtitle="Share of entries before → after" />
              <CardBody className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
                {result.exposures.slice(0, 24).map((x) => (
                  <div key={x.siteId} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate text-fg">{x.locked ? '🔒 ' : ''}{x.name}</span>
                    <span className="num shrink-0 text-fg-muted">
                      {x.before}% → <span className={cn(x.after > x.before ? 'text-positive' : x.after < x.before ? 'text-negative' : 'text-fg')}>{x.after}%</span>
                    </span>
                  </div>
                ))}
              </CardBody>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
