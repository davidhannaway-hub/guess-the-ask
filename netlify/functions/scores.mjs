// Today's scores per country. One blob per finished game; the score is in the key,
// so a single list() gives every score with no read-modify-write races.
import { getStore } from '@netlify/blobs';
import { recordPlayerScore } from '../lib/players.mjs';

// Games finished before this existed (taken from analytics), so they still count.
const SEED = { 'ie/2026-11-09': [239, 267, 288] };

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

async function scoresFor(store, country, date) {
  const { blobs } = await store.list({ prefix: `${country}/${date}/` });
  const fromStore = blobs.map(b => Number(b.key.split('/')[2].split('-')[0])).filter(n => n >= 0 && n <= 700);
  return [...(SEED[`${country}/${date}`] || []), ...fromStore];
}

function summary(scores) {
  const bins = Array(10).fill(0);
  for (const s of scores) bins[Math.min(9, Math.floor(s / 70))]++;
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  return { n: scores.length, bins, avg, scores };
}

export default async (req) => {
  const store = getStore({ name: 'scores', consistency: 'strong' });
  const url = new URL(req.url);
  if (req.method === 'GET') {
    const country = url.searchParams.get('country');
    if (!['ie', 'uk'].includes(country)) return json({ error: 'country must be ie or uk' }, 400);
    return json(summary(await scoresFor(store, country, today())));
  }
  if (req.method === 'POST') {
    let b; try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
    const score = Math.round(Number(b.score));
    if (!['ie', 'uk'].includes(b.country) || !(score >= 0 && score <= 700) || !/^[a-z0-9-]{8,64}$/i.test(String(b.id || ''))) return json({ error: 'bad input' }, 400);
    const date = today();
    await store.set(`${b.country}/${date}/${String(score).padStart(3, '0')}-${b.id}`, '1', { onlyIfNew: true });
    // Private leagues read scores per player; a failure here must never cost the game its score.
    try { await recordPlayerScore(getStore({ name: 'leagues', consistency: 'strong' }), b.id, b.country, date, score); } catch {}
    return json(summary(await scoresFor(store, b.country, date)));
  }
  return json({ error: 'method not allowed' }, 405);
};

export const config = { path: '/api/scores' };
