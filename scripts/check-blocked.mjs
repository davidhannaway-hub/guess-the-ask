// Fails (exit 1) if any game from today onwards, or any pooled house, comes from a blocked agent (data/blocked-agents.json).
// Past games are history and are only reported, not failed. Usage: node scripts/check-blocked.mjs [--today YYYY-MM-DD]
import fs from 'node:fs';
const rx = JSON.parse(fs.readFileSync('data/blocked-agents.json', 'utf8')).map(x => new RegExp(x, 'i'));
const hit = h => rx.some(r => r.test(`${h.agent || ''} ${h.src || ''}`));
const args = process.argv.slice(2);
const today = args.includes('--today') ? args[args.indexOf('--today') + 1] : new Date(Date.now() - 12 * 3600e3).toISOString().slice(0, 10); // earliest live day anywhere (US runs on New York time)
let bad = 0, past = 0;
for (const k of fs.readdirSync('site/houses')) {
  for (const f of fs.readdirSync(`site/houses/${k}`).filter(f => /^\d{4}-\d\d-\d\d\.json$/.test(f))) {
    const g = JSON.parse(fs.readFileSync(`site/houses/${k}/${f}`, 'utf8'));
    (g.houses || []).forEach((h, i) => {
      if (!hit(h)) return;
      if (f.slice(0, 10) >= today) { bad++; console.log(`::error::${k} ${f.slice(0, 10)} house #${i + 1} (${h.area}) is from a blocked agent: ${h.src}`); } else past++;
    });
  }
}
for (const f of fs.readdirSync('data').filter(f => /^pool-.*\.json$/.test(f))) {
  const p = JSON.parse(fs.readFileSync(`data/${f}`, 'utf8')), a = Array.isArray(p) ? p : (p.items || p.pool || []);
  const n = a.filter(hit).length; if (n) { bad += n; console.log(`::error::${f} still holds ${n} house(s) from a blocked agent`); }
}
console.log(bad ? `${bad} blocked house(s) found` : 'No blocked agents in live games or pools.', past ? `(${past} in past games, left as history)` : '');
process.exit(bad ? 1 : 0);
