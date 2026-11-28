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

// Every line in use, with the dates it is used on (all games, the last 14 days plus the days made ahead).
// daily.mjs keeps one of these as its "avoid" set and sets .date to the day being built.
// It lets the last resort below reuse the line used longest ago, and never one used on the same day:
// a line can never appear twice in one game, or in two games on the same day.
export class LineLog extends Set {
  constructor() { super(); this.uses = new Map(); this.date = null; }
  note(tr, date = this.date) {
    if (!tr) return;
    this.add(tr);
    if (!date) return;
    if (!this.uses.has(tr)) this.uses.set(tr, new Set());
    this.uses.get(tr).add(date);
  }
}
// When every fitting line has been used in the last 14 days: the one whose nearest use is furthest from this day.
// Never a line used on this same day. Returns null if there is none (the house then gets no line rather than a repeat).
function lastResort(lines, id, avoid, log, country) {
  if (!log || !log.uses || !log.date || !lines.length) return null;
  const t = Date.parse(log.date);
  const start = hash(String(id)) % lines.length;
  let best = null, bestGap = -1;
  for (let k = 0; k < lines.length; k++) {
    const l = local(lines[(start + k) % lines.length], country);
    if (!l) continue;
    if (avoid.has(l) && !log.has(l)) continue;   // skipped for another reason (wrong bedroom count)
    let gap = Infinity;
    for (const d of log.uses.get(l) || []) gap = Math.min(gap, Math.abs(t - Date.parse(d)) / 864e5);
    if (gap < 1) continue;   // used today, in this game or another
    if (gap > bestGap) { best = l; bestGap = gap; }
  }
  return best;
}

// Fallback lines are matched to what the listing actually says. A theme pairs a pattern for the agent's sentence with a
// pattern for the translation lines about that same thing, so "kitchen" in the blurb gets a kitchen joke. Lines that fit
// no theme are the only "universal" ones, used when no sentence in the listing matches anything.
const THEMES = [
  [/kitchen|island|breakfast bar|counter/i, /kitchen|breakfast bar|lemons/i],
  [/garden|yard|patio|outdoor|lawn|deck\b/i, /garden|patio/i],
  [/bath|shower|toilet|powder|\bW\.?C\b/i, /bathroom|toilet|shower/i],
  [/bedroom|primary|master|suite/i, /bedroom|box room/i],
  [/\blight|bright|sunny|sun-?filled|airy|windows?/i, /light|bright|window/i],
  [/parking|driveway|garage|\bcars?\b/i, /parking|driveway/i],
  [/storage|closet|cupboard|pantry/i, /storage|utility room|cupboard/i],
  [/fireplace|\bstove\b/i, /fireplace/i],
  [/paint|decor|renovat|updated|refresh|remodel|upgrad|newly|brand[- ]new/i, /recently|fresh paint|upgraded|carpeted|newest thing|re-roofed|neutral/i],
  [/location|close to|convenient|\bnear\b|minutes|walk|school|neighbo/i, /location|located|schools|close to everything|the road|rat run/i],
  [/spacious|generous|ceilings?|\bhall|landing|open[- ]plan|living room|reception/i, /hall|landing|ceilings|good sized|snug|playroom|reception room/i],
  [/entertain|gather|\bhost/i, /entertaining/i],
  [/charm|character|classic|original|period|hardwood|brick|craftsmanship|gem\b|condition/i, /gem|good bones|sound house|condition/i],
  [/heat|boiler|central air|hvac|energy|insulat/i, /boiler|heating|bills/i],
  [/\bview|private|quiet|\btrees?\b/i, /view of|private|hedge|every window/i],
  [/porch|office|extension|addition|roof/i, /porch|home office|extension|roof/i],
  [/\bfamily\b/i, /family home|ideal home/i]
];
// Lines only an Irish listing would make, kept out of UK and US games.
const IE_ONLY = /hot press|dual carriageway|\bhap\b|luas|\bdart\b|eircode|\bm50\b/i;
// US games also get the lines in banter.json "usOnly" (HOA, escrow, Zillow...), which never go to Ireland or the UK.
const US_ONLY = DATA.usOnly || [];
const genericFor = country => (country === 'us' ? F.generic.concat(US_ONLY) : F.generic);
const themed = new Set(THEMES.flatMap(([, lr]) => F.generic.concat(US_ONLY).filter(l => lr.test(l))));
const universalFor = country => genericFor(country).filter(l => !themed.has(l));
function themeLine(sentences, id, avoid, country) {
  for (const [sr, lr] of THEMES) {
    const hit = sentences.find(x => sr.test(x));
    if (!hit) continue;
    const lines = genericFor(country).filter(l => lr.test(l) && (country === 'ie' || !IE_ONLY.test(l)));
    const tr = lines.length && pick(lines, id, avoid, country);
    if (tr) return { blurb: trim(hit), tr };
  }
  return null;
}
// Last line of defence: a fresh universal line; else the universal line used longest ago (never one used today);
// else any generic line used longest ago; else no line at all. Never a repeat within a game or a day.
function universalLine(id, avoid, country, log) {
  const ok = l => country === 'ie' || !IE_ONLY.test(l);
  const lines = universalFor(country).filter(ok);
  return pick(lines, id, avoid, country) || lastResort(lines, id, avoid, log, country)
    || lastResort(genericFor(country).filter(ok), id, avoid, log, country) || '';
}
// Re-fit one built house: keep its quoted sentence, give it a translation that actually decodes it.
export function refit({ blurb, id, country, avoid = new Set(), log = avoid instanceof LineLog ? avoid : null }) {
  const sentences = blurb ? [blurb] : [];
  for (const [rx, lines] of RULES) { if (sentences.some(s => rx.test(s))) { const tr = pick(lines.filter(l => country === 'ie' || !IE_ONLY.test(l)), id, avoid, country); if (tr) return tr; } }
  const t = themeLine(sentences, id, avoid, country); if (t) return t.tr;
  return universalLine(id, avoid, country, log);
}

