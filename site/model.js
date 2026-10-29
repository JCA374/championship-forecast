// Dixon-Coles model + Monte Carlo season simulation, run in the visitor's browser.
//
//   λ = exp(α_home + β_away + γ_div)   μ = exp(α_away + β_home)
//
// Fitted on the Premier League, Championship and League One together, so every
// team (including those just relegated or promoted) has a rating on one scale.
// Matches are weighted by φ(t) = exp(−ξ·days_ago); γ is a home advantage per
// division; ρ is the Dixon-Coles low-score correction.
//
// Ratings have a hierarchical prior: α_i ~ N(mean α of the team's division, σ²),
// likewise β. It shrinks teams with little recent data toward their division and
// gives every rating a standard error, which the season simulation uses so that
// the forecast carries the uncertainty about how good each team really is.

export const MAX_GOALS = 10;
const S = MAX_GOALS + 1;
const DAY_MS = 86400000;
export const DEFAULTS = { xi: 0.0025, sigma: 0.5 };   // chosen by backtest, see docs/model.md

export function fitModel(data, { xi = DEFAULTS.xi, sigma = DEFAULTS.sigma, maxIter = 400, tol = 1e-6, init = null } = {}) {
  const n = data.teams.length;
  const ref = Date.parse(data.results[data.results.length - 1][0]);
  // matches older than ~8 years carry < 0.5% weight: skip them
  const rows = data.results.filter((r) => xi * (ref - Date.parse(r[0])) / DAY_MS < 5.3);
  const nDiv = 1 + Math.max(...rows.map((r) => r[5]));

  const m = rows.length;
  const H = new Int32Array(m), A = new Int32Array(m), D = new Int32Array(m);
  const GH = new Float64Array(m), GA = new Float64Array(m), W = new Float64Array(m);
  const division = new Int32Array(n).fill(-1);   // each team's latest division
  rows.forEach(([date, h, a, gh, ga, div], k) => {
    H[k] = h; A[k] = a; D[k] = div;
    GH[k] = Math.min(gh, 9); GA[k] = Math.min(ga, 9);
    W[k] = Math.exp(-xi * (ref - Date.parse(date)) / DAY_MS);
    division[h] = div; division[a] = div;
  });
  // teams with league fixtures still to play belong to the league now (e.g. a club
  // relegated in May is a Championship team from the summer on)
  for (const [, h, a] of data.fixtures ?? []) { division[h] = data.league; division[a] = data.league; }
  for (let i = 0; i < n; i++) if (division[i] < 0) division[i] = data.league ?? 0;

  const scored = new Float64Array(n), conceded = new Float64Array(n), weight = new Float64Array(n);
  const homeGoals = new Float64Array(nDiv);
  for (let k = 0; k < m; k++) {
    scored[H[k]] += W[k] * GH[k]; scored[A[k]] += W[k] * GA[k];
    conceded[A[k]] += W[k] * GH[k]; conceded[H[k]] += W[k] * GA[k];
    weight[H[k]] += W[k]; weight[A[k]] += W[k];
    homeGoals[D[k]] += W[k] * GH[k];
  }

  const att = new Float64Array(n), def = new Float64Array(n);
  const gamma = new Float64Array(nDiv).fill(0.25);
  if (init) { att.set(init.attack); def.set(init.defence); gamma.set(init.homeAdv.slice(0, nDiv)); }
  const prec = sigma > 0 ? 1 / (sigma * sigma) : 0;
  const den = new Float64Array(n), ex = new Float64Array(n);
  const egOf = new Float64Array(nDiv);

  // Mean rating per division. A plain mean: that is the prior mean's maximum-likelihood
  // value, so the coordinate updates below share one fixed point.
  const divMean = (v) => {
    const s = new Float64Array(nDiv), c = new Float64Array(nDiv);
    for (let i = 0; i < n; i++) if (weight[i] > 0) { s[division[i]] += v[i]; c[division[i]]++; }
    return Array.from(s, (x, d) => (c[d] ? x / c[d] : 0));
  };
  // Solve  goals − e^v·den − prec·(v − prior) = 0  for v (Newton; closed form if prec = 0).
  const solve = (v, goals, dn, prior) => {
    if (dn <= 0) return prior;
    if (!prec) return Math.log(Math.max(goals, 1e-9) / dn);
    for (let s = 0; s < 4; s++) {
      const e = Math.exp(v) * dn;
      v -= (goals - e - prec * (v - prior)) / (-e - prec);
    }
    return v;
  };

  for (let it = 0; it < maxIter; it++) {
    let change = 0;
    for (let d = 0; d < nDiv; d++) egOf[d] = Math.exp(gamma[d]);

    const mAtt = divMean(att);
    for (let i = 0; i < n; i++) ex[i] = Math.exp(def[i]);
    den.fill(0);
    for (let k = 0; k < m; k++) {
      den[H[k]] += W[k] * ex[A[k]] * egOf[D[k]];
      den[A[k]] += W[k] * ex[H[k]];
    }
    for (let i = 0; i < n; i++) {
      const v = solve(att[i], scored[i], den[i], mAtt[division[i]]);
      change = Math.max(change, Math.abs(v - att[i])); att[i] = v;
    }

    const mDef = divMean(def);
    for (let i = 0; i < n; i++) ex[i] = Math.exp(att[i]);
    den.fill(0);
    for (let k = 0; k < m; k++) {
      den[A[k]] += W[k] * ex[H[k]] * egOf[D[k]];
      den[H[k]] += W[k] * ex[A[k]];
    }
    for (let i = 0; i < n; i++) {
      const v = solve(def[i], conceded[i], den[i], mDef[division[i]]);
      change = Math.max(change, Math.abs(v - def[i])); def[i] = v;
    }

    const gd = new Float64Array(nDiv);
    for (let i = 0; i < n; i++) ex[i] = Math.exp(att[i]);
    const ed = def.map(Math.exp);
    for (let k = 0; k < m; k++) gd[D[k]] += W[k] * ex[H[k]] * ed[A[k]];
    for (let d = 0; d < nDiv; d++) {
      if (!gd[d]) continue;
      const v = Math.log(homeGoals[d] / gd[d]);
      change = Math.max(change, Math.abs(v - gamma[d])); gamma[d] = v;
    }

    // identifiability: weighted mean attack = 0 (the shift is absorbed by defence)
    let shift = 0, tw = 0;
    for (let i = 0; i < n; i++) { shift += weight[i] * att[i]; tw += weight[i]; }
    shift /= tw;
    for (let i = 0; i < n; i++) { att[i] -= shift; def[i] += shift; }

    if (change < tol) break;
  }

  // ρ: maximise Σ w·log τ over [−0.2, 0.2] by golden-section search
  const lowScore = [];
  for (let k = 0; k < m; k++) {
    if (GH[k] <= 1 && GA[k] <= 1) {
      const lam = Math.exp(att[H[k]] + def[A[k]] + gamma[D[k]]), mu = Math.exp(att[A[k]] + def[H[k]]);
      lowScore.push([GH[k], GA[k], lam, mu, W[k]]);
    }
  }
  const ll = (rho) => {
    let s = 0;
    for (const [x, y, lam, mu, w] of lowScore) {
      const t = tau(x, y, lam, mu, rho);
      if (t <= 0) return -Infinity;
      s += w * Math.log(t);
    }
    return s;
  };
  let lo = -0.2, hi = 0.2;
  const g = (Math.sqrt(5) - 1) / 2;
  for (let it = 0; it < 50; it++) {
    const c = hi - g * (hi - lo), d = lo + g * (hi - lo);
    if (ll(c) > ll(d)) hi = d; else lo = c;
  }
  const rho = (lo + hi) / 2;

  // Standard errors from the curvature of the (weighted) log-likelihood + prior:
  // var(α_i) ≈ 1 / (expected goals scored by i, weighted + prior precision).
  const expScored = new Float64Array(n), expConceded = new Float64Array(n);
  for (let k = 0; k < m; k++) {
    const lam = W[k] * Math.exp(att[H[k]] + def[A[k]] + gamma[D[k]]), mu = W[k] * Math.exp(att[A[k]] + def[H[k]]);
    expScored[H[k]] += lam; expScored[A[k]] += mu;
    expConceded[A[k]] += lam; expConceded[H[k]] += mu;
  }
  const attSd = Array.from(expScored, (e) => 1 / Math.sqrt(e + prec || 1));
  const defSd = Array.from(expConceded, (e) => 1 / Math.sqrt(e + prec || 1));

  const homeAdv = Array.from(gamma);
  return {
    attack: Array.from(att), defence: Array.from(def), attSd, defSd,
    homeAdv, gamma: homeAdv[data.league ?? 0], rho, division: Array.from(division),
  };
}

