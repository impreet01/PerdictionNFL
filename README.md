# NFL Win Predictor (Free Stack)

Train and serve **logistic**, **decision-tree**, and **hybrid** NFL win probabilities using free **nflverse** data, with zero Python.
- Weekly auto-train via **GitHub Actions**
- Free HTTPS endpoint via **Cloudflare Workers**
- Plug into a **Custom GPT Action** using `openapi.yaml`

## Quick Start
1) Create a new GitHub repo and upload this folder (keep structure).
2) Turn on **Actions**.
3) (Optional) Edit `/.github/workflows/train.yml` environment vars `SEASON` and `WEEK`.
4) Run the workflow (Actions → *Train weekly* → *Run workflow*). It writes JSON to `/artifacts`.
5) Deploy `api/worker.js` on **Cloudflare Workers**. Edit `REPO_RAW` inside it to your repo's raw URL.
6) Add `openapi.yaml` as a **Custom GPT Action** endpoint.

## Files
- `trainer/dataSources.js` — downloads nflverse team weekly stats + schedules
- `trainer/featureBuild.js` — builds **season-to-date (S2D)** pre-game features (paper-faithful)
- `trainer/train.js` — trains Logistic + Tree, blends Hybrid, emits JSON + English
- `api/worker.js` — Cloudflare Worker serving `/predict_week`
- `openapi.yaml` — Action schema for ChatGPT
- `.github/workflows/train.yml` — weekly cron

## Notes
- After first run, open an `artifacts/predictions_YYYY_WWW.json` to verify outputs.
- If a column name mismatch occurs (nflverse schema drift), adjust the `map` object in `trainer/featureBuild.js`.

## Offline-friendly schedules
- `trainer/dataSources.loadSchedules` now checks multiple sources in order: a local override (`NFLVERSE_SCHEDULES_FILE` or `./data/games.csv`), a cached copy (`NFLVERSE_SCHEDULES_CACHE` or `artifacts/cache/games.csv`), the main GitHub raw file, and finally a CDN mirror.
- Successful remote downloads are saved to the cache path so that subsequent runs can stay offline.
- `npm run train:multi` and helper scripts accept `--cache=/path/to/games.csv` (and `--local=...`) to exercise the offline branch. For example:
  ```bash
  NO_PROXY=localhost npm run train:multi -- --cache=artifacts/cache/games.csv
  node trainer/tests/smoke.js
  ```
