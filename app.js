'use strict';
// Gameday app v2: Team (Sleeper, straight from the phone), Map (advisor + what it hands off), Research (queue + reports).
// Map/Research read ./data/feed.json (a sanitised public feed; Pages caches for minutes, so the page shows "updated HH:MM").
const API = 'https://api.sleeper.app';
const SUBS = ['Lineup', 'Waivers', 'Alerts', 'Trades', 'Live'];
const BAD = {Out: 'OUT', IR: 'IR', PUP: 'PUP', Sus: 'SUSP', Doubtful: 'DOUBTFUL', NA: 'OUT'};
const SLOT = {FLEX: ['RB', 'WR', 'TE'], WRRB_FLEX: ['RB', 'WR'], REC_FLEX: ['WR', 'TE'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'], IDP_FLEX: ['DL', 'LB', 'DB']};
const SKIP = new Set(['BN', 'IR', 'TAXI']);

// ---- settings: from the link (#u=…&to=…&n=…), kept on the phone only ----
const store = {
  get(k) { try { return localStorage.getItem('fa.' + k) || ''; } catch (e) { return ''; } },
  set(k, v) { try { v ? localStorage.setItem('fa.' + k, v) : localStorage.removeItem('fa.' + k); } catch (e) {} },
};
const hp = new URLSearchParams(location.hash.slice(1));
for (const k of ['u', 'to', 'n']) if (hp.get(k)) store.set(k, hp.get(k));
const cfg = {u: store.get('u'), to: store.get('to'), n: store.get('n'), league: store.get('league'),
             page: store.get('page') || 'team', sub: store.get('sub') || 'Lineup'};
if (!['team', 'map', 'research'].includes(cfg.page)) cfg.page = 'team';
if (!SUBS.includes(cfg.sub)) cfg.sub = 'Lineup';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const f1 = x => (Math.round((x || 0) * 10) / 10).toFixed(1);
const hhmm = d => d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', hour12: false});
function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const today = new Date().toDateString() === d.toDateString();
  return today ? hhmm(d) : d.toLocaleDateString([], {month: 'short', day: 'numeric'}) + ' ' + hhmm(d);
}

// Messages to the advisor, prefilled (iOS sms form). The chat itself stays in Messages.
function smsHref(text) {
  if (!cfg.to) return '';
  return 'sms:' + encodeURIComponent(cfg.to).replace('%40', '@') + (text ? '&body=' + encodeURIComponent(text) : '');
}
const ask = (label, text, cls = '') => cfg.to ? `<a class="pbtn sm ${cls}" href="${esc(smsHref(text))}">${esc(label)}</a>` : '';

// ---- Sleeper ----
async function getJSON(path) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(r.status + ' ' + path);
  return r.json();
}
// Sleeper asks that the full player list be pulled at most once a day: keep it in the Cache API.
async function allPlayers() {
  const url = API + '/v1/players/nfl', day = new Date().toISOString().slice(0, 10);
  try {
    const c = await caches.open('fa-players');
    const hit = await c.match(url);
    if (hit && hit.headers.get('x-day') === day) return hit.json();
    const r = await fetch(url), body = await r.text();
    await c.put(url, new Response(body, {headers: {'x-day': day, 'content-type': 'application/json'}}));
    return JSON.parse(body);
  } catch (e) { return getJSON('/v1/players/nfl'); }
}

let D = null, DERR = '', FEED = null, FERR = false, FAT = null, REPORT = null, SEL = 'advisor', Q = '';
let BASE = null;           // once per visit: NFL state, the user, his leagues, projections, schedule, trending
const LG = new Map();      // league_id -> that league's loaded team, so switching teams is a swap, not a reload

async function loadBase() {
  const st = await getJSON('/v1/state/nfl');
  const season = st.league_season || st.season, week = Math.max(1, st.display_week || st.week || 1);
  const user = await getJSON('/v1/user/' + encodeURIComponent(cfg.u));
  if (!user || !user.user_id) throw new Error('nouser');
  const leagues = (await getJSON(`/v1/user/${user.user_id}/leagues/nfl/${season}`)) || [];
  if (!leagues.length) return {st, user, leagues, season, week};
  const [proj, sched, trend, drops] = await Promise.all([
    getJSON(`/projections/nfl/${season}/${week}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF`).catch(() => []),
    getJSON(`/schedule/nfl/regular/${season}`).catch(() => []),
    getJSON('/v1/players/nfl/trending/add?lookback_hours=24&limit=80').catch(() => []),
    getJSON('/v1/players/nfl/trending/drop?lookback_hours=24&limit=100').catch(() => []),
  ]);
  const games = {};
  for (const g of sched || []) if (g.week === week) { games[g.home] = {opp: g.away, home: true}; games[g.away] = {opp: g.home, home: false}; }
  return {st, user, leagues, season, week, proj, games, trend, drops};
}
async function loadLeague(lg) {
  const {st, user, leagues, season, week, proj, games, trend, drops} = BASE, id = lg.league_id;
  const [rosters, users, matchups, tx1, tx0] = await Promise.all([
    getJSON(`/v1/league/${id}/rosters`), getJSON(`/v1/league/${id}/users`),
    getJSON(`/v1/league/${id}/matchups/${week}`).catch(() => []),
    getJSON(`/v1/league/${id}/transactions/${week}`).catch(() => []),
    week > 1 ? getJSON(`/v1/league/${id}/transactions/${week - 1}`).catch(() => []) : [],
  ]);
  const rec = (lg.scoring_settings || {}).rec || 0;
  const key = rec >= 1 ? 'pts_ppr' : rec >= 0.5 ? 'pts_half_ppr' : 'pts_std';
  const P = {}, pts = {};
  for (const e of proj || []) {
    if (!e || !e.player_id) continue;
    const p = e.player || {};
    P[e.player_id] = {name: p.position === 'DEF' ? `${e.team || e.player_id} D/ST` : `${p.first_name || ''} ${p.last_name || ''}`.trim(),
                      pos: p.position, team: e.team || p.team, inj: p.injury_status, body: p.injury_body_part};
    pts[e.player_id] = (e.stats || {})[key] || 0;
  }
  const mine = rosters.find(r => r.owner_id === user.user_id || (r.co_owners || []).includes(user.user_id));
  const rostered = new Set(rosters.flatMap(r => r.players || []));
  const need = new Set([...(mine ? mine.players || [] : []), ...rosters.flatMap(r => r.starters || []),
                        ...trend.map(t => t.player_id), ...[...tx1, ...tx0].flatMap(t => Object.keys(t.adds || {}))]);
  const missing = [...need].filter(p => p && p !== '0' && !P[p]);
  if (missing.length) {
    const all = await allPlayers().catch(() => ({}));
    for (const p of missing) {
      const a = all[p];
      if (a) P[p] = {name: a.position === 'DEF' ? `${p} D/ST` : a.full_name || `${a.first_name} ${a.last_name}`,
                     pos: a.position, team: a.team, inj: a.injury_status, body: a.injury_body_part};
      else if (/^[A-Z]{2,3}$/.test(p)) P[p] = {name: p + ' D/ST', pos: 'DEF', team: p};
    }
  }
  return {st, user, leagues, lg, season, week, rosters, users, matchups, P, pts, games, mine, rostered, trend, drops, tx: [...tx1, ...tx0], at: new Date()};
}
const pickLeague = () => BASE.leagues.find(l => l.league_id === cfg.league) || BASE.leagues.find(l => l.status === 'in_season') || BASE.leagues[0];

