"""Export results + remaining fixtures as one compact JSON file for the static site.

The browser fits the model and runs the simulation itself (site/app.js); this
script only ships the data it needs.

Usage:
    python scripts/export_site_data.py           # export from data/*.csv
    python scripts/export_site_data.py --fetch   # fetch fresh data first
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.config import (  # noqa: E402
    AUTO_PROMOTED, DIVISIONS, FIXTURES_PATH, GAMES_PER_TEAM, LEAGUE, PLAYOFF_PLACES, POINT_DEDUCTIONS,
    RELEGATED, RESULTS_PATH, ROOT, SITE_DATA_PATH as OUT_PATH,
)


def market_probs(row):
    """Bookmaker odds → probabilities with the margin removed (proportionally)."""
    inv = [1 / row.odds_h, 1 / row.odds_d, 1 / row.odds_a]
    total = sum(inv)
    return [round(p / total, 3) for p in inv]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fetch", action="store_true", help="fetch fresh data before exporting")
    args = parser.parse_args()

    if args.fetch:
        from core.data.pipeline import fetch_and_save
        fetch_and_save()

    results = pd.read_csv(RESULTS_PATH, parse_dates=["date"]).sort_values(["date", "div", "home"])
    fixtures = pd.read_csv(FIXTURES_PATH, parse_dates=["date"]).sort_values(["date", "home"])
    season = int(results["season"].max())

    teams = sorted(set(results["home"]) | set(results["away"]) | set(fixtures["home"]) | set(fixtures["away"]))
    idx = {t: i for i, t in enumerate(teams)}
    unknown = set(POINT_DEDUCTIONS) - set(teams)
    if unknown:
        raise SystemExit(f"POINT_DEDUCTIONS names unknown teams: {sorted(unknown)}")

    def result_row(r):
        row = [r.date.strftime("%Y-%m-%d"), idx[r.home], idx[r.away], int(r.hg), int(r.ag), DIVISIONS[r.div]]
        if r.div == LEAGUE and pd.notna(r.odds_h) and min(r.odds_h, r.odds_d, r.odds_a) > 1:
            row += market_probs(r)   # only used to compare the model with the market
        return row

    data = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "season": season,
        "seasonStart": f"{season}-07-01",
        "league": DIVISIONS[LEAGUE],
        "gamesPerTeam": GAMES_PER_TEAM,
        "zones": {"promoted": AUTO_PROMOTED, "playoff": list(PLAYOFF_PLACES), "relegated": RELEGATED},
        "deductions": {idx[t]: pts for t, pts in POINT_DEDUCTIONS.items()},
        "teams": teams,
        # [date, home, away, home goals, away goals, division (0 = Premier League,
        #  1 = Championship, 2 = League One), market P(home), P(draw), P(away)?]
        "results": [result_row(r) for r in results.itertuples()],
        # [date, home, away, round]
        "fixtures": [
            [r.date.strftime("%Y-%m-%d"), idx[r.home], idx[r.away], int(r.round)]
            for r in fixtures.itertuples()
        ],
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(data, separators=(",", ":")))
    print(f"Wrote {OUT_PATH.relative_to(ROOT)}: {len(data['results'])} results, "
          f"{len(data['fixtures'])} fixtures, {OUT_PATH.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
