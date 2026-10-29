"""Tests for the data pipeline (no network unless marked)."""
import json

import pandas as pd
import pytest

from core.config import GAMES_PER_TEAM, ROOT, TEAMS, season_of
from core.data.pipeline import check_games_per_team
from core.data.sources import TEAM_NAME_MAP, canonical, fetch_schedule, fetch_season, season_code


def test_season_code():
    assert season_code(2026) == "2627"
    assert season_code(1999) == "9900"


def test_season_of_splits_in_july():
    assert season_of(pd.Timestamp("2026-08-14")) == 2026
    assert season_of(pd.Timestamp("2027-05-02")) == 2026


def test_canonical_names():
    known = set(TEAM_NAME_MAP.values()) | {"Burnley"}
    assert canonical("Wolverhampton Wanderers", known) == "Wolves"
    assert canonical("Burnley", known) == "Burnley"
    with pytest.raises(ValueError):
        canonical("Real Madrid", known)


def test_games_per_team_check():
    teams = [f"T{i}" for i in range(4)]
    fixtures = pd.DataFrame([(h, a) for h in teams for a in teams if h != a], columns=["home", "away"])
    empty = fixtures.iloc[:0]
    assert check_games_per_team(empty, fixtures, teams=4, games=6) == []
    assert check_games_per_team(empty, fixtures.iloc[1:], teams=4, games=6)


def test_committed_site_data_is_a_complete_season():
    data = json.loads((ROOT / "site/data.json").read_text())
    season = [r for r in data["results"] if r[0] >= data["seasonStart"] and r[5] == data["league"]]
    games = pd.Series([t for r in season for t in r[1:3]] + [t for f in data["fixtures"] for t in f[1:3]]).value_counts()
    assert len(games) == TEAMS
    assert (games == GAMES_PER_TEAM).all()
    for r in data["results"]:
        if len(r) > 6:
            assert abs(sum(r[6:9]) - 1) < 0.01


@pytest.mark.network
def test_live_sources():
    df = fetch_season("E1", 2025)
    assert len(df) == 552
    assert df["odds_h"].notna().all()
    known = set(df["home"]) | set(fetch_season("E1", 2026)["home"])
    schedule = fetch_schedule(2026, known)
    assert len(schedule) == 552
