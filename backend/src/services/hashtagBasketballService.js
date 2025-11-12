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
      teamDefenseVsPositionModel.bulkUpsert(defenseData);

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

  extractTeamAbbr(rawText) {
    // Clean up HTML entities and extra whitespace
    const cleaned = this.decodeHtmlEntities(rawText);

    // Extract just the team abbreviation (2-3 uppercase letters at the start)
    // Examples: "NY 3" -> "NY", "CLE 4" -> "CLE", "OKC 9" -> "OKC"
    const match = cleaned.match(/^([A-Z]{2,3})/);
    return match ? match[1] : cleaned;
  }

  parsePositionDefense(html) {
    const defenseData = [];
    const positions = ['PG', 'SG', 'SF', 'PF', 'C'];

    try {
      // Find table rows - Hashtag Basketball uses a table structure
      // Pattern: <tr>...</tr> with position and team data
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
          const cellText = this.decodeHtmlEntities(match[1].replace(/<[^>]*>/g, ''));
          cells.push(cellText);
        }

        // Expected format: [Position, Team, Rank, PTS, FG%, 3PM, REB, AST, STL, BLK, TO]
        if (cells.length >= 3) {
          const position = cells[0];
          const rawTeam = cells[1];
          const rank = parseInt(cells[2]);

          // Extract clean team abbreviation
          const team = this.extractTeamAbbr(rawTeam);

          // Only process if valid position and rank
          if (positions.includes(position) && !isNaN(rank) && team) {
            defenseData.push({
              team: this.normalizeTeamAbbr(team),
              position: position,
              rank: rank,
              ptsAllowed: cells[3] ? parseFloat(cells[3]) : null,
              fgPctAllowed: cells[4] ? parseFloat(cells[4]) : null,
              tpmAllowed: cells[5] ? parseFloat(cells[5]) : null,
              rebAllowed: cells[6] ? parseFloat(cells[6]) : null,
              astAllowed: cells[7] ? parseFloat(cells[7]) : null,
              stlAllowed: cells[8] ? parseFloat(cells[8]) : null,
              blkAllowed: cells[9] ? parseFloat(cells[9]) : null,
              toAllowed: cells[10] ? parseFloat(cells[10]) : null,
            });
          }
        }
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