const pl = id => D.P[id] || {name: id === '0' || !id ? 'Empty' : 'Player ' + id, pos: '?'};
function opp(id) {
  const t = pl(id).team, g = D.games[t];
  if (!t) return '';
  if (!g) return 'BYE';
  return (g.home ? 'vs ' : '@ ') + g.opp;
}
function badge(id) {
  const p = pl(id);
  if (!id || id === '0') return ['EMPTY', 'bad'];
  if (p.team && !D.games[p.team] && Object.keys(D.games).length) return ['BYE', 'bad'];
  if (BAD[p.inj]) return [BAD[p.inj], 'bad'];
  if (p.inj === 'Questionable') return ['Q', 'wait'];
  return ['START', 'ok'];
}
const eff = id => (badge(id)[1] === 'bad' ? 0 : D.pts[id] || 0);
const fits = (slot, pos) => slot === pos || (SLOT[slot] || []).includes(pos);
const posCls = p => ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].includes(p) ? 'pos-' + p : 'pos-FLEX';
const sleeperLink = () => `<a class="pbtn sm" href="https://sleeper.com/leagues/${esc(D.lg.league_id)}">Open Sleeper</a>`;
function teamName(rosterId) {
  const r = D.rosters.find(x => x.roster_id === rosterId);
  const u = r && D.users.find(x => x.user_id === r.owner_id);
  return u ? (u.metadata && u.metadata.team_name) || u.display_name : 'Team ' + rosterId;
}
function lineup() {
  const slots = (D.lg.roster_positions || []).filter(s => !SKIP.has(s));
  const starters = D.mine.starters || [];
  const bench = (D.mine.players || []).filter(p => !starters.includes(p) && !(D.mine.reserve || []).includes(p) && !(D.mine.taxi || []).includes(p));
  return {slots, starters, bench};
}
function swaps() {
  const {slots, starters, bench} = lineup(), used = new Set(), out = [];
  const cand = slots.map((s, i) => ({i, s, cur: starters[i], best: bench.filter(b => fits(s, pl(b).pos)).sort((a, b) => eff(b) - eff(a))}));
  for (let pass = 0; pass < slots.length; pass++) {
    let top = null;
    for (const c of cand) {
      if (c.done) continue;
      const b = c.best.find(x => !used.has(x));
      if (!b) continue;
      const gain = eff(b) - eff(c.cur);
      if (gain > 1.5 && (!top || gain > top.gain)) top = {c, b, gain};
    }
    if (!top) break;
    top.c.done = true; used.add(top.b);
    out.push({out: top.c.cur, in: top.b, gain: top.gain, slot: top.c.s});
  }
  return out;
}

// ---- building blocks (Home lanes + cards, Map rows) ----
const lane = (cls, title, n, body, extra = '') =>
  `<section class="hl ${cls}"><div class="hl-h"><b>${esc(title)}</b>${n != null ? `<span class="n">${n}</span>` : ''}<span class="sp"></span>${extra}</div><div class="hl-t">${body}</div></section>`;
const pill = (txt, cls) => `<span class="st ${cls}">${esc(txt)}</span>`;
const counts = items => `<div class="hcnt">${items.map(([cls, n, t]) => `<span><i class="hd ${cls}"></i><b>${n}</b> ${esc(t)}</span>`).join('')}</div>`;
const pageTop = (title, cnt = '') => `<div class="htop"><h1>${esc(title)}</h1>${cnt}</div>`;
function playerCard(id, slot, showOk = true) {
  const p = pl(id), [b, c] = badge(id);
  const line = [slot && slot !== p.pos ? slot.replace('_', ' ') + ' · ' + (p.pos || '') : p.pos || '', opp(id), 'proj ' + f1(D.pts[id])].filter(Boolean).join(' · ');
  return `<div class="ht ${posCls(slot && SLOT[slot] ? 'FLEX' : p.pos)}"><span class="rn">${esc(p.name)}</span>${showOk || c !== 'ok' ? pill(b === 'START' ? 'Start' : b, c) : '<span></span>'}
    <div class="rs">${esc(line)}${p.body && c !== 'ok' ? ' · ' + esc(p.body) : ''}</div></div>`;
}

