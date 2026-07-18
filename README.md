# Sprinkler Simulator

A small, free, self-hosted tool for mapping a yard's sprinkler heads, modeling
water coverage per square foot, and turning a live NWS forecast into a day-by-day
seasonal watering adjustment. Built for personal use and shared with a handful of
people, not a commercial product.

No build step, no framework, no accounts required to use it: it is a static page
of plain ES modules. `PLAN.md` holds the full architecture reasoning, data model,
and the phased build plan this repo was developed against.

## What it does

- **Yard & Heads**: set your yard dimensions, place sprinkler heads (position,
  radius, arc, GPM, plus audit fields like brand/model/nozzle and a
  needs-replacement flag), and drag them around on a preview. Up to 12 valve
  zones. Optionally trace **yard zones** and **dead spaces** (house, patio, beds)
  as polygons, and drop a **satellite screenshot** underneath as a tracing guide.
- **Coverage Map**: a heatmap of applied water depth, per-zone and per-yard-zone
  rollups (dead space excluded), effective-GPM scaling when a zone's supply can't
  feed all its heads, head-type sanity warnings, and a water-usage estimate in
  gallons per week/month.
- **Forecast Adjustment**: pulls a 7-day forecast from the National Weather
  Service, estimates daily ET0 (Hargreaves-Samani), and shows a day-by-day
  suggested run-time adjustment per zone, only on that zone's scheduled watering
  days.

## Running it locally

No dependencies for the app itself. From the repo root:

```bash
cd docs
python3 -m http.server 8000
```

Then open <http://localhost:8000>. (Open it through a server, not as a `file://`
URL: ES modules won't load over `file://`.)

## Deploying (GitHub Pages)

1. Push this repo to GitHub as a **public** repository (required for free
   GitHub Pages; see `PLAN.md` 6.8 for the private-repo Cloudflare Pages option).
2. **Settings -> Pages -> Build and deployment -> Deploy from a branch**, then
   choose branch `main`, folder `/docs`, and save.
3. It publishes at `https://<user>.github.io/<repo>/` within a minute or two.
   Every push to `main` that touches `docs/` redeploys automatically. No workflow
   file is needed for the site itself; `.github/workflows/ci.yml` only runs tests.

## Capturing and calibrating a satellite screenshot

The app never calls a maps API. You supply the image:

1. Open your lot in Google Maps / Google Earth / your county GIS viewer and take
   a screenshot. Try to include the on-screen scale bar.
2. In the app, on the **Yard & Heads** tab under **Background reference image**,
   click **Upload image**. It is downscaled and compressed locally (kept on your
   device only, never uploaded).
3. Click **Calibrate scale**, then click two points whose real distance you know
   (a fence line, a driveway width, or the endpoints of the map's scale bar).
   Enter that distance in feet. The image is scaled so the app's grid matches
   real-world feet.
4. Use **Move image** and the opacity/rotation controls to line it up, then trace
   your heads and areas on top. Adjust opacity so both the image and your wedges
   are visible.

## Cloud sync (optional)

The app is fully usable with just browser-local storage plus JSON export/import
(buttons in the header). If you want a few people to save configs to the cloud and
reload them on another device, there is an optional sync layer built on a Google
Apps Script web app backed by one Google Sheet. It is free, needs no payment
method, and does not pause when idle.

- Backend + step-by-step deploy: `apps-script/Code.gs` and `apps-script/DEPLOY.md`.
- In the app: header **Sync** button -> paste the `/exec` URL and your key ->
  **Save to cloud** / **Load from cloud**, with an optional auto-load on open.
- The satellite **background image is never synced** (Sheet cells cap at 50k
  characters). Calibration numbers do sync, so re-attaching the same screenshot on
  another device restores alignment.

## Data and privacy

- Everything you enter stays in your browser's `localStorage` unless you export it
  or turn on cloud sync.
- The only network calls the app makes on its own are two anonymous, keyless
  requests to `api.weather.gov` when you fetch a forecast.
- With sync enabled, your config (geometry, zones, settings; **not** the
  background image) is sent to the Google Sheet you or the sheet owner controls.
  Access is by a per-user random key. This is security-by-obscurity and is
  intentionally accepted for this small, non-sensitive use.

## Repository layout

```
docs/            the deployed static app (index.html + css/ + js/ ES modules)
apps-script/     optional Google Apps Script sync backend + deploy guide
scripts/         Python migration + JSON-Schema validation tooling (not shipped)
schema/          JSON Schema for the v2 config format
tests/           pytest golden tests (coverage/forecast/schedule math + migration)
legacy/          the original single-file prototype, kept verbatim for reference
PLAN.md          architecture + phased build specification
```

## Development notes

- The math in `docs/js/coverage.js`, `forecast.js`, and `schedule.js` is
  intentionally mirrored by Python in `tests/`, which pins it to golden values
  (cross-checked against the original spreadsheet) and to the agreed schedule/
  migration specs. If you change a formula on one side, change the other and
  re-run `pytest`.
- Config format is **schema v2**; older v1 configs auto-migrate on load
  (coordinate-origin flip, field renames, schedule derivation). See `PLAN.md`
  section 3 and `scripts/migrate_v1_config.py`.
- CI (`.github/workflows/ci.yml`) runs the pytest suite and greps `docs/` to keep
  em dashes out of shipped copy.

## Running the tests

```bash
pip install -r scripts/requirements.txt
pytest tests/ -v
```
