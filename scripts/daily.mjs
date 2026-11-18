// Nightly: keep a pool of real listings per country (topped up from Apify when it runs low),
// pick today's 7 houses, save their photos, and write site/houses/<country>/latest.json.
// Usage: APIFY_TOKEN=... node scripts/daily.mjs [--country ie|uk|us] [--force-refill]
// Each country runs on its own clock (CFG[c].tz): the US day starts at New York midnight.
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { banter } from './banter.mjs';
import { outsideScore, THRESHOLD, roomScore, ROOM_THRESHOLD } from './exterior.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CFG = JSON.parse(await fs.readFile(path.join(ROOT, 'scripts/config.json'), 'utf8'));
const TOKEN = process.env.APIFY_TOKEN;
const args = process.argv.slice(2);
const only = args.includes('--country') ? args[args.indexOf('--country') + 1] : null;
const FORCE = args.includes('--force-refill');
const FIX = args.includes('--fix-photos');   // re-check the photos in today's and the next two days' games
const AHEAD = args.includes('--ahead-only');  // with --fix-photos: leave today's live game alone, fix only the days ahead
// 'ier' is the Rental Edition: Irish rentals, its own daily game, pool and used list.
// 'ukr' is UK rentals (Rightmove). A rental game's cfg.base is the country it's in.
// Defaults for every US city game (current and future): variety of areas and house types, 3 days of pool, up to $10M.
// cfg.mix: each refill also pulls a few listings of other house types (5 townhomes, 5 condos), mixed into the single-family pool.
const CITY_DEFAULTS = { base: 'us', perPlaceCap: 2, maxSingle: 4, refillWhenBelow: 33, minPrice: 150000, maxPrice: 10000000, bigCity: '~none~', poolPerPlace: 120 };
for (const k of Object.keys(CFG)) if (CFG[k] && CFG[k].city) { CFG[k] = { ...CITY_DEFAULTS, ...CFG[k] }; CFG[k].mix = CFG[k].mix === undefined ? [{ propertyType: 'townhomes', maxItems: 5 }, { propertyType: 'condos', maxItems: 5 }] : [].concat(CFG[k].mix || []); }   // the scraper takes one property type per pull
const CITIES = Object.keys(CFG).filter(k => CFG[k] && CFG[k].city);   // US city games (usc-chicago ...): the US game, one city only
// The USA is played by city only: the all-USA game ('us') is no longer built. Cities are usc-*.
// Irish and UK rentals (ier, ukr) are built nightly. USA rentals (usr) are paused.
const COUNTRIES = ['ie', 'uk', 'ier', 'ukr', ...CITIES];
const RENTAL = c => !!(CFG[c] && CFG[c].rent);
const BASE = c => (CFG[c] && CFG[c].base) || (RENTAL(c) ? 'ie' : c);
const dateIn = c => new Date().toLocaleDateString('en-CA', { timeZone: CFG[c].tz || 'Europe/London' });
const nextDay = d => new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10);
let TODAY = dateIn('ie'), TOMORROW = nextDay(TODAY);   // reset per country in the main loop
const FORMAT = 3;
const dayNo = (d, c) => Math.floor((Date.parse(d) - Date.parse(CFG[c].launch || CFG.launch)) / 864e5) + 1;

const readJSON = async (p, d) => { try { return JSON.parse(await fs.readFile(path.join(ROOT, p), 'utf8')); } catch { return d; } };
// Agents we must not use (data/blocked-agents.json, regex strings). Checked for every house, sales and rentals, at every point a house is chosen.
const BLOCKED = (await readJSON('data/blocked-agents.json', [])).map(x => new RegExp(x, 'i'));
const blockedAgent = h => BLOCKED.some(rx => rx.test(`${h.agent || ''} ${h.src || ''}`));
const writeJSON = async (p, v) => { await fs.mkdir(path.dirname(path.join(ROOT, p)), { recursive: true }); await fs.writeFile(path.join(ROOT, p), JSON.stringify(v, null, 1)); };
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

