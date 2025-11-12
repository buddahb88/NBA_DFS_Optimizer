# NBA DFS AI Chat - Quick Start Guide

## 🚀 What You Built

An AI-powered chat assistant that can:
- Query player stats using natural language
- Build optimal lineups with specific constraints
- Analyze matchups and Vegas lines
- Provide DFS strategy advice
- Execute text-to-SQL queries against your NBA database

## 🏀 Example Queries

### Lineup Building
```
"Lock Luka Doncic and build an optimal GPP lineup"
"Build a cash game lineup under $49,500"
"Create a lineup with high ownership players"
"Lock Giannis and Trae Young and optimize around them"
```

### Player Analysis
```
"Show me the top 10 players by projected points"
"Find guards under $6000 with good value"
"Who has the highest usage rate tonight?"
"Show me players with low ownership and high upside"
```

### Matchup Analysis
```
"Which games have the highest Vegas totals?"
"Show me players from the Lakers vs Warriors game"
"Find players on teams favored by 7+ points"
"Who plays in games with over 225 total?"
```

### Advanced Queries
```
"Show players averaging 40+ DK points last 3 games"
"Find centers with over 30% usage and under 15% ownership"
"Which players have the best value in GPP mode?"
"Show me punt plays (cheap players with upside)"
```

## 🛠️ How It Works

### Architecture
1. **Frontend (React)**: Chat UI at `/chat` route
2. **Backend (Express)**: Chat API at `/api/chat`
3. **AI Service**: OpenAI SDK with Azure configuration
4. **Tools**: 4 specialized tools the AI can use

### AI Tools Available

1. **sql_query**: Execute SQL queries against the database
   - Access to players, slates, lineups, and all stats

2. **search_players**: Find players by name
   - Partial matching (e.g., "Luka" finds "Luka Doncic")
   - Returns player IDs needed for lineup building

3. **build_lineup**: Generate optimal lineups using Linear Programming
   - Lock specific players
   - Choose cash or GPP mode
   - Generate multiple lineups
   - Control randomness/variance

4. **get_current_slate**: Get the most recent slate ID
   - Useful when user doesn't specify a slate

### Player Filtering (IMPORTANT!)

Players are **automatically filtered out** if:
- ❌ RotoWire marks them with `pts = 0.0` in game data (injured/inactive)
- ❌ Projected points = 0
- ❌ Projected minutes = 0
- ❌ Below 15 projected points (in optimizer)
- ❌ Below 15 projected minutes (in optimizer)

**Exception**: Locked players bypass filters (so you can force anyone into a lineup)

## 📊 Database Schema

### Players Table (Main)
- **Basic**: name, position, team, opponent, salary
- **Projections**: projected_points, projected_minutes
- **Recent Performance**: fpts_last3, fpts_last5, fpts_last7, fpts_last14
- **Advanced**: per (efficiency), usage (usage rate %)
- **Vegas**: vegas_implied_total, vegas_spread, vegas_over_under, vegas_win_prob
- **DFS**: value (cash), value_gpp (tournaments), rostership (ownership %)
- **Status**: injury_status, game_info

### Other Tables
- **slates**: DFS contests (Main, Showdown, etc.)
- **lineups**: Saved lineups
- **lineup_players**: Junction table
- **chat_sessions**: Chat conversation history
- **chat_messages**: Individual messages

## 🔧 Configuration

### Environment Variables (.env)
```env
PORT=3001
DATABASE_PATH=./data/nba_dfs.db
ROTOWIRE_COOKIE=<your_cookie>
AZURE_OPENAI_KEY=<your_key>
AZURE_OPENAI_ENDPOINT=<your_endpoint>
AZURE_OPENAI_MODEL=gpt-4.1-mini
```

### Key Files
- **AI Service**: `backend/src/services/aiChatService.js`
- **Chat Routes**: `backend/src/routes/chat.js`
- **Chat UI**: `frontend/src/pages/ChatPage.jsx`
- **Optimizer**: `backend/src/services/optimizerService.js`
- **RotoWire**: `backend/src/services/rotowireService.js`

## 🎯 DFS Strategy Built-In

### Cash Games (Safe Mode)
- Uses `value` metric (includes ownership bonus for chalk)
- Prioritizes high floors, safety
- Favors popular/proven plays

### GPP/Tournaments (Leverage Mode)
- Uses `value_gpp` metric (includes low-ownership bonus)
- Prioritizes high ceilings, upside
- Rewards contrarian plays (under 5% owned = 1.15x value)
- Penalizes chalk (over 30% owned = 0.92x value)

### Value Calculation Factors
- Base: Points per $1000
- Minutes: More minutes = better (35+ min = 1.15x)
- PER: Higher efficiency = better (25+ = 1.20x)
- Usage: Higher usage = better (30+ = 1.10x)
- Recent form: Hot streaks rewarded (1.08x), cold streaks penalized (0.92x)
- Vegas: High totals = more points (230+ = 1.05x)
- Ownership: GPP leverages low-owned, Cash prefers chalk

## 🚨 Troubleshooting

### Backend won't start
- Check `.env` file exists in `backend/` directory
- Verify Azure OpenAI credentials
- Try: `npm run init-db` to reset database

### No players showing up
- Check RotoWire cookie is valid
- Make sure you synced a slate (Home page)
- Check backend logs for "REJECTED" or "Filtered" messages

### AI not responding
- Check backend console for errors
- Verify Azure OpenAI endpoint is reachable
- Check function call logs in backend

### Database locked error
- Stop backend server (Ctrl+C)
- Delete: `backend/data/nba_dfs.db`
- Restart: `npm run init-db && npm run dev`

## 📝 Example Session

```
User: "Show me the top value plays under $6000"
AI: [Executes SQL query]
    Returns: Table of guards/forwards under $6k sorted by value

User: "Lock the top guard and build a GPP lineup"
AI: [Searches for player name]
    [Builds lineup with locked player]
    Returns: Complete 8-player lineup with salaries and projections

User: "What's the Vegas total for that game?"
AI: [Queries Vegas data]
    Returns: Over/under, spread, implied totals
```

## 🎓 Tips

1. **Be specific**: "Lock Luka and Trae" is better than "build a lineup"
2. **Use player names**: The AI will search and find IDs automatically
3. **Specify mode**: "GPP lineup" vs "cash lineup" affects strategy
4. **Ask follow-ups**: Chat history is preserved in the session
5. **View past chats**: Sidebar shows all previous conversations

## 🔮 Future Enhancements

Ideas for expansion:
- Real-time player news integration
- Automated lineup generation on slate import
- Player correlation analysis
- Historical performance tracking
- Export lineups to DraftKings/FanDuel format
- Showdown mode support
- Multi-slate optimization

---

Built with: React, Express, SQLite, OpenAI, LangChain Tools, Linear Programming

Enjoy building winning lineups! 🏆🏀
