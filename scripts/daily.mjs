// Nightly: keep a pool of real listings per country (topped up from Apify when it runs low),
// pick today's 7 houses, save their photos, and write site/houses/<country>/latest.json.
// Usage: APIFY_TOKEN=... node scripts/daily.mjs [--country ie|uk|us] [--force-refill]
// Each country runs on its own clock (CFG[c].tz): the US day starts at New York midnight.
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { banter } from './banter.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CFG = JSON.parse(await fs.readFile(path.join(ROOT, 'scripts/config.json'), 'utf8'));
const TOKEN = process.env.APIFY_TOKEN;
const args = process.argv.slice(2);
const only = args.includes('--country') ? args[args.indexOf('--country') + 1] : null;
const FORCE = args.includes('--force-refill');
const COUNTRIES = ['ie', 'uk', 'us'];
const dateIn = c => new Date().toLocaleDateString('en-CA', { timeZone: CFG[c].tz || 'Europe/London' });
const nextDay = d => new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10);
let TODAY = dateIn('ie'), TOMORROW = nextDay(TODAY);   // reset per country in the main loop
const FORMAT = 3;
const dayNo = (d, c) => Math.floor((Date.parse(d) - Date.parse(CFG[c].launch || CFG.launch)) / 864e5) + 1;

