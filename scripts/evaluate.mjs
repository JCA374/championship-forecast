// Offline model checks behind the numbers in docs/model.md.
//
//   node scripts/evaluate.mjs matches [xi] [sigma]   # match-level backtest, 2021/22–2025/26
//   node scripts/evaluate.mjs seasons [uncertainty]  # replay 2016/17–2025/26 from rounds 0, 12 and 30
import fs from 'node:fs';
import { fitModel, simulateSeason, backtest } from '../site/model.js';

const data = JSON.parse(fs.readFileSync(new URL('../site/data.json', import.meta.url)));
const [mode = 'matches', a, b] = process.argv.slice(2);

if (mode === 'matches') {
  const fit = {};
  if (a) fit.xi = Number(a);
  if (b) fit.sigma = Number(b);
  const res = backtest(data, { from: '2021-07-01', to: '2026-07-01', fit });
  delete res.bins;
  console.log(JSON.stringify({ fit, ...res }));
}

if (mode === 'seasons') {
  const k = a == null ? 1 : Number(a);
  const boundary = (y) => (y === 2020 ? '2020-08-01' : `${y}-07-01`);   // 2019/20 ran into July
  const out = [];
  for (let y = 2016; y <= 2025; y++) {
    const start = boundary(y), end = boundary(y + 1);
    const season = data.results.filter((r) => r[5] === data.league && r[0] >= start && r[0] < end);
    const t = new Map();
    for (const [, h, aw, gh, ga] of season) for (const [x, f, g] of [[h, gh, ga], [aw, ga, gh]]) {
      const o = t.get(x) ?? { pts: 0, gd: 0, gf: 0 };
      o.gd += f - g; o.gf += f; o.pts += f > g ? 3 : f === g ? 1 : 0; t.set(x, o);
    }
    const finalOrder = [...t].sort((p, q) => q[1].pts - p[1].pts || q[1].gd - p[1].gd || q[1].gf - p[1].gf).map(([x]) => x);
    for (const round of [0, 12, 30]) {
      const cut = round ? season[round * 12 - 1][0] : null;
      const results = data.results.filter((r) => r[0] < start || (cut && r[0] >= start && r[0] <= cut));
      const fixtures = season.filter((r) => !cut || r[0] > cut).map(([d, h, aw]) => [d, h, aw]);
      const d = { ...data, season: y, seasonStart: start, results, fixtures, deductions: {} };
      const rows = simulateSeason(d, fitModel(d), { nSims: 4000, seed: 7, uncertainty: k });
      for (const r of rows) {
        const pos = finalOrder.indexOf(r.team), pts = t.get(r.team).pts;
        let c = 0, rps = 0;
        for (let p = 0; p < r.positions.length - 1; p++) { c += r.positions[p]; rps += (c - (p >= pos ? 1 : 0)) ** 2; }
        out.push({ round, ll: Math.log(Math.max(r.positions[pos], 1e-4)), rps: rps / (r.positions.length - 1), cover: r.ptsLow <= pts && pts <= r.ptsHigh });
      }
    }
  }
  for (const round of [0, 12, 30, 'all']) {
    const o = out.filter((x) => round === 'all' || x.round === round);
    const mean = (f) => o.reduce((s, x) => s + f(x), 0) / o.length;
    console.log(JSON.stringify({ uncertainty: k, round, n: o.length, logScore: +mean((x) => x.ll).toFixed(4), positionRps: +mean((x) => x.rps).toFixed(4), cover80: +mean((x) => x.cover).toFixed(3) }));
  }
}
