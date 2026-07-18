# Deploying the cloud-sync backend (Google Apps Script)

The sync layer is **optional**. The app is fully usable without it (localStorage
autosave plus JSON export/import). Set this up only if you want a handful of
people to save their yard config to the cloud and reload it on another device.

Everything here happens in **your own Google account**. It is free, needs no
payment method, and does not pause when idle.

## 1. Create the Sheet

1. Go to <https://sheets.google.com> and create a new blank spreadsheet.
2. Name it something like `Sprinkler Simulator Sync`.
3. You don't need to add any tabs or headers by hand; the script creates a
   `configs` tab with the header row on first use.

## 2. Add the script

1. In that spreadsheet: **Extensions -> Apps Script**.
2. Delete the placeholder `myFunction` code.
3. Copy the entire contents of `apps-script/Code.gs` from this repo and paste it in.
4. Click **Save** (the disk icon).
5. Select the `setup` function in the toolbar dropdown and click **Run** once.
   Approve the permissions prompt (it needs access to this one spreadsheet).
   This creates the `configs` tab.

## 3. Deploy as a web app

1. Click **Deploy -> New deployment**.
2. Click the gear next to "Select type" and choose **Web app**.
3. Set:
   - **Description**: `sprinkler sync`
   - **Execute as**: **Me**
   - **Who has access**: **Anyone**  (required so the browser can call it; the
     per-user key is what protects each row)
4. Click **Deploy**, approve any prompt, and **copy the Web app URL**. It ends in
   `/exec`. That is the endpoint you paste into the app's Sync settings.

## 4. Redeploying after a code change (the gotcha)

Editing `Code.gs` does **not** update the live `/exec` URL by itself. After
changing the code:

- **Deploy -> Manage deployments -> (your deployment) -> Edit (pencil) ->
  Version: New version -> Deploy.**

Using "New version" keeps the **same** `/exec` URL, so you don't have to hand out
a new endpoint. If you instead create a brand-new deployment you'll get a new
URL and have to update everyone.

## 5. Hand out keys

Give each person a short random passphrase as their key, e.g. `blue-otter-4821`.
They enter it once in the app's Sync settings along with the `/exec` URL; it's
stored in their browser. Each key maps to one row in the Sheet, which doubles as
a human-readable admin view of everyone's saved config.

## Notes / limits

- The satellite **background image is never synced** (a Sheet cell caps at 50,000
  characters; a base64 image blows past that). Calibration numbers (scale, offset,
  rotation) *are* synced, so re-attaching the same screenshot on a second device
  restores alignment. See PLAN.md section 1.2 / 6.3.
- Latency is ~1-3 seconds per call. Sync is explicit (Save / Load buttons) plus an
  auto-pull on load, never per-keystroke.
- Quotas (thousands of calls/day) are far beyond what five users saving a config a
  few times a week will ever hit.
- If Apps Script ever becomes annoying, the documented fallback is "localStorage +
  JSON export/import only," which always works because sync is a bolt-on layer.
