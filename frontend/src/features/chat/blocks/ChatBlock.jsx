import { Component } from 'react';
import { IconInfo } from '../../../components/ui';
import LineupBlock from './LineupBlock';
import LineupScoreCard from './LineupScoreCard';
import { MatchupTableBlock, TeamDefenseBlock } from './MatchupTable';
import PlayerCardList from './PlayerCardList';

const BLOCK_COMPONENTS = {
  player_list: PlayerCardList,
  usage_bumps: PlayerCardList,
  streaks: PlayerCardList,
  lineup: LineupBlock,
  matchup_table: MatchupTableBlock,
  team_defense: TeamDefenseBlock,
  lineup_score: LineupScoreCard,
};

function Fallback({ block, reason }) {
  return (
    <div role="note" className="my-3 flex items-start gap-2 rounded-md border border-dashed border-line bg-surface-sunken px-3 py-2 text-xs text-fg-muted">
      <IconInfo size={14} className="mt-px shrink-0 text-fg-subtle" />
      <span>
        {block.title ? <span className="font-medium text-fg">{block.title}: </span> : null}
        {reason}
      </span>
    </div>
  );
}

// A malformed block shouldn't take the conversation down with it
class BlockBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error('Chat block failed to render:', error);
  }

  render() {
    return this.state.failed ? <Fallback block={this.props.block} reason="This result couldn't be displayed." /> : this.props.children;
  }
}

/** Rich component for one normalized ui_block; unknown types get a quiet fallback. */
export default function ChatBlock({ block }) {
  const Renderer = BLOCK_COMPONENTS[block.type];
  if (!Renderer) return <Fallback block={block} reason={`"${block.type}" results aren't supported in this view yet.`} />;
  return (
    <BlockBoundary block={block}>
      <Renderer block={block} />
    </BlockBoundary>
  );
}

export function ChatBlocks({ blocks }) {
  if (!blocks?.length) return null;
  return (
    <div className="flex flex-col">
      {blocks.map((b) => (
        <ChatBlock key={b.id} block={b} />
      ))}
    </div>
  );
}
