# NBA DFS Optimizer - Architecture & Tech Stack Documentation

## Overview
A full-stack NBA DraftKings Daily Fantasy Sports (DFS) lineup optimizer with AI-powered decision making. The application fetches player data from RotoWire, stores it in SQLite, and provides tools for manual lineup building and automated optimization using linear programming.

---

## 1. FRONTEND ARCHITECTURE

### Framework & Tech Stack
- Framework: React 19.2.0
- Routing: React Router DOM 7.1.3
- HTTP Client: Axios 1.6.5
- Build Tool: Vite 7.2.2
- Styling: Tailwind CSS 3.4.1
- Node Version: ESM (type: module)

### Directory Structure
frontend/
├── src/
│   ├── components/          # Reusable React components
│   ├── pages/               # Page components (5 pages)
│   │   ├── HomePage.jsx
│   │   ├── PlayerPoolPage.jsx
│   │   ├── LineupBuilderPage.jsx
│   │   ├── OptimizerPage.jsx
│   │   └── LineupsPage.jsx
│   ├── services/
│   │   └── api.js          # Axios API client with all endpoints
│   ├── utils/              # Utility functions
│   ├── App.jsx             # Main app with React Router
│   └── main.jsx            # React DOM render

### Frontend Pages
1. HomePage: Import players, view available slates
2. PlayerPoolPage: Browse and filter player pool
3. LineupBuilderPage: Manual lineup construction
4. OptimizerPage: Automated lineup generation with LP solver
5. LineupsPage: Manage saved lineups

### Environment Variables
VITE_API_URL=http://localhost:3001/api

---

## 2. BACKEND ARCHITECTURE

### Framework & Tech Stack
- Runtime: Node.js (ESM type: module)
- Framework: Express 4.18.2
- Database: SQLite3 (better-sqlite3 9.2.2)
- Optimization: javascript-lp-solver 0.4.24
- AI Integration: LangChain + Azure OpenAI (already installed)

### Directory Structure
backend/
├── src/
│   ├── config/
│   │   ├── database.js      # SQLite3 connection setup
│   │   ├── schema.js        # Table creation & migrations
│   │   └── initDb.js        # Database initialization
│   ├── models/              # Data models
│   │   ├── playerModel.js
│   │   ├── slateModel.js
│   │   └── lineupModel.js
│   ├── routes/              # API endpoints
│   │   ├── slates.js
│   │   ├── players.js
│   │   ├── lineups.js
│   │   └── optimizer.js
│   ├── services/            # Business logic
│   │   ├── rotowireService.js
│   │   └── optimizerService.js
│   └── server.js            # Express server setup

### Express Routes
GET/POST/DELETE /api/slates
GET/POST /api/players/:slateId
POST /api/players/:slateId/sync
GET /api/lineups
POST /api/optimizer/generate
GET /api/health

---

## 3. DATABASE SCHEMA (SQLite)

### Tables

#### slates
- id (INTEGER PRIMARY KEY)
- slate_id (TEXT UNIQUE)
- name (TEXT)
- sport (TEXT)
- start_time (DATETIME)
- Stores DFS slate metadata

#### players
- id (INTEGER PRIMARY KEY)
- slate_id (TEXT FOREIGN KEY)
- player_id (TEXT)
- name, team, opponent, position
- salary, projected_points, projected_minutes
- value, value_gpp
- Advanced stats: per, usage, fpts_last3-14
- Vegas data: implied_total, spread, over_under, win_prob
- injury_status, rostership
- Indexes on: slate_id, position, salary

#### lineups
- id (INTEGER PRIMARY KEY)
- slate_id (TEXT FOREIGN KEY)
- name, total_salary, projected_points
- Stores user lineups

#### lineup_players
- id (INTEGER PRIMARY KEY)
- lineup_id (INTEGER FOREIGN KEY)
- player_id (INTEGER FOREIGN KEY)
- position_slot (TEXT)
- Junction table linking players to lineups

Database Config:
- WAL mode for concurrency
- Foreign keys enabled
- Location: ./data/nba_dfs.db

---

## 4. DATA MODELS

### PlayerModel
Methods:
- createOrUpdate(playerData)
- bulkCreateOrUpdate(slateId, playersData)
- getBySlateId(slateId, filters)
- getById(id)
- deleteBySlateId(slateId)

Filters: position, minSalary, maxSalary, team
Default sort: by value (descending)

