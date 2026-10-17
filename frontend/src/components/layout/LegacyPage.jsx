/**
 * Hosts a page that predates the design system. Those pages hard-code light
 * colours (bg-white, text-gray-900), so the subtree is pinned to light tokens
 * regardless of the app theme. Remove this wrapper once a page is redesigned
 * with the ui kit.
 *
 * fullBleed: page manages its own full-height layout (e.g. chat). Its root
 * `h-screen` element is clamped to the shell's content area instead.
 */
export default function LegacyPage({ fullBleed = false, children }) {
  if (fullBleed) {
    return <div className="theme-light h-full bg-canvas text-fg [&>.h-screen]:!h-full">{children}</div>;
  }
  return (
    <div className="theme-light min-h-full bg-canvas text-fg">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">{children}</div>
    </div>
  );
}
