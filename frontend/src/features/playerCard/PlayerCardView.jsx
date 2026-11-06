import { useState } from 'react';
import { Badge, Button, IconBan, IconCheck, IconChat, IconLock, IconAlert, IconX, Tooltip, cn } from '../../components/ui';
import InjuryRiskBadge from '../playerPool/InjuryRiskBadge';
import {
  ConfidenceRing,
  GameLogChart,
  LeverageMap,
  MatchupBars,
  MinutesBand,
  MinutesChart,
  OutcomeRange,
  RoleRadar,
  ScoreMeter,
  TrackRecordChart,
} from './charts';
import {
  SOURCE_LABELS,
  VERDICT_TONE,
  deltaTone,
  fmt,
  fmtPct,
  fmtSalary,
  fmtSigned,
  gameTime,
  initials,
  isNum,
  teamColor,
} from './cardFormat';

const TONE_TEXT = { positive: 'text-positive', negative: 'text-negative', caution: 'text-caution', info: 'text-info', neutral: 'text-fg', accent: 'text-accent' };

function Section({ title, aside, children, className }) {
  return (
    <section className={cn('rounded-lg border border-line bg-surface p-3 sm:p-4', className)}>
      <header className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">{title}</h3>
        {aside && <div className="text-2xs text-fg-subtle">{aside}</div>}
      </header>
      {children}
    </section>
  );
}

function Stat({ label, value, sub, tone }) {
  return (
    <div className="min-w-0 rounded-md bg-surface-sunken/60 px-2.5 py-2">
      <div className="truncate text-[10px] font-medium uppercase tracking-wider text-fg-subtle">{label}</div>
      <div className={cn('num truncate text-base font-semibold leading-tight', TONE_TEXT[tone] ?? 'text-fg')}>{value}</div>
      {sub && <div className="num truncate text-[10px] text-fg-muted">{sub}</div>}
    </div>
  );
}

function Headshot({ name, src, color }) {
  const [failed, setFailed] = useState(false);
  const ring = { boxShadow: `0 0 0 3px ${color}55, 0 8px 20px -6px ${color}aa` };
  if (src && !failed) {
    return <img src={src} alt="" onError={() => setFailed(true)} style={ring} className="h-16 w-16 shrink-0 rounded-full border-2 border-surface bg-surface-sunken object-cover sm:h-20 sm:w-20" />;
  }
  return (
    <div aria-hidden="true" style={{ ...ring, background: `${color}33` }} className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border-2 border-surface text-lg font-bold text-fg sm:h-20 sm:w-20">
      {initials(name)}
    </div>
  );
}

export function VerdictPill({ label, verdict }) {
  const tone = VERDICT_TONE[verdict.verdict] ?? 'accent';
  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-1.5"
      style={{ borderColor: `rgb(var(--${tone}) / 0.4)`, background: `rgb(var(--${tone}) / 0.1)` }}
      aria-label={`${label}: ${verdict.verdict}, confidence ${verdict.confidence}`}
    >
      <div className="relative">
        <ConfidenceRing value={verdict.confidence} tone={tone} />
        <span className="num absolute inset-0 flex items-center justify-center text-[10px] font-bold text-fg">{verdict.confidence}</span>
      </div>
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">{label}</div>
        <div className={cn('truncate text-sm font-bold', TONE_TEXT[tone])}>{verdict.verdict}</div>
      </div>
    </div>
  );
}

