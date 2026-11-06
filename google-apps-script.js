/**
 * LabTrack — Google Apps Script Backend
 *
 * Deploy this as a Web App from your Google Sheet:
 *   Extensions → Apps Script → paste this code → Deploy → Web App
 *   Execute as: Me | Who has access: Anyone
 *
 * Google Sheet must have these tabs (column order matters for write operations):
 *   Items      — id | name | cat | qty | unit | loc | minQty | img | desc | status | usedBy | serial | displayId | shared | consumable
 *   Deliveries — id | item | qty | unit | from | receivedBy | date | tracking | status
 *   Checkouts  — id | itemId | item | user | out | ret | status | checkedOutByEmail | groupEmails
 *   Orders     — id | store | item | link | qty | unit | price | cat | requestedBy | reason | urgency | date | status | requestedByEmail
 *   Settings   — key | value
 *   DeleteLog  — date | type | name | details | deletedBy
 *   SlackQueue — time | emoji | title | details | fields  (auto-created; used by digest mode)
 *
 * TRIGGERS to set up (Extensions → Apps Script → Triggers):
 *   sendDailyDigest   → Time-driven → Day timer → 5pm–6pm (set script timezone to America/New_York)
 *   checkOverduesAndAlert → Time-driven → Day timer → 8am–9am (morning check)
 */

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const ALLOWED_DOMAIN = "engineering.upenn.edu";
const SLACK_WEBHOOK_URL = PropertiesService.getScriptProperties().getProperty("SLACK_WEBHOOK_URL") || "YOUR_SLACK_WEBHOOK_URL_HERE";

// ─── SLACK HELPER ────────────────────────────────────────────────────────────
// slack_mode in Settings tab: "all" | "important" | "digest" | "off"
// "important" = only deletions, urgent/high orders, overdue returns
// "digest" = queues to SlackQueue tab, sent by daily trigger (sendDailyDigest)
function getSlackMode() { return String(readSettings_().slack_mode || "all").trim(); }

function sendSlack(emoji, title, details, fields, priority) {
  try { return sendSlackInternal_(emoji,title,details,fields,priority); } catch(e) { console.log("Slack notification failed (data saved): "+e.message); }
}
function sendSlackInternal_(emoji, title, details, fields, priority) {
  if (!SLACK_WEBHOOK_URL || SLACK_WEBHOOK_URL === "YOUR_SLACK_WEBHOOK_URL_HERE" || SLACK_WEBHOOK_URL === "") return;
  var mode = getSlackMode();
  if (mode === "off") return;
  // priority: "high" for deletions, urgent orders, overdue; "normal" for everything else
  var isHigh = (priority === "high");
  if (mode === "important" && !isHigh) return;
  if (mode === "digest") {
    // Queue it instead of sending immediately (high-priority still sends now)
    var queue = getOrCreateSheet("SlackQueue", ["time", "emoji", "title", "details", "fields"]);
    queue.appendRow([new Date().toISOString(), emoji, title, details || "", JSON.stringify(fields || [])]);
    if (!isHigh) return; // high-priority also sends immediately
  }
  try {
    var blocks = [
      { type: "section", text: { type: "mrkdwn", text: emoji + " *" + title + "*" } }
    ];
    if (details) blocks.push({ type: "section", text: { type: "mrkdwn", text: details } });
    if (fields && fields.length > 0) {
      blocks.push({ type: "section", fields: fields.map(function(f) { return { type: "mrkdwn", text: f }; }) });
    }
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "LabTrack · " + new Date().toLocaleString() }] });
    UrlFetchApp.fetch(SLACK_WEBHOOK_URL, {
      method: "post", contentType: "application/json",
      payload: JSON.stringify({ text: emoji + " " + title, blocks: blocks }),
      muteHttpExceptions: true,
    });
  } catch (e) {
    console.log("Slack error (non-fatal): " + e.message);
  }
}

// ─── DIGEST HELPERS ──────────────────────────────────────────────────────────
function getPendingOrders_() {
  var sheet = getSheet("Orders");
  if (!sheet) return [];
  var data = sheetToJson(sheet);
  return data.filter(function(o){ return o.status==="Pending"||o.status==="Approved"||o.status==="Ordered"; });
}

function getOverdueCheckouts_() {
  var sheet = getSheet("Checkouts");
  if (!sheet) return [];
  var data = sheetToJson(sheet);
  var today = Utilities.formatDate(new Date(), "America/New_York", "yyyy-MM-dd");
  return data.filter(function(c){ return c.status==="Active" && c.ret && String(c.ret).slice(0,10) < today; });
}

function getLowStockItems_() {
  var sheet = getSheet("Items");
  if (!sheet) return [];
  var data = sheetToJson(sheet);
  return data.filter(function(i){ return i.qty!==undefined && i.minQty!==undefined && Number(i.minQty) > 0 && Number(i.qty) <= Number(i.minQty); });
}

// Sort orders so Urgent/High come first
function sortOrdersByUrgency_(list) {
  return list.slice().sort(function(a, b) {
    var aH = (a.urgency === "Urgent" || a.urgency === "High") ? 0 : 1;
    var bH = (b.urgency === "Urgent" || b.urgency === "High") ? 0 : 1;
    return aH - bH;
  });
}

// Format a single order line with urgency badge inline
function formatOrderLine_(o) {
  var badge = (o.urgency === "Urgent") ? "🚨 " : (o.urgency === "High") ? "⚠️ " : "";
  var parts = [badge + "*" + o.item + "*  " + o.qty + " " + (o.unit || "")];
  if (o.store) parts.push(o.store);
  if (o.price) parts.push(o.price);
  if (o.link)  parts.push("<" + o.link + "|link>");
  return "• " + parts.join(" | ");
}

// ─── DAILY DIGEST (Trigger: sendDailyDigest → Day timer → 5pm–6pm, timezone: America/New_York) ─
function sendDailyDigest() {
  if (!SLACK_WEBHOOK_URL || SLACK_WEBHOOK_URL === "YOUR_SLACK_WEBHOOK_URL_HERE") return;

  var now = new Date();
  var dateStr = now.toLocaleDateString("en-US", {weekday:"long", month:"short", day:"numeric", year:"numeric"});

  var pending   = getPendingOrders_();
  var overdues  = getOverdueCheckouts_();
  var lowStock  = getLowStockItems_();

  // Queue (today's activity log)
  var queue = getSheet("SlackQueue");
  var queuedRows = [];
  if (queue) {
    var qd = queue.getDataRange().getValues();
    if (qd.length > 1) queuedRows = qd.slice(1);
  }

  var blocks = [
    { type: "header", text: { type: "plain_text", text: "📊 LabTrack Daily Summary — " + dateStr, emoji: true } },
    { type: "divider" }
  ];

  // ── Orders: grouped by stage so PI sees exactly what action is needed ──
  var needsApproval    = pending.filter(function(o){ return o.status === "Pending"; });
  var needsOrdering    = pending.filter(function(o){ return o.status === "Approved"; });
  var awaitingDelivery = pending.filter(function(o){ return o.status === "Ordered"; });

  if (pending.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "🛒 *Orders:* No active orders" } });
  } else {
    // 1 — Needs Approval (Pending): PI must act
    if (needsApproval.length > 0) {
      var approvalList = sortOrdersByUrgency_(needsApproval);
      var approvalText = approvalList.slice(0, 8).map(formatOrderLine_).join("\n");
      if (needsApproval.length > 8) approvalText += "\n_…and " + (needsApproval.length - 8) + " more_";
      blocks.push({ type: "section", text: { type: "mrkdwn", text: "🔔 *Needs Approval (" + needsApproval.length + ")*\n" + approvalText } });
    }

    // 2 — Approved / Needs Ordering: approved but not yet purchased
    if (needsOrdering.length > 0) {
      var orderingList = sortOrdersByUrgency_(needsOrdering);
      var orderingText = orderingList.slice(0, 8).map(formatOrderLine_).join("\n");
      if (needsOrdering.length > 8) orderingText += "\n_…and " + (needsOrdering.length - 8) + " more_";
      blocks.push({ type: "section", text: { type: "mrkdwn", text: "🛍️ *Approved — Place Order (" + needsOrdering.length + ")*\n" + orderingText } });
    }

    // 3 — Ordered / Awaiting Delivery: already purchased, just waiting
    if (awaitingDelivery.length > 0) {
      var deliveryList = sortOrdersByUrgency_(awaitingDelivery);
      var deliveryText = deliveryList.slice(0, 8).map(formatOrderLine_).join("\n");
      if (awaitingDelivery.length > 8) deliveryText += "\n_…and " + (awaitingDelivery.length - 8) + " more_";
      blocks.push({ type: "section", text: { type: "mrkdwn", text: "📬 *Ordered — Awaiting Delivery (" + awaitingDelivery.length + ")*\n" + deliveryText } });
    }
  }

  // ── Overdue checkouts ──
  if (overdues.length > 0) {
    var odText = overdues.map(function(o){
      return "• *" + o.item + "* — " + o.user + " (due " + String(o.ret).slice(0,10) + ")";
    }).join("\n");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "🔴 *Overdue Checkouts (" + overdues.length + ")*\n" + odText } });
  } else {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "✅ *Checkouts:* No overdue items" } });
  }

  var upcomingReservations = rows_("Reservations").filter(function(r){ return r.status === "Booked" && r.end > new Date().toISOString() && r.start < new Date(Date.now()+86400000).toISOString(); });
  if (upcomingReservations.length) {
    var itemNames = {}; rows_("Items").forEach(function(i){ itemNames[String(i.id)] = i.name + " [" + i.displayId + "]"; });
    blocks.push({type:"section",text:{type:"mrkdwn",text:"📅 *Equipment reservations — next 24 hours*\n"+upcomingReservations.slice(0,8).map(function(r){return "• *"+(itemNames[r.itemId]||r.itemId)+"* — "+r.user+" | "+localOf_(r.start)+" → "+localOf_(r.end)+" ET";}).join("\n")}});
  }

  // ── Low stock ──
  if (lowStock.length > 0) {
    var lsText = lowStock.slice(0,6).map(function(i){
      return "• *" + i.name + "* — " + i.qty + "/" + i.minQty + " " + i.unit + " (reorder needed)";
    }).join("\n");
    if (lowStock.length > 6) lsText += "\n_…and " + (lowStock.length-6) + " more_";
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "📦 *Low Stock (" + lowStock.length + ")*\n" + lsText } });
  }

  // ── Today's activity: count by type only (no listing individual events) ──
  if (queuedRows.length > 0) {
    var counts = {};
    queuedRows.forEach(function(r) {
      var emoji = String(r[1]).trim();
      counts[emoji] = (counts[emoji] || 0) + 1;
    });
    var countLine = Object.keys(counts).map(function(e){ return e + " ×" + counts[e]; }).join("  ·  ");
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "Today's activity: " + countLine + "  (" + queuedRows.length + " total)" }] });
  }

  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "LabTrack · Auto-digest · " + now.toLocaleString("en-US",{timeZone:"America/New_York"}) + " ET" }] });

  try {
    var digestResponse = UrlFetchApp.fetch(SLACK_WEBHOOK_URL, {
      method: "post", contentType: "application/json",
      payload: JSON.stringify({ text: "📊 LabTrack Daily Summary — " + dateStr, blocks: blocks }),
      muteHttpExceptions: true,
    });
    if(digestResponse.getResponseCode() >= 300) throw new Error("Slack returned HTTP "+digestResponse.getResponseCode());
  } catch(e) { console.log("Digest send failed: " + e.message); throw e; }

  // Clear queue
  if (queue && queuedRows.length > 0) {
    var qdata = queue.getDataRange().getValues();
    if (qdata.length > 1) queue.deleteRows(2, qdata.length - 1);
  }
}