function tau(x, y, lam, mu, rho) {
  if (x === 0 && y === 0) return 1 - lam * mu * rho;
  if (x === 0 && y === 1) return 1 + lam * rho;
  if (x === 1 && y === 0) return 1 + mu * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

const clip = (v) => Math.min(4, Math.max(-5, v));

// Expected goals. `neutral` splits the home advantage evenly (playoff final).
export function expectedGoals(model, home, away, { neutral = false } = {}) {
  const gh = neutral ? model.gamma / 2 : model.gamma, ga = neutral ? model.gamma / 2 : 0;
  return [
    Math.exp(clip(model.attack[home] + model.defence[away] + gh)),
    Math.exp(clip(model.attack[away] + model.defence[home] + ga)),
  ];
}

function poissonPmf(mean) {
  const p = new Float64Array(S);
  p[0] = Math.exp(-mean);
  for (let k = 1; k < S; k++) p[k] = p[k - 1] * mean / k;
  return p;
}

// Full score grid, flattened: grid[h * S + a] = P(home h, away a)
export function scoreGrid(model, home, away) {
  const [lam, mu] = expectedGoals(model, home, away);
  const ph = poissonPmf(lam), pa = poissonPmf(mu);
  const grid = new Float64Array(S * S);
  let total = 0;
  for (let h = 0; h < S; h++) {
    for (let a = 0; a < S; a++) {
      let p = ph[h] * pa[a];
      if (h <= 1 && a <= 1) p *= Math.max(1e-6, tau(h, a, lam, mu, model.rho));
      grid[h * S + a] = p;
      total += p;
    }
  }
  for (let i = 0; i < grid.length; i++) grid[i] /= total;
  return { grid, lam, mu };
}

export function matchProbabilities(model, home, away) {
  const { grid, lam, mu } = scoreGrid(model, home, away);
  let win = 0, draw = 0, loss = 0, best = 0, bestScore = [0, 0];
  for (let h = 0; h < S; h++) {
    for (let a = 0; a < S; a++) {
      const p = grid[h * S + a];
      if (h > a) win += p; else if (h === a) draw += p; else loss += p;
      if (p > best) { best = p; bestScore = [h, a]; }
    }
  }
  return { home: win, draw, away: loss, lam, mu, likelyScore: bestScore, grid };
}

const inSeason = (data, r) => r[0] >= data.seasonStart && r[5] === data.league;

// Current league table (points include any deductions).
export function currentTable(data) {
  const n = data.teams.length;
  const t = Array.from({ length: n }, (_, i) => ({ played: 0, pts: -(data.deductions?.[i] ?? 0), gf: 0, ga: 0, w: 0, d: 0, l: 0 }));
  const active = new Set();
  for (const r of data.results) {
    if (!inSeason(data, r)) continue;
    const [, h, a, gh, ga] = r;
    active.add(h); active.add(a);
    t[h].played++; t[a].played++;
    t[h].gf += gh; t[h].ga += ga; t[a].gf += ga; t[a].ga += gh;
    if (gh > ga) { t[h].pts += 3; t[h].w++; t[a].l++; }
    else if (gh < ga) { t[a].pts += 3; t[a].w++; t[h].l++; }
    else { t[h].pts++; t[a].pts++; t[h].d++; t[a].d++; }
  }
  for (const [, h, a] of data.fixtures) { active.add(h); active.add(a); }
  return { table: t, teams: [...active].sort((x, y) => x - y) };
}

export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rand) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function poisson(rand, mean) {
  const L = Math.exp(-mean);
  let k = 0, p = rand();
  while (p > L && k < MAX_GOALS) { k++; p *= rand(); }
  return k;
}