function Header({ card, onClose }) {
  const p = card.player;
  const color = teamColor(p.team);
  const riskPlayer = { ...card.projection, injury_status: p.injury_status };
  const time = gameTime(p.game_time);
  return (
    <div className="relative overflow-hidden border-b border-line">
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{ background: `radial-gradient(120% 140% at 0% 0%, ${color}66 0%, ${color}22 40%, transparent 75%)` }}
      />
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-1" style={{ background: color }} />
      <div className="relative flex items-start gap-3 px-4 pb-3 pt-4 sm:gap-4 sm:px-5">
        <Headshot name={p.name} src={p.headshot} color={color} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-bold leading-tight text-fg sm:text-xl">{p.name}</h2>
            <InjuryRiskBadge player={riskPlayer} size="md" />
          </div>
          <p className="mt-0.5 truncate text-xs text-fg-muted">
            <span className="font-semibold text-fg">{String(p.position || '').split(',').filter((x) => x !== 'UTIL').join('/')}</span>
            {' · '}
            {p.team} {p.is_home === false ? '@' : 'vs'} {p.opponent}
            {time && <> · {time}</>}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {p.archetype_label && <Badge size="sm" tone="accent">{p.archetype_label}</Badge>}
            {p.secondary_label && <Badge size="sm" tone="neutral">{p.secondary_label}</Badge>}
            {card.slate.isBacktest && <Badge size="sm" tone="caution">{card.slate.label}</Badge>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close player card"
            className="rounded-full p-1.5 text-fg-muted hover:bg-surface-raised hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <IconX size={18} />
          </button>
          <div className="num text-right text-lg font-bold text-fg sm:text-xl">{fmtSalary(p.salary)}</div>
        </div>
      </div>
      <div className="relative flex gap-2 px-4 pb-4 sm:px-5">
        <VerdictPill label="Cash" verdict={card.verdict.cash} />
        <VerdictPill label="GPP" verdict={card.verdict.gpp} />
      </div>
    </div>
  );
}

function ActualStrip({ card }) {
  const a = card.actual;
  if (!a) return null;
  if (a.points == null) {
    return <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2 text-xs text-fg-muted">Result pending - no box score for {card.slate.slateDate} yet.</div>;
  }
  const beat = a.vs_projection >= 0;
  return (
    <div className={cn('rounded-lg border px-3 py-2.5', beat ? 'border-positive/40 bg-positive-soft' : 'border-negative/40 bg-negative-soft')}>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">What actually happened</div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="num text-2xl font-bold text-fg">{fmt(a.points)} <span className="text-xs font-medium text-fg-muted">DK</span></span>
        <span className="num text-sm text-fg">{fmt(a.minutes, 0)} min</span>
        <span className="num text-sm text-fg">{fmt(a.value, 2)}x {a.hit5x ? <Badge size="sm" tone="positive">5x hit</Badge> : <Badge size="sm" tone="negative">missed 5x</Badge>}</span>
        <span className={cn('num text-sm font-semibold', beat ? 'text-positive' : 'text-negative')}>{fmtSigned(a.vs_projection)} vs proj</span>
        {a.status && a.status !== 'PLAYED' && <Badge tone="negative">{a.status}</Badge>}
      </div>
      <div className="num mt-1 text-2xs text-fg-muted">
        vs RotoWire {fmtSigned(a.vs_rotowire)} · vs ours {fmtSigned(a.vs_ours)}
      </div>
    </div>
  );
}

function VerdictSection({ card, onAskAi }) {
  const v = card.verdict;
  return (
    <Section
      title="The take"
      aside={onAskAi && (
        <Button size="xs" variant="outline" leftIcon={<IconChat size={12} />} onClick={onAskAi}>
          Ask AI
        </Button>
      )}
    >
      <p className="text-sm leading-relaxed text-fg">{v.blurb}</p>
      {v.slate?.changed && v.slate.note && (
        <p data-testid="verdict-slate-note" className="mt-2 rounded border border-line bg-surface-sunken px-2 py-1 text-2xs text-fg-muted">
          <span className="font-semibold text-fg">Slate size changed the call.</span> {v.slate.note}
          {v.slate.legacy && <> (any slate size: cash {v.slate.legacy.cash}, GPP {v.slate.legacy.gpp})</>}
        </p>
      )}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-positive">Reasons for</h4>
          {v.reasonsFor.length ? (
            <ul className="space-y-1">
              {v.reasonsFor.map((r) => (
                <li key={r} className="flex gap-1.5 text-xs text-fg"><IconCheck size={13} className="mt-0.5 shrink-0 text-positive" />{r}</li>
              ))}
            </ul>
          ) : <p className="text-xs text-fg-subtle">Nothing stands out.</p>}
        </div>
        <div>
          <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-negative">Reasons against</h4>
          {v.reasonsAgainst.length ? (
            <ul className="space-y-1">
              {v.reasonsAgainst.map((r) => (
                <li key={r} className="flex gap-1.5 text-xs text-fg"><IconAlert size={13} className="mt-0.5 shrink-0 text-negative" />{r}</li>
              ))}
            </ul>
          ) : <p className="text-xs text-fg-subtle">No red flags.</p>}
        </div>
      </div>
      {v.notes?.length > 0 && <p className="mt-2 border-t border-line pt-2 text-2xs text-fg-muted">{v.notes.join(' ')}</p>}
    </Section>
  );
}