// ---------- Apify ----------
async function runActor(actor, input) {
  if (!TOKEN) throw new Error('APIFY_TOKEN is not set');
  const base = 'https://api.apify.com/v2';
  const start = await fetch(`${base}/acts/${actor}/runs?token=${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  if (!start.ok) throw new Error(`Apify start ${actor}: ${start.status} ${await start.text()}`);
  let run = (await start.json()).data;
  log(`started ${actor} run ${run.id}`);
  const t0 = Date.now();
  while (['READY', 'RUNNING'].includes(run.status)) {
    if (Date.now() - t0 > 25 * 60e3) throw new Error(`Apify run ${run.id} timed out`);
    await new Promise(r => setTimeout(r, 10e3));
    run = (await (await fetch(`${base}/actor-runs/${run.id}?token=${TOKEN}`)).json()).data;
  }
  log(`${actor} run ${run.id} finished: ${run.status}`);
  const items = await (await fetch(`${base}/datasets/${run.defaultDatasetId}/items?token=${TOKEN}&clean=true&format=json`)).json();
  if (run.status !== 'SUCCEEDED' && !items.length) throw new Error(`Apify run ${run.id} ${run.status} with no items`);
  return items;
}

// ---------- normalise any actor's row into one shape ----------
const pick = (o, ...keys) => { for (const k of keys) { const v = k.split('.').reduce((a, p) => (a == null ? a : a[p]), o); if (v != null && v !== '') return v; } return null; };
const num = v => { if (typeof v === 'number') return v; if (typeof v !== 'string') return null; const n = Number(v.replace(/[^0-9.]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
const imgs = o => {
  const a = pick(o, 'images', 'imageUrls', 'photo_urls', 'photos', 'propertyImages', 'media.images') || [];
  const list = (Array.isArray(a) ? a : [a]).map(x => typeof x === 'string' ? x : (x && (x.url || x.srcUrl || x.src || x.large || x.medium || x.size720x480 || x.size1440x960))).filter(Boolean);
  const one = pick(o, 'imageUrl', 'image', 'mainImage', 'propertyImage');
  if (one && typeof one === 'string') list.unshift(one);
  return [...new Set(list)].filter(u => /^https?:/.test(u));
};

function normalise(o, country) {
  const id = String(pick(o, 'id', 'propertyId', 'property_id', 'daftShortcode', 'listingId') || pick(o, 'propertyUrl', 'url', 'listingUrl', 'href'));
  const url = pick(o, 'propertyUrl', 'url', 'link', 'listingUrl', 'href');
  const priceText = String(pick(o, 'priceText', 'displayPrice') || '');
  const price = num(pick(o, 'priceValue', 'price.amount', 'priceAmount', 'list_price', 'price', 'askingPrice'));
  const beds = num(pick(o, 'beds', 'bedrooms', 'numBedrooms'));
  const cars = num(pick(o, 'parkingSpaces', 'carspaces'));
  const baths = num(pick(o, 'bathrooms', 'baths', 'numBathrooms', 'baths_consolidated'));
  const type = String(pick(o, 'propertySubType', 'propertyType', 'property_type', 'type') || '').toLowerCase().replace(/_/g, ' ');
  const address = String(pick(o, 'title', 'displayAddress', 'address', 'streetAddress') || (o.address_line ? [o.address_line, o.address_city, o.address_state_code].filter(Boolean).join(', ') : ''));
  const county = String(pick(o, 'county', 'region', 'addressRegion', 'state', 'address_state_code') || '').replace(/^(Co\.|County)\s*/i, '').trim();
  const locality = String(pick(o, 'areaName', 'addressLocality', 'address_city', 'city', 'town', 'location') || '').trim().replace(/^[A-Z ]+$/, m => m.toLowerCase().replace(/\b\w/g, x => x.toUpperCase()));
  const sqm = num(pick(o, 'floorAreaValue', 'surface', 'size_m2', 'sizeSqM'));
  const sqft = num(pick(o, 'sizeSqFt', 'sizeSqft', 'floorAreaSqFt', 'sqft'));
  const rating = String(pick(o, 'berRating', 'berCode', 'ber', 'epcRating', 'epc.currentRating', 'energyRating') || '').replace(/^(BER|EPC)\s*/i, '').trim();
  const agent = pick(o, 'seller.branch', 'seller.name', 'agentName', 'agencyName', 'agent.name', 'seller_name', 'branchName', 'primary_office_name');
  const sellerType = pick(o, 'seller.sellerType', 'sellerType');
  const bedsText = String(pick(o, 'numBedrooms') || '');
  const outcode = pick(o, 'outcode');
  const text = [pick(o, 'description', 'summary', 'propertyDescription', 'description_text', 'text'), (pick(o, 'features', 'keyFeatures') || []).join?.('. ')].filter(Boolean).join(' ').replace(/<br\s*\/?>/gi, '. ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
  const titleRaw = String(pick(o, 'propertyTitle') || '').toLowerCase();
  // US: the neighbourhood (Realtor.com lists the most specific one first), so a city like
  // San Francisco shows "Noe Valley, San Francisco, CA" rather than just the city.
  const hoodList = pick(o, 'neighborhoods', 'neighborhood', 'neighborhood_name');
  let hood = (Array.isArray(hoodList) ? hoodList : String(hoodList || '').split(','))
    .map(x => String(typeof x === 'object' && x ? (x.name || '') : x).trim()).find(Boolean) || null;
  if (hood && hood.toLowerCase() === locality.toLowerCase()) hood = null;
  const extra = country === 'us' ? { hood } : {};
  return { ...extra, id, url, price, priceText, sellerType: sellerType ? String(sellerType) : null, bedsText, outcode: outcode ? String(outcode).toUpperCase() : null, cars, status: o.status ? String(o.status).toLowerCase() : null, beds, baths, type, titleRaw, address: address.replace(/\s*\|\s*/g, ', '), county, locality, sqm, sqft: sqft && sqft < 450 ? Math.round(sqft * 10.764) : sqft, rating, agent: agent ? String(agent) : null, text, images: imgs(o), country, seen: TODAY };
}

// Rentals: the price must be one monthly rent. Weekly rents become monthly (x52/12); a development
// advertised as "From €X" (several units at different rents) has no single answer, so it's dropped.
function rentPrice(o, h) {
  const t = String(pick(o, 'priceDisplay', 'price', 'priceText', 'displayPrice') || h.priceText || '');
  const freq = String(pick(o, 'priceFrequency', 'rentFrequency') || '');
  if (/^\s*from\b/i.test(t) || /\bfrom\s*[€£]/i.test(t) || /pppw|pppm|per person/i.test(t)) return null;
  let v = num(pick(o, 'priceValue', 'list_price')) || (typeof o.price === 'number' ? o.price : null) || num(t.replace(/(per|p\.?c\.?m|pw|pcm|p\/w|a week|a month).*$/i, ''));
  if (!v) return null;
  if (/week/i.test(freq) || (!freq && /week|\bpw\b|p\/w/i.test(t))) v = v * 52 / 12;
  else if (/year|annum|annual/i.test(freq) || (!freq && /annum|\bpa\b|per year/i.test(t))) v = v / 12;
  else if (/quarter/i.test(freq)) v = v / 3;
  else if (/day|night/i.test(freq + t)) return null;   // short lets
  return Math.round(v);
}
const RENT_BAD_TYPE = /private rental sector|apartments$|student|share|room|parking|garage|commercial|office|retail|site|holiday|retirement|park home|houseboat|mobile/;
function usableRent(h, c) {
  const cfg = CFG[c] || {};
  // Daft: branded agents only (proper photos). Rightmove lists agents only, so any named agent will do.
  // US: landlords and property managers too (the photo picker still drops bad photos)
  const agentOk = BASE(c) === 'ie' ? (h.sellerType === 'BRANDED_AGENT' || (cfg.allowUnbranded && h.sellerType === 'UNBRANDED_AGENT')) : BASE(c) === 'us' ? true : !!h.agent;
  return h.url && h.price && h.price >= (cfg.minPrice || 700) && h.price <= (cfg.maxPrice || 25000) && agentOk
    && h.images.length >= (cfg.minImages || 4) && !RENT_BAD_TYPE.test(h.type) && !/[&,]/.test(h.bedsText || '')
    && !/^from\b/i.test(h.priceText || '') && (h.county || h.locality || h.address)
    // student houses priced per person (a 7-bed at £550): the rent must be for the whole place
    && !(h.beds >= 3 && h.price < 160 * h.beds) && !/per person|\bpppw\b|\bpppm\b|per room|room only|students? only|mobile home|manufactured home|\btrailer\b|duration of (your )?stay|nightly|per night|vacation rental|short[- ]term (rental|let)|airbnb|vrbo/i.test(`${h.priceText || ''} ${h.text || ''}`);
}

// clean a stored listing (also fixes entries saved by older versions)
function tidy(h) {
  const strip = t => String(t || '').replace(/(&lt;|<)br\s*\/?(&gt;|>)/gi, '. ').replace(/<[^>]*>?/g, ' ').replace(/\bbr\s*\/>/gi, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').replace(/(\.\s*){2,}/g, '. ').trim();
  h.text = strip(h.text);
  h.address = String(h.address || '').replace(/\s*\|\s*/g, ', ');
  if (!h.sqft || h.sqft < 200) h.sqft = h.sqft && h.sqft > 25 ? Math.round(h.sqft * 10.764) : null;
  if (h.sqm && h.sqm < 25) h.sqm = null;
  return h;
}
// the searched place a listing came from (older listings: their county/town)
const placeOf = h => String(h.search || h.county || h.locality || '').toLowerCase();
const BAD_TYPE = /apartment|flat|studio|site|land|plot|parking|garage only|commercial|retirement|houseboat|park home|mobile|maisonette/;
const BAD_TEXT = /\bplot\b|\bland\b|building site|development opportunity|\bauction\b/i;
function usable(h, c) {
  if (blockedAgent(h)) return false;
  if (RENTAL(c)) return usableRent(h, c);
  const cfg = CFG[c] || {};
  if (BASE(c) === 'us' && h.status && h.status !== 'for_sale') return false;   // no pending, contingent or auction listings
  return h.url && h.price && h.price >= (cfg.minPrice || 120000) && h.price <= (cfg.maxPrice || 3500000) && h.images.length && !BAD_TYPE.test(h.type) && !BAD_TYPE.test(h.titleRaw || '') && !BAD_TEXT.test(h.address) && !BAD_TEXT.test(h.titleRaw || '') && (h.county || h.locality || h.address);
}

// ---------- pool ----------
const forced = new Set();     // games that must top up again this run (a day came up short)
const refilled = new Set();   // one Apify top-up per game per run, however many days it builds
async function refill(c, pool, used, sweep = false, mixOnly = false) {
  const cfg = CFG[c];
  if (refilled.has(c)) { log(`${c}: already topped up this run, using the pool`); return; }
  refilled.add(c);
  let rows = [];
  if (c === 'ie' || (RENTAL(c) && BASE(c) === 'ie')) {
    // rentals also run cfg.extraInputs (Dublin and top-price searches) alongside, so every day can have its €8k shock
    const runs = await Promise.all([cfg.input, ...(cfg.extraInputs || [])].map(inp => runActor(cfg.actor, inp).catch(e => { log(`${c} search failed: ${e.message}`); return []; })));
    rows = runs.flat();
    if (!rows.length) throw new Error(`${c}: every Apify search failed`);
  } else {
    // UK and US: a few places per refill, rotating through the list so the houses spread out.
    // Every day: the next few places in the list (cfg.dailyRuns), so each day's pick has fresh places.
    // sweep = every place at once (when the pool covers too few places), run five at a time.
    const state = await readJSON(`data/${c}-rotation.json`, { next: 0 });
    const runs = sweep ? cfg.locations.length : (cfg.dailyRuns || cfg.runsPerRefill);
    const locs = Array.from({ length: runs }, (_, i) => cfg.locations[(state.next + i) % cfg.locations.length]);
    for (let i = 0; i < locs.length && !mixOnly; i += 5) {
      await Promise.all(locs.slice(i, i + 5).map(async loc => {
        const input = { ...cfg.input, ...((cfg.inputFor || {})[loc] || {}), ...(BASE(c) === 'us' ? { searchLocations: [loc] } : { searchLocation: loc }) };
        try { rows.push(...(await runActor(cfg.actor, input)).map(r => ({ ...r, _search: loc }))); }
        catch (e) { log(`${c} search ${loc} failed: ${e.message}`); }
      }));
    }
    for (const loc of cfg.mix && cfg.mix.length ? locs : []) {
      for (const mx of cfg.mix) {
        try { const extra = (await runActor(cfg.actor, { ...cfg.input, ...mx, searchLocations: [loc] })).map(r => ({ ...r, _search: loc })); rows.push(...extra); log(`${c}: ${mx.propertyType} pull for ${loc} gave ${extra.length} listings`); }
        catch (e) { log(`${c} ${mx.propertyType} pull ${loc} failed (main pull unaffected): ${e.message}`); }
      }
    }
    if (!mixOnly) { state.next = (state.next + runs) % cfg.locations.length;
    state.lastDaily = TODAY; }
    await writeJSON(`data/${c}-rotation.json`, state);
  }
  log(`${c}: ${rows.length} rows from Apify`);
  if (rows[0]) await writeJSON(`data/sample-${c}.json`, rows.slice(0, 2));
  const have = new Set(pool.map(h => h.id));
  let added = 0;
  for (const r of rows) {
    const h = tidy(normalise(r, BASE(c)));
    if (RENTAL(c)) { h.price = rentPrice(r, h); h.priceText = String(pick(r, 'price') || h.priceText || ''); h.rental = true; }
    if (BASE(c) === 'uk' && !h.county && r._search) h.county = r._search;
    if (r._search) h.search = r._search;
    if (RENTAL(c)) { const why = !h.price ? (pick(r, 'list_price_min') ? 'rent range' : 'no single rent') : h.price < (cfg.minPrice || 700) || h.price > (cfg.maxPrice || 25000) ? 'price out of range' : h.images.length < (cfg.minImages || 4) ? 'few photos' : RENT_BAD_TYPE.test(h.type) ? 'type ' + h.type : (BASE(c) === 'uk' && !h.agent) ? 'no agent' : !usable(h, c) ? 'other' : 'ok'; (refill.why = refill.why || {})[why] = (refill.why[why] || 0) + 1; }
    const why = !usable(h, c) ? (h.price > (cfg.maxPrice || 3500000) ? 'over max price' : h.price < (cfg.minPrice || 120000) ? 'under min price' : BAD_TYPE.test(h.type) || BAD_TYPE.test(h.titleRaw || '') ? 'bad type ' + h.type : (h.status && h.status !== 'for_sale') ? 'status ' + h.status : !h.images.length ? 'no photos' : 'other unusable') : have.has(h.id) ? 'already in pool' : used.has(h.id) ? 'already used' : 'new';
    (refill.skips = refill.skips || {})[why] = (refill.skips[why] || 0) + 1;
    (refill.types = refill.types || {})[h.type || '?'] = (refill.types[h.type || '?'] || 0) + 1;
    if (why !== 'new') continue;
    pool.push(h); have.add(h.id); added++;
  }
  log(`${c}: ${added} usable new listings added to pool`);
  if (refill.skips) { log(`${c}: what the ${rows.length} rows were ${JSON.stringify(refill.skips)}`); refill.skips = null; }
  if (refill.types) { log(`${c}: house types in the pull ${JSON.stringify(refill.types)}`); refill.types = null; }
  if (refill.why) { log(`${c}: why listings were kept or skipped ${JSON.stringify(refill.why)}`); refill.why = null; }
  if (RENTAL(c)) { const by = {}; for (const r of rows) { const t = pick(r, 'seller.sellerType', 'priceFrequency') || 'none'; by[t] = (by[t] || 0) + 1; } log(`${c}: rows by seller type ${JSON.stringify(by)}`); }
  // keep at most cfg.poolPerPlace listings per place (newest first), so no place swamps the pool
  const per = {}, keep = [];
  for (const h of [...pool].reverse()) { const p = placeOf(h); if ((per[p] = (per[p] || 0) + 1) <= (cfg.poolPerPlace || CFG.poolPerPlace || 15)) keep.unshift(h); }
  pool.splice(0, pool.length, ...keep);
}

// ---------- today's seven ----------
function rng(seed) { let s = 0; for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

// A game's big city can cover several searched places (UK rentals: London, Kensington, Chelsea all count as London).
const groupOf = (c, h) => { const cfg = CFG[c] || {}; if (cfg.city) return String(h.hood || h.locality || placeOf(h)).toLowerCase(); const p = placeOf(h), big = String(cfg.bigCity || '').toLowerCase(); return (p.includes(big) || (cfg.bigPlaces || []).map(x => x.toLowerCase()).includes(p)) ? big : p; };
const capOf = (c, g) => g === String((CFG[c] || {}).bigCity || '').toLowerCase() ? ((CFG[c] || {}).bigCount || 2) : ((CFG[c] || {}).perPlaceCap || 1);

function chooseSeven(c, pool, date) {
  const cfg = CFG[c], R = rng(date + c), n = CFG.rounds;
  // listings saved with a neighbourhood field go first (only matters while older US listings are still in the pool)
  const shuffled = pool.filter(h => usable(h, c)).sort(() => R() - 0.5).sort((a, b) => ('hood' in b) - ('hood' in a));
  const place = h => groupOf(c, h);
  const chosen = [], perPlace = {};
  const single = h => /single family/.test(h.type || '');
  const nSingle = () => chosen.filter(single).length;
  const ok = h => (perPlace[place(h)] || 0) < capOf(c, place(h)) && !(cfg.maxSingle && single(h) && nSingle() >= cfg.maxSingle);
  const take = h => { chosen.push(h); const p = place(h); perPlace[p] = (perPlace[p] || 0) + 1; };
  // cfg.bigFirst: the big city's full quota goes in first (UK rentals: 2 London places every day)
  // cfg.quotas: [{places:[...], count:n}] — at least n listings from those searched places (US rentals: cities and small towns)
  for (const q of cfg.quotas || []) { const set = q.places.map(x => x.toLowerCase()); let k = 0; for (const h of shuffled) { if (k >= q.count) break; if (set.includes(placeOf(h)) && ok(h) && !chosen.includes(h)) { take(h); k++; } } }
  if (cfg.bigFirst) { const big = cfg.bigCity.toLowerCase(); for (const h of shuffled) { if ((perPlace[big] || 0) >= capOf(c, big)) break; if (place(h) === big) take(h); } }
  for (let k = 0; k < (cfg.lowCount || 1); k++) { const lo = shuffled.find(h => h.price < cfg.lowBand && ok(h) && !chosen.includes(h)); if (lo) take(lo); }
  for (let k = 0; k < (cfg.highCount || 1); k++) { const hi = shuffled.find(h => h.price > cfg.highBand && ok(h) && !chosen.includes(h)); if (hi) take(hi); }
  for (const h of shuffled) { if (chosen.length >= n) break; if (!chosen.includes(h) && ok(h)) take(h); }
  for (const h of shuffled) { if (chosen.length >= n) break; if (!chosen.includes(h)) take(h); } // relax place cap if short
  const order = chosen.sort(() => R() - 0.5);
  // backups, in case a chosen house has no outside photo: same place rules, then anything
  order.backups = shuffled.filter(h => !chosen.includes(h));
  return order;
}

const MATS = { ie: ['pebble', 'white', 'cream', 'red', 'mixed', 'white', 'pebble'], uk: ['red', 'newred', 'mixed', 'red', 'cream', 'white', 'newred'], us: ['sidingWhite', 'sidingBlue', 'sidingSage', 'sidingYellow', 'sidingGray', 'sidingWhite', 'sidingBlue'] };
const DOORS = ['#1F2A2E', '#2E6B4E', '#8C1C13', '#1B3A5C', '#EFEDE6', '#D4A017', '#5B3A2E', '#4A2C5A', '#0B2A4A', '#B03A2E'];
const cap = s => s.replace(/\b\w/g, m => m.toUpperCase());

const KINDS = [[/end[- ]of[- ]terrace|end terrace/, 'end-of-terrace house'], [/mid[- ]terrace|terrace/, 'terraced house'], [/semi[- ]?d(etached)?\b/, 'semi-detached house'], [/detached/, 'detached house'], [/town ?house/, 'townhouse'], [/bungalow/, 'bungalow'], [/cottage/, 'cottage'], [/farm ?house/, 'farmhouse'], [/mews/, 'mews house'], [/duplex/, 'duplex'], [/villa/, 'villa']];
function titleOf(h) {
  if (h.country === 'us') {   // US: say what it really is (a condo is not a 'house')
    const t = `${h.type || ''} ${h.titleRaw || ''}`, kind = /condo|co-?op/.test(t) ? 'condo' : /town ?(home|house)/.test(t) ? 'townhouse' : /single family/.test(t) ? 'house' : /multi/.test(t) ? 'multi-family home' : 'home';
    return `${h.beds ? h.beds + ' bed ' : ''}${kind}`.replace(/^./, m => m.toUpperCase());
  }
  const k = KINDS.find(([re]) => re.test(h.type) || re.test(h.titleRaw || ''));
  return `${h.beds ? h.beds + ' bed ' : ''}${k ? k[1] : 'house'}`.replace(/^./, m => m.toUpperCase());
}
// UK: Rightmove addresses run "street, district, town, county, postcode". Show the district and the
// searched place ("Didsbury, Manchester"), never the street (it makes the house a quick Google away).
const UK_STREET = /\b(road|rd|street|st|avenue|ave|lane|close|drive|grove|way|terrace|crescent|place|gardens|court|walk|mews|square|row|rise|vale|parade|wharf|yard|mount|approach|chase|croft|fold|meadow|meadows|wynd|gate)\.?$/i;
const UK_COUNTY = /(shire|^west midlands|^greater |^tyne and wear|^merseyside|^city of |lothian$|glamorgan$|^(co\.?|county) |sussex$|middlesex$|^somerset$|^dorset$|^northumberland$|^durham$|^county durham$|^rutland$|^highland$|^fife$|^isle of wight$|^avon$|^cornwall$|^devon$|^kent$|^norfolk$|^suffolk$|^essex$|^surrey$|^cumbria$|^northern ireland$|^scotland$|^wales$|^england$)/i;
const UK_POST = /^([A-Z]{1,2}\d[A-Z\d]?)(\s*\d[A-Z]{2})?$/i;
function ukArea(h) {
  const place = cap(h.county || '');
  const JUNK = /\b(home|homes|accommodation|property|bedroom|bed|family|charming|spacious|stunning|versatile|generous|floors|period|detached|cottage for)\b/i;
  let parts = h.address.split(',').map(s => s.replace(/\s+-\s+.*$/, '').trim()).filter(Boolean)
    .filter(p => !UK_POST.test(p) && !JUNK.test(p));
  if (parts.length >= 2) parts.shift();              // the first part is the street (or house name)
  else if (parts.length === 1) parts = [parts[0].replace(new RegExp('^.*\\b(' + UK_STREET.source.match(/\(([^)]+)\)/)[1] + ')\\.?\\s+', 'i'), '')];
  const lc = place.toLowerCase();
  const district = parts.find(p => !UK_STREET.test(p) && !UK_COUNTY.test(p) && !/\d/.test(p) && p.toLowerCase() !== lc && !lc.includes(p.toLowerCase()) && !p.toLowerCase().includes(lc));
  const d = district ? cap(district.toLowerCase()).replace(/\bSt\b\.?/g, 'St').replace(/\b(Upon|On|In|Under|The|And|Of|By)\b/g, m => m.toLowerCase()) : '';
  return d && place ? `${d}, ${place}` : place || d || 'UK';
}

function areaOf(h) {
  if (h.country === 'uk') return ukArea(h);
  if (h.country === 'us' && h.hood && h.locality) return `${h.hood}, ${cap(h.locality)}, ${h.county}`;
  const POST = /^([A-Z]{1,2}\d[A-Z\d]?(\s*\d[A-Z]{2})?|[A-Z]\d{2}\s?[A-Z\d]{4}|Dublin \d+w?)$/i;
  const parts = h.address.split(',').map(s => s.trim()).filter(Boolean)
    .filter(p => !/^[A-Z]{1,2}\d[A-Z\d]?(\s*\d[A-Z]{2})?$/i.test(p) && !/^[A-Z]\d[\dW]\s?[A-Z\d]{4}$/i.test(p))
    .filter(p => !(p.length > 14 && p === p.toUpperCase())) // drop shouty listing headlines ("BREATHTAKING VIEWS")
    .map(p => p.replace(/^(flat|apt|apartment|unit|no\.?)?\s*\d+[a-z]?\s+/i, ''));
  const county = h.county || '';
  if (h.country === 'ie' && parts.length >= 2) {
    const last = parts[parts.length - 1], prev = parts[parts.length - 2];
    if (/^(co\.?\s|county\s|dublin\s?\d)/i.test(last) || last.toLowerCase() === county.toLowerCase()) return `${prev}, ${/^dublin/i.test(last) ? last.replace(/w$/, 'W') : last.replace(/^(county\s+|co\.\s*|co\s+)/i, 'Co. ')}`;
    return `${prev}, ${last}`;
  }
  const local = h.locality || parts.filter(p => p.toLowerCase() !== county.toLowerCase()).slice(-1)[0] || '';
  if (!county || local.toLowerCase().includes(county.toLowerCase())) return cap(local || county);
  if (!local) return cap(county);
  return `${cap(local)}, ${h.country === 'ie' && !/dublin/i.test(county) ? 'Co. ' : ''}${cap(county)}`;
}

// Download a listing photo; returns the buffer, or null if it fails or is too small.
const bigUrls = u => /rdcpix\.com/.test(u) ? [u.replace(/^http:/, 'https:').replace(/s\.jpg$/, 'od-w1024_h768.jpg'), u.replace(/^http:/, 'https:').replace(/s\.jpg$/, 'rd-w1024_h768.jpg'), u] : [u];
async function fetchPhoto(u, c) {
  for (const v of bigUrls(u)) {
    try {
      const r = await fetch(v, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      const meta = await sharp(buf).metadata().catch(() => ({}));
      if ((meta.width || 0) < (BASE(c) === 'us' ? 600 : 300)) { log(`image too small (${meta.width}px) ${v}`); continue; }
      return buf;
    } catch (e) { log(`image failed ${v}: ${e.message}`); }
  }
  return null;
}

// The game photo must show the FRONT of the house: never a room, patio, roof terrace, deck, view,
// skyline, aerial shot, map, floor plan or mood board. Tries the listing's first 10 photos (a photo fix tries them all) in order and keeps the first one that passes the
// exterior check (scripts/exterior.mjs). No passing photo = the house is skipped.
async function saveImage(h, c, date, limit = 10) {
  const rel = `img/${c}/${date}-${h.id.replace(/[^\w-]/g, '').slice(-24)}.jpg`;
  for (const u of h.images.slice(0, limit)) {
    const buf = await fetchPhoto(u, c);
    if (!buf) continue;
    const score = await outsideScore(buf);   // throws if the model can't load: better no game than a living room
    if (score < THRESHOLD) { log(`not the front of the house (${score.toFixed(2)}) ${u}`); continue; }
    await fs.mkdir(path.join(ROOT, 'site', path.dirname(rel)), { recursive: true });
    await sharp(buf).rotate().resize({ width: 900, withoutEnlargement: true }).jpeg({ quality: 76, mozjpeg: true }).toFile(path.join(ROOT, 'site', rel));
    return rel;
  }
  log(`${c}: no outside photo for ${h.id} (${h.address}), skipped`);
  return null;
}

// Rentals: up to three photos per listing, best first. Each of the listing's first photos is scored
// (scripts/exterior.mjs roomScore): the outside, living room, kitchen, dining room, conservatory,
// garden or view count; bedrooms, bathrooms, bare walls, hallways, floor plans and logos never show.
// Fewer than two good photos = the listing is skipped.
async function saveRentImages(h, c, date, limit = 12) {
  const scored = [];
  for (const [k, u] of h.images.slice(0, limit).entries()) {
    const buf = await fetchPhoto(u, c);
    if (!buf) continue;
    const { good, label } = await roomScore(buf);   // throws if the model can't load: better no game than a bedroom
    if (good < ROOM_THRESHOLD) { log(`  skip photo ${k} (${good.toFixed(2)}, ${label})`); continue; }
    scored.push({ k, buf, good, label });
    if (scored.length >= 5) break;
  }
  if (scored.length < (CFG[c].minGoodPhotos || 2)) { log(`${c}: only ${scored.length} good photos for ${h.id} (${h.address}), skipped`); return null; }
  // the lead photo is the best one; the next two keep the listing's own order
  const lead = scored.reduce((a, b) => (b.good > a.good ? b : a));
  const rest = scored.filter(x => x !== lead).slice(0, 2);
  const out = [];
  for (const [n, x] of [lead, ...rest].entries()) {
    const rel = `img/${c}/${date}-${h.id.replace(/[^\w-]/g, '').slice(-24)}${n ? '-' + (n + 1) : ''}.jpg`;
    await fs.mkdir(path.join(ROOT, 'site', path.dirname(rel)), { recursive: true });
    await sharp(x.buf).rotate().resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 80, mozjpeg: true }).toFile(path.join(ROOT, 'site', rel));
    out.push(rel);
    log(`  photo ${n + 1}: #${x.k} ${x.good.toFixed(2)} ${x.label}`);
  }
  return out;
}

