# LabTrack setup and V2 upgrade

LabTrack stays a static React page on GitHub Pages with a sheet-bound Apps Script backend. Google Sheets is authoritative for inventory and reservations. A shared Google Calendar displays reservations; changes are made through LabTrack to enforce capacity and ownership.

Production site: https://penn-figueroa-lab.github.io/lab-inventory/

## Local verification

Use Node 22.18+ (or Node 24.11+) and Chrome:

```bash
npm ci
npm run check
npm test
npm run test:browser
```

The browser suite uses a separate headless Chrome process, synthetic lab data, and intercepted network requests backed by Apps Script service doubles. It never uses your Chrome profile, production spreadsheet, real Calendar, or Slack. Screenshots are saved under ignored `test-results/`. Set `CHROME_PATH` if Chrome isn't installed at `/usr/bin/google-chrome`.

These tests do not substitute for Google authorization, actual Sheets API behavior, Calendar ACL checks, or signed-in staging validation.

For real-service staging checks, append `tests/staging-smoke.gs` only to the copied Apps Script project and define `STAGING_SPREADSHEET_ID` with that copy's ID. Run `runLabTrackStagingSmoke()` and then `runLabTrackStagingRecovery()`. Both guard the spreadsheet ID/name; they create synthetic records and deliberately interrupt Calendar synchronization. Never install this test file in production.

## Production rollout — November 5, 2026