function SourceChips({ projection }) {
  const chips = [
    ['rotowire', projection.rotowire],
    ['ours', projection.ours],
    ['blend', projection.blend],
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map(([key, value]) => {
        const active = projection.source === key;
        return (
          <span
            key={key}
            className={cn(
              'num inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
              active ? 'border-accent bg-accent-soft font-semibold text-accent' : 'border-line bg-surface-sunken text-fg-muted',
            )}
            aria-current={active ? 'true' : undefined}
          >
            {SOURCE_LABELS[key]} <span className="text-fg">{fmt(value)}</span>
          </span>
        );
      })}
      {projection.fade && (
        <Tooltip content={projection.fade.text}>
          <span tabIndex={0}>
            <Badge tone="negative">
              FADE {fmt(projection.fade.points_diff)}
              {isNum(projection.fade.hit_rate) && ` · ${fmtPct(projection.fade.hit_rate)} hit`}
            </Badge>
          </span>
        </Tooltip>
      )}
      {!projection.fade && isNum(projection.ours_diff) && projection.ours_diff >= 4 && (
        <Tooltip content="Ours higher than RotoWire has had no proven edge in our backtests">
          <span tabIndex={0}><Badge tone="neutral">Ours +{fmt(projection.ours_diff)} (unproven)</Badge></span>
        </Tooltip>
      )}
    </div>
  );
}

function ProjectionSection({ card }) {
  const pr = card.projection;
  return (
    <Section title="Projection" aside={pr.fallback ? 'Own model unavailable - RotoWire shown' : `Active: ${SOURCE_LABELS[pr.source] ?? pr.source}`}>
      <SourceChips projection={pr} />
      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-[1fr_11rem]">
        <OutcomeRange projection={pr} actual={card.actual?.points} />
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">Ownership vs value</div>
          <LeverageMap value={pr.value} ownership={pr.rostership} />
        </div>
      </div>
    </Section>
  );
}

const UPSIDE_TONE = (score) => (score >= 50 ? 'positive' : score >= 25 ? 'info' : 'fg-subtle');

function MinutesUpsideSection({ card }) {
  const u = card.projection.minutes_upside;
  if (!u) return null;
  const c = u.correction;
  return (
    <Section title="Minutes upside" aside={isNum(u.gap) ? `RotoWire ${fmtSigned(u.gap)} min vs ours` : null}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[11rem_1fr]">
        <div className="space-y-2">
          <ScoreMeter label="Upside score" value={u.score} tone={UPSIDE_TONE(u.score)} />
          {u.reasons?.length > 0 && (
            <ul className="flex flex-wrap gap-1" aria-label="Minutes upside reasons">
              {u.reasons.map((r) => (
                <li key={r}><Badge size="sm" tone={u.score >= 50 ? 'positive' : 'neutral'}>{r}</Badge></li>
              ))}
            </ul>
          )}
        </div>
        <MinutesBand upside={u} actual={card.actual?.minutes} />
      </div>
      <p className="mt-2 text-2xs text-fg-muted">
        {c
          ? <>Our minutes moved <span className="num font-semibold text-fg">{Math.round(c.factor * 100)}%</span> of the way to RotoWire ({c.bucket}, {c.band}): on 14 saved slates the actual landed between the two.</>
          : 'When RotoWire is 3+ minutes above us the actual has landed about two thirds of the way to RotoWire.'}
        {' '}Score 50+: 28% beat our minutes by 8+ on the saved slates (8% overall).
      </p>
    </Section>
  );
}

