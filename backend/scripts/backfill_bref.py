"""
Basketball Reference Backfill Script

Fetches missing game data from Basketball Reference and imports it
directly into the local SQLite database.

Usage: python backfill_bref.py [--from-date YYYY-MM-DD] [--to-date YYYY-MM-DD]
"""

import sqlite3
import time
import argparse
from datetime import datetime, timedelta
from pathlib import Path

import requests
from bs4 import BeautifulSoup
import pandas as pd

try:
    from basketball_reference_scraper.box_scores import get_box_scores
except ImportError:
    print("Installing required packages...")
    import subprocess
    subprocess.check_call(['pip', 'install', 'basketball-reference-scraper', 'pandas', 'beautifulsoup4', 'lxml'])
    from basketball_reference_scraper.box_scores import get_box_scores


# Database path
DB_PATH = Path(__file__).parent.parent / 'data' / 'nba_dfs.db'

# Team abbreviation mappings
TEAM_ABBREVS = {
    'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BRK',
    'Charlotte Hornets': 'CHO', 'Chicago Bulls': 'CHI', 'Cleveland Cavaliers': 'CLE',
    'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN', 'Detroit Pistons': 'DET',
    'Golden State Warriors': 'GSW', 'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND',
    'Los Angeles Clippers': 'LAC', 'Los Angeles Lakers': 'LAL', 'Memphis Grizzlies': 'MEM',
    'Miami Heat': 'MIA', 'Milwaukee Bucks': 'MIL', 'Minnesota Timberwolves': 'MIN',
    'New Orleans Pelicans': 'NOP', 'New York Knicks': 'NYK', 'Oklahoma City Thunder': 'OKC',
    'Orlando Magic': 'ORL', 'Philadelphia 76ers': 'PHI', 'Phoenix Suns': 'PHO',
    'Portland Trail Blazers': 'POR', 'Sacramento Kings': 'SAC', 'San Antonio Spurs': 'SAS',
    'Toronto Raptors': 'TOR', 'Utah Jazz': 'UTA', 'Washington Wizards': 'WAS'
}


def calculate_dk_fantasy_points(row: dict) -> float:
    """Calculate DraftKings fantasy points from box score stats"""
    pts = row.get('points', 0) or 0
    fg3 = row.get('fg3_made', 0) or 0
    reb = row.get('rebounds', 0) or 0
    ast = row.get('assists', 0) or 0
    stl = row.get('steals', 0) or 0
    blk = row.get('blocks', 0) or 0
    tov = row.get('turnovers', 0) or 0

    fantasy_pts = (
        pts * 1.0 +
        fg3 * 0.5 +
        reb * 1.25 +
        ast * 1.5 +
        stl * 2.0 +
        blk * 2.0 +
        tov * -0.5
    )

    # Double-double and triple-double bonuses
    double_digit_cats = sum([
        1 if pts >= 10 else 0,
        1 if reb >= 10 else 0,
        1 if ast >= 10 else 0,
        1 if stl >= 10 else 0,
        1 if blk >= 10 else 0
    ])

    if double_digit_cats >= 2:
        fantasy_pts += 1.5
    if double_digit_cats >= 3:
        fantasy_pts += 3.0

    return round(fantasy_pts, 1)


def parse_minutes(mp_str) -> float:
    """Parse minutes string 'MM:SS' to decimal minutes"""
    if pd.isna(mp_str) or mp_str == '' or mp_str is None:
        return 0.0
    if isinstance(mp_str, (int, float)):
        return float(mp_str)
    try:
        if ':' in str(mp_str):
            parts = str(mp_str).split(':')
            return int(parts[0]) + int(parts[1]) / 60
        return float(mp_str)
    except:
        return 0.0


