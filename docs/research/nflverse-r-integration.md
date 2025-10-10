# Leveraging nflverse R packages for direct data ingestion

## Why consider R-native loaders?
- The nflverse ecosystem already curates nightly-updated play-by-play, player, team, roster, and auxiliary data with consistent schemas, so mirroring their pipelines via `nflreadr` lets us pull the same canonical tables we currently mirror through GitHub releases without maintaining bespoke fetchers.
- Packages such as `nflfastR` and `nflseedR` layer advanced modeling primitives (EPA/WP models, Monte Carlo seeding simulations, etc.) on top of those datasets, giving us feature engineering "for free" instead of rebuilding them in Node.js.
- R has first-class support for exporting tidy data to parquet/qs/CSV, which means we can schedule one R step to populate our `/artifacts` cache for JavaScript/Python consumers.

## Package capabilities snapshot

### `nflfastR`
- Supplies play-by-play data back to 1999 with drive/series metadata and hosted nightly releases for quick access.
- Bundles production models for expected points, win probability (spread-aware and neutral), completion probability (CPOE), and yards-after-catch (XYAC), exposing feature columns directly in the pbp tables.
- Includes `update_db()` to maintain a local play-by-play database we can sync into our data lake if we prefer SQL over flat files.

### `nflreadr`
- Minimal downloader with caching, progress hooks, and consistent `load_*` helpers (e.g., `load_pbp`, `load_player_stats`, `load_rosters`) across nflverse datasets.
- Sources data directly from the reorganized `nflverse-data` repository and supports configurable storage formats (`qs`, `rds`, `parquet`, `csv`) plus in-memory or filesystem caches.

### `nflseedR`
- Runs Monte Carlo season simulations that honor NFL tie-breakers, playoff seeding, and draft order rules so we only supply team strength priors per matchup.
- Can resume from the current league state (completed games pre-populated) to produce futures probabilities for marketing content or betting features.

### `nfl4th`
- Powers the public 4th-down decision calculator and Twitter bot, encapsulating go-for-it, punt, and field-goal models that incorporate defensive penalties, block/return probabilities, and roof adjustments.
- Gives us validated baselines for situational decision features without rebuilding them in-house; limitations are documented (e.g., turnover returns omitted, player-specific nuances ignored).

### `nflplotR`
- Adds `ggplot2` geoms and helper functions for logo overlays and high-quality NFL visuals, smoothing the path to automated report generation for bettors or social content.

## Proposed integration blueprint

1. **Create an R ingestion module.**
   - Structure a `scripts/r/` folder with standalone R scripts (e.g., `fetch_pbp.R`, `fetch_player_weekly.R`) that call `nflreadr::load_*` functions for requested seasons/weeks.
   - Each script writes `parquet` (preferred for compression + schema) into `artifacts/r-data/<dataset>/<season>.parquet`, mirroring our existing cache naming.
   - Parameterize seasons/weeks via CLI args so our Node trainers can shell out once per context build.

2. **Schedule ingestion alongside JS loaders.**
   - Extend `trainer/dataSources.js` to detect when an R artifact exists; if not, run `Rscript scripts/r/fetch_<dataset>.R --season 2024` before falling back to HTTP mirrors.
   - Cache manifest metadata (e.g., available seasons) by invoking `nflreadr::qs_release_urls()` or `nflreadr::nflverse_download()` to avoid redundant downloads.

3. **Adopt nflverse feature columns.**
   - Modify feature builders to consume `nflfastR` columns such as `epa`, `wp`, `cpoe`, `xyac_epa`, and drive/series IDs directly from the R-generated parquet files.
  - Integrate `nfl4th::load_4th_pbp()` outputs into situational models (e.g., classification label for whether the recommended decision matched actual play call).

4. **Layer season simulations.**
   - Export weekly team strength distributions from our existing model, feed them to an `nflseedR` script that runs, say, 20,000 simulations per week, and persist probability summaries (`make_playoffs`, `win_division`, `top_seed`, `draft_pick`).
   - Use these outputs as priors for marketing dashboards or as extra training features representing rest-of-season expectations.

5. **Visualization pipeline.**
   - For generated reports, call `nflplotR` geoms within RMarkdown/Quarto templates that pull from our `artifacts` parquet cache, producing PNG/SVG assets consumed by the web front-end.

## Implementation considerations

- **Environment setup:** add a `renv` or `pak` lockfile plus `scripts/setup-r.sh` to install `nflreadr`, `nflfastR`, `nflseedR`, `nfl4th`, and `nflplotR` on CI runners; mirror on local dev via Docker layer.
- **Cross-language handoff:** agree on parquet schemas (e.g., `integer64` -> string) to keep Node.js parsing simple; prefer `arrow` writes with explicit schema casts.
- **Versioning:** pin package versions via `renv.lock` and expose them in our context metadata so training runs are reproducible.
- **Fallback strategy:** retain existing HTTP loaders as a safety net; R scripts should exit non-zero on failure so the JS layer can transparently fall back to GitHub CSVs.
- **Testing:** add snapshot tests for R scripts (e.g., compare row counts vs. known seasons) and integration tests that ensure Node features parse expected columns.
- **Tooling footprint:** we can host all R scripts, lockfiles, and generated artifacts in GitHub without extra purchases. GitHub Actions' Ubuntu runners ship with R pre-installed, so adding a workflow step that restores the `renv` cache and runs our ingestion scripts should work out-of-the-box. Only if we need faster builds or GPU support would a paid runner or custom Docker registry become necessary; for pure R-based ingestion the open-source quota plus GitHub's built-in package cache (or `actions/cache`) is sufficient.

## Deployment & cost outlook

- **GitHub-only path:** keep sources, workflows, and cached parquet outputs inside the repository (or GitHub Releases) and rely on Actions + `actions/cache`/Artifacts. This covers CI/CD, scheduled refreshes, and artifact distribution with no added SaaS spend beyond existing GitHub plans.
- **Optional Docker image:** if we later want reproducible local environments, we can publish an OCI image from our repo (built via Actions) to GitHub Container Registry, which is included with GitHub accounts. There is no separate "Docker layer" purchase required—storage and bandwidth stay within GitHub quotas. Paid Docker Hub plans are only needed if we demand public Hub hosting or higher transfer limits than GitHub provides.
- **When to budget extra:** external costs would arise only if we outgrow GitHub-hosted runners (e.g., need on-demand spot instances, GPUs, or >72h workflows) or require premium storage/CDN for large historical parquet archives. For the current scope, GitHub infrastructure should suffice.

## Next steps

1. Prototype `nflreadr` ingestion for play-by-play (single season) and benchmark download time vs. current GitHub mirror.
2. Evaluate storage footprint + conversion speed of `arrow::write_parquet` vs. zipped CSV in our pipeline.
3. Draft `nfl4th` feature extraction script and map resulting probabilities to our model inputs.
4. Scope weekly automation (GitHub Actions job or cron) to refresh R-derived artifacts and publish dashboards with `nflplotR` visuals.