const RENT_KINDS = [[/studio/, 'studio apartment'], [/penthouse/, 'penthouse'], [/duplex/, 'duplex'], [/apartment|flat|condo|co-?op/, 'apartment'], [/townhome|townhouse/, 'townhouse'], [/multi[ _-]?family/, 'duplex']];
function rentTitleOf(h) {
  const k = RENT_KINDS.find(([re]) => re.test(h.type) || re.test(h.titleRaw || ''));
  if (k && k[1] === 'studio apartment') return 'Studio apartment';
  if (k) return `${h.beds ? h.beds + ' bed ' : ''}${k[1]}`.replace(/^./, m => m.toUpperCase());
  return titleOf(h);
}

function toGame(h, img, i, avoid) {
  if (h.rental) return toRentGame(h, img, i, avoid);
  const { blurb } = banter({ id: h.id, text: h.text, rating: h.rating, price: h.price, beds: h.beds, country: h.country, avoid });
  const tr = ''; // the "what they really mean" jokes are retired: nothing is shown about a real listing beyond the agent's own words
  avoid.add(tr);
  const facts = [];
  if (h.country === 'ie' && h.sqm) facts.push(`${Math.round(h.sqm)} m²`);
  if ((h.country === 'uk' || h.country === 'us') && (h.sqft || h.sqm)) facts.push(`${Math.round(h.sqft || h.sqm * 10.764).toLocaleString('en-GB')} sq ft`);
  // facts never show a size under 25 m² / 270 sq ft (bad data)
  if (h.beds) facts.push(`${h.beds} bed`);
  if (h.baths) facts.push(`${h.baths} bath`);
  const R = rng(h.id);
  return {
    id: h.id, img, title: titleOf(h), area: areaOf(h), facts,
    ber: h.country !== 'us' && /^[A-G][0-9+]?$/i.test(h.rating) ? h.rating.toUpperCase() : '', el: h.country === 'uk' ? 'EPC' : h.country === 'us' ? '' : 'BER',
    ask: Math.round(h.price), mat: MATS[h.country][i % 7], door: DOORS[Math.floor(R() * DOORS.length)],
    blurb, tr, src: h.agent || ({ ie: 'daft.ie', uk: 'rightmove.co.uk', us: 'realtor.com' })[h.country], url: h.url,
  };
}