// Admin can trigger manually (via UI button → doPost "sendDigest")
function sendManualDigest() { sendDailyDigest(); }

// ─── SETUP TRIGGERS (run once from the Apps Script editor) ───────────────────
// Run this function manually from the editor to create both time-based triggers.
// Requires: Project Settings → Time zone = America/New_York
// After running, verify in Triggers tab (clock icon on left sidebar).
function createTriggers() {
  // Remove any existing triggers for these functions to avoid duplicates
  ScriptApp.getProjectTriggers().forEach(function(t) {
    var fn = t.getHandlerFunction();
    if (fn === "sendDailyDigest" || fn === "checkOverduesAndAlert" || fn === "backupSpreadsheet") {
      ScriptApp.deleteTrigger(t);
    }
  });
  // Daily digest at 5pm (script timezone must be America/New_York)
  ScriptApp.newTrigger("sendDailyDigest")
    .timeBased()
    .atHour(17)
    .everyDays(1)
    .create();
  // Overdue alert at 8am
  ScriptApp.newTrigger("checkOverduesAndAlert")
    .timeBased()
    .atHour(8)
    .everyDays(1)
    .create();
  // Weekly backup every Sunday at 3am
  ScriptApp.newTrigger("backupSpreadsheet")
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(3)
    .create();
  Logger.log("✅ Triggers created (digest, overdue alert, weekly backup). Verify in Triggers tab. Time zone must be America/New_York.");
}

// ─── SPREADSHEET BACKUP ──────────────────────────────────────────────────────
// Copies the entire spreadsheet into a "LabTrack Backups" folder in Google Drive.
// Keeps the most recent BACKUP_KEEP_COUNT copies and trashes the rest.
// Called automatically every Sunday at 3am (set up via createTriggers()),
// or manually via the "Backup Now" button in the admin UI.
function backupSpreadsheet() {
  var BACKUP_KEEP_COUNT = 12; // keep ~3 months of weekly backups
  var FOLDER_NAME = "LabTrack Backups";

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ssFile = DriveApp.getFileById(ss.getId());

  // Place backup folder next to the spreadsheet (or in root if no parent)
  var parents = ssFile.getParents();
  var parentFolder = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();

  // Find or create the backup folder
  var backupFolder;
  var folders = parentFolder.getFoldersByName(FOLDER_NAME);
  if (folders.hasNext()) {
    backupFolder = folders.next();
  } else {
    backupFolder = parentFolder.createFolder(FOLDER_NAME);
  }

  // Name the backup with a timestamp (no colons — not allowed in Drive file names)
  var now = new Date();
  var pad = function(n) { return String(n).padStart(2, "0"); };
  var dateStr = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
  var timeStr = pad(now.getHours()) + "h" + pad(now.getMinutes());
  var backupName = "LabTrack Backup " + dateStr + " " + timeStr;

  ssFile.makeCopy(backupName, backupFolder);

  // Prune: keep only the most recent BACKUP_KEEP_COUNT files
  var files = [];
  var iter = backupFolder.getFiles();
  while (iter.hasNext()) {
    var f = iter.next();
    files.push({ file: f, date: f.getDateCreated() });
  }
  files.sort(function(a, b) { return b.date - a.date; }); // newest first
  for (var i = BACKUP_KEEP_COUNT; i < files.length; i++) {
    files[i].file.setTrashed(true);
  }

  // Record last backup time in Settings sheet
  var displayTime = dateStr + " " + pad(now.getHours()) + ":" + pad(now.getMinutes());
  var settingsSheet = getSheet("Settings");
  if (settingsSheet) {
    var sData = settingsSheet.getDataRange().getValues();
    var found = false;
    for (var j = sData.length - 1; j >= 0; j--) {
      if (String(sData[j][0]) === "last_backup") {
        settingsSheet.getRange(j + 1, 2).setValue(displayTime);
        found = true;
        break;
      }
    }
    if (!found) settingsSheet.appendRow(["last_backup", displayTime]);
  }

  sendSlack("💾", "Weekly Backup Complete", null, [
    "*File*\n" + backupName,
    "*Location*\n" + FOLDER_NAME,
    "*Kept*\n" + Math.min(files.length, BACKUP_KEEP_COUNT) + " backups"
  ]);
  Logger.log("✅ Backup created: " + backupName + " → " + FOLDER_NAME);
  return backupName;
}

// ─── OVERDUE ALERT (Trigger: checkOverduesAndAlert → Day timer → 8am–9am) ────
function checkOverduesAndAlert() {
  var overdues = getOverdueCheckouts_();
  if (overdues.length === 0) return;
  var text = overdues.map(function(o){
    return "• *" + o.item + "* — " + o.user + " (due " + String(o.ret).slice(0,10) + ")";
  }).join("\n");
  sendSlack("🔴", "Overdue Checkouts (" + overdues.length + ")", text, [], "high");
}

// ─── TOKEN VERIFICATION ──────────────────────────────────────────────────────
function verifyToken(token) {
  if (!token || token === "local") return null;
  try {
    const resp = UrlFetchApp.fetch(
      "https://oauth2.googleapis.com/tokeninfo?id_token=" + token
    );
    const payload = JSON.parse(resp.getContentText());
    if (payload.hd !== ALLOWED_DOMAIN || payload.aud !== "253618186533-8b7mt0hgcgdb4qlh8tg2admilfifuhgq.apps.googleusercontent.com" || String(payload.email_verified) !== "true") return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// ─── ADMIN CHECK ─────────────────────────────────────────────────────────────
function isAdmin(email) { return settingList_("admins").includes(email); }
function isMember(email) { var members = settingList_("members"); return !members.length || members.includes(email); }
// ─── DELETE LOG ──────────────────────────────────────────────────────────────
function logDeletion(type, name, details, deletedBy) {
  var sheet = getOrCreateSheet("DeleteLog", ["date", "type", "name", "details", "deletedBy"]);
  var now = new Date();
  var dateStr = now.toISOString().slice(0, 19).replace("T", " ");
  sheet.appendRow([dateStr, type, name, details, deletedBy]);
  sendSlack("🗑️", type + " Deleted: " + name, null, ["*Deleted by*\n" + deletedBy, "*Details*\n" + details], "normal");
}

// ─── AUDIT LOG ───────────────────────────────────────────────────────────────
// Logs every significant write action for accountability / troll detection.
// Columns: date | user | email | action | details
function logAudit(userName, userEmail, action, details) {
  var sheet = getOrCreateSheet("AuditLog", ["date", "user", "email", "action", "details"]);
  var now = new Date();
  var dateStr = now.toISOString().slice(0, 19).replace("T", " ");
  sheet.appendRow([dateStr, userName || "", userEmail || "", action, details || ""]);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function getSheet(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

function getOrCreateSheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers && headers.length > 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
  }
  return sheet;
}

function sheetToJson(sheet, suppliedData) {
  if (!sheet) return [];
  const data = suppliedData || sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      let val = row[i] == null ? "" : row[i];
      if (h === "usedBy") {
        if (typeof val === "string") {
          try { val = JSON.parse(val); } catch(e) { val = []; }
        }
        // Always ensure usedBy is a clean array of non-empty strings
        if (!Array.isArray(val)) val = [];
        else val = val.filter(function(x){ return x != null && x !== ""; });
      }
      if (["qty", "minQty"].includes(h) && val !== "") {
        val = Number(val);
      }
      if (["id", "itemId", "orderId", "receiptId"].includes(h)) { val = String(val); }
      if (["shared", "consumable"].includes(h)) val = val === true || String(val).toLowerCase() === "true";
      // Ensure text fields are strings — Sheets auto-detects numbers in text cells
      // (e.g. a serial number "12345678" returns as the JS number 12345678)
      var textFields = ["name","loc","cat","desc","serial","unit","status","displayId","tags","item","store","requestedBy","reason","link","from","receivedBy","tracking"];
      if (textFields.indexOf(h) >= 0 && typeof val !== "string") {
        val = val == null ? "" : String(val);
      }
      // Normalize datetime fields — Sheets auto-converts "YYYY-MM-DD HH:MM" strings to Date objects
      if (["out","ret"].includes(h)) {
        if (val instanceof Date) {
          val = val.getFullYear()+"-"+String(val.getMonth()+1).padStart(2,"0")+"-"+String(val.getDate()).padStart(2,"0")
               +" "+String(val.getHours()).padStart(2,"0")+":"+String(val.getMinutes()).padStart(2,"0");
        } else if (val != null && typeof val !== "string") { val = String(val); }
      }
      if (h === "date") {
        if (val instanceof Date) {
          val = val.getFullYear()+"-"+String(val.getMonth()+1).padStart(2,"0")+"-"+String(val.getDate()).padStart(2,"0");
        } else if (val != null && typeof val !== "string") { val = String(val); }
      }
      obj[h] = val;
    });
    return obj;
  });
}

