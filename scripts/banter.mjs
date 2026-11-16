// Agent-speak, translated. The lines live in data/banter.json so they can be edited
// without touching code (and without a Netlify deploy).
// First matching rule with an unused line wins; within a rule the start line rotates by listing id.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/banter.json'), 'utf8'));
const RULES = DATA.rules.map(([re, lines]) => [new RegExp(re, 'i'), lines]);
const F = DATA.fallback;
// Rental Edition: rent rules first, then the house rules minus any line about buying (RENT.skip).
const RENT = (() => {
  try {
    const R = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/banter-rent.json'), 'utf8'));
    const skip = new RegExp(R.skip, 'i');
    const houseRules = RULES.map(([re, lines]) => [re, lines.filter(l => !skip.test(l))]).filter(([, l]) => l.length);
    return { rules: [...R.rules.map(([re, lines]) => [new RegExp(re, 'i'), lines]), ...houseRules], F: R.fallback, houseGeneric: F.generic.filter(l => !skip.test(l)) };
  } catch { return null; }
})();

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
export function banter({ id, text, rating, price, beds, country, avoid = new Set(), rent = false }) {
  if (rent && RENT) return rentBanter({ id, text, price, beds, avoid, country });
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

// Rental Edition. price is the monthly rent.
const STREET = /\b\d{1,5}[A-Z]?\s+(?:[NSEW]\.?\s+)?(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Ave|Avenue|Ln|Lane|Dr|Drive|Rd|Road|Blvd|Boulevard|Way|Ct|Court|Pl|Place|Ter|Terrace|Pkwy|Parkway|Cir|Circle|Hwy|Highway|Sq|Square)\b\.?/;
const EIRCODE = /\b[ACDEFHKNPRTVWXY]\d[\dW]\s?[0-9ACDEFHKNPRTVWXY]{4}\b/;
const BOILER = /property reference|\bref(erence)?\.? ?(no|number)?\.? ?:? ?\d|epc rating|epc not|council tax|tenancy deposit|to the (rental |lettings? )?market|bring to (you|the)|register|registration|\blarn\b|redress|client money|\bcmp\b|\bpropertymark\b|\barla\b|delighted|pleased|proud|presents?\b|present (to the market|this|a)|enquir|e-?mail|contact|phone|call\b|apply|application|viewing|available (immediately|now|from)|let agreed|please|sorry|we (are|have)|our (client|office)|\bpsra\b|licen[cs]e|www\.|\.ie\b|\.com\b|daft/i;
// UK rentals: no Irish-only lines (Luas, HAP, Daft...), and Irish words swapped (press -> cupboard).
const UK_SKIP = /luas|\bdart\b|\bhap\b|daft|centra|eircode|m50|celtic tiger|craic|grand\b/i;
const UK_SWAP = [[/\bhot press\b/g, 'airing cupboard'], [/\bpresses\b/g, 'cupboards'], [/\bpress\b/g, 'cupboard'], [/€/g, '£']];
// US rentals: skip Irish/UK-only lines, swap words (cupboard -> closet, flat -> apartment...).
const US_SKIP = /luas|\bdart\b|\bhap\b|daft|centra|eircode|m50|celtic tiger|craic|storage heater|magnolia|\blidl\b|airing cupboard|hot press/i;
const US_SWAP = [[/\ba lift\b/g, 'an elevator'], [/\bA lift\b/g, 'An elevator'], [/\bpresses\b/g, 'closets'], [/\bpress\b/g, 'closet'], [/\bcupboards?\b/g, 'closet'], [/\bwardrobe\b/g, 'closet'], [/\blift\b/g, 'elevator'], [/\bflat\b/g, 'apartment'], [/\bmould\b/g, 'mold'], [/\bbins\b/g, 'trash cans'], [/\bcooker\b/g, 'stove'], [/\bviewing\b/g, 'showing'], [/\bViewing\b/g, 'Showing'], [/\bViewings\b/g, 'Showings'], [/\bGarden\b/g, 'Yard'], [/\bFlat\b/g, 'Apartment'], [/\bgarden\b/g, 'yard'], [/\bletting agent\b/g, 'leasing agent'], [/\bcar park\b/g, 'parking lot'], [/\bholiday\b/g, 'vacation'], [/[€£]/g, '$']];
function forUS(lines) { return lines.filter(l => !US_SKIP.test(l)).map(l => US_SWAP.reduce((x, [re, b]) => x.replace(re, b), l)); }
function forUK(lines) { return lines.filter(l => !UK_SKIP.test(l)).map(l => UK_SWAP.reduce((x, [re, b]) => x.replace(re, b), l)); }
function rentBanter({ id, text, price, beds, avoid, country = 'ie' }) {
  const L = lines => (country === 'uk' ? forUK(lines) : country === 'us' ? forUS(lines) : lines);
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  const PRICEY = /[€£$]\s?\d|\d{1,3},\d{3}|per (month|week|annum)|\bpcm\b|\bpw\b|\brent\b|price|deposit|holding fee/i;
  const sentences = clean.split(/(?<=[.!?])\s+|\s*\n+\s*/).map(s => s.trim())
    .map(s => s.replace(/\*+/g, '').replace(/\s+/g, ' ').trim())
    // agent boilerplate is never the quote: "X are delighted to present", "email enquiries only", viewing and contact details
    .filter(s => s.length > 25 && s.length < 260 && !PRICEY.test(s) && !BOILER.test(s) && !EIRCODE.test(s) && !STREET.test(s) && s !== s.toUpperCase());
  for (const [rx, lines] of RENT.rules) {
    if (beds > 1 && /studio/.test(rx.source)) continue;   // a studio joke never lands on a house
    const hit = sentences.find(s => rx.test(s));
    if (!hit) continue;
    const tr = pick(L(lines), id, avoid, 'ie');
    if (tr) return { blurb: trim(hit), tr };
  }
  const blurb = sentences[0] ? trim(sentences[0]) : '';
  const tries = [];
  if (price && price < 1500) tries.push(RENT.F.cheap);
  if (price && price > 5000) tries.push(RENT.F.posh);
  if (beds && beds >= 4) tries.push(RENT.F.bigBeds);
  tries.push(RENT.F.generic, RENT.houseGeneric);
  for (const lines of tries) { const tr = pick(L(lines), id, avoid, 'ie'); if (tr) return { blurb, tr }; }
  const g = L(RENT.F.generic);
  return { blurb, tr: g[hash(String(id)) % g.length] };
}