function toRentGame(h, imgs, i, avoid) {
  imgs = [].concat(imgs || []);   // swaps can hand in a single path: a rental always carries a list
  const base = h.country || 'ie';
  const { blurb } = banter({ id: h.id, text: h.text, rating: h.rating, price: h.price, beds: h.beds, country: base, avoid, rent: true });
  const tr = ''; // the "what they really mean" jokes are retired: nothing is shown about a real listing beyond the agent's own words
  avoid.add(tr);
  const facts = [];
  if ((base === 'uk' || base === 'us') && (h.sqft || h.sqm)) facts.push(`${Math.round(h.sqft || h.sqm * 10.764).toLocaleString('en-GB')} sq ft`);
  else if (h.sqm) facts.push(`${Math.round(h.sqm)} m²`);
  if (h.beds) facts.push(`${h.beds} bed`);
  if (h.baths) facts.push(`${h.baths} bath`);
  const R = rng(h.id);
  return {
    // UK: a bare city gets its postcode district ("London SW3") so the area says where it is
    id: h.id, img: imgs[0], imgs, title: rentTitleOf(h), area: (a => base === 'uk' && h.outcode && !a.includes(',') && !a.includes(h.outcode) ? `${a} ${h.outcode}` : a)(areaOf(h).replace(/^London, (.+)$/, '$1, London').replace(/^./, m => m.toUpperCase())), facts,
    ber: base !== 'us' && /^[A-G][0-9+]?$/i.test(h.rating) ? h.rating.toUpperCase() : '', el: base === 'uk' ? 'EPC' : base === 'us' ? '' : 'BER',
    ask: Math.round(h.price), mat: (MATS[base] || MATS.ie)[i % 7], door: DOORS[Math.floor(R() * DOORS.length)],
    blurb, tr, src: h.agent || ({ uk: 'rightmove.co.uk', us: 'realtor.com' })[base] || 'daft.ie', url: h.url,
  };
}

