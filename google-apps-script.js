/**
 * LabTrack — Google Apps Script Backend
 *
 * Deploy this as a Web App from your Google Sheet:
 *   Extensions → Apps Script → paste this code → Deploy → Web App
 *   Execute as: Me | Who has access: Anyone
 *
 * The script verifies Google ID tokens server-side and checks for @seas.upenn.edu domain.
 *
 * Google Sheet must have 5 tabs:
 *   Items      — id | name | cat | qty | unit | loc | minQty | img | desc | status | usedBy | serial
 *   Deliveries — id | item | qty | unit | from | receivedBy | date | tracking | status
 *   Checkouts  — id | itemId | item | user | out | ret | status
 *   Orders     — id | item | qty | unit | requestedBy | reason | urgency | date | status | price | link | cat
 *   Settings   — key | value
 */

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const ALLOWED_DOMAIN = "seas.upenn.edu";
const SLACK_WEBHOOK_URL = "YOUR_SLACK_WEBHOOK_URL_HERE";

// ─── SLACK HELPER ────────────────────────────────────────────────────────────
function sendSlack(text) {
  if (!SLACK_WEBHOOK_URL || SLACK_WEBHOOK_URL === "YOUR_SLACK_WEBHOOK_URL_HERE" || SLACK_WEBHOOK_URL === "") return;
  try {
    UrlFetchApp.fetch(SLACK_WEBHOOK_URL, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ text: text }),
      muteHttpExceptions: true,
    });
  } catch (e) {
    // Silently skip — don't break the main action
    console.log("Slack error (non-fatal): " + e.message);
  }
}

// ─── TOKEN VERIFICATION ──────────────────────────────────────────────────────
function verifyToken(token) {
  if (!token || token === "local") return null;
  try {
    const resp = UrlFetchApp.fetch(
      "https://oauth2.googleapis.com/tokeninfo?id_token=" + token
    );
    const payload = JSON.parse(resp.getContentText());
    if (payload.hd !== ALLOWED_DOMAIN) return null;
    return payload; // { email, name, hd, ... }
  } catch (e) {
    return null;
  }
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

function sheetToJson(sheet) {
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      let val = row[i];
      // Parse usedBy as JSON array
      if (h === "usedBy" && typeof val === "string") {
        try { val = JSON.parse(val); } catch(e) { val = []; }
      }
      // Parse numeric fields
      if (["qty", "minQty", "itemId"].includes(h) && val !== "") {
        val = Number(val);
      }
      // Keep id as string to avoid precision loss
      if (h === "id") {
        val = String(val);
      }
      obj[h] = val;
    });
    return obj;
  });
}