function FormSection({ card }) {
  const f = card.form;
  const c = f.consistency;
  const t = f.trend;
  return (
    <Section
      title="Recent form"
      aside={f.log.length ? `Last ${f.log.length} games${t.baseline === 'last_season' ? ' · baseline last season' : ''}` : null}
    >
      <div className="mb-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
        <Stat label="L5" value={fmt(f.l5?.fp)} sub={`${fmt(f.l5?.minutes)} min`} />
        <Stat label="L10" value={fmt(f.l10?.fp)} sub={`${fmt(f.l10?.minutes)} min`} />
        <Stat label="Season" value={fmt(f.season?.fp)} sub={f.season ? `${f.season.games} gp` : 'no games'} />
        <Stat label="FPPM L5" value={fmt(f.l5?.fppm, 2)} sub={isNum(t.fppm_delta_l5) ? `${fmtSigned(t.fppm_delta_l5, 2)} vs base` : null} tone={deltaTone(t.fppm_delta_l5, 0.05)} />
        <Stat label="Std dev" value={fmt(c.std_dev)} sub={isNum(c.floor_game) ? `${fmt(c.floor_game, 0)}–${fmt(c.ceiling_game, 0)}` : null} />
        <Stat label="5x hit" value={c.priced_games ? fmtPct(c.hit_rate) : '–'} sub={c.priced_games ? `${c.hit_games}/${c.priced_games} priced` : 'no salaries'} tone={c.hit_rate >= 0.5 ? 'positive' : c.priced_games ? 'negative' : undefined} />
      </div>
      <GameLogChart log={f.log} projection={card.projection.active} l5={f.l5?.fp} season={(f.season ?? f.lastSeason)?.fp} />
      <div className="mt-4">
        <div className="mb-1 flex items-baseline justify-between">
          <h4 className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">Minutes</h4>
          {isNum(t.minutes_delta_l5) && (
            <span className={cn('num text-2xs font-semibold', TONE_TEXT[deltaTone(t.minutes_delta_l5, 1.5)])}>
              {fmtSigned(t.minutes_delta_l5)} min L5 vs {t.baseline === 'last_season' ? 'last season' : 'season'}
            </span>
          )}
        </div>
        <MinutesChart log={f.log} oursMinutes={card.projection.ours_minutes} rotowireMinutes={card.projection.rotowire_minutes} />
      </div>
    </Section>
  );
}

const ordinal = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
function defenseRank(rank, teams) {
  if (!rank || !teams) return '';
  return rank <= teams / 2 ? `${ordinal(rank)} softest` : `${ordinal(teams - rank + 1)} stingiest`;
}

function rankLabel(rank, teams) {
  if (!rank || !teams) return null;
  return `#${rank}/${teams}`;
}