// Pick and save one day's game. ahead=true writes only the dated file (tomorrow's game, made early so
// the site can switch to it at midnight even when GitHub runs the job hours late).
async function doCountry(c, used, avoid, date = TODAY, ahead = false) {
  // Guard 1: never overwrite a game that is already live today (unless forced on purpose).
  const live = await readJSON(`site/houses/${c}/latest.json`, null);
  // --force-refill only tops up the pool; it never replaces a game that is already live.
  if (!ahead && live && live.date === TODAY) throw new Error(`refusing to replace today's live ${c} houses`);
  let pool = (await readJSON(`data/pool-${c}.json`, [])).map(tidy).filter(h => !used.has(h.id) && (Date.parse(TODAY) - Date.parse(h.seen)) / 864e5 <= (CFG[c].poolMaxAgeDays || CFG.poolMaxAgeDays));
  // US listings saved before neighbourhoods were captured are kept only as a fallback: the pool is
  // refilled as if they weren't there, and they are used only if the refill comes back too thin.
  let legacy = [];
  if (BASE(c) === 'us') { legacy = pool.filter(h => !('hood' in h)); pool = pool.filter(h => 'hood' in h); }
  const placesIn = list => new Set(list.map(placeOf)).size;
  const rot = await readJSON(`data/${c}-rotation.json`, {});
  const daily = c !== 'ie' && CFG[c].dailyRuns && rot.lastDaily !== TODAY;
  if (FORCE || forced.has(c) || daily || pool.length < (CFG[c].refillWhenBelow || CFG.refillWhenBelow)) {
    try { await refill(c, pool, used, c !== 'ie' && !CFG[c].city && placesIn(pool) < CFG.rounds * 2); } catch (e) { log(`${c} refill failed: ${e.message}`); if (pool.length + legacy.length < CFG.rounds) throw e; }
  }
  const places = placesIn(pool);
  if (legacy.length && (pool.length < CFG.refillWhenBelow || places < CFG.rounds)) { log(`${c}: thin pool (${pool.length} houses, ${places} places), older listings added back`); pool = pool.concat(legacy); legacy = []; }
  const seven = [], took = [];
  const picks = chooseSeven(c, pool, date);
  const big = CFG[c].bigCity.toLowerCase();
  const fits = h => took.filter(t => groupOf(c, t) === groupOf(c, h)).length < capOf(c, groupOf(c, h));
  // the chosen seven first; if some have no outside photo, big-city backups (when the big city is short), then backups from new places, then any backup
  const bigBackups = CFG[c].bigFirst ? picks.backups.filter(h => groupOf(c, h) === big) : [];
  for (const [list, strict] of [[picks, false], [bigBackups, true], [picks.backups, true], [picks.backups, false]]) {
    for (const h of list) {
      if (seven.length >= CFG.rounds) break;
      if (used.has(h.id) || (strict && !fits(h))) continue;
      const img = RENTAL(c) ? await saveRentImages(h, c, date) : await saveImage(h, c, date);
      used.add(h.id);
      if (img) { seven.push(toGame(h, img, seven.length, avoid)); took.push(h); }
    }
  }
  if (seven.length < CFG.rounds) throw new Error(`${c}: only ${seven.length} houses with photos today`);
  pool = pool.filter(h => !used.has(h.id)).concat(legacy);
  await writeJSON(`data/pool-${c}.json`, pool);
  const out = { country: c, date, day: dayNo(date, c), v: FORMAT, houses: seven };
  if (!ahead) await writeJSON(`site/houses/${c}/latest.json`, out);
  await writeJSON(`site/houses/${c}/${date}.json`, out);
  log(`${c}: game No. ${out.day} for ${date} written${ahead ? ' (made ahead)' : ''}, ${pool.length} left in pool`);
  for (const h of seven) log(`  ${h.area} · ${h.title} · ${h.ask} · ${h.tr}`);
}

