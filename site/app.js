import { lineChart, scatter, calibration, columns, showTip, onHover, SERIES } from './charts.js';

// football-data.co.uk short names → names to show
const DISPLAY_NAMES = {
  "Nott'm Forest": 'Nottingham Forest', 'Sheffield Weds': 'Sheffield Wednesday', Peterboro: 'Peterborough',
  'Bristol Rvs': 'Bristol Rovers', 'Man City': 'Manchester City', 'Man United': 'Manchester United',
  'Milton Keynes Dons': 'MK Dons',
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pct = (p) => (p >= 0.995 ? '>99%' : p > 0 && p < 0.005 ? '<1%' : `${Math.round(p * 100)}%`);
const fmtDate = (iso, opts) => new Date(iso + 'T12:00:00').toLocaleDateString('en-GB', opts);
const sum = (arr, from, to) => arr.slice(from, to).reduce((s, v) => s + v, 0);

const forecaster = new Worker('worker.js', { type: 'module' });
const background = new Worker('worker.js', { type: 'module' });

let data, model, matches, name, zones;
let rows = [];                 // latest forecast
let overrides = {};            // fixture index → 'H' | 'D' | 'A'
let requestId = 0;
let raceRounds = null, raceMetric = 'promoted';
let focus = null;              // team index shown in "Team in focus"

// probabilities for the zones, from a forecast row
const Z = {
  title: (r) => r.positions[0],
  top2: (r) => sum(r.positions, 0, zones.promoted),
  top6: (r) => sum(r.positions, 0, zones.playoff[1]),
  playoffs: (r) => sum(r.positions, zones.playoff[0] - 1, zones.playoff[1]),
  promoted: (r) => r.promoted,
  down: (r) => sum(r.positions, r.positions.length - zones.relegated),
};
const zoneOf = (pos, T) => (pos < zones.promoted ? 'up' : pos < zones.playoff[1] ? 'po' : pos >= T - zones.relegated ? 'down' : '');

// ── start-up ────────────────────────────────────────────────────────────────

async function init() {
  data = await (await fetch('data.json', { cache: 'no-cache' })).json();
  zones = data.zones;
  name = (i) => DISPLAY_NAMES[data.teams[i]] ?? data.teams[i];
  const lastResult = data.results.filter((r) => r[5] === data.league).at(-1)[0];
  const label = `${data.season}/${String((data.season + 1) % 100).padStart(2, '0')}`;
  $('#season').textContent = label;
  $('#season-short').textContent = label;
  $('#meta').textContent =
    `Results up to ${fmtDate(lastResult, { day: 'numeric', month: 'long', year: 'numeric' })} · ` +
    `${data.fixtures.length} matches left · data updated ${fmtDate(data.generated.slice(0, 10), { day: 'numeric', month: 'short' })}`;
  overrides = readHash();

  forecaster.onmessage = ({ data: msg }) => {
    if (msg.type === 'model') {
      ({ model, matches } = msg);
      renderFixtures();
      syncOverrideUi();
      renderStrength();
      // a quick 1,000-season pass first, so slow phones see a table sooner
      forecaster.postMessage({ type: 'forecast', id: 'preview', nSims: 1000, seed: 1, overrides });
      run(1);
    }
    if (msg.type === 'forecast' && msg.id === requestId) showForecast(msg);
    if (msg.type === 'forecast' && msg.id === 'preview' && !rows.length) showForecast(msg, true);
  };
  forecaster.postMessage({ type: 'init', data });

  background.onmessage = ({ data: msg }) => {
    if (msg.type === 'race-progress') $('#race-progress').value = msg.done / msg.total;
    if (msg.type === 'race') { raceRounds = msg.rounds; renderRace(); background.postMessage({ type: 'backtest' }); }
    if (msg.type === 'backtest-progress') $('#acc-progress').value = msg.done;
    if (msg.type === 'backtest') renderAccuracy(msg);
  };

  $('#run').addEventListener('click', () => run(Math.floor(Math.random() * 2 ** 31)));
  $('#nsims').addEventListener('change', () => run(1));
  $('#reset').addEventListener('click', () => { overrides = {}; afterOverrideChange(); });
  $('#race-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-metric]');
    if (!b) return;
    raceMetric = b.dataset.metric;
    for (const t of $('#race-tabs').children) t.setAttribute('aria-selected', t === b);
    renderRace();
  });
  $('#team-pick').addEventListener('change', (e) => { focus = Number(e.target.value); renderTeam(); });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-focus]');
    if (!b) return;
    focus = Number(b.dataset.focus);
    renderTeam();
    $('#team-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function run(seed) {
  const nSims = Number($('#nsims').value);
  $('#run').disabled = true;
  $('#status').textContent = `Simulating ${nSims.toLocaleString('en')} seasons…`;
  forecaster.postMessage({ type: 'forecast', id: ++requestId, nSims, seed, overrides });
}