// Does this translation already decode its quoted sentence (a rule or theme matched it)? Used to repair built games.
export function fits({ blurb, tr, country }) {
  const same = ls => ls.some(l => local(l, country) === tr);
  if (RULES.some(([rx, lines]) => rx.test(blurb || '') && same(lines))) return true;
  if (THEMES.some(([sr, lr]) => sr.test(blurb || '') && same(genericFor(country).filter(l => lr.test(l))))) return true;
  return [F.energyBad, F.energyGood, F.cheap, F.posh, F.bigBeds].some(same);   // these answer to the rating, price or bedrooms
}

// Agent boilerplate is never the quote: disclaimers, "delighted to present", viewing and contact details.
const SALE_BOILER = /photo disclaimer|digitally (enhanced|altered)|virtually staged|delighted to (present|offer|bring)|pleased to (present|offer)|offered to the market|to arrange a (viewing|private)|viewing (is )?(by|strictly)|please (contact|call|email)|brokerage|licensed|equal housing|all measurements|sold as[- ]is/i;

// Returns { blurb, tr }: blurb is the agent's own sentence, tr the translation.
// avoid = every line used in either country in the last 14 days, plus today's so far.
// A line that names a bedroom count ("Two bedrooms if you count the box room") never lands on a house with a different count.
const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const wrongBeds = (tr, beds) => { const m = /\b(one|two|three|four|five|six) bed(room)?s?\b/i.exec(tr || ''); return !!(m && beds && NUM[m[1].toLowerCase()] !== beds); };
export function banter(o) {
  const skip = new Set(o.avoid || []);
  const log = o.avoid instanceof LineLog ? o.avoid : null;
  let r = banterOnce({ ...o, avoid: skip, log });
  for (let i = 0; i < 8 && r.tr && wrongBeds(r.tr, o.beds); i++) { skip.add(r.tr); r = banterOnce({ ...o, avoid: skip, log }); }
  return r;
}
function banterOnce({ id, text, rating, price, beds, country, avoid = new Set(), rent = false, log = null }) {
  if (rent && RENT) return rentBanter({ id, text, price, beds, avoid, country, log });
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  const PRICEY = /[€£$]\s?\d|\d{1,3},\d{3}|\b\d+(\.\d+)?\s?(k|m|million)\b|asking|guide|offers (in excess|over)|price/i;
  const sentences = clean.split(/(?<=[.!?])\s+|\s*\n+\s*/).map(s => s.trim())
    .filter(s => s.length > 25 && s.length < 260 && !PRICEY.test(s) && !SALE_BOILER.test(s) && !/\bNo\.$/.test(s) && s !== s.toUpperCase());
  for (const [rx, lines] of RULES) {
    const hit = sentences.find(s => rx.test(s));
    if (!hit) continue;
    const tr = pick(lines, id, avoid, country);
    if (tr) return { blurb: trim(hit), tr };
  }
  const th = themeLine(sentences, id, avoid, country);   // a joke about something the listing really mentions
  if (th) return th;
  const blurb = sentences[0] ? trim(sentences[0]) : '';
  const r = (rating || '').toUpperCase();
  const tries = [];
  if (r.startsWith('G') || r.startsWith('F')) tries.push(F.energyBad);
  if (r.startsWith('A')) tries.push(F.energyGood);
  if (price && price < 180000) tries.push(F.cheap);
  if (price && price > 1500000) tries.push(F.posh);
  if (beds && beds >= 5) tries.push(F.bigBeds);
  for (const lines of tries) { const tr = pick(lines, id, avoid, country); if (tr) return { blurb, tr }; }
  return { blurb, tr: universalLine(id, avoid, country, log) };
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
function rentBanter({ id, text, price, beds, avoid, country = 'ie', log = null }) {
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
  // all used in the last 14 days: the one used longest ago, never one used today (in any game); else no line
  return { blurb, tr: lastResort(L(RENT.F.generic), id, avoid, log, 'ie') || lastResort(L(RENT.houseGeneric), id, avoid, log, 'ie') || '' };
}