async function cleanImages() {
  for (const c of COUNTRIES) {
    const dir = path.join(ROOT, 'site/img', c);
    for (const f of await fs.readdir(dir).catch(() => [])) {
      const d = f.slice(0, 10);
      if ((Date.parse(TODAY) - Date.parse(d)) / 864e5 > CFG.keepImagesDays) await fs.rm(path.join(dir, f));
    }
  }
}

const used = new Set(await readJSON('data/used.json', []));
const usedRent = {};
for (const c of COUNTRIES.filter(RENTAL)) usedRent[c] = new Set(await readJSON(`data/used-${c}.json`, []));
const usedFor = c => RENTAL(c) ? usedRent[c] : used;
// Real-meaning lines used in either country in the last 14 days (read from the dated game files),
// so no joke repeats within a fortnight or appears in both countries on the same day.
const avoid = new Set();
for (const c of COUNTRIES) {
  for (const f of await fs.readdir(path.join(ROOT, 'site/houses', c)).catch(() => [])) {
    const d = f.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const age = (Date.parse(TODAY) - Date.parse(d)) / 864e5;
    if (age < -2 || age > 14) continue;   // includes the two days made ahead
    for (const h of (await readJSON(`site/houses/${c}/${f}`, {})).houses || []) if (h.tr) avoid.add(h.tr);
  }
}
// --fix-photos: check the photo of every house in today's game and the next two days'. A photo that
// isn't the outside of the house is swapped for an outside photo of the SAME listing (so the answers
// don't change), from data/photo-candidates.json or the pool. If the listing has none, the house is
// replaced with a new one from the pool (same slot, different place).
async function fixPhotos(c) {
  const extra = await readJSON('data/photo-candidates.json', {});
  let pool = (await readJSON(`data/pool-${c}.json`, [])).map(tidy);
  let changed = 0;
  for (const d of AHEAD ? [TOMORROW, nextDay(TOMORROW)] : [TODAY, TOMORROW, nextDay(TOMORROW)]) {
    const game = await readJSON(`site/houses/${c}/${d}.json`, null);
    if (!game || !game.houses) continue;
    let dirty = false;
    for (let i = 0; i < game.houses.length; i++) {
      const g = game.houses[i];
      let score = 0;
      try { score = await outsideScore(await fs.readFile(path.join(ROOT, 'site', g.img))); } catch (e) { log(`${c} ${d}: can't read ${g.img}: ${e.message}`); }
      if (score >= THRESHOLD) continue;
      log(`${c} ${d} #${i} ${g.area}: photo is not the front of the house (${score.toFixed(2)})`);
      // 1) another photo of the same listing (new file name, so no one sees a cached old photo)
      const urls = [...(extra[g.id] || []), ...((pool.find(h => h.id === g.id) || {}).images || [])];
      const swapped = urls.length ? await saveImage({ id: g.id + 'x', images: [...new Set(urls)], address: g.area }, c, d, 80) : null;
      if (swapped) { game.houses[i] = { ...g, img: swapped }; dirty = true; changed++; log(`  swapped to another photo of the same house: ${swapped}`); continue; }
      // 2) replace the house with a new one from the pool
      const places = new Set(game.houses.map(h => h.area.split(',').slice(-2).join(',').trim().toLowerCase()));
      const cands = pool.filter(h => usable(h, c) && !used.has(h.id)).sort(() => Math.random() - 0.5)
        .sort((a, b) => places.has(areaOf(a).split(',').slice(-2).join(',').trim().toLowerCase()) - places.has(areaOf(b).split(',').slice(-2).join(',').trim().toLowerCase()));
      let done = false;
      for (const h of cands.slice(0, 40)) {
        const img = await (RENTAL(c) ? saveRentImages(h, c, d) : saveImage(h, c, d));
        used.add(h.id);
        if (!img) continue;
        const ng = toGame(h, img, i, avoid);
        ng.mat = g.mat;
        game.houses[i] = ng; dirty = true; changed++; done = true;
        log(`  replaced with ${ng.area} · ${ng.title} · ${ng.ask} · ${ng.tr}`);
        break;
      }
      if (!done) throw new Error(`${c} ${d}: no replacement house with an outside photo`);
    }
    if (!dirty) continue;
    await writeJSON(`site/houses/${c}/${d}.json`, game);
    const live = await readJSON(`site/houses/${c}/latest.json`, null);
    if (live && live.date === d) await writeJSON(`site/houses/${c}/latest.json`, game);
  }
  pool = pool.filter(h => !used.has(h.id));
  await writeJSON(`data/pool-${c}.json`, pool);
  log(`${c}: photo check done, ${changed} fixed`);
}

