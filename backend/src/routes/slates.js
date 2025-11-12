import express from 'express';
import slateModel from '../models/slateModel.js';
import rotowireService from '../services/rotowireService.js';

const router = express.Router();

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
    const slates = slateModel.getAll();
    if (slates.length === 0) {
      return res.json(null);
    }
    // Return the most recently updated slate
    res.json(slates[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all slates
router.get('/', async (req, res) => {
  try {
    const slates = slateModel.getAll();
    res.json(slates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get a specific slate
router.get('/:slateId', async (req, res) => {
  try {
    const slate = slateModel.getById(req.params.slateId);
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

    slateModel.createOrUpdate({
      slateId,
      name,
      sport: sport || 'NBA',
      startTime
    });

    const slate = slateModel.getById(slateId);
    res.json(slate);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a slate
router.delete('/:slateId', async (req, res) => {
  try {
    slateModel.delete(req.params.slateId);
    res.json({ message: 'Slate deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