// Draw one Dixon-Coles score: independent Poissons, accepted with probability τ/τmax.
function drawScore(rand, lam, mu, rho) {
  const tmax = Math.max(1, 1 - lam * mu * rho, 1 + lam * rho, 1 + mu * rho, 1 - rho);
  for (;;) {
    const h = poisson(rand, lam), a = poisson(rand, mu);
    if (h > 1 || a > 1 || rand() * tmax < tau(h, a, lam, mu, rho)) return [h, a];
  }
}

const outcomeOf = (h, a) => (h > a ? 'H' : h === a ? 'D' : 'A');
const FORCED = { H: [1, 0], D: [1, 1], A: [0, 1] };

// Simulate the rest of the season `nSims` times, then the playoffs.
//
// Each simulated season first draws every team's "true" strength from its rating's
// standard error (`uncertainty` scales this; 0 = treat the ratings as exact), then
// draws every match score from Dixon-Coles. `overrides` maps a fixture index to
// 'H' | 'D' | 'A'; such a match is redrawn until it has that outcome, so goal
// difference stays realistic. Ranking: points, goal difference, goals scored, then random.
//
// Playoffs: 3rd v 6th and 4th v 5th over two legs (higher seed at home in the
// second), extra time at a third of the scoring rate, then penalties (50/50).
// The final is at a neutral ground.
export function simulateSeason(data, model, { nSims = 10000, seed = 1, overrides = {}, uncertainty = 1 } = {}) {
  const rand = mulberry32(seed);
  const { table, teams } = currentTable(data);
  const T = teams.length;
  const zones = data.zones ?? { promoted: 2, playoff: [3, 6], relegated: 3 };
  const slot = new Map(teams.map((t, i) => [t, i]));
  const matches = data.fixtures.map(([, h, a], idx) => ({ h: slot.get(h), a: slot.get(a), fixed: overrides[idx] }));

  const baseAtt = teams.map((t) => model.attack[t]), baseDef = teams.map((t) => model.defence[t]);
  const sdAtt = teams.map((t) => uncertainty * (model.attSd?.[t] ?? 0));
  const sdDef = teams.map((t) => uncertainty * (model.defSd?.[t] ?? 0));
  const att = new Float64Array(T), def = new Float64Array(T);
  const { gamma, rho } = model;
  const xg = (h, a, gh, ga) => [Math.exp(clip(att[h] + def[a] + gh)), Math.exp(clip(att[a] + def[h] + ga))];

  const MAX_PTS = 3 * (data.gamesPerTeam ?? 46) + 1;
  const positions = Array.from({ length: T }, () => new Float64Array(T));
  const ptsHist = Array.from({ length: T }, () => new Float64Array(MAX_PTS));
  const ptsSum = new Float64Array(T), promoted = new Float64Array(T), playoffWin = new Float64Array(T);
  const pts = new Int32Array(T), gd = new Int32Array(T), gf = new Int32Array(T);
  const tiebreak = new Float64Array(T);
  const order = teams.map((_, i) => i);

  // two-legged tie, `high` at home in the second leg; returns the winner
  const tie = (high, low) => {
    let [a1, h1] = drawScore(rand, ...xg(low, high, gamma, 0), rho);
    const [h2, a2] = drawScore(rand, ...xg(high, low, gamma, 0), rho);
    let hi = h1 + h2, lo = a1 + a2;
    if (hi === lo) {
      const [l, m] = xg(high, low, gamma, 0);
      hi += poisson(rand, l / 3); lo += poisson(rand, m / 3);
    }
    return hi > lo ? high : hi < lo ? low : rand() < 0.5 ? high : low;
  };
  const final = (x, y) => {
    let [gx, gy] = drawScore(rand, ...xg(x, y, gamma / 2, gamma / 2), rho);
    if (gx === gy) {
      const [l, m] = xg(x, y, gamma / 2, gamma / 2);
      gx += poisson(rand, l / 3); gy += poisson(rand, m / 3);
    }
    return gx > gy ? x : gx < gy ? y : rand() < 0.5 ? x : y;
  };

  for (let s = 0; s < nSims; s++) {
    for (let i = 0; i < T; i++) {
      att[i] = baseAtt[i] + sdAtt[i] * normal(rand);
      def[i] = baseDef[i] + sdDef[i] * normal(rand);
      const row = table[teams[i]];
      pts[i] = row.pts; gd[i] = row.gf - row.ga; gf[i] = row.gf; tiebreak[i] = rand();
    }
    for (const { h, a, fixed } of matches) {
      const [lam, mu] = xg(h, a, gamma, 0);
      let hg, ag, tries = 0;
      do { [hg, ag] = drawScore(rand, lam, mu, rho); } while (fixed && outcomeOf(hg, ag) !== fixed && ++tries < 200);
      if (fixed && outcomeOf(hg, ag) !== fixed) [hg, ag] = FORCED[fixed];
      gd[h] += hg - ag; gd[a] += ag - hg; gf[h] += hg; gf[a] += ag;
      if (hg > ag) pts[h] += 3; else if (hg < ag) pts[a] += 3; else { pts[h]++; pts[a]++; }
    }
    order.sort((x, y) => pts[y] - pts[x] || gd[y] - gd[x] || gf[y] - gf[x] || tiebreak[y] - tiebreak[x]);
    for (let p = 0; p < T; p++) positions[order[p]][p]++;
    for (let i = 0; i < T; i++) { ptsSum[i] += pts[i]; ptsHist[i][Math.max(0, Math.min(pts[i], MAX_PTS - 1))]++; }

    for (let p = 0; p < zones.promoted; p++) promoted[order[p]]++;
    const [p0, p1] = zones.playoff;
    if (T >= p1) {
      const seeds = order.slice(p0 - 1, p1);   // 3rd..6th
      const w = final(tie(seeds[0], seeds[3]), tie(seeds[1], seeds[2]));
      playoffWin[w]++; promoted[w]++;
    }
  }

  const quantile = (hist, q) => {
    let c = 0;
    for (let p = 0; p < hist.length; p++) { c += hist[p]; if (c >= q * nSims) return p; }
    return hist.length - 1;
  };
  return teams.map((team, i) => ({
    team,
    ...table[team],
    expectedPts: ptsSum[i] / nSims,
    ptsLow: quantile(ptsHist[i], 0.1),
    ptsHigh: quantile(ptsHist[i], 0.9),
    positions: Array.from(positions[i], (c) => c / nSims),
    ptsDist: Array.from(ptsHist[i], (c) => c / nSims),
    promoted: promoted[i] / nSims,
    playoffWin: playoffWin[i] / nSims,
  }));
}

