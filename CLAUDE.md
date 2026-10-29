# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

EFL Championship (English second tier) season forecast, adapted from
[allsvenskan-v2](https://github.com/JCA374/allsvenskan-v2). A static site where **the visitor's browser**
fits a Dixon-Coles model and runs the Monte Carlo season simulation (playoffs included). Python only
fetches and exports the match data. Live at https://jca374.github.io/championship-forecast/.

## Layout

| Path | Purpose |
|------|---------|
| `site/index.html`, `site/style.css` | The page (plain HTML/CSS, no build step) |
| `site/app.js` | UI: tiles, table, team-in-focus card, race chart, heatmap, what-if picks, score grids |
| `site/model.js` | Dixon-Coles fit (three divisions), score grids, season + playoff simulation, round replay, backtest |
| `site/worker.js` | Web Worker wrapper around `model.js`; the page runs two (interactive forecast + background replay/backtest) |
| `site/charts.js` | Hand-written SVG charts (line + crosshair, scatter, calibration, columns) and the shared tooltip |
| `site/data.json` | Results + remaining fixtures, written by the export script |
| `data/results.csv`, `data/fixtures.csv` | Saved data (all three divisions; remaining Championship fixtures) |
| `scripts/export_site_data.py` | `--fetch` refreshes `data/*.csv` via `core/data/pipeline.py`, then writes `site/data.json` |
| `scripts/evaluate.mjs` | Offline backtests behind the numbers in `docs/model.md` |
| `core/config.py` | League constants, zones, `POINT_DEDUCTIONS` |
| `core/data/sources.py` | football-data.co.uk results + odds; fixturedownload.com schedule; `TEAM_NAME_MAP` |
| `.github/workflows/pages.yml` | Daily 05:00 UTC + on push: tests → fetch data → deploy `site/` to Pages |

## Commands

```bash
python scripts/export_site_data.py --fetch      # refresh data and site/data.json
python -m http.server -d site 8000               # preview at http://localhost:8000
python -m pytest tests/ -m "not network"         # Python tests (drop -m for live-data tests)
node --test "tests/js/*.test.mjs"                # JS model tests
node scripts/evaluate.mjs matches                # match-level backtest (~10 s)
node scripts/evaluate.mjs seasons 1              # replay 10 seasons (~1 min)
```

## Data

- Results: `https://www.football-data.co.uk/mmz4281/{2627}/{E0,E1,E2}.csv` (Premier League, Championship,
  League One) from 2014/15. Past seasons are downloaded once; the current season every run. Championship rows
  carry de-margined bookmaker closing odds in `data.json`, used only for the accuracy comparison.
- Schedule: `https://fixturedownload.com/feed/json/championship-{year}` (all 552 matches with round numbers).
  It often has a result before football-data does; such results are added to `results.csv`.
- Canonical team names are football-data's (`Wolves`, `West Brom`, `QPR`); `TEAM_NAME_MAP` maps fixturedownload
  names. An unknown name stops the fetch with a clear error: add it to the map.
- `fetch_and_save` refuses to write if results would shrink or the season is not 24 teams × 46 games.
- Seasons run July–June; `season` in `data.json` is the start year, `seasonStart` its first day.
- Points deductions are not in any source: set `POINT_DEDUCTIONS` in `core/config.py`.

## Model notes

See `docs/model.md`. In short: λ = exp(α_home + β_away + γ_division), μ = exp(α_away + β_home), ξ = 0.0025/day,
weak hierarchical prior (σ = 0.5) toward the team's current division, ρ low-score correction. The simulation draws
each team's strength from its rating's standard error every simulated season (checked: 80% ranges cover 79%).
If you change the model, rerun `scripts/evaluate.mjs` and update the tables in `docs/model.md`.
