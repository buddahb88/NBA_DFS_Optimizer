// Top-bar site switcher and slate selector, bound to SlateContext.
import Badge from '../ui/Badge';
import Select from '../ui/Select';
import Tooltip from '../ui/Tooltip';
import { useSlate } from '../../context/SlateContext';
import { describeTeamRules, formatRosterSlots, formatSalaryCap } from '../../context/slateSelection';

export function SiteSwitcherSlot() {
  const { site, sites, siteConfig, setSite } = useSlate();
  // Until GET /api/sites answers, show the persisted site so the control doesn't jump
  const options = sites.length ? sites.map((s) => ({ value: s.key, label: s.name })) : [{ value: site, label: site }];

  return (
    <div className="flex items-center gap-2">
      <Select
        size="sm"
        aria-label="DFS site"
        value={site}
        onChange={(e) => setSite(e.target.value)}
        disabled={!sites.length}
        options={options}
        className="w-28"
      />
      {siteConfig && <SiteFormatBadge site={siteConfig} />}
    </div>
  );
}

function SiteFormatBadge({ site }) {
  const roster = formatRosterSlots(site.rosterSlots);
  const rules = describeTeamRules(site);
  const details = (
    <div className="space-y-0.5">
      <div className="font-medium">{site.name} classic</div>
      <div>Salary cap {formatSalaryCap(site.salaryCap)}</div>
      <div>Roster {roster}</div>
      {rules.length > 0 && <div className="text-fg-muted">{rules.join(' · ')}</div>}
    </div>
  );

  return (
    <Tooltip content={details} side="bottom">
      <Badge tone="accent" tabIndex={0} className="hidden md:inline-flex" aria-label={`Salary cap ${formatSalaryCap(site.salaryCap)}, roster ${roster}`}>
        {formatSalaryCap(site.salaryCap)} · {site.rosterSlots.length} players
      </Badge>
    </Tooltip>
  );
}

export function SlateSelectorSlot() {
  const { slates, slateId, setSlateId, loadingSlates, error } = useSlate();

  let placeholder = null;
  if (loadingSlates && !slates.length) placeholder = 'Loading slates…';
  else if (error && !slates.length) placeholder = 'Slates unavailable';
  else if (!slates.length) placeholder = 'No slates';

  return (
    <Select
      size="sm"
      aria-label="Slate"
      title={error || undefined}
      value={placeholder ? '' : slateId ?? ''}
      onChange={(e) => setSlateId(e.target.value)}
      disabled={Boolean(placeholder)}
      options={placeholder ? [{ value: '', label: placeholder }] : slates.map((s) => ({ value: String(s.slate_id), label: s.name }))}
      className="w-36 sm:w-48"
    />
  );
}
