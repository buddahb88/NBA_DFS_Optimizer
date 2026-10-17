import { useEffect, useMemo, useState } from 'react';
import { portfolioAPI } from '../../services/api';
import { Button, Input, Modal, Select, Spinner } from '../../components/ui';
import {
  buildPortfolioRequest,
  estimatePrizePool,
  formFromPreset,
  money,
  payoutCurveLabel,
  validatePortfolioForm,
} from './portfolioMath';

const DEFAULT_PRESET = '20-max';

/**
 * Contest + sim settings for a portfolio build. Locks, exclusions and min salary
 * come from the Lineup Studio; onSubmit receives the POST /api/portfolio/build body.
 */
export default function PortfolioBuilderModal({ open, onClose, onSubmit, slateId, locked, excluded, minSalary }) {
  const [presets, setPresets] = useState({ status: 'idle' });
  const [form, setForm] = useState(null);
  const [touched, setTouched] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!open || presets.status === 'ready') return undefined;
    let cancelled = false;
    setPresets({ status: 'loading' });
    portfolioAPI
      .getPresets()
      .then((res) => {
        if (cancelled) return;
        const { presets: list, limits } = res.data;
        setPresets({ status: 'ready', list, limits });
        setForm((f) => f || formFromPreset(list, list[DEFAULT_PRESET] ? DEFAULT_PRESET : Object.keys(list)[0], limits));
      })
      .catch((err) => !cancelled && setPresets({ status: 'error', error: err.response?.data?.error || err.message }));
    return () => {
      cancelled = true;
    };
    // presets.status is deliberately left out: only (re)fetch on open or retry
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reload]);

  const errors = useMemo(() => (form ? validatePortfolioForm(form, presets.limits) : {}), [form, presets.limits]);
  const valid = form && Object.keys(errors).length === 0;
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const err = (k) => (touched || form?.[k] === '' ? errors[k] : undefined);

  const submit = (e) => {
    e.preventDefault();
    setTouched(true);
    if (!valid) return;
    onSubmit(buildPortfolioRequest(form, { slateId, presets: presets.list, locked, excluded, minSalary }));
  };

  const presetOptions = presets.list
    ? [
        ...Object.entries(presets.list).map(([value, p]) => ({
          value,
          label: `${p.label} · ${Number(p.contestSize).toLocaleString()} entries · ${money(p.entryFee)}`,
        })),
        ...(form?.contestPreset === 'custom' ? [{ value: 'custom', label: 'Custom' }] : []),
      ]
    : [];
  const curve = presets.list?.[form?.payoutPreset];
  const prizePool = form && curve && !errors.contestSize && !errors.entryFee
    ? estimatePrizePool(Number(form.contestSize), Number(form.entryFee), curve.rake)
    : null;

  // Editing a contest number turns the preset into a custom contest
  const setContest = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value, contestPreset: 'custom' }));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Simulate & build portfolio"
      description="Simulates the contest against a synthetic field and picks the entries with the best combined ROI."
      size="md"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" type="submit" form="portfolio-form" disabled={!form || (touched && !valid)}>
            Run simulation
          </Button>
        </>
      }
    >
      {presets.status === 'loading' && !form && (
        <div className="flex justify-center py-10">
          <Spinner size="md" />
        </div>
      )}
      {presets.status === 'error' && !form && (
        <div className="flex flex-col items-start gap-2 py-4 text-sm">
          <p className="text-negative">Couldn&apos;t load contest presets: {presets.error}</p>
          <Button size="sm" onClick={() => setReload((r) => r + 1)}>
            Retry
          </Button>
        </div>
      )}
      {form && (
        <form id="portfolio-form" onSubmit={submit} noValidate className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">Contest</legend>
            <Select
              label="Contest preset"
              value={form.contestPreset}
              options={presetOptions}
              onChange={(e) => e.target.value !== 'custom' && setForm(formFromPreset(presets.list, e.target.value, presets.limits))}
            />
            <div className="grid grid-cols-3 gap-3">
              <Input label="Contest size" numeric inputMode="numeric" value={form.contestSize} onChange={setContest('contestSize')} error={err('contestSize')} />
              <Input label="Entry fee ($)" numeric inputMode="decimal" value={form.entryFee} onChange={setContest('entryFee')} error={err('entryFee')} />
              <Input label="Max entries" numeric inputMode="numeric" value={form.maxEntries} onChange={setContest('maxEntries')} error={err('maxEntries')} />
            </div>
            <Select
              label="Payout structure"
              value={form.payoutPreset}
              options={Object.entries(presets.list).map(([value, p]) => ({ value, label: payoutCurveLabel(p) }))}
              onChange={(e) => setForm((f) => ({ ...f, payoutPreset: e.target.value, contestPreset: 'custom' }))}
            />
            {prizePool != null && (
              <p className="text-2xs text-fg-subtle">
                Prize pool ≈ <span className="num text-fg-muted">{money(Math.round(prizePool))}</span> after {Math.round(curve.rake * 100)}% rake
              </p>
            )}
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">Simulation</legend>
            <div className="grid grid-cols-3 gap-3">
              <Input label="Lineups to enter" numeric inputMode="numeric" value={form.numLineups} onChange={set('numLineups')} error={err('numLineups')} />
              <Input
                label="Candidate pool"
                numeric
                inputMode="numeric"
                value={form.poolSize}
                onChange={set('poolSize')}
                error={err('poolSize')}
                hint={err('poolSize') ? undefined : 'Lineups to choose from'}
              />
              <Input
                label="Iterations"
                numeric
                inputMode="numeric"
                value={form.iterations}
                onChange={set('iterations')}
                error={err('iterations')}
                hint={err('iterations') ? undefined : 'Simulated contests'}
              />
            </div>
            <p className="text-2xs text-fg-subtle">
              {locked.size + excluded.size > 0
                ? `Uses your ${locked.size} locked and ${excluded.size} excluded player${locked.size + excluded.size === 1 ? '' : 's'}`
                : 'No locks or exclusions'}
              {Number.isFinite(minSalary) && ` and a ${money(minSalary)} min salary`} from the optimizer settings. Bigger pools and more
              iterations are more accurate but slower.
            </p>
          </fieldset>
        </form>
      )}
    </Modal>
  );
}
