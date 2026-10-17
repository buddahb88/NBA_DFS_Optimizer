// Placeholders for the top-bar controls. The site-switcher / slate-selector
// card replaces these components; AppShell only renders them.

function SlotPlaceholder({ label, value }) {
  return (
    <div
      className="flex h-7 items-center gap-2 rounded border border-dashed border-line-strong px-2 text-xs text-fg-subtle"
      title={`${label} (not wired yet)`}
    >
      <span className="hidden text-2xs uppercase tracking-wider sm:inline">{label}</span>
      <span className="text-fg-muted">{value}</span>
    </div>
  );
}

export function SiteSwitcherSlot() {
  return <SlotPlaceholder label="Site" value="DraftKings" />;
}

export function SlateSelectorSlot() {
  return <SlotPlaceholder label="Slate" value="Main" />;
}
