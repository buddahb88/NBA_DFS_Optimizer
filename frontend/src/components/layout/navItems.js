import {
  IconChart,
  IconChat,
  IconCpu,
  IconDashboard,
  IconList,
  IconPalette,
  IconUsers,
  IconWrench,
} from '../ui/icons';

// `end` = only active on an exact path match.
export const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: IconDashboard, end: true },
  { to: '/players', label: 'Player Pool', icon: IconUsers },
  { to: '/optimizer', label: 'Optimizer', icon: IconCpu },
  { to: '/lineups', label: 'Lineups', icon: IconList },
  { to: '/lineup-builder', label: 'Lineup Builder', icon: IconWrench },
  { to: '/insights', label: 'Insights', icon: IconChart },
  { to: '/chat', label: 'AI Chat', icon: IconChat },
];

export const DEV_NAV_ITEMS = [{ to: '/ui-kit', label: 'UI Kit', icon: IconPalette }];
