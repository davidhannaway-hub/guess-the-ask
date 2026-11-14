// One-off: gather public-domain (CC0) photo textures for the walls.
// No data/tex-pick.json yet -> make contact sheets of candidates. With it -> download the picks.
import fs from 'node:fs/promises';
import sharp from 'sharp';
const OUT = 'data/tex', SITE = 'site/tex';
await fs.mkdir(OUT, { recursive: true }); await fs.mkdir(SITE, { recursive: true });
const get = async (u, t = 'json') => { const r = await fetch(u, { headers: { 'user-agent': 'guesstheask-texture-fetch' } }); if (!r.ok) throw new Error(`${r.status} ${u}`); return t === 'json' ? r.json() : Buffer.from(await r.arrayBuffer()); };
const pick = await fs.readFile('data/tex-pick.json', 'utf8').then(JSON.parse).catch(() => null);

if (!pick) {
  const cats = await get('https://api.polyhaven.com/categories/textures');
  await fs.writeFile(`${OUT}/ph-categories.json`, JSON.stringify(cats, null, 1));
  const want = Object.keys(cats).filter(c => /brick|wall|plaster|concrete|wood|facade|stone|siding|paint/i.test(c));
  const seen = new Map();
  for (const c of want) { const a = await get(`https://api.polyhaven.com/assets?t=textures&c=${encodeURIComponent(c)}`); for (const [id, v] of Object.entries(a)) if (!seen.has(id)) seen.set(id, { id, name: v.name, cats: v.categories, tags: v.tags }); }
  const list = [...seen.values()].filter(x => /brick|plaster|stucco|render|pebble|dash|siding|clapboard|plank|painted|facade|weatherboard|stone_wall|wall/i.test(x.id + ' ' + (x.tags || []).join(' ')));
  await fs.writeFile(`${OUT}/ph-list.json`, JSON.stringify(list, null, 1));
  console.log(`${list.length} Poly Haven candidates`);
  // contact sheets, 24 per sheet, labelled with the asset id
  const T = 240;
  for (let s = 0; s * 24 < list.length; s++) {
    const tiles = [];
    for (const [k, x] of list.slice(s * 24, s * 24 + 24).entries()) {
      try {
        const img = await sharp(await get(`https://cdn.polyhaven.com/asset_img/thumbs/${x.id}.png?width=${T}&height=${T}`, 'buf')).resize(T, T).png().toBuffer();
        const label = Buffer.from(`<svg width="${T}" height="22"><rect width="100%" height="100%" fill="#000"/><text x="4" y="16" font-size="13" font-family="sans-serif" fill="#fff">${(s * 24 + k)}: ${x.id.slice(0, 30)}</text></svg>`);
        tiles.push({ input: img, left: (k % 6) * T, top: Math.floor(k / 6) * (T + 22) }, { input: label, left: (k % 6) * T, top: Math.floor(k / 6) * (T + 22) + T });
      } catch (e) { console.log('thumb failed', x.id, e.message); }
    }
    await sharp({ create: { width: 6 * T, height: 4 * (T + 22), channels: 3, background: '#222' } }).composite(tiles).jpeg({ quality: 80 }).toFile(`${OUT}/sheet-${s}.jpg`);
  }
} else {
  for (const p of pick) {
    const files = await get(`https://api.polyhaven.com/files/${p.id}`);
    const map = files.Diffuse || files.diffuse || files.diff || files.Color;
    const res = map[p.res || '2k'] || map['2k'];
    const url = (res.jpg || res.png).url;
    const buf = await get(url, 'buf');
    await sharp(buf).resize({ width: p.width || 2048, withoutEnlargement: true }).webp({ quality: 82 }).toFile(`${SITE}/${p.as}.webp`);
    console.log('saved', p.as, 'from', p.id, url);
  }
}
