# AI Assistant Upgrade - Advanced Metrics Integration

## Overview
The AI Assistant has been upgraded with complete knowledge of all advanced projection metrics and variance analysis capabilities. It can now provide sophisticated DFS recommendations using floor/ceiling analysis, leverage scoring, and boom/bust probabilities.

---

## ✅ Updated Files

### 1. **database-schema.yaml**
**Location:** `backend/src/config/database-schema.yaml`

**Changes:**
- ✅ Added 9 new column definitions with descriptions
- ✅ Added 5 new common filters for advanced metrics
- ✅ Added 9 new example queries showcasing advanced analysis
- ✅ Updated query tips with advanced metric guidance
- ✅ Updated DFS strategy sections for cash games and GPP tournaments

### 2. **aiChatService.js**
**Location:** `backend/src/services/aiChatService.js`

**Changes:**
- ✅ Updated system prompt with comprehensive advanced metrics explanation
- ✅ Added strategic guidance for cash vs GPP using new metrics
- ✅ Included SQL query examples for each strategy type

---

## 📊 New Metrics the AI Understands

### **1. floor** (REAL)
- **Description**: 25th percentile projection (worst-case reasonable outcome)
- **Range**: 0-70 FP
- **Calculation**: `projection - std_dev + blowout_floor_impact`
- **AI Usage**: Cash game safety analysis
- **Target**: floor >= 30 for cash game cores

### **2. ceiling** (REAL)
- **Description**: 75th percentile projection (best-case reasonable outcome)
- **Range**: 0-80 FP
- **Calculation**: `projection + std_dev + blowout_ceiling_impact`
- **AI Usage**: GPP tournament upside identification
- **Target**: ceiling >= 50 for high upside plays

### **3. volatility** (REAL)
- **Description**: Coefficient of variation (std_dev / mean)
- **Range**: 0-1
- **Interpretation**:
  - <0.15 = Consistent/safe (CASH)
  - 0.15-0.30 = Moderate variance
  - >0.30 = High variance boom/bust (GPP)

### **4. boom_probability** (REAL)
- **Description**: % chance of exceeding value by 10+ fantasy points
- **Range**: 0-100%
- **Interpretation**:
  - ≥30% = High boom potential (great for GPP)
  - 10-30% = Moderate
  - <10% = Low upside

### **5. bust_probability** (REAL)
- **Description**: % chance of failing to meet value threshold
- **Range**: 0-100%
- **Interpretation**:
  - <20% = Safe play (good for cash)
  - 20-40% = Moderate bust risk
  - >40% = High bust risk (avoid in cash)

### **6. fppm** (REAL)
- **Description**: Weighted fantasy points per minute
- **Calculation**: 40% Last 3 games, 30% Last 5 games, 30% Season
- **AI Usage**: Captures current efficiency trends

### **7. leverage_score** (REAL) ⭐ **PRIMARY GPP METRIC**
- **Description**: GPP leverage formula
- **Calculation**: `(boom_probability × 100) / (ownership + 1)`
- **Range**: 0-5000+
- **Interpretation**:
  - ≥3.0 = HIGH LEVERAGE (ideal GPP play)
  - 1.0-3.0 = Moderate leverage
  - <1.0 = Low leverage (chalky)
- **AI Usage**: THE PRIMARY metric for GPP optimization

### **8. blowout_risk** (REAL)
- **Description**: Risk magnitude when spreads exceed 10 points
- **AI Usage**: Identify potential early pull situations
- **Note**: Favorites = early pull risk, Underdogs = garbage time variance

### **9. std_dev** (REAL)
- **Description**: Standard deviation of recent performance
- **AI Usage**: Variance analysis foundation
- **Note**: Higher = more boom/bust potential

---

## 🎯 AI's New Capabilities

### **Cash Game Strategy**
The AI can now query for:
```sql
SELECT name, salary, projected_points, floor, ceiling, volatility, bust_probability
FROM players
WHERE floor >= 30
  AND volatility < 0.20
  AND bust_probability < 25
  AND (injury_status IS NULL OR injury_status = '')
ORDER BY floor DESC
LIMIT 15
```

**Recommendations:**
- High floor plays (floor >= 30)
- Low volatility (< 0.20)
- Low bust risk (< 25%)
- Consistent producers

### **GPP Tournament Strategy**
The AI can now query for:
```sql
SELECT name, salary, projected_points, leverage_score, boom_probability, rostership, ceiling
FROM players
WHERE leverage_score >= 3.0
  AND boom_probability >= 20
  AND (injury_status IS NULL OR injury_status = '')
ORDER BY leverage_score DESC
LIMIT 15
```

**Recommendations:**
- Elite leverage plays (leverage >= 3.0)
- High ceiling potential (ceiling >= 50)
- High boom probability (>= 25%)
- Low ownership differentiation

### **Risk Analysis**
The AI can compare floor vs ceiling spreads:
```sql
SELECT name, salary, projected_points, floor, ceiling,
       (ceiling - floor) as spread, volatility, boom_probability
FROM players
WHERE projected_minutes >= 25
  AND (injury_status IS NULL OR injury_status = '')
ORDER BY spread DESC
LIMIT 15
```

**Use Case**: Identify boom/bust candidates vs consistent plays

---

## 💬 Example AI Conversations

### **User:** "Give me the safest cash game plays"
**AI Response:**
```
Let me query for players with high floors, low volatility, and minimal bust risk...

[Shows SQL query with floor >= 30, volatility < 0.20]

Top Safe Cash Game Plays:
1. Alperen Sengun - Floor: 47.9 | Vol: 2% | Bust: 8%
2. Deni Avdija - Floor: 46.9 | Vol: 7% | Bust: 12%
3. Victor Wembanyama - Floor: 46.9 | Vol: 8% | Bust: 10%

These players have elite floors with minimal variance, making them ideal cash game anchors.
```

