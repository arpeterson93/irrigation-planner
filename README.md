# Sprinkler Simulator

A small, free, self-hosted tool for mapping a yard's sprinkler heads, modeling
water coverage per square foot, and calculating a daily seasonal watering
adjustment from live NWS rainfall/ET forecasts. Built for personal use and
shared with a handful of people, not a commercial product.

See `PLAN.md` for the full architecture reasoning, data model, and phased
build plan this repo is being developed against.

## Current status

This repo currently holds the Phase 0 scaffold:

- `legacy/sprinkler-simulator.html` is the original, working single-file
  prototype, kept verbatim for reference.
- `docs/index.html` is presently an exact copy of the legacy file, so the
  site is live and functional the moment GitHub Pages is turned on.
- `tests/` has a pytest suite that pins the coverage-math, forecast/ET0-math,
  and schedule-math formulas to golden values that were cross-checked against
  the original Google Sheet this project started as.

Everything else in the folder structure (`docs/js/*`, `apps-script/`,
`scripts/`, `schema/`) is scaffolding for the work described in `PLAN.md` and
is not yet implemented.

## Running it locally

No build step, no dependencies. From the repo root:

```bash
cd docs
python3 -m http.server 8000
```

Then open `http://localhost:8000` in a browser.

## Running the tests

```bash
pip install -r scripts/requirements.txt   # currently just pytest
pytest tests/ -v
```

CI runs this same suite on every push (see `.github/workflows/ci.yml`).

## Deploying (GitHub Pages)

1. Push this repo to GitHub as a **public** repository (required for free
   GitHub Pages; see `PLAN.md` section 6.8 if you'd rather keep it private
   via Cloudflare Pages instead).
2. In the repo on GitHub: **Settings -> Pages -> Build and deployment ->
   Deploy from a branch**, then choose branch `main`, folder `/docs`, and
   save.
3. GitHub will publish it at `https://<your-username>.github.io/<repo-name>/`
   within a minute or two. No custom domain, no billing account, no
   additional service needed.
4. Every subsequent push to `main` that touches `docs/` redeploys
   automatically.

## Cloud sync (optional, not yet built)

Phase 5 of `PLAN.md` adds an optional sync layer on top of a Google Apps
Script web app and a single Google Sheet, so a handful of people can each
save their own yard configuration and reload it on another device. Until
that's built, the app is fully usable with just browser-local storage plus
manual JSON export/import (buttons in the header). Setup instructions for
the sync layer will live in `apps-script/DEPLOY.md` once Phase 5 lands.

## Data and privacy

Everything you enter stays in your browser's local storage unless you
explicitly export it or (once built) turn on cloud sync. The app calls two
free, keyless public APIs when you fetch a forecast: `api.weather.gov`
(rainfall/temperature forecast) and nothing else. No account, no tracking,
no ads.
