import { useEffect, useState } from 'react';
import { Toggle, Tooltip } from '../../components/ui';
import { projectionsAPI } from '../../services/api';

const COMPONENT_LABELS = { blowout: 'blowout trim', fppm: 'FPPM outlier shrink' };

/**
 * "Projection sanity adjustments" switch (GET / PUT /api/projections/sanity).
 * Server-wide: the optimizer, portfolio, chat, radar and player tables all
 * follow it. onChange(enabled) after a switch, so the page reloads its pool.
 * Renders nothing until the server answers.
 */
export default function ProjectionSanityToggle({ onChange, className }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // .then() so a client without getSanity (older mocks) just hides the switch
    Promise.resolve()
      .then(() => projectionsAPI.getSanity())
      .then((res) => !cancelled && setStatus(res?.data ?? null))
      .catch(() => !cancelled && setStatus(null));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status) return null;

  const active = Object.entries(status.components || {}).filter(([, on]) => on).map(([k]) => COMPONENT_LABELS[k] || k);
  const hint = `Adjusts RotoWire projections before every optimizer, portfolio, chat and radar read: ${
    active.length ? active.join(' + ') : 'no components enabled'
  }. Hover a marked projection for RotoWire vs adjusted. Server-wide; resets to ${status.default ? 'on' : 'off'} on restart.`;

  const toggle = async (enabled) => {
    setBusy(true);
    try {
      const res = await projectionsAPI.setSanity({ enabled });
      setStatus(res.data);
      onChange?.(res.data.enabled);
    } catch {
      // keep the current state; the next load shows what the server has
    } finally {
      setBusy(false);
    }
  };

  return (
    <Tooltip content={hint}>
      <span className={className}>
        <Toggle size="sm" checked={status.enabled} disabled={busy} onChange={toggle} label="Projection sanity adjustments" />
      </span>
    </Tooltip>
  );
}
