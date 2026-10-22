import { memo } from 'react';
import {
  Badge,
  IconBolt,
  IconChart,
  IconClipboardCheck,
  IconClock,
  IconDollar,
  IconFlame,
  IconLayers,
  IconTarget,
  IconUsers,
  cn,
} from '../../components/ui';
import { formatTipoff } from '../../pages/home/slateDashboard';
import { AssistantMark } from './ChatMessage';
import { greeting } from './chatFormat';

const KIND_ICONS = {
  usage_bump: IconUsers,
  archetype_edge: IconTarget,
  game_stack: IconLayers,
  hot_streak: IconFlame,
  value_play: IconDollar,
  score_lineup: IconClipboardCheck,
  leverage: IconChart,
};

const fmtLine = (n) => (n > 0 ? `+${n}` : `${n}`);

function GameChip({ game }) {
  const sep = game.hasHomeAway ? '@' : 'vs';
  const line = game.favorite && game.spread != null ? `${game.favorite} ${fmtLine(-game.spread)}` : null;
  return (
    <li className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md border border-line bg-surface-sunken px-2.5 py-1.5 text-xs">
      <span className="font-semibold text-fg">
        {game.away.team} <span className="font-normal text-fg-subtle">{sep}</span> {game.home.team}
      </span>
      {game.total != null && (
        <span className="num text-fg-muted" title="Vegas total">
          O/U <span className="text-fg">{game.total}</span>
        </span>
      )}
      {line && (
        <span className={cn('num', game.blowout ? 'text-caution' : 'text-fg-muted')} title={game.blowout ? 'Blowout risk' : 'Spread'}>
          {line}
        </span>
      )}
    </li>
  );
}

function SlateSummary({ slate, siteName, games, firstLock, loading }) {
  if (!slate) {
    return (
      <p className="rounded-lg border border-dashed border-line px-4 py-3 text-sm text-fg-muted">
        No slate selected. Pick one in the top bar and answers will use tonight&apos;s players and lines.
      </p>
    );
  }

  return (
    <section aria-label="Tonight's slate" className="rounded-lg border border-line bg-surface p-4 text-left">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        <span className="text-sm font-semibold text-fg">{slate.name}</span>
        {siteName && <Badge tone="accent" size="sm">{siteName}</Badge>}
        {!loading && (
          <>
            <span className="text-fg-muted">
              <span className="num text-fg">{games.length}</span> {games.length === 1 ? 'game' : 'games'}
            </span>
            <span className="flex items-center gap-1 text-fg-muted">
              <IconClock size={12} className="text-fg-subtle" />
              Lock <span className="num text-fg">{formatTipoff(firstLock)}</span>
            </span>
          </>
        )}
      </div>
      {loading ? (
        <div className="mt-3 flex gap-2 overflow-hidden sm:flex-wrap" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-7 w-36 shrink-0 animate-pulse rounded-md bg-surface-sunken motion-reduce:animate-none" />
          ))}
        </div>
      ) : games.length > 0 ? (
        // Phones: one scrolling row so the prompts stay in view; wider screens wrap
        <ul className="scrollbar-thin -mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0" aria-label="Games">
          {games.map((g) => (
            <GameChip key={g.key} game={g} />
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-fg-muted">No players loaded for this slate yet.</p>
      )}
    </section>
  );
}

function SuggestionCard({ suggestion, onSend, disabled }) {
  const Icon = KIND_ICONS[suggestion.kind] ?? IconBolt;
  return (
    <button
      type="button"
      onClick={() => onSend(suggestion.prompt)}
      disabled={disabled}
      title={suggestion.detail}
      className="group flex items-start gap-3 rounded-lg border border-line bg-surface p-3 text-left transition-[border-color,background-color,transform] duration-150 hover:-translate-y-px hover:border-line-strong hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
    >
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
        <Icon size={14} />
      </span>
      <span className="min-w-0">
        <span className="block text-2xs font-semibold uppercase tracking-wide text-fg-subtle">{suggestion.label}</span>
        <span className="mt-0.5 block text-sm text-fg-muted group-hover:text-fg">{suggestion.prompt}</span>
      </span>
    </button>
  );
}

/**
 * Empty state for a new chat: greeting, tonight's slate (games with Vegas
 * lines, lock, site) and starter prompts. Clicking a prompt sends it.
 */
function ChatWelcome({ slate, siteName, games = [], firstLock, slateLoading, suggestions = [], suggestionsLoading, onSend, disabled, now }) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 animate-fade-in motion-reduce:animate-none sm:py-14">
      <header className="text-center">
        <div className="mb-4 flex justify-center">
          <AssistantMark size={44} />
        </div>
        <h2 className="text-xl font-semibold text-fg">{greeting(now)}. What are we building tonight?</h2>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-fg-muted">
          Ask about value, matchups, stacks or lineups. Specialist agents dig into the slate and history for you.
        </p>
      </header>

      <SlateSummary slate={slate} siteName={siteName} games={games} firstLock={firstLock} loading={slateLoading} />

      <section aria-label="Suggested prompts">
        <h3 className="mb-2 text-2xs font-semibold uppercase tracking-wide text-fg-subtle">Try asking</h3>
        {suggestionsLoading ? (
          <div className="grid gap-2 sm:grid-cols-2" aria-busy="true" aria-label="Loading suggestions">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-[4.5rem] animate-pulse rounded-lg border border-line bg-surface motion-reduce:animate-none" />
            ))}
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {suggestions.map((s) => (
              <SuggestionCard key={s.id} suggestion={s} onSend={onSend} disabled={disabled} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default memo(ChatWelcome);
