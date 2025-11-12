# Quick Start Guide

## Your NBA DFS Optimizer is Ready! 🏀

### What's Been Built

**Backend (Node.js + Express + SQLite)**
- RESTful API with routes for slates, players, and lineups
- SQLite database for storing player data and lineups
- RotoWire API integration for fetching player projections
- Lineup validation (DraftKings $50k salary cap + 8 position slots)

**Frontend (React + Tailwind CSS)**
- Home page with slate management and data import
- Player pool viewer with sorting and filtering
- Interactive lineup builder with drag-and-drop feel
- Saved lineups manager with CSV export

### How to Run

#### Option 1: Run Both Together (Recommended)
```bash
npm run dev
```
This starts:
- Backend on http://localhost:3001
- Frontend on http://localhost:5173

#### Option 2: Run Separately
```bash
# Terminal 1 - Backend
cd backend
npm run dev

# Terminal 2 - Frontend
cd frontend
npm run dev
```

### Getting Started

1. **Start the app** using one of the commands above

2. **Open your browser** to http://localhost:5173

3. **Import player data:**
   - On the home page, enter a RotoWire slate ID (e.g., `26155`)
   - Click "Import Players"
   - The app will fetch and store player data in your SQLite database

4. **View players:**
   - Click "Player Pool" in the navigation
   - Browse, search, and sort players by salary, projections, value, etc.

5. **Build a lineup:**
   - Click "Lineup Builder"
   - Select players for each position slot (PG, SG, SF, PF, C, G, F, UTIL)
   - Watch the salary and projection totals update in real-time
   - Save your lineup when complete

6. **Manage lineups:**
   - Click "My Lineups" to view all saved lineups
   - Export any lineup to CSV for DraftKings upload
   - Delete lineups you no longer need

### Project Structure

```
NBA_DFS_Optimizer/
├── backend/
│   ├── data/              # SQLite database files
│   ├── src/
│   │   ├── config/        # Database setup
│   │   ├── models/        # Data models
│   │   ├── routes/        # API endpoints
│   │   ├── services/      # Business logic (RotoWire API)
│   │   └── server.js      # Express server
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/    # React components (ready for future use)
│   │   ├── pages/         # Page components
│   │   ├── services/      # API client
│   │   └── App.jsx        # Main app with routing
│   └── package.json
└── package.json           # Root scripts

```

### API Endpoints

**Slates**
- `GET /api/slates` - Get all slates
- `GET /api/slates/:slateId` - Get specific slate
- `POST /api/slates` - Create/update slate
- `DELETE /api/slates/:slateId` - Delete slate

**Players**
- `GET /api/players/:slateId` - Get players for a slate
- `POST /api/players/:slateId/sync` - Sync from RotoWire
- `GET /api/players/player/:id` - Get specific player

**Lineups**
- `GET /api/lineups` - Get all lineups
- `GET /api/lineups/:id` - Get specific lineup with players
- `POST /api/lineups` - Create new lineup
- `PUT /api/lineups/:id` - Update lineup
- `DELETE /api/lineups/:id` - Delete lineup
- `POST /api/lineups/validate` - Validate lineup constraints

### Configuration

**Backend (.env)**
```
PORT=3001
DATABASE_PATH=./data/nba_dfs.db
ROTOWIRE_COOKIE=your_cookie_here
```

**Frontend (.env)**
```
VITE_API_URL=http://localhost:3001/api
```

### Next Steps - Future Enhancements

Here are some features you can add next:

1. **AI Integration**
   - Add Claude/OpenAI API for lineup optimization
   - Natural language chat for player analysis
   - Automated lineup generation based on strategy

2. **Advanced Features**
   - Multi-lineup generator for GPP contests
   - Player exposure tracking
   - Correlation analysis and stacking suggestions
   - Injury news monitoring and alerts

3. **Data Sources**
   - Integrate additional projection sources
   - Add Vegas lines and game totals
   - Import DraftKings pricing directly
   - Historical performance tracking

4. **Optimization Engine**
   - Linear programming lineup optimizer
   - Monte Carlo simulation for variance
   - Ownership projection integration
   - Custom constraints (stacks, limits, etc.)

5. **User Features**
   - User authentication and accounts
   - Cloud sync for lineups
   - Contest results tracking
   - Performance analytics

### Troubleshooting

**Port already in use:**
```bash
# Change ports in .env files
# Backend: PORT=3002
# Frontend: Change in vite.config.js
```

**Database errors:**
```bash
cd backend
npm run init-db  # Reinitialize database
```

**RotoWire API not working:**
- Update your cookie in `backend/.env`
- Get fresh cookie from browser DevTools when logged into RotoWire

### Support

- Check the README.md for detailed documentation
- Review code comments for implementation details
- API is RESTful and well-documented in route files

---

**Ready to optimize some lineups?** 🚀

Run `npm run dev` and visit http://localhost:5173 to get started!
