"""
NBA Box Score Fetcher - Azure Function

LEGACY / NON-CANONICAL: historical_games is now loaded from ESPN by the
backend (backend/src/services/espnBoxScoreService.js), nightly via the
HISTORICAL_SYNC_CRON scheduler (backend/src/services/historicalSyncScheduler.js)
or on demand with POST /api/historical/sync. The blob this function writes is
only read by the legacy POST /api/historical/sync { source: 'blob' } import.

Timer-triggered function that runs at 3am EST (8am UTC) daily.
Fetches yesterday's box scores from Basketball Reference and
uploads to Azure Blob Storage.
"""

import azure.functions as func
import logging
import json
import time
from datetime import datetime, timedelta
from typing import List, Dict, Any

import pandas as pd
from basketball_reference_scraper.box_scores import get_box_scores
from basketball_reference_scraper.seasons import get_schedule
from azure.storage.blob import BlobServiceClient
import os


# Season helpers -- mirror backend/src/utils/season.js (seasons roll over October 1st)
KNOWN_SEASON_STARTS = {'2024-25': '2024-10-22', '2025-26': '2025-10-21', '2026-27': '2026-10-20'}


def season_for_date(date_str: str) -> str:
    year, month = int(date_str[:4]), int(date_str[5:7])
    start_year = year if month >= 10 else year - 1
    return f"{start_year}-{(start_year + 1) % 100:02d}"


def season_start_date(season: str) -> str:
    return KNOWN_SEASON_STARTS.get(season, f"{season[:4]}-10-01")


def season_end_year(season: str) -> int:
    return int(season[:4]) + 1


def calculate_dk_fantasy_points(row: Dict) -> float:
    """Calculate DraftKings fantasy points from box score stats"""
    pts = row.get('PTS', 0) or 0
    fg3 = row.get('3P', 0) or 0
    reb = row.get('TRB', 0) or 0
    ast = row.get('AST', 0) or 0
    stl = row.get('STL', 0) or 0
    blk = row.get('BLK', 0) or 0
    tov = row.get('TOV', 0) or 0

    # Base scoring
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
        fantasy_pts += 1.5  # Double-double bonus
    if double_digit_cats >= 3:
        fantasy_pts += 3.0  # Triple-double bonus

    return round(fantasy_pts, 1)


# FanDuel and Yahoo NBA scoring. Keep in sync with backend/src/config/sites.js
# (scoring.fanduel / scoring.yahoo). Neither site has a 3PM or DD/TD bonus.
SITE_SCORING = {
    'fd_fantasy_points': {'PTS': 1.0, 'TRB': 1.2, 'AST': 1.5, 'STL': 3.0, 'BLK': 3.0, 'TOV': -1.0},
    'yahoo_fantasy_points': {'PTS': 1.0, 'TRB': 1.2, 'AST': 1.5, 'STL': 3.0, 'BLK': 3.0, 'TOV': -1.0},
}


def calculate_site_fantasy_points(row: Dict) -> Dict[str, float]:
    """Calculate FanDuel and Yahoo fantasy points from box score stats.

    row uses Basketball Reference keys (PTS, TRB, AST, STL, BLK, TOV).
    Returns {'fd_fantasy_points': ..., 'yahoo_fantasy_points': ...}.
    """
    result = {}
    for field, weights in SITE_SCORING.items():
        total = sum((row.get(stat, 0) or 0) * weight for stat, weight in weights.items())
        result[field] = round(total, 2)
    return result


# Box score JSON field -> Basketball Reference key, for rows already in blob storage
STORED_TO_BREF = {'points': 'PTS', 'rebounds': 'TRB', 'assists': 'AST',
                  'steals': 'STL', 'blocks': 'BLK', 'turnovers': 'TOV'}


