// Floor area from a listing's own description, for listings whose size box is empty.
// Picks the biggest plausible whole-house figure ("approx 1,250 sq ft", "102 sq m"), skipping rooms,
// gardens, plots, garages and outbuildings, and anything too small for the number of bedrooms.
const NUM = String.raw`(\d{1,2},\d{3}|\d{2,5}(?:\.\d+)?)`;
const UNIT = String.raw`(sq\.?\s*f(?:ee)?t\.?|sq\.?\s*ft|sqft|ft²|ft2|square\s+f(?:ee|oo)t|sq\.?\s*m(?:etres?|eters?)?\.?|sqm|m²|m2|square\s+met(?:re|er)s?)`;
const RX = new RegExp(String.raw`(?:approx(?:imately|\.)?\s*)?${NUM}\s*${UNIT}(?![a-z])`, 'gi');
const NOT_HOUSE = /\b(garden|plot|grounds|land|acres?|garage|workshop|outbuildings?|barn|annexe?|office|studio|cabin|shed|summer ?house|patio|roof terrace|decking|balcony|commercial|retail|warehouse)\W+(\w+\W+){0,3}$/i;
export function sizeFromText(text, beds) {
  const t = String(text || '');
  let best = null;
  for (const m of t.matchAll(RX)) {
    const v = Number(m[1].replace(/,/g, '')), metric = /m/i.test(m[2].replace(/^sq\.?\s*f/i, '')) && !/f/i.test(m[2]);
    const sqft = metric ? v * 10.764 : v;
    if (sqft < 400 || sqft > 8000) continue;
    const before = t.slice(Math.max(0, m.index - 40), m.index);
    if (NOT_HOUSE.test(before)) continue;
    if (/^\W*(\(.{0,20}\)\W*)?(of\s+)?(\w+\s+){0,2}(garden|plot|grounds|land|garage|workshop|outbuilding|barn|annexe?|office|studio|cabin|shed|summer ?house|patio|decking|balcony|commercial|retail|warehouse)/i.test(t.slice(m.index + m[0].length, m.index + m[0].length + 45))) continue;
    if (/\d\s*(m|ft|'|"|metres?)?\s*[x×]\s*\d[\d.]*\s*(m|ft|'|"|metres?)?\s*\(?$/i.test(before)) continue;   // a room's dimensions ("11.26m x 3.37m 409 sq ft")
    if (beds && sqft < 200 + 180 * beds) continue;   // too small for the house: a room or one floor
    if (!best || sqft > best) best = sqft;
  }
  return best ? Math.round(best) : null;
}
