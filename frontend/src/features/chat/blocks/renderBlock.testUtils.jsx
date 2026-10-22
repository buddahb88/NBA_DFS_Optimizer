/* eslint-disable react-refresh/only-export-components */
// Shared render helper for block tests (services/api must be mocked by the test file).
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ChatBlocksProvider } from './ChatBlocksProvider';
import { ToastProvider } from './Toasts';
import useChatPins from '../useChatPins';

export const SLATE_PLAYERS = [
  { id: 1, player_id: 'p1', name: 'Guard One', team: 'BOS', opponent: 'NYK', position: 'PG', salary: 8000, projected_points: 44, headshot: 'g1.png' },
  { id: 2, player_id: 'p2', name: 'Wing Two', team: 'BOS', opponent: 'NYK', position: 'SF', salary: 6000, projected_points: 30 },
  { id: 3, player_id: 'p3', name: 'Big Three', team: 'NYK', opponent: 'BOS', position: 'C', salary: 7000, projected_points: 36 },
];

export const SITE_CONFIG = {
  key: 'draftkings',
  name: 'DraftKings',
  salaryCap: 50000,
  rosterSlots: [{ slot: 'PG', eligible: ['PG'] }, { slot: 'SF', eligible: ['SF'] }, { slot: 'C', eligible: ['C'] }],
};

let lastLocation = null;
function LocationProbe() {
  lastLocation = useLocation();
  return <div data-testid="route">{lastLocation.pathname}</div>;
}
export const currentLocation = () => lastLocation;

function Harness({ slateId, slatePlayers, children }) {
  const pins = useChatPins(null);
  return (
    <ChatBlocksProvider slateId={slateId} site="draftkings" siteConfig={SITE_CONFIG} slatePlayers={slatePlayers} pins={pins}>
      {children}
      <ul aria-label="Pinned">
        {pins.pinned.map((p) => (
          <li key={p.name}>{p.name}</li>
        ))}
      </ul>
    </ChatBlocksProvider>
  );
}

/** Render inside router + toasts + block context with real session pins (listed under "Pinned"). */
export function renderWithBlocks(ui, { slateId = '42', slatePlayers = SLATE_PLAYERS } = {}) {
  lastLocation = null;
  return render(
    <MemoryRouter initialEntries={['/chat']}>
      <ToastProvider>
        <Harness slateId={slateId} slatePlayers={slatePlayers}>
          <Routes>
            <Route path="/chat" element={ui} />
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </Harness>
      </ToastProvider>
    </MemoryRouter>,
  );
}