def add_missing_site_points(games: List[Dict]) -> int:
    """Fill fd/yahoo points on stored games written before those fields existed"""
    filled = 0
    for game in games:
        if all(field in game for field in SITE_SCORING):
            continue
        row = {bref: game.get(field, 0) for field, bref in STORED_TO_BREF.items()}
        for field, value in calculate_site_fantasy_points(row).items():
            game.setdefault(field, value)
        filled += 1
    return filled


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


def fetch_games_for_date(date_str: str, games_on_date: pd.DataFrame) -> List[Dict[str, Any]]:
    """Fetch all box scores for games on a specific date"""
    all_player_games = []

    for _, game in games_on_date.iterrows():
        home_team = game.get('HOME') or game.get('Home')
        away_team = game.get('VISITOR') or game.get('Visitor') or game.get('AWAY')

        if not home_team or not away_team:
            logging.warning(f"Skipping game - missing team info")
            continue

        try:
            logging.info(f"Fetching {away_team} @ {home_team}...")
            basic = get_box_scores(date_str, home_team, away_team, period='GAME', stat_type='BASIC')

            # Small delay before advanced stats request
            time.sleep(1.5)

            advanced = get_box_scores(date_str, home_team, away_team, period='GAME', stat_type='ADVANCED')

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
                        'is_home': 1 if is_home else 0,
                        'minutes': parse_minutes(row.get('MP')),
                        'points': int(row.get('PTS', 0) or 0),
                        'fg_made': int(row.get('FG', 0) or 0),
                        'fg_attempted': int(row.get('FGA', 0) or 0),
                        'fg_pct': float(row.get('FG%', 0) or 0),
                        'fg3_made': int(row.get('3P', 0) or 0),
                        'fg3_attempted': int(row.get('3PA', 0) or 0),
                        'fg3_pct': float(row.get('3P%', 0) or 0),
                        'ft_made': int(row.get('FT', 0) or 0),
                        'ft_attempted': int(row.get('FTA', 0) or 0),
                        'ft_pct': float(row.get('FT%', 0) or 0),
                        'oreb': int(row.get('ORB', 0) or 0),
                        'dreb': int(row.get('DRB', 0) or 0),
                        'rebounds': int(row.get('TRB', 0) or 0),
                        'assists': int(row.get('AST', 0) or 0),
                        'steals': int(row.get('STL', 0) or 0),
                        'blocks': int(row.get('BLK', 0) or 0),
                        'turnovers': int(row.get('TOV', 0) or 0),
                        'fouls': int(row.get('PF', 0) or 0),
                        'plus_minus': int(row.get('+/-', 0) or 0),
                    }

                    # Calculate DK fantasy points
                    player_game['dk_fantasy_points'] = calculate_dk_fantasy_points(row)
                    player_game.update(calculate_site_fantasy_points(row))

                    # Advanced stats (if available)
                    if adv_df is not None and player_name in adv_df['PLAYER'].values:
                        adv_row = adv_df[adv_df['PLAYER'] == player_name].iloc[0]
                        player_game.update({
                            'ts_pct': float(adv_row.get('TS%', 0) or 0),
                            'efg_pct': float(adv_row.get('eFG%', 0) or 0),
                            'usg_pct': float(adv_row.get('USG%', 0) or 0),
                            'off_rtg': float(adv_row.get('ORtg', 0) or 0),
                            'def_rtg': float(adv_row.get('DRtg', 0) or 0),
                            'bpm': float(adv_row.get('BPM', 0) or 0),
                        })

                    all_player_games.append(player_game)

            logging.info(f"Got {len(all_player_games)} player games so far")

            # Rate limit between games
            time.sleep(3)

        except Exception as e:
            logging.error(f"Error fetching {away_team} @ {home_team}: {e}")
            continue

    return all_player_games


def download_existing_data(blob_service_client: BlobServiceClient) -> List[Dict]:
    """Download existing box_scores.json from blob storage"""
    try:
        blob_client = blob_service_client.get_blob_client(container="nba-data", blob="box_scores.json")
        if blob_client.exists():
            data = blob_client.download_blob().readall()
            return json.loads(data)
    except Exception as e:
        logging.warning(f"Could not download existing data: {e}")
    return []


