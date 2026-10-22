// Turns a react-markdown table (hast node) into rows + column hints for DataTable.

const EMPTY = new Set(['', '-', '—', '–', 'n/a', 'na']);

export function hastText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.value;
  return (node.children || []).map(hastText).join('');
}

const childElements = (node, tagName) => (node?.children || []).filter((c) => c.type === 'element' && (!tagName || c.tagName === tagName));

/** '$7,200' -> 7200, '$7.2K' -> 7200, '+3.1' -> 3.1, '24%' -> 24, '5.2x' -> 5.2; null when not a number. */
export function parseNumber(text) {
  const t = String(text ?? '').trim().replace(/−/g, '-');
  if (EMPTY.has(t.toLowerCase())) return null;
  const m = /^([+-])?\$?([\d,]*\.?\d+)\s*(k|%|x)?$/i.exec(t);
  if (!m) return null;
  const n = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const scaled = m[3]?.toLowerCase() === 'k' ? n * 1000 : n;
  return m[1] === '-' ? -scaled : scaled;
}

const isPlayerHeader = (label) => /^(player|name|player name)$/i.test(label.trim()) || /\bplayer\b/i.test(label);

// Coloring only where the meaning is unambiguous
function toneFor(label, cells) {
  if (cells.some((c) => /^[+−-]\s*\$?\d/.test(c.trim()))) return 'signed';
  if (/\bvalue\b|^val$|pts\s*\/\s*\$/i.test(label)) return 'value';
  if (/\bproj|\bfpts\b|projection/i.test(label)) return 'proj';
  return null;
}

/**
 * { columns: [{ label, numeric, player, tone }], rows: [{ cells: string[], values: (number|null)[] }] }
 * Returns null when the node has no header row or no body rows.
 */
export function parseMarkdownTable(tableNode) {
  const thead = childElements(tableNode, 'thead')[0];
  const tbody = childElements(tableNode, 'tbody')[0];
  const headerRow = thead && childElements(thead, 'tr')[0];
  if (!headerRow || !tbody) return null;

  const labels = childElements(headerRow).map((th, i) => hastText(th).trim() || `Column ${i + 1}`);
  const bodyCells = childElements(tbody, 'tr').map((tr) => {
    const cells = childElements(tr).map((td) => hastText(td).trim());
    return labels.map((_, i) => cells[i] ?? '');
  });
  if (!labels.length || !bodyCells.length) return null;

  const columns = labels.map((label, i) => {
    const cells = bodyCells.map((r) => r[i]);
    const filled = cells.filter((c) => !EMPTY.has(c.toLowerCase()));
    const player = isPlayerHeader(label);
    const numeric = !player && filled.length > 0 && filled.every((c) => parseNumber(c) !== null);
    return { label, numeric, player, tone: numeric ? toneFor(label, filled) : null };
  });

  const rows = bodyCells.map((cells) => ({
    cells,
    values: cells.map((c, i) => (columns[i].numeric ? parseNumber(c) : null)),
  }));

  return { columns, rows };
}

/** Text color for a numeric cell; '' when the column has no obvious good/bad direction. */
export function toneClass(tone, value) {
  if (value == null) return '';
  if (tone === 'signed') return value > 0 ? 'text-positive' : value < 0 ? 'text-negative' : '';
  // DK-style points per $1K: 5x+ is the usual value target
  if (tone === 'value') return value >= 5 ? 'font-semibold text-positive' : value < 4 ? 'text-fg-muted' : '';
  if (tone === 'proj') return 'font-semibold';
  return '';
}
