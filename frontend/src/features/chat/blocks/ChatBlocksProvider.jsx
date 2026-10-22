import { useMemo } from 'react';
import usePlayerSettings from '../../playerPool/usePlayerSettings';
import { resolveSlatePlayer } from './blockModel';
import { ChatBlocksContext, NO_PINS } from './blocksContext';
import { useToast } from './toastContext';

const CONTROL_TEXT = {
  lock: ['Locked', 'Unlocked'],
  exclude: ['Excluded', 'Included'],
};

/**
 * Slate, saved player controls (Lock / Exclude, same store as the Player Pool)
 * and session pins for chat cards. `pins` comes from useChatPins.
 */
export function ChatBlocksProvider({ slateId, site, siteConfig, slatePlayers = [], pins = NO_PINS, children }) {
  const notify = useToast();
  const { settings, update } = usePlayerSettings(slateId);

  const value = useMemo(() => {
    const findSlatePlayer = (p) => resolveSlatePlayer(slatePlayers, p);
    return {
      slateId,
      site,
      siteConfig,
      slatePlayers,
      findSlatePlayer,
      /** Saved controls for a card player, {} when none, null when not on the slate. */
      controlsFor: (p) => {
        const sp = findSlatePlayer(p);
        return sp ? settings[String(sp.player_id)] ?? {} : null;
      },
      /** Flip lock or exclude for a card player (optimistic; failures toast and reload). */
      toggleControl: (p, control) => {
        const sp = findSlatePlayer(p);
        if (!slateId || !sp) {
          notify({ text: `${p.name} isn't on the current slate.`, tone: 'negative' });
          return;
        }
        const on = !settings[String(sp.player_id)]?.[control];
        const invalid = update(sp.player_id, { [control]: on }, { onError: (text) => notify({ text, tone: 'negative' }) });
        if (invalid) notify({ text: invalid, tone: 'negative' });
        else notify({ text: `${CONTROL_TEXT[control][on ? 0 : 1]} ${sp.name}`, tone: 'positive' });
      },
      pinned: pins.pinned,
      isPinned: pins.isPinned,
      togglePin: pins.togglePin
        ? (p) => {
            const nowPinned = pins.togglePin(p);
            notify({ text: nowPinned ? `Pinned ${p.name} to context` : `Unpinned ${p.name}`, tone: 'info' });
          }
        : null,
    };
  }, [slateId, site, siteConfig, slatePlayers, settings, update, notify, pins]);

  return <ChatBlocksContext.Provider value={value}>{children}</ChatBlocksContext.Provider>;
}
