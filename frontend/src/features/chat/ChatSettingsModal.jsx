import { Modal, Slider, Toggle } from '../../components/ui';

const AGENTS = [
  { name: 'Optimizer', role: 'Lineup building', tone: 'bg-positive' },
  { name: 'Research', role: 'Slate data and research tools', tone: 'bg-accent' },
  { name: 'Analyst', role: 'Player history and context', tone: 'bg-info' },
];

export default function ChatSettingsModal({ open, onClose, maxIterations, setMaxIterations, showReasoning, setShowReasoning }) {
  return (
    <Modal open={open} onClose={onClose} size="sm" title="Chat settings" description="Applies to new messages in this tab.">
      <div className="flex flex-col gap-5 py-1">
        <div>
          <Slider label="Max agent steps" value={maxIterations} min={5} max={30} onChange={setMaxIterations} />
          <p className="mt-1.5 text-2xs text-fg-subtle">Higher values allow more tool calls but may take longer.</p>
        </div>
        <Toggle checked={showReasoning} onChange={setShowReasoning} label="Show reasoning" description="Display the agents' thinking and tool calls while they work" />
        <div className="border-t border-line pt-4">
          <h3 className="mb-2 text-2xs font-semibold uppercase tracking-wide text-fg-subtle">Available agents</h3>
          <ul className="space-y-1.5">
            {AGENTS.map((a) => (
              <li key={a.name} className="flex items-center gap-2 text-xs">
                <span className={`h-2 w-2 rounded-full ${a.tone}`} aria-hidden="true" />
                <span className="font-medium text-fg">{a.name}</span>
                <span className="text-fg-subtle">{a.role}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Modal>
  );
}
