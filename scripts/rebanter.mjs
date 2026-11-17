// Repair built games: any house whose translation doesn't decode its quoted sentence gets one that does.
// No network, no scraping: it only rewrites the "tr" line in site/houses/<key>/<date>.json (and latest.json when it is that day).
// Usage: node scripts/rebanter.mjs [--dates 2026-11-17,2026-11-18,2026-11-19] [--write]
import fs from 'node:fs';
import { refit, fits } from './banter.mjs';
const args = process.argv.slice(2), WRITE = args.includes('--write');
const dates = (args.includes('--dates') ? args[args.indexOf('--dates') + 1] : '').split(',').filter(Boolean);
const keys = fs.readdirSync('site/houses').filter(k => /^(ie|uk|usc-.+)$/.test(k));
let fixed = 0, total = 0;
for (const k of keys) {
  const country = k === 'ie' ? 'ie' : k === 'uk' ? 'uk' : 'us';
  for (const d of dates) {
    const file = `site/houses/${k}/${d}.json`;
    if (!fs.existsSync(file)) continue;
    const g = JSON.parse(fs.readFileSync(file, 'utf8'));
    const avoid = new Set(g.houses.map(h => h.tr));
    let changed = 0;
    g.houses.forEach(h => {
      total++;
      if (fits({ blurb: h.blurb, tr: h.tr, country })) return;
      avoid.delete(h.tr);
      const tr = refit({ blurb: h.blurb, id: h.id, country, avoid });
      console.log(`${k} ${d} | ${String(h.blurb).slice(0, 70)}\n    ${h.tr}\n -> ${tr}`);
      h.tr = tr; avoid.add(tr); changed++; fixed++;
    });
    if (changed && WRITE) {
      fs.writeFileSync(file, JSON.stringify(g, null, 1) + '\n');
      const lf = `site/houses/${k}/latest.json`;
      if (fs.existsSync(lf)) { const l = JSON.parse(fs.readFileSync(lf, 'utf8')); if (l.date === d) fs.writeFileSync(lf, JSON.stringify(g, null, 1) + '\n'); }
    }
  }
}
console.log(`\n${fixed} of ${total} lines ${WRITE ? 'rewritten' : 'would change'}`);
