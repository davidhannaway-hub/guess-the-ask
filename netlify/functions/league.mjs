// Private leagues. No accounts: a player is the random id the game already keeps in localStorage.
// Store "leagues":
//   l/<CODE>          {name, by, at}         one per league
//   m/<CODE>/<id>     '1'                    one per member, so joins never race
//   p/<id>            {nick, s:{ie:{date:score}, uk:{...}}}  a player's name and recent scores
// Scores land in p/<id> from /api/scores, or here from the player's own report of today's
// game, which is only accepted if the matching score blob exists in the "scores" store.
import { getStore } from '@netlify/blobs';
import { recordPlayerScore, today } from '../lib/players.mjs';

const MAX_MEMBERS = 50, MAX_LEAGUES = 10;
const ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const okId = id => /^[a-z0-9-]{8,64}$/i.test(String(id || ''));
const okCode = c => new RegExp(`^[${ABC}]{6}$`).test(String(c || ''));
const okCountry = c => c === 'ie' || c === 'uk';
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

// Monday-to-Sunday week containing `date` (YYYY-MM-DD), as date strings.
export function weekDates(date) {
  const d = new Date(date + 'T12:00:00Z'), back = (d.getUTCDay() + 6) % 7;
  return [...Array(7)].map((_, i) => new Date(d.getTime() - (back - i) * 864e5).toISOString().slice(0, 10)).filter(x => x <= date);
}

async function members(store, code) {
  const { blobs } = await store.list({ prefix: `m/${code}/` });
  return blobs.map(b => b.key.split('/')[2]);
}
const player = async (store, id) => (await store.get(`p/${id}`, { type: 'json' })) || { nick: '', s: {} };

async function setNick(store, id, nick) {
  const p = await player(store, id);
  if (p.nick !== nick) { p.nick = nick; await store.setJSON(`p/${id}`, p); }
}

async function board(store, code, country, me) {
  const meta = await store.get(`l/${code}`, { type: 'json' });
  if (!meta) return null;
  const date = today(), week = weekDates(date);
  const ids = await members(store, code);
  const rows = await Promise.all(ids.map(async id => {
    const p = await player(store, id), s = (p.s && p.s[country]) || {};
    const wk = week.filter(d => s[d] != null);
    return { nick: p.nick || 'Someone', me: id === me, today: s[date] ?? null, week: wk.reduce((a, d) => a + s[d], 0), days: wk.length };
  }));
  return { code, name: meta.name, country, date, weekDays: week.length, members: rows };
}

export default async (req) => {
  const store = getStore({ name: 'leagues', consistency: 'strong' });
  const url = new URL(req.url);

  // Invite preview: league name and size, nothing about members.
  if (req.method === 'GET') {
    const code = String(url.searchParams.get('code') || '').toUpperCase();
    if (!okCode(code)) return json({ error: 'bad code' }, 400);
    const meta = await store.get(`l/${code}`, { type: 'json' });
    if (!meta) return json({ error: 'not found' }, 404);
    const by = meta.by ? (await player(store, meta.by)).nick : '';
    return json({ code, name: meta.name, by, size: (await members(store, code)).length });
  }
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let b; try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const id = String(b.id || '');
  if (!okId(id)) return json({ error: 'bad id' }, 400);

  if (b.action === 'create') {
    const name = clean(b.name, 24), nick = clean(b.nick, 16);
    if (!name || !nick) return json({ error: 'name and nick needed' }, 400);
    let code = null;
    for (let i = 0; i < 8 && !code; i++) {
      const c = [...crypto.getRandomValues(new Uint8Array(6))].map(x => ABC[x % ABC.length]).join('');
      if (!(await store.get(`l/${c}`))) code = c;   // 31^6 codes, so a clash is near impossible
    }
    if (!code) return json({ error: 'try again' }, 503);
    await store.setJSON(`l/${code}`, { name, by: id, at: new Date().toISOString() });
    await store.set(`m/${code}/${id}`, '1');
    await setNick(store, id, nick);
    return json({ code, name });
  }

  if (b.action === 'join') {
    const code = String(b.code || '').toUpperCase(), nick = clean(b.nick, 16);
    if (!okCode(code) || !nick) return json({ error: 'bad input' }, 400);
    const meta = await store.get(`l/${code}`, { type: 'json' });
    if (!meta) return json({ error: 'not found' }, 404);
    const ids = await members(store, code);
    if (!ids.includes(id) && ids.length >= MAX_MEMBERS) return json({ error: 'full' }, 409);
    await store.set(`m/${code}/${id}`, '1');
    await setNick(store, id, nick);
    return json({ code, name: meta.name });
  }

  if (b.action === 'leave') {
    const code = String(b.code || '').toUpperCase();
    if (!okCode(code)) return json({ error: 'bad code' }, 400);
    await store.delete(`m/${code}/${id}`);
    return json({ ok: true });
  }

  if (b.action === 'view') {
    const country = b.country;
    if (!okCountry(country)) return json({ error: 'bad country' }, 400);
    const codes = [...new Set((Array.isArray(b.codes) ? b.codes : []).map(c => String(c).toUpperCase()).filter(okCode))].slice(0, MAX_LEAGUES);
    // Today's own score, for games finished before leagues existed or when the scores call failed.
    const score = Math.round(Number(b.score));
    if (b.score != null && score >= 0 && score <= 700) {
      const scores = getStore({ name: 'scores', consistency: 'strong' });
      const real = await scores.get(`${country}/${today()}/${String(score).padStart(3, '0')}-${id}`);
      if (real != null) await recordPlayerScore(store, id, country, today(), score);
    }
    const leagues = (await Promise.all(codes.map(c => board(store, c, country, id)))).filter(Boolean);
    // Drop leagues this player is no longer in (left on another tab, or never joined).
    return json({ leagues: leagues.filter(l => l.members.some(m => m.me)), gone: codes.filter(c => !leagues.some(l => l.code === c && l.members.some(m => m.me))) });
  }

  return json({ error: 'unknown action' }, 400);
};

export const config = { path: '/api/league' };
