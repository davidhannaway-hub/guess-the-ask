// Sends the daily "today's houses are live" email at 8am in each game's own time zone.
// Runs hourly; for each country it sends once a day, from 8am, once that day's houses are live
// (if the houses are late it tries again each hour until noon). Needs RESEND_API_KEY;
// without it, it does nothing.
import { getStore } from '@netlify/blobs';
import { TZ, COUNTRIES, today } from '../lib/players.mjs';

const RAW = 'https://raw.githubusercontent.com/davidhannaway-hub/guess-the-ask/main/site/houses/';
const NAME = { ie: 'Ireland', uk: 'the UK', us: 'the US', ier: 'Ireland', ukr: 'the UK', usr: 'the US' };
const WHAT = c => (c === 'ier' || c === 'ukr' || c === 'usr') ? 'rentals' : 'houses';
const HASH = c => c === 'ier' ? 'rent' : c === 'ukr' ? 'rent-uk' : c === 'usr' ? 'rent-us' : c;
const FROM = 'Guess the Ask <houses@guesstheask.com>';
const hourIn = c => Number(new Date().toLocaleString('en-GB', { timeZone: TZ[c], hour: '2-digit', hourCycle: 'h23' }));

function mail(c, no, token) {
  const play = `https://guesstheask.com/?s=email#${HASH(c)}`, out = `https://guesstheask.com/api/remind?u=${token}`;
  return {
    subject: `No. ${no} is live \u{1F3E0}`,
    text: `7 new ${WHAT(c)} in ${NAME[c]}. Same 7 for everyone today.\n\nPlay: ${play}\n\nStop these emails: ${out}`,
    html: `<!doctype html><body style="margin:0;background:#f4f3f0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 16px">
<table role="presentation" width="100%" style="max-width:440px;background:#121212;border-radius:16px" cellpadding="0" cellspacing="0"><tr><td style="padding:28px;color:#fff">
<div style="font-size:24px;font-weight:800;letter-spacing:-.02em">Guess the <span style="color:#00A651">Ask</span></div>
<div style="font-size:13px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#F4C300;margin-top:18px">No. ${no} is live</div>
<div style="font-size:20px;font-weight:800;margin-top:6px;line-height:1.3">7 new ${WHAT(c)} in ${NAME[c]}.<br>Same 7 for everyone today.</div>
<a href="${play}" style="display:inline-block;margin-top:22px;background:#00A651;color:#fff;text-decoration:none;font-weight:800;font-size:17px;padding:14px 22px;border-radius:12px">Play today's ${WHAT(c)}</a>
</td></tr></table>
<div style="font-size:12px;color:#5f5f5f;margin-top:14px">You asked for a daily reminder at guesstheask.com. <a href="${out}" style="color:#5f5f5f">Unsubscribe</a></div>
</td></tr></table></body>`,
    headers: { 'List-Unsubscribe': `<${out}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

export default async () => {
  const key = process.env.RESEND_API_KEY;
  const store = getStore({ name: 'reminders', consistency: 'strong' });
  // One line every hour so the morning report can read sign-up numbers from the Netlify logs.
  try {
    const { blobs } = await store.list({ prefix: 'e/' });
    const all = (await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' })))).filter(Boolean);
    const since = new Date(Date.now() - 864e5).toISOString();
    const n = c => all.filter(s => s.c && s.c.includes(c)).length;
    console.log(`SIGNUPS total=${all.length} ie=${n('ie')} uk=${n('uk')} us=${n('us')} ier=${n('ier')} ukr=${n('ukr')} usr=${n('usr')} new24h=${all.filter(s => s.at >= since).length}`);
  } catch (e) { console.log('SIGNUPS count failed: ' + e.message); }
  if (!key) { console.log('RESEND_API_KEY not set; no reminders sent'); return; }
  for (const c of COUNTRIES) {
    const h = hourIn(c), date = today(c);
    if (h < 8 || h > 11) continue;
    if (await store.get(`sent/${c}/${date}`)) continue;
    const day = await fetch(`${RAW}${c}/latest.json?t=${Date.now()}`).then(r => r.ok ? r.json() : null).catch(() => null);
    if (!day || day.date !== date) { console.log(`${c}: today's houses not live yet`); continue; }
    const { blobs } = await store.list({ prefix: 'e/' });
    const subs = (await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' })))).filter(s => s && s.c && s.c.includes(c));
    await store.set(`sent/${c}/${date}`, String(subs.length));   // mark first, so a retry never double-sends
    let sent = 0;
    for (let i = 0; i < subs.length; i += 100) {
      const batch = subs.slice(i, i + 100).map(s => ({ from: FROM, to: [s.email], ...mail(c, day.day, s.t) }));
      const r = await fetch('https://api.resend.com/emails/batch', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(batch) });
      if (r.ok) sent += batch.length; else console.log(`${c}: batch failed ${r.status} ${(await r.text()).slice(0, 200)}`);
    }
    console.log(`${c}: No. ${day.day} reminder sent to ${sent} of ${subs.length}`);
  }
};

export const config = { schedule: '7 * * * *' };
