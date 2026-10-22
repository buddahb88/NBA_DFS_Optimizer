import { createContext } from 'react';

// Player name -> headshot URL for the slate's players (used by chat tables)
export const PlayerHeadshotsContext = createContext({});

export function formatTimestamp(timestamp, now = new Date()) {
  const date = new Date(timestamp);
  const diffInMins = Math.floor((now - date) / 60000);
  if (diffInMins < 1) return 'Just now';
  if (diffInMins < 60) return `${diffInMins}m ago`;
  const diffInHours = Math.floor(diffInMins / 60);
  if (diffInHours < 24) return `${diffInHours}h ago`;
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
