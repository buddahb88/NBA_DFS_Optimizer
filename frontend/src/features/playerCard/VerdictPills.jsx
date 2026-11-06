import { Tooltip, cn } from '../../components/ui';
import { lineupVerdictSummary, verdictTone as toneOf } from './cardFormat';

/**
 * Compact Cash / GPP verdict column for a lineup row: two small pills with the
 * confidence, colored by the verdict tone (same palette as the player card
 * header pills). Below sm they collapse to two dots. Tooltip: verdict labels
 * and the headline. entry = a /players/:slateId/verdicts player (or null).
 */

const toneStyle = (tone) => ({ borderColor: `rgb(var(--${tone}) / 0.4)`, background: `rgb(var(--${tone}) / 0.12)`, color: `rgb(var(--${tone}))` });
const dotStyle = (tone) => ({ background: `rgb(var(--${tone}))` });

function Pill({ label, v }) {
  const tone = toneOf(v.verdict);
  return (
    <>
      <span
        data-testid={`verdict-${label.toLowerCase()}`}
        data-tone={tone}
        className="num hidden h-4 min-w-[2.1rem] items-center justify-center gap-0.5 rounded border px-1 text-[10px] font-semibold leading-none sm:inline-flex"
        style={toneStyle(tone)}
      >
        <span className="opacity-70">{label[0]}</span>
        {v.confidence}
      </span>
      <span aria-hidden="true" data-tone={tone} className="h-2 w-2 shrink-0 rounded-full sm:hidden" style={dotStyle(tone)} />
    </>
  );
}

function verdictTooltip(entry) {
  if (!entry) return null;
  return (
    <div className="max-w-[16rem] space-y-0.5 text-left">
      <div>
        <span className="font-semibold">Cash:</span> {entry.cash.verdict} ({entry.cash.confidence})
        {' · '}
        <span className="font-semibold">GPP:</span> {entry.gpp.verdict} ({entry.gpp.confidence})
      </div>
      {entry.headline && <div className="text-fg-muted">{entry.headline}</div>}
      {entry.slate_note && entry.slate_note !== entry.headline && <div className="text-fg-muted">{entry.slate_note}</div>}
    </div>
  );
}

/** The per-row column; a fixed-width placeholder while loading / without a verdict keeps rows aligned. */
export default function VerdictPills({ entry, className }) {
  if (!entry) return <span className={cn('w-4 shrink-0 sm:w-[4.5rem]', className)} aria-hidden="true" />;
  const label = `Cash ${entry.cash.verdict} ${entry.cash.confidence}, GPP ${entry.gpp.verdict} ${entry.gpp.confidence}`;
  return (
    <Tooltip content={verdictTooltip(entry)}>
      <span
        tabIndex={0}
        role="img"
        aria-label={label}
        className={cn('flex w-4 shrink-0 items-center justify-end gap-0.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:w-[4.5rem]', className)}
      >
        <Pill label="Cash" v={entry.cash} />
        <Pill label="GPP" v={entry.gpp} />
      </span>
    </Tooltip>
  );
}

/** Lineup-level summary chips (lineupVerdictSummary): average Cash / GPP confidence, toned by the average score. */
export function LineupVerdictSummary({ entries, thresholds, className }) {
  const s = lineupVerdictSummary(entries, thresholds);
  if (!s) return null;
  const chip = (label, v) => (
    <span
      className="num inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold leading-none"
      style={toneStyle(toneOf(v.verdict))}
      data-testid={`lineup-verdict-${label.toLowerCase()}`}
    >
      {label} {v.confidence}
    </span>
  );
  return (
    <Tooltip content={`Average card confidence of ${s.n} player${s.n === 1 ? '' : 's'}; color = verdict of the average score (cash ${s.cash.score}, GPP ${s.gpp.score})`}>
      <span tabIndex={0} className={cn('inline-flex items-center gap-1', className)} aria-label={`Average verdict confidence: cash ${s.cash.confidence}, GPP ${s.gpp.confidence}`}>
        {chip('Cash', s.cash)}
        {chip('GPP', s.gpp)}
      </span>
    </Tooltip>
  );
}