- Existing Apps Script deployment upgraded from version **37** to **38**, retaining its URL. Prior frontend commit: `d404013`.
- Fresh pre-cutover [spreadsheet backup](https://docs.google.com/spreadsheets/d/1nDkKm7qvQ921Oc8sj6uULJ01z_EQQi_u2ZMRKc152K4/edit) retained in the existing backup folder. The migration only appended fields/tabs.
- The membership JSON typo was corrected and the existing 31-member list retained, as requested. No email aliases were inferred.
- The production Slack webhook was moved to Script Properties and checked against its original value. Digest mode and both existing digest/overdue triggers were preserved. The Calendar retry trigger was added and its first execution succeeded.
- **Lab Equipment** calendar created with reader access for listed members/admins; scheduling enabled. Calendar ID: `c_05604e51f96495822a2585cba47a47088f1fb07a58208dd3c1463c835cce0a24@group.calendar.google.com`.
- Legacy records remain intact: 53 checkout rows lack item IDs. **ANR EMG** (`1773314303669`) and **1TB External Hard Drive** (`1792137195350`) remain blocked for booking until an admin verifies physical availability and reconciles them. Historical candidate matches were not automatically applied.
- Validation passed: 28 backend tests, JSX validation, browser workflows, signed-in desktop/mobile staging checks, real concurrent booking/receipt requests, purchase-summary generation, and actual Sheets/Calendar failure recovery with stable event IDs. Production Slack test messages were not sent. Calendar sharing with another member's signed-in account still needs that member's acceptance check.
- Post-deployment signed-in reads verified all 372 inventory records, all 53 historical checkouts, scheduling enabled, and exactly the two expected blocked assets. The published page loaded successfully and label search retained full group totals. No synthetic inventory or bookings were written to production.

The temporary staging calendar and triggers were deleted on November 5, 2026 at the administrator's request. The staging spreadsheet and its bound project were moved to Trash. Production and its backups were retained. The local staging test fixture remains available for future isolated validation; there is no standing staging calendar.

## Inventory refresh and confirmed loans — November 5, 2026

- Backend version **39** retains the same deployment URL and adds indefinite-loan protection plus guarded administrator checkout transfer helpers. Version 38 remains available, but must not be used for rollback while an item has `On loan` status: it does not enforce that status. Disable scheduling first if a backend rollback is necessary.
- Inventory now includes **Checked out / reserved**, equipment-card **Reserve / Choose unit** actions, a compact schedule defaulting to **My reservations** with **All lab** available, searchable original checkout history, and an embedded private Google Calendar. The calendar stays hidden until **View calendar** is selected. Mobile starts with Agenda; desktop starts with Week. Secondary actions (including Digest and Backup) are under **Tools & account**. The embed uses the member's signed-in Google account and the existing calendar ACL; the calendar is not public.
- Added 66 image URLs only to previously empty `Items.img` cells. Sources and product/generic-reference labels are in `image-catalog.js`. Existing photos, item descriptions, purchase links and quantities were preserved. 35 custom or insufficiently identified items still need an actual photo or a reliable matching source. Failed external images fall back to a local placeholder.
- Repaired the existing blank `AuditLog!E1` header to `details`, preserving its historical values and allowing atomic audit writes to retain their details.
- Fresh [pre-transfer backup](https://docs.google.com/spreadsheets/d/1iJBx4bVZg_yEBy7ZGhhPAIEmIM-Ym_2ZUpgMG7bpcS4/edit) retained.
- The administrator confirmed Lily Zhang's ANR EMG checkout should become a reservation. The original November 3, 2026, 23:01 Eastern start and May 1, 2027 return date are retained. The stored return timestamp is May 1 at 00:00 Eastern; the Calendar event preserves that timestamp. The old checkout blocked all stock, so the transfer preserves its two-unit capacity reservation. The owner/admin can adjust quantity explicitly.
- External drive **CE-000265-002** remains **On loan to Shafagh**, with no invented return date or identity alias. It is excluded from bookable capacity until returned. To record its return, edit its Status to Available; the server clears the borrower and records the normal item-update audit.
- Validation: 31 backend tests and browser workflows pass, including personal/hidden-calendar defaults, receipt failure/retry, label search, booking capacity, theme switching, and mobile overflow checks. Desktop/mobile screenshots were reviewed in both themes.
- Read-only production integration check passed at 22:26 Eastern: stored Slack webhook present, digest mode, digest/overdue/Calendar retry triggers present, Calendar accessible, zero unsynchronized reservations, 53 checkout records, and no blocked assets. No Slack test message was sent.
- Published frontend `64129d0` was verified byte-for-byte against the workspace. Signed-in desktop/mobile checks confirmed the personal schedule default, hidden calendar, original checkout history, grouped-unit availability, and no horizontal overflow. The embedded Google Calendar displayed both Lily’s transferred EMG booking and the administrator’s existing Franka booking. Production checks were read-only.
- All 53 checkout rows remain preserved. The transferred row is marked `Transferred` and linked to the exact item, while its original owner/dates remain unchanged. Historical rows with missing item IDs or inconsistent date ranges remain searchable by recorded name; they are not assigned guessed unit IDs or uploaded as misleading Calendar events.

`convertConfirmedCheckoutToReservation(options)` and `recordConfirmedIndefiniteLoan(options)` run only from the Apps Script editor as a listed administrator and require the exact spreadsheet ID. The read-only `verifyLabTrackIntegrations()` function reports webhook presence, notification mode, triggers, Calendar access, sync backlog, and record counts without printing credentials or sending messages. Their administrator identity check requires the manifest's `userinfo.email` scope; authorize that scope before running them. Checkout transfers are locked, atomic, idempotent and retain durable Calendar retry state. They do not send retrospective Slack notifications. Do not rerun a transfer with a different identity or manually duplicate its Calendar event.

## Deployment order — staging first

1. Record the production deployment ID and version, frontend commit, spreadsheet ID, Script Properties, and existing trigger list. Keep the current backend version available for rollback.
2. Make a spreadsheet backup and a separate **LabTrack Staging** copy. Open the copy's **Extensions → Apps Script**. Confirm its bound spreadsheet is the copy, not production. Copies do not inherit time-driven triggers reliably; inspect the trigger list explicitly.
3. In staging, set `slack_mode` to `off` and omit the Slack webhook. Replace `google-apps-script.js` in the copied bound project. Enable the manifest in **Project Settings → Show appsscript.json**, then merge the supplied `appsscript.json`, preserving any unrelated existing configuration. It declares the advanced **Google Sheets v4** and **Google Calendar v3** services and the New York timezone. A standard Cloud project also needs both APIs enabled in Cloud Console.
4. Run `migrateLabTrackV2()` from the editor and authorize as the deployment owner. This only appends missing columns, creates new tabs, and records schema version 2. Rerunning is safe. Review its migration report in the execution log.
5. Configure staging `members` and `admins` with test accounts only. Run `setupLabEquipmentCalendar()`. It creates a separate calendar, grants view permissions to the explicit members/admins, and installs one five-minute synchronization trigger. It does **not** enable bookings. Rename this calendar **Lab Equipment — Staging** in Google Calendar before testing.
6. Run `enableLabScheduling()`. Items with unresolved active legacy checkouts or stale In Use state remain blocked individually. Resolve these through the admin panel only after verifying the physical item and recording a reason.
7. Deploy a staging web app: **Execute as Me**, **Who has access: Anyone**. Keep token verification enabled. Point a private/local staging copy of the frontend's `APP_CONFIG.apps_script_url` to the staging deployment. Its Google Sign-In OAuth client must permit that test origin; register a localhost origin on the existing client if needed. Do not commit the staging URL into the production frontend.
8. Complete the signed-in acceptance checklist below. Verify the staging spreadsheet ID and calendar ID before each integration test.
9. Before production cutover, make a fresh backup and preserve the deployed Slack webhook: store it in **Script Properties → `SLACK_WEBHOOK_URL`** before replacing source. The repository deliberately contains no webhook. The existing source constant may also be retained as a deployment-specific fallback. Never overwrite the live webhook with the repository placeholder.
10. Install the backend and manifest in the production bound project, run the additive migration, and deploy a **new version of the existing deployment** so its URL remains stable. Editing source affects installed triggers even before publishing a web-app version, so do this only after staging succeeds.
11. Create/share the production calendar and its retry trigger. Check members, owner access, timezone, and pending legacy issues. Enable scheduling when ready, then publish the frontend. During the transition, old clients receive an instruction to refresh when they attempt legacy checkouts; ordinary inventory/orders remain compatible.
12. Reload the site and verify one real receipt/booking only when it corresponds to actual lab activity. Check the execution log, sheet records, Calendar visibility from a member account, and Slack digest configuration.

Do not run `createTriggers()` just to enable Calendar. It replaces the existing digest/overdue/backup trigger schedule. `setupLabEquipmentCalendar()` adds only its own retry trigger.

## Data and migration

Existing IDs, rows, dates, column order, and checkout history are preserved. IDs are strings, including numeric-looking legacy IDs. Writes use header names. Settings can have a `key | value` header or the existing headerless layout; the last occurrence of a setting remains effective.

Existing tabs retain their original columns. Migration appends:

| Tab | New columns |
| --- | --- |
| Items | `link`, `createdAt` |
| Orders | `img`, `receiptId`, `createdAt` |
| Deliveries | `orderId`, `receiptId` |

New tabs:

| Tab | Columns |
| --- | --- |
| Receipts | `id`, `orderId`, `itemIds`, `quantities`, `date`, `email`, `mode`, `link`, `img` |
| Reservations | `id`, `requestId`, `seriesId`, `itemId`, `qty`, `user`, `email`, `groupEmails`, `start`, `end`, `originalEnd`, `status`, `notes`, `eventId`, `syncState`, `syncError`, `updatedAt` |
| Operations | `id`, `action`, `result`, `email`, `date` |

`Receipts.itemIds` and `quantities` are aligned JSON arrays. `Operations` is the idempotency ledger: retain it along with the receipt/reservation records. AuditLog and DeleteLog continue to record accountable changes. Treat the new operational tabs as app-managed; direct edits bypass locks and validation.

Important settings:

| Key | Meaning |
| --- | --- |
| `admins` | JSON list of administrator email addresses |
| `members` | JSON list of authorized members; empty retains the existing domain-only access policy |
| `categories` | JSON category list |
| `slack_mode` | `all`, `important`, `digest`, or `off` |
| `schema_version` | Set to `2` by migration |
| `calendar_id` | Created and recorded by calendar setup |
| `scheduling_enabled` | Changed by `enableLabScheduling()` / `disableLabScheduling()` |

Calendar sharing always requires explicit member/admin lists, even when website membership allows the whole domain. Re-run setup after adding members to add missing reader ACLs; remove departed members' Calendar access in Google Calendar. Reader ACLs do not grant permission to edit events. Members subscribe using **Add lab calendar**. The integration does not import or modify anyone's personal calendar events.

### Legacy reconciliation

The migration report identifies missing item references, active checkouts, and stale item usage. It does not match duplicate names to physical units or rewrite old email domains. An admin must select the verified item label and confirm return/correct status with a note. The original checkout dates and ownership remain in history. Close other active checkouts for the same item before clearing its status.

Already-Received legacy orders are not automatically received again: they may already have created inventory. Purchase links/images can be added manually to the verified inventory item. No automatic name-based backfill is performed.

## Receiving and inventory behavior

- Search is trimmed, case-insensitive, and matches name, location, serial, label ID, category, and description. A sub-label match opens the full group with matched units marked; group totals remain accurate.
- Purchase links are optional HTTP/HTTPS URLs. Image upload/camera input is compressed to at most 49,000 data-URL characters; unreadable and oversized files show errors. Existing remote image URLs still work subject to their sharing/hosting permissions.
- Receiving is admin-only and starts from an **Ordered** request. Cancellation changes nothing. Confirmation uses a script lock plus an atomic Sheets API batch to save inventory, order status, delivery, receipt, and audit together.
- Retry of a received order returns its prior receipt. A restock adds converted inventory quantities exactly once, preserves metadata, and fills missing links/images from the order. Explicit replacement affects only link/image.
- Individual tracking creates 1–200 non-consumable units, each with a label and optional serial. Individually labeled records cannot be restocked into a quantity pool. Received records with receipt history cannot be deleted or split later because their original item relationships must remain traceable.
- Consumable use is an idempotent, locked server-side deduction and cannot make stock negative.
- Forms wait for server confirmation; an unreadable response is an error. Polling ignores snapshots that overlap a local write. Cache failures cannot discard saved sheet data.

## Reservation behavior

- All non-consumables support one-time or weekly reservations; broken, maintenance, zero-stock, and unresolved legacy items are blocked. Select a specific physical unit within grouped inventory.
- Capacity is enforced even for Shared items. Back-to-back bookings are allowed. Individually labeled equipment requires quantity one.
- Weekly series use the same local weekday/time in `America/New_York`, require an end date, and allow up to 52 occurrences. The entire series is checked and committed together. Nonexistent or ambiguous daylight-saving times require another time.
- Owners/admins can reschedule, extend, or cancel one occurrence or an upcoming occurrence and all following ones. Teammates can finish an active occurrence early. Past occurrences cannot be changed. Active start times cannot be rewritten.
- Availability is computed from current time and reservations; no return trigger is needed. Finish early preserves the original end time, records actual completion, releases capacity, and shortens the event.
- Each occurrence has its own Calendar event and a shared LabTrack series ID. Calendar displays who, what, label, quantity, location, times, notes, and a link back to item details. Edit series through LabTrack.
- Sheets is authoritative. Calendar changes are not imported. A reservation remains valid if Calendar is temporarily unavailable, with a visible pending/delayed status. The initial request syncs up to ten occurrences; the five-minute trigger retries up to twenty queued occurrences per run.
- Stable event IDs prevent duplicate creation after interrupted responses. Cancellation removes Calendar events but retains reservation history. Inspect `syncError` and Apps Script executions if retries continue failing.
- New reservations never produce legacy overdue alerts. The digest includes upcoming/active reservations for the next 24 hours.
- Item history initially loads the recent window; **Load older history** retrieves preceding years through bounded requests.

## Sign-in renewal — November 9, 2026

`auth-session.js` initializes Google Identity Services once per page, including when restoring a saved login. It schedules renewal five minutes before token expiry and rechecks on tab visibility, focus, and reconnection. Hidden/offline tabs stop polling. API requests obtain the current credential when they execute; simultaneous requests share one renewal attempt. An explicit Unauthorized response may be retried once with a new credential; network failures are never blindly retried.

If Google declines automatic renewal, LabTrack stops automatic prompts for that credential and offers its Google sign-in button in the page and open forms. Reconnecting with the same account preserves drafts. Only explicit sign-out disables automatic account selection. Renewed credentials propagate between tabs. Token decoding in the browser only schedules renewal; the unchanged backend still verifies Google tokens, the OAuth audience, domain, membership, and administrator permissions on every request. Google/browser policy may still require occasional confirmation.

This is a frontend-only release: publish `index.html` and `auth-session.js` together. No Apps Script deployment, scope change, data migration, or Slack configuration change is required. Tests cover restored expired sessions, wake-up, concurrent renewal, Google dismissal/timeout, account mismatches, and form preservation during reconnection.

## API compatibility

`doGet` retains inventory, orders, deliveries, checkouts, settings, and role. It adds capabilities, the recent/upcoming reservation window, and the migration report. `action=listReservations` accepts optional `itemId` and required ISO `from`/`to` with a maximum 367-day interval.

New POST actions:

| Action | Inputs |
| --- | --- |
| `receiveOrder` | `orderId`, `mode` (`new`, `individual`, `restock`), `item`, optional `itemId`, `serials`, `replaceMetadata`, `tracking` |
| `useConsumable` | `requestId`, `itemId`, positive `qty` |
| `addIndividualItems` | `requestId`, `item`, optional `serials` |
| `splitItem` | `requestId`, `itemId`, `item` (existing unreceived pooled stock only) |
| `createReservation` | `requestId`, `itemId`, `qty`, local `startLocal`/`endLocal` (`YYYY-MM-DDTHH:mm`), optional `repeatUntil`, `groupEmails`, `notes` |
| `updateReservation` | `requestId`, `id`, local times, `qty`, `notes`, `scope` (`one` or `future`) |
| `cancelReservation` | `requestId`, `id`, optional `scope` |
| `finishReservation` | `requestId`, `id` |
| `reconcileLegacy` | Admin-only `itemId`, optional active `checkoutId`, and required `note` |

All POSTs still include the Google ID token. Ownership comes from the verified token, never a caller-provided email. Retries reuse the request ID. Successful responses have `ok: true`; failures provide `error` and `detail`. Receiving and new writes return authoritative records; reservation responses distinguish sheet persistence from Calendar sync.

## Slack and existing integrations

Preserve the live webhook and `slack_mode`. `all` sends activity immediately, `important` sends urgent/high orders and legacy overdue notices, `digest` queues activity for the existing daily digest, and `off` suppresses activity notifications. Receipt/reservation retries do not enqueue the same operation again. Slack failures do not roll back inventory. Failed digest delivery retains the queue for retry.

Existing digest, legacy overdue, and weekly backup functions remain available. Keep their current triggers and timezone. Purchase summaries still use the Orders link and price fields. Keep existing Google Sign-In client ID and production web-app URL unless intentionally moving deployment; server token validation checks the expected OAuth client and domain.

## Signed-in staging acceptance checklist

- Sign in as both admin and member; verify membership restrictions and requester-only editing.
- Cancel receiving without changing the sheet. Receive with an uploaded image and link, refresh, and verify the inventory, receipt, order, delivery, and audit records. Test restocking and individual serials.
- Use two browser sessions to compete for the last unit; only one overlapping booking succeeds. Test a weekly series with one conflicting date and confirm none of that series is created.
- Subscribe from a member account and verify event details. Test an edit, cancellation, extension, and early finish against Calendar and Sheets.
- Temporarily remove staging Calendar write access or use a deliberately unavailable staging calendar; verify pending/error visibility and recovery without duplicate events.
- Test a stock deduction and retry, expired authentication, offline failure, mobile forms, keyboard focus, dark/light mode, and polling across users.
- Exercise Slack payloads with a mock endpoint or isolated test channel, never the production lab channel. Verify purchasing summaries and backup configuration.

## Rollback and monitoring

Run `disableLabScheduling()` to stop new bookings/edits without deleting reservations, receipts, or Calendar events. Keep the V2 backend for receiving and data integrity; deploy a prior frontend only if necessary. Calendar retries continue, and existing reservations may still be cancelled/finished through the V2 API. Legacy checkout requests are refused for equipment with future reservations.

Do not restore an old spreadsheet over newer receipts or reservations. Full backend rollback to pre-V2 code requires pausing writes and reconciling all new records first; it is not safe while users continue booking. Retain the new tabs/columns and backup snapshots.

After rollout, inspect failed Apps Script executions, pending/error Calendar rows, receipt/order consistency, and Slack digest delivery. The UI surfaces unconfirmed saves and delayed Calendar synchronization.
