import { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import AppShell from './components/layout/AppShell';
import LegacyPage from './components/layout/LegacyPage';
import Spinner from './components/ui/Spinner';
import HomePage from './pages/HomePage';
import PlayerPoolPage from './pages/PlayerPoolPage';
import LineupBuilderPage from './pages/LineupBuilderPage';
import LineupsPage from './pages/LineupsPage';
import OptimizerPage from './pages/OptimizerPage';
import ChatPage from './pages/ChatPage';
import InsightsPage from './pages/InsightsPage';

const UIKitPage = lazy(() => import('./pages/UIKitPage'));

function App() {
  return (
    <Router>
      <AppShell>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/players" element={<LegacyPage><PlayerPoolPage /></LegacyPage>} />
          <Route path="/insights" element={<LegacyPage><InsightsPage /></LegacyPage>} />
          <Route path="/lineup-builder" element={<LegacyPage><LineupBuilderPage /></LegacyPage>} />
          <Route path="/optimizer" element={<LegacyPage><OptimizerPage /></LegacyPage>} />
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
  );
}

export default App;
