// Scores photos with the front-of-house check and prints them lowest first.
// Usage: node scripts/photo-test.mjs [extra image paths under site/...]
import fs from 'node:fs/promises';
import path from 'node:path';
import { outsideDetail, THRESHOLD } from './exterior.mjs';
const games = ['ie', 'uk', 'us', 'usc-nyc', 'usc-sf', 'usc-chicago', 'usc-seattle', 'usc-boston'];
const files = new Set(process.argv.slice(2));
for (const c of games) for (const d of ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19']) {
  try { for (const h of JSON.parse(await fs.readFile(`site/houses/${c}/${d}.json`, 'utf8')).houses) files.add('site/' + h.img); } catch {}
}
const out = [];
for (const f of files) {
  try { const r = await outsideDetail(await fs.readFile(f)); out.push([r.score, f, r.label]); } catch (e) { out.push([-1, f, e.message]); }
}
out.sort((a, b) => a[0] - b[0]);
for (const [s, f, l] of out) console.log(`${s >= THRESHOLD ? 'PASS' : 'FAIL'} ${s.toFixed(2)} ${path.basename(f)} | ${l}`);
console.log(`${out.filter(x => x[0] < THRESHOLD).length} of ${out.length} would be rejected`);