function appendRow(sheetName, obj, headers) {
  const sheet = getSheet(sheetName);
  const actual = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const row = actual.map(h => cellValue_(obj[h]));
  sheet.appendRow(row);
  delete transactionalData_[sheetName];
  ["id", "itemId", "serial", "displayId"].forEach(h => {
    const col = actual.indexOf(h); if (col >= 0) sheet.getRange(sheet.getLastRow(), col + 1).setNumberFormat("@");
  });
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function idsMatch(sheetVal, targetId) {
  var a = String(sheetVal).trim();
  var b = String(targetId).trim();
  if (a === b) return true;
  try { if (Number(a) === Number(b) && !isNaN(Number(a))) return true; } catch(e) {}
  if (a.replace(/\.0+$/, "") === b.replace(/\.0+$/, "")) return true;
  return false;
}

// ─── GET ─────────────────────────────────────────────────────────────────────
function doGet(e) {
  transactionalData_ = {};
  apiModifiedSheets_ = {};
  try {
    const token = (e && e.parameter && e.parameter.token) || "";
    const user = verifyToken(token);
    if (!user) {
      return jsonResponse({ error: "Unauthorized", detail: "Token verification failed" });
    }
    if (!isMember(user.email)) {
      return jsonResponse({ error: "NotMember", detail: "Your account is not authorized to access this lab's system. Contact a lab admin." });
    }

    var settings = readSettings_();
    if (e.parameter.action === "listReservations") return jsonResponse(listReservations_(e.parameter));
    return jsonResponse({
      items: sheetToJson(getSheet("Items")),
      deliveries: sheetToJson(getSheet("Deliveries")),
      checkouts: sheetToJson(getSheet("Checkouts")),
      orders: sheetToJson(getSheet("Orders")),
      settings: settings,
      capabilities: capabilities_(),
      reservations: currentReservations_(),
      migration: migrationReport_(),
      userRole: isAdmin(user.email) ? "admin" : "member",
    });
  } catch (err) {
    return jsonResponse({ error: "Server error", detail: err.message });
  }
}

// ─── POST ────────────────────────────────────────────────────────────────────
function doPost(e) {
  transactionalData_ = {};
  apiModifiedSheets_ = {};
  var writeLock = LockService.getScriptLock();
  try {
  writeLock.waitLock(30000);
  const body = JSON.parse(e.postData.contents);
  const user = verifyToken(body.token);
  if (!user) {
    return jsonResponse({ error: "Unauthorized", detail: "Token verification failed for POST" });
  }
  if (!isMember(user.email)) {
    return jsonResponse({ error: "NotMember", detail: "Your account is not authorized to access this lab's system." });
  }

  const action = body.action;
  const userEmail = user.email || "";
  const userName = user.name || userEmail;
  const admin = isAdmin(userEmail);

  var upgraded = handleV2_(action, body, user, admin);
  if (upgraded !== null) return jsonResponse(upgraded);

  // ── Add Item ──────────────────────────────────────────────────────────────
  if (action === "addItem") {
    {
      const it = body.item;
      it.id = requireId_(it.id);
      it.createdAt = new Date().toISOString();
      validateItem_(it);
      if(it.link && !capabilities_().receiving) throw new Error("Run the V2 migration before saving purchase links");
      var prior = sheetToJson(getSheet("Items")).find(x => String(x.id) === String(it.id));
      if (prior) return jsonResponse({ok:true, displayId:prior.displayId, item:prior});
      // Always generate displayId server-side (inside the lock) to prevent collisions.
      const allItems = sheetToJson(getSheet("Items"));
      const isSubId = /^.+-\d{3}$/.test(String(it.displayId||""));
      if (!isSubId) {
        // Regular item: global sequential 6-digit counter across all prefixes.
        const prefixMatch = String(it.displayId||"GEN-000000").match(/^([^-]+)-/);
        const prefix = prefixMatch ? prefixMatch[1] : "GEN";
        const maxNum = Math.max(0, ...allItems.map(function(i) {
          var m = String(i.displayId||"").match(/(\d{6})(?:-\d+)?$/);
          return m ? parseInt(m[1]) : 0;
        }));
        it.displayId = prefix + "-" + String(maxNum + 1).padStart(6, "0");
      } else {
        const requestedBase=String(it.displayId).replace(/-\d{3}$/, "");
        if(!allItems.some(i=>String(i.displayId||"").startsWith(requestedBase+"-"))) throw new Error("Use individual-unit creation to start a new labeled group.");
        // Sub-ID item (e.g. CE-000042-001): assign next available 3-digit suffix
        // for this base ID server-side so concurrent "Add Unit" calls can't collide.
        const baseId = String(it.displayId||"").replace(/-\d{3}$/, "");
        const maxSuffix = Math.max(0, ...allItems
          .filter(function(i) { return String(i.displayId||"").replace(/-\d{3}$/, "") === baseId; })
          .map(function(i) {
            var m = String(i.displayId||"").match(/-(\d{3})$/);
            return m ? parseInt(m[1]) : 0;
          })
        );
        it.displayId = baseId + "-" + String(maxSuffix + 1).padStart(3, "0");
      }
      appendRow("Items", it, [
        "id", "name", "cat", "qty", "unit", "loc", "minQty", "img", "desc", "status", "usedBy", "serial", "displayId", "shared", "consumable"
      ]);
      sendSlack("📦", "New Item Added: " + it.name, null, ["*Category*\n" + (it.cat||"—"), "*Qty*\n" + (it.qty||0) + " " + (it.unit||""), "*Location*\n" + (it.loc||"—"), "*Added by*\n" + userName]);
      logAudit(userName, userEmail, "AddItem", it.name + " | qty:" + (it.qty||0) + " " + (it.unit||"") + " | cat:" + (it.cat||"") + " | id:" + (it.displayId||""));
      return jsonResponse({ ok: true, displayId: it.displayId, item:it });
    }
  }

  // ── Update Item ───────────────────────────────────────────────────────────
  if (action === "updateItem") {
    const it = body.item;
    validateMedia_(it);
    var previous = sheetToJson(getSheet("Items")).find(x => String(x.id) === String(it.id));
    if (!previous) throw new Error("Item not found");
    delete it.usedBy;
    if((it.status||previous.status)==="On loan") {
      const borrower=String(it.loanBorrower===undefined?(previous.usedBy||[]).join(", "):it.loanBorrower).trim();
      if(!borrower) throw new Error("Record who has this equipment on loan");
      it.usedBy=[borrower];
    } else if(previous.status==="On loan"&&it.status) it.usedBy=[];
    validateItem_(Object.assign({}, previous, it));
    protectReservations_(previous, it);
    const sheet = getSheet("Items");
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idCol = headers.indexOf("id");
    const fields = ["name", "cat", "qty", "unit", "loc", "minQty", "img", "desc", "status", "serial", "displayId", "shared", "consumable", "link", "usedBy"];

    for (let i = 1; i < data.length; i++) {
      if (idsMatch(data[i][idCol], it.id)) {
        // Batch update: build full row and write once instead of cell-by-cell
        var row = data[i].slice();
        fields.forEach(f => {
          const col = headers.indexOf(f);
          if (col >= 0 && it[f] !== undefined) row[col] = it[f];
        });
        if(capabilities_().receiving) {
          const patch={};fields.forEach(f=>{if(it[f]!==undefined)patch[f]=it[f];});
          atomicWrite_([{sheet:"Items",id:it.id,object:patch}]);
        } else fields.forEach(f=>{const col=headers.indexOf(f);if(col>=0&&it[f]!==undefined)sheet.getRange(i+1,col+1).setValue(it[f]);});
        logAudit(userName, userEmail, "UpdateItem", (it.name||"") + " | id:" + (it.displayId||it.id||""));
        return jsonResponse({ ok: true, item:findId_("Items",it.id) });
      }
    }
    return jsonResponse({ error: "Item not found", detail: "No item with id " + it.id });
  }

  // ── Delete Item (admin only) ──────────────────────────────────────────────
  if (action === "deleteItem") {
    if (!admin) {
      return jsonResponse({ error: "Forbidden", detail: "Only admins can delete items" });
    }
    const itemId = body.itemId;
    assertNoReservations_(itemId);
    const sheet = getSheet("Items");
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idCol = headers.indexOf("id");

    for (let i = 1; i < data.length; i++) {
      if (idsMatch(data[i][idCol], itemId)) {
        // Build details string from the row
        var rowObj = {};
        headers.forEach(function(h, ci) { rowObj[h] = data[i][ci]; });
        var itemName = rowObj.name || "Unknown";
        var details = "cat:" + (rowObj.cat||"") + " qty:" + (rowObj.qty||"") + " loc:" + (rowObj.loc||"") + " serial:" + (rowObj.serial||"");
        logDeletion("Item", itemName, details, userName);
        logAudit(userName, userEmail, "DeleteItem", itemName + " | " + details);
        sheet.deleteRow(i + 1);
        return jsonResponse({ ok: true });
      }
    }
    return jsonResponse({ error: "Item not found", detail: "No item with id " + itemId });
  }

  // ── Add Delivery ──────────────────────────────────────────────────────────
  if (action === "addDelivery") {
    const d = body.delivery;
    if(findId_("Deliveries",d.id)) return jsonResponse({ok:true});
    appendRow("Deliveries", d, [
      "id", "item", "qty", "unit", "from", "receivedBy", "date", "tracking", "status"
    ]);
    sendSlack("🚚", "Delivery Received: " + d.item, null, ["*Qty*\n" + d.qty + " " + d.unit, "*Supplier*\n" + (d.from||"—"), "*Received by*\n" + (d.receivedBy||userName), "*Tracking*\n" + (d.tracking||"—")]);
    logAudit(userName, userEmail, "AddDelivery", d.item + " × " + d.qty + " " + (d.unit||"") + " from " + (d.from||"—"));
    return jsonResponse({ ok: true });
  }

  // ── Add Checkout ──────────────────────────────────────────────────────────
  if (action === "addCheckout") {
    if (capabilities_().scheduling) throw new Error("Please refresh LabTrack and use reservations.");
    const c = body.checkout;
    if(findId_("Checkouts",c.id)) return jsonResponse({ok:true});
    const chosen = resolveLegacyItem_(c.itemId, c.item);
    if (!chosen) throw new Error("Select a specific item by label ID.");
    if(liveReservations_().some(r=>String(r.itemId)===String(chosen.id)&&r.end>new Date().toISOString())) throw new Error("This item has reservations; use the updated scheduling workflow.");
    c.itemId = String(chosen.id); c.checkedOutByEmail = userEmail;
    appendRow("Checkouts", c, [
      "id", "itemId", "item", "user", "out", "ret", "status", "checkedOutByEmail", "groupEmails"
    ]);
    updateItemStatus(c.itemId, "In Use", c.user, "add");
    sendSlack("🔑", "Item Checked Out: " + c.item, null, ["*Person*\n" + c.user, "*Date*\n" + (c.out||"—"), "*Return by*\n" + (c.ret||"—")]);
    logAudit(userName, userEmail, "Checkout", c.item + " → " + c.user + " | return by:" + (c.ret||"—"));
    return jsonResponse({ ok: true });
  }

  // ── Return Item ───────────────────────────────────────────────────────────
  if (action === "returnItem") {
    const coId = body.checkoutId;
    const sheet = getSheet("Checkouts");
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idCol = headers.indexOf("id");
    const statusCol = headers.indexOf("status");
    const retCol = headers.indexOf("ret");
    const itemCol = headers.indexOf("item");
    const userCol = headers.indexOf("user");

    for (let i = 1; i < data.length; i++) {
      if (idsMatch(data[i][idCol], coId)) {
        if(data[i][statusCol] === "Returned") return jsonResponse({ok:true});
        const coEmailCol = headers.indexOf("checkedOutByEmail");
        const groupEmailsCol = headers.indexOf("groupEmails");
        const coEmail = coEmailCol >= 0 ? String(data[i][coEmailCol] || "") : "";
        const groupEmailsStr = groupEmailsCol >= 0 ? String(data[i][groupEmailsCol] || "") : "";
        const groupList = groupEmailsStr.split(",").map(e => e.trim()).filter(Boolean);
        if (!admin && coEmail && userEmail !== coEmail && !groupList.includes(userEmail)) {
          return jsonResponse({ error: "Forbidden", detail: "Only the person who checked out this item, group members, or an admin can return it." });
        }
        const now = new Date();
        const nowStr = now.getFullYear()+"-"+String(now.getMonth()+1).padStart(2,"0")+"-"+String(now.getDate()).padStart(2,"0")
                      +" "+String(now.getHours()).padStart(2,"0")+":"+String(now.getMinutes()).padStart(2,"0");
        if (retCol >= 0) sheet.getRange(i + 1, retCol + 1).setValue(nowStr);
        sheet.getRange(i + 1, statusCol + 1).setValue("Returned");
        const itemName = data[i][itemCol];
        const returnedUser = data[i][userCol];
        const oldItemId = headers.indexOf("itemId");
        const resolved = resolveLegacyItem_(oldItemId >= 0 ? data[i][oldItemId] : "", itemName);
        if (resolved) updateItemStatus(resolved.id, "Available", returnedUser, "remove");
        sendSlack("✅", "Item Returned: " + itemName, null, ["*Returned by*\n" + userName]);
        logAudit(userName, userEmail, "Return", itemName + " | originally checked out by:" + returnedUser);
        break;
      }
    }
    return jsonResponse({ ok: true });
  }

  // ── Add Order ─────────────────────────────────────────────────────────────
  if (action === "addOrder") {
    const o = body.order;
    validateMedia_(o);
    if(o.img && !capabilities_().receiving) throw new Error("Run the V2 migration before saving order images");
    if (!String(o.item || "").trim() || !(Number(o.qty) > 0)) throw new Error("Item and positive quantity are required");
    var priorOrder = sheetToJson(getSheet("Orders")).find(x => String(x.id) === String(o.id));
    if (priorOrder) return jsonResponse({ok:true, order:priorOrder});
    o.id = requireId_(o.id); o.createdAt = new Date().toISOString();
    o.requestedByEmail = userEmail; o.requestedBy = userName; o.status = "Pending";
    appendRow("Orders", o, [
      "id", "store", "item", "link", "qty", "unit", "price", "cat", "requestedBy", "reason", "urgency", "date", "status", "requestedByEmail"
    ]);
    var linkText = o.link ? " | <" + o.link + "|Purchase Link>" : "";
    sendSlack("🛒", "New Order Request: " + o.item,
      "*Store:* " + (o.store||"—") + linkText,
      ["*Qty*\n" + o.qty + " " + o.unit, "*Urgency*\n" + (o.urgency||"Normal"), "*Price*\n" + (o.price||"—"), "*Requested by*\n" + userName],
      (o.urgency==="Urgent"||o.urgency==="High")?"high":"normal");
    logAudit(userName, userEmail, "AddOrder", o.item + " | " + (o.store||"—") + " | qty:" + o.qty + " | urgency:" + (o.urgency||"Normal"));
    return jsonResponse({ ok: true, order:o });
  }

  // ── Update Order ──────────────────────────────────────────────────────────
  if (action === "updateOrder") {
    const o = body.order;
    validateMedia_(o);
    if(o.qty !== undefined && (!Number.isFinite(Number(o.qty)) || Number(o.qty)<=0)) throw new Error("Order quantity must be positive");
    const sheet = getSheet("Orders");
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idCol = headers.indexOf("id");
    const fields = ["store","item","link","qty","unit","price","cat","requestedBy","reason","urgency","date","img"];
    for (let i = 1; i < data.length; i++) {
      if (idsMatch(data[i][idCol], o.id)) {
        const oldStatus = data[i][headers.indexOf("status")];
        if (oldStatus === "Received") throw new Error("Received orders are retained as purchase history; edit inventory metadata instead.");
        if (o.status !== undefined && o.status !== oldStatus) throw new Error("Use the admin status action; receiving requires confirmation.");
        const reqEmailCol = headers.indexOf("requestedByEmail");
        const reqEmail = reqEmailCol >= 0 ? String(data[i][reqEmailCol] || "") : "";
        if (!admin && reqEmail && userEmail !== reqEmail) {
          return jsonResponse({ error: "Forbidden", detail: "Only the person who submitted this order or an admin can edit it." });
        }
        var row = data[i].slice();
        fields.forEach(f => { const col = headers.indexOf(f); if (col >= 0 && o[f] !== undefined) row[col] = o[f]; });
        if(capabilities_().receiving) {
          const patch={};fields.forEach(f=>{if(o[f]!==undefined)patch[f]=o[f];});
          atomicWrite_([{sheet:"Orders",id:o.id,object:patch}]);
        } else fields.forEach(f=>{const col=headers.indexOf(f);if(col>=0&&o[f]!==undefined)sheet.getRange(i+1,col+1).setValue(o[f]);});
        logAudit(userName, userEmail, "UpdateOrder", (o.item||"") + " | store:" + (o.store||"—"));
        return jsonResponse({ ok: true, order:findId_("Orders",o.id) });
      }
    }
    return jsonResponse({ error: "Order not found" });
  }

  // ── Send Digest (admin only) ───────────────────────────────────────────────
  if (action === "sendDigest") {
    if (!admin) {
      return jsonResponse({ error: "Forbidden", detail: "Only admins can send digest" });
    }
    try { sendDailyDigest(); } catch(e) { return jsonResponse({ error: "Digest failed", detail: e.message }); }
    return jsonResponse({ ok: true });
  }

  // ── Update Order Status ───────────────────────────────────────────────────
  if (action === "updateOrderStatus") {
    if (!admin) return jsonResponse({error:"Forbidden", detail:"Only admins can change order status"});
    if (!["Pending", "Approved", "Ordered", "Rejected"].includes(body.status)) throw new Error("Use Receive to add stock and mark an order received.");
    const orderId = body.orderId;
    const newStatus = body.status;
    const sheet = getSheet("Orders");
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idCol = headers.indexOf("id");
    const statusCol = headers.indexOf("status");
    const itemCol = headers.indexOf("item");

    for (let i = 1; i < data.length; i++) {
      if (idsMatch(data[i][idCol], orderId)) {
        if (data[i][statusCol] === "Received") throw new Error("A received order cannot be reopened.");
        sheet.getRange(i + 1, statusCol + 1).setValue(newStatus);
        var orderItem = data[i][itemCol] || "";
        sendSlack("📋", "Order Status Updated: " + orderItem, null, ["*New Status*\n" + newStatus, "*Updated by*\n" + userName]);
        logAudit(userName, userEmail, "OrderStatus", orderItem + " → " + newStatus);
        return jsonResponse({ ok: true });
      }
    }
    return jsonResponse({ error: "Order not found", detail: "No order with id " + orderId });
  }

  // ── Delete Order (admin only) ─────────────────────────────────────────────
  if (action === "deleteOrder") {
    if (!admin) {
      return jsonResponse({ error: "Forbidden", detail: "Only admins can delete orders" });
    }
    const orderId = body.orderId;
    const existingOrder = sheetToJson(getSheet("Orders")).find(x => String(x.id) === String(orderId));
    if (existingOrder && existingOrder.receiptId) throw new Error("Received orders are retained for receipt history.");
    const sheet = getSheet("Orders");
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idCol = headers.indexOf("id");
    const itemCol = headers.indexOf("item");

    for (let i = 1; i < data.length; i++) {
      if (idsMatch(data[i][idCol], orderId)) {
        var orderName = data[i][itemCol] || "Unknown";
        logDeletion("Order", orderName, "id:" + orderId, userName);
        logAudit(userName, userEmail, "DeleteOrder", orderName);
        sheet.deleteRow(i + 1);
        return jsonResponse({ ok: true });
      }
    }
    return jsonResponse({ error: "Order not found", detail: "No order with id " + orderId });
  }

  // ── Save Settings (admin only) ────────────────────────────────────────────
  if (action === "saveSettings") {
    if (!admin) {
      return jsonResponse({ error: "Forbidden", detail: "Only admins can change settings" });
    }
    const key = body.key;
    if (["scheduling_enabled", "calendar_id", "schema_version"].includes(key)) throw new Error("Use the deployment setup functions to change scheduling configuration.");
    const value = body.value;
    var sheet = getOrCreateSheet("Settings", ["key", "value"]);
    var data = sheet.getDataRange().getValues();
    var found = false;
    for (var i = data.length - 1; i >= 0; i--) {
      if (String(data[i][0]) === String(key)) {
        sheet.getRange(i + 1, 2).setValue(value);
        found = true;
        break;
      }
    }
    if (!found) {
      sheet.appendRow([key, value]);
    }
    return jsonResponse({ ok: true });
  }

  // ── Log Edit Unlock (non-admin members only; admin skipped client-side) ────
  if (action === "logEditUnlock") {
    logAudit(userName, userEmail, "EditUnlock", "inventory editing unlocked");
    return jsonResponse({ ok: true });
  }

  // ── Generate Purchase Summary sheet ──────────────────────────────────────
  if (action === "generatePurchaseSummary") {
    var orders = body.orders || [];
    if (orders.length === 0) return jsonResponse({ error: "No orders provided" });

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetName = "Purchase Summary";

    // Remove existing sheet if present, then create fresh
    var existing = ss.getSheetByName(sheetName);
    if (existing) ss.deleteSheet(existing);
    var ps = ss.insertSheet(sheetName);

    // ── Header row (plain styling) ──
    var dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "MMMM d, yyyy");
    ps.getRange(1, 1, 1, 6).merge()
      .setValue("Purchase Summary — " + dateStr)
      .setFontWeight("bold").setFontSize(13);

    // ── Column headers (plain bold, default background) ──
    var headers = ["Qty", "Item", "Unit Price", "Total", "Purchase Link", "Store"];
    var hRow = ps.getRange(2, 1, 1, 6);
    hRow.setValues([headers]).setFontWeight("bold");

    // ── Data rows: qty and price as numbers; total and grand total as formulas ──
    var firstDataRow = 3;
    var dataRows = orders.map(function(o) {
      var qty = parseFloat(o.qty) || 0;
      var price = parseFloat(String(o.price || "").replace(/[^0-9.]/g, "")) || null;
      return [
        qty || o.qty || "",
        o.item || "",
        price !== null ? price : "",  // numeric — formatted as currency below
        "",                           // Total: filled with formula per row below
        o.link || "",
        o.store || ""
      ];
    });

    var lastDataRow = firstDataRow + dataRows.length - 1;

    if (dataRows.length > 0) {
      ps.getRange(firstDataRow, 1, dataRows.length, 6).setValues(dataRows);

      // Per-row total formulas: =A3*C3, =A4*C4, …
      for (var r = 0; r < dataRows.length; r++) {
        var rowNum = firstDataRow + r;
        ps.getRange(rowNum, 4).setFormula("=A" + rowNum + "*C" + rowNum);

        // Clickable hyperlink in Link column
        var link = dataRows[r][4];
        if (link && link.startsWith("http")) {
          ps.getRange(rowNum, 5).setFormula('=HYPERLINK("' + link.replace(/"/g, '""') + '","' + link.replace(/"/g, '""') + '")');
        }
      }

      // Format Unit Price (col C) and Total (col D) as currency
      ps.getRange(firstDataRow, 3, dataRows.length, 2)
        .setNumberFormat('"$"#,##0.00');
    }

    // ── Grand total row with SUM formula ──
    var totalRow = lastDataRow + 2;
    ps.getRange(totalRow, 1, 1, 3).merge().setValue("Grand Total").setFontWeight("bold").setHorizontalAlignment("right");
    ps.getRange(totalRow, 4)
      .setFormula("=SUM(D" + firstDataRow + ":D" + lastDataRow + ")")
      .setNumberFormat('"$"#,##0.00')
      .setFontWeight("bold");

    // ── Column widths and freeze ──
    ps.setColumnWidth(1, 50);   // Qty
    ps.setColumnWidth(2, 220);  // Item
    ps.setColumnWidth(3, 100);  // Unit Price
    ps.setColumnWidth(4, 90);   // Total
    ps.setColumnWidth(5, 320);  // Link
    ps.setColumnWidth(6, 120);  // Store
    ps.setFrozenRows(2);

    ss.setActiveSheet(ps);
    logAudit(userName, userEmail, "PurchaseSummary", orders.length + " items");
    return jsonResponse({ ok: true });
  }

  // ── Backup Now (admin only) ───────────────────────────────────────────────
  if (action === "backupNow") {
    if (!admin) return jsonResponse({ error: "Forbidden", detail: "Admin only" });
    var backupName = backupSpreadsheet();
    return jsonResponse({ ok: true, backupName: backupName });
  }

  return jsonResponse({ error: "Unknown action: " + action });
  } catch (err) {
    return jsonResponse({ error: "Request failed", detail: err.message });
  } finally { writeLock.releaseLock(); }
}

