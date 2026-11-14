// Daily reminder sign-ups (the bell on the results screen).
// Store "reminders":
//   e/<hash of email>   {email, c:[countries], t: unsubscribe token, at}
//   t/<token>           <hash>   so an unsubscribe link finds the sign-up
// POST {email, country}           -> sign up (or add a country)
// GET  ?u=<token>                 -> unsubscribe, shows a plain page
import { getStore } from '@netlify/blobs';
import { createHash, randomBytes } from 'node:crypto';
import { COUNTRIES } from '../lib/players.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const page = msg => new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Guess the Ask</title><body style="margin:0;font:17px -apple-system,BlinkMacSystemFont,sans-serif;background:#121212;color:#fff;display:grid;place-items:center;min-height:100vh;text-align:center;padding:24px;box-sizing:border-box"><div><div style="font-size:26px;font-weight:800;margin-bottom:10px">Guess the <span style="color:#00A651">Ask</span></div><p>${msg}</p><p><a href="https://guesstheask.com" style="color:#F4C300;font-weight:800">Play today's houses</a></p></div>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
const okEmail = e => /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,}$/i.test(e);
export const hashOf = e => createHash('sha256').update(e).digest('hex').slice(0, 32);

export default async (req) => {
  const store = getStore({ name: 'reminders', consistency: 'strong' });
  const url = new URL(req.url);

  if (req.method === 'GET' && url.searchParams.has('admin')) return admin(store, url);
  if (req.method === 'GET') {
    const t = String(url.searchParams.get('u') || '');
    if (!/^[a-f0-9]{32}$/.test(t)) return page('That link doesn’t look right.');
    const h = await store.get(`t/${t}`);
    if (h) { await store.delete(`e/${h}`); await store.delete(`t/${t}`); }
    return page('You’re unsubscribed. No more reminders.');
  }
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let b; try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const email = String(b.email || '').trim().toLowerCase(), c = String(b.country || '');
  if (!okEmail(email)) return json({ error: 'email' }, 400);
  if (!COUNTRIES.includes(c)) return json({ error: 'country' }, 400);
  const h = hashOf(email);
  const cur = await store.get(`e/${h}`, { type: 'json' });
  if (cur) {
    if (!cur.c.includes(c)) { cur.c.push(c); await store.setJSON(`e/${h}`, cur); }
    return json({ ok: true });
  }
  const t = randomBytes(16).toString('hex');
  await store.setJSON(`e/${h}`, { email, c: [c], t, at: new Date().toISOString() });
  await store.set(`t/${t}`, h);
  return json({ ok: true });
};

// Private view for Dave: /api/remind?admin=<ADMIN_KEY>
//   (default)  HTML list of every sign-up, newest first
//   &csv=1     the same as a CSV download
//   &json=1    counts only (used by the morning report)
const ADMIN_HASH = '2458188da413db1748d7b207ab75d1eb545bb09554d889965b025d66f5c826cc';
async function admin(store, url) {
  const key = String(url.searchParams.get('admin') || '');
  // Only a fingerprint of the private key lives here, so a public repo doesn't give it away.
  if (createHash('sha256').update(key).digest('hex') !== ADMIN_HASH) return new Response('Not found', { status: 404 });
  const { blobs } = await store.list({ prefix: 'e/' });
  const subs = (await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' })))).filter(Boolean)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const since = new Date(Date.now() - 864e5).toISOString();
  const by = c => subs.filter(s => s.c.includes(c)).length;
  const counts = Object.fromEntries(COUNTRIES.map(c => [c, by(c)]));
  const newCounts = Object.fromEntries(COUNTRIES.map(c => [c, subs.filter(s => s.at >= since && s.c.includes(c)).length]));
  const sent = {};
  for (const c of COUNTRIES) {
    const days = [0, 1].map(d => new Date(Date.now() - d * 864e5).toLocaleDateString('en-CA', { timeZone: 'Europe/Dublin' }));
    sent[c] = {};
    for (const d of days) { const v = await store.get(`sent/${c}/${d}`); if (v != null) sent[c][d] = Number(v); }
  }
  if (url.searchParams.get('json')) {
    return json({ total: subs.length, new_last_24h: subs.filter(s => s.at >= since).length, by_country: counts, new_by_country_last_24h: newCounts, reminders_sent: sent, resend_key_set: !!process.env.RESEND_API_KEY });
  }
  if (url.searchParams.get('csv')) {
    const csv = 'email,countries,signed_up\n' + subs.map(s => `${s.email},${s.c.join(' ')},${s.at}`).join('\n');
    return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="guesstheask-signups.csv"', 'cache-control': 'no-store' } });
  }
  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const flag = { ie: 'IE', uk: 'UK', us: 'US' };
  const rows = subs.map(s => `<tr><td>${esc(s.email)}</td><td>${s.c.map(c => flag[c] || c).join(' · ')}</td><td>${esc(String(s.at).slice(0, 16).replace('T', ' '))}</td></tr>`).join('');
  const k = encodeURIComponent(key);
  return new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Sign-ups · Guess the Ask</title>
<body style="margin:0;font:15px -apple-system,BlinkMacSystemFont,sans-serif;background:#121212;color:#fff;padding:24px">
<div style="font-size:24px;font-weight:800">Guess the <span style="color:#00A651">Ask</span> · reminder sign-ups</div>
<p style="font-size:40px;font-weight:800;margin:16px 0 4px">${subs.length}</p>
<p style="margin:0 0 16px;color:#bbb">Ireland ${counts.ie} · UK ${counts.uk} · USA ${counts.us} &nbsp;|&nbsp; new in last 24h: ${subs.filter(s => s.at >= since).length}</p>
<p><a href="?admin=${k}&csv=1" style="color:#F4C300;font-weight:800">Download CSV</a></p>
<table style="border-collapse:collapse;width:100%;max-width:720px"><tr style="text-align:left;color:#888"><th style="padding:6px 8px">Email</th><th style="padding:6px 8px">Country</th><th style="padding:6px 8px">Signed up (UTC)</th></tr>
${rows.replace(/<td>/g, '<td style="padding:6px 8px;border-top:1px solid #2a2a2a">') || '<tr><td style="padding:6px 8px;color:#888" colspan="3">No sign-ups yet.</td></tr>'}</table>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}

export const config = { path: '/api/remind' };
