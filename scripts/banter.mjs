// Agent-speak, translated. First match in the listing text wins.
// Each rule: [pattern, real meaning]. Patterns run case-insensitive.
export const PHRASES = [
  [/deceptively spacious/, "It's small. They know it's small."],
  [/\bbijou\b/, 'You can touch both walls from the sofa.'],
  [/\bcompact\b/, 'Tiny. Measure your bed first.'],
  [/\bcos(y|ie)\b/, 'Small. Very, very small.'],
  [/in need of (some |full |complete )?(modernisation|modernization|refurbishment|renovation|updating|upgrading|tlc)|requires? (some |full )?(modernisation|modernization|refurbishment|updating|upgrading)|\btlc\b/, 'Bring a skip. Bring two.'],
  [/(huge|great|enormous|excellent|tremendous|exciting) potential/, "It's a wreck with a garden."],
  [/renovation project|refurbishment project|doer[- ]upper/, "It's a wreck. They've said so politely."],
  [/(grade (ii|2)|listed building|listed property)/, "You'll need the council's permission to change a lightbulb."],
  [/(much[- ]loved|cherished|lovingly maintained) (family )?home/, 'Nobody has touched it since 1987.'],
  [/(original|period) features/, 'Original windows. Bring a jumper.'],
  [/\bcharacter(ful)?\b|full of charm|charming/, 'Nothing in it is level.'],
  [/low[- ]maintenance (rear |back |front )?garden/, "It's concrete."],
  [/(stunning|breathtaking|panoramic|uninterrupted) (sea |mountain |coastal |countryside )?views/, 'The photo was taken from the one good window.'],
  [/rarely (available|come|comes)|rare opportunity|unique opportunity|opportunity not to be missed/, 'The last owner lasted 40 years. Ask why.'],
  [/no onward chain|chain[- ]free|vacant possession/, "They've already moved out. They want this over."],
  [/investment opportunity|ideal for investors?|investors? (will|take note)/, 'Currently tenanted. Possibly by students.'],
  [/(ideal|perfect|excellent) (for )?(first[- ]time buyers?|starter home|first home)/, 'Two bedrooms if you count the box room.'],
  [/walk[- ]in condition|turn[- ]?key|move[- ]in ready|ready to move into/, 'They painted it magnolia last week.'],
  [/(immaculate|pristine|beautifully presented|presented in excellent)/, 'Staged by someone with more cushions than you.'],
  [/(quiet|peaceful|tranquil|secluded) (cul[- ]de[- ]sac|location|setting|road|lane|position)/, "There's one bus a day. It doesn't stop here."],
  [/(idyllic|picturesque|rural|countryside) (setting|location|village|surroundings)/, "You'll need a car. And a second car."],
  [/(village|town) centre|main street|high street location/, 'Above, beside or behind a chipper.'],
  [/convenient(ly)? (located |situated )?(for|to) (the )?(local )?(amenities|shops|transport|bus|train|rail|motorway|m50|city)/, "You'll hear the traffic from bed."],
  [/(close to|minutes from|easy access to) (the )?(m50|m\d+|n\d+|motorway|dual carriageway|ring road)/, "You'll hear the motorway from bed."],
  [/(south|west)[- ]facing (rear |back )?garden/, 'The garden gets sun for one hour in June.'],
  [/open[- ]plan/, 'They knocked a wall down. Hopefully not that one.'],
  [/(attic|loft) conversion|converted (attic|loft)/, 'Mind your head. Always mind your head.'],
  [/\bcottage\b/, 'Mind your head on the beams.'],
  [/architect[- ]designed|contemporary (home|design|residence)|floor[- ]to[- ]ceiling/, 'Floor-to-ceiling windows. Floor-to-ceiling heating bills.'],
  [/\bbungalow\b/, "It's all on one level. That's the whole pitch."],
  [/(online )?auction|\bamv\b|guide price|offers (in excess of|over)/, 'The guide price is a suggestion. A low one.'],
  [/new[- ]build|newly built|a[- ]?rated|nzeb/, 'The walls are thinner than the brochure.'],
  [/mid[- ]terrace|terraced (house|home)/, "You'll know your neighbours' TV schedule."],
  [/popular (residential )?(area|estate|development|location)|much sought|sought[- ]after/, "You're paying for the address, not the house."],
  [/well[- ]proportioned/, "The rooms are fine. That's the best they could do."],
  [/(spacious|generous|extensive) (family )?(accommodation|living space|home)/, 'Big. Heating it is your problem.'],
  [/extended|extension/, 'The extension is where the heat goes to die.'],
  [/(viewing|viewings) (is |are )?(highly )?(recommended|advised|essential)/, "The photos aren't doing it any favours."],
  [/(cul[- ]de[- ]sac)/, 'Every child on the road will be in your garden.'],
  [/(coastal|seaside|beside the sea|sea views?)/, "Everything you own will rust. But the view."],
];

const GENERIC = [
  'Every photo was taken with a wide-angle lens.',
  "The best room is the one they didn't photograph.",
  'The agent said "bright" three times in one paragraph.',
  'The neighbours are lovely. The neighbours wrote this.',
  'Great storage, as long as you own nothing.',
  'Recently decorated, as in last Tuesday.',
];

function hash(str) { let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }

// Returns { blurb, tr }: blurb is the agent's own sentence, tr the translation.
export function banter({ id, text, rating, price, beds, country }) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  const PRICEY = /[€£$]\s?\d|\d{1,3},\d{3}|\b\d+(\.\d+)?\s?(k|m|million)\b|asking|guide|offers (in excess|over)|price/i;
  const sentences = clean.split(/(?<=[.!?])\s+|\s*\n+\s*/).map(s => s.trim())
    .filter(s => s.length > 25 && s.length < 260 && !PRICEY.test(s) && s !== s.toUpperCase());
  for (const [re, tr] of PHRASES) {
    const rx = new RegExp(re.source, 'i');
    const hit = sentences.find(s => rx.test(s));
    if (hit) return { blurb: trim(hit), tr };
  }
  const blurb = sentences[0] ? trim(sentences[0]) : '';
  const r = (rating || '').toUpperCase();
  if (r.startsWith('G') || r.startsWith('F')) return { blurb, tr: 'Heating bills like a second mortgage.' };
  if (r.startsWith('A')) return { blurb, tr: "So airtight you'll need to open a window to sneeze." };
  if (price && price < 180000) return { blurb, tr: "There's a reason it's this cheap. Find it." };
  if (price && price > 1500000) return { blurb, tr: 'The stamp duty alone would buy a nice car.' };
  if (beds && beds >= 5) return { blurb, tr: 'Five bedrooms. Four of them are for boxes.' };
  return { blurb, tr: GENERIC[hash(String(id)) % GENERIC.length] };
}

function trim(s) {
  s = s.replace(/^[^A-Za-z0-9"']+/, '');
  if (s.length <= 150) return s;
  const cut = s.slice(0, 147);
  return cut.slice(0, cut.lastIndexOf(' ')) + '…';
}