// ─── Update item status & usedBy in Items sheet ──────────────────────────────
function updateItemStatus(itemId, newStatus, userName, mode) {
  const sheet = getSheet("Items");
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const nameCol = headers.indexOf("id");
  const statusCol = headers.indexOf("status");
  const usedByCol = headers.indexOf("usedBy");

  const sharedCol = headers.indexOf("shared");
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][nameCol]) === String(itemId)) {
      var row = data[i].slice();
      const isShared = sharedCol >= 0 && (data[i][sharedCol] === true || String(data[i][sharedCol]).toLowerCase() === "true");
      if (!(newStatus === "In Use" && isShared)) row[statusCol] = newStatus;
      if (usedByCol >= 0) {
        let usedBy = [];
        try { usedBy = JSON.parse(data[i][usedByCol]) || []; } catch(e) {}
        if (mode === "add" && !usedBy.includes(userName)) usedBy.push(userName);
        else if (mode === "remove") usedBy = usedBy.filter(u => u !== userName);
        row[usedByCol] = JSON.stringify(usedBy);
      }
      sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
      break;
    }
  }
}

// ─── V2: additive schema, receipts and reservations ──────────────────────────
const LAB_TZ = "America/New_York";
const V2_HEADERS = {
  Items: ["link", "createdAt"], Orders: ["img", "receiptId", "createdAt"], Deliveries: ["orderId", "receiptId"],
  Receipts: ["id", "orderId", "itemIds", "quantities", "date", "email", "mode", "link", "img"],
  Reservations: ["id", "requestId", "seriesId", "itemId", "qty", "user", "email", "groupEmails", "start", "end", "originalEnd", "status", "notes", "eventId", "syncState", "syncError", "updatedAt"],
  Operations: ["id", "action", "result", "email", "date"]
};
function readSettings_() {
  const sheet = getSheet("Settings"), out = {};
  if (sheet) sheet.getDataRange().getValues().forEach(r => { if (r[0] && r[0] !== "key") out[String(r[0])] = r[1]; });
  return out;
}
function settingList_(key) {
  const value = readSettings_()[key];
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("Invalid " + key + " setting");
  return parsed;
}
function setSetting_(key, value) {
  const sheet = getOrCreateSheet("Settings", ["key", "value"]), rows = sheet.getDataRange().getValues();
  for (let i = rows.length - 1; i >= 0; i--) if (String(rows[i][0]) === key) { sheet.getRange(i + 1, 2).setValue(value); return; }
  sheet.appendRow([key, value]);
}
function capabilities_() {
  const s = readSettings_();
  return {version: Number(s.schema_version) || 1, receiving: Number(s.schema_version) >= 2,
    scheduling: String(s.scheduling_enabled) === "true" && !!s.calendar_id, calendarId: String(s.calendar_id || ""), timeZone: LAB_TZ};
}
function requireV2_() { if (!capabilities_().receiving) throw new Error("Admin must run migrateLabTrackV2 before using this feature."); }
function cellValue_(v) { return v == null ? "" : Array.isArray(v) ? JSON.stringify(v) : v; }
function validateMedia_(obj) {
  if (obj.link && !/^https?:\/\/[^\s]+$/i.test(String(obj.link))) throw new Error("Purchase link must be an http or https URL.");
  if (obj.img && (!/^https?:\/\/[^\s]+$/i.test(String(obj.img)) && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(String(obj.img)))) throw new Error("Choose a valid image file or http/https image URL.");
  if (String(obj.img || "").length > 49000) throw new Error("Image is too large. Please upload a smaller image.");
}
function validateItem_(it) {
  validateMedia_(it);
  if (!String(it.name || "").trim() || !Number.isFinite(Number(it.qty)) || Number(it.qty) < 0) throw new Error("Item name and nonnegative quantity are required.");
  if (!Number.isFinite(Number(it.minQty || 0)) || Number(it.minQty || 0) < 0) throw new Error("Minimum stock must be nonnegative.");
}
// SpreadsheetApp caches reads separately from the advanced Sheets service.
// Read-after-write uses the same API as writes, with a per-execution cache
// invalidated after each commit. Initial reads stay on SpreadsheetApp so polling
// does not consume the advanced API read quota. Never reuse a stale snapshot.
let transactionalData_ = {};
let apiModifiedSheets_ = {};
function transactionalSheetData_(name) {
  if (!transactionalData_[name]) {
    SpreadsheetApp.flush();
    transactionalData_[name] = apiModifiedSheets_[name]
      ? Sheets.Spreadsheets.Values.get(SpreadsheetApp.getActiveSpreadsheet().getId(), "'" + name.replace(/'/g, "''") + "'", {valueRenderOption:"UNFORMATTED_VALUE",dateTimeRenderOption:"FORMATTED_STRING"}).values || []
      : getSheet(name).getDataRange().getValues();
  }
  return transactionalData_[name];
}
function atomicWrite_(changes) {
  // Each entry is {sheet, object, id?}. All values use explicit types: no formula injection.
  const requests = changes.flatMap(c => {
    const sheet = getSheet(c.sheet), data = transactionalSheetData_(c.sheet), headers = data[0];
    const index = c.id == null ? -1 : data.findIndex((r, i) => i > 0 && String(r[headers.indexOf("id")]) === String(c.id));
    if (c.id != null && index < 0) throw new Error(c.sheet + " record no longer exists");
    const values = headers.map((h, i) => {
      const value = cellValue_(c.object[h] === undefined && index >= 0 ? data[index][i] : c.object[h]);
      const userEnteredValue = typeof value === "number" ? {numberValue: value} : typeof value === "boolean" ? {boolValue:value} : {stringValue:String(value)};
      return {userEnteredValue};
    });
    if (index < 0) return [{appendCells:{sheetId:sheet.getSheetId(), rows:[{values}], fields:"userEnteredValue"}}];
    return headers.flatMap((h,i)=>c.object[h]===undefined?[]:[{updateCells:{range:{sheetId:sheet.getSheetId(),startRowIndex:index,endRowIndex:index+1,startColumnIndex:i,endColumnIndex:i+1},rows:[{values:[values[i]]}],fields:"userEnteredValue"}}]);
  });
  if (requests.length) {
    SpreadsheetApp.flush();
    Sheets.Spreadsheets.batchUpdate({requests}, SpreadsheetApp.getActiveSpreadsheet().getId());
    changes.forEach(c => { delete transactionalData_[c.sheet]; apiModifiedSheets_[c.sheet] = true; });
  }
}
function auditChange_(user, action, details) {
  return {sheet:"AuditLog", object:{date:new Date().toISOString(), user:user.name || user.email, email:user.email, action, details}};
}
function newId_() { return Utilities.getUuid().replace(/-/g, ""); }
function rows_(name) { const sheet=getSheet(name); return sheet ? sheetToJson(sheet, transactionalSheetData_(name)) : []; }
function findId_(name, id) { return rows_(name).find(r => String(r.id) === String(id)); }
function requireId_(id) { if (!/^[a-zA-Z0-9_-]{1,100}$/.test(String(id || ""))) throw new Error("Missing or invalid request ID"); return String(id); }
function operation_(id, action, user) {
  const prior = findId_("Operations", requireId_(id));
  if (!prior) return null;
  if (prior.email !== user.email || prior.action !== action) throw new Error("Request ID already used");
  return JSON.parse(prior.result);
}
function operationChange_(id, action, user, result) {
  return {sheet:"Operations", object:{id, action, email:user.email, result:JSON.stringify(result), date:new Date().toISOString()}};
}
function nextLabel_(items, cat) {
  const prefix = String(cat || "GEN").split(/[^a-zA-Z]+/).filter(Boolean).map(w=>w[0]).join("").slice(0,5).toUpperCase() || "GEN";
  const max = Math.max(0, ...items.map(i=>{ const m=String(i.displayId||"").match(/(\d{6})(?:-\d{3})?$/); return m ? Number(m[1]) : 0; }));
  return prefix + "-" + String(max+1).padStart(6,"0");
}
function receiveOrder_(body, user, admin) {
  if (!admin) throw new Error("Only admins can receive orders");
  const order = findId_("Orders", body.orderId);
  if (!order) throw new Error("Order not found");
  if (order.receiptId) {
    const receipt = findId_("Receipts", order.receiptId);
    return {ok:true, receipt, order, items:JSON.parse(receipt.itemIds).map(id=>findId_("Items", id)), deliveries:rows_("Deliveries").filter(d=>d.receiptId===order.receiptId)};
  }
  if (order.status !== "Ordered") throw new Error("Only an Ordered request can be received. Legacy Received requests require admin reconciliation.");
  const f=body.item || {}, mode=body.mode || "new", receiptId=newId_(), items=rows_("Items"), changes=[], saved=[];
  if (!["new","individual","restock"].includes(mode)) throw new Error("Invalid receiving mode");
  if (!(Number(f.qty)>0) || !Number.isFinite(Number(f.qty))) throw new Error("Inventory quantity must be positive");
  if (mode === "restock") {
    const existing=findId_("Items",body.itemId);
    if (!existing) throw new Error("Choose an existing inventory item");
    if (f.unit !== existing.unit) throw new Error("Convert received quantity to the existing inventory unit: " + existing.unit);
    if (/^.+-\d{6}-\d{3}$/.test(existing.displayId || "")) throw new Error("Individually labeled units cannot be restocked; create new individual units.");
    const updated=Object.assign({},existing,{qty:Number(existing.qty)+Number(f.qty)});
    if(body.replaceMetadata) { updated.link=f.link || ""; updated.img=f.img || ""; }
    else { if(!updated.link) updated.link=order.link || ""; if(!updated.img) updated.img=order.img || ""; }
    validateItem_(updated); saved.push(updated); changes.push({sheet:"Items",id:existing.id,object:updated});
  } else {
    if (!String(f.loc||"").trim()) throw new Error("Location is required");
    const count=mode==="individual" ? Number(f.qty) : 1;
    if (!Number.isInteger(count) || count<1 || count>200 || (mode==="individual" && f.consumable)) throw new Error("Individual tracking requires 1–200 non-consumable units");
    const label=nextLabel_(items, f.cat || order.cat);
    for(let i=0;i<count;i++) {
      const item={id:newId_(),createdAt:new Date().toISOString(),name:String(f.name || order.item).trim(),cat:f.cat || order.cat,qty:mode==="individual"?1:Number(f.qty),unit:f.unit || order.unit,loc:String(f.loc).trim(),minQty:Number(f.minQty||0),img:f.img===undefined?order.img||"":f.img,link:f.link===undefined?order.link||"":f.link,desc:f.desc||"",status:"Available",usedBy:[],serial:mode==="individual"?(body.serials||[])[i]||"":f.serial||"",displayId:mode==="individual"?label+"-"+String(i+1).padStart(3,"0"):label,shared:!!f.shared,consumable:!!f.consumable};
      validateItem_(item); saved.push(item); changes.push({sheet:"Items",object:item});
    }
  }
  const delivery={id:newId_(),item:order.item,qty:Number(order.qty),unit:order.unit,from:order.store,receivedBy:user.name||user.email,date:Utilities.formatDate(new Date(),LAB_TZ,"yyyy-MM-dd"),tracking:body.tracking||"",status:"Logged",orderId:String(order.id),receiptId};
  const receipt={id:receiptId,orderId:String(order.id),itemIds:JSON.stringify(saved.map(i=>String(i.id))),quantities:JSON.stringify(saved.map(i=>mode==="restock"?Number(f.qty):i.qty)),date:new Date().toISOString(),email:user.email,mode,link:order.link||"",img:order.img||""};
  const updatedOrder=Object.assign({},order,{status:"Received",receiptId});
  changes.push({sheet:"Orders",id:order.id,object:updatedOrder},{sheet:"Deliveries",object:delivery},{sheet:"Receipts",object:receipt},auditChange_(user,"ReceiveOrder",order.item+" | receipt:"+receiptId));
  atomicWrite_(changes);
  sendSlack("🚚","Order Received: "+order.item,null,["*Qty*\n"+order.qty+" "+order.unit,"*Received by*\n"+(user.name||user.email),"*Inventory labels*\n"+saved.map(i=>i.displayId).join(", ")]);
  return {ok:true,receipt,order:updatedOrder,items:saved,deliveries:[delivery]};
}
function useConsumable_(body,user) {
  const old=operation_(body.requestId,"useConsumable",user); if(old) return {ok:true,item:findId_("Items",old.itemId || old.item.id)};
  const item=findId_("Items",body.itemId), qty=Number(body.qty);
  if(!item || !item.consumable || !Number.isFinite(qty) || qty<=0 || qty>Number(item.qty)) throw new Error("Choose an available consumable quantity");
  const updated=Object.assign({},item,{qty:Number(item.qty)-qty}), result={ok:true,item:updated};
  atomicWrite_([{sheet:"Items",id:item.id,object:updated},auditChange_(user,"UseConsumable",item.name+" | used:"+qty+" | itemId:"+item.id),operationChange_(body.requestId,"useConsumable",user,{ok:true,itemId:String(item.id)})]);
  return result;
}

// Wall time is resolved explicitly in the lab timezone. Reject nonexistent/ambiguous DST times.
function localInstant_(local) {
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local||"")) throw new Error("Enter a date and time");
  const base=Date.parse(local+":00Z"), matches=[];
  for(let hours=4;hours<=5;hours++) {
    const d=new Date(base+hours*3600000);
    if(Utilities.formatDate(d,LAB_TZ,"yyyy-MM-dd'T'HH:mm")===local) matches.push(d.toISOString());
  }
  if(matches.length!==1) throw new Error("This time is ambiguous or unavailable at the daylight-saving transition; choose another time.");
  return matches[0];
}
function shiftLocal_(local, days) { return new Date(Date.parse(local+":00Z")+days*86400000).toISOString().slice(0,16); }
function localOf_(iso) { return Utilities.formatDate(new Date(iso),LAB_TZ,"yyyy-MM-dd'T'HH:mm"); }
function buildOccurrences_(startLocal,endLocal,until) {
  const first=localInstant_(startLocal), last=localInstant_(endLocal);
  if(last<=first) throw new Error("End time must be after start time");
  if(until && (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until<startLocal.slice(0,10))) throw new Error("Choose a repeat end date on or after the first booking");
  if(until) localInstant_(until+"T12:00");
  const out=[];
  for(let n=0;n<53;n++) {
    const s=shiftLocal_(startLocal,n*7), e=shiftLocal_(endLocal,n*7);
    if(n && (!until || s.slice(0,10)>until)) break;
    if(n===52) throw new Error("Weekly series may contain at most 52 occurrences");
    out.push({start:localInstant_(s),end:localInstant_(e)});
  }
  return out;
}
function liveReservations_() { return rows_("Reservations").filter(r=>r.status==="Booked"); }
function assertCapacity_(item,candidates,others) {
  const intervals=others.concat(candidates).filter(r=>String(r.itemId)===String(item.id)&&r.status==="Booked");
  const points=[];
  intervals.forEach(r=>{points.push([Date.parse(r.start),Number(r.qty)]);points.push([Date.parse(r.end),-Number(r.qty)]);});
  points.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  let used=0;
  for(const p of points) { used+=p[1]; if(used>Number(item.qty)+1e-9) throw new Error("Booking conflict for "+(item.displayId||item.name)+" at "+localOf_(new Date(p[0]).toISOString())+". Available quantity would be exceeded."); }
}
function assertBookable_(item) {
  if(!item || item.consumable || Number(item.qty)<=0 || ["Maintenance","Broken","On loan"].includes(item.status)) throw new Error("This item is not available for reservations");
  const report=migrationReport_();
  if(report.blockedItemIds.includes(String(item.id))) throw new Error("An admin must reconcile this item's legacy checkout before booking.");
}
function protectReservations_(old,patch) {
  const bookings=liveReservations_().filter(r=>String(r.itemId)===String(old.id)&&r.end>new Date().toISOString());
  if(!bookings.length) return;
  const next=Object.assign({},old,patch);
  if(next.consumable || ["Maintenance","Broken","On loan"].includes(next.status) || next.unit!==old.unit || next.displayId!==old.displayId) throw new Error("Resolve upcoming reservations before changing tracking, unit, label, or maintenance status.");
  assertCapacity_(next,[],bookings);
}
function assertNoReservations_(id) {
  if((findId_("Items",id)||{}).status==="On loan") throw new Error("Record the return of this loan before deleting the item.");
  if(liveReservations_().some(r=>String(r.itemId)===String(id)&&r.end>new Date().toISOString())) throw new Error("Cancel future reservations before deleting this item.");
  if(rows_("Receipts").some(r=>JSON.parse(r.itemIds||"[]").includes(String(id)))) throw new Error("This item has receipt history; retain it with quantity zero or a maintenance status.");
}
function reservationOperation_(action,body,user,admin) {
  if(!capabilities_().scheduling && !["cancelReservation","finishReservation"].includes(action)) throw new Error("Scheduling is not enabled yet");
  const replay=operation_(body.requestId,action,user); if(replay) return Object.assign({},replay,{reservations:rows_("Reservations").filter(r=>replay.ids.includes(r.id))});
  const all=rows_("Reservations"), now=new Date().toISOString(); let changed=[];
  if(action==="createReservation") {
    const item=findId_("Items",body.itemId); assertBookable_(item);
    const qty=Number(body.qty); if(!Number.isFinite(qty)||qty<=0) throw new Error("Quantity must be positive");
    if(/^.+-\d{6}-\d{3}$/.test(item.displayId||"")&&qty!==1) throw new Error("An individually labeled unit must be booked as one whole unit");
    const dates=buildOccurrences_(body.startLocal,body.endLocal,body.repeatUntil||"");
    if(dates[0].start<now) throw new Error("Start time must be in the future");
    const group=String(body.groupEmails||"").split(",").map(s=>s.trim()).filter(Boolean);
    if(group.some(e=>!e.endsWith("@"+ALLOWED_DOMAIN)||!isMember(e))) throw new Error("Teammates must be authorized lab members");
    const seriesId=dates.length>1?newId_():"";
    changed=dates.map(d=>({id:newId_(),requestId:body.requestId,seriesId,itemId:String(item.id),qty,user:user.name||user.email,email:user.email,groupEmails:group.join(","),start:d.start,end:d.end,originalEnd:d.end,status:"Booked",notes:String(body.notes||"").slice(0,2000),syncState:"Pending",syncError:"",updatedAt:now}));
    assertCapacity_(item,changed,all.filter(r=>r.end>now));
  } else {
    const target=all.find(r=>r.id===String(body.id));
    if(!target) throw new Error("Reservation not found");
    const teammate=String(target.groupEmails||"").split(",").includes(user.email);
    if(!admin && target.email!==user.email && !(action==="finishReservation"&&teammate)) throw new Error("Only the owner or admin can change this reservation");
    if(target.status!=="Booked" || target.end<=now) throw new Error("Past or cancelled reservations cannot be changed");
    if(action==="finishReservation" && !(target.start<now&&now<target.end)) throw new Error("Only an active booking can finish early");
    if(body.scope==="future"&&target.start<=now) throw new Error("Select an upcoming occurrence to change the future series");
    const targets=body.scope==="future" && target.seriesId && action!=="finishReservation" ? all.filter(r=>r.seriesId===target.seriesId&&r.start>=target.start&&r.start>now&&r.status==="Booked") : [target];
    if(!targets.length) throw new Error("No future occurrences to change");
    if(action==="updateReservation" && target.start<=now && body.scope==="future") throw new Error("Edit an upcoming occurrence to change the future series");
    let dayShift=0;
    if(action==="updateReservation") dayShift=Math.round((Date.parse(body.startLocal.slice(0,10)+"T00:00Z")-Date.parse(localOf_(target.start).slice(0,10)+"T00:00Z"))/86400000);
    changed=targets.map(r=>{
      const n=Object.assign({},r,{syncState:"Pending",syncError:"",updatedAt:now});
      if(action==="cancelReservation") n.status="Cancelled";
      if(action==="finishReservation") { n.end=now; n.status="Finished"; }
      if(action==="updateReservation") {
        const originalLocal=localOf_(r.start);
        const baseDate=shiftLocal_(originalLocal,dayShift).slice(0,10);
        const durationDays=Math.round((Date.parse(body.endLocal.slice(0,10)+"T00:00Z")-Date.parse(body.startLocal.slice(0,10)+"T00:00Z"))/86400000);
        n.start=localInstant_(baseDate+"T"+body.startLocal.slice(11));
        n.end=localInstant_(shiftLocal_(baseDate+"T"+body.endLocal.slice(11),durationDays));
        if(n.end<=n.start || n.end<=now || (r.start>now&&n.start<=now) || (r.start<=now&&n.start!==r.start)) throw new Error("Choose valid future times; an active booking's start cannot change");
        n.qty=Number(body.qty); if(!Number.isFinite(n.qty)||n.qty<=0) throw new Error("Quantity must be positive");
        n.notes=String(body.notes||"").slice(0,2000); n.originalEnd=n.end;
      }
      return n;
    });
    if(action==="updateReservation") { const item=findId_("Items",target.itemId); assertBookable_(item); if(/^.+-\d{6}-\d{3}$/.test(item.displayId||"")&&changed.some(r=>r.qty!==1)) throw new Error("An individually labeled unit requires quantity one"); assertCapacity_(item,changed,all.filter(r=>!targets.some(t=>t.id===r.id)&&r.end>now)); }
  }
  changed.forEach(r=>{if(!r.eventId) r.eventId="lt"+r.id;});
  const result={ok:true,ids:changed.map(r=>r.id),syncState:"Pending"};
  atomicWrite_(changed.map(r=>({sheet:"Reservations",id:action==="createReservation"?undefined:r.id,object:r})).concat([operationChange_(body.requestId,action,user,result),auditChange_(user,action,changed.length+" occurrence(s) | "+changed.map(r=>r.id).join(","))]));
  // Durable rows are committed before external calls. Failure cannot erase a booking.
  syncCalendarRows_(changed.slice(0,10));
  sendSlack("📅",action==="createReservation"?"Equipment Reserved":"Reservation Updated",null,["*By*\n"+(user.name||user.email),"*Occurrences*\n"+changed.length,"*Item*\n"+(findId_("Items",changed[0].itemId)||{}).name]);
  return Object.assign({},result,{reservations:rows_("Reservations").filter(r=>result.ids.includes(r.id))});
}
function syncCalendarRows_(rows) {
  const calendarId=readSettings_().calendar_id;
  if(!calendarId) return;
  for(const r of rows) {
    try {
      const item=findId_("Items",r.itemId)||{name:"Archived equipment",displayId:r.itemId};
      if(r.status==="Cancelled") {
        try { Calendar.Events.remove(calendarId,r.eventId); } catch(e) { if(!/404|410|not found|gone/i.test(e.message)) throw e; }
      } else {
        const event={summary:item.name+" ["+item.displayId+"] — "+r.user,location:item.loc||"",description:"Booked in LabTrack\nQuantity: "+r.qty+" "+(item.unit||"")+"\nSerial: "+(item.serial||"—")+"\nOwner: "+r.email+"\nTeammates: "+(r.groupEmails||"—")+"\n"+(r.notes||"")+"\nManage in LabTrack: https://penn-figueroa-lab.github.io/lab-inventory/?item="+encodeURIComponent(r.itemId),start:{dateTime:r.start,timeZone:LAB_TZ},end:{dateTime:r.end,timeZone:LAB_TZ},extendedProperties:{private:{labtrackId:r.id,itemId:r.itemId}},transparency:"opaque"};
        try { Calendar.Events.get(calendarId,r.eventId); Calendar.Events.patch(event,calendarId,r.eventId); }
        catch(e) { if(!/404|not found/i.test(e.message)) throw e; Calendar.Events.insert(Object.assign({id:r.eventId},event),calendarId); }
      }
      atomicWrite_([{sheet:"Reservations",id:r.id,object:{syncState:"Synced",syncError:""}}]);
    } catch(e) { atomicWrite_([{sheet:"Reservations",id:r.id,object:{syncState:"Error",syncError:String(e.message).slice(0,500)}}]); }
  }
}
function syncReservationsToCalendar() {
  transactionalData_ = {};
  apiModifiedSheets_ = {};
  const lock=LockService.getScriptLock(); if(!lock.tryLock(1000)) return;
  try { if(readSettings_().calendar_id) syncCalendarRows_(rows_("Reservations").filter(r=>r.syncState!=="Synced").slice(0,20)); } finally {lock.releaseLock();}
}
function currentReservations_() {
  const now=Date.now(), from=new Date(now-30*86400000).toISOString(), to=new Date(now+366*86400000).toISOString();
  return rows_("Reservations").filter(r=>r.end>=from&&r.start<=to);
}
function listReservations_(args) {
  const from=new Date(args.from), to=new Date(args.to);
  if(!Number.isFinite(+from)||!Number.isFinite(+to)||to<=from||to-from>367*86400000) throw new Error("Reservation reads require a range of at most 367 days");
  return {ok:true,reservations:rows_("Reservations").filter(r=>(!args.itemId||String(r.itemId)===String(args.itemId))&&r.end>=from.toISOString()&&r.start<=to.toISOString())};
}
function resolveLegacyItem_(id,name) {
  const items=rows_("Items"); if(id) return items.find(i=>String(i.id)===String(id));
  const matches=items.filter(i=>i.name===name); return matches.length===1?matches[0]:null;
}
function migrationReport_() {
  const items=rows_("Items"), checkouts=rows_("Checkouts"), issues=[], blocked=new Set();
  checkouts.forEach(c=>{
    const matches=c.itemId?items.filter(i=>String(i.id)===String(c.itemId)):items.filter(i=>i.name===c.item);
    if(!c.itemId||matches.length!==1) issues.push({checkoutId:c.id,item:c.item,status:c.status,reason:!c.itemId?"Missing item ID":"Missing item",candidateIds:matches.map(i=>i.id)});
    // An active legacy checkout remains blocked until explicitly reconciled, even with a unique name.
    if(c.status==="Active") matches.forEach(i=>blocked.add(String(i.id)));
  });
  items.filter(i=>i.status!=="On loan"&&(i.status==="In Use"||(i.usedBy||[]).length)).forEach(i=>{blocked.add(String(i.id));issues.push({itemId:i.id,item:i.name,reason:"Legacy availability requires reconciliation"});});
  return {issues,blockedItemIds:Array.from(blocked)};
}