### **User:** "Show me leverage bombs for GPP"
**AI Response:**
```
Searching for elite leverage plays with low ownership and high boom potential...

[Shows SQL query with leverage_score >= 3.0]

Top GPP Leverage Plays:
1. Brandon Williams - Lev: 2917.0 | Boom: 76% | Own: 1.6%
2. Daniss Jenkins - Lev: 1597.0 | Boom: 59% | Own: 2.7%
3. Jalen Suggs - Lev: 1141.6 | Boom: 74% | Own: 5.5%

Brandon Williams has INSANE leverage - 76% boom probability with only 1.6% ownership!
This is the type of contrarian play that wins GPPs.
```

### **User:** "Who has the highest ceilings tonight?"
**AI Response:**
```
Finding players with maximum tournament upside...

[Shows SQL query sorted by ceiling DESC]

Highest Ceiling Plays:
1. Victor Wembanyama - Ceiling: 54.7 FP
2. Deni Avdija - Ceiling: 53.7 FP | Boom: 18%
3. Alperen Sengun - Ceiling: 49.7 FP

Wemby has the highest ceiling, but Avdija has better boom probability for GPP upside.
```

### **User:** "Build me a balanced lineup"
**AI Response:**
```
I'll build a balanced lineup mixing safe cash plays with GPP upside...

[Uses leverage_score and floor in optimization logic]

Lineup Strategy:
- Core (high floor): Sengun, KAT (floors 45+)
- Upside (leverage): Brandon Williams (lev: 2917), Jaquez (lev: 200)
- Value: Cisse ($4k, ceiling: 27)

Total Salary: $49,800 | Projection: 242.5 FP
Floor: 215 | Ceiling: 270 | Avg Ownership: 12%
```

---

## 🔧 Common Filters Added

The AI now has access to these pre-defined filters:

```yaml
safe_cash_plays: "WHERE floor >= 30 AND volatility < 0.20 AND bust_probability < 25"
high_ceiling_gpp: "WHERE ceiling >= 50 AND boom_probability >= 25"
elite_leverage: "WHERE leverage_score >= 3.0 AND boom_probability >= 20"
consistent_producers: "WHERE volatility < 0.15 AND floor >= 25"
boom_bust_candidates: "WHERE volatility >= 0.30 AND ceiling >= 45"
```

---

## 📖 Example Queries the AI Can Now Execute

### **1. Safe Cash Game Cores**
```sql
SELECT name, salary, floor, ceiling, volatility, bust_probability
FROM players
WHERE floor >= 30
  AND volatility < 0.20
  AND bust_probability < 25
ORDER BY floor DESC
LIMIT 15
```

### **2. Elite GPP Leverage**
```sql
SELECT name, salary, leverage_score, boom_probability, rostership, ceiling
FROM players
WHERE leverage_score >= 3.0
  AND boom_probability >= 20
ORDER BY leverage_score DESC
LIMIT 15
```

### **3. Boom/Bust Analysis**
```sql
SELECT name, salary, floor, ceiling, volatility, boom_probability, leverage_score
FROM players
WHERE volatility >= 0.30
  AND ceiling >= 45
  AND leverage_score >= 2.0
ORDER BY leverage_score DESC
```

### **4. Blowout Risk Situations**
```sql
SELECT name, team, opponent, vegas_spread, blowout_risk, floor, ceiling
FROM players
WHERE blowout_risk > 0
ORDER BY blowout_risk DESC
```

---

## 🎓 Strategic Guidance the AI Provides

### **Cash Games**
- **Focus**: Safety, consistency, high floors
- **Metrics**: floor >= 30, volatility < 0.20, bust_probability < 25
- **Reasoning**: Minimize downside risk

### **GPP Tournaments**
- **Focus**: Leverage, ceiling, differentiation
- **Metrics**: leverage_score >= 3.0, ceiling >= 50, boom_probability >= 25
- **Reasoning**: Maximize upside and differentiation from field

### **Hybrid Approach**
- **Focus**: Balanced risk/reward
- **Metrics**: Mix of safe cores + leverage plays
- **Reasoning**: Protect floor while maintaining ceiling

---

## ✅ Testing the Upgrade

Try these prompts with the AI assistant:

1. **"Show me the safest cash game plays with high floors"**
   - Should query using floor, volatility, bust_probability

2. **"Find me leverage bombs for GPP"**
   - Should sort by leverage_score DESC

3. **"Who has the highest ceilings tonight?"**
   - Should query ceiling >= 50 with boom_probability

4. **"Compare boom/bust candidates"**
   - Should show volatility, floor/ceiling spreads

5. **"Build a GPP lineup focused on leverage"**
   - Should prioritize leverage_score in selections

---

## 📊 Summary

The AI assistant now has:
- ✅ Complete knowledge of 9 new advanced metrics
- ✅ Strategic guidance for cash vs GPP
- ✅ 9 new example queries demonstrating advanced analysis
- ✅ Updated query tips with metric thresholds
- ✅ Pre-defined filters for common use cases
- ✅ Leverage scoring as PRIMARY GPP optimization metric

**Result**: The AI can now provide expert-level DFS advice using variance analysis, leverage scoring, and sophisticated cash/GPP strategies!

---

## 🚀 Next Steps

1. **Test the AI assistant** with prompts about leverage, floor, ceiling
2. **Ask for GPP recommendations** and verify it uses leverage_score
3. **Request cash game cores** and verify it prioritizes floor + low volatility
4. **Try hybrid strategies** and see how it balances metrics

The AI is now fully equipped to be your expert DFS advisor! 🏀
