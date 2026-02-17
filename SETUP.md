# LabTrack Setup Guide

## Quick Start (Local Mode)

1. Open `index.html` in any browser
2. Click **Continue Locally** on the login page
3. The app works immediately with seed data, persisted in localStorage

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
2. Create 3 tabs (rename the sheets) with these exact names and column headers:

**Tab: Items**
| id | name | cat | qty | unit | loc | minQty | img | desc | status | usedBy |
|----|------|-----|-----|------|-----|--------|-----|------|--------|--------|

**Tab: Deliveries**
| id | item | qty | unit | from | receivedBy | date | tracking | status |
|----|------|-----|------|------|------------|------|----------|--------|

**Tab: Checkouts**
| id | itemId | item | user | out | ret | status |
|----|--------|------|------|-----|-----|--------|

3. Type the headers in row 1 of each tab exactly as shown above

### Step 3: Deploy the Apps Script Backend

1. In your Google Sheet, go to **Extensions → Apps Script**
2. Delete any existing code in the editor
3. Paste the entire contents of `google-apps-script.js`
4. **(Optional)** Set your Slack webhook URL in the `SLACK_WEBHOOK_URL` constant at the top
5. Click **Deploy → New deployment**
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Click **Deploy** and authorize when prompted
7. Copy the **Web app URL** (looks like `https://script.google.com/macros/s/.../exec`)

### Step 4: Configure the App

1. Open `index.html` in your browser
2. Click **Settings** on the login page
3. Enter:
   - **Apps Script Web App URL**: the URL from Step 3
   - **OAuth Client ID**: the Client ID from Step 1
4. Click **Save**
5. The Google Sign-In button will now appear — sign in with your `@seas.upenn.edu` account

### Step 5: Deploy to GitHub Pages

1. Create a GitHub repository (e.g., `lab-inventory`)
2. Push `index.html` to the repo:
   ```bash
   git init
   git add index.html
   git commit -m "Initial LabTrack deployment"
   git remote add origin https://github.com/YOUR_USERNAME/lab-inventory.git
   git push -u origin main
   ```
3. Go to repo **Settings → Pages**
   - Source: **Deploy from a branch**
   - Branch: **main**, folder: **/ (root)**
4. Your app will be live at `https://YOUR_USERNAME.github.io/lab-inventory/`

> **Important:** Make sure the GitHub Pages URL is listed in your OAuth client's Authorized JavaScript Origins (Step 1).

---

## Security

- **Client-side**: Google Sign-In `hd` parameter restricts the login prompt to `@seas.upenn.edu` accounts
- **Server-side**: Every Apps Script request verifies the Google ID token and checks the email domain — even crafted requests are rejected without a valid token
- **Slack webhook**: stored only in the Apps Script (server-side), never exposed in client code
- **No secrets in HTML**: only the OAuth Client ID (designed to be public) and the Apps Script URL are in the client

## Troubleshooting

- **"Access restricted" error**: You must sign in with a `@seas.upenn.edu` Google account
- **Data not persisting**: Check that your Apps Script URL is correct in Settings, and that the script is deployed as a Web App
- **Google Sign-In button not showing**: Ensure the OAuth Client ID is set in Settings and the page is served over HTTPS (or localhost)
- **CORS errors**: Apps Script web apps handle CORS automatically; make sure you're using the `/exec` URL, not `/dev`
