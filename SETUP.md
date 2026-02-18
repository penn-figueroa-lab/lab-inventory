# LabTrack Setup Guide

## Quick Start

1. Go to **https://penn-figueroa-lab.github.io/lab-inventory/**
2. Sign in with your **@seas.upenn.edu** Google account
3. Start managing inventory

---

## Google Sheet Schema

The backend uses a Google Sheet with these tabs:

**Items** — `id | name | cat | qty | unit | loc | minQty | img | desc | status | usedBy | serial`

**Deliveries** — `id | item | qty | unit | from | receivedBy | date | tracking | status`

**Checkouts** — `id | itemId | item | user | out | ret | status`

**Orders** — `id | item | qty | unit | requestedBy | reason | urgency | date | status | price | link | cat`

**Settings** — `key | value`

| key | value |
|-----|-------|
| `categories` | `["Robot","Sensor","Actuator","Controller","Cable & Connector","Tool","Consumable","Safety","Computer & Electronics","Other"]` |
| `admins` | `["admin@seas.upenn.edu"]` |
| `slack_mode` | `all` or `important` or `digest` or `off` |

**DeleteLog** (auto-created) — `date | type | name | details | deletedBy`

**SlackQueue** (auto-created, used by digest mode) — `time | emoji | title | details | fields`

---

## Apps Script Deployment

1. In the Google Sheet: **Extensions → Apps Script**
2. Paste contents of `google-apps-script.js`
3. Replace `"YOUR_SLACK_WEBHOOK_URL_HERE"` on line 19 with your Slack webhook URL
4. **Deploy → New deployment** → Web app → Execute as: Me → Who has access: Anyone
5. Copy the Web app URL

> After code updates, always create a **new version** via Deploy → Manage deployments.

### Slack Notification Modes

Set `slack_mode` in the Settings tab:

| Mode | Behavior |
|------|----------|
| `all` | Every action sends a Slack notification (default) |
| `important` | Only deletions and urgent/high-priority orders |
| `digest` | Queues notifications; sends daily summary via trigger |
| `off` | No notifications |

For **digest mode**, set up a daily trigger: Apps Script → Triggers → Add → `sendDailyDigest` → Day timer.

---

## Admin System

Add emails to the `admins` list in the Settings tab to grant admin access:
```
["admin1@seas.upenn.edu","admin2@seas.upenn.edu"]
```

**Admins can**: delete items, delete orders, manage categories, change settings
**All users can**: add items, edit items, check out/return, log deliveries, submit orders

All deletions are logged in the DeleteLog tab with timestamp, details, and who deleted.

---

## Features

- **Inventory**: Add/edit items with serial numbers, image upload (camera/file/URL), customizable categories
- **Procurement**: Unified orders + deliveries tab; auto-adds item to inventory when order marked "Received"
- **Usage Tracking**: Check out/return items, overdue alerts, bulk return
- **Calendar**: Visual calendar of deliveries, checkouts, and return dates
- **Live Sync**: Auto-polls every 30s so all users see changes without refreshing
- **Pagination & Sort**: 24 items/page with sort by name, date, quantity
- **Slack**: Rich Block Kit notifications with configurable modes
- **Admin Permissions**: Role-based deletion and settings control
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
| Slow updates | Inherent to Apps Script (~1-3s); UI updates instantly |
| Images not showing | Images are compressed to <50KB base64; check cell size limit |
