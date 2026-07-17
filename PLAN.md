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
