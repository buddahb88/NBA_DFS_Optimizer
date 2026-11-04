import { createContext, useContext } from 'react';

/**
 * open({ playerId, slateId?, slateDate?, name?, headshot?, team?, controls? })
 *   slateId omitted -> the app's working slate (the backtest's when one is picked)
 *   controls: { lock, exclude, maxExposure, exposure: bool, onUpdate(patch) } to
 *             drive the page's own lock / exclude state; omitted -> the card
 *             saves player settings itself (playerSettingsAPI)
 * close()
 * Without a provider open is null and triggers render plain text.
 */
export const PlayerCardContext = createContext({ open: null, close: () => {}, target: null });

export const usePlayerCard = () => useContext(PlayerCardContext);
