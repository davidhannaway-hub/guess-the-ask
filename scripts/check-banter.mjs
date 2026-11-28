// Check the real-meaning lines in every game for today and the two days made ahead.
// Fails (so GitHub emails) if a line appears twice in one game or in two games on the same day.
// Warns (does not fail) for a line also used in any game in the previous 14 days: that happens only when the jokes run short.
// Usage: node scripts/check-banter.mjs [--from 2026-11-28]
import fs from 'node:fs';
const args = process.argv.slice(2);
const from = args.includes('--from') ? args[args.indexOf('--from') + 1] : new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const DAY = 864e5, dayDiff = (a, b) => (Date.parse(a) - Date.parse(b)) / DAY;
const byDate = new Map();   // date -> [{ key, id, tr }]
for (const k of fs.readdirSync('site/houses')) for (const f of fs.readdirSync(`site/houses/${k}`)) {
  const d = f.slice(0, 10), age = dayDiff(from, d);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || age > 14 || age < -3) continue;
  let g; try { g = JSON.parse(fs.readFileSync(`site/houses/${k}/${f}`, 'utf8')); } catch { continue; }
  for (const h of g.houses || []) if (h.tr) { if (!byDate.has(d)) byDate.set(d, []); byDate.get(d).push({ key: k, id: h.id, tr: h.tr }); }
}
let bad = 0, warn = 0;
for (const [d, rows] of [...byDate].sort()) {
  if (dayDiff(d, from) < 0) continue;   // past games can't be changed; only today and ahead are checked
  const seen = new Map();
  for (const r of rows) {
    if (seen.has(r.tr)) { console.log(`::error::${d}: "${r.tr}" is in ${seen.get(r.tr)} and ${r.key} (${r.id})`); bad++; }
    else seen.set(r.tr, `${r.key} (${r.id})`);
    const before = [...byDate].filter(([x, rs]) => { const g = dayDiff(d, x); return g >= 1 && g <= 14 && rs.some(o => o.tr === r.tr); }).map(([x]) => x);
    if (before.length) { console.log(`::warning::${d} ${r.key}: "${r.tr}" was also used on ${before.join(', ')}`); warn++; }
  }
}
console.log(`real-meaning lines from ${from}: ${bad} same-day repeats, ${warn} repeats within 14 days`);
if (bad) process.exit(1);