function appendRow(sheetName, obj, headers) {
  const sheet = getSheet(sheetName);
  const row = headers.map(h => {
    const val = obj[h];
    if (h === "usedBy" && Array.isArray(val)) return JSON.stringify(val);
    return val !== undefined ? val : "";
  });
  sheet.appendRow(row);
  // Force ID column to text format to avoid precision loss with large numbers
  const lastRow = sheet.getLastRow();
  const idCol = headers.indexOf("id");
  if (idCol >= 0) {
    sheet.getRange(lastRow, idCol + 1).setNumberFormat("@");
  }
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// Helper to compare IDs robustly (handles large number precision issues)
function idsMatch(sheetVal, targetId) {
  var a = String(sheetVal).trim();
  var b = String(targetId).trim();
  if (a === b) return true;
  // Try numeric comparison for large numbers that may lose precision
  try {
    if (Number(a) === Number(b) && !isNaN(Number(a))) return true;
  } catch(e) {}
  // Try trimming trailing zeros or decimal points from sheet formatting
  if (a.replace(/\.0+$/, "") === b.replace(/\.0+$/, "")) return true;
  return false;
}

// ─── GET (fetch all data) ────────────────────────────────────────────────────
function doGet(e) {
  try {
    const token = (e && e.parameter && e.parameter.token) || "";
    const user = verifyToken(token);
    if (!user) {
      return jsonResponse({ error: "Unauthorized", detail: "Token verification failed" });
    }

    // Read settings
    var settings = {};
    var settingsSheet = getSheet("Settings");
    if (settingsSheet) {
      var sData = settingsSheet.getDataRange().getValues();
      for (var i = 1; i < sData.length; i++) {
        settings[String(sData[i][0])] = sData[i][1];
      }
    }

    return jsonResponse({
      items: sheetToJson(getSheet("Items")),
      deliveries: sheetToJson(getSheet("Deliveries")),
      checkouts: sheetToJson(getSheet("Checkouts")),
      orders: sheetToJson(getSheet("Orders")),
      settings: settings,
    });
  } catch (err) {
    return jsonResponse({ error: "Server error", detail: err.message });
  }
}

// ─── POST (mutations) ────────────────────────────────────────────────────────
function doPost(e) {
  try {
  const body = JSON.parse(e.postData.contents);
  const user = verifyToken(body.token);
  if (!user) {
    return jsonResponse({ error: "Unauthorized", detail: "Token verification failed for POST" });
  }

  const action = body.action;

  // ── Add Item ──────────────────────────────────────────────────────────────
  if (action === "addItem") {
    const it = body.item;
    appendRow("Items", it, [
      "id", "name", "cat", "qty", "unit", "loc", "minQty", "img", "desc", "status", "usedBy", "serial"
    ]);
    sendSlack("📦 New item added: " + it.name);
    return jsonResponse({ ok: true });
  }

  // ── Update Item ───────────────────────────────────────────────────────────
  if (action === "updateItem") {
    const it = body.item;
    const sheet = getSheet("Items");
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idCol = headers.indexOf("id");
    const fields = ["name", "cat", "qty", "unit", "loc", "minQty", "img", "desc", "status", "serial"];

    for (let i = 1; i < data.length; i++) {
      if (idsMatch(data[i][idCol], it.id)) {
        fields.forEach(f => {
          const col = headers.indexOf(f);
          if (col >= 0 && it[f] !== undefined) {
            sheet.getRange(i + 1, col + 1).setValue(it[f]);
          }
        });
        return jsonResponse({ ok: true });
      }
    }
    return jsonResponse({ error: "Item not found", detail: "No item with id " + it.id });
  }

  // ── Delete Item ───────────────────────────────────────────────────────────
  if (action === "deleteItem") {
    const itemId = body.itemId;
    const sheet = getSheet("Items");
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idCol = headers.indexOf("id");
    const nameCol = headers.indexOf("name");
    var deletedName = "";

    for (let i = 1; i < data.length; i++) {
      if (idsMatch(data[i][idCol], itemId)) {
        deletedName = data[i][nameCol] || "Unknown";
        sheet.deleteRow(i + 1);
        sendSlack("🗑️ Item deleted: " + deletedName);
        return jsonResponse({ ok: true });
      }
    }
    return jsonResponse({ error: "Item not found", detail: "No item with id " + itemId });
  }

  // ── Add Delivery ──────────────────────────────────────────────────────────
  if (action === "addDelivery") {
    const d = body.delivery;
    appendRow("Deliveries", d, [
      "id", "item", "qty", "unit", "from", "receivedBy", "date", "tracking", "status"
    ]);
    sendSlack("🚚 Delivery received: " + d.qty + " " + d.unit + " of " + d.item);
    return jsonResponse({ ok: true });
  }

  // ── Add Checkout ──────────────────────────────────────────────────────────
  if (action === "addCheckout") {
    const c = body.checkout;
    appendRow("Checkouts", c, [
      "id", "itemId", "item", "user", "out", "ret", "status"
    ]);
    // Update item status in Items sheet
    updateItemStatus(c.item, "In Use", c.user, "add");
    sendSlack("🔑 " + c.user + " checked out " + c.item);
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
    const itemCol = headers.indexOf("item");
    const userCol = headers.indexOf("user");

    for (let i = 1; i < data.length; i++) {
      if (idsMatch(data[i][idCol], coId)) {
        sheet.getRange(i + 1, statusCol + 1).setValue("Returned");
        const itemName = data[i][itemCol];
        const userName = data[i][userCol];
        updateItemStatus(itemName, "Available", userName, "remove");
        sendSlack("✅ " + itemName + " returned");
        break;
      }
    }
    return jsonResponse({ ok: true });
  }

  // ── Add Order ─────────────────────────────────────────────────────────────
  if (action === "addOrder") {
    const o = body.order;
    appendRow("Orders", o, [
      "id", "item", "qty", "unit", "requestedBy", "reason", "urgency", "date", "status", "price", "link", "cat"
    ]);
    sendSlack("🛒 New order request: " + o.qty + " " + o.unit + " of " + o.item + " (" + o.urgency + ")");
    return jsonResponse({ ok: true });
  }

  // ── Update Order Status ───────────────────────────────────────────────────
  if (action === "updateOrderStatus") {
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
        sheet.getRange(i + 1, statusCol + 1).setValue(newStatus);
        if (newStatus === "Received") {
          var itemName = data[i][itemCol] || "";
          sendSlack("✅ Order received: " + itemName);
        }
        return jsonResponse({ ok: true });
      }
    }
    return jsonResponse({ error: "Order not found", detail: "No order with id " + orderId });
  }

  // ── Delete Order ──────────────────────────────────────────────────────────
  if (action === "deleteOrder") {
    const orderId = body.orderId;
    const sheet = getSheet("Orders");
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idCol = headers.indexOf("id");

    for (let i = 1; i < data.length; i++) {
      if (idsMatch(data[i][idCol], orderId)) {
        sheet.deleteRow(i + 1);
        return jsonResponse({ ok: true });
      }
    }
    return jsonResponse({ error: "Order not found", detail: "No order with id " + orderId });
  }

  // ── Save Settings ─────────────────────────────────────────────────────────
  if (action === "saveSettings") {
    const key = body.key;
    const value = body.value;
    var sheet = getOrCreateSheet("Settings", ["key", "value"]);
    var data = sheet.getDataRange().getValues();
    var found = false;
    for (var i = 1; i < data.length; i++) {
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

  return jsonResponse({ error: "Unknown action: " + action });
  } catch (err) {
    return jsonResponse({ error: "Server error", detail: err.message });
  }
}

// ─── Update item status & usedBy in Items sheet ──────────────────────────────
function updateItemStatus(itemName, newStatus, userName, mode) {
  const sheet = getSheet("Items");
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const nameCol = headers.indexOf("name");
  const statusCol = headers.indexOf("status");
  const usedByCol = headers.indexOf("usedBy");

  for (let i = 1; i < data.length; i++) {
    if (data[i][nameCol] === itemName) {
      sheet.getRange(i + 1, statusCol + 1).setValue(newStatus);
      if (usedByCol >= 0) {
        let usedBy = [];
        try { usedBy = JSON.parse(data[i][usedByCol]) || []; } catch(e) {}
        if (mode === "add" && !usedBy.includes(userName)) {
          usedBy.push(userName);
        } else if (mode === "remove") {
          usedBy = usedBy.filter(u => u !== userName);
        }
        sheet.getRange(i + 1, usedByCol + 1).setValue(JSON.stringify(usedBy));
      }
      break;
    }
  }
}
