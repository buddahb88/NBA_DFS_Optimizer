// Prism style for react-syntax-highlighter built from theme tokens, so code blocks
// follow light/dark mode without a second stylesheet.
const t = (token, alpha) => (alpha ? `rgb(var(--${token}) / ${alpha})` : `rgb(var(--${token}))`);

const base = {
  color: t('fg'),
  background: 'none',
  fontFamily: 'var(--font-mono, "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
  fontSize: '0.8125rem',
  lineHeight: 1.6,
  textAlign: 'left',
  whiteSpace: 'pre',
  wordSpacing: 'normal',
  wordBreak: 'normal',
  tabSize: 2,
  hyphens: 'none',
};

const codeTheme = {
  'code[class*="language-"]': base,
  'pre[class*="language-"]': { ...base, margin: 0, padding: '0.875rem 1rem', overflow: 'auto', background: t('surface-sunken') },
  comment: { color: t('fg-subtle'), fontStyle: 'italic' },
  prolog: { color: t('fg-subtle') },
  doctype: { color: t('fg-subtle') },
  cdata: { color: t('fg-subtle') },
  punctuation: { color: t('fg-muted') },
  operator: { color: t('fg-muted') },
  property: { color: t('info') },
  tag: { color: t('negative') },
  'attr-name': { color: t('caution') },
  boolean: { color: t('caution') },
  number: { color: t('caution') },
  constant: { color: t('caution') },
  symbol: { color: t('caution') },
  deleted: { color: t('negative') },
  selector: { color: t('positive') },
  string: { color: t('positive') },
  char: { color: t('positive') },
  'attr-value': { color: t('positive') },
  inserted: { color: t('positive') },
  builtin: { color: t('info') },
  url: { color: t('info') },
  entity: { color: t('info') },
  atrule: { color: t('accent') },
  keyword: { color: t('accent'), fontWeight: 600 },
  function: { color: t('info') },
  'class-name': { color: t('caution') },
  regex: { color: t('caution') },
  important: { color: t('negative'), fontWeight: 600 },
  variable: { color: t('fg') },
  bold: { fontWeight: 600 },
  italic: { fontStyle: 'italic' },
};

export default codeTheme;
