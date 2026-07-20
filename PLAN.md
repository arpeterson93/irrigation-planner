# Sprinkler Simulator: Implementation Plan for Opus

**Prepared:** July 17, 2026
**Purpose:** This document is the build specification. Opus should execute the phases in order, stopping at every point marked **STOP / CONFIRM WITH ALEX** before proceeding.

**Source review status:** The current `sprinkler-simulator.html` (1,113 lines, ~51 KB) was reviewed during planning. The description it was planned from proved accurate; the schema, migration steps, and section 7 below are grounded in the actual code, including exact v1 field names. The real file lives in `legacy/sprinkler-simulator.html` in this repo.

---

## 1. Architecture Recommendations

### 1.1 Hosting: GitHub Pages (recommended), Cloudflare Pages as fallback

**Recommendation: GitHub Pages**, deploying straight from the same repo the project is migrating into.

Reasoning, verified against current (mid-2026) conditions:

- GitHub Pages and Cloudflare Pages are both genuinely free with no credit card, no expiring credits, and no trial mechanics. Netlify moved to a credit-based billing system (300 credits/month free, sites pause when exhausted), and Vercel's Hobby tier is fine but adds nothing for this project and carries a non-commercial restriction plus per-seat pricing pressure if it ever grows.
- The project is already committed to living in a GitHub repo. GitHub Pages means zero additional accounts, zero additional services, and deploys on every push to `main` (or via a one-line Actions workflow). For a static app shared with 5 people, bandwidth and build limits are irrelevant.
- GitHub Pages' known limitations do not apply here: it is static-only (this app is static), free public-repo hosting requires the repo be public (acceptable for a hobby tool; see risk 6.8 if Alex wants it private), and it prohibits commercial use (this is not commercial).
- The app calls `api.weather.gov` client-side. NWS supports CORS from browser clients, so no proxy is needed and static hosting remains sufficient.

**Fallback:** Cloudflare Pages. Choose it instead only if Alex later wants preview deployments per branch or the repo must be private without paying for GitHub Pro. It is equally free (unlimited bandwidth, no card) but adds one more account/service.

**What Python is for, given static hosting:** Python is deliberately NOT in the runtime path. The deployed app is a static JS frontend. Python's role is:

1. One-time migration scripts (converting the original Google Sheet export and the v1 localStorage/JSON format into the new schema).
2. A test suite (`pytest`) that re-implements the coverage and forecast math and asserts it against golden values from the original spreadsheet, so refactors can't silently break the math.
3. JSON Schema validation tooling for config files.
4. Local dev convenience (`python -m http.server` or a tiny dev script).

Do not introduce a Python backend or a build step. Plain ES modules served as-is keep the "open the repo, push, it deploys" property.

### 1.2 Persistence: Google Apps Script + Google Sheet sync layer, with localStorage + JSON export/import retained as the permanent fallback

**Recommendation:** Keep localStorage autosave and manual JSON export/import exactly as they are (they become the guaranteed-working offline path), and add an optional, thin cloud-sync layer built on a Google Apps Script web app backed by a single Google Sheet.

How the options compared:

**Supabase: rejected.** The decisive problem is the free-tier inactivity pause: free projects are automatically paused after 7 days without database activity and stay offline until someone manually resumes them from the dashboard. A sprinkler app is inherently seasonal and sporadically used, it will sit idle for a week constantly, and for entire winters. The standard workarounds are keep-alive pings via cron/GitHub Actions/uptime monitors, which is exactly the kind of babysitting infrastructure this project should not acquire. Combined with Alex's stated preference not to default back to Supabase, it's out. (For the record, the rest of the free tier is fine: 500 MB database, 2 projects, no card required.)

**Firebase Firestore (Spark plan): viable but not chosen.** Spark requires no payment method and Firestore's free daily quotas (1 GiB storage, 50K reads/day, 20K writes/day) dwarf this project's needs, and Spark projects do not pause. Two things push it to second place: (a) it drags in the Firebase console, SDK, anonymous auth, and security-rules design, real surface area for a 5-user config store; (b) Firebase's free tier has a volatile recent history (Cloud Storage was removed from Spark in February 2026 and now requires the card-on-file Blaze plan), which makes it a shakier long-term bet for a "set it and forget it" hobby tool.

**Google Apps Script + Sheet: chosen.** It is free with no card on any consumer Google account, has no pausing behavior, and its quotas (e.g. 20,000 URL-fetch calls/day, generous web-app execution limits) are absurd overkill for 5 users saving a config a few times a week. Alex is already fluent in Sheets and Apps Script, which neutralizes the platform's main cost (its quirks). The Sheet doubles as a human-readable admin view of everyone's saved configs. The known quirks and how to handle them:

- Apps Script web apps don't handle CORS preflight. The client must POST with `Content-Type: text/plain` (body is still a JSON string) and use simple GETs, which avoids preflight entirely.
- Requests return a 302 redirect; `fetch` follows it by default. Do not set custom headers.
- Redeployment requires creating a new version or using a stable `/exec` head deployment. Document the deploy procedure in the repo README.
- Latency is 1-3 seconds per call. Acceptable: sync is explicit/save-triggered, not per-keystroke.

**Design (keep it this simple):**

- One Sheet, one tab, one row per user: `key | config_json | updated_at_iso | note`.
- Each of the 5 users gets a random passphrase/key (generated once, e.g. `blue-otter-4821`) that Alex hands out. The key is stored in the user's localStorage after first entry. This is security-by-obscurity and that is fine for this threat model; the plan explicitly accepts it. No PII goes in configs beyond what a yard layout implies.
- `GET ?key=X` returns `{config, updatedAt}` or 404-equivalent JSON. `POST {key, config, baseUpdatedAt}` writes and returns the new `updatedAt`. If `baseUpdatedAt` doesn't match the stored row, return a conflict response and let the client prompt: "Cloud copy is newer, overwrite, or load it instead?" Last-write-wins after that prompt. Do not build merge logic.
- The app must remain 100% functional with sync disabled/unconfigured.
- One important carve-out: the satellite background image is NOT synced through the Sheet by default (a Sheet cell caps at 50,000 characters; a base64 image blows through that). Sync geometry and settings only; the background image stays per-device, re-uploadable, with the calibration numbers synced so re-attaching an image is easy. See section 3 data model.

**Documented fallback:** if Apps Script ever becomes annoying (deployment friction, quota policy change), the fallback is "localStorage + JSON export/import only," which the app already fully supports because sync is an optional layer. Firestore Spark is the documented second-choice cloud option if a rebuild is ever wanted.

### 1.3 Address / satellite lookup: user-supplied screenshot + two-point scale calibration (default); Google Maps API as opt-in stretch only

**Confirmed:** the March 2025 Google Maps Platform pricing change replaced the pooled $200 monthly credit with per-SKU free caps (10K/month for Essentials SKUs like Static Maps and Geocoding), and activating an API key for actual use still requires a Google Cloud billing account with a payment method on file even when usage stays within the free caps. That directly conflicts with the no-cost constraint, so it is not the default under any circumstances.

