import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../../components/ui';
import ChatTable from './ChatTable';
import CodeBlock from './CodeBlock';
import { hastText } from './markdownTable';

// Fenced code arrives as <pre><code class="language-x">; inline code is a bare <code>
function Pre({ node }) {
  const codeNode = node?.children?.find((c) => c.type === 'element' && c.tagName === 'code');
  const className = [].concat(codeNode?.properties?.className || []).join(' ');
  const language = /language-([\w+#-]+)/.exec(className)?.[1] ?? '';
  return <CodeBlock code={hastText(codeNode).replace(/\n$/, '')} language={language} />;
}

const components = {
  pre: Pre,
  code: ({ children }) => (
    <code className="rounded border border-line/70 bg-surface-sunken px-1 py-px font-mono text-[0.8125em] text-fg">{children}</code>
  ),
  h1: ({ children }) => <h1 className="mb-2 mt-6 text-lg font-semibold tracking-tight text-fg">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-5 text-base font-semibold tracking-tight text-fg">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1.5 mt-4 text-sm font-semibold text-fg">{children}</h3>,
  h4: ({ children }) => <h4 className="mb-1.5 mt-4 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">{children}</h4>,
  p: ({ children }) => <p className="my-2.5 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="my-2.5 list-outside list-disc space-y-1 pl-5 marker:text-fg-subtle">{children}</ul>,
  ol: ({ children }) => <ol className="my-2.5 list-outside list-decimal space-y-1 pl-5 marker:text-fg-subtle">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5 leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 rounded-r-md border-l-2 border-accent bg-accent-soft/40 px-3 py-0.5 text-fg-muted">{children}</blockquote>
  ),
  table: ChatTable,
  th: ({ children }) => <th className="border-b border-line bg-surface-sunken px-2 py-1 text-left font-semibold text-fg-subtle">{children}</th>,
  td: ({ children }) => <td className="border-b border-line/60 px-2 py-1">{children}</td>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
  hr: () => <hr className="my-5 border-line" />,
};

const REMARK_PLUGINS = [remarkGfm];

/** Assistant prose. `streaming` adds the trailing caret (see chat.css). */
export default memo(function Markdown({ children, streaming = false }) {
  return (
    <div className={cn('chat-md text-sm text-fg', streaming && 'is-streaming')}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