// --vary: make today's and the next two days' games in every city more varied. In each game, up to two houses
// that repeat a neighbourhood (or are single-family when the game is all single-family) are swapped, same slot, for houses
// from other neighbourhoods and other house types. Pulls only the small 'mix' (cfg.mix) from Apify. May change today's live game on purpose.
const VARY = args.includes('--vary');
async function varyCity(c) {
  const cfg = CFG[c], single = h => /single family/.test(h.type || '');
  let pool = (await readJSON(`data/pool-${c}.json`, [])).map(tidy);
  if (TOKEN && cfg.mix && cfg.mix.length) { refilled.delete(c); try { await refill(c, pool, usedFor(c), false, true); } catch (e) { log(`${c}: mix pull failed: ${e.message}`); } }
  pool = pool.filter(h => usable(h, c) && !usedFor(c).has(h.id));
  const hoodOf = h => String(h.hood || h.locality || '').toLowerCase();
  const typeOfGame = g => g.id && (pool.find(p => p.id === g.id) || {});
  let changed = 0;
  for (const d of [TODAY, TOMORROW, nextDay(TOMORROW)]) {
    const game = await readJSON(`site/houses/${c}/${d}.json`, null);
    if (!game || !game.houses) continue;
    const areaKey = g => String(g.area || '').split(',')[0].trim().toLowerCase();
    const seen = {}; const slots = [];
    game.houses.forEach((g, i) => { const k = areaKey(g); if (seen[k] !== undefined) slots.push(i); else seen[k] = i; });   // repeat neighbourhoods
    const isSingleG = g => /house|single/i.test(g.title || '') && !/condo|townhouse|townhome|apartment/i.test(g.title || '');
    const nonSingle = game.houses.filter(g => !isSingleG(g)).length;   // house-type variety: aim for at least two non-single-family a game
    if (nonSingle < 2) for (let i = 0; i < game.houses.length && slots.length < 2; i++) if (!slots.includes(i) && isSingleG(game.houses[i])) slots.push(i);
    let did = 0;
    for (const i of slots) {
      if (did >= 2) break;
      const keep = new Set(game.houses.filter((_, j) => j !== i).map(areaKey));
      const cands = pool.filter(h => !usedFor(c).has(h.id) && !keep.has(String(areaOf(h)).split(',')[0].trim().toLowerCase()))
        .sort((a, b) => (single(a) - single(b)) || (R_(a.id) - R_(b.id)));
      let done = false;
      for (const h of cands.slice(0, 25)) {
        const img = await (RENTAL(c) ? saveRentImages(h, c, d) : saveImage(h, c, d));
        usedFor(c).add(h.id);
        if (!img) continue;
        const ng = toGame(h, img, i, avoid); ng.mat = game.houses[i].mat;
        log(`${c} ${d} #${i}: ${game.houses[i].area} · ${game.houses[i].title}  ->  ${ng.area} · ${ng.title}`);
        game.houses[i] = ng; changed++; did++; done = true; break;
      }
      if (!done) log(`${c} ${d} #${i}: no suitable replacement, left as is`);
    }
    if (did) {
      await writeJSON(`site/houses/${c}/${d}.json`, game);
      const live = await readJSON(`site/houses/${c}/latest.json`, null);
      if (live && live.date === d) await writeJSON(`site/houses/${c}/latest.json`, game);
    }
  }
  pool = pool.filter(h => !usedFor(c).has(h.id));
  await writeJSON(`data/pool-${c}.json`, pool);
  log(`${c}: variety pass done, ${changed} houses swapped`);
}
const R_ = id => { let x = 0; for (const ch of String(id)) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return x; };
if (VARY) {
  for (const c of (only ? [only] : CITIES)) { TODAY = dateIn(c); TOMORROW = nextDay(TODAY); await varyCity(c); }
  await writeJSON('data/used.json', [...used]);
  process.exit(0);
}


