// A player's recent scores, kept so a league table is one read per member.
export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });

export async function recordPlayerScore(store, id, country, date, score) {
  const p = (await store.get(`p/${id}`, { type: 'json' })) || { nick: '', s: {} };
  p.s = p.s || {};
  const s = p.s[country] = p.s[country] || {};
  if (s[date] != null) return;   // first game of the day counts, same as the game itself
  s[date] = score;
  const cut = new Date(Date.now() - 15 * 864e5).toISOString().slice(0, 10);   // two weeks is plenty
  for (const d of Object.keys(s)) if (d < cut) delete s[d];
  await store.setJSON(`p/${id}`, p);
}
