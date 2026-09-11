# Billable Time Tracker

**v1.0.0**

A local-only Chrome extension (Manifest V3) that tracks billable time passively,
per browser tab/domain — no start/stop timer required. Tag time to a client,
see dollar totals, and export a CSV or a printable invoice.

No build step, no external network calls, no analytics. Everything lives in
`chrome.storage.local`.

## Install

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and select this folder.
4. Pin the extension so its toolbar icon is visible.

A first-run onboarding tab opens automatically on install and walks through
how passive tracking works and adding your first client. Revisit it anytime
from the Dashboard header ("Take the tour").

## How it works

- **Tracking is automatic.** The service worker watches the active, focused,
  non-idle browser tab and buckets time by domain. It pauses when the window
  loses focus, you go idle for 60s, or the active tab isn't `http(s)`.
- **The toolbar icon is a live status indicator** — a green badge shows the
  domain you're currently being tracked on and how long, so you never have to
  open anything to know it's working. It's blank whenever tracking is paused.
- **The popup** is a quick glance at today: total time, total $, and a
  per-domain breakdown with a client-assignment dropdown.
- **The Dashboard** (opens in its own tab) is the full workspace: date range
  (Today / This Week / This Month / Custom), per-client summary, an editable
  entry table, manual time entry, client & rate management, CSV export, and
  invoice generation (`window.print()` → Save as PDF).
- **Deletes are undoable, not blocking.** Deleting an entry or a client
  happens immediately — a snackbar offers a few seconds to undo instead of a
  confirm() dialog interrupting you. Deleting a client fully restores its
  domain mappings and entry associations if you undo it, not just the client
  record itself.

## Files

- `manifest.json` — MV3 manifest.
- `background.js` — service worker: tracking, 60s checkpoint alarm (so a
  service-worker restart loses at most ~60s), the live toolbar badge, and
  first-run onboarding trigger.
- `lib/storage.js` — all `chrome.storage.local` reads/writes, aggregation,
  and undo/restore helpers, shared by every page.
- `lib/util.js` — pure helpers (domain normalization, date-range math,
  formatting).
- `theme.css` — shared color tokens (dark, unconditionally) imported by
  every stylesheet.
- `popup.html/css/js` — today-only quick glance.
- `options.html/css/js` — the Dashboard.
- `onboarding.html/css/js` — first-run guided setup.
- `icons/` — app icons.

## Notes

- "This Week" is Monday–Sunday of the current week.
- Unassigned (untagged) time is visible in the Dashboard for awareness but
  never counts toward a client's $ total or an invoice.
- Deleting a client un-assigns its time entries rather than deleting them —
  they fall back to Unassigned.
- Out of scope for this version: Chrome Web Store packaging, sync across
  devices, team features, and native invoicing integrations.
