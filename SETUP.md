# LabTrack Setup Guide

## Quick Start

1. Go to **https://penn-figueroa-lab.github.io/lab-inventory/**
2. Sign in with your **@seas.upenn.edu** Google account
3. Start managing inventory

---

## Google Sheet Schema

The backend uses a Google Sheet with these tabs:

**Items** — `id | name | cat | qty | unit | loc | minQty | img | desc | status | usedBy | serial | displayId | shared | consumable`

**Deliveries** — `id | item | qty | unit | from | receivedBy | date | tracking | status`

**Checkouts** — `id | itemId | item | user | out | ret | status | checkedOutByEmail | groupEmails`

**Orders** — `id | store | item | link | qty | unit | price | cat | requestedBy | reason | urgency | date | status | requestedByEmail`

> ⚠️ Column order matters for new rows written by the script. If upgrading, reorder your Orders sheet header row to match the above.

**Settings** — `key | value`

| key | value |
|-----|-------|
| `categories` | `["Robots & Motors","Sensors & Vision","Compute & Electronics","Wiring & Networking","Tools & Hardware","Consumables & Supplies","Safety & Facility","Other"]` |
| `admins` | `["admin@seas.upenn.edu"]` |
| `slack_mode` | `all` or `important` or `digest` or `off` |

**DeleteLog** (auto-created) — `date | type | name | details | deletedBy`

**SlackQueue** (auto-created, used by digest mode) — `time | emoji | title | details | fields`

---

## Apps Script Deployment

1. In the Google Sheet: **Extensions → Apps Script**
2. Paste contents of `google-apps-script.js`
3. Replace `"YOUR_SLACK_WEBHOOK_URL_HERE"` on line ~19 with your Slack webhook URL
4. **Set script timezone**: Project Settings → Time zone → **America/New_York**
5. **Deploy → New deployment** → Web app → Execute as: Me → Who has access: Anyone
6. Copy the Web app URL

> After code updates, always create a **new version** via Deploy → Manage deployments.

### Slack Notification Modes

Set `slack_mode` in the Settings tab:

| Mode | Behavior |
|------|----------|
| `all` | Every action sends a Slack notification |
| `important` | Only urgent/high order requests + overdue checkouts |
| `digest` | Queues events; sends compact daily summary at 5pm ET |
| `off` | No notifications |

### Setting Up Triggers (for digest mode)

Go to **Apps Script → Triggers → Add Trigger**:

| Function | Event Type | Time |
|----------|-----------|------|
| `sendDailyDigest` | Time-driven → Day timer | **5pm – 6pm** |
| `checkOverduesAndAlert` | Time-driven → Day timer | 8am – 9am |

> Make sure the script timezone is **America/New_York** so 5pm ET is correct.

### Daily Digest Format (sent at 5pm ET)

The digest is compact but informative — designed for your PI to quickly review:
- 🚨 **Urgent/High orders** — item, qty, store, price, purchase link
- 🛒 **All pending orders** — item, store, status
- 🔴 **Overdue checkouts** — item, person, due date
- 📦 **Low stock items** — item, current/min qty
- One-line activity count: e.g. `🚚 ×3 · 🔑 ×5 · ✅ ×2` (no per-event listing)

Deletions are **not** flagged as important — admins delete items during cleanup and it shouldn't flood the channel. Deletions are logged in the DeleteLog sheet and appear in digest mode only as a count.

### Admin: Manual Digest

Admins can send the digest at any time by clicking the **Digest** button in the top header bar. This is useful for testing or when your PI needs an immediate summary.

---

## Admin System

Add emails to the `admins` list in the Settings tab to grant admin access:
```
["admin1@seas.upenn.edu","admin2@seas.upenn.edu"]
```

**Admins can**: delete items/orders, manage categories, change settings, send digest manually, change order status (Approve/Reject/etc.)
**All users can**: add/edit items, check out/return, log deliveries, submit and edit order requests

All deletions are logged in the DeleteLog tab with timestamp, details, and who deleted.

---

## Features

- **Inventory**: Add/edit items with serial numbers, label IDs (`PREFIX-NNNNN`), image upload (camera/file/URL), customizable categories; mark items as Shared (multi-user checkout) or Consumable (qty deduction without checkout)
- **Order Requests**: Submit and edit orders (store, item, link, qty, price, etc.); admins can change status (Pending/Approved/Ordered/Received/Rejected); "Mark Received" opens a staging form to set location/label/serial before adding to inventory; generate copy-pasteable email text with per-item totals and grand total
- **Usage Tracking**: Check out/return items, overdue alerts, bulk return; consumables use a "Use" button instead of checkout
- **Calendar**: Visual calendar of deliveries, checkouts, and return dates
- **Live Sync**: Auto-polls every 30s so all users see changes without refreshing
- **Pagination & Sort**: 24 items/page with sort by name, date, quantity
- **Slack**: Rich Block Kit notifications; daily 5pm ET digest with compact PI-friendly summary; `important` mode for urgent orders + overdues only
- **Dark/Light Mode**: Toggle with the ☀/🌙 button in the header; preference saved per browser
- **Admin Permissions**: Role-based deletion and settings control; manual digest trigger
- **Delete Audit Log**: Full record of all deletions

---

## Frontend Configuration

In `index.html`, update `APP_CONFIG`:
```js
const APP_CONFIG = {
  oauth_client_id: "YOUR_OAUTH_CLIENT_ID",
  apps_script_url: "YOUR_APPS_SCRIPT_WEB_APP_URL",
};
```

## GitHub Pages Deployment

```bash
git add index.html google-apps-script.js SETUP.md
git commit -m "Deploy LabTrack"
git push origin main
```

Repo Settings → Pages → Deploy from branch: `main` / `/ (root)`

---

## Security

- Google Sign-In restricted to `@seas.upenn.edu` domain (client + server verified)
- Slack webhook stored only in Apps Script (server-side), never in client code
- No secrets in HTML — only the OAuth Client ID (designed to be public) and Apps Script URL

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "Access restricted" | Must use `@seas.upenn.edu` account |
| Data not syncing | Check Apps Script URL; redeploy as new version |
| Delete not working | Check you're in the `admins` list in Settings tab |
| Digest not sending | Verify trigger is set; check script timezone = America/New_York |
| Orders not saving correctly | Ensure Orders sheet column order matches: `id \| store \| item \| link \| qty \| unit \| price \| cat \| requestedBy \| reason \| urgency \| date \| status \| requestedByEmail` |
| `displayId`/`shared`/`consumable` not saving | Ensure Items sheet has these 3 columns after `serial`: `displayId \| shared \| consumable` |
| Slow updates | Inherent to Apps Script (~1-3s); UI updates instantly |
| Images not showing | Images are compressed to <50KB base64; check cell size limit |
