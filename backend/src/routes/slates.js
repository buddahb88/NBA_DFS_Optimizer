import express from 'express';
import slateModel from '../models/slateModel.js';
import rotowireService from '../services/rotowireService.js';
import { importSalaries } from '../services/salaryImportService.js';
import { parseMultipart } from '../utils/multipart.js';
import { DEFAULT_SITE, isValidSite } from '../config/sites.js';
import { getSlateFreshness } from '../services/slateFreshness.js';
import { listBacktestSlates, resolveSlate, sourceFields } from '../services/slateSource.js';

const router = express.Router();

// Slates with no site predate multi-site support and are DraftKings
export const filterSlatesBySite = (slates, site) =>
  slates.filter(s => (s.site || DEFAULT_SITE) === site.toLowerCase());

// Slate row plus the night it covers and whether that is before today (ET)
async function withFreshness(slate) {
  const f = await getSlateFreshness(slate);
  return { ...slate, slate_date: f.slateDate, is_stale: f.isStale, days_old: f.daysOld };
}

// Get available slates from RotoWire (Classic contests only)
router.get('/list', async (req, res) => {
  try {
    const slates = await rotowireService.fetchSlateList();
    res.json(slates);
  } catch (error) {
    console.error('Error fetching slate list:', error);
    res.status(500).json({ error: error.message });
  }
});

// Import a site's official player/salary CSV (multipart: file, optional site, slateId, slateName)
router.post('/import-salaries', express.raw({ type: 'multipart/form-data', limit: '10mb' }), async (req, res) => {
  try {
    if (!req.is('multipart/form-data')) {
      return res.status(400).json({ error: 'Expected multipart/form-data with a "file" field' });
    }
    const { fields, files } = parseMultipart(req.body, req.headers['content-type']);
    if (!files.file || files.file.buffer.length === 0) {
      return res.status(400).json({ error: 'No file uploaded (field name "file")' });
    }

    const result = await importSalaries({
      csvText: files.file.buffer.toString('utf8'),
      site: fields.site || null,
      slateId: fields.slateId || null,
      slateName: fields.slateName || null
    });
    res.json(result);
  } catch (error) {
    if (!error.status) console.error('Salary import error:', error);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Get all slates, optionally only one site's (?site=fanduel)
router.get('/', async (req, res) => {
  try {
    const { site } = req.query;
    if (site !== undefined && !isValidSite(site)) {
      return res.status(400).json({ error: `Unknown site: ${site}` });
    }
    const slates = await slateModel.getAll();
    res.json(await Promise.all((site ? filterSlatesBySite(slates, site) : slates).map(withFreshness)));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Saved past slates that can be rebuilt (Backtest picker), newest first (?site=)
router.get('/backtests', async (req, res) => {
  try {
    const { site } = req.query;
    if (site !== undefined && !isValidSite(site)) {
      return res.status(400).json({ error: `Unknown site: ${site}` });
    }
    res.json(await listBacktestSlates({ site: site || null }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Which slate a request means: ?slateId=&slateDate=&site= (services/slateSource.js)
router.get('/source', async (req, res) => {
  try {
    const { slateId, slateDate, site } = req.query;
    const source = await resolveSlate({ slateId, slateDate, site });
    if (!source) return res.status(404).json({ error: 'No slate synced' });
    res.json(sourceFields(source));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Get a specific slate
router.get('/:slateId', async (req, res) => {
  try {
    const slate = await slateModel.getById(req.params.slateId);
    if (!slate) {
      return res.status(404).json({ error: 'Slate not found' });
    }
    res.json(await withFreshness(slate));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
