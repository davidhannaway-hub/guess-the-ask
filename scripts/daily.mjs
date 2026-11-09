// Nightly: keep a pool of real listings per country (topped up from Apify when it runs low),
// pick today's 7 houses, save their photos, and write site/houses/<country>/latest.json.
// Usage: APIFY_TOKEN=... node scripts/daily.mjs [--country ie|uk] [--force-refill]
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
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const FORMAT = 3;
const DAY = Math.floor((Date.parse(TODAY) - Date.parse(CFG.launch)) / 864e5) + 1;

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
  const a = pick(o, 'images', 'imageUrls', 'photos', 'propertyImages', 'media.images') || [];
  const list = (Array.isArray(a) ? a : [a]).map(x => typeof x === 'string' ? x : (x && (x.url || x.srcUrl || x.src || x.large || x.medium || x.size720x480 || x.size1440x960))).filter(Boolean);
  const one = pick(o, 'imageUrl', 'image', 'mainImage', 'propertyImage');
  if (one && typeof one === 'string') list.unshift(one);
  return [...new Set(list)].filter(u => /^https?:/.test(u));
};

function normalise(o, country) {
  const id = String(pick(o, 'id', 'propertyId', 'daftShortcode', 'listingId') || pick(o, 'propertyUrl', 'url'));
  const url = pick(o, 'propertyUrl', 'url', 'link');
  const price = num(pick(o, 'priceValue', 'price.amount', 'price', 'askingPrice'));
  const beds = num(pick(o, 'beds', 'bedrooms', 'numBedrooms'));
  const baths = num(pick(o, 'bathrooms', 'baths', 'numBathrooms'));
  const type = String(pick(o, 'propertySubType', 'propertyType', 'type') || '').toLowerCase();
  const address = String(pick(o, 'title', 'displayAddress', 'address', 'streetAddress') || '');
  const county = String(pick(o, 'county', 'region', 'addressRegion') || '').replace(/^(Co\.|County)\s*/i, '').trim();
  const locality = String(pick(o, 'areaName', 'addressLocality', 'city', 'town', 'location') || '').trim();
  const sqm = num(pick(o, 'floorAreaValue', 'surface', 'size_m2', 'sizeSqM'));
  const sqft = num(pick(o, 'sizeSqFt', 'sizeSqft', 'floorAreaSqFt'));
  const rating = String(pick(o, 'berRating', 'berCode', 'ber', 'epcRating', 'epc.currentRating', 'energyRating') || '').replace(/^(BER|EPC)\s*/i, '').trim();
  const agent = pick(o, 'seller.branch', 'seller.name', 'agentName', 'agencyName', 'agent.name', 'seller_name', 'branchName');
  const text = [pick(o, 'description', 'summary', 'propertyDescription', 'text'), (pick(o, 'features', 'keyFeatures') || []).join?.('. ')].filter(Boolean).join(' ').replace(/<br\s*\/?>/gi, '. ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
  const titleRaw = String(pick(o, 'propertyTitle') || '').toLowerCase();
  return { id, url, price, beds, baths, type, titleRaw, address: address.replace(/\s*\|\s*/g, ', '), county, locality, sqm, sqft: sqft && sqft < 450 ? Math.round(sqft * 10.764) : sqft, rating, agent: agent ? String(agent) : null, text, images: imgs(o), country, seen: TODAY };
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
  return h.url && h.price && h.price >= 120000 && h.price <= 3500000 && h.images.length && !BAD_TYPE.test(h.type) && !BAD_TYPE.test(h.titleRaw || '') && !BAD_TEXT.test(h.address) && !BAD_TEXT.test(h.titleRaw || '') && (h.county || h.locality || h.address);
}

// ---------- pool ----------
async function refill(c, pool, used) {
  const cfg = CFG[c];
  let rows = [];
  if (c === 'ie') {
    rows = await runActor(cfg.actor, cfg.input);
  } else {
    const state = await readJSON('data/uk-rotation.json', { next: 0 });
    for (let i = 0; i < cfg.runsPerRefill; i++) {
      const loc = cfg.locations[(state.next + i) % cfg.locations.length];
      try { rows.push(...(await runActor(cfg.actor, { ...cfg.input, searchLocation: loc })).map(r => ({ ...r, _search: loc }))); }
      catch (e) { log(`UK search ${loc} failed: ${e.message}`); }
    }
    state.next = (state.next + cfg.runsPerRefill) % cfg.locations.length;
    await writeJSON('data/uk-rotation.json', state);
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

function chooseSeven(c, pool) {
  const cfg = CFG[c], R = rng(TODAY + c), n = CFG.rounds;
  const shuffled = pool.filter(h => usable(h, c)).sort(() => R() - 0.5);
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

const MATS = { ie: ['pebble', 'white', 'cream', 'red', 'mixed', 'white', 'pebble'], uk: ['red', 'newred', 'mixed', 'red', 'cream', 'white', 'newred'] };
const DOORS = ['#1F2A2E', '#2E6B4E', '#8C1C13', '#1B3A5C', '#EFEDE6', '#D4A017', '#5B3A2E', '#4A2C5A', '#0B2A4A', '#B03A2E'];
const cap = s => s.replace(/\b\w/g, m => m.toUpperCase());

const KINDS = [[/end[- ]of[- ]terrace|end terrace/, 'end-of-terrace house'], [/mid[- ]terrace|terrace/, 'terraced house'], [/semi[- ]?d(etached)?\b/, 'semi-detached house'], [/detached/, 'detached house'], [/town ?house/, 'townhouse'], [/bungalow/, 'bungalow'], [/cottage/, 'cottage'], [/farm ?house/, 'farmhouse'], [/mews/, 'mews house'], [/duplex/, 'duplex'], [/villa/, 'villa']];
function titleOf(h) {
  const k = KINDS.find(([re]) => re.test(h.type) || re.test(h.titleRaw || ''));
  return `${h.beds ? h.beds + ' bed ' : ''}${k ? k[1] : 'house'}`.replace(/^./, m => m.toUpperCase());
}
function areaOf(h) {
  const POST = /^([A-Z]{1,2}\d[A-Z\d]?(\s*\d[A-Z]{2})?|[A-Z]\d{2}\s?[A-Z\d]{4}|Dublin \d+w?)$/i;
  const parts = h.address.split(',').map(s => s.trim()).filter(Boolean)
    .filter(p => !/^[A-Z]{1,2}\d[A-Z\d]?(\s*\d[A-Z]{2})?$/i.test(p) && !/^[A-Z]\d[\dW]\s?[A-Z\d]{4}$/i.test(p))
    .map(p => p.replace(/^(flat|apt|apartment|unit|no\.?)?\s*\d+[a-z]?\s+/i, ''));
  const county = h.county || '';
  if (h.country === 'ie' && parts.length >= 2) {
    const last = parts[parts.length - 1], prev = parts[parts.length - 2];
    if (/^(co\.?\s|county\s|dublin\s?\d)/i.test(last) || last.toLowerCase() === county.toLowerCase()) return `${prev}, ${/^dublin/i.test(last) ? last.replace(/w$/, 'W') : last.replace(/^(county|co\.?)\s*/i, 'Co. ')}`;
    return `${prev}, ${last}`;
  }
  const local = h.locality || parts.filter(p => p.toLowerCase() !== county.toLowerCase()).slice(-1)[0] || '';
  if (!county || local.toLowerCase().includes(county.toLowerCase())) return cap(local || county);
  if (!local) return cap(county);
  return `${cap(local)}, ${h.country === 'ie' && !/dublin/i.test(county) ? 'Co. ' : ''}${cap(county)}`;
}

async function saveImage(h, c) {
  const rel = `img/${c}/${TODAY}-${h.id.replace(/[^\w-]/g, '').slice(-24)}.jpg`;
  for (const u of h.images.slice(0, 3)) {
    try {
      const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
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
  if (h.country === 'uk' && (h.sqft || h.sqm)) facts.push(`${Math.round(h.sqft || h.sqm * 10.764).toLocaleString('en-GB')} sq ft`);
  // facts never show a size under 25 m² / 270 sq ft (bad data)
  if (h.beds) facts.push(`${h.beds} bed`);
  if (h.baths) facts.push(`${h.baths} bath`);
  const R = rng(h.id);
  return {
    id: h.id, img, title: titleOf(h), area: areaOf(h), facts,
    ber: /^[A-G][0-9+]?$/i.test(h.rating) ? h.rating.toUpperCase() : '', el: h.country === 'uk' ? 'EPC' : 'BER',
    ask: Math.round(h.price), mat: MATS[h.country][i % 7], door: DOORS[Math.floor(R() * DOORS.length)],
    blurb, tr, src: h.agent || (h.country === 'ie' ? 'daft.ie' : 'rightmove.co.uk'), url: h.url,
  };
}

async function doCountry(c, used) {
  let pool = (await readJSON(`data/pool-${c}.json`, [])).map(tidy).filter(h => !used.has(h.id) && (Date.parse(TODAY) - Date.parse(h.seen)) / 864e5 <= CFG.poolMaxAgeDays);
  if (FORCE || pool.length < CFG.refillWhenBelow) {
    try { await refill(c, pool, used); } catch (e) { log(`${c} refill failed: ${e.message}`); if (pool.length < CFG.rounds) throw e; }
  }
  const seven = [], avoid = new Set();
  for (const h of chooseSeven(c, pool)) {
    if (seven.length >= CFG.rounds) break;
    const img = await saveImage(h, c);
    used.add(h.id);
    if (img) seven.push(toGame(h, img, seven.length, avoid));
  }
  if (seven.length < CFG.rounds) throw new Error(`${c}: only ${seven.length} houses with photos today`);
  pool = pool.filter(h => !used.has(h.id));
  await writeJSON(`data/pool-${c}.json`, pool);
  const out = { country: c, date: TODAY, day: DAY, v: FORMAT, houses: seven };
  await writeJSON(`site/houses/${c}/latest.json`, out);
  await writeJSON(`site/houses/${c}/${TODAY}.json`, out);
  log(`${c}: game No. ${DAY} written, ${pool.length} left in pool`);
  for (const h of seven) log(`  ${h.area} · ${h.title} · ${h.ask} · ${h.tr}`);
}

async function cleanImages() {
  for (const c of ['ie', 'uk']) {
    const dir = path.join(ROOT, 'site/img', c);
    for (const f of await fs.readdir(dir).catch(() => [])) {
      const d = f.slice(0, 10);
      if ((Date.parse(TODAY) - Date.parse(d)) / 864e5 > CFG.keepImagesDays) await fs.rm(path.join(dir, f));
    }
  }
}

const used = new Set(await readJSON('data/used.json', []));
let failed = 0;
for (const c of only ? [only] : ['ie', 'uk']) {
  const already = await readJSON(`site/houses/${c}/latest.json`, null);
  if (already && already.date === TODAY && !FORCE)  // once a day's houses are out, they never change that day { log(`${c}: today's game already exists`); continue; }
  try { await doCountry(c, used); } catch (e) { failed++; console.error(`${c} FAILED: ${e.message}`); }
}
await writeJSON('data/used.json', [...used]);
await cleanImages();
if (failed) { console.error(`${failed} country/countries failed. Yesterday's houses stay live for them.`); process.exit(1); }