def get_games_on_date(date_str: str) -> list:
    """Scrape the basketball-reference daily page to find all games on a date"""
    date_parts = date_str.split('-')
    url = f"https://www.basketball-reference.com/boxscores/?month={date_parts[1]}&day={date_parts[2]}&year={date_parts[0]}"

    try:
        response = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=30)
        soup = BeautifulSoup(response.text, 'html.parser')

        games = []
        game_summaries = soup.find_all('div', class_='game_summary')

        for game_div in game_summaries:
            try:
                # Find team links
                teams = game_div.find_all('a', href=lambda x: x and '/teams/' in x)
                if len(teams) >= 2:
                    away_name = teams[0].text.strip()
                    home_name = teams[1].text.strip()

                    away_abbr = TEAM_ABBREVS.get(away_name, away_name[:3].upper())
                    home_abbr = TEAM_ABBREVS.get(home_name, home_name[:3].upper())

                    games.append({'away': away_abbr, 'home': home_abbr})
            except:
                continue

        return games
    except Exception as e:
        print(f"  Error fetching daily page: {e}")
        return []


def fetch_single_game(date_str: str, home_team: str, away_team: str) -> list:
    """Fetch box score for a single game"""
    all_player_games = []

    try:
        print(f"    {away_team} @ {home_team}...")
        basic = get_box_scores(date_str, home_team, away_team, period='GAME', stat_type='BASIC')

        time.sleep(2)

        try:
            advanced = get_box_scores(date_str, home_team, away_team, period='GAME', stat_type='ADVANCED')
        except:
            advanced = {}

        # Process each team
        for team, opponent, is_home in [(home_team, away_team, True), (away_team, home_team, False)]:
            if team not in basic or basic[team] is None:
                continue

            basic_df = basic[team]
            adv_df = advanced.get(team) if advanced else None

            for idx, row in basic_df.iterrows():
                player_name = row.get('PLAYER', '')
                if not player_name or player_name in ['Team Totals', 'Totals']:
                    continue

                player_game = {
                    'player_name': player_name,
                    'team': team,
                    'opponent': opponent,
                    'game_date': date_str,
                    'season': '2024-25',
                    'is_home': 1 if is_home else 0,
                    'minutes': parse_minutes(row.get('MP')),
                    'points': int(row.get('PTS', 0) or 0),
                    'fg_made': int(row.get('FG', 0) or 0),
                    'fg_attempted': int(row.get('FGA', 0) or 0),
                    'fg3_made': int(row.get('3P', 0) or 0),
                    'fg3_attempted': int(row.get('3PA', 0) or 0),
                    'ft_made': int(row.get('FT', 0) or 0),
                    'ft_attempted': int(row.get('FTA', 0) or 0),
                    'oreb': int(row.get('ORB', 0) or 0),
                    'dreb': int(row.get('DRB', 0) or 0),
                    'rebounds': int(row.get('TRB', 0) or 0),
                    'assists': int(row.get('AST', 0) or 0),
                    'steals': int(row.get('STL', 0) or 0),
                    'blocks': int(row.get('BLK', 0) or 0),
                    'turnovers': int(row.get('TOV', 0) or 0),
                    'plus_minus': int(row.get('+/-', 0) or 0),
                    'ts_pct': 0, 'usg_pct': 0, 'off_rtg': 0, 'def_rtg': 0
                }

                player_game['dk_fantasy_points'] = calculate_dk_fantasy_points(player_game)

                # Advanced stats
                if adv_df is not None and player_name in adv_df['PLAYER'].values:
                    try:
                        adv_row = adv_df[adv_df['PLAYER'] == player_name].iloc[0]
                        player_game['ts_pct'] = float(adv_row.get('TS%', 0) or 0)
                        player_game['usg_pct'] = float(adv_row.get('USG%', 0) or 0)
                        player_game['off_rtg'] = float(adv_row.get('ORtg', 0) or 0)
                        player_game['def_rtg'] = float(adv_row.get('DRtg', 0) or 0)
                    except:
                        pass

                all_player_games.append(player_game)

        print(f"      Got {len(all_player_games)} player games")

    except Exception as e:
        print(f"      Error: {e}")

    return all_player_games


