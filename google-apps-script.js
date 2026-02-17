/**
 * LabTrack — Google Apps Script Backend
 *
 * Deploy this as a Web App from your Google Sheet:
 *   Extensions → Apps Script → paste this code → Deploy → Web App
 *   Execute as: Me | Who has access: Anyone
 *
 * The script verifies Google ID tokens server-side and checks for @seas.upenn.edu domain.
 *
 * Google Sheet must have 3 tabs:
 *   Items      — id | name | cat | qty | unit | loc | minQty | img | desc | status | usedBy
 *   Deliveries — id | item | qty | unit | from | receivedBy | date | tracking | status
 *   Checkouts  — id | itemId | item | user | out | ret | status
 */

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const ALLOWED_DOMAIN = "seas.upenn.edu";
const SLACK_WEBHOOK_URL = ""; // Paste your Slack Incoming Webhook URL here

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

// ─── SLACK ────────────────────────────────────────────────────────────────────
function sendSlack(text) {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    UrlFetchApp.fetch(SLACK_WEBHOOK_URL, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ text: text }),
    });
  } catch (e) {
    console.error("Slack error:", e);
  }
}

// ─── GET (fetch all data) ────────────────────────────────────────────────────
function doGet(e) {
  const token = e.parameter.token;
  const user = verifyToken(token);
  if (!user) {
    return jsonResponse({ error: "Unauthorized" });
  }

  return jsonResponse({
    items: sheetToJson(getSheet("Items")),
    deliveries: sheetToJson(getSheet("Deliveries")),
    checkouts: sheetToJson(getSheet("Checkouts")),
  });
}

// ─── POST (mutations) ────────────────────────────────────────────────────────
function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  const user = verifyToken(body.token);
  if (!user) {
    return jsonResponse({ error: "Unauthorized" });
  }

  const action = body.action;

  if (action === "addItem") {
    const it = body.item;
    appendRow("Items", it, [
      "id", "name", "cat", "qty", "unit", "loc", "minQty", "img", "desc", "status", "usedBy"
    ]);
    return jsonResponse({ ok: true });
  }

  if (action === "addDelivery") {
    const d = body.delivery;
    appendRow("Deliveries", d, [
      "id", "item", "qty", "unit", "from", "receivedBy", "date", "tracking", "status"
    ]);
    sendSlack("📦 *New Delivery*\n• *" + d.item + "* — " + d.qty + " " + d.unit +
      " from " + (d.from || "—") + "\n• Received by: " + d.receivedBy +
      " | Tracking: `" + (d.tracking || "—") + "`");
    return jsonResponse({ ok: true });
  }

  if (action === "addCheckout") {
    const c = body.checkout;
    appendRow("Checkouts", c, [
      "id", "itemId", "item", "user", "out", "ret", "status"
    ]);
    // Update item status in Items sheet
    updateItemStatus(c.item, "In Use", c.user, "add");
    sendSlack("🔬 *Checked Out*\n• *" + c.item + "* → " + c.user +
      "\n• Return by: " + (c.ret || "—"));
    return jsonResponse({ ok: true });
  }

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
        sendSlack("✅ *Returned*\n• *" + itemName + "* returned by " + userName);
        break;
      }
    }
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "Unknown action: " + action });
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
