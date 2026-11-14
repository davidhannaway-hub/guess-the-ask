// Agent-speak, translated. The lines live in data/banter.json so they can be edited
// without touching code (and without a Netlify deploy).
// First matching rule with an unused line wins; within a rule the start line rotates by listing id.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/banter.json'), 'utf8'));
const RULES = DATA.rules.map(([re, lines]) => [new RegExp(re, 'i'), lines]);
const F = DATA.fallback;

function hash(str) { let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
// US houses get American English: some lines are skipped, the rest have words swapped (garden -> yard).
const US = DATA.us ? { skip: new RegExp(DATA.us.skip, 'i'), swap: DATA.us.swap.map(([a, b]) => [new RegExp(`\\b${a}\\b`, 'g'), b]) } : null;
function local(line, country) {
  if (country !== 'us' || !US) return line;
  if (US.skip.test(line)) return null;
  return US.swap.reduce((l, [re, b]) => l.replace(re, b), line);
}
function pick(lines, id, avoid, country) {
  const start = hash(String(id)) % lines.length;
  for (let k = 0; k < lines.length; k++) { const l = local(lines[(start + k) % lines.length], country); if (l && !avoid.has(l)) return l; }
  return null;
}

// Returns { blurb, tr }: blurb is the agent's own sentence, tr the translation.
// avoid = every line used in either country in the last 14 days, plus today's so far.
export function banter({ id, text, rating, price, beds, country, avoid = new Set() }) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  const PRICEY = /[€£$]\s?\d|\d{1,3},\d{3}|\b\d+(\.\d+)?\s?(k|m|million)\b|asking|guide|offers (in excess|over)|price/i;
  const sentences = clean.split(/(?<=[.!?])\s+|\s*\n+\s*/).map(s => s.trim())
    .filter(s => s.length > 25 && s.length < 260 && !PRICEY.test(s) && s !== s.toUpperCase());
  for (const [rx, lines] of RULES) {
    const hit = sentences.find(s => rx.test(s));
    if (!hit) continue;
    const tr = pick(lines, id, avoid, country);
    if (tr) return { blurb: trim(hit), tr };
  }
  const blurb = sentences[0] ? trim(sentences[0]) : '';
  const r = (rating || '').toUpperCase();
  const tries = [];
  if (r.startsWith('G') || r.startsWith('F')) tries.push(F.energyBad);
  if (r.startsWith('A')) tries.push(F.energyGood);
  if (price && price < 180000) tries.push(F.cheap);
  if (price && price > 1500000) tries.push(F.posh);
  if (beds && beds >= 5) tries.push(F.bigBeds);
  tries.push(F.generic);
  for (const lines of tries) { const tr = pick(lines, id, avoid, country); if (tr) return { blurb, tr }; }
  // Everything used recently (should never happen with 180+ lines): allow a repeat rather than fail.
  return { blurb, tr: local(F.generic[hash(String(id)) % F.generic.length], country) || F.generic[0] };
}

function trim(s) {
  s = s.replace(/^[^A-Za-z0-9"']+/, '');
  if (s.length <= 150) return s;
  const cut = s.slice(0, 147);
  return cut.slice(0, cut.lastIndexOf(' ')) + '…';
}