let backgroundStarted = false;

function showForecast(msg, preview = false) {
  // the replay and backtest wait until the full forecast is up: phones have few cores
  if (!backgroundStarted && !preview) {
    backgroundStarted = true;
    background.postMessage({ type: 'init', data });
    background.postMessage({ type: 'race', nSims: 2000 });
  }
  rows = msg.rows.sort((a, b) => b.expectedPts - a.expectedPts);
  if (focus == null) focus = rows[0].team;
  renderTiles();
  renderTable();
  renderTeamPicker();
  renderTeam();
  renderHeatmap();
  if (preview) return;   // status and button wait for the full run
  const nSims = Number($('#nsims').value);
  $('#status').textContent = `Played out ${nSims.toLocaleString('en')} seasons in your browser in ${(msg.ms / 1000).toFixed(1)} s`;
  $('#run').disabled = false;
}

// ── what-if overrides, kept in the URL hash as Home-Away:H ──────────────────

const fixtureKey = (i) => `${data.teams[data.fixtures[i][1]]}-${data.teams[data.fixtures[i][2]]}`;

function readHash() {
  const m = location.hash.match(/fix=([^&]*)/);
  if (!m) return {};
  const wanted = new Map(decodeURIComponent(m[1]).split(',').map((s) => {
    const k = s.lastIndexOf(':');
    return [s.slice(0, k), s.slice(k + 1)];
  }));
  const out = {};
  data.fixtures.forEach((_, i) => {
    const o = wanted.get(fixtureKey(i));
    if (['H', 'D', 'A'].includes(o)) out[i] = o;
  });
  return out;
}

function afterOverrideChange() {
  const parts = Object.entries(overrides).map(([i, o]) => `${fixtureKey(i)}:${o}`);
  history.replaceState(null, '', parts.length ? `#fix=${encodeURIComponent(parts.join(','))}` : location.pathname);
  syncOverrideUi();
  run(1);
}

function syncOverrideUi() {
  const n = Object.keys(overrides).length;
  $('#fixed-chip').hidden = !n;
  $('#fixed-count').textContent = `${n} match${n === 1 ? '' : 'es'} fixed`;
  for (const btn of document.querySelectorAll('.pick button')) {
    btn.setAttribute('aria-pressed', overrides[btn.dataset.idx] === btn.dataset.o);
  }
  for (const m of document.querySelectorAll('.match')) m.classList.toggle('fixed', !!overrides[m.dataset.idx]);
}

// ── tiles ───────────────────────────────────────────────────────────────────

function renderTiles() {
  const best = (f) => rows.reduce((a, b) => (f(b) > f(a) ? b : a));
  const tile = (label, r, p, note, zone) =>
    `<div class="tile ${zone}"><div class="tile-label">${label}</div><div class="tile-value">${pct(p)}</div>` +
    `<button type="button" class="tile-team" data-focus="${r.team}">${esc(name(r.team))}</button><div class="tile-note">${note}</div></div>`;
  const champ = best(Z.title), up = best(Z.promoted), po = best((r) => r.playoffWin), down = best(Z.down);
  $('#tiles').innerHTML =
    tile('Title favourite', champ, Z.title(champ), 'chance of finishing 1st', '') +
    tile('Likeliest promoted', up, Z.promoted(up), 'top two or playoff winners', 'up') +
    tile('Playoff favourite', po, po.playoffWin, 'chance of winning the playoffs', 'po') +
    tile('Likeliest relegated', down, Z.down(down), `chance of finishing in the bottom ${zones.relegated}`, 'down');
}

