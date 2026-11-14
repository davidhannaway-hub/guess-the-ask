// Server-side "game_scored" events, so PostHog can see the same player come back on another day.
// The browser's PostHog runs in memory only (no cookie banner), so it gives every visit a fresh ID.
// Every finished game already reaches /api/scores with the device's player id; PostHog gets a
// one-way hash of it, never the id itself, and no person profile is created.
import { createHash } from 'node:crypto';

const KEY = 'phc_t2MgYXthAfUMNUy4VCZpE3dsirqakkio6ic4V7ykUuia';   // public project key, same as the site
const HOST = 'https://eu.i.posthog.com';

const anon = id => 'p_' + createHash('sha256').update('gta:' + id).digest('hex').slice(0, 24);

// Same game -> same uuid, so a replayed event is dropped by PostHog rather than counted twice.
const uuid = k => { const h = createHash('sha256').update(k).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

const scored = (id, country, date, score, timestamp) => ({
  event: 'game_scored',
  uuid: uuid(`${country}/${date}/${id}`),
  distinct_id: anon(id),
  timestamp,
  properties: { country, game_date: date, score, $process_person_profile: false },
});

async function send(batch, historical = false) {
  for (let i = 0; i < batch.length; i += 500) {
    await fetch(`${HOST}/batch/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: KEY, historical_migration: historical, batch: batch.slice(i, i + 500) }),
    });
  }
}

export const sendScored = (id, country, date, score) =>
  send([scored(id, country, date, score, new Date().toISOString())]).catch(() => {});

// One-off: replay every game already stored, so retention has history from day one.
// Runs once (a rare double run is harmless: the uuids match, so PostHog drops the repeats).
export async function backfillOnce(scoresStore, metaStore) {
  try {
    if (await metaStore.get('backfill-game-scored-v1')) return;
    await metaStore.set('backfill-game-scored-v1', new Date().toISOString());
    const { blobs } = await scoresStore.list();
    const batch = [];
    for (const { key } of blobs) {
      const [country, date, rest] = key.split('/');
      const dash = (rest || '').indexOf('-');
      if (!date || dash < 1) continue;
      const score = Number(rest.slice(0, dash)), id = rest.slice(dash + 1);
      if (!(score >= 0 && score <= 700) || !id) continue;
      batch.push(scored(id, country, date, score, `${date}T12:00:00Z`));
    }
    await send(batch, true);
  } catch {}
}
