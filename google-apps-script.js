/**
 * LabTrack — Google Apps Script Backend
 *
 * Deploy this as a Web App from your Google Sheet:
 *   Extensions → Apps Script → paste this code → Deploy → Web App
 *   Execute as: Me | Who has access: Anyone
 *
 * Google Sheet must have 6 tabs:
 *   Items      — id | name | cat | qty | unit | loc | minQty | img | desc | status | usedBy | serial
 *   Deliveries — id | item | qty | unit | from | receivedBy | date | tracking | status
 *   Checkouts  — id | itemId | item | user | out | ret | status
 *   Orders     — id | item | qty | unit | requestedBy | reason | urgency | date | status | price | link | cat
 *   Settings   — key | value
 *   DeleteLog  — date | type | name | details | deletedBy
 */

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const ALLOWED_DOMAIN = "seas.upenn.edu";
const SLACK_WEBHOOK_URL = "YOUR_SLACK_WEBHOOK_URL_HERE";

// ─── SLACK HELPER ────────────────────────────────────────────────────────────
function sendSlack(emoji, title, details, fields) {
  if (!SLACK_WEBHOOK_URL || SLACK_WEBHOOK_URL === "YOUR_SLACK_WEBHOOK_URL_HERE" || SLACK_WEBHOOK_URL === "") return;
  try {
    var blocks = [
      { type: "section", text: { type: "mrkdwn", text: emoji + " *" + title + "*" } }
    ];
    if (details) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: details } });
    }
    if (fields && fields.length > 0) {
      blocks.push({ type: "section", fields: fields.map(function(f) { return { type: "mrkdwn", text: f }; }) });
    }
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "LabTrack · " + new Date().toLocaleString() }] });
    UrlFetchApp.fetch(SLACK_WEBHOOK_URL, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ text: emoji + " " + title, blocks: blocks }),
      muteHttpExceptions: true,
    });
  } catch (e) {
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
    return payload;
  } catch (e) {
    return null;
  }
}

// ─── ADMIN CHECK ─────────────────────────────────────────────────────────────
function isAdmin(email) {
  var settingsSheet = getSheet("Settings");
  if (!settingsSheet) return false;
  var data = settingsSheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === "admins") {
      try {
        var admins = JSON.parse(data[i][1]);
        return Array.isArray(admins) && admins.indexOf(email) >= 0;
      } catch(e) { return false; }
    }
  }
  return false;
}

// ─── DELETE LOG ──────────────────────────────────────────────────────────────
function logDeletion(type, name, details, deletedBy) {
  var sheet = getOrCreateSheet("DeleteLog", ["date", "type", "name", "details", "deletedBy"]);
  var now = new Date();
  var dateStr = now.toISOString().slice(0, 19).replace("T", " ");
  sheet.appendRow([dateStr, type, name, details, deletedBy]);
  sendSlack("🗑️", type + " Deleted: " + name, null, ["*Deleted by*\n" + deletedBy, "*Details*\n" + details]);
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
      if (h === "usedBy" && typeof val === "string") {
        try { val = JSON.parse(val); } catch(e) { val = []; }
      }
      if (["qty", "minQty", "itemId"].includes(h) && val !== "") {
        val = Number(val);
      }
      if (h === "id") { val = String(val); }
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
  try {
    const token = (e && e.parameter && e.parameter.token) || "";
    const user = verifyToken(token);
    if (!user) {
      return jsonResponse({ error: "Unauthorized", detail: "Token verification failed" });
    }

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
      userRole: isAdmin(user.email) ? "admin" : "member",
    });
  } catch (err) {
    return jsonResponse({ error: "Server error", detail: err.message });
  }
}

// ─── POST ────────────────────────────────────────────────────────────────────
function doPost(e) {
  try {
  const body = JSON.parse(e.postData.contents);
  const user = verifyToken(body.token);
  if (!user) {
    return jsonResponse({ error: "Unauthorized", detail: "Token verification failed for POST" });
  }

  const action = body.action;
  const userEmail = user.email || "";
  const userName = user.name || userEmail;
  const admin = isAdmin(userEmail);

  // ── Add Item ──────────────────────────────────────────────────────────────
  if (action === "addItem") {
    const it = body.item;
    appendRow("Items", it, [
      "id", "name", "cat", "qty", "unit", "loc", "minQty", "img", "desc", "status", "usedBy", "serial"
    ]);
    sendSlack("📦", "New Item Added: " + it.name, null, ["*Category*\n" + (it.cat||"—"), "*Qty*\n" + (it.qty||0) + " " + (it.unit||""), "*Location*\n" + (it.loc||"—"), "*Added by*\n" + userName]);
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

  // ── Delete Item (admin only) ──────────────────────────────────────────────
  if (action === "deleteItem") {
    if (!admin) {
      return jsonResponse({ error: "Forbidden", detail: "Only admins can delete items" });
    }
    const itemId = body.itemId;
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
        sheet.deleteRow(i + 1);
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
    sendSlack("🚚", "Delivery Received: " + d.item, null, ["*Qty*\n" + d.qty + " " + d.unit, "*Supplier*\n" + (d.from||"—"), "*Received by*\n" + (d.receivedBy||userName), "*Tracking*\n" + (d.tracking||"—")]);
    return jsonResponse({ ok: true });
  }

  // ── Add Checkout ──────────────────────────────────────────────────────────
  if (action === "addCheckout") {
    const c = body.checkout;
    appendRow("Checkouts", c, [
      "id", "itemId", "item", "user", "out", "ret", "status"
    ]);
    updateItemStatus(c.item, "In Use", c.user, "add");
    sendSlack("🔑", "Item Checked Out: " + c.item, null, ["*Person*\n" + c.user, "*Date*\n" + (c.out||"—"), "*Return by*\n" + (c.ret||"—")]);
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
        const returnedUser = data[i][userCol];
        updateItemStatus(itemName, "Available", returnedUser, "remove");
        sendSlack("✅", "Item Returned: " + itemName, null, ["*Returned by*\n" + returnedUser]);
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
    sendSlack("🛒", "New Order Request: " + o.item, (o.link ? "<" + o.link + "|Purchase Link>" : null), ["*Qty*\n" + o.qty + " " + o.unit, "*Urgency*\n" + (o.urgency||"Normal"), "*Price*\n" + (o.price||"—"), "*Requested by*\n" + userName]);
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
        var orderItem = data[i][itemCol] || "";
        sendSlack("📋", "Order Status Updated: " + orderItem, null, ["*New Status*\n" + newStatus, "*Updated by*\n" + userName]);
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
    const sheet = getSheet("Orders");
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idCol = headers.indexOf("id");
    const itemCol = headers.indexOf("item");

    for (let i = 1; i < data.length; i++) {
      if (idsMatch(data[i][idCol], orderId)) {
        var orderName = data[i][itemCol] || "Unknown";
        logDeletion("Order", orderName, "id:" + orderId, userName);
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
