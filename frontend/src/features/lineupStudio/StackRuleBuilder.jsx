import { useMemo } from 'react';
import { Badge, Button, IconX, Input, Select, cn } from '../../components/ui';
import {
  FIELD_LABELS,
  RULE_TYPES,
  STACK_PRESETS,
  createRule,
  describeRule,
  ruleDefinition,
  slateGames,
  slateTeams,
} from './stackRules';

const NUMERIC_FIELDS = ['min', 'max', 'bringBack', 'topGames', 'maxSpread'];

/** Chips for the picked values plus a select to add more. */
function ChipPicker({ label, values, options, onChange, format = (v) => v }) {
  const remaining = options.filter((o) => !values.includes(o.value));
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-fg-muted">{label}</span>
      <div className="flex flex-wrap items-center gap-1">
        {values.map((v) => (
          <span key={v} className="inline-flex h-6 items-center gap-1 rounded border border-line bg-surface-raised pl-2 pr-1 text-xs text-fg">
            {format(v)}
            <button
              type="button"
              aria-label={`Remove ${format(v)}`}
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="rounded p-0.5 text-fg-subtle hover:bg-surface-sunken hover:text-fg"
            >
              <IconX size={10} />
            </button>
          </span>
        ))}
        <select
          aria-label={`Add ${label.toLowerCase()}`}
          value=""
          onChange={(e) => {
            const opt = remaining.find((o) => String(o.value) === e.target.value);
            if (opt) onChange([...values, opt.value]);
          }}
          className="h-6 max-w-[10rem] cursor-pointer rounded border border-dashed border-line bg-transparent px-1.5 text-xs text-fg-muted hover:border-line-strong focus:border-accent focus:outline-none"
        >
          <option value="">{values.length ? '+ add' : 'Any'}</option>
          {remaining.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function RuleEditor({ rule, errors, onChange, onRemove, teamOptions, gameOptions, playerOptions, playerName }) {
  const def = ruleDefinition(rule);
  const set = (field, value) => onChange({ ...rule, [field]: value });
  const isPreset = rule.kind.startsWith('preset:');

  return (
    <div className={cn('rounded-md border bg-surface-sunken/40 p-2.5', errors ? 'border-negative/50' : 'border-line')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Badge tone={isPreset ? 'info' : 'accent'} size="sm">
              {def.label}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-fg">{describeRule(rule, playerName)}</p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Remove rule" onClick={onRemove}>
          <IconX size={14} />
        </Button>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2">
        {def.fields
          .filter((f) => NUMERIC_FIELDS.includes(f))
          .map((f) => (
            <Input
              key={f}
              label={FIELD_LABELS[f]}
              type="number"
              min={0}
              numeric
              value={rule[f] ?? ''}
              onChange={(e) => set(f, e.target.value === '' ? '' : Number(e.target.value))}
            />
          ))}
        <Input
          label="% lineups"
          type="number"
          min={0}
          max={100}
          numeric
          value={rule.percentOfLineups ?? ''}
          onChange={(e) => set('percentOfLineups', e.target.value === '' ? '' : Number(e.target.value))}
        />
      </div>

      {def.fields.includes('teams') && (
        <div className="mt-2">
          <ChipPicker label="Teams" values={rule.teams} options={teamOptions} onChange={(v) => set('teams', v)} />
        </div>
      )}
      {def.fields.includes('games') && (
        <div className="mt-2">
          <ChipPicker label="Games" values={rule.games} options={gameOptions} onChange={(v) => set('games', v)} />
        </div>
      )}
      {def.fields.includes('playerIds') && (
        <div className="mt-2">
          <ChipPicker
            label="Players"
            values={rule.playerIds}
            options={playerOptions}
            onChange={(v) => set('playerIds', v)}
            format={playerName}
          />
        </div>
      )}

      <p className="mt-2 text-2xs text-fg-subtle">{def.help}</p>
      {errors && (
        <ul className="mt-1.5 space-y-0.5">
          {errors.map((e) => (
            <li key={e} className="text-2xs text-negative">
              {e}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Builds settings.stackRules (see stackRules.js). `rules` are drafts from
 * createRule(); `errors` is validateDraftRules(rules).
 */
export default function StackRuleBuilder({ rules, onChange, errors = {}, players = [] }) {
  const teamOptions = useMemo(() => slateTeams(players).map((t) => ({ value: t, label: t })), [players]);
  const gameOptions = useMemo(() => slateGames(players).map((g) => ({ value: g, label: g.replace('@', ' vs ') })), [players]);
  const playerOptions = useMemo(
    () =>
      [...players]
        .sort((a, b) => (b.projected_points || 0) - (a.projected_points || 0))
        .map((p) => ({ value: p.id, label: `${p.name} (${p.team})` })),
    [players],
  );
  const names = useMemo(() => new Map(players.map((p) => [p.id, p.name])), [players]);
  const playerName = (id) => names.get(id) || `#${id}`;

  const add = (kind) => kind && onChange([...rules, createRule(kind)]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end justify-between gap-2">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">Stack rules</h4>
          <p className="text-2xs text-fg-subtle">{rules.length ? `${rules.length} active` : 'None: any team/game mix'}</p>
        </div>
        <Select size="sm" aria-label="Add stack rule" value="" onChange={(e) => add(e.target.value)} className="w-36">
          <option value="">+ Add rule</option>
          <optgroup label="Rules">
            {Object.entries(RULE_TYPES).map(([key, t]) => (
              <option key={key} value={key}>
                {t.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="NBA presets">
            {Object.entries(STACK_PRESETS).map(([key, p]) => (
              <option key={key} value={`preset:${key}`}>
                {p.label}
              </option>
            ))}
          </optgroup>
        </Select>
      </div>

      {rules.map((rule) => (
        <RuleEditor
          key={rule.uid}
          rule={rule}
          errors={errors[rule.uid]}
          onChange={(next) => onChange(rules.map((r) => (r.uid === rule.uid ? next : r)))}
          onRemove={() => onChange(rules.filter((r) => r.uid !== rule.uid))}
          teamOptions={teamOptions}
          gameOptions={gameOptions}
          playerOptions={playerOptions}
          playerName={playerName}
        />
      ))}
    </div>
  );
}
