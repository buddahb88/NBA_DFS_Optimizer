import fetch from 'node-fetch';
import teamDefenseModel from '../models/teamDefenseModel.js';

class EspnScraperService {
  constructor() {
    this.url = 'https://www.espn.com/nba/hollinger/teamstats/_/sort/defensiveEff';
  }

  async fetchAndStoreDefenseRankings() {
    try {
      console.log('🏀 Fetching team defense rankings from ESPN...');

      const response = await fetch(this.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        }
      });

      if (!response.ok) {
        throw new Error(`ESPN fetch failed: ${response.status} ${response.statusText}`);
      }

      const html = await response.text();
      const teams = this.parseHollingerStats(html);

      if (teams.length === 0) {
        console.warn('⚠️  No teams parsed from ESPN - HTML structure may have changed');
        return { success: false, count: 0 };
      }

      // Store in database
      teamDefenseModel.bulkUpsert(teams);

      console.log(`✅ Stored defense rankings for ${teams.length} teams`);

      return { success: true, count: teams.length, teams };
    } catch (error) {
      console.error('❌ Error fetching ESPN defense rankings:', error.message);
      throw error;
    }
  }

  parseHollingerStats(html) {
    const teams = [];

    try {
      // ESPN uses a table structure - extract rows
      // Pattern: <tr>...</tr> with team data
      const tableRowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/g;
      const rows = html.match(tableRowRegex) || [];

      for (const row of rows) {
        // Skip header rows
        if (row.includes('<th') || row.includes('TEAM')) continue;

        // Extract team name from link
        const teamMatch = row.match(/\/nba\/team\/_\/name\/([a-z]+)\/([^"]+)"|>([A-Z][a-z\s]+(?:[A-Z][a-z\s]+)*)<\/a>/);
        if (!teamMatch) continue;

        const teamAbbr = teamMatch[1]?.toUpperCase();
        const teamName = teamMatch[2] || teamMatch[3];

        if (!teamAbbr) continue;

        // Extract all numeric cells
        const cellRegex = /<td[^>]*>([\d.]+)<\/td>/g;
        const cells = [];
        let match;
        while ((match = cellRegex.exec(row)) !== null) {
          cells.push(parseFloat(match[1]));
        }

        // ESPN Hollinger columns (actual positions):
        // 0: RK (rank), 1: PACE, 2: AST, 3: TO, 4: ORR, 5: DRR, 6: REBR, 7: EFF FG%, 8: TS%, 9: OFF EFF, 10: DEF EFF
        if (cells.length >= 11) {
          teams.push({
            team: this.normalizeTeamAbbr(teamAbbr),
            pace: cells[1],      // PACE (not rank!)
            astRatio: cells[2],  // AST
            toRatio: cells[3],   // TO
            rebr: cells[6],      // REBR
            effFgPct: cells[7],  // EFF FG%
            tsPct: cells[8],     // TS%
            offEff: cells[9],    // OFF EFF
            defEff: cells[10],   // DEF EFF
          });
        }
      }

      return teams;
    } catch (error) {
      console.error('Error parsing ESPN HTML:', error);
      return [];
    }
  }

  normalizeTeamAbbr(abbr) {
    // Map ESPN abbreviations to standard 3-letter codes
    const mapping = {
      'GS': 'GSW',
      'SA': 'SAS',
      'NO': 'NOP',
      'NY': 'NYK',
      'PHX': 'PHO',
    };

    return mapping[abbr] || abbr;
  }
}

export default new EspnScraperService();
