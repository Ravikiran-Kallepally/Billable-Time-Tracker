# Product Requirements Doc: Billable Time Tracker (Chrome Extension)

## 1. Problem & Goal

People who bill hourly (freelancers, consultants, agencies, lawyers) lose 20-30% of
billable time because they forget to start/stop manual timers. This extension tracks
time passively per browser tab/domain, lets the user tag time to a client, and
exports/generates invoices — no manual start/stop required.

**Goal of this build:** a working local prototype (loadable via `chrome://extensions`
in Developer Mode) that proves the core loop: track time passively → tag to a client
→ see dollar totals → export an invoice. Not shipping to the Chrome Web Store yet.

## 2. Target User

Freelancers and consultants who bill hourly and work primarily in a browser
(email, docs, calls via web, project tools). They already track time manually today
(Toggl, Harvest, or a spreadsheet) and lose money to forgotten timers.

## 3. Core User Stories

1. As a user, I open my browser and work normally — the extension tracks time per
   domain in the background without me starting anything.
2. As a user, I open the popup and see today's time broken down by domain/site.
3. As a user, I assign a domain to a client (e.g. "gmail.com" → "Acme Corp") and
   that assignment is remembered for future sessions.
4. As a user, I set an hourly rate per client so I see dollars, not just minutes.
5. As a user, I can view a date range (not just today) — e.g. "this week."
6. As a user, I can export a CSV or generate a simple invoice (PDF or clean HTML)
   for a client covering a date range.
7. As a user, I can manually add/edit/delete a time entry, in case tracking missed
   something (e.g. an in-person meeting, or a phone call).

## 4. Out of Scope for This Prototype

- Chrome Web Store publishing / review compliance
- Payment processing / licensing
- Cross-device sync (local `chrome.storage.local` only for now)
- Team/multi-user features
- Native integrations with QuickBooks/FreshBooks/Stripe (just clean CSV/PDF export)
- Mobile

## 5. Functional Requirements

### 5.1 Passive Time Tracking (background service worker)
- Track time spent on the **active, focused, non-idle** browser tab, bucketed by
  domain (strip `www.`, ignore `chrome://`/`file://`/internal pages).
- Pause tracking when: the browser window loses focus, the user goes idle
  (no input for 60s, via `chrome.idle`), or the active tab has no valid http(s) URL.
- Resume tracking automatically when the user becomes active again.
- Persist completed sessions to `chrome.storage.local`, keyed by date
  (`log:YYYY-MM-DD`), as an array of entries:
  ```
  { domain, durationMs, startedAt, endedAt, client: string | null }
  ```
- Guard against Manifest V3 service worker termination: use a `chrome.alarms`
  checkpoint (every 60s) that flushes the in-progress session to storage and
  restarts it, so no more than ~60s of tracked time can ever be lost.
- Merge contiguous sessions on the same domain (gap < 5s) into one entry instead
  of fragmenting them.
- Ignore sessions under 3 seconds (tab-switch noise).

### 5.2 Client & Rate Management
- Maintain a `clients` list in storage: `{ id, name, hourlyRate }`.
- Maintain a `domainClientMap`: `{ [domain]: clientId }` so once a domain is tagged,
  future time on that domain auto-assigns to that client.
- Provide a simple UI (options page or popup section) to add/edit/delete clients
  and their hourly rate.
- Default/untagged time goes into an "Unassigned" bucket that does not count toward
  any client's dollar total.

### 5.3 Popup UI (daily view — quick glance)
- Show total tracked time for **today**, and total **dollars today** (based on
  tagged client rates).
- List today's time broken down by domain, each row showing: domain, duration, a
  dropdown to assign/change client.
- A link/button into the full **Dashboard** (options page) for history, editing,
  and exports.

### 5.4 Dashboard / Options Page (the real workspace)
This is a full HTML page (`options.html`), not the small popup. Build the bulk of
the UI here since the popup has limited space.
- **Date range selector**: Today / This Week / This Month / Custom range.
- **Summary view**: total time and total $ per client for the selected range.
- **Entry table**: every tracked entry in range — domain, client, duration, date —
  editable (change client, adjust duration) and deletable.
- **Manual entry**: a form to add a manual time block (client, description,
  duration or start/end time, date) for time not captured by the browser (calls,
  in-person meetings).
- **Client management**: add/edit/delete clients and hourly rates (can live here
  instead of/in addition to the popup).