// ── table with points range ─────────────────────────────────────────────────

function probCell(p, cls = '') {
  return `<td class="num prob ${cls}">${pct(p)}<span class="bar"><i style="width:${(p * 100).toFixed(1)}%"></i></span></td>`;
}

function form(team, n = 5) {
  const games = data.results.filter((r) => r[0] >= data.seasonStart && r[5] === data.league && (r[1] === team || r[2] === team)).slice(-n);
  return games.map(([date, h, a, gh, ga]) => {
    const [f, g] = h === team ? [gh, ga] : [ga, gh];
    const o = f > g ? 'W' : f === g ? 'D' : 'L';
    const opp = name(h === team ? a : h);
    return `<i class="form-${o}" title="${esc(`${o} ${f}–${g} ${h === team ? 'v' : 'at'} ${opp}, ${fmtDate(date, { day: 'numeric', month: 'short' })}`)}">${o}</i>`;
  }).join('');
}

function renderTable() {
  const T = rows.length;
  const lo = Math.floor(Math.min(...rows.map((r) => r.pts)) / 10) * 10;
  const hi = Math.ceil(Math.max(...rows.map((r) => r.ptsHigh)) / 10) * 10;
  const at = (v) => `${(((v - lo) / (hi - lo)) * 100).toFixed(2)}%`;
  const scale = [];
  for (let v = lo; v <= hi; v += 20) scale.push(`<span style="left:${at(v)}">${v}</span>`);
  $('#range-scale').innerHTML = scale.join('');

  $('#table tbody').innerHTML = rows.map((r, i) => {
    const gd = r.gf - r.ga;
    const ded = data.deductions?.[r.team];
    return `<tr class="zone-${zoneOf(i, T) || 'mid'}${r.team === focus ? ' focus' : ''}">
      <td class="num dim">${i + 1}</td>
      <td class="team"><button type="button" data-focus="${r.team}">${esc(name(r.team))}</button></td>
      <td class="form opt">${form(r.team)}</td>
      <td class="num dim opt">${r.played}</td>
      <td class="num">${r.pts}${ded ? `<sup title="${ded} points deducted">−${ded}</sup>` : ''}</td>
      <td class="num dim opt">${gd > 0 ? '+' : ''}${gd}</td>
      <td class="range narrow-hide" data-team="${r.team}"><div class="range-track">
        <span class="rbar" style="left:${at(r.ptsLow)};width:calc(${at(r.ptsHigh)} - ${at(r.ptsLow)})"></span>
        <span class="rdot" style="left:${at(r.pts)}"></span>
        <span class="rtick" style="left:${at(r.expectedPts)}"></span>
      </div></td>
      <td class="num"><b>${r.expectedPts.toFixed(1)}</b></td>
      ${probCell(Z.title(r), 'narrow-hide')}
      ${probCell(Z.top2(r), 'up narrow-hide')}
      ${probCell(Z.top6(r), 'po narrow-hide')}
      ${probCell(Z.promoted(r), 'up strong')}
      ${probCell(Z.down(r), 'down')}
    </tr>`;
  }).join('');

  for (const cell of document.querySelectorAll('td.range')) {
    const r = rows.find((x) => x.team === Number(cell.dataset.team));
    onHover(cell, (e) => showTip(e, name(r.team), [
      { value: r.pts, label: 'points now' },
      { value: r.expectedPts.toFixed(1), label: 'expected final points' },
      { value: `${r.ptsLow}–${r.ptsHigh}`, label: 'likely range (80%)' },
    ]));
  }
}

// ── team in focus ───────────────────────────────────────────────────────────