def get_latest_date(existing_data: List[Dict]) -> str:
    """Get the latest game date from existing data"""
    if not existing_data:
        return None
    dates = [g.get('game_date') for g in existing_data if g.get('game_date')]
    if dates:
        return max(dates)
    return None


def main(mytimer: func.TimerRequest, outputblob: func.Out[str]) -> None:
    utc_timestamp = datetime.utcnow().isoformat()

    if mytimer.past_due:
        logging.info('Timer is past due!')

    logging.info(f'NBA Box Score Sync started at {utc_timestamp}')

    try:
        # Connect to blob storage
        connection_string = os.environ.get('AzureWebJobsStorage')
        blob_service_client = BlobServiceClient.from_connection_string(connection_string)

        # Download existing data
        existing_data = download_existing_data(blob_service_client)
        latest_date = get_latest_date(existing_data)

        logging.info(f"Existing data has {len(existing_data)} games, latest date: {latest_date}")

        filled = add_missing_site_points(existing_data)
        if filled:
            logging.info(f"Added FanDuel/Yahoo points to {filled} existing games")

        # Determine date range to fetch
        yesterday = (datetime.utcnow() - timedelta(days=1)).strftime('%Y-%m-%d')

        if latest_date and latest_date >= yesterday:
            logging.info(f"Data already up to date (latest: {latest_date}, yesterday: {yesterday})")
            # Still output existing data
            outputblob.set(json.dumps(existing_data, indent=2))
            return

        # Start date is day after latest, or season start
        if latest_date:
            start_date = (datetime.strptime(latest_date, '%Y-%m-%d') + timedelta(days=1)).strftime('%Y-%m-%d')
        else:
            start_date = season_start_date(season_for_date(yesterday))

        logging.info(f"Fetching games from {start_date} to {yesterday}")

        # Season schedules keyed by end year (basketball_reference uses 2025 for 2024-25);
        # fetched lazily so a range spanning the offseason covers both seasons
        schedules = {}

        def schedule_for(date_str):
            season_year = season_end_year(season_for_date(date_str))
            if season_year not in schedules:
                try:
                    schedules[season_year] = get_schedule(season_year)
                except Exception as e:
                    logging.error(f"Failed to get {season_year} schedule: {e}")
                    schedules[season_year] = pd.DataFrame()
            return schedules[season_year]

        # Fetch new games
        new_games = []
        current_date = datetime.strptime(start_date, '%Y-%m-%d')
        end_date = datetime.strptime(yesterday, '%Y-%m-%d')

        while current_date <= end_date:
            date_str = current_date.strftime('%Y-%m-%d')
            logging.info(f"Processing {date_str}...")

            schedule = schedule_for(date_str)
            if len(schedule) > 0:
                date_col = 'DATE' if 'DATE' in schedule.columns else 'Date'
                games_today = schedule[schedule[date_col] == date_str]

                if len(games_today) == 0:
                    logging.info(f"No games scheduled for {date_str}")
                    current_date += timedelta(days=1)
                    continue
            else:
                # If no schedule available, skip
                current_date += timedelta(days=1)
                continue

            try:
                day_games = fetch_games_for_date(date_str, games_today)
                new_games.extend(day_games)
                logging.info(f"Total new games collected: {len(new_games)}")
            except Exception as e:
                logging.error(f"Error on {date_str}: {e}")

            # Rate limit between dates
            time.sleep(5)
            current_date += timedelta(days=1)

        # Merge with existing data
        all_games = existing_data + new_games
        logging.info(f"Total games after merge: {len(all_games)}")

        # Upload to blob
        outputblob.set(json.dumps(all_games, indent=2))

        logging.info(f"Successfully synced {len(new_games)} new games. Total: {len(all_games)}")

    except Exception as e:
        logging.error(f"Function failed: {e}")
        raise
