# Guess the Ask

Daily house price guessing game. Ireland and UK.

- `site/` is what Netlify publishes. `site/index.html` is the game.
- Every night `.github/workflows/daily.yml` runs `scripts/daily.mjs`, which tops up a pool of real listings from Apify when it runs low, picks 7 Irish and 7 UK houses, saves one photo each, and writes `site/houses/<ie|uk>/latest.json`. The commit makes Netlify redeploy.
- To run it by hand: Actions → Daily houses → Run workflow.
- Scrapers and search areas: `scripts/config.json`. Agent-speak translations: `scripts/banter.mjs`.
- Needs the repository secret `APIFY_TOKEN`.