// Editor-only, explicit administrator migrations. Original checkout dates and
// identity are retained; no guessed email aliases or historical unit matching.
function confirmedMigration_(options,work) {
  transactionalData_={}; apiModifiedSheets_={};
  const email=Session.getActiveUser().getEmail();
  if(!email||!isAdmin(email)) throw new Error("Run this migration as a listed administrator in the Apps Script editor");
  if(!options||options.spreadsheetId!==SpreadsheetApp.getActiveSpreadsheet().getId()) throw new Error("Confirm the exact spreadsheet ID");
  const lock=LockService.getScriptLock();lock.waitLock(30000);
  try {requireV2_();return work({email,name:email});} finally {lock.releaseLock();}
}
function convertConfirmedCheckoutToReservation(options) {
  return confirmedMigration_(options,user=>{
    if(!capabilities_().scheduling) throw new Error("Enable the shared calendar first");
    const requestId="checkout-transfer-"+requireId_(options.checkoutId),action="TransferCheckout";
    const replay=operation_(requestId,action,user);
    if(replay) return {ok:true,reservation:findId_("Reservations",replay.id)};
    const co=findId_("Checkouts",options.checkoutId),item=findId_("Items",options.itemId);
    if(!co||co.status!=="Active"||!item) throw new Error("An active checkout and exact inventory item are required");
    if(co.itemId?String(co.itemId)!==String(item.id):String(co.item).trim()!==String(item.name).trim()) throw new Error("Checkout does not match the confirmed item");
    if(!co.itemId&&rows_("Items").filter(i=>String(i.name).trim()===String(co.item).trim()).length!==1) throw new Error("Duplicate names require a separately verified physical-unit link");
    if(item.consumable||Number(item.qty)<=0||["Maintenance","Broken","On loan"].includes(item.status)) throw new Error("Item cannot be reserved");
    if(rows_("Checkouts").some(c=>c.id!==co.id&&c.status==="Active"&&(c.itemId===item.id||String(c.item).trim()===String(item.name).trim()))) throw new Error("Other active checkouts must be reconciled first");
    if(!co.checkedOutByEmail||!co.checkedOutByEmail.endsWith("@"+ALLOWED_DOMAIN)||!isMember(co.checkedOutByEmail)) throw new Error("Checkout owner must have an exact authorized email; do not infer aliases");
    const parse=(value,end)=>{const v=String(value||"").trim();if(/^\d{4}-\d{2}-\d{2}$/.test(v)){if(!end)throw new Error("A start time is required");return localInstant_(shiftLocal_(v+"T00:00",1));}const m=v.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/);if(!m)throw new Error("Checkout dates need explicit correction");return localInstant_(m[1]+"T"+m[2].padStart(2,"0")+":"+m[3]);};
    const start=parse(co.out,false),end=parse(co.ret,true),now=new Date().toISOString();
    if(end<=start||end<=now) throw new Error("Confirm a valid future return date before transferring an active checkout");
    // Legacy checkout had no quantity field and made the entire stock unavailable.
    // Preserve that capacity until its owner/admin explicitly adjusts the booking.
    const id=newId_(),reservation={id,requestId,seriesId:"",itemId:String(item.id),qty:Number(item.qty),user:co.user,email:co.checkedOutByEmail,groupEmails:String(co.groupEmails||""),start,end,originalEnd:end,status:"Booked",notes:"Transferred from checkout "+co.id+". Original checkout: "+co.out+"; return: "+co.ret+". A date-only return includes the entire return day. Original checkout reserved all recorded units; quantity preserved.",eventId:"lt"+id,syncState:"Pending",syncError:"",updatedAt:now};
    assertCapacity_(item,[reservation],liveReservations_());
    atomicWrite_([{sheet:"Reservations",object:reservation},{sheet:"Checkouts",id:co.id,object:{itemId:String(item.id),status:"Transferred"}},{sheet:"Items",id:item.id,object:{status:"Available",usedBy:[]}},operationChange_(requestId,action,user,{id}),auditChange_(user,action,JSON.stringify({checkoutId:co.id,itemId:item.id,reservationId:id,start,end,qty:reservation.qty}))]);
    syncCalendarRows_([reservation]);
    return {ok:true,reservation:findId_("Reservations",id)};
  });
}
function recordConfirmedIndefiniteLoan(options) {
  return confirmedMigration_(options,user=>{
    const item=findId_("Items",options.itemId),borrower=String(options.borrower||"").trim(),note=String(options.note||"").trim();
    if(!item||item.consumable||!borrower||!note) throw new Error("Exact equipment, borrower and confirmation note required");
    if(rows_("Checkouts").some(c=>c.status==="Active"&&(c.itemId===item.id||String(c.item).trim()===String(item.name).trim()))) throw new Error("Transfer or resolve the active checkout first");
    protectReservations_(item,{status:"On loan"});
    atomicWrite_([{sheet:"Items",id:item.id,object:{status:"On loan",usedBy:[borrower]}},auditChange_(user,"ConfirmIndefiniteLoan",JSON.stringify({itemId:item.id,borrower,note}))]);
    return {ok:true,item:findId_("Items",item.id)};
  });
}
function handleV2_(action,body,user,admin) {
  const actions=["addIndividualItems","splitItem","receiveOrder","useConsumable","createReservation","updateReservation","cancelReservation","finishReservation","reconcileLegacy"];
  if(!actions.includes(action)) return null;
  requireV2_();
  if(action==="addIndividualItems"||action==="splitItem") return individualItems_(action,body,user);
  if(action==="receiveOrder") return receiveOrder_(body,user,admin);
  if(action==="useConsumable") return useConsumable_(body,user);
  if(action==="reconcileLegacy") {
    if(!admin) throw new Error("Admin only");
    const item=findId_("Items",body.itemId); if(!item) throw new Error("Item not found");
    const changes=[auditChange_(user,"ReconcileLegacy",JSON.stringify({itemId:body.itemId,checkoutId:body.checkoutId||"",note:body.note}))];
    if(!String(body.note||"").trim()) throw new Error("Record the reason for reconciliation");
    if(body.checkoutId) { const co=findId_("Checkouts",body.checkoutId); if(!co||co.status!=="Active") throw new Error("Active checkout not found"); changes.push({sheet:"Checkouts",id:co.id,object:{itemId:String(item.id),status:"Returned"}}); }
    if(rows_("Checkouts").some(c=>c.status==="Active"&&String(c.id)!==String(body.checkoutId)&&(String(c.itemId)===String(item.id)||(!c.itemId&&c.item===item.name)))) throw new Error("Other active legacy checkouts for this item must be resolved first");
    changes.push({sheet:"Items",id:item.id,object:{status:item.status==="In Use"?"Available":item.status,usedBy:[]}}); atomicWrite_(changes);
    return {ok:true,migration:migrationReport_()};
  }
  return reservationOperation_(action,body,user,admin);
}

