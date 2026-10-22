import { useEffect, useId, useState } from 'react';
import {
  IconAlert,
  IconBolt,
  IconChart,
  IconCheck,
  IconChevronDown,
  IconCpu,
  IconGrid,
  IconInfo,
  IconList,
  IconSearch,
  IconUsers,
  IconWrench,
  IconX,
  Spinner,
  cn,
} from '../../components/ui';
import {
  ORCHESTRATOR,
  agentLabel,
  formatDuration,
  stepDuration,
  summarizeTimeline,
  timelineCounts,
  timelineWarnings,
  toolLabel,
} from './timelineSteps';

const AGENT_ICONS = { orchestrator: IconBolt, research: IconSearch, analyst: IconChart, optimizer: IconCpu };

const TOOL_ICONS = [
  [/lineup/, IconUsers],
  [/sql|query/, IconList],
  [/history|streak|projection_results|summary/, IconChart],
  [/matchup|defense|environment/, IconGrid],
  [/usage|missing|roster_context/, IconInfo],
  [/search|pool|roster|player|slate/, IconSearch],
];

const toolIcon = (name = '') => TOOL_ICONS.find(([re]) => re.test(name))?.[1] || IconWrench;

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50';

// Re-renders every `ms` while active so the running clock ticks
function useNow(active, ms = 250) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

export function AgentAvatar({ agent, size = 'md' }) {
  const Icon = AGENT_ICONS[agent] || IconUsers;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'agent-tone flex shrink-0 items-center justify-center rounded-md bg-[rgb(var(--agent)/0.14)] text-[rgb(var(--agent))] ring-1 ring-inset ring-[rgb(var(--agent)/0.35)]',
        AGENT_ICONS[agent] && `agent-tone-${agent}`,
        size === 'sm' ? 'h-5 w-5' : 'h-6 w-6',
      )}
    >
      <Icon size={size === 'sm' ? 11 : 13} />
    </span>
  );
}

function StepStatus({ step }) {
  if (step.status === 'running') return <Spinner size="xs" label="Running" className="motion-reduce:animate-none" />;
  const duration = formatDuration(stepDuration(step));
  return (
    <span className="flex items-center gap-1.5 text-2xs tabular-nums text-fg-subtle">
      {duration && <span>{duration}</span>}
      {step.status === 'success' && <IconCheck size={12} className="text-positive" aria-label="Done" role="img" />}
      {step.status === 'error' && <IconX size={12} className="text-negative" aria-label="Failed" role="img" />}
      {step.status === 'interrupted' && <IconAlert size={12} className="text-caution" aria-label="Interrupted" role="img" />}
    </span>
  );
}

function AgentStep({ step }) {
  return (
    <div className="flex items-center gap-2.5 py-1">
      <AgentAvatar agent={step.agent} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-fg">{agentLabel(step.agent)}</span>
          {step.stepLimitHit && (
            <span className="rounded border border-caution/30 bg-caution-soft px-1 text-2xs font-medium leading-4 text-caution">Step limit</span>
          )}
        </div>
        {step.task && (
          <p className="truncate text-2xs text-fg-muted" title={step.task}>
            {step.task}
          </p>
        )}
      </div>
      <StepStatus step={step} />
    </div>
  );
}