// Split this season into rounds: cutoff k is the date of the (k·T/2)-th league match.
// Returns [{ round, date }] with round 0 = before the season started.
export function seasonRounds(data) {
  const season = data.results.filter((r) => inSeason(data, r));
  const perRound = currentTable(data).teams.length / 2;
  const rounds = [{ round: 0, date: null }];
  for (let k = 1; k * perRound <= season.length; k++) rounds.push({ round: k, date: season[k * perRound - 1][0] });
  return rounds;
}

// The data as it looked after `date` (null = before the season): later league
// results become fixtures; later results in other divisions are dropped.
export function dataAsOf(data, date) {
  const cutoff = date ?? new Date(Date.parse(data.seasonStart) - DAY_MS).toISOString().slice(0, 10);
  const results = data.results.filter((r) => r[0] <= cutoff);
  const replayed = data.results.filter((r) => r[0] > cutoff && inSeason(data, r)).map(([d, h, a]) => [d, h, a]);
  return { ...data, results, fixtures: [...replayed, ...data.fixtures] };
}

// seasons run July–June
const seasonEnd = (date) => `${Number(date.slice(0, 4)) + (date.slice(5, 7) >= '07' ? 1 : 0)}-07-01`;

const rpsOf = (P, o) => {
  const E = [0, 0, 0]; E[o] = 1;
  return ((P[0] - E[0]) ** 2 + (P[0] + P[1] - E[0] - E[1]) ** 2) / 2;
};