function renderTeamPicker() {
  const pick = $('#team-pick');
  const sorted = [...rows].sort((a, b) => name(a.team).localeCompare(name(b.team)));
  pick.innerHTML = sorted.map((r) => `<option value="${r.team}">${esc(name(r.team))}</option>`).join('');
  pick.value = focus;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function renderTeam() {
  if (!rows.length || focus == null) return;
  $('#team-pick').value = focus;
  for (const tr of document.querySelectorAll('#table tbody tr')) {
    tr.classList.toggle('focus', tr.querySelector('[data-focus]')?.dataset.focus === String(focus));
  }
  const T = rows.length;
  const r = rows.find((x) => x.team === focus);
  const now = [...rows].sort((a, b) => b.pts - a.pts || (b.gf - b.ga) - (a.gf - a.ga) || b.gf - a.gf).findIndex((x) => x.team === focus) + 1;

  // ratings against an average league side at a neutral ground
  const league = rows.map((x) => x.team);
  const mean = (f) => league.reduce((s, t) => s + f(t), 0) / league.length;
  const avgAtt = mean((t) => model.attack[t]), avgDef = mean((t) => model.defence[t]), half = model.gamma / 2;
  const scores = Math.exp(model.attack[focus] + avgDef + half), concedes = Math.exp(avgAtt + model.defence[focus] + half);
  const rankOf = (f) => 1 + league.filter((t) => f(t) > f(focus)).length;

  const next = data.fixtures.map((f, i) => [f, i]).filter(([f]) => f[1] === focus || f[2] === focus).slice(0, 6);
  const stat = (v, l, cls = '') => `<div class="stat ${cls}"><b>${v}</b><span>${l}</span></div>`;

  $('#team-card').innerHTML = `
    <div class="team-head">
      <h3>${esc(name(focus))}</h3>
      <p class="note">${ordinal(now)} now · ${r.pts} pts from ${r.played} games (${r.w}W ${r.d}D ${r.l}L, ${r.gf}–${r.ga}) · form <span class="form">${form(focus)}</span></p>
    </div>
    <div class="stats">
      ${stat(r.expectedPts.toFixed(1), `expected points (${r.ptsLow}–${r.ptsHigh})`)}
      ${stat(pct(Z.title(r)), 'win the title')}
      ${stat(pct(Z.promoted(r)), 'promoted', 'up')}
      ${stat(pct(Z.playoffs(r)), 'reach the playoffs', 'po')}
      ${stat(pct(r.playoffWin), 'win the playoffs', 'po')}
      ${stat(pct(Z.down(r)), 'relegated', 'down')}
    </div>
    <div class="team-grid">
      <div>
        <h4>Final points</h4>
        <div id="team-points" class="chart-box small"></div>
      </div>
      <div>
        <h4>Final position</h4>
        <div id="team-positions" class="chart-box small"></div>
      </div>
      <div>
        <h4>Rating</h4>
        <p class="rating"><b>${scores.toFixed(2)}</b> goals scored per match · ${ordinal(rankOf((t) => model.attack[t]))} in the league<br>
          <b>${concedes.toFixed(2)}</b> goals conceded per match · ${ordinal(rankOf((t) => -model.defence[t]))} in the league</p>
        <p class="note">Against an average Championship side at a neutral ground. Uncertainty: about ±${Math.round(model.attSd[focus] * 100)}% on attack, ±${Math.round(model.defSd[focus] * 100)}% on defence (1 s.d.); the simulation includes it.</p>
      </div>
      <div>
        <h4>Next matches</h4>
        <div class="mini-fixtures">${next.map(([[date, h, a], i]) => {
          const p = matches[i];
          const home = h === focus;
          const [w, d, l] = home ? [p.home, p.draw, p.away] : [p.away, p.draw, p.home];
          return `<div class="mini"><span class="dim">${fmtDate(date, { day: 'numeric', month: 'short' })}</span>
            <span>${home ? 'v' : 'at'} ${esc(name(home ? a : h))}</span>
            <span class="wdl" title="win ${pct(w)}, draw ${pct(d)}, loss ${pct(l)}"><b>${pct(w)}</b> · ${pct(d)} · ${pct(l)}</span></div>`;
        }).join('') || '<p class="note">No matches left.</p>'}
        <p class="note">Win · draw · loss</p></div>
      </div>
    </div>`;

  const first = r.ptsDist.findIndex((p) => p > 0.0005);
  const last = r.ptsDist.length - 1 - [...r.ptsDist].reverse().findIndex((p) => p > 0.0005);
  columns($('#team-points'), {
    values: r.ptsDist.slice(first, last + 1),
    xTickLabel: (i) => first + i,
    tip: (i, v) => [`${first + i} points`, [{ value: `${(v * 100).toFixed(1)}%`, label: 'chance' }]],
    mark: { at: r.expectedPts - first, label: `exp. ${r.expectedPts.toFixed(1)}` },
  });
  columns($('#team-positions'), {
    values: r.positions,
    xTickLabel: (i) => i + 1,
    colorOf: (i) => ({ up: 'var(--zone-up)', po: 'var(--zone-po)', down: 'var(--zone-down)' })[zoneOf(i, T)] ?? 'var(--draw)',
    tip: (i, v) => [`Finishes ${ordinal(i + 1)}`, [{ value: `${(v * 100).toFixed(1)}%`, label: 'chance' }]],
  });
}

// ── position heatmap ────────────────────────────────────────────────────────

function renderHeatmap() {
  const T = rows.length;
  const edge = (p) => (p === zones.promoted - 1 || p === zones.playoff[1] - 1 || p === T - zones.relegated - 1 ? ' edge' : '');
  const head = `<tr><th></th>${rows.map((_, p) => `<th class="z-${zoneOf(p, T) || 'mid'}${edge(p)}">${p + 1}</th>`).join('')}</tr>`;
  const body = rows.map((r) => `<tr><th class="rowhead"><button type="button" data-focus="${r.team}">${esc(name(r.team))}</button></th>${r.positions.map((p, pos) => {
    const share = Math.round(Math.min(1, p / 0.5) * 100);   // 50%+ = full colour
    const label = p >= 0.005 ? Math.round(p * 100) : '';
    const tip = `${name(r.team)} finishes ${ordinal(pos + 1)}: ${(p * 100).toFixed(1)}%`;
    return `<td class="${share > 45 ? 'dark' : 'light'}${edge(pos)}" title="${esc(tip)}"
      style="background:color-mix(in oklab, var(--heat) ${share}%, var(--bg))">${label}</td>`;
  }).join('')}</tr>`).join('');
  $('#heatmap').innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;
}

// ── race over the season ────────────────────────────────────────────────────

const METRICS = {
  promoted: { label: 'be promoted', of: (r, t) => r.promoted[t] },
  title: { label: 'win the league', of: (r, t) => r.positions[t][0] },
  top6: { label: 'finish in the top 6', of: (r, t) => sum(r.positions[t], 0, zones.playoff[1]) },
  down: { label: 'be relegated', of: (r, t) => sum(r.positions[t], r.positions[t].length - zones.relegated) },
};

function renderRace() {
  if (!raceRounds) return;
  const metric = METRICS[raceMetric];
  const teams = Object.keys(raceRounds.at(-1).positions).map(Number);
  const all = teams.map((t) => ({ team: t, values: raceRounds.map((r) => (r.positions[t] ? metric.of(r, t) : 0)) }));
  const ranked = all.filter((s) => Math.max(...s.values) >= 0.05)
    .sort((a, b) => b.values.at(-1) - a.values.at(-1) || Math.max(...b.values) - Math.max(...a.values));
  const shown = new Set(ranked.slice(0, SERIES.length).map((s) => s.team));
  // colour follows the team (alphabetical slot among those shown), not its rank
  const palette = new Map([...shown].sort((a, b) => name(a).localeCompare(name(b))).map((t, k) => [t, SERIES[k]]));
  const series = all.map((s) => ({ name: name(s.team), values: s.values, color: palette.get(s.team), muted: !shown.has(s.team) }));
  const legend = $('#race-legend');
  legend.replaceChildren(...ranked.slice(0, SERIES.length).map((s) => {
    const item = document.createElement('span');
    item.className = 'key';
    item.innerHTML = `<i class="kline" style="background:${palette.get(s.team)}"></i>`;
    item.append(name(s.team));
    return item;
  }));
  lineChart($('#race'), {
    series,
    xLabel: 'Round',
    xTickLabel: (i) => (i === 0 ? 'Start' : i),
    tipTitle: (i) => (i === 0 ? 'Before the season' : `After round ${i} (${fmtDate(raceRounds[i].date, { day: 'numeric', month: 'short' })})`),
  });
  $('#race').setAttribute('aria-label', `Chance to ${metric.label} after each round`);
}

// ── team strength scatter ───────────────────────────────────────────────────

function renderStrength() {
  const teams = [...new Set(data.fixtures.flatMap(([, h, a]) => [h, a]))];
  const mean = (f) => teams.reduce((s, t) => s + f(t), 0) / teams.length;
  const avgAtt = mean((t) => model.attack[t]), avgDef = mean((t) => model.defence[t]);
  const half = model.gamma / 2;
  const points = teams.map((t) => {
    const scores = Math.exp(model.attack[t] + avgDef + half);
    const concedes = Math.exp(avgAtt + model.defence[t] + half);
    return {
      x: scores, y: concedes, label: name(t),
      tip: [{ value: scores.toFixed(2), label: 'goals scored per match' }, { value: concedes.toFixed(2), label: 'goals conceded per match' }],
    };
  });
  scatter($('#strength'), {
    points,
    xLabel: 'Goals scored per match →',
    yLabel: '← Goals conceded per match',
    xRef: Math.exp(avgAtt + avgDef + half),
    yRef: Math.exp(avgAtt + avgDef + half),
    yInvert: true,
    quadrants: ['Weak attack · tight defence', 'Strong attack · tight defence', 'Weak attack · leaky defence', 'Strong attack · leaky defence'],
  });
}

// ── fixtures by round, with what-if picks and score grids ───────────────────

function renderFixtures() {
  const byRound = new Map();
  data.fixtures.forEach((f, i) => {
    if (!byRound.has(f[3])) byRound.set(f[3], []);
    byRound.get(f[3]).push(i);
  });
  // rounds in order of their first match; rearranged games stay in their round
  const rounds = [...byRound].sort((a, b) => (data.fixtures[a[1][0]][0] < data.fixtures[b[1][0]][0] ? -1 : 1));
  const SHOW = 2;
  $('#fixtures').innerHTML = rounds.map(([round, idxs], k) => {
    let lastDate = '';
    const items = idxs.map((i) => {
      const [date, h, a] = data.fixtures[i];
      const p = matches[i];
      const dateHead = date !== lastDate ? `<h4>${fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long' })}</h4>` : '';
      lastDate = date;
      const pick = (o, label, title) =>
        `<button type="button" data-idx="${i}" data-o="${o}" aria-pressed="${overrides[i] === o}" title="${esc(title)}">${label}</button>`;
      return `${dateHead}<div class="match${overrides[i] ? ' fixed' : ''}" data-idx="${i}">
        <button type="button" class="teams" aria-expanded="false">${esc(name(h))} – ${esc(name(a))}</button>
        <div>
          <div class="split" role="img" aria-label="Home ${pct(p.home)}, draw ${pct(p.draw)}, away ${pct(p.away)}">
            <i class="home" style="flex:${p.home}"></i><i class="draw" style="flex:${p.draw}"></i><i class="away" style="flex:${p.away}"></i>
          </div>
          <div class="split-nums"><span>${pct(p.home)}</span><span>${pct(p.draw)}</span><span>${pct(p.away)}</span></div>
        </div>
        <div class="pick" role="group" aria-label="Fix the result">
          ${pick('H', '1', `${name(h)} win`)}${pick('D', 'X', 'Draw')}${pick('A', '2', `${name(a)} win`)}
        </div>
        <div class="grid-slot" hidden></div>
      </div>`;
    }).join('');
    return `<div class="round"${k >= SHOW ? ' data-later hidden' : ''}><h3>Round ${round}</h3>${items}</div>`;
  }).join('') + (rounds.length > SHOW
    ? `<button type="button" id="show-all" class="show-all">Show all ${data.fixtures.length} remaining matches (${rounds.length} rounds)</button>` : '');

  $('#fixtures').addEventListener('click', (e) => {
    if (e.target.id === 'show-all') {
      for (const d of document.querySelectorAll('.round[data-later]')) d.hidden = false;
      e.target.remove();
      return;
    }
    const pickBtn = e.target.closest('.pick button');
    if (pickBtn) {
      const { idx, o } = pickBtn.dataset;
      if (overrides[idx] === o) delete overrides[idx]; else overrides[idx] = o;
      afterOverrideChange();
      return;
    }
    const teamsBtn = e.target.closest('button.teams');
    if (teamsBtn) {
      const match = teamsBtn.closest('.match');
      const slot = match.querySelector('.grid-slot');
      const open = slot.hidden;
      slot.hidden = !open;
      teamsBtn.setAttribute('aria-expanded', open);
      if (open && !slot.childElementCount) slot.innerHTML = scoreGridHtml(Number(match.dataset.idx));
    }
  });
}

function scoreGridHtml(i) {
  const [, h, a] = data.fixtures[i];
  const p = matches[i];
  const N = 6, S = 11;   // show 0–5 goals; the grid holds 0–10
  const max = Math.max(...p.grid);
  let rowsHtml = '';
  for (let x = 0; x < N; x++) {
    rowsHtml += `<tr><th>${x}</th>`;
    for (let y = 0; y < N; y++) {
      const v = p.grid[x * S + y];
      const share = Math.round((v / max) * 100);
      const best = x === p.likelyScore[0] && y === p.likelyScore[1];
      rowsHtml += `<td class="${share > 55 ? 'dark' : 'light'}${best ? ' best' : ''}" title="${x}–${y}: ${(v * 100).toFixed(1)}%"
        style="background:color-mix(in oklab, var(--heat) ${share}%, var(--bg))">${(v * 100).toFixed(v < 0.1 ? 1 : 0)}</td>`;
    }
    rowsHtml += '</tr>';
  }
  return `<div class="score-grid">
    <p class="note">Chance of each exact score, in %. Rows: ${esc(name(h))} goals · columns: ${esc(name(a))} goals.
      Expected goals ${p.lam.toFixed(2)}–${p.mu.toFixed(2)}; most likely ${p.likelyScore.join('–')}.</p>
    <table class="heatmap"><thead><tr><th></th>${[...Array(N).keys()].map((y) => `<th>${y}</th>`).join('')}</tr></thead><tbody>${rowsHtml}</tbody></table>
  </div>`;
}

// ── model accuracy ──────────────────────────────────────────────────────────

function renderAccuracy(bt) {
  calibration($('#calibration'), bt.bins);
  const better = (1 - bt.rps / bt.rpsBase) * 100;
  const gap = bt.rpsMarket != null ? (bt.rpsModelOnMarket / bt.rpsMarket - 1) * 100 : null;
  $('#acc-note').textContent =
    `Every Championship match since July ${bt.from} (${bt.n.toLocaleString('en')} matches) was predicted using only earlier results. ` +
    'Dots on the diagonal mean the percentages can be trusted: things the model calls 40% happen about 40% of the time.';
  $('#acc-tiles').innerHTML = `
    <div class="tile"><div class="tile-label">Prediction error (RPS)</div><div class="tile-value">${bt.rps.toFixed(3)}</div><div class="tile-note">lower is better · ${better.toFixed(0)}% smaller than a naive guess (${bt.rpsBase.toFixed(3)})</div></div>
    ${gap != null ? `<div class="tile"><div class="tile-label">Bookmakers' closing odds</div><div class="tile-value">${bt.rpsMarket.toFixed(3)}</div><div class="tile-note">the model's error is ${gap.toFixed(1)}% larger than the market's, on the same ${bt.nMarket.toLocaleString('en')} matches. The market also knows about injuries, transfers and team news.</div></div>` : ''}`;
}

init().catch((err) => {
  console.error(err);
  $('#meta').textContent = 'Could not load the data. Try reloading the page.';
});
