import { createRule } from './stackRules';

// Contest-type presets for the Lineup Studio settings panel. Picking one fills
// every setting below it; the user can still tweak each value afterwards.
// Pool filters (minProjection, minMinutes, maxOwnership) feed the optimizer's
// legacy filters. minSalaryPct is a share of the site's salary cap so presets work on DK, FD and Yahoo.

export const CONTEST_PRESETS = {
  cash: {
    label: 'Cash',
    description: '50/50s and double-ups: one max-projection lineup, no stacking.',
    mode: 'cash',
    numLineups: 1,
    randomness: 0,
    minUniqueness: 1,
    maxExposure: 100,
    minSalaryPct: 0.98,
    minProjection: 25,
    minMinutes: 28,
    maxOwnership: 100,
    stackRules: [],
  },
  se: {
    label: 'Single-entry GPP',
    description: 'One tournament lineup with a light game stack for correlation.',
    mode: 'gpp',
    numLineups: 1,
    randomness: 5,
    minUniqueness: 1,
    maxExposure: 100,
    minSalaryPct: 0.96,
    minProjection: 20,
    minMinutes: 20,
    maxOwnership: 100,
    stackRules: [{ kind: 'gameStack', min: 3, bringBack: 1 }],
  },
  max20: {
    label: '20-max',
    description: 'Small multi-entry: moderate randomness and exposure caps.',
    mode: 'gpp',
    numLineups: 20,
    randomness: 15,
    minUniqueness: 2,
    maxExposure: 60,
    minSalaryPct: 0.95,
    minProjection: 20,
    minMinutes: 20,
    maxOwnership: 100,
    stackRules: [{ kind: 'gameStack', min: 3, bringBack: 1, percentOfLineups: 60 }],
  },
  max150: {
    label: '150-max',
    description: 'Mass multi-entry: high randomness, tight exposure, shootout stacks.',
    mode: 'gpp',
    numLineups: 150,
    randomness: 25,
    minUniqueness: 3,
    maxExposure: 40,
    minSalaryPct: 0.94,
    minProjection: 20,
    minMinutes: 20,
    maxOwnership: 100,
    stackRules: [
      { kind: 'preset:shootout', min: 3, bringBack: 1, topGames: 2, maxSpread: 6, percentOfLineups: 50 },
      { kind: 'teamStack', min: 3, percentOfLineups: 30 },
    ],
  },
};

export const PRESET_OPTIONS = Object.entries(CONTEST_PRESETS).map(([value, p]) => ({ value, label: p.label }));

/** Round a min salary to a sensible step for the site's cap ($100 on DK/FD, $1 on Yahoo). */
export function minSalaryFor(preset, salaryCap) {
  const step = salaryCap >= 10000 ? 100 : 1;
  return Math.floor((salaryCap * preset.minSalaryPct) / step) * step;
}

/** Full settings object for a preset (stack rules become editable drafts). */
export function settingsFromPreset(key, salaryCap) {
  const preset = CONTEST_PRESETS[key];
  // eslint-disable-next-line no-unused-vars -- display-only fields stay out of settings
  const { label, description, minSalaryPct, stackRules, ...settings } = preset;
  return {
    ...settings,
    preset: key,
    minSalary: minSalaryFor(preset, salaryCap),
    stackRules: stackRules.map(({ kind, ...overrides }) => createRule(kind, overrides)),
  };
}