const readJSON = async (p, d) => { try { return JSON.parse(await fs.readFile(path.join(ROOT, p), 'utf8')); } catch { return d; } };
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
  const text = [pick(o, 'description', 'summary', 'propertyDescription', 'description_text', 'text'), (pick(o, 'features', 'keyFeatures') || []).join?.('. ')].filter(Boolean).join(' ').replace(/<br\s*\/?>/gi, '. ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
  const titleRaw = String(pick(o, 'propertyTitle') || '').toLowerCase();
  // US: the neighbourhood (Realtor.com lists the most specific one first), so a city like
  // San Francisco shows "Noe Valley, San Francisco, CA" rather than just the city.
  const hoodList = pick(o, 'neighborhoods', 'neighborhood', 'neighborhood_name');
  let hood = (Array.isArray(hoodList) ? hoodList : String(hoodList || '').split(','))
    .map(x => String(typeof x === 'object' && x ? (x.name || '') : x).trim()).find(Boolean) || null;
  if (hood && hood.toLowerCase() === locality.toLowerCase()) hood = null;
  const extra = country === 'us' ? { hood } : {};
  return { ...extra, id, url, price, priceText, cars, status: o.status ? String(o.status).toLowerCase() : null, beds, baths, type, titleRaw, address: address.replace(/\s*\|\s*/g, ', '), county, locality, sqm, sqft: sqft && sqft < 450 ? Math.round(sqft * 10.764) : sqft, rating, agent: agent ? String(agent) : null, text, images: imgs(o), country, seen: TODAY };
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
const BAD_TYPE = /apartment|flat|studio|site|land|plot|parking|garage only|commercial|retirement|houseboat|park home|mobile|maisonette/;
const BAD_TEXT = /\bplot\b|\bland\b|building site|development opportunity|\bauction\b/i;
function usable(h, c) {
  const cfg = CFG[c] || {};
  if (c === 'us' && h.status && h.status !== 'for_sale') return false;   // no pending, contingent or auction listings
  return h.url && h.price && h.price >= (cfg.minPrice || 120000) && h.price <= (cfg.maxPrice || 3500000) && h.images.length && !BAD_TYPE.test(h.type) && !BAD_TYPE.test(h.titleRaw || '') && !BAD_TEXT.test(h.address) && !BAD_TEXT.test(h.titleRaw || '') && (h.county || h.locality || h.address);
}

// ---------- pool ----------
async function refill(c, pool, used, sweep = false) {
  const cfg = CFG[c];
  let rows = [];
  if (c === 'ie') {
    rows = await runActor(cfg.actor, cfg.input);
  } else {
    // UK and US: a few places per refill, rotating through the list so the houses spread out.
    // sweep = every place at once (used when the pool is empty), run a few at a time.
    const state = await readJSON(`data/${c}-rotation.json`, { next: 0 });
    const runs = sweep ? cfg.locations.length : cfg.runsPerRefill;
    const locs = Array.from({ length: runs }, (_, i) => cfg.locations[(state.next + i) % cfg.locations.length]);
    for (let i = 0; i < locs.length; i += 5) {
      await Promise.all(locs.slice(i, i + 5).map(async loc => {
        const input = c === 'us' ? { ...cfg.input, searchLocations: [loc] } : { ...cfg.input, searchLocation: loc };
        try { rows.push(...(await runActor(cfg.actor, input)).map(r => ({ ...r, _search: loc }))); }
        catch (e) { log(`${c} search ${loc} failed: ${e.message}`); }
      }));
    }
    state.next = (state.next + runs) % cfg.locations.length;
    await writeJSON(`data/${c}-rotation.json`, state);
  }
  log(`${c}: ${rows.length} rows from Apify`);
  if (rows[0]) await writeJSON(`data/sample-${c}.json`, rows.slice(0, 2));
  const have = new Set(pool.map(h => h.id));
  let added = 0;
  for (const r of rows) {
    const h = tidy(normalise(r, c));
    if (c === 'uk' && !h.county && r._search) h.county = r._search;
    if (!usable(h, c) || have.has(h.id) || used.has(h.id)) continue;
    pool.push(h); have.add(h.id); added++;
  }
  log(`${c}: ${added} usable new listings added to pool`);
}

// ---------- today's seven ----------
function rng(seed) { let s = 0; for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

function chooseSeven(c, pool, date) {
  const cfg = CFG[c], R = rng(date + c), n = CFG.rounds;
  // listings saved with a neighbourhood field go first (only matters while older US listings are still in the pool)
  const shuffled = pool.filter(h => usable(h, c)).sort(() => R() - 0.5).sort((a, b) => ('hood' in b) - ('hood' in a));
  const place = h => (h.county || h.locality || '').toLowerCase();
  const chosen = [], perPlace = {};
  const ok = h => {
    const p = place(h), big = cfg.bigCity.toLowerCase();
    const cap = p.includes(big) ? 2 : (cfg.perPlaceCap || 1);
    return (perPlace[p] || 0) < cap;
  };
  const take = h => { chosen.push(h); const p = place(h); perPlace[p] = (perPlace[p] || 0) + 1; };
  const lo = shuffled.find(h => h.price < cfg.lowBand && ok(h)); if (lo) take(lo);
  const hi = shuffled.find(h => h.price > cfg.highBand && ok(h) && !chosen.includes(h)); if (hi) take(hi);
  for (const h of shuffled) { if (chosen.length >= n) break; if (!chosen.includes(h) && ok(h)) take(h); }
  for (const h of shuffled) { if (chosen.length >= n) break; if (!chosen.includes(h)) take(h); } // relax place cap if short
  return chosen.sort(() => R() - 0.5);
}

const MATS = { ie: ['pebble', 'white', 'cream', 'red', 'mixed', 'white', 'pebble'], uk: ['red', 'newred', 'mixed', 'red', 'cream', 'white', 'newred'], us: ['sidingWhite', 'sidingBlue', 'sidingSage', 'sidingYellow', 'sidingGray', 'sidingWhite', 'sidingBlue'] };
const DOORS = ['#1F2A2E', '#2E6B4E', '#8C1C13', '#1B3A5C', '#EFEDE6', '#D4A017', '#5B3A2E', '#4A2C5A', '#0B2A4A', '#B03A2E'];
const cap = s => s.replace(/\b\w/g, m => m.toUpperCase());

const KINDS = [[/end[- ]of[- ]terrace|end terrace/, 'end-of-terrace house'], [/mid[- ]terrace|terrace/, 'terraced house'], [/semi[- ]?d(etached)?\b/, 'semi-detached house'], [/detached/, 'detached house'], [/town ?house/, 'townhouse'], [/bungalow/, 'bungalow'], [/cottage/, 'cottage'], [/farm ?house/, 'farmhouse'], [/mews/, 'mews house'], [/duplex/, 'duplex'], [/villa/, 'villa']];
function titleOf(h) {
  const k = KINDS.find(([re]) => re.test(h.type) || re.test(h.titleRaw || ''));
  return `${h.beds ? h.beds + ' bed ' : ''}${k ? k[1] : 'house'}`.replace(/^./, m => m.toUpperCase());
}
function areaOf(h) {
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

async function saveImage(h, c, date) {
  const rel = `img/${c}/${date}-${h.id.replace(/[^\w-]/g, '').slice(-24)}.jpg`;
  // Realtor.com photo links end in "s.jpg" (a 120px thumbnail): ask for the big version first.
  const big = u => /rdcpix\.com/.test(u) ? [u.replace(/^http:/, 'https:').replace(/s\.jpg$/, 'od-w1024_h768.jpg'), u.replace(/^http:/, 'https:').replace(/s\.jpg$/, 'rd-w1024_h768.jpg'), u] : [u];
  for (const u of h.images.slice(0, 3).flatMap(big)) {
    try {
      const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      const meta = await sharp(buf).metadata().catch(() => ({}));
      if (c === 'us' && (meta.width || 0) < 600) { log(`image too small (${meta.width}px) ${u}`); continue; }
      await fs.mkdir(path.join(ROOT, 'site', path.dirname(rel)), { recursive: true });
      await sharp(buf).rotate().resize({ width: 900, withoutEnlargement: true }).jpeg({ quality: 76, mozjpeg: true }).toFile(path.join(ROOT, 'site', rel));
      return rel;
    } catch (e) { log(`image failed ${u}: ${e.message}`); }
  }
  return null;
}

function toGame(h, img, i, avoid) {
  const { blurb, tr } = banter({ id: h.id, text: h.text, rating: h.rating, price: h.price, beds: h.beds, country: h.country, avoid });
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

// Pick and save one day's game. ahead=true writes only the dated file (tomorrow's game, made early so
// the site can switch to it at midnight even when GitHub runs the job hours late).
async function doCountry(c, used, avoid, date = TODAY, ahead = false) {
  // Guard 1: never overwrite a game that is already live today (unless forced on purpose).
  const live = await readJSON(`site/houses/${c}/latest.json`, null);
  if (!ahead && live && live.date === TODAY && !FORCE) throw new Error(`refusing to replace today's live ${c} houses`);
  let pool = (await readJSON(`data/pool-${c}.json`, [])).map(tidy).filter(h => !used.has(h.id) && (Date.parse(TODAY) - Date.parse(h.seen)) / 864e5 <= CFG.poolMaxAgeDays);
  // US listings saved before neighbourhoods were captured are kept only as a fallback: the pool is
  // refilled as if they weren't there, and they are used only if the refill comes back too thin.
  let legacy = [];
  if (c === 'us') { legacy = pool.filter(h => !('hood' in h)); pool = pool.filter(h => 'hood' in h); }
  if (FORCE || pool.length < CFG.refillWhenBelow) {
    try { await refill(c, pool, used, c !== 'ie' && pool.length === 0); } catch (e) { log(`${c} refill failed: ${e.message}`); if (pool.length + legacy.length < CFG.rounds) throw e; }
  }
  const places = new Set(pool.map(h => (h.county + h.locality).toLowerCase())).size;
  if (legacy.length && (pool.length < CFG.refillWhenBelow || places < CFG.rounds)) { log(`${c}: thin pool (${pool.length} houses, ${places} places), older listings added back`); pool = pool.concat(legacy); legacy = []; }
  const seven = [];
  for (const h of chooseSeven(c, pool, date)) {
    if (seven.length >= CFG.rounds) break;
    const img = await saveImage(h, c, date);
    used.add(h.id);
    if (img) seven.push(toGame(h, img, seven.length, avoid));
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
// Real-meaning lines used in either country in the last 14 days (read from the dated game files),
// so no joke repeats within a fortnight or appears in both countries on the same day.
const avoid = new Set();
for (const c of COUNTRIES) {
  for (const f of await fs.readdir(path.join(ROOT, 'site/houses', c)).catch(() => [])) {
    const d = f.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const age = (Date.parse(TODAY) - Date.parse(d)) / 864e5;
    if (age < -1 || age > 14) continue;
    for (const h of (await readJSON(`site/houses/${c}/${f}`, {})).houses || []) if (h.tr) avoid.add(h.tr);
  }
}
let failed = 0;
for (const c of only ? [only] : COUNTRIES) {
  TODAY = dateIn(c); TOMORROW = nextDay(TODAY);
  const already = await readJSON(`site/houses/${c}/latest.json`, null);
  const madeAhead = await readJSON(`site/houses/${c}/${TODAY}.json`, null);
  // Once a day's houses are out, they never change that day.
  if (already && already.date === TODAY && !FORCE) log(`${c}: today's game already exists, left unchanged`);
  // Today's game was made ahead yesterday (and may already be live via the dated file): promote it, never re-pick.
  else if (madeAhead && madeAhead.date === TODAY && (madeAhead.houses || []).length >= CFG.rounds && !FORCE) {
    await writeJSON(`site/houses/${c}/latest.json`, madeAhead); log(`${c}: today's game was made ahead, now promoted to latest`);
  }
  else { try { await doCountry(c, used, avoid); } catch (e) { failed++; console.error(`${c} FAILED: ${e.message}`); continue; } }
  // Tomorrow's game, made now so it is ready at midnight whatever time GitHub runs the next job.
  const next = await readJSON(`site/houses/${c}/${TOMORROW}.json`, null);
  if (next && (next.houses || []).length >= CFG.rounds) log(`${c}: tomorrow's game already made`);
  else { try { await doCountry(c, used, avoid, TOMORROW, true); } catch (e) { failed++; console.error(`${c} tomorrow FAILED: ${e.message}`); } }
}
await writeJSON('data/used.json', [...used]);
await cleanImages();
if (failed) { console.error(`${failed} country/countries failed. Yesterday's houses stay live for them.`); process.exit(1); }