// Rolling out-of-sample test: predict every league match from `from` onward with
// a model fitted only on earlier matches (refitted every `refitDays`). Returns the
// mean ranked probability score (RPS) of the model, of a base-rate baseline and,
// where odds exist, of the bookmakers' closing prices; plus calibration bins.
export function backtest(data, { from, to = '9999', refitDays = 7, fit = {}, onProgress } = {}) {
  const test = data.results.filter((r) => r[0] >= from && r[0] < to && r[5] === data.league);
  const bins = Array.from({ length: 10 }, () => ({ predicted: 0, observed: 0, n: 0 }));
  let model = null, refitAfter = '', base = null, rps = 0, rpsBase = 0, logLoss = 0;
  let nMarket = 0, rpsMarket = 0, rpsModelOnMarket = 0;
  const pastAll = data.results;
  test.forEach((r, k) => {
    if (!model || r[0] > refitAfter) {
      const past = pastAll.filter((x) => x[0] < r[0]);
      const upcoming = test.filter((x) => x[0] >= r[0] && x[0] < seasonEnd(r[0]));
      model = fitModel({ ...data, results: past, fixtures: upcoming }, { ...fit, init: model });
      const counts = [0, 0, 0];
      const league = past.filter((x) => x[5] === data.league);
      for (const x of league) counts[x[3] > x[4] ? 0 : x[3] === x[4] ? 1 : 2]++;
      base = counts.map((c) => c / league.length);
      const next = new Date(r[0]); next.setDate(next.getDate() + refitDays);
      refitAfter = next.toISOString().slice(0, 10);
      onProgress?.(k / test.length);
    }
    const p = matchProbabilities(model, r[1], r[2]);
    const P = [p.home, p.draw, p.away];
    const o = r[3] > r[4] ? 0 : r[3] === r[4] ? 1 : 2;
    const s = rpsOf(P, o);
    rps += s; rpsBase += rpsOf(base, o); logLoss -= Math.log(P[o]);
    if (r.length >= 9) { nMarket++; rpsMarket += rpsOf(r.slice(6, 9), o); rpsModelOnMarket += s; }
    for (let j = 0; j < 3; j++) {
      const b = bins[Math.min(9, Math.floor(P[j] * 10))];
      b.predicted += P[j]; b.observed += j === o ? 1 : 0; b.n++;
    }
  });
  return {
    n: test.length,
    rps: rps / test.length,
    rpsBase: rpsBase / test.length,
    logLoss: logLoss / test.length,
    nMarket,
    rpsMarket: nMarket ? rpsMarket / nMarket : null,
    rpsModelOnMarket: nMarket ? rpsModelOnMarket / nMarket : null,
    bins: bins.filter((b) => b.n).map((b) => ({ predicted: b.predicted / b.n, observed: b.observed / b.n, n: b.n })),
  };
}
