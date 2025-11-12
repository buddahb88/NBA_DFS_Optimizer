import express from 'express';
import lineupModel from '../models/lineupModel.js';

const router = express.Router();

// DraftKings NBA lineup constraints
const DK_CONSTRAINTS = {
  SALARY_CAP: 50000,
  POSITIONS: ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL'],
  POSITION_COUNT: 8
};

// Validate lineup helper
function validateLineup(players) {
  const errors = [];

  if (players.length !== DK_CONSTRAINTS.POSITION_COUNT) {
    errors.push(`Lineup must have exactly ${DK_CONSTRAINTS.POSITION_COUNT} players`);
  }

  const totalSalary = players.reduce((sum, p) => sum + (p.salary || 0), 0);
  if (totalSalary > DK_CONSTRAINTS.SALARY_CAP) {
    errors.push(`Total salary ($${totalSalary}) exceeds cap ($${DK_CONSTRAINTS.SALARY_CAP})`);
  }

  return { isValid: errors.length === 0, errors, totalSalary };
}

// Get all lineups
router.get('/', async (req, res) => {
  try {
    const { slateId } = req.query;
    const lineups = lineupModel.getAll(slateId);
    res.json(lineups);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get a specific lineup with players
router.get('/:id', async (req, res) => {
  try {
    const lineup = lineupModel.getById(req.params.id);
    if (!lineup) {
      return res.status(404).json({ error: 'Lineup not found' });
    }
    res.json(lineup);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create a new lineup
router.post('/', async (req, res) => {
  try {
    const { slateId, name, players } = req.body;

    if (!slateId || !name || !players || !Array.isArray(players)) {
      return res.status(400).json({
        error: 'slateId, name, and players array are required'
      });
    }

    // Validate lineup
    const validation = validateLineup(players);
    if (!validation.isValid) {
      return res.status(400).json({
        error: 'Invalid lineup',
        details: validation.errors
      });
    }

    // Calculate projected points
    const projectedPoints = players.reduce(
      (sum, p) => sum + (parseFloat(p.projectedPoints) || 0),
      0
    );

    // Create lineup
    const lineupId = lineupModel.create({
      slateId,
      name,
      totalSalary: validation.totalSalary,
      projectedPoints
    });

    // Add players to lineup
    const lineupPlayers = players.map((player, index) => ({
      playerId: player.id,
      positionSlot: player.positionSlot || DK_CONSTRAINTS.POSITIONS[index]
    }));

    lineupModel.addPlayers(lineupId, lineupPlayers);

    // Return the created lineup
    const lineup = lineupModel.getById(lineupId);
    res.status(201).json(lineup);
  } catch (error) {
    console.error('Create lineup error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update a lineup
router.put('/:id', async (req, res) => {
  try {
    const { name, totalSalary, projectedPoints } = req.body;

    lineupModel.update(req.params.id, {
      name,
      totalSalary,
      projectedPoints
    });

    const lineup = lineupModel.getById(req.params.id);
    res.json(lineup);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a lineup
router.delete('/:id', async (req, res) => {
  try {
    lineupModel.delete(req.params.id);
    res.json({ message: 'Lineup deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Validate lineup endpoint
router.post('/validate', async (req, res) => {
  try {
    const { players } = req.body;

    if (!players || !Array.isArray(players)) {
      return res.status(400).json({ error: 'players array is required' });
    }

    const validation = validateLineup(players);
    res.json(validation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
