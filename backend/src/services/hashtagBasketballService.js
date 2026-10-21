import fetch from 'node-fetch';
import teamDefenseVsPositionModel from '../models/teamDefenseVsPositionModel.js';

class HashtagBasketballService {
  constructor() {
    this.url = 'https://hashtagbasketball.com/nba-defense-vs-position';
  }

  async fetchAndStorePositionDefense() {
    try {
      console.log('🏀 Fetching position-specific defense rankings from Hashtag Basketball...');

      const response = await fetch(this.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        }
      });

      if (!response.ok) {
        throw new Error(`Hashtag Basketball fetch failed: ${response.status} ${response.statusText}`);
      }

      const html = await response.text();
      const defenseData = this.parsePositionDefense(html);

      if (defenseData.length === 0) {
        console.warn('⚠️  No position defense data parsed - HTML structure may have changed');
        return { success: false, count: 0 };
      }

      // Store in database
      await teamDefenseVsPositionModel.bulkUpsert(defenseData);

      console.log(`✅ Stored position defense rankings for ${defenseData.length} team-position combinations`);

      return { success: true, count: defenseData.length, data: defenseData };
    } catch (error) {
      console.error('❌ Error fetching Hashtag Basketball position defense:', error.message);
      throw error;
    }
  }

  decodeHtmlEntities(text) {
    // Decode common HTML entities
    return text
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
  }

  parseTeamCell(rawText) {
    // Team cell holds the abbreviation plus the overall DvP rank badge
    // Examples: "NY 3" -> { team: "NY", rank: 3 }, "UTA 150" -> { team: "UTA", rank: 150 }
    const cleaned = this.decodeHtmlEntities(rawText);
    const match = cleaned.match(/^([A-Z]{2,3})\s+(\d+)/);
    return match ? { team: match[1], rank: parseInt(match[2], 10) } : null;
  }

  parseStat(cellText) {
    // Stat cells hold the value followed by its own rank badge: "21.6 28" -> 21.6
    const value = cellText ? parseFloat(cellText) : NaN;
    return isNaN(value) ? null : value;
  }

  parsePositionDefense(html) {
    const defenseData = [];
    const seen = new Set();
    const positions = ['PG', 'SG', 'SF', 'PF', 'C'];

    try {
      // The page has a full table plus "Best/Worst Defense" summary tables that repeat rows
      const tableRowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/g;
      const rows = html.match(tableRowRegex) || [];

      for (const row of rows) {
        // Skip header rows
        if (row.includes('<th') || row.includes('Position')) continue;

        // Extract cells from the row
        const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
        const cells = [];
        let match;
        while ((match = cellRegex.exec(row)) !== null) {
          // Remove HTML tags, decode entities, and get text content
          const cellText = this.decodeHtmlEntities(match[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ');
          cells.push(cellText);
        }

        // Format: [Position, "Team Rank", PTS, FG%, FT%, 3PM, REB, AST, STL, BLK, TO]
        // Rank is the overall rank across all 150 team-position combos (1 = best defense).
        // PTS is real points allowed, not fantasy points. FT% has no column and is skipped.
        if (cells.length < 11) continue;

        const position = cells[0];
        const teamCell = this.parseTeamCell(cells[1]);
        if (!positions.includes(position) || !teamCell) continue;

        const team = this.normalizeTeamAbbr(teamCell.team);
        const key = `${team}_${position}`;
        if (seen.has(key)) continue;
        seen.add(key);

        defenseData.push({
          team,
          position,
          rank: teamCell.rank,
          ptsAllowed: this.parseStat(cells[2]),
          fgPctAllowed: this.parseStat(cells[3]),
          tpmAllowed: this.parseStat(cells[5]),
          rebAllowed: this.parseStat(cells[6]),
          astAllowed: this.parseStat(cells[7]),
          stlAllowed: this.parseStat(cells[8]),
          blkAllowed: this.parseStat(cells[9]),
          toAllowed: this.parseStat(cells[10]),
        });
      }

      return defenseData;
    } catch (error) {
      console.error('Error parsing Hashtag Basketball HTML:', error);
      return [];
    }
  }

  normalizeTeamAbbr(abbr) {
    // Map alternative abbreviations to standard 3-letter codes
    const mapping = {
      'GS': 'GSW',
      'SA': 'SAS',
      'NO': 'NOP',
      'NY': 'NYK',
      'PHX': 'PHO',
    };

    const normalized = abbr.toUpperCase().trim();
    return mapping[normalized] || normalized;
  }
}

export default new HashtagBasketballService();
