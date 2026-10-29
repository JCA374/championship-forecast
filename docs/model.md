# The model

Everything below runs in the browser (`site/model.js`). Numbers come from
`scripts/evaluate.mjs` on the data as of 29 October 2026.

## Match model: Dixon-Coles across three divisions

For home team *i* and away team *j* in division *d*:

```
home goals ~ Poisson(λ),  λ = exp(α_i + β_j + γ_d)
away goals ~ Poisson(μ),  μ = exp(α_j + β_i)
P(x, y) = τ(x, y; λ, μ, ρ) · Pois(x; λ) · Pois(y; μ)
```

- α = attack, β = defence (higher concedes more), γ_d = home advantage per division,
  ρ = Dixon-Coles low-score correction (τ only touches 0-0, 1-0, 0-1 and 1-1).
- Match weight φ = exp(−ξ · days ago), ξ = 0.0025 per day (half-life ≈ 9 months).
- **Fitted on the Premier League, Championship and League One together** (2014/15 on).
  Every season six clubs enter the Championship from another division; with one shared
  scale they get ratings from their real results instead of a guessed prior.
- Hierarchical prior α_i ~ N(mean of its division, σ²), likewise β, σ = 0.5. A team's
  division is the one it is about to play in (a club relegated in May counts as a
  Championship club from the summer on). The prior is weak: it barely moves the
  predictions (see below), but keeps ratings finite for teams with almost no data.
- Fitting: coordinate updates (closed form/Newton per team), mean attack fixed at 0, then
  a golden-section search for ρ. About 100 ms in the browser.
- Each rating gets a standard error from the curvature of the weighted likelihood:
  `sd(α_i) ≈ 1 / sqrt(Σ w·expected goals scored by i + 1/σ²)`.

### Match-level backtest

Every Championship match from 2021/22 to 2025/26 (2,760 matches), each predicted by a
model fitted only on earlier matches (refitted weekly). RPS = ranked probability score,
lower is better.

| Model | RPS |
|---|---|
| Base rate (same H/D/A odds for every match) | 0.2288 |
| Allsvenskan model unchanged (Championship data only, promoted-team prior) | 0.2204 |
| This model, Championship data only | 0.2196 |
| **Three divisions, ξ = 0.0025** (this site) | **0.2187** |
| Bookmakers' average closing odds | 0.2147 |

Tried, no measurable gain (differences ≤ 0.0001, below the noise): stronger shrinkage
(σ = 0.15–0.25 was *worse*), extra discount at each summer break, down-weighting other
divisions' matches, ξ between 0.0018 and 0.003.

The market is still ~2% better: it knows about injuries, transfers and team news. The
site shows this comparison in its accuracy section.

## Season simulation

Each of the N simulated seasons:

1. **Draws every team's strength** α_i + sd(α_i)·z, β_i + sd(β_i)·z′. Ratings are
   estimates; treating them as exact makes the forecast overconfident.
2. Plays every remaining fixture: independent Poisson goals, accepted with probability
   τ/τ_max (exact Dixon-Coles sampling). What-if picks redraw until the outcome matches.
3. Ranks by points (minus any `POINT_DEDUCTIONS`), goal difference, goals scored, random.
4. Plays the playoffs: 3rd v 6th and 4th v 5th over two legs (higher seed at home in the
   second), extra time at a third of the scoring rate, penalties 50/50; the final at a
   neutral ground (home advantage split evenly).

### Does step 1 help? Replaying ten seasons

Seasons 2016/17–2025/26, forecast from before the season, after round 12 and after
round 30 (720 team-seasons), scored against the real final table:

| Rating uncertainty | 80% points range actually covers | Log score of final position | Position RPS |
|---|---|---|---|
| off (ratings treated as exact) | 70.4% | −2.749 | 0.1141 |
| **on (this site)** | **79.0%** | **−2.712** | **0.1116** |

With uncertainty on, the "80% range" covers 79% of outcomes, as it should; without it,
only 70%.

## Known simplifications

- League ties after goals scored go to a coin flip (the EFL then uses head-to-head).
- Playoff penalties are 50/50.
- Points deductions must be added by hand in `core/config.py`.
- Ratings are constant within a simulated season; form swings beyond the rating
  uncertainty aren't modelled.