### SlateModel
Methods:
- createOrUpdate(slateData)
- getAll()
- getById(slateId)
- delete(slateId)

### LineupModel
Methods:
- create(lineupData)
- addPlayers(lineupId, players)
- getAll(slateId)
- getById(id)
- update(id, lineupData)
- delete(id)

---

## 5. SERVICES

### RotoWireService
Purpose: Fetch and transform player data from RotoWire API

Key Methods:
- fetchPlayers(slateId)
- transformPlayerData(data)
- fetchSlates()

Data Transformation:
1. Extract core fields: playerId, name, team, position, salary
2. Parse Vegas data: spread, O/U, implied points, win probability
3. Extract recent form: FPTS last 3/5/7/14 games
4. Calculate Smart Projections:
   - Weighted formula: 40% last3 + 30% last5 + 20% last7 + 10% season
   - Vegas adjustment: Boosts for high-scoring games
   - Favorite bonus: Adjusts for spread
5. Calculate Smart Value Metrics:
   - CASH VALUE: With chalk ownership boost
   - GPP VALUE: With leverage bonus for low-owned players
   - Minute bonuses, PER bonuses, usage bonuses
   - Recent form and Vegas pace adjustments

### OptimizerService
Purpose: Generate optimized lineups using Linear Programming

Key Methods:
- optimize(players, settings)
- generateLineupWithLP(players, lockedPlayerIds, excludedPlayerIds)
- extractLineupFromSolution(solution, players)
- getExposureStats(lineups)

Settings:
- mode: 'cash' or 'gpp'
- numLineups: Number of lineups to generate
- lockedPlayers: Force certain players in
- excludedPlayers: Exclude certain players
- minSalary: Minimum salary floor
- maxExposure: Exposure cap across lineups
- randomness: Variance for GPP

Algorithm:
1. Filter by quality metrics (minutes, projection, value percentile)
2. Build LP model with constraints:
   - Exactly 8 players
   - $50k salary cap
   - Position requirements (PG, SG, SF, PF, C, G, F, UTIL)
   - Each player used max once
3. Solve with javascript-lp-solver
4. Track exposure, auto-exclude overexposed
5. Return validated lineups with salary/projection totals

---

## 6. DraftKings CONSTRAINTS

Salary Cap: $50,000
Roster Slots: 8 players
- PG (Point Guard)
- SG (Shooting Guard)
- SF (Small Forward)
- PF (Power Forward)
- C (Center)
- G (Guard - PG/SG eligible)
- F (Forward - SF/PF eligible)
- UTIL (Any position)

---

## 7. ENVIRONMENT CONFIGURATION

### Backend (.env)
PORT=3001
NODE_ENV=development
DATABASE_PATH=./data/nba_dfs.db
ROTOWIRE_COOKIE=<your_cookie>
AZURE_OPENAI_KEY=<key>
AZURE_OPENAI_ENDPOINT=<endpoint>
AZURE_OPENAI_MODEL=gpt-4.1-mini

### Frontend (.env)
VITE_API_URL=http://localhost:3001/api

---

## 8. RUNNING THE APPLICATION

Setup:
npm run install:all

Development:
npm run dev

Access:
- Frontend: http://localhost:5173
- Backend API: http://localhost:3001/api
- Health Check: http://localhost:3001/api/health

---

## 9. KEY FILES FOR AI CHAT INTEGRATION

For adding AutoGen agents and text-to-SQL:

1. Backend entry point: src/server.js
2. New AI service: src/services/aiChatService.js (to create)
3. New route: src/routes/chat.js (to create)
4. Database schema: src/config/schema.js (reference)
5. Dependencies already installed: LangChain, Azure OpenAI
6. Environment vars already configured: .env

---

## 10. TECH STACK SUMMARY

| Component | Technology | Version |
|-----------|-----------|---------|
| Frontend | React | 19.2.0 |
| Routing | React Router DOM | 7.1.3 |
| HTTP | Axios | 1.6.5 |
| Build | Vite | 7.2.2 |
| Styling | Tailwind CSS | 3.4.1 |
| Backend | Express | 4.18.2 |
| Database | SQLite3 | 9.2.2 |
| Optimization | LP Solver | 0.4.24 |
| AI | LangChain + Azure OpenAI | ^1.0.0 |
| External | RotoWire API | (via fetch) |