function ToolStep({ step }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const label = toolLabel(step.tool);
  const Icon = toolIcon(step.tool);
  const hasArgs = step.args && Object.keys(step.args).length > 0;
  const nested = step.agent && step.agent !== ORCHESTRATOR;

  return (
    <div className={cn(nested && `agent-tone agent-tone-${step.agent} ml-3 border-l-2 border-[rgb(var(--agent)/0.35)] pl-3`)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={detailsId}
        className={cn('-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded px-1 py-1 text-left transition-colors hover:bg-surface-raised', focusRing)}
      >
        <Icon size={13} className={cn('shrink-0', step.status === 'error' ? 'text-negative' : 'text-fg-subtle')} />
        <span className={cn('min-w-0 flex-1 truncate text-xs', step.status === 'running' ? 'text-fg' : 'text-fg-muted')}>{label}</span>
        <StepStatus step={step} />
        <IconChevronDown size={12} className={cn('shrink-0 text-fg-subtle transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
      </button>
      {open && (
        <div id={detailsId} role="region" aria-label={`${label} details`} className="mb-1.5 mt-1 space-y-1.5 animate-fade-in motion-reduce:animate-none">
          <div className="font-mono text-2xs text-fg-subtle">{step.tool}</div>
          {hasArgs && (
            <pre className="scrollbar-thin max-h-32 overflow-auto rounded border border-line bg-surface-sunken p-2 font-mono text-2xs text-fg-muted">
              {JSON.stringify(step.args, null, 2)}
            </pre>
          )}
          {step.error ? (
            <p className="rounded border border-negative/30 bg-negative-soft px-2 py-1 text-2xs text-negative">{step.error}</p>
          ) : (
            step.preview && (
              <pre className="scrollbar-thin max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-surface-sunken p-2 font-mono text-2xs text-fg-muted">
                {step.preview}
              </pre>
            )
          )}
        </div>
      )}
    </div>
  );
}

function ThoughtStep({ step }) {
  return <p className="py-0.5 pl-1 text-2xs italic text-fg-subtle">{step.text}</p>;
}

function Warnings({ warnings }) {
  if (!warnings.length) return null;
  return (
    <div role="note" aria-label="Agent warnings" className="mt-2 flex gap-2 rounded-md border border-caution/30 bg-caution-soft px-3 py-2 text-xs text-fg">
      <IconAlert size={14} className="mt-0.5 shrink-0 text-caution" />
      <ul className="space-y-0.5">
        {warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Live agent activity: an expanded, animating step list while streaming; a summary chip
 * ("Used 4 tools across 2 agents · 3.2s") once done. With showReasoning off only the chip shows.
 * Step-limit hits, tool errors and interruptions always surface as a caution callout.
 */
export default function AgentTimeline({ timeline, isStreaming = false, showReasoning = true }) {
  const [expanded, setExpanded] = useState(null); // null = follow the streaming default
  const listId = useId();
  const now = useNow(isStreaming);
  const steps = timeline?.steps || [];
  const warnings = timelineWarnings(timeline);

  if (!isStreaming && steps.length === 0 && warnings.length === 0) return null;

  const open = expanded ?? (isStreaming && showReasoning);
  const { tools, agents } = timelineCounts(timeline);
  const running = steps.filter((s) => s.status === 'running');
  const activeAgent = [...running].reverse().find((s) => s.kind === 'agent')?.agent;

  let chipText;
  if (isStreaming) {
    const elapsed = timeline?.startedAt != null ? formatDuration(Math.max(0, now - timeline.startedAt)) : '';
    const counts = [tools && `${tools} tool${tools === 1 ? '' : 's'}`, agents && `${agents} agent${agents === 1 ? '' : 's'}`].filter(Boolean);
    chipText = ['Working', counts.join(', '), elapsed].filter(Boolean).join(' · ');
  } else {
    chipText = summarizeTimeline(timeline);
  }

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setExpanded(!open)}
        aria-expanded={open}
        aria-controls={listId}
        className={cn(
          'inline-flex max-w-full items-center gap-2 rounded-full border border-line bg-surface-raised px-2.5 py-1 text-2xs font-medium text-fg-muted transition-colors hover:border-line-strong hover:text-fg',
          focusRing,
        )}
      >
        {isStreaming ? (
          activeAgent ? <AgentAvatar agent={activeAgent} size="sm" /> : <Spinner size="xs" label="Working" className="motion-reduce:animate-none" />
        ) : (
          <IconWrench size={12} className="shrink-0 text-fg-subtle" />
        )}
        <span className="truncate tabular-nums">{chipText}</span>
        {timeline?.iteration && isStreaming && (
          <span className="hidden text-fg-subtle sm:inline">
            step {timeline.iteration.current}/{timeline.iteration.max}
          </span>
        )}
        <IconChevronDown size={12} className={cn('shrink-0 transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
      </button>

      {open && (
        <ol
          id={listId}
          aria-label="Agent activity"
          className="mt-2 space-y-0.5 rounded-lg border border-line bg-surface p-2.5 animate-fade-in motion-reduce:animate-none"
        >
          {steps.map((step) => (
            <li key={step.id} className="animate-fade-in motion-reduce:animate-none">
              {step.kind === 'agent' && <AgentStep step={step} />}
              {step.kind === 'tool' && <ToolStep step={step} />}
              {step.kind === 'thought' && <ThoughtStep step={step} />}
            </li>
          ))}
          {isStreaming && steps.length === 0 && <li className="py-1 text-2xs text-fg-subtle">Analyzing your request…</li>}
        </ol>
      )}

      <Warnings warnings={warnings} />
    </div>
  );
}
