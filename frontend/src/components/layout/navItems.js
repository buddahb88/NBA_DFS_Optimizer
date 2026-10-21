import {
  IconChart,
  IconChat,
  IconCpu,
  IconDashboard,
  IconGrid,
  IconList,
  IconPalette,
  IconUsers,
  IconWrench,
} from '../ui/icons';

// `end` = only active on an exact path match.
export const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: IconDashboard, end: true },
  { to: '/players', label: 'Player Pool', icon: IconUsers },
  { to: '/optimizer', label: 'Lineup Studio', icon: IconCpu },
  { to: '/lineups', label: 'Lineups', icon: IconList },
  { to: '/insights', label: 'Insights', icon: IconChart },
  { to: '/archetypes', label: 'Archetypes', icon: IconGrid },
  { to: '/chat', label: 'AI Chat', icon: IconChat },
  { to: '/data-status', label: 'Data Status', icon: IconWrench },
];

export const DEV_NAV_ITEMS = [{ to: '/ui-kit', label: 'UI Kit', icon: IconPalette }];