def get_latest_game_date(conn: sqlite3.Connection) -> str:
    """Get the latest game date from the database"""
    cursor = conn.execute("SELECT MAX(game_date) FROM historical_games")
    result = cursor.fetchone()[0]
    return result


def insert_games(conn: sqlite3.Connection, games: list) -> int:
    """Insert games into the database, skipping duplicates"""
    inserted = 0

    for game in games:
        try:
            conn.execute("""
                INSERT OR IGNORE INTO historical_games
                (player_name, team, opponent, game_date, season, is_home,
                 minutes, points, rebounds, assists, steals, blocks, turnovers,
                 fg_made, fg_attempted, fg3_made, fg3_attempted, ft_made, ft_attempted,
                 oreb, dreb, plus_minus, dk_fantasy_points, ts_pct, usg_pct, off_rtg, def_rtg)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                game['player_name'], game['team'], game['opponent'],
                game['game_date'], game.get('season', '2024-25'), game['is_home'],
                game['minutes'], game['points'], game['rebounds'],
                game['assists'], game['steals'], game['blocks'], game['turnovers'],
                game['fg_made'], game['fg_attempted'], game['fg3_made'],
                game['fg3_attempted'], game['ft_made'], game['ft_attempted'],
                game['oreb'], game['dreb'], game['plus_minus'],
                game['dk_fantasy_points'],
                game.get('ts_pct', 0), game.get('usg_pct', 0),
                game.get('off_rtg', 0), game.get('def_rtg', 0)
            ))
            if conn.total_changes > inserted:
                inserted += 1
        except Exception as e:
            print(f"  Error inserting {game['player_name']}: {e}")

    conn.commit()
    return inserted


def main():
    parser = argparse.ArgumentParser(description='Backfill NBA historical data from Basketball Reference')
    parser.add_argument('--from-date', type=str, help='Start date (YYYY-MM-DD)')
    parser.add_argument('--to-date', type=str, help='End date (YYYY-MM-DD)')
    args = parser.parse_args()

    print(f"\n{'='*60}")
    print(f"  Basketball Reference Backfill")
    print(f"{'='*60}")
    print(f"Database: {DB_PATH}")

    conn = sqlite3.connect(DB_PATH)

    latest_in_db = get_latest_game_date(conn)
    print(f"Latest game in database: {latest_in_db}")

    if args.from_date:
        start_date = args.from_date
    elif latest_in_db:
        start_date = (datetime.strptime(latest_in_db, '%Y-%m-%d') + timedelta(days=1)).strftime('%Y-%m-%d')
    else:
        start_date = '2024-10-22'

    end_date = args.to_date or (datetime.now() - timedelta(days=1)).strftime('%Y-%m-%d')

    print(f"Backfilling from {start_date} to {end_date}")

    current_date = datetime.strptime(start_date, '%Y-%m-%d')
    end = datetime.strptime(end_date, '%Y-%m-%d')
    total_inserted = 0

    while current_date <= end:
        date_str = current_date.strftime('%Y-%m-%d')
        print(f"\n[{date_str}]")

        # Get games on this date
        games_list = get_games_on_date(date_str)

        if not games_list:
            print("  No games found")
            current_date += timedelta(days=1)
            continue

        print(f"  Found {len(games_list)} games")

        day_games = []
        for game in games_list:
            player_games = fetch_single_game(date_str, game['home'], game['away'])
            day_games.extend(player_games)
            time.sleep(3)  # Rate limit

        if day_games:
            inserted = insert_games(conn, day_games)
            total_inserted += inserted
            print(f"  Inserted {inserted} player games (total: {total_inserted})")

        time.sleep(5)  # Rate limit between dates
        current_date += timedelta(days=1)

    conn.close()

    print(f"\n{'='*60}")
    print(f"  Backfill Complete!")
    print(f"  Total player games inserted: {total_inserted}")
    print(f"{'='*60}\n")


if __name__ == '__main__':
    main()
