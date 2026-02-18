# LabTrack Setup Guide

## Quick Start (Local Mode)

1. Open `index.html` in any browser
2. Sign in with your `@seas.upenn.edu` Google account
3. Data is fetched from Google Sheets; localStorage is used as fallback

---

## Full Setup (Google Sign-In + Shared Data)

### Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (e.g., "LabTrack")
3. Navigate to **APIs & Services → OAuth consent screen**
   - Choose **Internal** (if your org supports it) or **External**
   - Fill in app name: "LabTrack", support email, etc.
   - Add scope: `email`, `profile`, `openid`
4. Navigate to **APIs & Services → Credentials**
   - Click **Create Credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorized JavaScript origins: add your GitHub Pages URL (e.g., `https://yourusername.github.io`)
   - Also add `http://localhost` and `http://127.0.0.1` for local testing
5. Copy the **Client ID** (looks like `123456789.apps.googleusercontent.com`)

### Step 2: Create the Google Sheet

1. Create a new Google Sheet
2. Create **5 tabs** (rename the sheets) with these exact names and column headers:

**Tab: Items**
| id | name | cat | qty | unit | loc | minQty | img | desc | status | usedBy | serial |
|----|------|-----|-----|------|-----|--------|-----|------|--------|--------|--------|

**Tab: Deliveries**
| id | item | qty | unit | from | receivedBy | date | tracking | status |
|----|------|-----|------|------|------------|------|----------|--------|

**Tab: Checkouts**
| id | itemId | item | user | out | ret | status |
|----|--------|------|------|-----|-----|--------|

**Tab: Orders**
| id | item | qty | unit | requestedBy | reason | urgency | date | status | price | link | cat |
|----|------|-----|------|-------------|--------|---------|------|--------|-------|------|-----|

**Tab: Settings**
| key | value |
|-----|-------|
| categories | ["Robot","Sensor","Actuator","Controller","Cable & Connector","Tool","Consumable","Safety","Computer & Electronics","Other"] |
| admins | ["admin1@seas.upenn.edu","admin2@seas.upenn.edu"] |

**Tab: DeleteLog** (auto-created on first deletion)
| date | type | name | details | deletedBy |
|------|------|------|---------|-----------|

3. Type the headers in row 1 of each tab exactly as shown above (5 tabs + DeleteLog is auto-created)
4. **Important**: Add your email to the `admins` list in the Settings tab to enable admin features (delete items/orders, manage categories)

### Step 3: Deploy the Apps Script Backend

1. In your Google Sheet, go to **Extensions → Apps Script**
2. Delete any existing code in the editor
3. Paste the entire contents of `google-apps-script.js`
4. **(Optional) Slack notifications**: On line 2 of the script, replace `"YOUR_SLACK_WEBHOOK_URL_HERE"` with your Slack Incoming Webhook URL. If left as-is, Slack notifications are silently skipped.
5. Click **Deploy → New deployment**
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Click **Deploy** and authorize when prompted
7. Copy the **Web app URL** (looks like `https://script.google.com/macros/s/.../exec`)

> **Important**: After updating the Apps Script code, you must create a **new deployment** (not just save) for changes to take effect. Go to Deploy → Manage deployments → Create new version.

### Step 4: Configure the App

1. Open `index.html` and update the `APP_CONFIG` object at the top of the `<script>` section with:
   - `apps_script_url`: the Web App URL from Step 3
   - `oauth_client_id`: the Client ID from Step 1
2. Open the app in your browser and sign in with your `@seas.upenn.edu` account

### Step 5: Deploy to GitHub Pages

1. Create a GitHub repository (e.g., `lab-inventory`)
2. Push files to the repo:
   ```bash
   git init
   git add index.html google-apps-script.js SETUP.md
   git commit -m "LabTrack deployment"
   git remote add origin https://github.com/YOUR_USERNAME/lab-inventory.git
   git push -u origin main
   ```
3. Go to repo **Settings → Pages**
   - Source: **Deploy from a branch**
   - Branch: **main**, folder: **/ (root)**
4. Your app will be live at `https://YOUR_USERNAME.github.io/lab-inventory/`

> **Important:** Make sure the GitHub Pages URL is listed in your OAuth client's Authorized JavaScript Origins (Step 1).

---

## Features

- **Inventory Management**: Add, edit, delete items with serial numbers, image upload (camera/file/URL), and category management
- **Procurement**: Unified Orders + Deliveries tab with auto-add to inventory when orders are marked "Received"
- **Usage Tracking**: Check out/return items, overdue alerts, bulk return
- **Calendar**: Visual calendar showing deliveries, checkouts, and return dates
- **Categories**: Customizable categories synced to Google Sheets (Settings tab) — shared across all users
- **Pagination**: Automatic pagination at 24 items per page with sort options
- **Slack Notifications**: Server-side notifications for all inventory actions (add, delete, checkout, return, order, delivery)
- **Image Upload**: Take photos or upload files, auto-compressed to ~50KB thumbnails
- **Admin Permissions**: Only admins (listed in Settings tab) can delete items/orders and manage categories. Regular users can add/edit freely.
- **Delete Log**: All deletions are recorded in a DeleteLog sheet with timestamp, item details, and who deleted it

---

## Security

- **Client-side**: Google Sign-In `hd` parameter restricts the login prompt to `@seas.upenn.edu` accounts
- **Server-side**: Every Apps Script request verifies the Google ID token and checks the email domain — even crafted requests are rejected without a valid token
- **Slack webhook**: stored only in the Apps Script (server-side), never exposed in client code
- **No secrets in HTML**: only the OAuth Client ID (designed to be public) and the Apps Script URL are in the client

## Troubleshooting

- **"Access restricted" error**: You must sign in with a `@seas.upenn.edu` Google account
- **Data not persisting**: Check that your Apps Script URL is correct, and that the script is deployed as a Web App
- **Google Sign-In button not showing**: Ensure the OAuth Client ID is set and the page is served over HTTPS (or localhost)
- **CORS errors**: Apps Script web apps handle CORS automatically; make sure you're using the `/exec` URL, not `/dev`
- **Delete not working**: Large numeric IDs can lose precision in Google Sheets. The updated Apps Script uses robust ID comparison to handle this.
- **Images not showing**: Base64 images are stored in Google Sheets cells (max ~50K chars). The app compresses images to fit within this limit.