// ---- Team ----
function vLineup() {
  const {slots, starters, bench} = lineup();
  const total = starters.reduce((a, p) => a + eff(p), 0);
  const bs = starters.map(badge);
  const nOk = bs.filter(b => b[1] === 'ok').length, nQ = bs.filter(b => b[1] === 'wait').length, nBad = bs.filter(b => b[1] === 'bad').length;
  const sw = swaps();
  const askTxt = `Who should I start this week? (${D.lg.name}, week ${D.week})` + (sw.length ? ` Thinking ${pl(sw[0].in).name} over ${pl(sw[0].out).name}?` : '');
  const swapCards = sw.map(s => `<div class="ht big ${posCls(pl(s.in).pos)}"><span class="rn">Start ${esc(pl(s.in).name)}</span>${pill('+' + f1(s.gain), 'ok')}
      <div class="rs">over ${esc(pl(s.out).name)} · ${esc(s.slot.replace('_', ' '))}</div></div>`).join('');
  const sc = D.lg.scoring_settings || {}, scoring = sc.rec >= 1 ? 'PPR' : sc.rec >= .5 ? 'half PPR' : 'standard';
  return pageTop(`Week ${D.week} lineup`, counts([['ok', nOk, 'starting'], ['wait', nQ, 'questionable'], ['bad', nBad, 'out or bye']]))
    + `<div class="pbar"><span class="upd">Projected <b>${f1(total)}</b> pts</span>${ask('Ask advisor', askTxt, 'pri')}${sleeperLink()}</div>`
    + vMatchup()
    + (sw.length ? lane('l-free', 'Swap ideas', sw.length, swapCards) : lane('l-free', 'Swap ideas', 0, `<p class="note">Your best projected players are already in.</p>`))
    + lane('l-work', 'Starters', starters.length, slots.map((s, i) => playerCard(starters[i], s)).join(''))
    + (bench.length ? lane('l-idle', 'Bench', bench.length, bench.map(id => playerCard(id, '', false)).join('')) : '')
    + vSeason()
    + `<p class="foot">Projections: Sleeper (${scoring}) · updated ${hhmm(D.at)}</p>`;
}
function vMatchup() {
  const me = (D.matchups || []).find(m => m.roster_id === D.mine.roster_id);
  if (!me || me.matchup_id == null) return '';
  const them = D.matchups.find(m => m.matchup_id === me.matchup_id && m.roster_id !== me.roster_id);
  if (!them) return '';
  const proj = m => (m.starters || []).reduce((a, p) => a + (D.pts[p] || 0), 0);
  return lane('l-acc', `vs ${teamName(them.roster_id)}`, null,
    `<div class="ht" style="--bar:var(--dk-accent)"><span class="big">${f1(me.points)} – ${f1(them.points)}</span>${pill('Week ' + D.week, 'acc plain')}
      <div class="rs">Projected ${f1(proj(me))} vs ${f1(proj(them))}</div></div>`);
}
function vSeason() {
  const s = D.mine.settings || {}, fp = r => (r.settings.fpts || 0) + (r.settings.fpts_decimal || 0) / 100;
  if (!(s.wins || s.losses || s.ties)) return '';
  const byRec = [...D.rosters].sort((a, b) => (b.settings.wins - a.settings.wins) || (fp(b) - fp(a)));
  const byPF = [...D.rosters].sort((a, b) => fp(b) - fp(a));
  const rank = byRec.findIndex(r => r.roster_id === D.mine.roster_id) + 1, pf = byPF.findIndex(r => r.roster_id === D.mine.roster_id) + 1;
  return lane('l-done', 'Season so far', null, `<div class="ht" style="--bar:var(--dk-done)"><span class="rn">${s.wins}–${s.losses}${s.ties ? '–' + s.ties : ''} · ${ord(rank)} of ${D.rosters.length}</span><span></span>
    <div class="rs">Points for ${f1(fp(D.mine))} (${ord(pf)} in the league)</div></div>`);
}
function vWaivers() {
  const posOK = new Set((D.lg.roster_positions || []).flatMap(s => SLOT[s] || [s]));
  const picks = D.trend.filter(t => !D.rostered.has(t.player_id) && posOK.has(pl(t.player_id).pos)).slice(0, 8);
  const faab = D.lg.settings.waiver_type === 2;
  const cards = picks.map((t, i) => {
    const p = pl(t.player_id), [b, c] = badge(t.player_id);
    const q = `Should I pick up ${p.name} (${p.pos}, ${p.team || 'FA'}) in ${D.lg.name}?` + (faab ? ' How much FAAB should I bid?' : '') + ' Who would I drop?';
    return `<div class="ht ${posCls(p.pos)}"><span class="rn">${i + 1}. ${esc(p.name)}</span>${cfg.to ? `<a class="st acc plain" href="${esc(smsHref(q))}">Ask</a>` : '<span></span>'}
      <div class="rs">${esc(p.pos || '')} · ${esc(p.team || 'FA')} · +${t.count.toLocaleString()} adds today · proj ${f1(D.pts[t.player_id])}${c !== 'ok' ? ' · ' + b : ''}</div></div>`;
  }).join('') || `<p class="note">No hot free agents right now.</p>`;
  let budget = '';
  if (faab) {
    const tot = D.lg.settings.waiver_budget || 100, left = r => tot - ((r.settings || {}).waiver_budget_used || 0);
    const mine = left(D.mine), avg = D.rosters.reduce((a, r) => a + left(r), 0) / D.rosters.length;
    budget = lane('l-acc', 'FAAB budget', null, `<div class="ht" style="--bar:var(--dk-accent)"><span class="big">$${mine} <span class="pts">of $${tot} left</span></span><span></span>
      <div class="rs">League average: $${Math.round(avg)} left</div></div>`);
  } else if (D.mine.settings.waiver_position) {
    budget = lane('l-acc', 'Waiver priority', null, `<div class="ht" style="--bar:var(--dk-accent)"><span class="big">#${D.mine.settings.waiver_position}</span><span></span></div>`);
  }
  return pageTop('Waivers', counts([['ok', picks.length, 'hot pickups free in your league']]))
    + `<div class="pbar">${ask('Who should I add?', `Who should I pick up off waivers this week in ${D.lg.name}?`, 'pri')}${sleeperLink()}</div>`
    + lane('l-free', 'Hot pickups', picks.length, cards) + budget;
}
function vAlerts() {
  const {slots, starters, bench} = lineup(), bad = [], warn = [], watch = [];
  starters.forEach((id, i) => {
    if (!id || id === '0') return;
    const p = pl(id), [b, c] = badge(id);
    if (c === 'ok') return;
    const sub = bench.filter(x => fits(slots[i], pl(x).pos) && badge(x)[1] === 'ok').sort((a, z) => eff(z) - eff(a))[0];
    const what = b === 'BYE' ? 'on bye' : b === 'Q' ? 'questionable' : b.toLowerCase();
    const card = `<div class="ht big ${posCls(p.pos)}"><span class="rn">${esc(p.name)} is ${esc(what)}</span>${pill(b, c)}
      <div class="rs">In your starting lineup${p.body ? ' · ' + esc(p.body) : ''}${sub ? ` · best swap <b>${esc(pl(sub).name)}</b> (proj ${f1(D.pts[sub])})` : ''}</div>
      <div class="rs chips">${ask(sub ? 'Swap him in?' : 'What should I do?', `${p.name} is ${what} this week. ${sub ? 'Should I start ' + pl(sub).name + ' instead?' : 'Who should I start instead?'}`)}</div></div>`;
    (c === 'bad' ? bad : warn).push(card);
  });
  for (const id of bench) {
    const p = pl(id);
    if (BAD[p.inj] || p.inj === 'Questionable') watch.push(`<div class="ht ${posCls(p.pos)}"><span class="rn">${esc(p.name)}</span>${pill(BAD[p.inj] || 'Q', p.inj === 'Questionable' ? 'wait' : 'bad')}
      <div class="rs">On your bench${p.body ? ' · ' + esc(p.body) : ''}</div></div>`);
  }
  const dropSet = new Map(D.drops.map(d => [d.player_id, d.count]));
  for (const id of (D.mine.players || []).filter(x => (dropSet.get(x) || 0) > 20000).sort((a, z) => dropSet.get(z) - dropSet.get(a)).slice(0, 3)) {
    watch.push(`<div class="ht big ${posCls(pl(id).pos)}"><span class="rn">${esc(pl(id).name)}</span>${pill('Watch', 'wait')}
      <div class="rs">Dropped in ${dropSet.get(id).toLocaleString()} Sleeper leagues in the last day</div>
      <div class="rs chips">${ask('Should I drop him?', `${pl(id).name} is getting dropped everywhere. Should I drop him?`)}</div></div>`);
  }
  return pageTop('Alerts', counts([['bad', bad.length, 'out or bye'], ['wait', warn.length, 'questionable'], ['park', watch.length, 'to watch']]))
    + (bad.length ? lane('l-bad', 'Fix before kickoff', bad.length, bad.join('')) : '')
    + (warn.length ? lane('l-wait', 'Questionable starters', warn.length, warn.join('')) : '')
    + (!bad.length && !warn.length ? lane('l-free', 'All clear', null, `<p class="note">No injuries or byes in your starting lineup for week ${D.week}.</p>`) : '')
    + (watch.length ? lane('l-idle', 'Keep an eye on', watch.length, watch.join('')) : '');
}
function vTrades() {
  const trades = D.tx.filter(t => t.type === 'trade' && t.status === 'complete').slice(0, 6).map(t => {
    const got = {};
    for (const [p, r] of Object.entries(t.adds || {})) (got[r] = got[r] || []).push(pl(p).name);
    const sides = Object.entries(got);
    return `<div class="ht big" style="--bar:var(--dk-sess-2)"><span class="rn">${esc(sides.map(([r]) => teamName(+r)).join(' ⇄ '))}</span><span class="pts">${esc(when(new Date(t.status_updated || t.created).toISOString()))}</span>
      ${sides.map(([r, ps]) => `<div class="rs"><b>${esc(teamName(+r))}</b>&nbsp;gets ${esc(ps.join(', '))}</div>`).join('')}</div>`;
  }).join('');
  const qs = ['Who should I trade for?', 'Am I a buyer or a seller right now?', 'Who on my team is a sell-high?', 'Is this trade fair: '];
  return pageTop('Trades')
    + lane('l-acc', 'Thinking about a trade?', null, `<p class="note">Text your advisor the offer and get a call on it.</p>
      <div class="chips">${cfg.to ? qs.map(q => `<a class="pbtn sm" href="${esc(smsHref(q))}">${esc(q.replace(': ', '…'))}</a>`).join('') : ''}</div>`)
    + lane('l-idle', 'Recent trades in your league', trades ? null : 0, trades || `<p class="note">No trades in the last two weeks.</p>`);
}
// ---- Live: per-team live-game text ticks + activity log ----
// The texter runs on the advisor's side; a tick travels as a text ("Live texts off: <team>") and the feed confirms it.
const KEYS = new Map();    // league_id -> feed key (sha256 prefix, as the exporter makes it; the feed never has raw ids)
async function teamKeys() {
  if (!BASE || !BASE.leagues || !(window.crypto && crypto.subtle)) return;
  for (const l of BASE.leagues) {
    if (KEYS.has(l.league_id)) continue;
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(l.league_id)));
    KEYS.set(l.league_id, Array.from(new Uint8Array(h).slice(0, 8), b => b.toString(16).padStart(2, '0')).join(''));
  }
}
const LIVEK = {td: ['TD', 'done'], pick6: ['Pick-six', 'bad'], int: ['Pick', 'bad'], fumble: ['Fumble', 'bad'], fg: ['Long FG', 'ok'],
               big: ['Big play', 'ok'], injury: ['Injury', 'bad'], back: ['Back in', 'done'], lead: ['Matchup', 'wait'],
               half: ['Halftime', 'park'], final: ['Final', 'wait'], pregame: ['Pregame', 'park'], out: ['Out', 'bad'], pref: ['Setting', 'park']};
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
function livePend() { try { return JSON.parse(store.get('livepend') || '{}') || {}; } catch (e) { return {}; } }
function liveState(id) {
  const k = KEYS.get(id), t = FEED && FEED.live && FEED.live.texts || {};
  const conf = k && k in t ? !!t[k] : true;                     // no pref yet = texts on
  const p = livePend()[id];
  return p && p.on !== conf && Date.now() - p.at < 20 * 60000 ? {on: p.on, pending: true} : {on: conf, pending: false};
}
const liveText = (l, on) => `Live texts ${on ? 'on' : 'off'}: ${(l.name || '').trim()}`;
function vLive() {
  const ticks = BASE.leagues.map(l => {
    const s = liveState(l.league_id), href = cfg.to ? smsHref(liveText(l, !s.on)) : '';
    return `<a class="lvt${s.on ? ' on' : ''}${s.pending ? ' pend' : ''}" ${href ? `href="${esc(href)}"` : 'aria-disabled="true"'} data-live="${esc(l.league_id)}" role="checkbox" aria-checked="${s.on}">
      <span class="bx" aria-hidden="true">${s.on ? CHECK : ''}</span><span class="lvn"><b>${esc((l.name || 'League').trim())}</b><small>${s.pending ? 'Press send in Messages to confirm' : s.on ? 'Texts for the big stuff' : 'Log only, no texts'}</small></span>${s.pending ? pill('Waiting', 'wait') : ''}</a>`;
  }).join('');
  const k = KEYS.get(D.lg.league_id);
  const all = (FEED && FEED.live && FEED.live.log || []).filter(r => r.k === k || (r.k === '' && r.kind === 'pref'));
  const rows = all.slice(-80).reverse();
  let day = '', log = '';
  for (const r of rows) {
    const d = new Date(r.ts), lbl = isNaN(d) ? '' : new Date().toDateString() === d.toDateString() ? 'Today' : d.toLocaleDateString([], {weekday: 'short', month: 'short', day: 'numeric'});
    if (lbl !== day) { day = lbl; log += `<div class="lvd">${esc(lbl)}</div>`; }
    const [kl, k0] = LIVEK[r.kind] || [r.kind, ''], kc = r.kind === 'td' && /opponent/i.test(r.line) ? 'bad' : k0;
    log += `<div class="ht lvr k-${esc(kc)}"><span class="rn">${esc(r.line)}</span><span class="pts">${isNaN(d) ? '' : esc(hhmm(d))}</span>
      <div class="rs">${pill(kl, kc)}${r.texted ? pill('Texted you', 'ok') : ''}</div></div>`;
  }
  const on = BASE.leagues.filter(l => liveState(l.league_id).on).length;
  return pageTop('Live games', counts([['ok', on, 'texting'], ['park', BASE.leagues.length - on, 'log only'], ['done', all.length, 'in this log']]))
    + lane('l-acc', 'Live game texts', null, `<p class="note">Tick a team to get texts during its games. Only the big stuff gets a text: <b>your starter scores or gets hurt, a starter ruled out, your matchup flipping, and the final</b>. Everything else just lands in the log.</p>
      <div class="lvts">${ticks}</div>${cfg.to ? '' : '<p class="note">Open this app from your advisor\'s link to change these.</p>'}`)
    + lane('l-idle', 'Live activity · ' + (D.lg.name || '').trim(), rows.length || 0, log || `<p class="note">Nothing yet. During games, every play that matters to this team shows up here, newest first.</p>`,
      `<span class="pts">${esc(feedTime())}</span>`);
}
function vTeam() {
  const seg = `<div class="seg" role="tablist">${SUBS.map(s => `<button type="button" role="tab" data-s="${s}" class="${s === cfg.sub ? 'on' : ''}" aria-selected="${s === cfg.sub}">${s}</button>`).join('')}</div>`;
  if (!cfg.u) return setupHTML();
  if (DERR) return seg + DERR;
  if (!D) return seg + `<p class="empty">Loading your team…</p>`;
  if (!D.mine) return seg + `<p class="empty">You're not on a team in ${esc(D.lg.name)}.</p>`;
  try { return seg + ({Lineup: vLineup, Waivers: vWaivers, Alerts: vAlerts, Trades: vTrades, Live: vLive}[cfg.sub])(); }
  catch (e) { console.error(e); return seg + `<p class="empty">Something didn't load right. Tap refresh to try again.</p>`; }
}
function setupHTML(msg) {
  return `<form class="setup" id="su"><h1>Hook up your Sleeper team</h1>
    <p>Type your Sleeper username. No password needed; it only stays on this phone.</p>
    <input id="un" placeholder="Sleeper username" autocapitalize="none" autocorrect="off" spellcheck="false" value="${esc(cfg.u)}">
    ${msg ? `<div class="err">${esc(msg)}</div>` : ''}
    <button class="pbtn pri" type="submit">Show my team</button>
    <p class="foot">Tip: in Safari tap Share → Add to Home Screen to keep this as an app.</p></form>`;
}