// Run from the Apps Script editor on staging first. These do not run automatically.
function migrateLabTrackV2() {
  transactionalData_ = {};
  apiModifiedSheets_ = {};
  const lock=LockService.getScriptLock(); lock.waitLock(30000);
  try {
    settingList_("members"); settingList_("admins"); // Fail before migration if access configuration is malformed.
    Object.keys(V2_HEADERS).forEach(name=>{
      let sheet=getSheet(name);
      if(!sheet) { if(["Items","Orders","Deliveries"].includes(name)) throw new Error("Missing production tab: "+name); sheet=getOrCreateSheet(name,V2_HEADERS[name]); }
      const headers=sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
      if(!headers.includes("id") || new Set(headers.filter(Boolean)).size!==headers.filter(Boolean).length) throw new Error("Invalid or duplicate headers in "+name);
      const missing=V2_HEADERS[name].filter(h=>!headers.includes(h));
      if(missing.length) sheet.getRange(1,headers.length+1,1,missing.length).setValues([missing]);
    });
    getOrCreateSheet("AuditLog",["date","user","email","action","details"]);
    setSetting_("schema_version",2);
    if(readSettings_().scheduling_enabled===undefined) setSetting_("scheduling_enabled","false");
    Logger.log(JSON.stringify(migrationReport_(),null,2));
    return migrationReport_();
  } finally {lock.releaseLock();}
}
function setupLabEquipmentCalendar() {
  requireV2_();
  let id=readSettings_().calendar_id;
  if(!id) { id=Calendar.Calendars.insert({summary:"Lab Equipment",timeZone:LAB_TZ,description:"Equipment reservations managed through LabTrack. Make booking changes in LabTrack."}).id; setSetting_("calendar_id",id); }
  Calendar.Calendars.get(id);
  const members=Array.from(new Set(settingList_("members").concat(settingList_("admins"))));
  // Never make the calendar public or domain-wide implicitly.
  if(!members.length) throw new Error("Set an explicit members/admins list before sharing the equipment calendar");
  const rules=Calendar.Acl.list(id).items||[];
  members.forEach(email=>{if(!rules.some(r=>r.scope&&r.scope.value===email)) Calendar.Acl.insert({role:"reader",scope:{type:"user",value:email}},id,{sendNotifications:false});});
  if(!ScriptApp.getProjectTriggers().some(t=>t.getHandlerFunction()==="syncReservationsToCalendar")) ScriptApp.newTrigger("syncReservationsToCalendar").timeBased().everyMinutes(5).create();
  Logger.log("Calendar prepared; scheduling is still disabled: "+id);
  return id;
}
function enableLabScheduling() {
  requireV2_(); const id=readSettings_().calendar_id; if(!id) throw new Error("Run setupLabEquipmentCalendar first");
  Calendar.Calendars.get(id);
  setSetting_("scheduling_enabled","true");
  Logger.log(JSON.stringify(migrationReport_())); // affected assets stay blocked until reconciled
}
function disableLabScheduling() { setSetting_("scheduling_enabled","false"); }

