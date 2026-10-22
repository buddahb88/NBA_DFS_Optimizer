import { createContext, useContext } from 'react';

export const NO_PINS = { pinned: [], isPinned: () => false, togglePin: null };

export const ChatBlocksContext = createContext({
  slateId: null,
  site: null,
  siteConfig: null,
  slatePlayers: [],
  findSlatePlayer: () => null,
  controlsFor: () => null,
  toggleControl: null,
  ...NO_PINS,
});

/** What block cards need from the page; without a provider, actions are hidden. */
export const useChatBlocks = () => useContext(ChatBlocksContext);
