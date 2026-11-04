// Theme tokens resolved to colours for SVG attributes (which can't read CSS variables).
import { useEffect, useState } from 'react';

const TOKENS = ['chart-1', 'chart-2', 'line', 'fg', 'fg-muted', 'fg-subtle', 'surface', 'positive', 'negative', 'caution', 'accent'];

function readTokens() {
  const style = typeof window !== 'undefined' ? getComputedStyle(document.documentElement) : null;
  return Object.fromEntries(
    TOKENS.map((t) => {
      const v = style?.getPropertyValue(`--${t}`).trim();
      return [t, v ? `rgb(${v})` : 'currentColor'];
    }),
  );
}

/** Theme colours for SVG attributes, re-read when the theme class on <html> flips. */
export default function useChartTokens() {
  const [tokens, setTokens] = useState(readTokens);
  useEffect(() => {
    const observer = new MutationObserver(() => setTokens(readTokens()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return tokens;
}

