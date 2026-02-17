/**
 * LabTrack — Google Apps Script Backend
 *
 * Deploy this as a Web App from your Google Sheet:
 *   Extensions → Apps Script → paste this code → Deploy → Web App
 *   Execute as: Me | Who has access: Anyone
 *
 * The script verifies Google ID tokens server-side and checks for @seas.upenn.edu domain.
 *
 * Google Sheet must have 4 tabs:
 *   Items      — id | name | cat | qty | unit | loc | minQty | img | desc | status | usedBy
 *   Deliveries — id | item | qty | unit | from | receivedBy | date | tracking | status
 *   Checkouts  — id | itemId | item | user | out | ret | status
 *   Orders     — id | item | qty | unit | requestedBy | reason | urgency | date | status
 */

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const ALLOWED_DOMAIN = "seas.upenn.edu";

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
        try { val = JSON.parse(val); } catch { val = []; }
      }
      // Parse numeric fields
      if (["id", "qty", "minQty", "itemId"].includes(h) && val !== "") {
        val = Number(val);
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
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── GET (fetch all data) ────────────────────────────────────────────────────
function doGet(e) {
  try {
    const token = (e && e.parameter && e.parameter.token) || "";
    const user = verifyToken(token);
    if (!user) {
      return jsonResponse({ error: "Unauthorized", detail: "Token verification failed" });
    }

    return jsonResponse({
      items: sheetToJson(getSheet("Items")),
      deliveries: sheetToJson(getSheet("Deliveries")),
      checkouts: sheetToJson(getSheet("Checkouts")),
      orders: sheetToJson(getSheet("Orders")),
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
      "id", "name", "cat", "qty", "unit", "loc", "minQty", "img", "desc", "status", "usedBy"
    ]);
    return jsonResponse({ ok: true });
  }

  // ── Update Item ───────────────────────────────────────────────────────────
  if (action === "updateItem") {
    const it = body.item;
    const sheet = getSheet("Items");
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idCol = headers.indexOf("id");
    const fields = ["name", "cat", "qty", "unit", "loc", "minQty", "img", "desc", "status"];

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idCol]) === String(it.id)) {
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

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idCol]) === String(itemId)) {
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
      if (String(data[i][idCol]) === String(coId)) {
        sheet.getRange(i + 1, statusCol + 1).setValue("Returned");
        const itemName = data[i][itemCol];
        const userName = data[i][userCol];
        updateItemStatus(itemName, "Available", userName, "remove");
        break;
      }
    }
    return jsonResponse({ ok: true });
  }

  // ── Add Order ─────────────────────────────────────────────────────────────
  if (action === "addOrder") {
    const o = body.order;
    appendRow("Orders", o, [
      "id", "item", "qty", "unit", "requestedBy", "reason", "urgency", "date", "status"
    ]);
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

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idCol]) === String(orderId)) {
        sheet.getRange(i + 1, statusCol + 1).setValue(newStatus);
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
      if (String(data[i][idCol]) === String(orderId)) {
        sheet.deleteRow(i + 1);
        return jsonResponse({ ok: true });
      }
    }
    return jsonResponse({ error: "Order not found", detail: "No order with id " + orderId });
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
        try { usedBy = JSON.parse(data[i][usedByCol]) || []; } catch {}
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
