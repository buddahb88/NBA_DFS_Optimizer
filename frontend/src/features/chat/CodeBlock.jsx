import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { IconCheck, IconCopy } from '../../components/ui';
import codeTheme from './codeTheme';
import useCopy from './useCopy';

/** Fenced code block: language label, copy button, token-colored highlighting. */
export default function CodeBlock({ code, language }) {
  const { copied, copy } = useCopy();

  return (
    <div className="my-3 overflow-hidden rounded-md border border-line bg-surface-sunken">
      <div className="flex h-8 items-center justify-between border-b border-line bg-surface-raised pl-3 pr-1">
        <span className="font-mono text-2xs text-fg-subtle">{language || 'text'}</span>
        <button
          type="button"
          onClick={() => copy(code)}
          aria-label={copied ? 'Copied code' : 'Copy code'}
          className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-2xs text-fg-muted transition-colors hover:bg-surface-sunken hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          {copied ? <IconCheck size={12} className="text-positive" /> : <IconCopy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <SyntaxHighlighter style={codeTheme} language={language || 'text'} PreTag="div" className="scrollbar-thin">
        {code}
      </SyntaxHighlighter>
    </div>
  );
}