function individualItems_(action,body,user) {
  const replay=operation_(body.requestId,action,user);
  if(replay) return {ok:true,items:replay.ids.map(id=>findId_("Items",id))};
  const old=action==="splitItem"?findId_("Items",body.itemId):null;
  if(action==="splitItem"&&!old) throw new Error("Item not found");
  if(old) {
    if(liveReservations_().some(r=>r.itemId===String(old.id)&&r.end>new Date().toISOString()) || migrationReport_().blockedItemIds.includes(String(old.id))) throw new Error("Resolve active use and reservations before splitting units");
    if(rows_("Receipts").some(r=>JSON.parse(r.itemIds||"[]").includes(String(old.id)))) throw new Error("Received items with receipt history must retain their inventory unit; use individual tracking when receiving new stock.");
    if(/^.+-\d{6}-\d{3}$/.test(old.displayId||"")) throw new Error("This item is already individually tracked");
  }
  const base=Object.assign({},old||{},body.item), count=Number(base.qty);
  validateItem_(base);
  if(!Number.isInteger(count)||count<1||count>200||base.consumable) throw new Error("Individual tracking requires 1–200 whole non-consumable units");
  if(old&&count!==Number(old.qty)) throw new Error("Save quantity changes before splitting units");
  const label=old&&old.displayId?old.displayId:nextLabel_(rows_("Items"),base.cat);
  const created=Array.from({length:count},(_,i)=>Object.assign({},base,{id:old&&i===0?String(old.id):newId_(),createdAt:old&&i===0?old.createdAt||"":new Date().toISOString(),qty:1,displayId:label+"-"+String(i+1).padStart(3,"0"),serial:(body.serials||[])[i]||(old&&i===0?old.serial||"":""),status:"Available",usedBy:[]}));
  const result={ok:true,ids:created.map(i=>i.id)};
  atomicWrite_(created.map((item,i)=>({sheet:"Items",id:old&&i===0?old.id:undefined,object:item})).concat([operationChange_(body.requestId,action,user,result),auditChange_(user,action,base.name+" | units:"+count)]));
  sendSlack("📦","Individual Units Added: "+base.name,null,["*Units*\n"+count,"*By*\n"+(user.name||user.email)]);
  return {ok:true,items:created};
}
