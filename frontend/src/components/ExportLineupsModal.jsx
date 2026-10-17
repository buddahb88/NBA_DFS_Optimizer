import { useEffect, useState } from 'react';
import { lineupsAPI } from '../services/api';
import { Button, Modal, Select } from './ui';

const SITES = [
  { value: 'draftkings', label: 'DraftKings' },
  { value: 'fanduel', label: 'FanDuel' },
  { value: 'yahoo', label: 'Yahoo' },
];

const ENTRIES_HELP = {
  draftkings: 'DraftKings: Lineups → Edit Entries → Download (DKEntries.csv)',
  fanduel: 'FanDuel: Upcoming → CSV Edit → Download a .csv template',
  yahoo: 'Yahoo: My Contests → Set Lineup → Upload Lineups from CSV → download the template',
};

// The API's JSON body limit is 1 MB; leave room for the lineups
const MAX_TEMPLATE_BYTES = 900 * 1024;

function downloadCsv(csv, filename) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

/**
 * Bulk export lineups as a site upload CSV.
 * Pass either lineupIds (saved lineups) or lineups (unsaved, e.g. optimizer
 * results: [{ name, players: [{ position, player: { id } }] }]).
 */
export default function ExportLineupsModal({ open, onClose, lineupIds, lineups, defaultSite = 'draftkings' }) {
  const [site, setSite] = useState(defaultSite);
  const [mode, setMode] = useState('new');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (open) {
      setSite(SITES.some(s => s.value === defaultSite) ? defaultSite : 'draftkings');
      setResult(null);
    }
  }, [open, defaultSite]);

  const count = lineupIds?.length ?? lineups?.length ?? 0;
  const siteName = SITES.find(s => s.value === site)?.label;

  const handleExport = async () => {
    setResult(null);
    if (mode === 'entries' && !file) {
      setResult({ errors: [{ index: null, messages: [`Choose your ${siteName} entries file`] }] });
      return;
    }
    if (file && mode === 'entries' && file.size > MAX_TEMPLATE_BYTES) {
      setResult({ errors: [{ index: null, messages: ['That entries file is too large (over 900 KB)'] }] });
      return;
    }

    setBusy(true);
    try {
      const body = { site, mode };
      if (lineupIds) body.lineupIds = lineupIds;
      else {
        // Send only ids and slots; the server reads everything else from the DB
        body.lineups = lineups.map(l => ({
          name: l.name,
          players: (l.players || [])
            .map(s => (s.player ? { id: s.player.id, positionSlot: s.position } : { id: s.id, positionSlot: s.position_slot ?? s.positionSlot }))
            .filter(p => p.id !== undefined && p.id !== null),
        }));
      }
      if (mode === 'entries') body.entriesTemplate = await file.text();

      const { data } = await lineupsAPI.exportCsv(body);
      const filename = mode === 'entries'
        ? file.name.replace(/\.csv$/i, '') + '-filled.csv'
        : `${site}-lineups-${stamp()}.csv`;
      downloadCsv(data.csv, filename);
      setResult({ success: true, rowCount: data.rowCount, warnings: data.warnings || [], filename });
    } catch (error) {
      const data = error.response?.data;
      setResult({
        errors: data?.errors || [{ index: null, messages: [data?.error || error.message] }],
        warnings: data?.warnings || [],
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Export lineups"
      description={`${count} lineup${count === 1 ? '' : 's'} as a site upload CSV`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={handleExport} loading={busy} disabled={count === 0}>
            Download CSV
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Select label="Site" options={SITES} value={site} onChange={e => setSite(e.target.value)} />

        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-medium text-fg-muted">Format</legend>
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input type="radio" name="export-mode" value="new" checked={mode === 'new'} onChange={() => setMode('new')} className="mt-1" />
            <span>
              New lineups
              <span className="block text-xs text-fg-muted">Upload from the site's Upload Lineups page, then enter contests with them</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input type="radio" name="export-mode" value="entries" checked={mode === 'entries'} onChange={() => setMode('entries')} className="mt-1" />
            <span>
              Fill my entries file
              <span className="block text-xs text-fg-muted">Puts these lineups into the entries you already have, in order</span>
            </span>
          </label>
        </fieldset>

        {mode === 'entries' && (
          <div className="space-y-1">
            <label htmlFor="entries-file" className="text-xs font-medium text-fg-muted">Entries file</label>
            <input
              id="entries-file"
              type="file"
              accept=".csv,text/csv"
              onChange={e => setFile(e.target.files?.[0] || null)}
              className="block w-full text-sm text-fg file:mr-3 file:rounded file:border file:border-line file:bg-surface-raised file:px-2.5 file:py-1 file:text-sm file:text-fg"
            />
            <p className="text-xs text-fg-subtle">{ENTRIES_HELP[site]}</p>
          </div>
        )}

        {result?.success && (
          <div role="status" className="rounded border border-positive/40 bg-positive/10 p-3 text-sm">
            Downloaded {result.filename} with {result.rowCount} lineup{result.rowCount === 1 ? '' : 's'}.
          </div>
        )}

        {result?.warnings?.length > 0 && (
          <ul className="list-disc space-y-1 rounded border border-line bg-surface-raised p-3 pl-7 text-xs text-fg-muted">
            {result.warnings.map(w => <li key={w}>{w}</li>)}
          </ul>
        )}

        {result?.errors?.length > 0 && (
          <div role="alert" className="rounded border border-negative/40 bg-negative/10 p-3 text-sm">
            <div className="mb-1 font-medium">Nothing was exported. Fix these and try again:</div>
            <ul className="space-y-1.5">
              {result.errors.map((e, i) => (
                <li key={i}>
                  {e.index !== null && e.index !== undefined && (
                    <span className="font-medium">
                      {e.name || `Lineup ${e.index}`}{e.csvRow ? ` (CSV row ${e.csvRow})` : ''}:{' '}
                    </span>
                  )}
                  {e.messages.join('; ')}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
