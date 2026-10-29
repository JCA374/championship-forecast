// Run with: node --test "tests/js/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  fitModel, matchProbabilities, simulateSeason, seasonRounds, dataAsOf, backtest, mulberry32, currentTable,
} from '../../site/model.js';

const data = JSON.parse(fs.readFileSync(new URL('../../site/data.json', import.meta.url)));
const model = fitModel(data);
const leagueTeams = currentTable(data).teams;

// A synthetic two-division world with known ratings, to check the fit recovers them.
function synthetic(seed = 3) {
  const rand = mulberry32(seed);
  const pois = (m) => { let k = 0, p = rand(); const L = Math.exp(-m); while (p > L) { k++; p *= rand(); } return k; };
  const n = 16, attack = [], defence = [];
  for (let i = 0; i < n; i++) { attack.push((rand() - 0.5) * 0.8); defence.push((rand() - 0.5) * 0.8); }
  const gamma = [0.3, 0.2];
  const results = [];
  for (let season = 0; season < 16; season++) {
    // teams 0–7 in division 0, 8–15 in division 1; two pairs swap every other season
    const div = Array.from({ length: n }, (_, i) => (i < 8 ? 0 : 1));
    if (season % 2) { div[6] = 1; div[7] = 1; div[8] = 0; div[9] = 0; }
    for (let h = 0; h < n; h++) for (let a = 0; a < n; a++) {
      if (h === a || div[h] !== div[a]) continue;
      const day = String(1 + ((h * 7 + a) % 28)).padStart(2, '0');
      const lam = Math.exp(attack[h] + defence[a] + gamma[div[h]]), mu = Math.exp(attack[a] + defence[h]);
      results.push([`${2000 + season}-10-${day}`, h, a, pois(lam), pois(mu), div[h]]);
    }
  }
  results.sort((x, y) => (x[0] < y[0] ? -1 : 1));
  return { truth: { attack, defence, gamma }, data: { teams: attack.map((_, i) => `T${i}`), league: 1, results, fixtures: [] } };
}

test('recovers known ratings from simulated matches', () => {
  const { truth, data: d } = synthetic();
  const m = fitModel(d, { xi: 0, sigma: 0 });
  // ratings are identified up to a common shift: compare attack − defence
  const strength = (att, def, i) => att[i] - def[i];
  const t = truth.attack.map((_, i) => strength(truth.attack, truth.defence, i));
  const f = m.attack.map((_, i) => strength(m.attack, m.defence, i));
  const tm = t.reduce((s, v) => s + v) / t.length, fm = f.reduce((s, v) => s + v) / f.length;
  const worst = Math.max(...t.map((v, i) => Math.abs(v - tm - (f[i] - fm))));
  assert.ok(worst < 0.25, `largest strength error ${worst}`);
  assert.ok(Math.abs(m.homeAdv[0] - 0.3) < 0.1 && Math.abs(m.homeAdv[1] - 0.2) < 0.1, `home advantage ${m.homeAdv}`);
});

test('the fit is a stationary point of the penalised likelihood', () => {
  const { data: d } = synthetic(5);
  const m = fitModel(d, { xi: 0, sigma: 0, tol: 1e-10, maxIter: 2000 });
  // ∂/∂α_i: goals scored by i − expected goals scored by i = 0 (no prior)
  const resid = new Float64Array(d.teams.length);
  for (const [, h, a, gh, ga, div] of d.results) {
    resid[h] += gh - Math.exp(m.attack[h] + m.defence[a] + m.homeAdv[div]);
    resid[a] += ga - Math.exp(m.attack[a] + m.defence[h]);
  }
  assert.ok(Math.max(...resid.map(Math.abs)) < 1e-4, `largest score residual ${Math.max(...resid.map(Math.abs))}`);
});

test('fitted parameters are in the usual range for English football', () => {
  assert.ok(model.gamma > 0.1 && model.gamma < 0.4, `home advantage ${model.gamma}`);
  assert.ok(model.rho > -0.2 && model.rho < 0.1, `rho ${model.rho}`);
  for (const t of leagueTeams) assert.ok(model.attSd[t] > 0.03 && model.attSd[t] < 0.4, `attSd ${model.attSd[t]}`);
});

test('1X2 probabilities sum to 1', () => {
  const p = matchProbabilities(model, leagueTeams[0], leagueTeams[1]);
  assert.ok(Math.abs(p.home + p.draw + p.away - 1) < 1e-9);
});

test('season simulation: positions, promotion and relegation add up', () => {
  const rows = simulateSeason(data, model, { nSims: 2000 });
  assert.equal(rows.length, 24);
  for (const r of rows) assert.ok(Math.abs(r.positions.reduce((s, v) => s + v, 0) - 1) < 1e-9);
  for (let p = 0; p < rows.length; p++) assert.ok(Math.abs(rows.reduce((s, r) => s + r.positions[p], 0) - 1) < 1e-9);
  assert.ok(Math.abs(rows.reduce((s, r) => s + r.promoted, 0) - 3) < 1e-9, 'two automatic + one playoff winner');
  assert.ok(Math.abs(rows.reduce((s, r) => s + r.playoffWin, 0) - 1) < 1e-9);
  for (const r of rows) {
    assert.ok(r.ptsLow <= r.expectedPts && r.expectedPts <= r.ptsHigh);
    const top6 = r.positions.slice(0, 6).reduce((s, v) => s + v, 0);
    assert.ok(r.promoted <= top6 + 1e-9, 'only top-6 teams can go up');
  }
});

test('rating uncertainty widens the points range', () => {
  const sure = simulateSeason(data, model, { nSims: 3000, uncertainty: 0 });
  const unsure = simulateSeason(data, model, { nSims: 3000, uncertainty: 1 });
  const width = (rows) => rows.reduce((s, r) => s + r.ptsHigh - r.ptsLow, 0);
  assert.ok(width(unsure) > width(sure), `${width(unsure)} vs ${width(sure)}`);
});

test('a fixed home win always gives the home team 3 points', () => {
  const [, h, a] = data.fixtures[0];
  const one = { ...data, fixtures: [data.fixtures[0]] };
  const before = currentTable(one).table;
  const rows = simulateSeason(one, model, { nSims: 300, overrides: { 0: 'H' } });
  assert.equal(rows.find((r) => r.team === h).ptsLow, before[h].pts + 3);
  assert.equal(rows.find((r) => r.team === a).ptsHigh, before[a].pts);
});

test('points deductions come off the table', () => {
  const t = leagueTeams[0];
  const plain = currentTable(data).table[t].pts;
  assert.equal(currentTable({ ...data, deductions: { [t]: 12 } }).table[t].pts, plain - 12);
});

test('replaying a round turns later league results back into fixtures', () => {
  const rounds = seasonRounds(data);
  assert.equal(rounds[0].round, 0);
  assert.ok(rounds.length > 1);
  const asOf = dataAsOf(data, rounds[1].date);
  assert.equal(asOf.fixtures.length, data.fixtures.length + currentTable(data).table.reduce((s, r) => s + r.played, 0) / 2 - 12);
  assert.ok(asOf.results.every((r) => r[0] <= rounds[1].date));
});

test('backtest beats the base-rate baseline', () => {
  const bt = backtest(data, { from: `${data.season - 1}-07-01`, refitDays: 60 });
  assert.ok(bt.n > 500);
  assert.ok(bt.rps < bt.rpsBase, `model ${bt.rps} vs baseline ${bt.rpsBase}`);
  assert.ok(bt.nMarket > 0 && bt.rpsMarket < bt.rpsBase);
});
