import { Button, IconBolt, Input, Select, Slider } from '../../components/ui';
import { CONTEST_PRESETS, PRESET_OPTIONS } from './presets';
import StackRuleBuilder from './StackRuleBuilder';
import { formatSalary } from './lineupMath';

function Section({ title, children }) {
  return (
    <section className="flex flex-col gap-3 border-b border-line px-3 py-3 last:border-b-0">
      {title && <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">{title}</h4>}
      {children}
    </section>
  );
}

const intOr = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Left-hand optimizer settings. `settings` is the page's settings object;
 * `onChange(patch)` merges a partial update, `onPreset(key)` applies a preset.
 */
export default function SettingsPanel({
  settings,
  onChange,
  onPreset,
  stackErrors,
  players,
  siteConfig,
  lockedCount,
  excludedCount,
  onGenerate,
  generating,
  canGenerate,
  disabledReason,
}) {
  const preset = CONTEST_PRESETS[settings.preset];
  const multi = settings.numLineups > 1;
  const rosterSize = siteConfig.rosterSlots.length;
  const capStep = siteConfig.salaryCap >= 10000 ? 100 : 1;

  return (
    <div className="flex flex-col">
      <Section>
        <Select
          label="Contest type"
          value={settings.preset}
          onChange={(e) => onPreset(e.target.value)}
          options={[...PRESET_OPTIONS, ...(settings.preset === 'custom' ? [{ value: 'custom', label: 'Custom' }] : [])]}
        />
        <p className="-mt-1.5 text-2xs text-fg-subtle">
          {preset ? preset.description : 'Settings changed from the preset.'}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Input
            label="Lineups"
            type="number"
            min={1}
            max={150}
            numeric
            value={settings.numLineups}
            onChange={(e) => onChange({ numLineups: Math.min(150, Math.max(1, intOr(e.target.value, 1))) })}
          />
          <Input
            label="Min salary"
            type="number"
            min={0}
            max={siteConfig.salaryCap}
            step={capStep}
            numeric
            value={settings.minSalary}
            hint={`Cap ${formatSalary(siteConfig.salaryCap)}`}
            onChange={(e) => onChange({ minSalary: Math.max(0, intOr(e.target.value, 0)) })}
          />
        </div>
      </Section>

      <Section title="Diversity">
        <Slider
          label="Randomness"
          min={0}
          max={50}
          value={settings.randomness}
          format={(v) => `${v}%`}
          onChange={(v) => onChange({ randomness: v })}
        />
        <Slider
          label="Global max exposure"
          min={5}
          max={100}
          step={5}
          value={settings.maxExposure}
          format={(v) => `${v}%`}
          disabled={!multi}
          onChange={(v) => onChange({ maxExposure: v })}
        />
        <Input
          label="Min uniqueness"
          type="number"
          min={1}
          max={rosterSize}
          numeric
          disabled={!multi}
          value={settings.minUniqueness}
          hint={multi ? 'Players each lineup must differ from every other' : 'Applies to multi-lineup runs'}
          onChange={(e) => onChange({ minUniqueness: Math.min(rosterSize, Math.max(1, intOr(e.target.value, 1))) })}
        />
      </Section>

      <Section title="Projection">
        <Slider
          label="Opportunity factor"
          min={0}
          max={100}
          step={5}
          value={Math.round((settings.opportunityWeight ?? 0) * 100)}
          format={(v) => (v === 0 ? 'Off' : `${v}%`)}
          onChange={(v) => onChange({ opportunityWeight: v / 100 })}
        />
        <p className="-mt-1.5 text-2xs text-fg-subtle">
          Nudges projections up to ±10% by the Opportunity Radar {settings.mode === 'gpp' ? 'GPP' : 'Cash'} score. Off leaves them unchanged.
        </p>
      </Section>

      <Section>
        <StackRuleBuilder
          rules={settings.stackRules}
          errors={stackErrors}
          players={players}
          onChange={(stackRules) => onChange({ stackRules })}
        />
      </Section>

      <Section>
        <details className="group">
          <summary className="cursor-pointer list-none text-xs font-semibold uppercase tracking-wider text-fg-subtle hover:text-fg">
            Pool filters <span className="font-normal normal-case tracking-normal">(projection, minutes, ownership)</span>
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            <Slider
              label="Min projection"
              min={0}
              max={40}
              value={settings.minProjection}
              format={(v) => `${v} pts`}
              onChange={(v) => onChange({ minProjection: v })}
            />
            <Slider
              label="Min minutes"
              min={0}
              max={36}
              value={settings.minMinutes}
              format={(v) => `${v} min`}
              onChange={(v) => onChange({ minMinutes: v })}
            />
            <Slider
              label="Max ownership"
              min={5}
              max={100}
              step={5}
              value={settings.maxOwnership}
              format={(v) => `${v}%`}
              onChange={(v) => onChange({ maxOwnership: v })}
            />
          </div>
        </details>
      </Section>

      <div className="sticky bottom-0 flex flex-col gap-1.5 border-t border-line bg-surface px-3 py-3">
        {(lockedCount > 0 || excludedCount > 0) && (
          <p className="text-2xs text-fg-muted">
            {lockedCount > 0 && `${lockedCount} locked`}
            {lockedCount > 0 && excludedCount > 0 && ' · '}
            {excludedCount > 0 && `${excludedCount} excluded`}
          </p>
        )}
        <Button
          variant="primary"
          size="lg"
          className="w-full justify-center"
          leftIcon={<IconBolt size={14} />}
          loading={generating}
          disabled={!canGenerate}
          onClick={onGenerate}
        >
          {generating ? 'Optimizing…' : `Generate ${settings.numLineups === 1 ? 'lineup' : `${settings.numLineups} lineups`}`}
        </Button>
        {!canGenerate && !generating && disabledReason && <p className="text-2xs text-caution">{disabledReason}</p>}
      </div>
    </div>
  );
}
