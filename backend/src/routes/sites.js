import express from 'express';
import { SITES, isValidSite, getSiteConfig } from '../config/sites.js';

const router = express.Router();

// Get rules for all supported DFS sites (public contest rules only)
router.get('/', (req, res) => {
  res.json(SITES);
});

// Get rules for one site
router.get('/:site', (req, res) => {
  if (!isValidSite(req.params.site)) {
    return res.status(404).json({ error: `Unknown site: ${req.params.site}` });
  }
  res.json(getSiteConfig(req.params.site));
});

export default router;