function MatchupSection({ card }) {
  const m = card.matchup;
  const env = card.environment;
  const opp = env.opponent;
  const mine = env.team;
  return (
    <Section
      title={m ? `vs ${m.opponent}: ${m.label}${m.grouping === 'archetype' ? 's' : ''}` : 'Matchup'}
      aside={m ? `${m.season} · ${m.games} games · tiebreaker only` : null}
    >
      <div className="mb-3 flex flex-wrap gap-1.5">
        {m?.grade && <Badge tone={m.grade <= 'B' ? 'positive' : m.grade >= 'D' ? 'negative' : 'neutral'}>Grade {m.grade} · {rankLabel(m.rank, m.teams)}</Badge>}
        {opp && (
          <Tooltip content={`${card.player.opponent} allows ${fmt(opp.def_eff)} points per 100 possessions (rank ${opp.def_rank} of ${opp.teams}, 1 = softest)`}>
            <span tabIndex={0}>
              <Badge tone={opp.def_rank <= 10 ? 'positive' : opp.def_rank > 20 ? 'negative' : 'neutral'}>
                {card.player.opponent} D {fmt(opp.def_eff)} · {defenseRank(opp.def_rank, opp.teams)}
              </Badge>
            </span>
          </Tooltip>
        )}
        {mine && <Badge tone="neutral">{card.player.team} pace {fmt(mine.pace)} ({rankLabel(mine.pace_rank, mine.teams)})</Badge>}
        {opp && <Badge tone="neutral">{card.player.opponent} pace {fmt(opp.pace)} ({rankLabel(opp.pace_rank, opp.teams)})</Badge>}
      </div>
      <div className="space-y-3">
        <MatchupBars stats={m?.stats} fp={m?.fp_delta} />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Implied" value={fmt(env.implied_total)} sub={isNum(env.opp_implied_total) ? `opp ${fmt(env.opp_implied_total)}` : null} />
          <Stat label="Spread" value={fmtSigned(env.spread)} sub={env.blowout ? 'blowout risk' : null} tone={env.blowout ? 'caution' : undefined} />
          <Stat label="Total" value={fmt(env.over_under)} />
          <Stat label="Adj. edge" value={fmtSigned(m?.adjusted_edge)} sub={m?.edge_flags?.length ? m.edge_flags.join(', ') : null} tone={deltaTone(m?.adjusted_edge)} />
        </div>
      </div>
    </Section>
  );
}

function RoleSection({ card }) {
  const r = card.role;
  return (
    <Section
      title="Role"
      aside={[
        r.started_last_game === true ? 'Started last game' : r.started_last_game === false ? 'Came off the bench' : null,
        isNum(r.starts_l5) ? `${r.starts_l5}/5 starts` : null,
        r.starter_change === 'to_starter' ? 'new starter' : r.starter_change === 'to_bench' ? 'moved to bench' : null,
      ].filter(Boolean).join(' · ')}
    >
      <RoleRadar
        current={r.current}
        previous={r.previous}
        average={r.archetype_average}
        labels={{ current: r.season, previous: r.lastSeason, average: `${card.player.archetype_label ?? 'Archetype'} avg` }}
      />
      <div className="mt-2 grid grid-cols-3 gap-2">
        <Stat label="Min / game" value={fmt(r.current?.minutes_pg)} sub={r.previous ? `last ${fmt(r.previous.minutes_pg)}` : null} />
        <Stat label="Usage" value={fmtPct(r.current?.usg_pct, 1)} sub={r.previous ? `last ${fmtPct(r.previous.usg_pct, 1)}` : null} tone={deltaTone(((r.current?.usg_pct ?? 0) - (r.previous?.usg_pct ?? r.current?.usg_pct ?? 0)) * 100, 1.5)} />
        <Stat label="DK FPPM" value={fmt(r.current?.dk_fppm, 2)} sub={r.previous ? `last ${fmt(r.previous.dk_fppm, 2)}` : null} />
      </div>
    </Section>
  );
}

