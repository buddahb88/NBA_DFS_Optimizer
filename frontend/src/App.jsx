import { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './components/layout/AppShell';
import LegacyPage from './components/layout/LegacyPage';
import Spinner from './components/ui/Spinner';
import { SlateProvider } from './context/SlateContext';
import HomePage from './pages/HomePage';
import PlayerPoolPage from './pages/PlayerPoolPage';
import LineupsPage from './pages/LineupsPage';
import LineupStudioPage from './pages/LineupStudioPage';
import ChatPage from './pages/ChatPage';
import InsightsPage from './pages/InsightsPage';

const UIKitPage = lazy(() => import('./pages/UIKitPage'));

function App() {
  return (
    <SlateProvider>
      <Router>
        <AppShell>
          <Routes>
            <Route path="/" element={<LegacyPage><HomePage /></LegacyPage>} />
            <Route path="/players" element={<LegacyPage><PlayerPoolPage /></LegacyPage>} />
            <Route path="/insights" element={<LegacyPage><InsightsPage /></LegacyPage>} />
            <Route path="/lineup-builder" element={<Navigate to="/optimizer?mode=manual" replace />} />
            <Route path="/optimizer" element={<LineupStudioPage />} />
            <Route path="/lineups" element={<LegacyPage><LineupsPage /></LegacyPage>} />
            <Route path="/chat" element={<LegacyPage fullBleed><ChatPage /></LegacyPage>} />
            <Route
              path="/ui-kit"
              element={
                <Suspense fallback={<div className="flex justify-center py-16"><Spinner size="md" /></div>}>
                  <UIKitPage />
                </Suspense>
              }
            />
          </Routes>
        </AppShell>
      </Router>
    </SlateProvider>
  );
}

export default App;
