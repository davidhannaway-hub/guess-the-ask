// Web push sign-ups (the "Turn on reminders" button on the results screen).
// Store "push":  p/<hash of endpoint>  {sub, c:[countries], at}
// GET                          -> {key: <public VAPID key>} for the browser to subscribe with
// POST {subscription, country} -> save (or add a country to) a subscription
// POST {unsubscribe, endpoint} -> remove a subscription
// Needs VAPID_PRIVATE_KEY (send-reminders signs with it); the public key is not a secret.
import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import { COUNTRIES } from '../lib/players.mjs';
import { PUBLIC_KEY } from '../lib/vapid.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const hashOf = e => createHash('sha256').update(e).digest('hex').slice(0, 32);

// Only real browser push services: the server will POST to this address, so never accept any other host.
const PUSH_HOST = /^https:\/\/(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)\/[\w\-./=~%+:?&]{1,900}$/i;
const B64URL = /^[A-Za-z0-9_-]{16,200}={0,2}$/;

export default async (req) => {
  if (req.method === 'GET') return json({ key: PUBLIC_KEY });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let b; try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const store = getStore({ name: 'push', consistency: 'strong' });

  if (b.unsubscribe) {
    const ep = String((b && b.endpoint) || '');
    if (PUSH_HOST.test(ep)) await store.delete(`p/${hashOf(ep)}`);
    return json({ ok: true });
  }

  const sub = b.subscription, c = String(b.country || '');
  const ep = sub && String(sub.endpoint || ''), k = sub && sub.keys;
  if (!PUSH_HOST.test(ep || '')) return json({ error: 'endpoint' }, 400);
  if (!k || !B64URL.test(String(k.p256dh || '')) || !B64URL.test(String(k.auth || ''))) return json({ error: 'keys' }, 400);
  if (!COUNTRIES.includes(c)) return json({ error: 'country' }, 400);

  const h = hashOf(ep);
  const cur = await store.get(`p/${h}`, { type: 'json' });
  if (cur) {
    if (!cur.c.includes(c)) { cur.c.push(c); await store.setJSON(`p/${h}`, cur); }
    return json({ ok: true });
  }
  await store.setJSON(`p/${h}`, { sub: { endpoint: ep, keys: { p256dh: String(k.p256dh), auth: String(k.auth) } }, c: [c], at: new Date().toISOString() });
  return json({ ok: true });
};

export const config = { path: '/api/push' };