function ContextSection({ card }) {
  const ctx = card.context;
  const split = ctx.split;
  return (
    <Section title="Context">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">Teammates out</h4>
          {ctx.teammates_out.length ? (
            <ul className="flex flex-wrap gap-1">
              {ctx.teammates_out.map((t) => (
                <li key={t.name}><Badge tone="negative">{t.name}{t.salary ? ` · ${fmtSalary(t.salary)}` : ''}</Badge></li>
              ))}
            </ul>
          ) : <p className="text-xs text-fg-subtle">Full strength.</p>}
          {split && (split.min_delta != null || split.usg_delta != null) && (
            <div className="mt-2 rounded-md bg-surface-sunken/60 px-2.5 py-2 text-xs">
              <div className="text-fg-muted">Without {split.out_names.join(', ') || 'them'}{split.games_without ? ` (${split.games_without} games${split.sample ? `, ${split.sample}` : ''})` : ''}:</div>
              <div className="num mt-0.5 flex gap-3 font-semibold">
                <span className={TONE_TEXT[deltaTone(split.min_delta, 1)]}>{fmtSigned(split.min_delta)} min</span>
                <span className={TONE_TEXT[deltaTone((split.usg_delta ?? 0) * 100, 1)]}>{fmtSigned((split.usg_delta ?? 0) * 100)} usg pts</span>
              </div>
            </div>
          )}
        </div>
        <div className="space-y-2">
          <h4 className="text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">Opportunity Radar</h4>
          {ctx.radar ? (
            <>
              <ScoreMeter label="Cash" value={ctx.radar.cash_score} tone="chart-1" />
              <ScoreMeter label="GPP" value={ctx.radar.gpp_score} tone="chart-2" />
              {ctx.radar.reason && <p className="text-2xs text-fg-muted">{ctx.radar.reason}</p>}
              <p className="text-2xs text-fg-subtle">
                {ctx.radar.back_to_back ? 'Back-to-back tonight. ' : isNum(ctx.radar.rest_days) ? `${ctx.radar.rest_days} day(s) rest. ` : ''}
                {ctx.radar.salary_lag ? 'Salary lagging his production.' : ''}
              </p>
            </>
          ) : <p className="text-xs text-fg-subtle">Not scored.</p>}
        </div>
      </div>
    </Section>
  );
}

function TrackSection({ card }) {
  const t = card.trackRecord;
  return (
    <Section title="Projection track record" aside={t.n ? `${t.n} past slates${t.dnp ? ` · ${t.dnp} DNP` : ''}` : null}>
      {t.n ? (
        <>
          <div className="mb-2 grid grid-cols-3 gap-2">
            <Stat label="Bias" value={fmtSigned(t.bias)} sub={t.bias > 0 ? 'beats proj' : 'misses proj'} tone={deltaTone(t.bias, 1.5)} />
            <Stat label="Avg miss" value={fmt(t.mae)} sub="MAE" />
            <Stat label="Beat rate" value={fmtPct(t.beat_rate)} />
          </div>
          <TrackRecordChart recent={t.recent} />
        </>
      ) : <p className="text-xs text-fg-subtle">No saved slates with a result for him yet.</p>}
    </Section>
  );
}

