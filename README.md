# NBA DFS Optimizer

A DraftKings NBA daily fantasy sports lineup optimizer with AI-powered decision making.

## Project Structure

```
NBA_DFS_Optimizer/
├── backend/          # Node.js + Express API
│   ├── src/
│   │   ├── config/   # Database and app configuration
│   │   ├── models/   # Database models
│   │   ├── routes/   # API routes
│   │   ├── services/ # Business logic
│   │   └── server.js # Entry point
│   └── package.json
├── frontend/         # React application
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── services/
│   │   └── App.jsx
│   └── package.json
└── package.json      # Root package.json
```

## Tech Stack

**Frontend:**
- React 18
- React Router
- Tailwind CSS
- Axios

**Backend:**
- Node.js
- Express
- SQLite3
- better-sqlite3

## Getting Started

1. Install dependencies:
```bash
npm run install:all
```

2. Start development servers:
```bash
npm run dev
```

This will start:
- Backend API on http://localhost:3001
- Frontend on http://localhost:5173

## Features (Planned)

- [ ] Fetch player data from RotoWire API
- [ ] Display searchable/filterable player pool
- [ ] Manual lineup builder with DK constraints
- [ ] Lineup validation ($50k salary cap, position requirements)
- [ ] Save/manage multiple lineups
- [ ] Export lineups to CSV for DraftKings
- [ ] AI-powered lineup optimization
- [ ] AI chat assistant for player analysis
- [ ] Integration with additional data sources

## API Endpoints

- `GET /api/slates` - Get available slates
- `GET /api/players/:slateId` - Get players for a slate
- `POST /api/lineups` - Save a lineup
- `GET /api/lineups` - Get user's saved lineups
- `DELETE /api/lineups/:id` - Delete a lineup
