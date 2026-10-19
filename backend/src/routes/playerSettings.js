import express from 'express';
import playerSettingsModel from '../models/playerSettingsModel.js';

const router = express.Router();

const sendError = (res, error) => {
  if (!error.status) console.error('Player settings error:', error);
  res.status(error.status || 500).json({ error: error.message });
};

// All saved player controls for a slate
router.get('/:slateId', async (req, res) => {
  try {
    res.json(await playerSettingsModel.getBySlateId(req.params.slateId));
  } catch (error) {
    sendError(res, error);
  }
});

// Replace one player's controls; an all-default body deletes the row
router.put('/:slateId/:playerId', async (req, res) => {
  try {
    const { slateId, playerId } = req.params;
    const saved = await playerSettingsModel.upsert(slateId, playerId, req.body || {});
    res.json(saved ?? { playerId: String(playerId), cleared: true });
  } catch (error) {
    sendError(res, error);
  }
});

// Reset every control on a slate
router.delete('/:slateId', async (req, res) => {
  try {
    const result = await playerSettingsModel.clearSlate(req.params.slateId);
    res.json({ success: true, cleared: result?.changes ?? 0 });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
