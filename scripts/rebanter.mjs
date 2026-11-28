// Repair built games: any house whose translation doesn't decode its quoted sentence gets one that does.
// --repeats instead rewrites only lines that are repeats: used twice in one game, in two games on the same day,
// or used in any game in the 14 days before. The first use keeps it; later ones get a new line.
// No network, no scraping: it only rewrites the "tr" line in site/houses/<key>/<date>.json (and latest.json when it is that day).
// Usage: node scripts/rebanter.mjs [--dates 2026-11-17,2026-11-18,2026-11-19] [--repeats] [--write]
import fs from 'node:fs';
import { refit, fits, LineLog } from './banter.mjs';
const args = process.argv.slice(2), WRITE = args.includes('--write'), REPEATS = args.includes('--repeats');
const dates = (args.includes('--dates') ? args[args.indexOf('--dates') + 1] : '').split(',').filter(Boolean).sort();
const keys = fs.readdirSync('site/houses').filter(k => /^(ie|uk|usc-.+)$/.test(k)).sort();
const DAY = 864e5, dayDiff = (a, b) => (Date.parse(a) - Date.parse(b)) / DAY;

// every line in every game from 14 days before the first date to 2 days after the last, with its dates
const log = new LineLog();
const count = new Map();   // `${date}|${line}` -> how many houses use it that day
const noteUse = (tr, d) => { if (!tr) return; log.note(tr, d); const k = `${d}|${tr}`; count.set(k, (count.get(k) || 0) + 1); };
const dropUse = (tr, d) => {
  const k = `${d}|${tr}`, n = (count.get(k) || 0) - 1;
  if (n > 0) { count.set(k, n); return; }
  count.delete(k);
  const u = log.uses.get(tr); if (u) { u.delete(d); if (!u.size) { log.uses.delete(tr); log.delete(tr); } }
};
if (dates.length) {
  for (const k of fs.readdirSync('site/houses')) for (const f of fs.readdirSync(`site/houses/${k}`)) {
    const d = f.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || dayDiff(d, dates[0]) < -14 || dayDiff(d, dates[dates.length - 1]) > 2) continue;
    for (const h of JSON.parse(fs.readFileSync(`site/houses/${k}/${f}`, 'utf8')).houses || []) noteUse(h.tr, d);
  }
}
const usedBefore = (tr, d) => [...(log.uses.get(tr) || [])].some(x => { const g = dayDiff(d, x); return g >= 1 && g <= 14; });

let fixed = 0, total = 0;
for (const d of dates) {
  const seenToday = new Set();
  for (const k of keys) {
    const country = k === 'ie' ? 'ie' : k === 'uk' ? 'uk' : 'us';
    const file = `site/houses/${k}/${d}.json`;
    if (!fs.existsSync(file)) continue;
    const g = JSON.parse(fs.readFileSync(file, 'utf8'));
    let changed = 0;
    g.houses.forEach(h => {
      total++;
      const repeat = REPEATS && h.tr && (seenToday.has(h.tr) || usedBefore(h.tr, d));
      // --repeats rewrites repeats only; without it, lines that don't decode their quote
      const redo = REPEATS ? repeat : h.tr && !fits({ blurb: h.blurb, tr: h.tr, country });
      if (!redo) { if (h.tr) seenToday.add(h.tr); return; }
      dropUse(h.tr, d);
      log.date = d;
      const tr = refit({ blurb: h.blurb, id: h.id, country, avoid: log, log });
      console.log(`${k} ${d}${repeat ? ' (repeat)' : ''} | ${String(h.blurb).slice(0, 70)}\n    ${h.tr}\n -> ${tr || '(no line)'}`);
      h.tr = tr; noteUse(tr, d); if (tr) seenToday.add(tr); changed++; fixed++;
    });
    if (changed && WRITE) {
      fs.writeFileSync(file, JSON.stringify(g, null, 1) + '\n');
      const lf = `site/houses/${k}/latest.json`;
      if (fs.existsSync(lf)) { const l = JSON.parse(fs.readFileSync(lf, 'utf8')); if (l.date === d) fs.writeFileSync(lf, JSON.stringify(g, null, 1) + '\n'); }
    }
  }
}
console.log(`\n${fixed} of ${total} lines ${WRITE ? 'rewritten' : 'would change'}`);
