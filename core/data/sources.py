"""Download results (football-data.co.uk) and the season schedule (fixturedownload.com)."""
import io
import logging

import pandas as pd
import requests

logger = logging.getLogger(__name__)

FOOTBALL_DATA_URL = "https://www.football-data.co.uk/mmz4281/{code}/{div}.csv"
FIXTURES_URL = "https://fixturedownload.com/feed/json/championship-{year}"

# Closing odds where available, otherwise opening odds; average market first.
ODDS_COLUMNS = [
    ("AvgCH", "AvgCD", "AvgCA"), ("PSCH", "PSCD", "PSCA"), ("B365CH", "B365CD", "B365CA"),
    ("AvgH", "AvgD", "AvgA"), ("PSH", "PSD", "PSA"), ("B365H", "B365D", "B365A"),
]

# fixturedownload.com full names → football-data.co.uk short names. Names that are
# already identical (Burnley, Millwall, ...) need no entry.
TEAM_NAME_MAP = {
    "AFC Wimbledon": "AFC Wimbledon",
    "Barnsley FC": "Barnsley",
    "Birmingham City": "Birmingham",
    "Blackburn Rovers": "Blackburn",
    "Bolton Wanderers": "Bolton",
    "Brighton & Hove Albion": "Brighton",
    "Bristol Rovers": "Bristol Rvs",
    "Burton Albion": "Burton",
    "Cambridge United": "Cambridge",
    "Cardiff City": "Cardiff",
    "Charlton Athletic": "Charlton",
    "Coventry City": "Coventry",
    "Derby County": "Derby",
    "Exeter City": "Exeter",
    "Huddersfield Town": "Huddersfield",
    "Hull City": "Hull",
    "Ipswich Town": "Ipswich",
    "Leeds United": "Leeds",
    "Leicester City": "Leicester",
    "Lincoln City": "Lincoln",
    "Luton Town": "Luton",
    "Manchester City": "Man City",
    "Manchester United": "Man United",
    "Mansfield Town": "Mansfield",
    "Milton Keynes Dons": "Milton Keynes Dons",
    "MK Dons": "Milton Keynes Dons",
    "Newcastle United": "Newcastle",
    "Northampton Town": "Northampton",
    "Norwich City": "Norwich",
    "Nottingham Forest": "Nott'm Forest",
    "Oxford United": "Oxford",
    "Peterborough United": "Peterboro",
    "Plymouth Argyle": "Plymouth",
    "Preston North End": "Preston",
    "Queens Park Rangers": "QPR",
    "Rotherham United": "Rotherham",
    "Sheffield Wednesday": "Sheffield Weds",
    "Shrewsbury Town": "Shrewsbury",
    "Stevenage FC": "Stevenage",
    "Stockport County": "Stockport",
    "Stoke City": "Stoke",
    "Swansea City": "Swansea",
    "Tottenham Hotspur": "Tottenham",
    "West Bromwich Albion": "West Brom",
    "West Ham United": "West Ham",
    "Wigan Athletic": "Wigan",
    "Wolverhampton Wanderers": "Wolves",
    "Wycombe Wanderers": "Wycombe",
}


def season_code(year: int) -> str:
    """2026 → '2627' (football-data.co.uk's folder name for 2026/27)."""
    return f"{year % 100:02d}{(year + 1) % 100:02d}"


def fetch_season(div: str, year: int, session=None) -> pd.DataFrame:
    """One division-season of results with columns
    date, season, div, home, away, hg, ag, odds_h, odds_d, odds_a."""
    url = FOOTBALL_DATA_URL.format(code=season_code(year), div=div)
    resp = (session or requests).get(url, timeout=30)
    resp.raise_for_status()
    raw = pd.read_csv(io.StringIO(resp.content.decode("latin1")), on_bad_lines="skip")
    raw.columns = [c.strip().lstrip("﻿").lstrip("ï»¿") for c in raw.columns]
    raw = raw.dropna(subset=["HomeTeam", "AwayTeam", "FTHG", "FTAG"])

    df = pd.DataFrame({
        "date": pd.to_datetime(raw["Date"], dayfirst=True, format="mixed"),
        "season": year,
        "div": div,
        "home": raw["HomeTeam"].str.strip(),
        "away": raw["AwayTeam"].str.strip(),
        "hg": raw["FTHG"].astype(int),
        "ag": raw["FTAG"].astype(int),
    })
    for col in ("odds_h", "odds_d", "odds_a"):
        df[col] = float("nan")
    for cols in ODDS_COLUMNS:
        if not set(cols) <= set(raw.columns):
            continue
        odds = raw[list(cols)].apply(pd.to_numeric, errors="coerce").to_numpy()
        missing = df["odds_h"].isna().to_numpy()
        df.loc[missing, ["odds_h", "odds_d", "odds_a"]] = odds[missing]
    return df.reset_index(drop=True)


def canonical(name: str, known: set) -> str:
    name = TEAM_NAME_MAP.get(name, name)
    if name not in known:
        raise ValueError(f"Unknown team name {name!r}: add it to TEAM_NAME_MAP")
    return name


def fetch_schedule(year: int, known: set, session=None) -> pd.DataFrame:
    """Every match of the Championship season (played or not) with columns
    date, round, home, away, hg, ag (goals NaN when not played)."""
    resp = (session or requests).get(FIXTURES_URL.format(year=year), timeout=30)
    resp.raise_for_status()
    rows = [{
        "date": pd.Timestamp(m["DateUtc"]).tz_convert("Europe/London").tz_localize(None).normalize(),
        "round": m["RoundNumber"],
        "home": canonical(m["HomeTeam"], known),
        "away": canonical(m["AwayTeam"], known),
        "hg": m["HomeTeamScore"],
        "ag": m["AwayTeamScore"],
    } for m in resp.json()]
    return pd.DataFrame(rows)
