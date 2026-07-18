/**
 * Sprinkler Simulator - cloud sync backend (Google Apps Script web app).
 *
 * One Google Sheet, one tab ("configs"), one row per user:
 *   key | config_json | updated_at_iso | note
 *
 * Protocol (PLAN.md section 1.2), designed to avoid CORS preflight:
 *   GET  ?key=XXX                      -> { config, updatedAt } or { error:"not_found" }
 *   POST body (text/plain, JSON string):
 *        { key, config, baseUpdatedAt } -> { updatedAt }
 *        ...or if baseUpdatedAt is stale: { conflict:true, updatedAt, config }
 *
 * The client POSTs with Content-Type text/plain (body is still JSON) and sets no
 * custom headers, so the browser sends a "simple" request with no preflight.
 * Apps Script answers a 302 that fetch() follows automatically.
 *
 * Deploy per apps-script/DEPLOY.md. This file has NO secrets; access control is
 * the per-user random key (security-by-obscurity, accepted for this threat model).
 */

var SHEET_NAME = "configs";
var HEADERS = ["key", "config_json", "updated_at_iso", "note"];

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
  }
  return sh;
}

/** Run once from the editor after first paste to create the tab + header row. */
function setup() {
  getSheet_();
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function findRow_(sh, key) {
  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) { // row 0 is the header
    if (String(values[i][0]) === String(key)) return { rowIndex: i + 1, row: values[i] };
  }
  return null;
}

function doGet(e) {
  try {
    var key = e && e.parameter && e.parameter.key;
    if (!key) return json_({ error: "missing_key" });
    var sh = getSheet_();
    var found = findRow_(sh, key);
    if (!found) return json_({ error: "not_found" });
    return json_({
      config: JSON.parse(found.row[1] || "null"),
      updatedAt: found.row[2] || null,
      note: found.row[3] || "",
    });
  } catch (err) {
    return json_({ error: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var key = body.key;
    if (!key) return json_({ error: "missing_key" });
    var sh = getSheet_();
    var found = findRow_(sh, key);
    var nowIso = new Date().toISOString();

    if (found) {
      var storedUpdatedAt = found.row[2] || null;
      // Conflict check: refuse if the caller's base doesn't match what's stored.
      if (body.baseUpdatedAt && storedUpdatedAt && body.baseUpdatedAt !== storedUpdatedAt) {
        return json_({ conflict: true, updatedAt: storedUpdatedAt, config: JSON.parse(found.row[1] || "null") });
      }
      sh.getRange(found.rowIndex, 2).setValue(JSON.stringify(body.config));
      sh.getRange(found.rowIndex, 3).setValue(nowIso);
      if (body.note != null) sh.getRange(found.rowIndex, 4).setValue(String(body.note));
    } else {
      sh.appendRow([key, JSON.stringify(body.config), nowIso, body.note || ""]);
    }
    return json_({ updatedAt: nowIso });
  } catch (err) {
    return json_({ error: String(err) });
  }
}