function Controls({ controls }) {
  const [exposure, setExposure] = useState(null);
  if (!controls?.available) return null;
  const { state, set, error, saving } = controls;
  const shown = exposure ?? (state.maxExposure ?? '');
  const commit = () => {
    if (exposure === null) return;
    const v = exposure === '' ? null : Math.max(0, Math.min(100, Number(exposure)));
    set({ maxExposure: Number.isFinite(v) ? v : null });
    setExposure(null);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant={state.lock ? 'positive' : 'outline'} aria-pressed={state.lock} leftIcon={<IconLock size={13} />} onClick={() => set({ lock: !state.lock })}>
        {state.lock ? 'Locked' : 'Lock'}
      </Button>
      <Button size="sm" variant={state.exclude ? 'danger' : 'outline'} aria-pressed={state.exclude} leftIcon={<IconBan size={13} />} onClick={() => set({ exclude: !state.exclude })}>
        {state.exclude ? 'Excluded' : 'Exclude'}
      </Button>
      {controls.exposure && (
        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
          Max exp
          <input
            type="number"
            min={0}
            max={100}
            step={5}
            inputMode="numeric"
            aria-label="Max exposure %"
            placeholder="100"
            value={shown}
            onChange={(e) => setExposure(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
            className="num h-7 w-16 rounded border border-line bg-surface-sunken px-2 text-right text-xs text-fg focus:outline-none focus:ring-2 focus:ring-accent/50"
          />
          %
        </label>
      )}
      {saving && <span className="text-2xs text-fg-subtle">Saving…</span>}
      {error && <span className="text-2xs text-negative">{error}</span>}
    </div>
  );
}

/** The whole card for a loaded `card` payload. */
export default function PlayerCardView({ card, onClose, controls, onAskAi }) {
  const pr = card.projection;
  return (
    <div className="flex min-h-full flex-col">
      <Header card={card} onClose={onClose} />
      <div className="flex-1 space-y-3 bg-canvas p-3 sm:p-4">
        <ActualStrip card={card} />
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          <Stat label={SOURCE_LABELS[pr.source] ?? 'Proj'} value={fmt(pr.active)} sub="projection" tone="accent" />
          <Stat label="Value" value={`${fmt(pr.value, 2)}x`} sub="pts / $1K" tone={pr.value >= 5 ? 'positive' : pr.value < 4.5 ? 'negative' : undefined} />
          <Stat label="Own" value={`${fmt(pr.rostership)}%`} sub={isNum(pr.leverage) ? `lev ${fmt(pr.leverage)}` : null} />
          <Stat label="Ceiling" value={fmt(pr.blend_p90 ?? pr.p90 ?? pr.ceiling)} sub={isNum(pr.p_boom) ? `boom ${fmtPct(pr.blend_p_boom ?? pr.p_boom)}` : null} />
          <Stat label="Minutes" value={fmt(pr.ours_minutes ?? pr.rotowire_minutes)} sub={`RW ${fmt(pr.rotowire_minutes)}`} />
          <Stat label="Play %" value={fmtPct(pr.p_play)} tone={pr.p_play != null && pr.p_play < 0.85 ? 'caution' : undefined} />
        </div>
        <VerdictSection card={card} onAskAi={onAskAi} />
        <ProjectionSection card={card} />
        <MinutesUpsideSection card={card} />
        <FormSection card={card} />
        <div className="grid gap-3 lg:grid-cols-2">
          <MatchupSection card={card} />
          <RoleSection card={card} />
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <ContextSection card={card} />
          <TrackSection card={card} />
        </div>
        {card.meta?.warnings?.length > 0 && (
          <p className="text-[10px] text-fg-subtle">Some data unavailable: {card.meta.warnings.map((w) => w.split(':')[0]).join(', ')}.</p>
        )}
      </div>
      {controls?.available && (
        <footer className="sticky bottom-0 z-10 border-t border-line bg-surface/95 px-4 py-2.5 backdrop-blur">
          <Controls controls={controls} />
        </footer>
      )}
    </div>
  );
}

/** Loading skeleton in the card's shape. */
export function PlayerCardSkeleton({ name, headshot, onClose }) {
  return (
    <div className="flex min-h-full flex-col" aria-busy="true" aria-label={`Loading ${name ?? 'player'} card`}>
      <div className="flex items-start gap-3 border-b border-line px-4 pb-4 pt-4 sm:px-5">
        {headshot ? <img src={headshot} alt="" className="h-16 w-16 rounded-full bg-surface-sunken object-cover sm:h-20 sm:w-20" /> : <div className="h-16 w-16 animate-pulse rounded-full bg-surface-sunken sm:h-20 sm:w-20" />}
        <div className="flex-1 space-y-2 pt-1">
          {name ? <h2 className="text-lg font-bold text-fg">{name}</h2> : <div className="h-5 w-40 animate-pulse rounded bg-surface-sunken" />}
          <div className="h-3 w-52 animate-pulse rounded bg-surface-sunken" />
          <div className="flex gap-2 pt-2">
            <div className="h-11 flex-1 animate-pulse rounded-lg bg-surface-sunken" />
            <div className="h-11 flex-1 animate-pulse rounded-lg bg-surface-sunken" />
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close player card" className="rounded-full p-1.5 text-fg-muted hover:bg-surface-raised">
          <IconX size={18} />
        </button>
      </div>
      <div className="space-y-3 p-4">
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => <div key={i} className="h-14 animate-pulse rounded-md bg-surface-sunken" />)}
        </div>
        {[24, 40, 52, 36].map((h, i) => <div key={i} className="animate-pulse rounded-lg bg-surface-sunken" style={{ height: `${h * 4}px` }} />)}
      </div>
    </div>
  );
}
