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
  // Bake raking light into each photo: colour x ambient occlusion x (light from the top left, from the normal map).
  // That gives the mortar its recess and render its grain, without any 3D in the browser.
  const raw = async (buf, w, h) => sharp(buf).resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  for (const p of pick) {
    const files = await get(`https://api.polyhaven.com/files/${p.id}`);
    const url = k => { const m = files[k]; if (!m) return null; const r = m[p.res || '2k'] || m['2k'] || m['1k']; return r && (r.jpg || r.png) ? (r.jpg || r.png).url : null; };
    const dif = await get(url('Diffuse'), 'buf');
    const meta = await sharp(dif).metadata(), W = Math.min(p.width || 2048, meta.width), H = Math.round(meta.height * W / meta.width);
    const d = await raw(dif, W, H);
    const aoU = url('AO'), nU = url('nor_gl');
    const ao = aoU ? await sharp(await get(aoU, 'buf')).resize(W, H, { fit: 'fill' }).greyscale().raw().toBuffer() : null;
    const nm = nU ? await raw(await get(nU, 'buf'), W, H) : null;
    const L = p.light || [-0.55, 0.55, 0.63], ll = Math.hypot(...L), lx = L[0] / ll, ly = L[1] / ll, lz = L[2] / ll;
    const out = Buffer.alloc(W * H * 3), k = p.relief ?? 0.6, a = p.ao ?? 0.85;
    for (let i = 0, j = 0; i < W * H; i++, j += 3) {
      let f = 1;
      if (ao) f *= 1 - a * (1 - ao[i] / 255);
      if (nm) { const nx = nm[j] / 127.5 - 1, ny = nm[j + 1] / 127.5 - 1, nz = nm[j + 2] / 127.5 - 1; const dot = Math.max(0, nx * lx + ny * ly + nz * lz); f *= (1 - k) + k * dot / lz; }
      for (let c = 0; c < 3; c++) out[j + c] = Math.max(0, Math.min(255, Math.round(d[j + c] * f)));
    }
    let img = sharp(out, { raw: { width: W, height: H, channels: 3 } });
    if (p.rotate) img = sharp(await img.rotate(p.rotate).png().toBuffer());
    if (p.grey) img = img.greyscale().linear(p.grey[0], p.grey[1]);
    await img.webp({ quality: p.q || 80 }).toFile(`${SITE}/${p.as}.webp`);
    console.log('saved', p.as, 'from', p.id, `${W}x${H}`, ao ? '+AO' : '', nm ? '+normal' : '');
  }
}
