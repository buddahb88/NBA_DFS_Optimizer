/**
 * PICK LOG ROUTES (forward test, services/pickLogService.js)
 *
 *   GET  /api/pick-log            picks per night + per-source summary
 *        ?from&to&site&source&slateId&forward=true|false&limit
 *   POST /api/pick-log            log one pick { slateId, slateDate, site, source, lineup, meta }
 *                                 (409 after lock unless source ends in _backfill)
 *   POST /api/pick-log/log-now    run the registered pickers on the live DK main slate now
 *                                 { slateId?, sources? } (409 after lock)
 *   POST /api/pick-log/score      score finished nights { slateId?, gameDate?, rescore? }
 *   PUT  /api/pick-log/nights     real contest numbers of a night
 *                                 { site, slateId, gameDate, cashLine, winningScore, contestName, notes }
 */

import express from 'express';
import {
  PickLogError, logPick, logLiveSlateNow, pickLogReport, scorePendingPicks, setNightResult
} from '../services/pickLogService.js';

const router = express.Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function sendError(res, error) {
  if (error instanceof PickLogError || error.status) return res.status(error.status || 400).json({ error: error.message });
  console.error('Pick log error:', error);
  return res.status(500).json({ error: error.message });
}

const boolParam = (v) => (v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : null);

router.get('/', async (req, res) => {
  try {
    const { from, to, site, source, slateId, limit } = req.query;
    for (const [k, v] of [['from', from], ['to', to]]) {
      if (v && !DATE_RE.test(v)) return res.status(400).json({ error: `${k} must be YYYY-MM-DD` });
    }
    const report = await pickLogReport({
      from: from || null, to: to || null, site: site || null, source: source || null,
      slateId: slateId || null, forward: boolParam(req.query.forward), limit
    });
    res.json({ success: true, ...report });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/', async (req, res) => {
  try {
    const { slateId, slateDate, site, source, lineup, meta } = req.body ?? {};
    const { pick, replaced } = await logPick({ slateId, slateDate, site, source, lineup, meta });
    res.status(replaced ? 200 : 201).json({ success: true, replaced, pick });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/log-now', async (req, res) => {
  try {
    const { slateId = null, sources = null } = req.body ?? {};
    if (sources !== null && (!Array.isArray(sources) || sources.some(s => typeof s !== 'string'))) {
      return res.status(400).json({ error: 'sources must be an array of picker names' });
    }
    res.json({ success: true, ...(await logLiveSlateNow({ slateId, sources })) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/score', async (req, res) => {
  try {
    const { slateId = null, gameDate = null, rescore = false } = req.body ?? {};
    if (gameDate && !DATE_RE.test(gameDate)) return res.status(400).json({ error: 'gameDate must be YYYY-MM-DD' });
    res.json({ success: true, ...(await scorePendingPicks({ slateId, gameDate, rescore: Boolean(rescore) })) });
  } catch (error) {
    sendError(res, error);
  }
});

router.put('/nights', async (req, res) => {
  try {
    const { site, slateId, gameDate, cashLine, winningScore, contestName, notes } = req.body ?? {};
    res.json({ success: true, night: await setNightResult({ site, slateId, gameDate, cashLine, winningScore, contestName, notes }) });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
