"""Refresh data/results.csv and data/fixtures.csv."""
import pandas as pd
import requests

from core.config import (
    DIVISIONS, FIRST_SEASON, FIXTURES_PATH, GAMES_PER_TEAM, LEAGUE, RESULTS_PATH, TEAMS, season_of,
)
from core.data.sources import fetch_schedule, fetch_season

KEY = ["date", "home", "away"]


def fetch_and_save(today=None):
    """Download missing past seasons and the current one, then save results and
    the remaining Championship fixtures.

    Raises RuntimeError if the saved results would shrink or the season does not
    add up to TEAMS teams with GAMES_PER_TEAM games each.
    """
    today = pd.Timestamp(today or pd.Timestamp.now()).normalize()
    current = season_of(today)
    session = requests.Session()

    saved = pd.read_csv(RESULTS_PATH, parse_dates=["date"]) if RESULTS_PATH.exists() else None
    have = set() if saved is None else set(zip(saved["div"], saved["season"]))

    frames = [] if saved is None else [saved[saved["season"] != current]]
    for div in DIVISIONS:
        for year in range(FIRST_SEASON, current + 1):
            if year == current or (div, year) not in have:
                print(f"  fetching {div} {year}/{(year + 1) % 100:02d}")
                frames.append(fetch_season(div, year, session))
    results = pd.concat(frames, ignore_index=True)

    # The schedule site often has a result a day or two before football-data does.
    known = set(results["home"]) | set(results["away"])
    schedule = fetch_schedule(current, known, session)
    league_now = results[(results["div"] == LEAGUE) & (results["season"] == current)]
    played_pairs = set(zip(league_now["home"], league_now["away"]))
    unplayed = pd.Series([p not in played_pairs for p in zip(schedule["home"], schedule["away"])],
                         index=schedule.index)
    extra = schedule[unplayed & schedule["hg"].notna()]
    if len(extra):
        print(f"  {len(extra)} result(s) only in the schedule feed so far")
        results = pd.concat([results, extra.drop(columns="round").assign(
            season=current, div=LEAGUE, hg=extra["hg"].astype(int), ag=extra["ag"].astype(int))],
            ignore_index=True)
    fixtures = schedule[unplayed & schedule["hg"].isna()].drop(columns=["hg", "ag"])

    results = results.drop_duplicates(subset=KEY + ["div"], keep="last").sort_values(["date", "div", "home"])
    if saved is not None and len(results) < len(saved):
        raise RuntimeError(f"Refusing to overwrite results: {len(results)} rows vs {len(saved)} saved")

    league_now = results[(results["div"] == LEAGUE) & (results["season"] == current)]
    bad = check_games_per_team(league_now, fixtures)
    if bad:
        raise RuntimeError("Games-per-team check failed: " + "; ".join(bad))

    RESULTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    results.to_csv(RESULTS_PATH, index=False, date_format="%Y-%m-%d")
    fixtures.sort_values(["date", "home"]).to_csv(FIXTURES_PATH, index=False, date_format="%Y-%m-%d")
    print(f"  {len(league_now)} Championship matches played · {len(fixtures)} to play · "
          f"{len(results)} results saved")
    return results, fixtures


def check_games_per_team(results, fixtures, teams=TEAMS, games=GAMES_PER_TEAM):
    """Problems with the season's shape, as readable strings (empty = fine)."""
    counts = pd.concat([results["home"], results["away"], fixtures["home"], fixtures["away"]]).value_counts()
    bad = [f"{team}: {n} games" for team, n in counts.items() if n != games]
    if len(counts) != teams:
        bad.append(f"{len(counts)} teams, expected {teams}")
    return bad
