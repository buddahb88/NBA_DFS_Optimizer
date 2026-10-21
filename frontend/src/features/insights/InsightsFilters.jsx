import { useState } from 'react';
import { Badge, Button, Input, Select } from '../../components/ui';
import { WINDOWS, toDateInput, validateRange } from './insights';

/**
 * Date window + site for every card. Preset windows apply immediately; a
 * custom range (backtest) applies on "Apply" so half-typed dates don't fetch.
 * `range` = summary.dateRange, used to prefill a new custom range.
 */
export default function InsightsFilters({ value, onChange, siteName, range }) {
  const [mode, setMode] = useState(value.mode);
  const [startDate, setStartDate] = useState(value.startDate);
  const [endDate, setEndDate] = useState(value.endDate);
  const [error, setError] = useState(null);

  const pickMode = (next) => {
    setMode(next);
    setError(null);
    if (next !== 'custom') {
      onChange({ mode: next, startDate: '', endDate: '' });
      return;
    }
    if (!startDate) setStartDate(toDateInput(range?.earliest));
    if (!endDate) setEndDate(toDateInput(range?.latest));
  };

  const apply = () => {
    const message = validateRange(startDate, endDate);
    setError(message);
    if (!message) onChange({ mode: 'custom', startDate, endDate });
  };

  return (
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2 rounded-md border border-line bg-surface px-3 py-2">
      <Select
        size="sm"
        label="Date window"
        value={mode}
        onChange={(e) => pickMode(e.target.value)}
        options={WINDOWS.map(({ value, label }) => ({ value, label }))}
        className="w-52"
      />
      {mode === 'custom' && (
        <>
          <Input
            type="date"
            label="From"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-40 [&_input]:h-7 [&_input]:text-xs"
          />
          <Input
            type="date"
            label="To"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-40 [&_input]:h-7 [&_input]:text-xs"
          />
          <Button size="sm" variant="primary" onClick={apply}>
            Apply
          </Button>
        </>
      )}
      <div className="flex min-h-7 items-center gap-2 text-2xs text-fg-subtle">
        {error ? (
          <span role="alert" className="text-negative">
            {error}
          </span>
        ) : mode === 'custom' ? (
          'Only games inside this range count, for backtesting past slates.'
        ) : null}
      </div>
      {siteName && (
        <Badge tone="info" className="ml-auto self-center" title="Fantasy points are scored with this site's rules">
          {siteName} scoring
        </Badge>
      )}
    </div>
  );
}