// --swap: targeted swaps in TODAY's city game, read from data/swap-plan.json:
// { "usc-chicago": { "pull": ["Lincoln Park, Chicago, IL"], "maxItems": 20, "swaps": [ { "slot": 1, "where": "bronx", "minPrice": 0 } ] } }
// "pull" is an optional small Apify pull for places the pool lacks; "where" is a regex on neighbourhood+place. May change today's live game on purpose.
const SWAP = args.includes('--swap');
if (SWAP) {
  const plan = await readJSON('data/swap-plan.json', {});
  for (const c of (only ? [only] : Object.keys(plan))) {
    const spList = [].concat(plan[c] || []); if (!spList.length || !CFG[c]) continue;
  for (const sp of spList) {
    TODAY = sp.date || dateIn(c);
    let pool = (await readJSON(`data/pool-${c}.json`, [])).map(tidy);
    const have = new Set(pool.map(h => h.id));
    if (TOKEN && sp.pull) for (const loc of sp.pull) {
      try {
        const rows = await runActor(CFG[c].actor, { ...CFG[c].input, maxItems: sp.maxItems || 20, searchLocations: [loc] });
        let n = 0; for (const r of rows) { const h = tidy(normalise(r, BASE(c))); if (usable(h, c) && !have.has(h.id) && !used.has(h.id)) { pool.push(h); have.add(h.id); n++; } }
        log(`${c}: pull for ${loc} gave ${rows.length} rows, ${n} new`);
      } catch (e) { log(`${c}: pull ${loc} failed: ${e.message}`); }
    }
    const file = `site/houses/${c}/${TODAY}.json`, game = await readJSON(file, null);
    if (!game) continue;
    const areaKey = g => String(g.area || '').split(',')[0].trim().toLowerCase();
    let changed = 0;
    for (const w of sp.swaps || []) {
      const keep = new Set(game.houses.filter((_, j) => j !== w.slot).map(areaKey));
      const re = new RegExp(w.where || '.', 'i');
      const cands = pool.filter(h => usable(h, c) && !used.has(h.id) && re.test(`${h.hood || ''} ${h.locality || ''}`) && h.price >= (w.minPrice || 0) && h.price <= (w.maxPrice || 1e9) && !keep.has(String(areaOf(h)).split(',')[0].trim().toLowerCase()))
        .sort((a, b) => R_(a.id) - R_(b.id));
      let done = false;
      for (const h of cands.slice(0, 15)) {
        const img = await (RENTAL(c) ? saveRentImages(h, c, TODAY) : saveImage(h, c, TODAY));
        used.add(h.id);
        if (!img) continue;
        const ng = toGame(h, img, w.slot, avoid); ng.mat = game.houses[w.slot].mat;
        log(`${c} ${TODAY} #${w.slot}: ${game.houses[w.slot].area} · ${game.houses[w.slot].title} · $${game.houses[w.slot].ask}  ->  ${ng.area} · ${ng.title} · $${ng.ask}`);
        game.houses[w.slot] = ng; changed++; done = true; break;
      }
      if (!done) log(`${c} #${w.slot}: no suitable replacement for ${w.where}, left as is`);
    }
    if (changed) { await writeJSON(file, game); const live = await readJSON(`site/houses/${c}/latest.json`, null); if (live && live.date === TODAY) await writeJSON(`site/houses/${c}/latest.json`, game); }
    await writeJSON(`data/pool-${c}.json`, pool.filter(h => !used.has(h.id)));
    log(`${c}: swap pass done for ${TODAY}, ${changed} houses swapped`);
  }
  }
  await writeJSON('data/used.json', [...used]);
  process.exit(0);
}

if (FIX) {
  for (const c of (only ? [only] : COUNTRIES).filter(c => !RENTAL(c))) { TODAY = dateIn(c); TOMORROW = nextDay(TODAY); await fixPhotos(c); }
  await writeJSON('data/used.json', [...used]);
  process.exit(0);
}

// Rolling three days (today and the next two) in every city, always. When a city's pool is too thin for a day's seven
// houses, pull 10 more listings and try again, 10 at a time, up to 100. It only costs Apify credits when it is needed.
async function buildDay(c, date, ahead) {
  const cfg = CFG[c];
  for (let step = 0; ; step++) {
    try { return await doCountry(c, usedFor(c), avoid, date, ahead); }
    catch (e) {
      if (!cfg.city || !/only \d+ houses/.test(e.message) || !TOKEN || (cfg.input.maxItems || 0) >= 100 || step >= 6) throw e;
      cfg.input.maxItems = (cfg.input.maxItems || 30) + 10;
      forced.add(c); refilled.delete(c);
      log(`${c}: short of houses for ${date}, pulling ${cfg.input.maxItems} listings and trying again`);
    }
  }
}

// --refill-only: top up the pool(s) from Apify and stop (no games built). For deliberate small test pulls.
if (args.includes('--refill-only')) {
  for (const c of only ? [only] : COUNTRIES) {
    TODAY = dateIn(c);
    const pool = (await readJSON(`data/pool-${c}.json`, [])).map(tidy);
    await refill(c, pool, usedFor(c), false);
    await writeJSON(`data/pool-${c}.json`, pool);
    log(`${c}: pool now ${pool.length}`);
  }
  process.exit(0);
}

let failed = 0;
for (const c of only ? [only] : COUNTRIES) {
  TODAY = dateIn(c); TOMORROW = nextDay(TODAY);
  const already = await readJSON(`site/houses/${c}/latest.json`, null);
  const madeAhead = await readJSON(`site/houses/${c}/${TODAY}.json`, null);
  // Once a day's houses are out, they never change that day.
  if (already && already.date === TODAY) log(`${c}: today's game already exists, left unchanged`);
  // Today's game was made ahead yesterday (and may already be live via the dated file): promote it, never re-pick.
  else if (madeAhead && madeAhead.date === TODAY && (madeAhead.houses || []).length >= CFG.rounds) {
    await writeJSON(`site/houses/${c}/latest.json`, madeAhead); log(`${c}: today's game was made ahead, now promoted to latest`);
  }
  else { try { await buildDay(c, TODAY, false); } catch (e) { failed++; console.error(`${c} FAILED: ${e.message}`); continue; } }
  // The next two days' games are made now, so tomorrow's is always ready (for midnight and for the
  // sneak peek) and a whole day of failed runs still leaves the game running.
  for (const [d, name] of [[TOMORROW, 'tomorrow'], [nextDay(TOMORROW), 'day after tomorrow']]) {
    const next = await readJSON(`site/houses/${c}/${d}.json`, null);
    if (next && next.date === d && (next.houses || []).length >= CFG.rounds) { log(`${c}: ${name}'s game already made`); continue; }
    try { await buildDay(c, d, true); } catch (e) { failed++; console.error(`${c} ${name} FAILED: ${e.message}`); break; }
  }
}
await writeJSON('data/used.json', [...used]);
for (const c of COUNTRIES.filter(RENTAL)) if (!only || only === c) await writeJSON(`data/used-${c}.json`, [...usedRent[c]]);
await cleanImages();
if (failed) { console.error(`${failed} country/countries failed. Yesterday's houses stay live for them.`); process.exit(1); }
