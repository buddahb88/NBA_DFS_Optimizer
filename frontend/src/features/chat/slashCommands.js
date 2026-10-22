// Composer slash commands. Each expands into a prompt template; [bracketed] text
// marks placeholders the user tabs through. {site} and {mode} come from the
// slate context bar.

export const SLASH_COMMANDS = [
  {
    name: 'value',
    args: '<salary>',
    description: 'Value plays under a salary',
    template:
      'Find the best {mode} value plays under $[salary] on tonight\'s {site} slate. Rank by projected points per $1K and include minutes, ownership and injury risk.',
  },
  {
    name: 'stacks',
    description: 'Best game stacks by Vegas total',
    template:
      'What are the best game stacks for {mode} on tonight\'s {site} slate? Rank games by Vegas total and spread, then build a [team] stack with a bring-back.',
  },
  {
    name: 'player',
    args: '<name>',
    description: 'Player breakdown and verdict',
    template:
      'Break down [player name] for {mode} on {site}: recent game log, role and usage, tonight\'s matchup against their archetype defense, projection vs salary, and a play or fade verdict.',
  },
  {
    name: 'matchups',
    description: 'Archetype matchup edges tonight',
    template:
      'Which players have the best archetype matchups tonight on {site}? Focus on [position or archetype] and explain the edge for {mode}.',
  },
  {
    name: 'score',
    args: '<date>',
    description: 'Score a lineup from a past date',
    template:
      'Score this {site} lineup from [YYYY-MM-DD]: [players]. Show each player\'s actual fantasy points and the lineup total.',
  },
  {
    name: 'usage',
    description: 'Usage bumps from injuries',
    template:
      'Who gets a usage bump from injuries or absences on tonight\'s {site} slate? Focus on [team or "all teams"] and rate each beneficiary for {mode}.',
  },
  {
    name: 'help',
    description: 'What the assistant can do',
    template:
      'What can you help me with on tonight\'s {site} slate? List the research you can run for {mode} and give an example question for each.',
  },
];

const MODE_LABELS = { cash: 'Cash', gpp: 'GPP' };

const PLACEHOLDER = /\[[^\]\n]+\]/g;

export function findCommand(name) {
  return SLASH_COMMANDS.find((c) => c.name === name?.toLowerCase()) || null;
}

/** Commands matching what was typed after "/": prefix matches first, then name/description matches. */
export function filterCommands(query) {
  const q = (query || '').toLowerCase();
  if (!q) return SLASH_COMMANDS;
  const prefix = SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
  const rest = SLASH_COMMANDS.filter((c) => !c.name.startsWith(q) && (c.name.includes(q) || c.description.toLowerCase().includes(q)));
  return [...prefix, ...rest];
}

/**
 * What a composer value means for the slash menu:
 *   "/va"          -> { query: 'va' }               (menu open, filtering)
 *   "/player luka" -> { command, arg: 'luka' }      (known command with an argument)
 *   anything else  -> null
 */
export function parseSlash(text) {
  const typing = /^\/(\w*)$/.exec(text);
  if (typing) return { query: typing[1] };
  const withArg = /^\/(\w+)\s+(.*)$/s.exec(text);
  if (withArg) {
    const command = findCommand(withArg[1]);
    if (command) return { command, arg: withArg[2].trim() };
  }
  return null;
}

/** Fill {site}/{mode}; an argument replaces the first placeholder. */
export function expandCommand(command, { arg, site, mode } = {}) {
  let text = command.template
    .replaceAll('{site}', site || 'DFS')
    .replaceAll('{mode}', MODE_LABELS[mode] || 'GPP');
  const value = command.name === 'value' ? arg?.replace(/^\$/, '') : arg;
  if (value) text = text.replace(/\[[^\]\n]+\]/, () => value);
  return text;
}

/** Next (or previous) [placeholder] range from `from`, wrapping around; null when none are left. */
export function findPlaceholder(text, from = 0, direction = 1) {
  const all = [...text.matchAll(PLACEHOLDER)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  if (!all.length) return null;
  if (direction > 0) return all.find((p) => p.start >= from) || all[0];
  return [...all].reverse().find((p) => p.end <= from) || all[all.length - 1];
}
