/**
 * INJURY-RISK DISCOUNT SETTING + TABLE
 *
 * When on, slate reads (slateSource.loadSlatePlayers, after the projection
 * source - RotoWire, ours or blend) discount tagged players' projections by
 * P(play | tag, salary band): services/projections/sourceLayer.js applyInjuryRisk.
 * First match wins:
 *   runtime  Lineup Studio / PUT /api/projections/injury-risk, in memory until restart
 *   env      INJURY_RISK_DISCOUNT = on | off (true / false / 1 / 0)
 *   default  DEFAULT_ENABLED (on)
 *
 * The table: injuryRiskTable.json, written by `npm run calibrate:injury-risk`
 * (all saved slates). Missing or unreadable -> the fallback rates
 * (QUES 0.68, PROB 0.92, DOUBT 0.25, GTD = QUES). Backtest slates calibrate
 * as of their date instead (projections/injuryRiskService.js).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fallbackTable } from '../services/projections/injuryRisk.js';

export const DEFAULT_ENABLED = true;
const ENV = 'INJURY_RISK_DISCOUNT';
export const TABLE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'injuryRiskTable.json');

let runtime = null;
let cachedTable = null;

/** true / false from on/off/true/false/1/0/yes/no, else null. */
export function parseEnabled(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['on', 'true', '1', 'yes'].includes(s)) return true;
  if (['off', 'false', '0', 'no'].includes(s)) return false;
  return null;
}

const fallback = () => parseEnabled(process.env[ENV]) ?? DEFAULT_ENABLED;

export const injuryRiskEnabled = () => runtime ?? fallback();

/** The committed table (or the fallback rates), read once. */
export function injuryRiskTable({ reload = false } = {}) {
  if (cachedTable && !reload) return cachedTable;
  try {
    const parsed = JSON.parse(fs.readFileSync(TABLE_FILE, 'utf8'));
    cachedTable = parsed?.tags ? parsed : fallbackTable();
  } catch {
    cachedTable = { ...fallbackTable(), missing: true };
  }
  return cachedTable;
}

/** { enabled, origin: 'runtime' | 'env' | 'default', default, table } */
export function injuryRiskStatus() {
  const origin = runtime !== null ? 'runtime' : parseEnabled(process.env[ENV]) !== null ? 'env' : 'default';
  const t = injuryRiskTable();
  return {
    enabled: injuryRiskEnabled(),
    origin,
    default: fallback(),
    table: {
      generatedAt: t.generated_at ?? null,
      rows: t.rows ?? 0,
      missing: Boolean(t.missing),
      playProbability: Object.fromEntries(Object.entries(t.tags).map(([tag, e]) => [tag, {
        all: e.p_play, lt5k: e.bands?.lt5k?.p_play ?? null, '5k+': e.bands?.['5k+']?.p_play ?? null, n: e.n
      }]))
    }
  };
}

/** true / false: runtime override; null: back to env / default. Throws on anything else. */
export function setInjuryRiskEnabled(value) {
  if (value === null || value === undefined) {
    runtime = null;
  } else {
    const v = parseEnabled(value);
    if (v === null) throw new Error('enabled must be true or false');
    runtime = v;
  }
  return injuryRiskStatus();
}

export default { DEFAULT_ENABLED, TABLE_FILE, parseEnabled, injuryRiskEnabled, injuryRiskTable, injuryRiskStatus, setInjuryRiskEnabled };