// ---- feed (Map + Research) ----
async function loadFeed() {
  try {
    const r = await fetch('data/feed.json?t=' + Date.now(), {cache: 'no-store'});
    if (!r.ok) throw new Error(r.status);
    FEED = await r.json(); FERR = false; FAT = new Date();
  } catch (e) { FERR = true; }
}
const feedTime = () => FEED && FEED.generated_at ? `Updated ${hhmm(new Date(FEED.generated_at))}` : 'No updates yet';
const ST = {queued: ['Queued', 'wait'], running: ['Working', 'ok'], done: ['Done', 'done'], failed: ['Stopped', 'bad'],
            planned: ['Planned', 'wait'], idle: ['Idle', ''], working: ['Working', 'ok'], texting: ['Texting', 'ok']};
const KIND = {research: 'Research', feature: 'App feature', check: 'Check'};
const stp = s => pill((ST[s] || [s || '—'])[0], (ST[s] || [, ''])[1]);
function feedBar() {
  return `<div class="pbar"><span class="upd" id="upd">${esc(feedTime())}</span><button type="button" class="pbtn" data-act="feed">Refresh</button></div>`;
}
function vMap() {
  if (!FEED) return feedBar() + `<section class="region"><p class="dnone">${FERR ? 'Nothing posted yet. Your advisor\'s work shows up here once it starts.' : 'Loading…'}</p></section>`;
  const a = FEED.advisor || {}, dl = (FEED.delegations || []).map((d, i) => ({...d, i}));
  const q = Q.trim().toLowerCase(), hit = d => !q || (d.label || '').toLowerCase().includes(q) || (KIND[d.kind] || '').toLowerCase().includes(q);
  const groups = [['running', 'Working'], ['queued', 'Queued'], ['done', 'Done'], ['failed', 'Stopped']];
  const row = d => `<button type="button" class="drow${SEL === 'd' + d.i ? ' on' : ''}" data-sel="d${d.i}"><span class="dn">${esc(d.label)}</span>${stp(d.status)}
      <span class="dl">${esc([KIND[d.kind] || d.kind, d.done ? 'finished ' + when(d.done) : d.started ? 'started ' + when(d.started) : ''].filter(Boolean).join(' · '))}</span></button>`;
  let list = `<div class="dcap"><span>Advisor</span></div>
    <button type="button" class="drow adv${SEL === 'advisor' ? ' on' : ''}" data-sel="advisor"><span class="dn">Your advisor</span>${stp(a.state || 'idle')}
      <span class="dl">${esc(a.now || 'Ready when you text.')}</span></button>`;
  for (const [s, t] of groups) {
    const g = dl.filter(d => d.status === s && hit(d));
    if (g.length) list += `<div class="dcap"><span>${t} · ${g.length}</span></div>` + g.map(row).join('');
  }
  if (!dl.length) list += `<p class="dnone">Nothing handed off yet. When your advisor sends work out (research, app features, checks) it shows here.</p>`;
  let dock;
  const d = SEL.startsWith('d') ? dl[+SEL.slice(1)] : null;
  if (d) {
    dock = `<div class="ph"><b>${esc(d.label)}</b>${stp(d.status)}</div><dl class="kv"><dt>Type</dt><dd>${esc(KIND[d.kind] || d.kind)}</dd>
      ${d.started ? `<dt>Started</dt><dd>${esc(when(d.started))}</dd>` : ''}${d.done ? `<dt>Finished</dt><dd>${esc(when(d.done))}</dd>` : ''}</dl>
      <div class="chips" style="margin-top:12px">${d.kind === 'research' ? '<button type="button" class="pbtn sm" data-go="research">See research</button>' : ''}${ask('Ask about this', `About "${d.label}": `)}</div>`;
  } else {
    dock = `<div class="ph"><b>Your advisor</b>${stp(a.state || 'idle')}</div><dl class="kv"><dt>Now</dt><dd>${esc(a.now || 'Ready when you text.')}</dd>
      ${a.last_active ? `<dt>Last active</dt><dd>${esc(when(a.last_active))}</dd>` : ''}<dt>Handing off</dt><dd>${dl.filter(x => x.status === 'running' || x.status === 'queued').length} open · ${dl.filter(x => x.status === 'done').length} done</dd></dl>
      <div class="chips" style="margin-top:12px">${ask('Text your advisor', '', 'pri')}</div>`;
  }
  return feedBar() + `<section class="region"><input type="search" id="mq" placeholder="Find research or task" aria-label="Find research or task" autocomplete="off" value="${esc(Q)}"><div id="mlist">${list}</div></section>
    <section class="dock" aria-label="Details">${dock}</section>`;
}
const okSlug = s => /^[a-z0-9-]{1,80}$/.test(s || '');
function vResearch() {
  if (REPORT) return vReport();
  if (!FEED) return feedBar() + pageTop('Research') + `<p class="empty">${FERR ? 'No research posted yet. Your advisor researches things for your team over time; reports land here.' : 'Loading…'}</p>`;
  const rq = (FEED.research && FEED.research.queue) || [], reps = ((FEED.research && FEED.research.reports) || []).filter(r => okSlug(r.slug));
  const run = rq.filter(x => x.status === 'running'), plan = rq.filter(x => x.status === 'planned');
  const qcard = (x, bar) => `<div class="ht big" style="--bar:${bar}"><span class="rn">${esc(x.title)}</span>${stp(x.status)}${x.why ? `<div class="rs">${esc(x.why)}</div>` : ''}</div>`;
  const rcards = reps.slice().sort((a, b) => String(b.date).localeCompare(String(a.date))).map(r =>
    `<button type="button" class="ht big tap" style="--bar:var(--dk-done)" data-rep="${esc(r.slug)}"><span class="rn">${esc(r.title)}</span><span class="pts">${esc(r.date || '')}</span>
      ${r.summary ? `<div class="rs">${esc(r.summary)}</div>` : ''}</button>`).join('');
  return feedBar() + pageTop('Research', counts([['work', run.length, 'researching'], ['wait', plan.length, 'planned'], ['done', reps.length, 'reports']]))
    + (run.length ? lane('l-work', 'Researching now', run.length, run.map(x => qcard(x, 'var(--dk-working)')).join('')) : '')
    + lane('l-done', 'Reports', reps.length, rcards || `<p class="note">The first report lands here when it's done.</p>`)
    + (plan.length ? lane('l-wait', 'Up next', plan.length, plan.map(x => qcard(x, 'var(--dk-waiting)')).join('')) : '')
    + `<div class="pbar" style="justify-content:flex-start">${ask('Suggest a research topic', 'Can you research: ')}</div>`;
}
function vReport() {
  const r = REPORT;
  const back = `<div class="pbar" style="justify-content:flex-start"><button type="button" class="pbtn" data-act="back">‹ Research</button></div>`;
  if (r.loading) return back + `<p class="empty">Opening…</p>`;
  if (r.err) return back + `<p class="empty">Couldn't open that report. Try again in a minute.</p>`;
  let src = r.text, fm = {};
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) { src = src.slice(m[0].length); for (const l of m[1].split('\n')) { const k = l.match(/^(\w+):\s*(.*)$/); if (k) fm[k[1]] = k[2].replace(/^["']|["']$/g, ''); } }
  const title = fm.title || r.title || '';
  const body = window.DeskMd ? DeskMd.md(src.replace(new RegExp('^#\\s+' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\n'), '')) : `<pre>${esc(src)}</pre>`;
  return back + `<article class="rep"><p class="meta">${esc(fm.date || r.date || '')}</p><h1>${esc(title)}</h1>${body}</article>`;
}
async function openReport(slug) {
  if (!okSlug(slug)) return;
  const meta = ((FEED.research && FEED.research.reports) || []).find(x => x.slug === slug) || {};
  REPORT = {slug, title: meta.title, date: meta.date, loading: true}; render(); scrollTo(0, 0);
  try {
    const r = await fetch(`data/reports/${slug}.md?t=` + Date.now(), {cache: 'no-store'});
    if (!r.ok) throw new Error(r.status);
    REPORT = {...REPORT, loading: false, text: await r.text()};
  } catch (e) { REPORT = {...REPORT, loading: false, err: true}; }
  if (REPORT && REPORT.slug === slug) render();
}

// ---- team switcher (one tap, on every page; remembers the last pick) ----
const ord = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
function teamInfo(d) {
  if (!d || !d.mine) return null;
  const s = d.mine.settings || {}, fp = r => ((r.settings || {}).fpts || 0) + ((r.settings || {}).fpts_decimal || 0) / 100;
  const played = s.wins || s.losses || s.ties;
  const byRec = [...d.rosters].sort((a, b) => ((b.settings || {}).wins - (a.settings || {}).wins) || (fp(b) - fp(a)));
  const me = d.users.find(u => u.user_id === d.user.user_id) || {};
  const keep = D; D = d;   // badge() reads D
  let fix = 0;
  try { fix = (d.mine.starters || []).filter(id => badge(id)[1] === 'bad').length; } finally { D = keep; }
  return {rec: played ? `${s.wins}–${s.losses}${s.ties ? '–' + s.ties : ''} · ${ord(byRec.findIndex(r => r.roster_id === d.mine.roster_id) + 1)}` : '',
          av: (me.metadata || {}).avatar || '', fix};
}
function teamStrip() {
  const el = $('tms');
  if (!BASE || !BASE.leagues || BASE.leagues.length < 2 || !cfg.u) { el.hidden = true; el.innerHTML = ''; return; }
  const cur = D && D.lg ? D.lg.league_id : cfg.league;
  const chips = BASE.leagues.map(l => {
    const i = teamInfo(LG.get(l.league_id)), on = l.league_id === cur, name = (l.name || 'League').trim();
    const av = /^https:\/\/sleepercdn\.com\//.test(i && i.av || '') ? i.av : l.avatar ? 'https://sleepercdn.com/avatars/thumbs/' + l.avatar : '';
    const pic = av ? `<img src="${esc(av)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : esc(Array.from(name)[0] || '?');
    return `<button type="button" class="tm${on ? ' on' : ''}" data-lg="${esc(l.league_id)}" role="tab" aria-selected="${on}">
      <span class="tav" aria-hidden="true">${pic}</span><span class="tx"><b>${esc(name)}</b><small>${esc(i ? i.rec || 'Not started' : on && !D ? 'Loading…' : '')}</small></span>
      ${i && i.fix ? `<span class="tfix" title="${i.fix} to fix before kickoff" aria-label="${i.fix} to fix">${i.fix}</span>` : ''}</button>`;
  }).join('');
  const old = el.querySelector('.trow'), keepX = old ? old.scrollLeft : 0;
  el.hidden = false;
  el.innerHTML = `<div class="tcap">Your teams <span>${BASE.leagues.length}</span></div><div class="trow" role="tablist" aria-label="Your teams">${chips}</div>`;
  const row = el.querySelector('.trow'), on = row.querySelector('.tm.on');
  row.scrollLeft = keepX;
  if (on && (on.offsetLeft < row.scrollLeft || on.offsetLeft + on.offsetWidth > row.scrollLeft + row.clientWidth)) row.scrollLeft = on.offsetLeft - 12;
}
async function switchTeam(id) {
  if (!BASE || !BASE.leagues.some(l => l.league_id === id)) return;
  cfg.league = id; store.set('league', id);
  const moved = cfg.page !== 'team' || REPORT;
  if (cfg.page !== 'team') { cfg.page = 'team'; store.set('page', 'team'); }
  REPORT = null;
  if (moved) scrollTo(0, 0);
  if (LG.has(id)) { D = LG.get(id); DERR = ''; return render(); }
  D = null; DERR = ''; render();
  try { LG.set(id, await loadLeague(BASE.leagues.find(l => l.league_id === id))); }
  catch (e) { console.error(e); if (cfg.league === id) DERR = `<p class="empty">Couldn't reach Sleeper just now. Tap refresh to try again.</p>`; }
  if (cfg.league === id) { D = LG.get(id) || null; render(); }
}
// Load his other teams quietly once the first one is up, so each switch is instant and the chips show records.
async function prefetch() {
  for (const l of BASE ? BASE.leagues : []) {
    if (LG.has(l.league_id)) continue;
    const b = BASE;
    try { const d = await loadLeague(l); if (b === BASE) LG.set(l.league_id, d); } catch (e) {}
    if (b !== BASE) return;
    teamStrip();
  }
}

// ---- chrome ----
const MOON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>';
const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
function chrome() {
  const light = document.documentElement.dataset.theme === 'light';
  $('theme').innerHTML = light ? SUN : MOON;
  $('theme').setAttribute('aria-label', light ? 'Light theme: tap for dark' : 'Dark theme: tap for light');
  document.querySelector('meta[name=theme-color]').content = light ? '#F3F2EF' : '#141a24';
  $('bname').textContent = cfg.n || 'Gameday';
  document.querySelectorAll('.dkn-t').forEach(b => { const on = b.dataset.p === cfg.page; b.classList.toggle('on', on); on ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'); });
  const ta = $('textadv'); ta.hidden = !cfg.to; if (cfg.to) ta.href = smsHref('');
  const lw = $('lgp');
  const cur = BASE && BASE.leagues && (BASE.leagues.find(l => l.league_id === cfg.league) || (D && D.lg));
  if (cur) {
    lw.hidden = false; $('lgname').textContent = cur.name;
    $('lg').innerHTML = BASE.leagues.map(l => `<option value="${esc(l.league_id)}"${l.league_id === cur.league_id ? ' selected' : ''}>${esc(l.name)}</option>`).join('');
    $('lg').disabled = BASE.leagues.length < 2; lw.querySelector('.cv').hidden = BASE.leagues.length < 2;
  } else lw.hidden = true;
  teamStrip();
  fitBrand();
}
function fitBrand() {
  const h = $('hdr'), b = $('brand');
  h.style.setProperty('--nfs', '100px');
  const per = b.getBoundingClientRect().width / 100;
  const cs = getComputedStyle(h), inner = h.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const avail = inner - 44 * 2 - 6 * 3 - 8;
  h.style.setProperty('--nfs', Math.max(28, Math.min(80, Math.floor(avail / per))) + 'px');
  document.documentElement.style.setProperty('--hh', h.offsetHeight + 'px');
}
function render() {
  chrome();
  const v = cfg.page === 'map' ? vMap() : cfg.page === 'research' ? vResearch() : vTeam();
  $('main').innerHTML = v;
  const su = $('su');
  if (su) su.onsubmit = e => { e.preventDefault(); cfg.u = $('un').value.trim(); store.set('u', cfg.u); goTeam(); };
  const mq = $('mq');
  if (mq) mq.oninput = () => { Q = mq.value; const pos = mq.selectionStart; render(); const n = $('mq'); n.focus(); n.setSelectionRange(pos, pos); };
  renderFeat();
}
async function goTeam() {
  BASE = null; LG.clear();
  if (!cfg.u) { D = null; return render(); }
  DERR = ''; D = null; render();
  try {
    BASE = await loadBase();
    if (!BASE.leagues.length) { DERR = setupHTML(`No ${BASE.season} leagues found for "${cfg.u}". Double-check the username?`); D = null; }
    else {
      await teamKeys();
      const lg = pickLeague(), b = BASE;
      cfg.league = lg.league_id; store.set('league', cfg.league); render();
      const d = await loadLeague(lg);
      if (b !== BASE) return;
      LG.set(lg.league_id, d);
      if (cfg.league === lg.league_id) D = d;
      else if (LG.has(cfg.league)) D = LG.get(cfg.league);
      render(); prefetch();
      return;
    }
  } catch (e) {
    console.error(e);
    DERR = e.message === 'nouser' ? setupHTML(`Couldn't find a Sleeper user called "${cfg.u}".`) : `<p class="empty">Couldn't reach Sleeper just now. Tap refresh to try again.</p>`;
  }
  render();
}

// ---- feature box ----
function featText() { const t = $('ftext').value.trim(); return 'Feature request: ' + (t || ''); }
function renderFeat() {
  const t = $('ftext').value.trim();
  const s = $('fsend');
  if (cfg.to && t) { s.href = smsHref(featText()); s.removeAttribute('aria-disabled'); s.style.opacity = ''; }
  else { s.href = '#'; s.setAttribute('aria-disabled', 'true'); s.style.opacity = '.5'; }
  s.hidden = !cfg.to;
  const fs = (FEED && FEED.features) || [];
  const FST = {new: ['Received', 'wait'], building: ['Building', 'ok'], shipped: ['Live', 'done'], declined: ['Not now', '']};
  $('freqs').hidden = !fs.length;
  $('freqs').innerHTML = fs.length ? `<span class="lab">Your requests</span>` + fs.slice(0, 6).map(f => `<div class="req"><span>${esc(f.text)}</span>${pill((FST[f.status] || [f.status])[0], (FST[f.status] || [, ''])[1])}</div>`).join('') : '';
}
function openFeat(open) {
  const f = $('feat'), b = $('featb');
  f.hidden = !open; b.setAttribute('aria-expanded', String(open));
  if (open) { f.style.top = ($('hdr').getBoundingClientRect().bottom + 6) + 'px'; $('fmsg').textContent = ''; renderFeat(); $('ftext').focus(); }
}
$('featb').onclick = () => openFeat($('feat').hidden);
$('fclose').onclick = () => openFeat(false);
$('ftext').oninput = renderFeat;
$('fsend').onclick = e => {
  if (!$('ftext').value.trim()) { e.preventDefault(); $('fmsg').textContent = 'Type your idea first.'; return; }
  $('fmsg').textContent = 'Opening Messages… press send there.';
};
$('fcopy').onclick = async () => {
  const t = $('ftext').value.trim();
  if (!t) { $('fmsg').textContent = 'Type your idea first.'; return; }
  const txt = featText();
  let ok = false;
  try { await navigator.clipboard.writeText(txt); ok = true; } catch (e) {
    const ta = document.createElement('textarea'); ta.value = txt; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, txt.length);
    try { ok = document.execCommand('copy'); } catch (e2) {} ta.remove();
  }
  $('fmsg').textContent = ok ? 'Copied. Paste it into a text to your advisor.' : 'Copy this and text it to your advisor: ' + txt;
};

// ---- events ----
$('nav').onclick = e => {
  const b = e.target.closest('.dkn-t'); if (!b) return;
  cfg.page = b.dataset.p; store.set('page', cfg.page); REPORT = null; render(); scrollTo(0, 0);
  if (cfg.page !== 'team') loadFeed().then(render);
};
$('main').onclick = e => {
  const t = e.target.closest('[data-s],[data-sel],[data-rep],[data-act],[data-go],[data-live]'); if (!t) return;
  if (t.dataset.live) {                 // the link opens Messages with the on/off text; show it pending until the feed confirms
    if (!t.getAttribute('href')) { e.preventDefault(); return; }
    const p = livePend(); p[t.dataset.live] = {on: !liveState(t.dataset.live).on, at: Date.now()};
    store.set('livepend', JSON.stringify(p)); setTimeout(render, 50);
  }
  else if (t.dataset.s) {
    cfg.sub = t.dataset.s; store.set('sub', cfg.sub); render();
    if (cfg.sub === 'Live' && (!FAT || Date.now() - FAT > 30000)) loadFeed().then(render);
  }
  else if (t.dataset.sel) { SEL = t.dataset.sel; render(); document.querySelector('.dock')?.scrollIntoView({behavior: 'smooth', block: 'nearest'}); }
  else if (t.dataset.rep) openReport(t.dataset.rep);
  else if (t.dataset.go) { cfg.page = t.dataset.go; store.set('page', cfg.page); render(); scrollTo(0, 0); }
  else if (t.dataset.act === 'back') { REPORT = null; render(); }
  else if (t.dataset.act === 'feed') { t.textContent = 'Refreshing…'; loadFeed().then(render); }
};
$('lg').onchange = e => switchTeam(e.target.value);
$('tms').onclick = e => { const t = e.target.closest('[data-lg]'); if (t) switchTeam(t.dataset.lg); };
$('refresh').onclick = async () => {
  const r = $('refresh'); r.classList.add('spin');
  await Promise.all([loadFeed(), cfg.page === 'team' ? goTeam() : Promise.resolve()]);
  r.classList.remove('spin'); render();
};
$('theme').onclick = () => {
  const n = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = n; store.set('theme', n); chrome();
};
$('brand').onclick = e => { e.preventDefault(); cfg.page = 'team'; store.set('page', 'team'); REPORT = null; render(); scrollTo(0, 0); };
addEventListener('resize', fitBrand);
// The header's league pill is the switcher's sticky stand-in: hidden while the team chips are on screen, back once scrolled past.
if (window.IntersectionObserver) new IntersectionObserver(es => { for (const e of es) $('lgp').classList.toggle('away', e.isIntersecting); },
  {rootMargin: '-200px 0px 0px 0px'}).observe($('tms'));
document.addEventListener('visibilitychange', () => { if (!document.hidden && FAT && Date.now() - FAT > 60000) loadFeed().then(render); });
if (document.fonts) document.fonts.ready.then(fitBrand);

render();
loadFeed().then(render);
goTeam();
