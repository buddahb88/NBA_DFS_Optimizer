import express from 'express';
import slateModel from '../models/slateModel.js';
import rotowireService from '../services/rotowireService.js';
import { DEFAULT_SITE, isValidSite } from '../config/sites.js';

const router = express.Router();

// Slates with no site predate multi-site support and are DraftKings
export const filterSlatesBySite = (slates, site) =>
  slates.filter(s => (s.site || DEFAULT_SITE) === site.toLowerCase());

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

// Get the current active slate (most recent one)
router.get('/active', async (req, res) => {
  try {
    const slates = await slateModel.getAll();
    if (slates.length === 0) {
      return res.json(null);
    }
    // Return the most recently updated slate
    res.json(slates[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    res.json(site ? filterSlatesBySite(slates, site) : slates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get a specific slate
router.get('/:slateId', async (req, res) => {
  try {
    const slate = await slateModel.getById(req.params.slateId);
    if (!slate) {
      return res.status(404).json({ error: 'Slate not found' });
    }
    res.json(slate);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create or update a slate
router.post('/', async (req, res) => {
  try {
    const { slateId, name, sport, startTime } = req.body;

    if (!slateId || !name) {
      return res.status(400).json({ error: 'slateId and name are required' });
    }

    await slateModel.createOrUpdate({
      slateId,
      name,
      sport: sport || 'NBA',
      startTime
    });

    const slate = await slateModel.getById(slateId);
    res.json(slate);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a slate
router.delete('/:slateId', async (req, res) => {
  try {
    await slateModel.delete(req.params.slateId);
    res.json({ message: 'Slate deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
