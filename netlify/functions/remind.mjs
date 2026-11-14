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

export const config = { path: '/api/remind' };
