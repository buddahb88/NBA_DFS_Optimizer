// Map GET /api/historical/seasons into season-selector options
export function toSeasonOptions(info) {
  return (info?.seasons || []).map(({ value, current }) => ({
    value,
    label: current ? `${value} (Current)` : value,
  }));
}