**The screenshot-and-calibrate approach is fully workable** and is a well-trodden technique (it's how most hobby CAD/landscape tools handle this). Concretely:

1. User captures a screenshot of their lot from Google Maps/Google Earth/county GIS viewer on their own screen (personal use of their own screenshot; the app never touches Google's APIs).
2. App loads it via `<input type="file">` -> `FileReader` -> draws it as a background layer on the yard canvas with adjustable opacity, and stores it as a compressed JPEG data URL (downscale to max ~1600 px on the long edge, quality ~0.8, via an offscreen canvas) to stay well inside localStorage's ~5 MB budget.
3. Calibration: user clicks two points on the image whose real-world separation they know (a fence line they can measure once, a driveway width, or, pro tip to put in the UI, the scale bar Google Maps renders in the corner of the screenshot). They enter the distance in feet. `feetPerPixel = knownDistanceFt / pixelDistance`. Store `scaleFtPerPx`, plus image offset and optional rotation so the image can be nudged to align with the yard grid.
4. Everything else (head placement, dead-space tracing, yard-zone tracing) then happens on top of the reference image at true scale.

This gets someone from "blank grid" to "traced yard" in a few minutes with zero cost, zero API keys, and zero accounts.

**Stretch (opt-in only, STOP required):** the Google Maps Static API path (geocode address -> fetch satellite tile at known zoom -> derive scale from zoom+latitude) would automate steps 1-3, stays within the 10K/month Essentials free cap at this usage level, but requires Alex to set up billing with a card. Opus must never scaffold, key, or code-path this without an explicit go-ahead. If this is ever revisited, also evaluate free-tile alternatives at that time (e.g. Esri World Imagery via Leaflet, USGS/NAIP public-domain imagery), terms of use for those change and must be re-verified before relying on them.

---

## 2. Repository Structure

```
sprinkler-simulator/
├── README.md                  # what it is, how to run locally, how to deploy,
│                              # how to (re)deploy the Apps Script sync backend
├── PLAN.md                    # this document
├── LICENSE
├── .gitignore
├── .nojekyll                  # in the served directory; stops Pages running Jekyll
│
├── docs/                      # served by GitHub Pages (Settings -> Pages -> /docs on main)
│   ├── index.html             # shell only: markup + <script type="module">
│   ├── css/
│   │   └── styles.css
│   └── js/
│       ├── app.js             # bootstrapping, tab wiring, top-level state
│       ├── state.js           # schema (see section 3), schemaVersion, v1->v2 migration,
│       │                      # localStorage autosave, JSON export/import
│       ├── sync.js            # optional Apps Script sync client
│       ├── canvas.js          # rendering, coordinate transforms, hit-testing,
│       │                      # drag interactions, polygon drawing tools
│       ├── coverage.js        # precip rate, effective GPM, heatmap, rollups
│       ├── forecast.js        # NWS fetch, ET0 (Hargreaves-Samani), day-by-day table
│       ├── schedule.js        # cycles-per-week logic, scheduled-day resolution
│       └── usage.js           # water usage estimator
│
├── apps-script/
│   ├── Code.gs                # the sync web app (copy-paste or clasp-push to deploy)
│   └── DEPLOY.md               # step-by-step deployment + redeployment instructions
│
├── scripts/                   # Python tooling, NOT part of the deployed app
│   ├── requirements.txt
│   ├── migrate_sheet_export.py   # original Google Sheet export -> schema v2 JSON
│   ├── migrate_v1_config.py      # old single-file localStorage/JSON -> schema v2
│   └── validate_config.py        # JSON Schema validation of config files
│
├── schema/
│   └── config.schema.json     # JSON Schema for the v2 config format
│
├── tests/                     # pytest; golden tests against spreadsheet values
│   ├── test_coverage_math.py  # precip rate, sector area, effective GPM scaling
│   ├── test_forecast_math.py  # ET0, baseline need, adjustment %
│   ├── test_schedule.py       # cycles/week, scheduled-day logic
│   └── fixtures/
│       ├── golden_spreadsheet_values.json
│       └── sample_config_v1.json
│
├── legacy/
│   └── sprinkler-simulator.html   # the original file, kept verbatim for reference
│
└── .github/
    └── workflows/
        └── ci.yml             # run pytest on push (Pages deploy needs no workflow
                               # if using "deploy from branch /docs")
```

Notes for Opus:

- No bundler, no npm, no framework. Plain ES modules loaded with `<script type="module">`. This preserves the zero-build property and works natively on Pages.
- The JS math in `coverage.js`/`forecast.js` and the Python in `tests/` intentionally duplicate formulas. The Python versions exist to pin the math to golden spreadsheet values; keep them in sync when formulas change and say so in comments on both sides.
- Serving from `/docs` on `main` avoids needing a deploy workflow at all; `ci.yml` only runs tests.

---

## 3. Data Model (Schema v2)

This is the target shape. `state.js` owns it; everything else consumes it. All geometry is in **yard feet with origin (0,0) at the bottom-left**; the canvas layer flips the y-axis at render time only (`canvasY = canvasHeight - y * pxPerFt`). No stored coordinate is ever in canvas space.

> **Correction (Phase 7, task 30):** the `schedule` block below is stale. The shipped schema uses a **four-mode** model, not the three modes shown here: `every_day`, `odd_even`, `days_of_week` (a chosen set of weekdays Mon..Sun; replaces `n_per_week`), and `interval` (every N days from an anchor date). The authoritative definitions are the header comment in `docs/js/schedule.js` and the `mode` enum in `schema/config.schema.json`. Legacy `n_per_week` blobs are coerced to `days_of_week` by `state.js`'s `normalizeSchedule()`, which stays in place permanently for old localStorage data.

```jsonc
{
  "schemaVersion": 2,

  "yard": { "widthFt": 80, "heightFt": 50 },

  // Sprinkler (valve) zones. Up to 12. UI seeds 6 on first load; "Add zone"
  // reveals more up to the cap. Zones with no heads may be hidden/collapsed.
  "sprinklerZones": [
    {
      "id": "sz1",
      "name": "Zone 1",
      "supplyGpm": 9.5,           // measured available flow; null = unknown/unlimited
      "runTimeMin": 25,           // THE canonical run time; Forecast tab derives from this
      "weeklyTargetIn": 1.0,      // target inches of water per week
      "schedule": {
        "mode": "odd_even",       // "every_day" | "odd_even" | "n_per_week"
        "oddEvenChoice": "odd",   // required when mode = odd_even: "odd" | "even"
        "nPerWeek": 3,            // required when mode = n_per_week
        "daysOfWeek": [1,3,5]     // optional refinement for n_per_week; see section 6.2
      }
    }
  ],

  // Yard zones: informal user-defined areas, fully independent of valve wiring.
  "yardZones": [
    { "id": "yz1", "name": "Front lawn", "color": "#4caf50",
      "polygon": [[0,0],[40,0],[40,30],[0,30]] }
  ],

  // Dead space: excluded from turf coverage stats and heatmap.
  "deadSpaces": [
    { "id": "ds1", "label": "House", "kind": "house",   // house|patio|deck|driveway|pool|bed|other
      "polygon": [[10,10],[35,10],[35,28],[10,28]] }
  ],

  "heads": [
    {
      "id": "h1",
      "sprinklerZoneId": "sz1",
      "x": 5.0, "y": 5.0,               // feet, bottom-left origin
      "radiusFt": 15,
      "arcStartDeg": 0, "arcEndDeg": 180,  // bearings, same convention as v1
      "ratedGpm": 2.0,
      // --- new audit/maintenance fields (all optional except type) ---
      "type": "rotary",                  // "rotary" | "fixed"
      "nozzleFamily": "MP Rotator",      // free text; suggested values incl. MP Rotator
      "brand": "Hunter",
      "model": "PRS40",
      "nozzle": "MP2000",
      "riserHeightIn": 4,
      "needsReplacement": false,
      "notes": ""
    }
  ],

  "background": {
    "imageDataUrl": null,       // compressed JPEG data URL; NEVER included in cloud sync
    "scaleFtPerPx": null,       // synced
    "offsetXFt": 0, "offsetYFt": 0, "rotationDeg": 0, "opacity": 0.5  // synced
  },

  "forecast": {
    "latitude": null, "longitude": null,   // for NWS gridpoint + Hargreaves-Samani
    "windowDays": 7,
    "efficiencyPct": 80        // runoff/uptake efficiency, stored AND displayed as a %
  },

  "sync": {
    "enabled": false,
    "endpointUrl": null,       // Apps Script /exec URL
    "userKey": null,
    "lastSyncedAt": null
  }
}
```

**Migration v1 -> v2** (in `state.js`, applied automatically on load of any config lacking `schemaVersion: 2`):

1. Flip y: `y2 = yardHeightFt - y1` for every head (and any other stored y).
2. Wrap the 6 fixed zones into `sprinklerZones` objects with generated ids; map the existing per-zone run time into `runTimeMin`; carry over supply GPM if it exists in v1, else `null`.
3. Add head defaults: `type: "fixed"` is a reasonable default only if v1 has no hint; otherwise leave `type` unset and surface a "set head types" nudge in the UI, do not silently guess rotary vs fixed since it drives warnings.
4. Convert the old raw cycles-per-week number: 7 -> `every_day`; 3.5 -> `odd_even` (default `oddEvenChoice` from... nothing, leave `"odd"` and flag in UI); anything else -> `n_per_week` with `nPerWeek` = round(value).
5. Initialize empty `yardZones`, `deadSpaces`, `background`, `sync`.
6. Preserve the original JSON blob under `_v1Backup` inside the exported file the first time a migration runs (belt-and-suspenders; not kept in localStorage).

**Core math changes:**

- **Effective GPM (the fix):** per zone, let `R = sum(ratedGpm)` over its heads. If `supplyGpm` is set and `supplyGpm < R`, then for each head `effectiveGpm = ratedGpm * (supplyGpm / R)`. Otherwise `effectiveGpm = ratedGpm`. All precipitation-rate math (`96.3 * effectiveGpm / sectorAreaSqFt`) and the heatmap consume `effectiveGpm`. Keep the existing over-subscription warning; it now also states that scaling has been applied and by what factor.
- **Head type in calculations:** `type` must visibly matter, not just sit in a table. Two concrete behaviors: (a) a zone-level warning when a zone mixes rotary and fixed heads ("mixed precipitation rates in one valve zone cause uneven watering, consider separating or matching nozzles"), since rotary heads run at inherently lower precip rates than fixed sprays; (b) a per-head sanity check comparing the computed precip rate against typical ranges (roughly: fixed spray 1.3-2.0 in/hr, rotary/MP-style 0.4-0.9 in/hr) with a soft "rated GPM or arc may be misentered" flag when far outside. Do not invent distribution-curve physics beyond this; the uniform-within-sector model stays (see section 6.4).
- **Coverage rollups:** summary stats computable grouped by sprinkler zone OR yard zone. Yard-zone membership of a grid cell = point-in-polygon. Dead-space cells are excluded from all turf stats and rendered as hatched/neutral on the heatmap. If a cell falls in multiple yard zones, count it in each (document this choice in the UI tooltip); dead space always wins over yard zone.
- **Cycles per week:** `every_day` -> 7.0; `odd_even` -> 3.5; `n_per_week` -> N. Always displayed to 1 decimal.
- **Forecast baseline:** per zone, `baselineDailyNeedIn = weeklyTargetIn / cyclesPerWeek`. No manually maintained daily-need field anywhere.
- **Run-time single-sourcing:** the Forecast tab's suggested/adjusted run time for a zone-day = `runTimeMin * adjustmentPct`, where `runTimeMin` is read live from the sprinkler zone object. There is no second run-time field to drift.
- **Water usage:** per zone, `zoneFlowGpm = min(supplyGpm ?? infinity, sum(ratedGpm))`; `gallonsPerWeek = zoneFlowGpm * runTimeMin * cyclesPerWeek`; monthly = weekly * 4.345. Display per-zone and total, weekly and monthly. Gallons only. Extension point: a `rateSchedule` key is reserved in the schema (absent for now) and `usage.js` exposes `estimateGallons()` separately from any future `estimateCost()` so cost can bolt on without rework.

---

## 4. Ordered Task Breakdown

### Phase 0 — Repo scaffolding and safety net

> **STOP / CONFIRM WITH ALEX before starting:** confirm the actual current `sprinkler-simulator.html` is provided (it is, in `legacy/`), and confirm the GitHub repo name and whether public visibility is acceptable (required for free Pages).

1. Create the repo with the section 2 structure; commit the untouched original to `legacy/`. (Done as of this scaffold.)
2. Extract golden values: record precip-rate outputs, ET0 values, and summary stats for a representative config into `tests/fixtures/golden_spreadsheet_values.json`. (Done as of this scaffold, derived from values already cross-checked against the real Google Sheet.)
3. Write `tests/test_coverage_math.py` and `test_forecast_math.py` in Python against the goldens (re-implementing the v1 formulas). These must pass before and after every subsequent phase. (Done as of this scaffold.)
4. Set up `ci.yml` to run pytest on push. (Done as of this scaffold.)
5. Enable GitHub Pages (deploy from branch, `/docs`), with `docs/index.html` initially being the legacy file verbatim, so there is a working deployed URL from day one. (File is in place; enabling Pages itself happens in GitHub's repo settings after the first push.)

### Phase 1 — Modularization and schema v2

6. Split the single file into the `docs/` modules per section 2, changing zero behavior. Verify against goldens and by manual diff of on-screen numbers.
7. Implement schema v2 in `state.js` with the v1->v2 auto-migration (section 3), including the coordinate-origin flip. Render-time y-flip in `canvas.js`.
8. Write `scripts/migrate_v1_config.py` and `scripts/migrate_sheet_export.py`; validate outputs with `schema/config.schema.json` + `validate_config.py`.
9. UI: 12-zone support (6 shown initially, explicit "Add zone"), compact inline yard-dimensions control, new head fields in the table (type, nozzle family, brand, model, nozzle, riser height, needs-replacement flag), and a "needs replacement" visual marker on the canvas.
10. Sweep all UI copy and generated text for em dashes and remove them; add a check to CI (simple grep over `docs/`) so they can't come back.

### Phase 2 — Canvas interaction

11. Hit-testing and drag-to-move for heads on the Yard Preview (mouse + touch). Selected head highlights and scrolls/syncs to its table row and vice versa.
12. Drag handles on the selected head for radius (edge handle) and arc start/end (two handles on the arc ends). Snap-to-degree increments (e.g. 5 degrees) and snap-to-0.5-ft for position, with a modifier key for free movement.
13. Polygon drawing tool used for both yard zones and dead spaces: click to add vertices, click first vertex or double-click to close, drag vertices to edit, delete vertex. Dead spaces render hatched; yard zones render as tinted outlines with labels.
14. Background image: file upload, downscale/compress to JPEG data URL, opacity slider, drag-to-position, optional rotation, and the two-point scale calibration flow (section 1.3). Persist per section 3 (image local-only).

### Phase 3 — Math and audit features

15. Effective-GPM proportional scaling (section 3) wired into precip rates and heatmap; update the over-subscription warning accordingly. Extend golden tests with supply-limited cases.
16. Dead-space exclusion from heatmap and stats; yard-zone rollups added to Coverage Map summary (group-by toggle: Sprinkler Zone / Yard Zone). Remove the "Peak Zone GPM" stat.
17. Head-type-driven warnings and sanity ranges (section 3).
18. Zone flow calculator (small modal/panel on the zone): two input modes, (a) gallons used over a timed interval, (b) meter revolutions times gallons-per-revolution over a timed interval, outputting GPM with a one-click "apply as this zone's supply GPM."
19. Watering schedule control replacing the raw cycles/week input: every day / odd-even (with odd-or-even choice) / N per week; effective cycles per week shown to 1 decimal everywhere it's used.

### Phase 4 — Forecast tab and usage estimator

20. Day-by-day table: today leftmost, 7-day outlook rightward. Per day: forecasted rain, ET0, efficiency (as %), net water need, and that day's seasonal adjustment %, the latter only rendered on days that are scheduled watering days per the zone's schedule (non-watering days show a muted "no watering scheduled" cell).
21. Baseline daily need auto-derived (`weeklyTargetIn / cyclesPerWeek`); delete any manual daily-need field.
22. Adjusted run times derived live from each zone's `runTimeMin` (section 3). Verify NWS gridpoint precipitation units (values commonly arrive in mm; convert explicitly) and handle forecast-fetch failure gracefully (tab still renders with rain unknown).
23. Water usage estimator per section 3, on the Coverage Map tab (or its own small card): per-zone and total gallons per week and month, with the clean `estimateCost()` extension seam left unimplemented.

### Phase 5 — Cloud sync (optional layer)

> **STOP / CONFIRM WITH ALEX before starting this phase:** confirm he wants the Apps Script sync now (vs. shipping with localStorage + export/import only), confirm which Google account will own the Sheet and script, and walk through `apps-script/DEPLOY.md` together since deployment happens in his account, not Opus's.

24. Write `apps-script/Code.gs`: `doGet`/`doPost` per section 1.2 (key-keyed rows, text/plain POST bodies, `updatedAt` conflict check), plus `DEPLOY.md` with exact deployment steps and the redeployment gotcha.
25. Client `sync.js`: settings UI (endpoint URL + user key), explicit Save-to-cloud / Load-from-cloud actions plus auto-pull-on-load when enabled, conflict prompt, and clear offline behavior. Background image excluded from payloads.
26. Generate the 5 user keys with Alex; seed the Sheet.

### Phase 6 — Polish and ship

27. Full pass on interface smoothness: tab layout, compact controls, empty states ("no heads yet, click the canvas to add one"), first-run hint pointing at the background-image + calibration flow.
28. README: local dev, deploy, sync setup, how to capture and calibrate a satellite screenshot, data/privacy note (what syncs, what stays local).
29. Final golden-test run, cross-browser check (Chrome, Safari, Firefox, one phone), share URL with the 5 users.

> **Standing STOP rules for Opus throughout:** stop and confirm before (a) creating or configuring ANY third-party service or account, (b) anything that requires or could ever require a payment method, this includes the entire Google Maps API stretch path, which is opt-in only, (c) deviating from the recommended stack when two options seem closely matched during implementation, and (d) any schema change beyond section 3 that would affect saved user data.

---

## 5. Sync of decisions to requirements (quick trace)

Every firm requirement in the request maps to a numbered task: origin flip (7), compact dimensions control (9), 12 zones (9), yard zones (13, 16), dead space (13, 16), head audit fields (9) with type affecting calculations (17), draggable heads + arc/radius handles (11, 12), zone flow calculator (18), proportional GPM fix (15), Peak Zone GPM removal (16), yard-zone grouping (16), schedule selector with 1-decimal cycles (19), day-by-day forecast table (20), scheduled-days-only adjustments (20), auto baseline (21), run-time single-sourcing (22), em-dash removal (10), water usage estimator (23).

---

## 6. Ambiguities, Risks, and Suggested Simplifications

**6.1 The source file was reconciled during scaffolding.** The real `legacy/sprinkler-simulator.html` is in the repo. Opus should still do a quick pass confirming the schema/migration notes above match it exactly before Phase 1.

**6.2 "Every other day" vs. odd/even is genuinely ambiguous.** Odd/even watering (a common municipal restriction) means watering on odd or even calendar dates, which is not the same as strict alternation (the 31st->1st transition gives two consecutive odd days). The plan treats the selector as calendar odd/even with an explicit odd-or-even choice, computing 3.5 cycles/week as specified. If Alex actually wants strict alternation from an anchor date, say so before Phase 3, it changes the scheduled-day resolution in task 20. Similarly, "N times per week" needs to resolve to specific days for the forecast table; the plan defaults to letting the user optionally pick days of week, otherwise assuming evenly spaced days starting Monday. Confirm.

**6.3 Background image vs. sync.** As designed, the satellite image does not travel between devices (Sheets cell limits). Calibration numbers do, so re-attaching the same screenshot on a second device restores everything. If cross-device image sync ever becomes a must-have, the clean path is Apps Script writing the image to a Drive file, deferrable, not designed now.

**6.4 The uniform-precipitation model is a simplification.** Real heads deliver more water near the head (or per their nozzle's distribution curve); the tool assumes uniform depth across the wetted sector. That matches the original spreadsheet and is fine for comparing zones and auditing coverage, but the heatmap should carry a small caption saying it models average precip rate, not measured distribution, so nobody treats it as a catch-can audit.

**6.5 Hargreaves-Samani from forecast temps is coarse.** It ignores wind, humidity, and solar measurement, and forecast highs/lows are themselves uncertain at day 6-7. Reasonable for a percentage nudge; the day-by-day table should visually de-emphasize days 5-7 (lighter text) rather than pretending equal confidence.

**6.6 Overlap semantics.** Dead space always overrides yard zones and turf. A cell in two yard zones counts toward both zones' rollups (simplest, and matches how people casually define overlapping areas). If Alex prefers exclusive zones, enforcement (warn on overlap) is a small addition to task 13, decide before Phase 3.

**6.7 Touch interactions are the riskiest UI work.** Drag handles for arc/radius at phone scale are fiddly. The plan requires drag-to-move on touch, but treats arc/radius handles as desktop-first with a fallback (tap head -> edit fields in a popover) on small screens. This is a deliberate simplification; fully gesture-driven arc editing on phones is not worth the effort for 5 users.

**6.8 Public repo.** Free GitHub Pages requires a public repo. Yard layouts are mildly sensitive (they sketch a house footprint), but user configs live in localStorage/the Sheet, never in the repo, so the public repo exposes only code. If even that is unwanted, Cloudflare Pages hosts from a private repo for free, decide at Phase 0.

**6.9 Simplification worth taking.** The plan deliberately does not add: user accounts, merge/conflict resolution beyond a prompt, PWA/offline-install, or a cost estimator. Each has a clean seam to add later. Resist scope creep past the phases above until the 5 users have actually used it.

---

## 7. Phase 7 Addendum — Post-launch fixes and features

**Prepared:** July 17, 2026, from Alex's hands-on use of the deployed app.
**Code-verified against:** commit `c8f4790` ("Inital launch with Sync"). Every file/line reference below was checked against the actual code at that commit; where Alex's report and the code disagreed, the code won and the discrepancy is noted.

Same rules as the rest of this document: Opus executes section 7.2's numbered tasks in order, stopping at every **STOP / CONFIRM WITH ALEX** marker. Section 7.3 items are **discussion items, not tasks**; do not implement them until Alex converts them. The standing STOP rules at the end of section 4 remain in force, in particular rule (d): any schema change affecting saved user data (tasks 40 and 42 below) needs explicit confirmation.

### 7.1 Status note: the schedule-mode mismatch is already (mostly) resolved

Planning for this phase flagged that `schedule.js` handled only `every_day` / `odd_even` / `n_per_week` while `state.js` produces `mode: "days_of_week"`, which would throw "unknown schedule mode" against real state. **Verification against the current code shows this was already fixed:** `schedule.js` implements a four-mode model (`every_day`, `odd_even`, `days_of_week`, `interval`; header comment says "confirmed with Alex, extends PLAN.md section 3"), `state.js`'s `normalizeSchedule()` coerces legacy `n_per_week` blobs into `days_of_week`, `tests/test_schedule.py` mirrors all four modes, and `schema/config.schema.json` enumerates exactly those four modes. `forecast.js`'s `isScheduledDay()` calls therefore work today.

What is still stale, and becomes task 30:

- `scripts/migrate_v1_config.py:144` and `scripts/migrate_sheet_export.py:90,117` still emit `{"mode": "n_per_week", "nPerWeek": 3}`. That shape is **invalid against `config.schema.json`** (its `mode` enum has no `n_per_week`), so `validate_config.py` rejects the migrators' own output; the app only loads such blobs thanks to `normalizeSchedule()`'s legacy coercion.
- `tests/test_forecast_math.py:90` (`test_n_per_week_schedule`) still tests the retired shape.
- Section 3 of this document still documents the old three-mode schema. Treat `schedule.js`'s header comment and `config.schema.json` as the source of truth over section 3's `schedule` block.

### 7.2 Ordered tasks (numbering continues from task 29)

> **STOP / CONFIRM WITH ALEX before starting this phase.** Decisions needed up front:
> (a) Task 31: one-time "copy schedule to all zones" (recommended) vs. a persistent linked-schedule mode.
> (b) Task 34: sequential IDs for heads only (recommended), or also for zones / yard zones / dead spaces.
> (c) Task 35: layout order, default is Zones table above, Yard Preview below.
> (d) Task 40: remove the zone Name from the UI only (recommended) vs. removing `name` from the schema entirely (schema change, standing rule (d)).
> (e) Task 41: dropdown labels "Rotary" / "Fixed" confirmed; is the empty option "unset" or "Unset"?
> (f) Task 42: removing `nozzleFamily` is a schema change affecting saved user data (standing rule (d)); confirm before touching `state.js` / `config.schema.json` / the migrators.

30. **Schedule-mode cleanup (do first; prerequisite for task 38).** Update `scripts/migrate_v1_config.py` and `scripts/migrate_sheet_export.py` to emit `{"mode": "days_of_week", "daysOfWeek": [...]}` using the same evenly-spaced-weekdays logic as `state.js`'s `normalizeSchedule()` (state.js:70-76), so migrator output passes `validate_config.py`. Update `tests/test_forecast_math.py:90` to the four-mode shape. Add a short correction note to section 3 of this document pointing at the four-mode model. Keep `normalizeSchedule()`'s `n_per_week` coercion in place permanently (old localStorage blobs exist in the wild).

31. **Apply one schedule to all zones.** Add a "Copy this schedule to all zones" action to the schedule modal (app.js `openScheduleModal`, ~line 505) or a button on the Zones card: deep-copies the chosen `schedule` object into every `sprinklerZones[i].schedule`, then `saveState()` and re-render. **Recommended: one-time copy, not a persistent linked mode.** Linking adds sync bookkeeping and surprise edits-at-a-distance for a 12-row list Alex can re-copy in one click; decision (a) above.

32. **Flow calculator: meter-reading inputs for the "gallons" method.** In `openFlowModal` (app.js:512-574), replace the single "Gallons used" field (app.js:540) with two fields, "Meter before" and "Meter after", plus the existing "Over minutes". `gallons = after - before`; guard against `after <= before` (show "-" and keep the Apply button inert, same as today's `gpm > 0` guard at app.js:568). GPM math and the existing one-click "Apply as supply GPM" (app.js:567-573) are unchanged; the revolutions method is unchanged.

33. **Heatmap: show water landing on dead space instead of hiding it.** In `drawHeatmap` (canvas.js:619-630), dead-mask cells currently get an opaque neutral fill (`rgba(120,130,125,0.5)` at canvas.js:624) **instead of** the water-depth color. Change to: paint `colorForValue(grid[r][c], ref)` for every cell, then overlay dead-mask cells with a diagonal-hatch `CanvasPattern` (build once from a small offscreen canvas, ~8 px repeat, semi-transparent gray) so the depth color reads through. This is rendering-only: `coverage.js` stats/rollups continue excluding dead cells exactly as now. Optional nicety: append "(dead space)" to the hover tooltip (canvas.js:655) for masked cells.

34. **Sequential head IDs.** Replace `uid("H")` at both call sites (app.js:179 and app.js:829) with a `nextHeadId(state)` helper: scan existing head ids for `/^H(\d+)$/`, take max+1 (start at 1), return `"H" + n`. Existing random-suffix ids remain valid and are simply skipped by the scan. `uid()` (state.js:28) stays for zones (`uid("sz")`, app.js:98), yard zones, and dead spaces unless Alex opts them in; decision (b) above.

35. **Full-width Yard Preview.** In `index.html`'s tab-yard, the Yard Preview canvas currently shares a `grid cols-2` row with the Zones table. Give each its own full-width row and size the canvas larger. Default order: Zones table above, Yard Preview below (decision (c)). Re-check the canvas's scale-to-fit math picks up the wider container (canvas.js computes from `clientWidth`).

36. **Yard-zone area in sq ft.** Add a shoelace-formula `polygonAreaSqFt(polygon)` helper (natural home: `coverage.js`, next to the other geometry; add a matching case to the Python tests only if goldens are touched). Show it as an "Area (sq ft)" column in `#yardZoneTable` (header at index.html:136, rows rendered in `renderAreaLists`, app.js:292-308). Optional: live area readout while the polygon tool is drawing, and the same column for dead spaces (index.html:148), both cheap once the helper exists.

37. **Usage estimator flow source: verified, no change needed.** Confirmed during planning: `usage.js`'s `zoneFlowGpm()` (usage.js:16-19) implements `min(supplyGpm ?? Infinity, sum(ratedGpm))` and directly feeds the `#usageTable` Flow (GPM) column; there is no separate or duplicate flow input anywhere in the usage card (index.html:203-206). The Yard & Heads zone data is already the single source of truth. No code change; this task exists so the checklist records the verification.

38. **Forecast table: all zones, 10% rounding, 10-150% clamp, over-cap flag.** Requires task 30 first. Three coordinated changes to `forecast.js` / `index.html`:
    - **(a) Show every zone.** Remove the "Show adjustments for" selector (`#forecastZone`, index.html:223; wiring at forecast.js:29, 41, 187-188). Note the premise correction: the adjustment % is **not** global today, `adj = netNeed / baseline` where `baseline = weeklyTargetIn / cyclesPerWeek` is per-zone (forecast.js:190-191), so adjustment and run time both vary by zone. **Proposed layout:** keep the existing day-columns table; the Forecast rain / ET0 / Efficiency / Net need rows stay as single global rows (forecast.js:202-208); replace the single Adjustment + Suggested-run-time rows with **one row per sprinkler zone**, labeled "Zone N (base 25 min)", whose cells show `28 min (110%)` on that zone's scheduled days and the muted "no watering" treatment otherwise. Keeps the table one screen tall for 12 zones and preserves the days-5-7 dimming. Rewrite `#forecastNote` (forecast.js:233-237), which currently narrates a single zone's baseline, into generic copy (per-zone baseline can move into the row label's `title` tooltip).
    - **(b) Rounding and clamp.** `adjRounded = clamp(Math.round(rawAdj * 10) / 10, 0.1, 1.5)`; suggested minutes = `Math.round(zone.runTimeMin * adjRounded)`. Update the two `clamp(..., 0, 1.5)` sites (forecast.js:212, 218, which collapse into the per-zone row builder), the module header comment (forecast.js:10), the About-tab copy "clamped 0 to 150%" (index.html:253), and the Python twin `tests/test_forecast_math.py` plus goldens, which currently pin the unrounded 0-150% behavior.
    - **(c) Over-cap flag.** When `rawAdj > 1.5`, render the cell with a warning marker (e.g. a `warn` class and "▲" suffix) and a `title` tooltip of the form "unclamped need was 212%", so silent clamping never hides a genuinely dry day. Applies per zone-day cell since baselines differ.

39. **1 ft granularity everywhere; grid default 1 ft.** Drop the 0.5 ft step across the board: `#cellSize` `min`/`step` 0.5 -> 1 (index.html:50) and its clamp floor (app.js:83); default `cellSizeFt` 2 -> 1 in `defaultState` (state.js:94) and the normalize fallback (state.js:220); head x/y/radius input steps 0.5 -> 1 (app.js:220-222); canvas drag snapping 0.5 -> 1 ft for head position, radius, polygon vertices, and background offset (canvas.js:387, 391-392, 398-401; update the header comment at canvas.js:12-13). Alt-for-free-movement still bypasses snapping, so sub-foot placement remains possible deliberately. Existing saved configs keep their stored `cellSizeFt` (no forced migration; the v1 migrator's carry-over at state.js:200 stays). Note: 1 ft default quadruples heatmap cell count (80x60 yard = 4,800 cells), which is trivially fine at this scale.

40. **Hide the sprinkler-zone Name field.** **Recommended: UI-only removal.** Keep `name` in the schema (it labels `zoneSummaryTable`, the coverage zone filter, and forecast row labels/notes) but replace the editable Name input in the zones table with a static label, and have add/render logic keep stored names locked to "Zone N". Decide what N means after a deletion (recommend: renumber by position at render so labels stay dense, since nothing user-visible references old names). Full schema removal would also touch `migrateV1toV2`, `config.schema.json`, both migrator scripts, and every consumer above; only do that on explicit confirmation, decision (d).

41. **Heads table: move Type next to Zone, capitalize labels.** Reorder the `#headsTable` header (index.html:122-123) and the row template (app.js, `renderHeadsTable` cell order incl. app.js:226) so Type sits immediately after Zone: ID, Zone, Type, X, Y, Radius, Arc start, Arc end, GPM, ... In `typeOptions()` (app.js:193-196), capitalize labels to "Rotary" / "Fixed"; the empty option per decision (e). Values (`"rotary"`, `"fixed"`, `""`) are unchanged, labels only, so no schema/stat impact.

42. **Remove `nozzleFamily`.** Schema change, decision (f) required first. Remove: the Nozzle family column (index.html:123) and its cell in the heads-table row template (app.js), the field from the head shape/defaults in `state.js` (~line 180 block), the `migrateV1toV2` per-head mapping, `config.schema.json:115`, and any emission in `scripts/migrate_*.py`. `nozzle` (the specific model, e.g. "MP2000") stays. Loading old configs that still contain `nozzleFamily` must not error: either strip it in normalize or rely on `additionalProperties` tolerance, but be deliberate and test it.

43. **Stop scrolling the page on canvas head selection.** In `selectHead()` (app.js:35-46), delete the `scrollIntoView` block (app.js:40-44 core at line 43). Row highlighting via `renderHeadsTable()` and canvas redraw stay; this amends PLAN.md task 11, whose "scrolls to its table row" behavior proved to be an unwanted page-jerk when dragging heads. Since table-originated selection never needed the scroll (the row is already in view), removing it entirely is correct; no conditional needed.

**Trace:** Alex's items 1-13 map to tasks 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43 respectively; the schedule-mode housekeeping is task 30.

### 7.3 Needs design discussion first — do NOT implement

Same treatment as section 6: these are framed questions for Alex, not specs. Opus must not start any of them without a converted, confirmed task.

**7.3.1 Multiple watering scenarios ("established turf" vs. "seeding").** The lightest coherent design is scenarios as named overlays over one shared geometry: heads, zones, polygons, and background stay singular, while each scenario stores per-zone `runTimeMin` / `schedule` / `weeklyTargetIn`, with exactly one scenario active and driving Coverage/Forecast/Usage. The alternative, full independent configs, doubles every sync/export/migration surface for little gain. **Ask Alex:** (1) does the overlay model (shared geometry, per-zone watering params only) cover the seeding use case, or do scenarios ever need different heads/zones? (2) is one-active-at-a-time with the rest as stored presets acceptable? (3) should scenarios ride inside the one synced config blob (recommended, keeps sync/export untouched structurally) or be separate saves?

**7.3.2 Coverage-per-gallon optimizer.** New algorithmic territory, nothing like it exists in the codebase, and it is a meaningfully larger scope item than everything else in this list. The tractable, explainable version is a local grid search: hold head positions and radii fixed, vary arc start/end in the existing 5-degree snap steps and run time in small steps, re-scoring each candidate with the existing `computeCoverage()`; no general solver. **Ask Alex before any speccing:** (1) confirm positions/radii are fixed and only arcs + run times vary; (2) pick the objective, minimize depth variance across turf cells per gallon, hit each zone's `weeklyTargetIn` with least total water, or bound worst-case over/under-watering, these give different answers; (3) confirm appetite for the scope (this is a mini-phase of its own, with its own golden tests).

**7.3.3 Cycle-length / start-time staggering.** On a standard single-wire controller zones fire sequentially, so "how long is one full cycle" is just the sum of `runTimeMin` over the zones scheduled that day, and the feature reduces to a small per-day "total cycle runtime" stat (Forecast tab or Zones card) Alex can use to space start times. **Ask Alex:** confirm the sequential-controller assumption (no concurrent zones / multiple valve wires); if confirmed this is a near-trivial task, and if not, it needs real modeling and moves up in scope. Also ask whether the stat should use base run times, forecast-adjusted run times, or both.

**7.3.4 Forecast math audit and override surface.** Current override surface is exactly one knob: runoff/uptake efficiency (`#runoffEff`, 10-100%). There is **no ET0 override in the current code** (the `#etOverride` field from an older draft of this document does not exist in index.html/forecast.js), so reinstating one is an open question, not a regression fix. Plan a verification pass: re-derive two or three days by hand from raw NWS gridpoint data through `hargreavesET0()` and the net-need/adjustment chain, and cross-check the mm-to-inches conversion (task 22's known trap). **Ask Alex:** after seeing the audit results, which overrides are actually worth the surface area, a manual ET0 override, a per-day manual adjustment-% override, both, or neither? Recommend deciding on evidence from the audit rather than adding knobs preemptively.

> **STOP / CONFIRM WITH ALEX** closes this phase as it opened it: nothing in 7.3 becomes code without an explicit go-ahead, and tasks 40/42's schema-touching variants stay behind standing rule (d).

---

## 8. Phase 8 Addendum — Mobile / small-screen experience

**Prepared:** July 17, 2026.
**Code-verified against:** the current working tree (which includes uncommitted Phase 7 work). Every file/line reference below was checked against the actual code; line numbers may drift as Phase 7 lands, so the named symbols (`renderHeadsTable`, `computeTransform`, `drawHeatmap`, the `*_HIT_PX` constants) are the stable anchors. One correction to the planning notes: the yard canvas is `height="560"` (index.html:84), not 480; only the heat canvas is 480 (index.html:179).

Same rules as always: Opus executes 8.2's numbered tasks in order, stopping at the **STOP / CONFIRM WITH ALEX** marker; 8.3 items are discussion items, not tasks. The standing STOP rules from section 4 remain in force.

**The one non-negotiable constraint for this whole phase:** nothing changes the desktop/larger-screen layout, table density, or drag-handle precision that already works. Every new code path is strictly additive, gated behind the phase's media query or capability check. Task 50 exists specifically to verify this.

### 8.1 Architectural recommendation: targeted fork at two pain points, passive CSS everywhere else

The current responsive story is one media query (styles.css:59, stacking `.grid.cols-2/.cols-3` at 980px) plus `.table-wrap{overflow-x:auto}` (styles.css:83). Two approaches were weighed for going further:

**Option A, one shared layout with more breakpoints.** Keep every element structurally identical at all widths and add CSS adjustments (tighter padding, smaller fonts, more stacking). Cheap and low-risk, and it is genuinely sufficient for most of this app: the read-mostly tables scroll acceptably, the tabs already scroll, the card grids already stack. But it cannot fix the two real problems. No amount of CSS makes a 17-column editable table (`#headsTable`, index.html:120-123) usable on a phone; you are still horizontally scrolling across sixteen cells to edit one head. And no media query fixes fingertip accuracy on 10-12 px hit targets (`HANDLE_HIT_PX = 12`, `HEAD_HIT_PX = 10`, `VERTEX_HIT_PX = 10`, canvas.js:34-36); that is an interaction problem, not a layout problem.

**Option B, genuinely different presentations below a breakpoint.** Alex's instinct. Taken maximally (a parallel mobile layout for the whole app) it is rejected: it roughly doubles the presentation surface to maintain for a 5-user hobby tool, and most of the app does not need it.

**Recommendation: Option B, but scoped to exactly the two components Option A cannot fix, with Option A treatment for everything else.** Concretely:

- **Forks (different presentation below the gate):** (1) the heads table becomes a card-per-head list on narrow viewports (task 46); (2) canvas precision editing gains bigger touch targets and a tap-to-edit modal on coarse-pointer devices (tasks 47-48), which is exactly the fallback section 6.7 promised and never got.
- **Stays shared with light CSS only:** header actions, mode toolbar, the read-mostly tables (`#zoneSummaryTable`, `#usageTable`, `#yardZoneTable`, `#deadSpaceTable`, the forecast table), which keep `.table-wrap` horizontal scroll deliberately, and `#zoneTable` (8 columns, editable but borderline; see decision (c)).
- **Never forks, regardless of screen:** `state.js`, `coverage.js`, `schedule.js`, `forecast.js`, `usage.js`, and all of `canvas.js`'s math, coordinate transforms, and state model. One source of truth; only rendering and event-affordance code branches.

**Detection method: two signals for two different problems, not one breakpoint for everything.**

- **Layout** (card list vs. table, canvas height, chrome density) is governed by viewport width: `@media (max-width: 700px)` in CSS and a matching `matchMedia` in JS. Layout is about available space, so width is the honest signal. 700px sits below every tablet-landscape and desktop width while catching phones in both orientations; the existing 980px query stays untouched as the tablet step.
- **Interaction** (hit-target size, the edit-head modal affordance) is governed by pointer capability: `matchMedia("(pointer: coarse)")`. This is why a single width check is wrong in both directions: a touchscreen laptop at desktop width reports a *fine* primary pointer (the trackpad), so it correctly keeps the precision drag handles unchanged; an iPad at near-desktop width reports *coarse* and correctly gets the bigger targets and the modal. Width says nothing about either case.

On coarse-pointer devices the drag handles are **not removed**, they get larger hit slop and remain the fast path for rough adjustment; the modal is the additive precision path. Fine-pointer desktop sees zero change from any of this.

### 8.2 Ordered tasks (numbering continues from task 43)

> **STOP / CONFIRM WITH ALEX before starting this phase.** Decisions needed up front:
> (a) Task 44: the two-signal gate as recommended in 8.1 (700px width for layout, `pointer: coarse` for interaction)? Or a different breakpoint value (640/768 are the common alternatives)?
> (b) Task 46: how much the head cards diverge from the desktop table. Recommended: primary fields visible, audit fields behind a "More" expander; see 8.3.1 for the alternatives before deciding.
> (c) Task 46: `#zoneTable` (8 columns, editable) keeps horizontal scroll for now (recommended; revisit after real phone use per 8.3.4), or gets the same card treatment immediately.
> (d) Task 48: the edit-head modal is gated to coarse-pointer/narrow only (recommended, per the desktop-untouched constraint), or also offered on desktop; see 8.3.3.

44. **Viewport signal module.** New `docs/js/viewport.js` (tiny, no dependencies): create the two `matchMedia` handles once, export `isNarrow()` (`(max-width: 700px)`), `isCoarse()` (`(pointer: coarse)`), and `onViewportChange(cb)` that subscribes `cb` to both lists' `change` events. `app.js` wires `onViewportChange` to re-render the affected surfaces (`renderHeadsTable()`, `drawYardCanvas()`, `redrawHeatmap()`), reusing the same calls as the existing resize listener (app.js:921). The 700px literal will also appear in `styles.css` media queries; put a "keep in sync with viewport.js" comment on both sides, same convention as the JS/Python math twins. The viewport meta tag is already correct (index.html:5); no change there. All new CSS in this phase goes in `styles.css` under a `/* --- Phase 8 additions --- */` comment, matching the existing per-phase convention.

45. **Responsive canvas height, gated narrow.** Both canvas draw entry points set `canvas.width = canvas.clientWidth` already but leave height at the static HTML attribute (560 for `#yardCanvas`, 480 for `#heatCanvas`), which on a phone squashes wide yards and eats the viewport. In `drawYardCanvas` (canvas.js:130) and `drawHeatmap` (canvas.js:597): when `isNarrow()`, set `canvas.height = clamp(Math.round((canvas.clientWidth - 20) * yard.heightFt / yard.widthFt) + 20, 240, Math.round(window.innerHeight * 0.65))` (the `- 20`/`+ 20` mirrors `computeTransform`'s 20 px margin, canvas.js:65); when not narrow, explicitly set the static height (560/480) so rotating a tablet across the breakpoint restores it. `computeTransform` (canvas.js:60-68) already reads `canvas.height`, and the existing resize listener (app.js:921) already redraws both canvases, so no other plumbing is needed; verify orientation change fires it (it does in all current browsers, `orientationchange` needs no separate listener).

46. **Head cards below the breakpoint.** Add an empty `<div id="headsCards"></div>` sibling to `#headsTableWrap` (index.html:118). CSS: `#headsCards{display:none}`; inside the 700px query, `#headsTableWrap{display:none}` and `#headsCards{display:block}`. In `renderHeadsTable` (app.js:207), branch on `isNarrow()`: narrow renders one card per head into `#headsCards` instead of table rows. Card layout, reusing existing classes only: a header row with the zone swatch, the ID input, the zone `<select>`, and the ✕ delete button; a `.field-row` grid with the primary fields (Type, X, Y, Radius, Arc start°, Arc end°, GPM); a native `<details><summary>More</summary>` holding the audit fields (Brand, Model, Nozzle, Riser, Replace?, Notes). **Critical: identical wiring.** Every control keeps its `data-f` attribute and attaches the exact same `change`/`focus` handlers as the table path (app.js:249-260), so `updateHeadField`, `saveState`, selection highlighting, and the structural re-render list are shared, not duplicated; factor the handler attachment into a small helper both branches call. Card tap (outside controls) calls `selectHead(h.id)` like the row click (app.js:244-248); the selected card gets the same `var(--green-100)` background. `onViewportChange` re-render (task 44) handles crossing the breakpoint. The empty state and `updateHeadTypeNudge()` behave identically in both branches. All other tables keep `.table-wrap` scroll per 8.1 and decision (c).

47. **Coarse-pointer touch targets on the canvas.** Convert the three hit constants (canvas.js:34-36) to values chosen at module load: fine pointer keeps 12/10/10; `isCoarse()` gives `HANDLE_HIT_PX = 22`, `HEAD_HIT_PX = 18`, `VERTEX_HIT_PX = 18`. This automatically widens every consumer: head hits (canvas.js:488), handle hits (canvas.js:496), vertex hits (canvas.js:505), and the draw-tool close/dedupe thresholds (canvas.js:417, 423). In `drawHandles` (canvas.js:277) and `drawVertices` (canvas.js:233), scale the drawn marker radius up ~1.5x when coarse so the visible target matches the hit target. No behavior change for fine pointers; the constants resolve to today's values.

48. **Tap-to-edit head modal (the section 6.7 fallback, finally built).** When a head is selected AND (`isCoarse()` OR `isNarrow()`), show an "Edit head" button (`#btnEditHead`, `btn-light btn-sm`, appended to the `#canvasTools` toolbar row, index.html:75-81, hidden otherwise); wire visibility into `selectHead` (app.js:39). Tapping it opens the existing modal (`openModal`, app.js:417, same `#modalOverlay`/`#modalBox` used by Sync settings and the flow calculator) with the selected head's precision fields: Zone, Type, X, Y, Radius, Arc start°, Arc end°, GPM, laid out with `.field-row`. Edits apply **live** on `change` (same `data-f` + `updateHeadField` + `saveState` + `drawYardCanvas` + `renderHeadsTable` pipeline as task 46), so the single action button is "Close"; there are no OK/Cancel semantics to get out of sync, matching how table edits already behave. Number inputs get `inputmode="decimal"` so phones show a numeric keyboard. Drag handles stay fully enabled on touch (task 47 makes them usable for rough moves); this modal is the precision path for arc/radius values that fingertips cannot hit exactly. Fine-pointer wide-viewport users never see the button (decision (d)).

49. **Narrow chrome polish, CSS only.** All inside the 700px query unless noted: header padding down to ~12px 14px and `.header-actions` gap tightened (buttons already wrap, index.html header + styles.css:24); `.mode-toolbar` becomes a no-wrap horizontal scroll row (`flex-wrap:nowrap; overflow-x:auto`) matching how `nav.tabs` already behaves (styles.css:43), so the five mode buttons stop stacking into a tall block; `main` padding to 14px 12px and `.card` padding to 14px; **form controls (`input`, `select`) get `font-size:16px`** inside the query, which is the standard fix for iOS Safari auto-zooming the page when focusing a sub-16px input, easily the most annoying current phone behavior. Separately, in an `@media (pointer: coarse)` block: `button{min-height:42px}` and `td .btn-sm` padding bumped so tap targets clear ~40 px. Nothing outside these two queries changes.

50. **Verification pass (the constraint check).** Two halves. **Desktop unchanged:** on a fine-pointer machine at >700px widths (check ~981px and ~1280px), confirm zero visual or behavioral difference: table layouts, canvas heights still exactly 560/480, handle hit feel, no "Edit head" button, no card list. **Phone works:** devtools iPhone-size pass plus one real phone (same spirit as task 29's cross-browser list): add a head, edit it end-to-end via the card list and via the Edit-head modal, drag a head and its radius/arc handles by finger, draw and close a yard-zone polygon, run the calibration flow, and walk every tab confirming the read-mostly tables scroll horizontally without the page itself scrolling sideways. Add a short "using it on a phone" note to the README's usage section (card list + Edit head modal).

**Trace:** canvas height fix (45), heads-table replacement (46), touch-target sizing (47), the 6.7 popover fallback (48), header/toolbar behavior on narrow (49), the desktop-untouched guarantee (50); task 44 is shared plumbing for all of them.

### 8.3 Needs design discussion first — do NOT implement

Same treatment as sections 6 and 7.3: framed questions, not specs.

**8.3.1 How much should the head cards diverge from the desktop table?** Three coherent levels: (i) **recommended,** primary fields visible + audit fields behind a "More" expander (task 46 as written), which keeps every field editable on the phone while keeping cards short; (ii) all 16 fields always visible per card, simplest to build but each card becomes a full screen tall and the list becomes a scroll slog; (iii) read-only summary cards where all editing goes through the task 48 modal, cleanest visually but makes bulk audit edits (walking the yard marking "Replace?") two taps per field instead of one. If Alex expects to do the walk-the-yard audit workflow on his phone, (i) is the right call and (iii) is wrong; confirm which fields belong in "primary" (proposed: Type, X, Y, Radius, Arc start, Arc end, GPM, on the theory that geometry is what you tweak while looking at the yard).

**8.3.2 Desktop letterbox for flat yards.** Task 45's aspect-fit height would also *improve* desktop for very wide, shallow yards (an 80x20 yard currently floats in a 560 px-tall letterbox), but applying it above the breakpoint violates this phase's desktop-untouched constraint, so it is gated off. If Alex looks at task 45's result and wants aspect-fit everywhere, that is a one-line gate removal, but it is his call to make after seeing it, not a default.

**8.3.3 Edit-head modal on desktop.** Currently invisible to fine-pointer wide-viewport users (decision (d)). Some desktop users might still prefer a focused editor over hunting the 17-column row. Leaving it hidden costs nothing and honors the constraint; surfacing it later is trivial (drop the gate on the button). Recommend deciding after the phone version exists.

**8.3.4 `#zoneTable` cards.** 8 columns, editable, borderline. The recommendation is to ship this phase with it still scrolling horizontally and let real phone use decide; if editing zone run times from the phone turns out to be a common action (plausible, it is the knob people twist most), give it a slimmed version of the task 46 card treatment as a follow-up task. Do not build it speculatively.

> **STOP / CONFIRM WITH ALEX** closes this phase as it opened it: nothing in 8.3 becomes code without an explicit go-ahead, and task 50's desktop-unchanged check is the acceptance gate for the whole phase.

---

## 9. Phase 9 Addendum — Post-Phase-8 phone-use follow-ups

**Prepared:** July 18, 2026, from Alex's hands-on phone use after Phase 8 shipped, plus one small fix and one research item.
**Code-verified against:** commit `8a968d2` ("Mobile UI changes") plus the working tree's single uncommitted `app.js` change (the `attachHeadFieldHandlers` `syncList` parameter from Phase 8 modal work). Every file/line reference below was checked against that working tree; where the incoming report and the code disagreed, the code won and the discrepancy is noted, same rule as section 7. Notable corrections: `renderZoneSummary` spans app.js:887-949 (not ~907-928; the crowded cell is app.js:928), `renderUsage` is app.js:953-973, the seed heads are app.js:1045-1046, and the About tab's "Your data" block is index.html:260-261.

Phase 8's work (viewport.js, `responsiveCanvasHeight`, the head cards, coarse-pointer targets, the edit-head modal) is done and is not being redesigned here; every task below is a follow-up on top of it. Phase 8's non-negotiable constraint carries forward: the desktop layout stays pixel-identical, with everything new gated inside the narrow/coarse queries (new CSS goes under a `/* --- Phase 9 additions --- */` comment). The standing STOP rules at the end of section 4 remain in force.

### 9.1 STOP / CONFIRM WITH ALEX before starting

> Decisions needed up front:
> (a) Task 51: where Export JSON / Import JSON live on narrow screens. **Option B (recommended):** relocate them into the About tab's "Your data" section, which already narrates exactly what they do. **Option A:** an overflow "⋮ More" menu in the header, shown only under 700px. If B, one sub-choice: show the About-tab buttons at **all widths (recommended;** the pixel-identical constraint is about the header, and a real button where the text currently name-drops "Export JSON" in bold is a small desktop win**)**, or gate them to narrow-only for the strictest reading of the Phase 8 convention.
> (b) Task 54: what the forecast zone-row label says once the "(base X min)" text moves into the tooltip. **Recommended: keep the literal "Zone N",** preserving Phase 7 task 40 / decision 7.2(d) that zone names stay out of the visible UI. If Alex's phrasing "put the Zone name" means he now wants the stored `name` field surfaced here, that is an explicit reversal of that decision and must be confirmed as such, not assumed from wording.

### 9.2 Ordered tasks (numbering continues from task 50)

51. **Declutter the narrow header bar.** Verified premise: `.header-actions` (index.html:19-26) holds the save-status text plus New / Export JSON / Import JSON / Sync at every width; the 700px query (styles.css:190-203) only tightens header padding (styles.css:193) and gap (styles.css:194), hiding nothing, so the row wraps against the logo on a phone. Per Alex: Export JSON and Import JSON move off the visible bar on narrow screens; **New, Sync, and the save-status text stay.** Wiring lives in `wireHeaderActions` (app.js:977-989).
    - **Option B (recommended, decision (a)):** inside the 700px query add `#btnExport, #btnImportTrigger{display:none;}`. In the About tab's "Your data" block (h3 at index.html:260, paragraph at 261) add a small button row: `<button class="btn-light btn-sm" id="btnExportAbout">Export JSON</button>` and `<button class="btn-light btn-sm" id="btnImportTriggerAbout">Import JSON</button>`, wired in `wireHeaderActions` to the same `exportJSON` handler and the same `document.getElementById("btnImport").click()` trigger. The hidden file input (index.html:24) is already `display:none` globally (styles.css:39) and serves both triggers; no second input. Why B: zero new UI machinery, and export/import are rare, deliberate backup actions that can live one tab away.
    - **Option A:** append a `#btnMore` ("⋮ More", `btn-ghost btn-sm`) to `.header-actions`, `display:none` outside the 700px query; tapping it opens the shared modal (`openModal`, app.js:505, `#modalOverlay`/`#modalBox`, index.html:267-269) containing Export / Import buttons calling the same handlers, plus Close. Keeps the actions reachable without leaving the current tab, at the cost of a new menu pattern for exactly two items.
    - Either way the desktop header renders pixel-identically: every change is inside the 700px query (plus, under Option B all-widths, the additive About-tab buttons).

52. **Coverage heatmap fit on phones: lower the heat canvas ceiling; the breakpoints were not the problem.** Two things verified against the code before touching anything:
    - The 980px and 700px breakpoints **do** cooperate: at any width at or below 700px, the separate 980px query (styles.css:59) has long since stacked `.grid.cols-2` (index.html:182) into one column, heatmap card above Zone summary. Card stacking is not the gap; do not condition it on `isNarrow()`.
    - The actual gap is the ceiling in `responsiveCanvasHeight` (canvas.js:54-60, applied to `#heatCanvas` at canvas.js:623): `clamp(fit, 240, innerHeight*0.65)` budgets nothing for what shares the screen with the canvas. On a ~390x664 phone viewport the ceiling is ~430px, but the heatmap card adds its own h2, legend (index.html:189-191), model caption (index.html:192), and padding (~130px together), and above it sit the header, tabs, and the controls card (index.html:166-180), whose toolbar wraps to 2-3 rows at phone width. Any yard deep enough to reach the ceiling (heightFt/widthFt above roughly 1.3) therefore can never be seen whole.
    Fix, keeping the mechanism: parameterize the cap, `responsiveCanvasHeight(canvas, staticH, maxFrac)`. `#yardCanvas` keeps 0.65 (canvas.js:154; precision editing there wants the size, and scrolling is acceptable). `#heatCanvas` passes ~0.45 (canvas.js:623), yielding ~300px on a 664px viewport, so the whole map plus legend and caption fit one screenful once the card is scrolled to the top. The 240 floor stays (on short landscape viewports the cap may undercut the floor; let the cap win so the canvas shrinks rather than overflows). Optional, same query: `#tab-coverage .toolbar .field{min-width:0;}` so the two selects share a row and the controls card shortens; nice-to-have, not required. Verify on a devtools iPhone preset **and Alex's real phone with his actual yard** (his yard's aspect is what exposed this); confirm desktop still renders 480 exactly at >700px, which the `isNarrow()` early-return (canvas.js:55) already guarantees.

53. **Zone Summary: move the Avg-cell annotation into a tooltip.** Verified premise: `#zoneSummaryTable` and `#usageTable` share the same generic `.table-wrap` (styles.css:83) with no distinct styling, so the difference Alex sees is content density. The sprinkler-zone variant's Avg in/wk cell (app.js:928) packs `fmt(weeklyAvg,2)` plus an inline `/ target X · Y/wk` muted span, held to one line by the global `white-space:nowrap` (styles.css:79); `renderUsage` (app.js:953-973) is five plain columns. Change app.js:928 to render just the number, with the annotation as a `title` tooltip on that `<td>` (e.g. `target 1.00"/wk at 3.5 cycles/wk`; mind the inch quote inside the HTML attribute, use `&quot;` or `escapeHtml`), the same pattern as the forecast zone-row tooltip (forecast.js:214). The Status badge is already its own column (app.js:929) and is unchanged. **Premise correction:** the yard-zone-grouped variant (app.js:894-908) was checked and has no analogous crowded cell; its seven columns are already plain numbers, so it needs no change. Honest trade to note in the commit: `title` tooltips do not surface on touch, so on the phone the target/cycles detail becomes invisible rather than relocated; nothing is lost from the app (Target and Schedule remain editable and visible in the Zones table) and the same trade was already accepted for the forecast baseline tooltip. Per Alex, this is explicitly **not** a card-list conversion.

54. **7-day outlook: shorten row labels into tooltips.** Two changes in `renderForecast` (forecast.js:172-231), both verified at the stated lines:
    - **(a)** The first-column label `Net need (ET0 - rain x eff)` (forecast.js:223) becomes `Net need`, with the formula moved to a tooltip on that cell: `<td title="ET0 - rain x eff">Net need</td>`, matching the zone-label tooltip pattern (forecast.js:214). Keep the string ASCII (hyphen, `x`); the task 10 em-dash CI grep covers `docs/`.
    - **(b)** Drop the visible `<span class="muted">(base ${z.runTimeMin} min)</span>` from the zone-row label (forecast.js:214). **Confirmed trap:** `baseTip` (forecast.js:201) today covers only weeklyTargetIn / cycles / baseline and does NOT include `runTimeMin`, so removing the visible text without extending the tooltip would silently lose that number; append it, e.g. `· base run time ${z.runTimeMin} min`. Also update the `#forecastNote` copy (forecast.js:228-230), which currently says "hover the zone label for its baseline daily need", to say baseline and base run time. The label text itself is decision (b): recommended stays `Zone ${zi + 1}`.

55. **Seed heads: empty Notes.** In `init()`'s first-load seeding (app.js:1043-1048), drop the `notes: "example; edit or delete me"` key from both `addHead` calls (app.js:1045-1046); `addHead`'s defaults (app.js:196) already give `notes: ""`. The seeding condition (`state.heads.length === 0 && !localStorage.getItem(SEEDED_KEY)`, app.js:1043) is untouched, and existing users are unaffected (their `SEEDED_KEY` is set, so this path never re-runs).

**Trace:** Alex's items 1-5 map to tasks 51-55 respectively; item 6 is section 9.3.

### 9.3 Research: automatic satellite-image pull (comparison, not tasks)

Section 1.3 chose screenshot-upload + two-point calibration and deferred evaluating free-tile alternatives "with terms of use to be re-verified at that time." This is that evaluation, done July 18, 2026, for the four sources Alex named. Same treatment as section 1's hosting/persistence comparisons: verdicts and a recommendation, **not coded tasks.** Per the standing STOP rules (section 4 (a)/(b)), nothing here gets implemented without Alex's explicit go-ahead, and whatever is chosen, **the manual upload+calibrate path stays untouched; any automatic pull is additive.**

**What any source must satisfy** (from section 1.3 plus how the background layer actually works):

1. Callable from static client-side JS on GitHub Pages; this app has zero backend and that does not change.
2. No payment method on file, ever; the exact disqualifier that ruled out Google Maps.
3. **CORS headers on the imagery responses.** This one is load-bearing and easy to miss: the app persists the background as a compressed JPEG data URL (`compressImageFile`, canvas.js:596-613; background block, state.js:47). Drawing a fetched image into a canvas and calling `toDataURL` requires the response to carry `Access-Control-Allow-Origin`, otherwise the canvas is tainted and export throws. "Has a tile URL" is not enough.
4. ToS must permit **persistent client-side storage** of the imagery. A localStorage data URL is storage, not transient caching, so tile-caching restrictions in commercial ToS apply directly.

**Mapbox Satellite: disqualified.** As of 2026 a credit card is required at signup to activate the free tier ("no no-card sandbox"), which is criterion 2, the same rule that removed Google. Moot but for the record: the free tier itself is generous (200,000 Static Tiles requests/month, ~50,000 map loads), imagery is sharp and recent, and calls are plain key-in-URL client-side fetches; however Mapbox's terms also restrict long-term tile caching, which the data-URL persistence model would collide with (criterion 4). Two independent failures.

**Esri World Imagery (ArcGIS Location Platform free tier): viable but not chosen.** The free tier requires an account and an API key but **no card** (a payment method is needed only to enable pay-as-you-go beyond the free tier), and includes 2,000,000 basemap tiles/month, absurd headroom for 5 users. It is the sharpest imagery of the four for US residential addresses (Maxar/Vexcel collections, commonly ~7-30cm in populated areas, refreshed every 1-3 years). Three strikes keep it second: (1) an API key embedded in a public static site must be referrer-restricted and becomes one more credential and account for Alex to own (standing rule (a) territory); (2) attribution is contractually required on the displayed map; (3) Esri's terms prohibit systematic tile export / offline storage outside sanctioned flows (their "World Imagery (for Export)" layer via ArcGIS apps), and this app's whole model is storing the image permanently as a data URL, at best a gray area (criterion 4). **Documented fallback** if NAIP resolution proves unusable in practice and Alex accepts the account + key + ToS caveats with eyes open.

**USGS / NAIP via The National Map: recommended.** Verified live during this planning pass, not just from docs:

- `https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?bbox=<lon/lat box>&bboxSR=4326&size=<w,h>&format=jpg&f=image` returns a single JPEG for an **arbitrary bbox at an arbitrary pixel size**, keyless; tested HTTP 200 with `Access-Control-Allow-Origin: *`.
- `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}` is the XYZ tile-cache alternative, same open CORS, cache levels to LOD 23, service metadata reporting "Data refreshed June, 2024."
- No account, no key, no card, and the imagery is **public domain** (USDA/USGS federal work): no attribution obligation (a courtesy "Imagery: USDA NAIP via USGS The National Map" caption is good manners), and, uniquely among the four, permanently storing the image as a data URL is unambiguously fine. Criteria 1-4 all pass. No published rate limits; it is a shared federal service, so the integration should be one `exportImage` call per fetch, not tile hammering.
- **The honest cost is resolution and recency.** NAIP is 0.3-0.6m ground resolution on a 2-3 year state-by-state cycle (recent acquisitions run roughly half the states at 30cm, half at 60cm). At 60cm (~2 ft/px) an 80ft yard spans only ~40 source pixels: lot lines, driveways, and beds are legible; individual sprinkler heads are not. That is noticeably softer than the ~7-15cm imagery in a Google Maps screenshot, and up to ~3 years stale. The manual screenshot path therefore remains the quality path; this is the convenience path.
- **Integration shape (the decisive win): no calibration step at all.** Because the client chooses the bbox, the scale is exactly known: request a box centered on the yard's latitude/longitude spanning the yard dimensions plus margin, at a pixel size inside the existing compress budget, then `scaleFtPerPx = bboxWidthFt / imageWidthPx`, `offsetXFt = offsetYFt = 0`, `rotationDeg = 0` (`exportImage` returns north-up, axis-aligned imagery in the requested spatial reference). That fills every field of the background block (state.js:47) directly; the existing opacity/nudge/remove controls and manual re-calibration work on it unchanged. Latitude/longitude can come from the Forecast tab's saved coordinates or its "📍 Use my location" geolocation (index.html:227-234, forecast.js:53-65), so **no geocoder is needed for v1.** If typing a street address is ever wanted: the US Census geocoder was tested during this pass and sends **no CORS headers** (browser-blocked, so it is out); OSM Nominatim advertises CORS support and a light usage policy but must be re-verified at implementation time.

**OpenAerialMap: not viable as a default.** Keyless, free, CC-BY 4.0, genuinely open, and the tooling (catalog API + tiler) is client-callable; but the catalog is volunteer and disaster-response scenes, coverage is a patchwork concentrated where humanitarian mapping happened, and a typical US residential address has **no imagery at all.** Fine as an opportunistic extra source someday; useless as the backing service for a "fetch my yard" button.

**Recommendation:** an additive "Fetch satellite image" action backed by NAIP `exportImage`, next to (never replacing) Upload image, auto-filling scale/offset/rotation as above, with manual two-point calibration still available to re-align it or to calibrate manual screenshots exactly as today. It is the rare integration satisfying the standing STOP rules with zero accounts and zero payment surface. Per those rules and Alex's instruction it is still **not** scoped into numbered tasks here; if Alex confirms, it becomes its own set of tasks with the additive-only constraint restated on each.

> **STOP / CONFIRM WITH ALEX** closes this phase as it opened it: decisions (a) and (b) gate tasks 51 and 54, and nothing in 9.3 becomes code without an explicit go-ahead.

## 10. Phase 10 Addendum — CSV grid import/export for yard zones and dead spaces

**Prepared:** July 20, 2026, from Alex wanting a spreadsheet-based alternative for entering yard zones and dead spaces alongside (not instead of) the existing "+ Yard zone" / "+ Dead space" polygon-drawing tools on the yard preview.
**Code-verified against:** commit `c677ff9` ("Set deployed Apps Script sync endpoint URL"). File/line references below were checked against that commit.

The freehand polygon tools (canvas.js's `yardzone`/`deadspace` draw modes, index.html:77-78) are unchanged and stay the primary/only way to draw non-rectangular shapes. This phase adds a second, spreadsheet-based path: export the yard as a CSV grid, fill in cells by hand, re-upload, and the app turns the grid back into `yardZones`/`deadSpaces` entries. Three open questions were put to Alex before writing these tasks; all were resolved recommended-option:

- **Row orientation:** the CSV mirrors the on-screen preview. Row 1 is the header (blank corner cell, then `1..widthFt` left to right). Row 2 (first data row) is the **far/top edge of the yard**, i.e. `y = heightFt`; the last row is `y = 1`, the near edge. Column A holds the y label for each data row, descending. This matches `toPx`'s existing flip (canvas.js:99-102: pixel-up is feet-up, `h - y`), so the sheet reads the same way the canvas draws.
- **Shape fidelity:** cells are decomposed into axis-aligned rectangles (scanline run-merge, spec'd in task 58), not traced into arbitrary polygons. This is a deliberate simplification: it needs no hole-in-polygon handling and no diagonal-adjacency logic, at the cost of shapes always being blocky/stair-stepped through the grid rather than smooth. Anyone wanting a smooth/angled shape still uses the polygon tool.
- **Size mismatch on import:** if the CSV's header extents don't match the current `state.yard.widthFt`/`heightFt` (rounded to the nearest foot), reject the whole import with a specific error naming both sizes; never auto-resize the yard from an uploaded file.

### 10.1 CSV format spec (for both directions)

- **Dimensions:** `W = Math.round(state.yard.widthFt)`, `H = Math.round(state.yard.heightFt)`. This is independent of `state.yard.cellSizeFt` (state.js:94, the separate 1-10ft coverage-heatmap resolution, app.js:77-82) — the grid is always 1 square foot per cell, matching the 1ft snap already used for hand-drawn polygon vertices (canvas.js:456).
- **Header row (row 1):** `""`, then `1, 2, ..., W` across columns B..(W+1).
- **Data rows (rows 2..H+1):** column A is the y label, `H, H-1, ..., 1` top to bottom (row 2 = y=H, the far edge; last data row = y=1). Columns B..(W+1) hold the cell token for `(x, y)` where `x` = column position (1..W), `y` = that row's label.
- **Cell tokens:** blank = no yard zone / no dead space (plain turf). `y<N>` (case-insensitive, e.g. `y1`, `y2`) = yard zone. `d<N>` (e.g. `d1`, `d2`) = dead space. A cell holds at most one token — yard zones and dead spaces are mutually exclusive per cell in the CSV (freehand polygons can still overlap on the canvas; that overlap is lossy through export, see task 57).
- **Legend footer (export only, ignored on import):** one blank row after the grid (row H+3), then one line per existing `yardZones`/`deadSpaces` entry: `y1, <name>` / `d1, <label> (<kind>)`. Import always reads exactly rows 1..(H+1) and columns 1..(W+1) by position — it never scans for a separator — so this footer (or anything else a spreadsheet program appends) is automatically ignored.

### 10.2 Ordered tasks (numbering continues from task 55)

56. **New pure module `docs/js/gridcsv.js`.** Keep the same separation the rest of the app uses (state/coverage/canvas/schedule/usage/forecast/sync/viewport, each imported into app.js as the composition root, app.js:9-27) — no DOM access in this module, just data in/data out, so it's easy to unit-test in isolation the way `tests/` already exercises the other pure modules. Export two functions:
    - `buildGridCsv(state)` -> CSV string (task 57).
    - `parseGridCsv(text, state)` -> `{ yardZones, deadSpaces }` on success, or throws an `Error` with a user-facing message on any validation failure (task 58). Throwing (rather than returning an error shape) matches the existing `coerceToV2`/`importJSONFile` convention (state.js:296-311, catches and `alert()`s `err.message`).

57. **`buildGridCsv(state)`.** For each of the `W*H` cells (cell centers at `(x-0.5, y-0.5)` in feet, matching `cellInPolygon`'s `(c+0.5)*cell` convention at app.js:891-892 adapted to 1ft cells), determine its token:
    - Test `state.deadSpaces` in array order with `pointInPolygon` (coverage.js:147-156, already exported and imported by app.js:15) against each `.polygon`; first match wins, token is `d<index+1>`.
    - Else test `state.yardZones` in array order the same way; first match wins, token is `y<index+1>`.
    - Else blank.
    - Dead space intentionally wins over yard zone on overlap (matches existing semantics: `renderZoneSummary`'s `notDead(r,c) && cellInPolygon(...)`, app.js:900-908, already subtracts dead cells from a yard zone's stats regardless of whether the two polygons visually overlap). Note in the commit message that overlapping same-type zones/dead-spaces are lossy on export (first-in-array wins) — this only matters for freehand-drawn overlaps, which are rare and already an edge case the UI itself warns about (index.html "Overlapping zones each count the shared cells", app.js:915).
    - Assemble the CSV per the 10.1 spec (row/column order, legend footer using each entry's existing `name`/`label`+`kind`). Use `\r\n` or `\n` line endings consistently and quote any legend name containing a comma (existing `name`/`label` fields are free text, e.g. via the Yard zones table's name input, app.js:403).
    - Wire to a new button; download via the same `Blob` + `URL.createObjectURL` + temporary-`<a>` pattern as `exportJSON` (state.js:285-294), filename `sprinkler-simulator-yard-grid-${stamp}.csv` (same date-stamp convention, state.js:290).

58. **`parseGridCsv(text, state)` — the rectangle-decomposition importer.** Steps, in order, each failure throwing a specific message (don't silently partial-import):
    - Parse CSV into rows (a minimal comma-split honoring double-quoted fields is enough; no cell value or legend name in this feature needs embedded commas on the *import* side since tokens are simple `y1`/`d2` strings — quoting only matters for the legend, which import ignores).
    - Read `W` from row 1's header cells, `H` from the count/labels of data rows actually needed — but per the locked-in decision, **don't infer W/H from the file**; require the file's header row and column-A labels to match `Math.round(state.yard.widthFt)`/`heightFt` exactly (row 1 must be `1..W`, column A of rows 2..H+1 must be `H..1` descending). On any mismatch, throw naming both the file's apparent size and the current yard size, e.g. `"CSV is 55 wide but the yard is set to 50 ft wide. Resize the yard or fix the CSV, then re-upload."`
    - Validate every non-blank cell in the W×H data block matches `/^[yd]\d+$/i`; on the first bad value, throw naming the cell (e.g. by its `x,y` feet coordinate) and the bad text.
    - Build `mask[token] = Set of {x,y}` cells for every distinct token seen.
    - For each token, run scanline rectangle decomposition to turn its cell set into 1+ axis-aligned rectangles: process y from `H` down to `1` (or any fixed order — direction doesn't matter for correctness); for each row compute the token's maximal contiguous x-runs; keep a working list of "open" rectangles keyed by `(xStart,xEnd)`; a run matching an open rectangle's `(xStart,xEnd)` extends it one more row, a run that doesn't match starts a new open rectangle, and any open rectangle not matched by the current row closes (emits a finalized rectangle spanning its accumulated y-range); close all remaining open rectangles after the last row. This is a standard, deterministic technique (histogram/run-merge rectangle decomposition) — it needs no connectivity/flood-fill step and handles disjoint blocks and "holes" punched by a different token (e.g. a dead space carved out of a yard zone's rectangle) automatically, since it only ever looks at where the token itself appears.
    - Each emitted rectangle for token `y<N>`/`d<N>` becomes one polygon: `[[xStart-1,yStart-1],[xEnd,yStart-1],[xEnd,yEnd],[xStart-1,yEnd]]` in feet (mind the off-by-one: cell column `c` spans feet `[c-1, c]`, so a rectangle covering columns `xStart..xEnd` spans feet `xStart-1` to `xEnd`; likewise rows/y).
    - Group resulting rectangles by token, sort tokens by their numeric suffix ascending, and build the replacement arrays in that order (so token numbering is stable across an export/import/export round-trip, since export assigns `y<index+1>` positionally). For a **new** token number, default `name`/`label` to `"Area " + N` / `"Dead space " + N"` (matching the existing freehand-draw defaults, canvas.js:465/467) and `kind: "other"` for dead spaces (the grid has no way to express `kind`; call this out as a known limitation — the user can still edit `kind` afterward in the Dead spaces table, app.js:420-423). Assign `color` from `AREA_PALETTE` (canvas.js:49) cycling by the yard zone's position in the new array, same as canvas.js:464. Multiple rectangles from the same token share the same `name`/`color` but get distinct `id`s via `uid("yz")`/`uid("ds")` (state.js:28, matching the prefixes already used at canvas.js:465/467) — each is a separate entry in `yardZones`/`deadSpaces`, so `renderZoneSummary`'s per-yard-zone rows (app.js:902-916) will show one row per rectangle, not per token; acceptable and worth a one-line note in the commit rather than solved here.

59. **Wire up the UI.** In the "Yard preview" card (index.html:72-109), add a small toolbar under the existing grid/radius-circle checkboxes (after index.html:98, before the `<div class="divider">` at index.html:99): two buttons "Export grid CSV" / "Import grid CSV" plus a hidden `<input type="file" accept=".csv,text/csv">`, and one `<p class="hint">` line explaining the `y1`/`d1` token scheme and that it replaces the current yard zones/dead spaces entirely. Handlers in app.js (near `wireHeaderActions`/the existing `btnImport` wiring, app.js:987-997, for stylistic consistency):
    - Export button calls `buildGridCsv(getState())`, downloads it — no confirmation needed, it's non-destructive.
    - Import: on file selection, read as text, call `parseGridCsv(text, getState())` inside a `try/catch`. On failure, `alert(err.message)` (matching `importJSONFile`'s pattern, state.js:306-308) and do nothing further. On success, `confirm()` first — mirroring the existing `btnNew` confirm text style (app.js:997) — e.g. `` `Replace the current ${state.yardZones.length} yard zone(s) and ${state.deadSpaces.length} dead space(s) with the ${n} from this file?` ``; if confirmed, set `state.yardZones`/`state.deadSpaces` to the parsed result, `saveState(true)`, `renderAreaLists()` (app.js:394) and `drawYardCanvas()` (canvas.js:155) to refresh both the tables and the preview.

60. **Tests.** `tests/` already exercises the other pure modules (per Phase 0's safety net, section 4) — add coverage for `gridcsv.js` alongside them: round-trip a hand-built `yardZones`/`deadSpaces` state through `buildGridCsv` -> `parseGridCsv` and check the rectangles reproduce the same cell coverage (not necessarily the same vertex count, since decomposition can split a shape into multiple rectangles); a case with a dead space fully inside a yard zone's bounding box (the "hole" case); a case with two disjoint blocks sharing one token; and the three rejection paths (bad token, wrong width, wrong height).

**Trace:** all of section 10 maps to Alex's CSV-grid request; the three resolved decisions are recorded inline in the phase preamble rather than as a separate STOP block, since they were already confirmed before this section was written.
