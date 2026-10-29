"""File paths and league constants."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

RESULTS_PATH = ROOT / "data/results.csv"
FIXTURES_PATH = ROOT / "data/fixtures.csv"
SITE_DATA_PATH = ROOT / "site/data.json"

# football-data.co.uk division codes. The model is fitted on all three, so a team
# coming down from the Premier League or up from League One has a real rating.
DIVISIONS = {"E0": 0, "E1": 1, "E2": 2}   # Premier League, Championship, League One
LEAGUE = "E1"
FIRST_SEASON = 2014                        # 2014/15; older matches carry ~no weight

TEAMS = 24
GAMES_PER_TEAM = 46                        # 24 teams, double round-robin
AUTO_PROMOTED = 2                          # 1st and 2nd go up
PLAYOFF_PLACES = (3, 6)                    # 3rd–6th play off for the third spot
RELEGATED = 3                              # 22nd–24th go down

# Points deductions for the current season: {canonical team name: points}.
# The sources only carry results, so deductions have to be entered by hand.
POINT_DEDUCTIONS: dict = {}


def season_of(date) -> int:
    """Start year of the season a date belongs to (seasons run August–May)."""
    return date.year if date.month >= 7 else date.year - 1