- **Export**:
  - CSV export for the selected range (columns: Date, Domain/Description, Client,
    Minutes, Rate, Amount).
  - Simple invoice generation: pick a client + date range → generate a clean
    printable HTML invoice (client name, date range, line items grouped by day or
    by domain, subtotal, total). A "Print / Save as PDF" button using
    `window.print()` is sufficient for the prototype — no PDF library needed.

## 6. Non-Functional Requirements
- Manifest V3.
- No external network calls or analytics in the prototype — everything local.
- No frameworks required; plain HTML/CSS/JS is fine and keeps this reviewable/
  buildable quickly. (If Claude Code prefers a lightweight framework, that's fine,
  but don't add build tooling complexity for a local prototype.)
- Reasonably clean, readable code — this is a prototype meant to be iterated on,
  not throwaway.

## 7. Data Model (chrome.storage.local)

```js
// Per-day activity log
"log:2026-09-10": [
  { domain: "gmail.com", durationMs: 1320000, startedAt: 1234, endedAt: 5678, client: "client_1" }
]

// Manually added entries (kept separate from auto-tracked log, or merged with a `manual: true` flag — pick one and be consistent)
"manualEntries": [
  { id, date, description, client: "client_1", durationMs, createdAt }
]

// Clients
"clients": [
  { id: "client_1", name: "Acme Corp", hourlyRate: 150 }
]

// Domain -> client auto-tagging
"domainClientMap": { "gmail.com": "client_1", "notion.so": "client_2" }
```

## 8. Existing Starter Code

There is already a working MVP with basic tab tracking, a popup, and CSV export
(built as a first pass — see attached `billable-tracker` folder/zip). It has:
- `manifest.json` (V3, permissions: tabs, idle, storage, alarms, downloads)
- `background.js` (tab/domain tracking, idle/focus handling, checkpoint alarm)
- `popup.html/css/js` (today-only view, per-domain client dropdown, CSV export)
- `icons/` (placeholder icons)

**Instruction to Claude Code:** Use this as the foundation rather than starting
from scratch. Extend it to meet the full spec above — the main gaps are: (a) no
client/rate model yet (popup currently uses a hardcoded client name list with no
rates), (b) no date-range/history view (today-only), (c) no options/dashboard page,
(d) no manual entry, (e) no invoice generation. Refactor as needed if the current
structure doesn't scale to these features cleanly.

## 9. Suggested Build Order (for Claude Code to work through as milestones)

1. **Data layer refactor**: introduce `clients` and rate-aware `domainClientMap`
   (client IDs, not raw name strings). Write small helper functions for reading/
   writing/aggregating storage so both popup and options page can share them
   (e.g. a `storage.js` module).
2. **Options page skeleton**: create `options.html/js/css`, wire it up in
   `manifest.json`, add a link to it from the popup.
3. **Date range + aggregation**: implement Today/Week/Month/Custom range
   selection and an aggregation function that sums duration and $ per client
   across the selected range.
4. **Client management UI**: add/edit/delete clients + hourly rate, on the
   options page.
5. **Entry table**: list all entries in range, allow editing client assignment
   and deleting entries.
6. **Manual entry form**: add a manual time block tied to a client.
7. **CSV export**: extend existing export to support a date range and include
   rate/amount columns.
8. **Invoice generation**: pick client + range → render a clean printable HTML
   invoice view → `window.print()`.
9. **Popup polish**: show today's $ total (not just time), add the dashboard link.

## 10. Acceptance Criteria for the Prototype
- [ ] Loads without errors via `chrome://extensions` → Load unpacked.
- [ ] Browsing for a few minutes across 2-3 different sites produces visible,
      reasonably accurate per-domain time entries.
- [ ] Assigning a client to a domain persists and auto-applies to future time on
      that domain.
- [ ] Options page shows correct aggregated time and dollar totals for
      Today/Week/Month, matching a manual sum of the underlying entries.
- [ ] A manual entry can be added and shows up correctly in totals and exports.
- [ ] CSV export produces a valid, correctly-totaled file for a selected range.
- [ ] Invoice view renders a clean, printable summary for one client over a
      date range with a correct total.

## 11. Open Questions (flag back to the human, don't guess silently on these)
- Should "Unassigned" time be visible/exportable at all, or hidden entirely from
  client-facing views? (Leaning: visible in the dashboard for the user's own
  awareness, excluded from client invoices.)
- Should idle/focus thresholds be user-configurable, or fixed for the prototype?
  (Fine to leave fixed for now.)
