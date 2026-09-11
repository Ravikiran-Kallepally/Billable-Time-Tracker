// background.js — MV3 service worker (module). Passive per-domain time tracking.
//
// Tracks the active/focused/non-idle tab's domain. Persists the in-progress
// session to chrome.storage.session so a service-worker restart loses at
// most one checkpoint interval (~60s) of time, per PRD §5.1.

import { normalizeDomain, dateKey } from './lib/util.js';
import { appendTrackedEntry } from './lib/storage.js';

const CHECKPOINT_ALARM = 'checkpoint';
const IDLE_THRESHOLD_SECONDS = 60;

// In-memory mirror of the persisted session. Rehydrated from
// chrome.storage.session on first use after every service-worker wake.
let session = null; // { domain, tabId, startedAt, lastFlushAt }
// Last domain we were tracking, kept around even after the session ends —
// lets the popup/onboarding page say "a moment ago you were on X" instead of
// going silent the instant tracking pauses.
let lastTracked = null; // { domain, updatedAt }
let sessionLoaded = false;

let idleState = 'active';
let focusedWindowId = chrome.windows.WINDOW_ID_NONE;

async function loadSession() {
  if (sessionLoaded) return;
  const data = await chrome.storage.session.get(['activeSession', 'lastTracked']);
  session = data.activeSession || null;
  lastTracked = data.lastTracked || null;
  sessionLoaded = true;
}

async function persistSession() {
  if (session) await chrome.storage.session.set({ activeSession: session });
  else await chrome.storage.session.remove('activeSession');
}

/** The domain/tab that should currently be tracked, or null if nothing qualifies. */
async function getEligibleTarget() {
  if (idleState !== 'active') return null;
  if (focusedWindowId === chrome.windows.WINDOW_ID_NONE || focusedWindowId == null) return null;

  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, windowId: focusedWindowId });
  } catch {
    return null;
  }
  const tab = tabs[0];
  if (!tab || !tab.url) return null;

  const domain = normalizeDomain(tab.url);
  if (!domain) return null;
  return { domain, tabId: tab.id };
}

/** Write out accumulated time since the last flush; optionally end the session. */
async function flushSession(now, ending) {
  if (!session) return;
  const domain = session.domain;
  const duration = now - session.lastFlushAt;
  if (duration > 0) {
    await appendTrackedEntry(`log:${dateKey(new Date(session.lastFlushAt))}`, {
      domain,
      durationMs: duration,
      startedAt: session.lastFlushAt,
      endedAt: now,
    });
  }
  lastTracked = { domain, updatedAt: now };
  await chrome.storage.session.set({ lastTracked });

  if (ending) {
    session = null;
  } else {
    session.lastFlushAt = now;
  }
  await persistSession();
}

/** Re-evaluate what should be tracked and switch sessions if needed. Call on every relevant event. */
async function sync() {
  await loadSession();
  const target = await getEligibleTarget();
  const now = Date.now();
  const currentDomain = session?.domain ?? null;
  const newDomain = target?.domain ?? null;

  if (currentDomain !== newDomain) {
    if (session) await flushSession(now, true);
    if (target) {
      session = { domain: target.domain, tabId: target.tabId, startedAt: now, lastFlushAt: now };
      await persistSession();
    }
  } else if (session && target && session.tabId !== target.tabId) {
    // Same domain, different tab (e.g. two tabs on the same site) — keep the session running.
    session.tabId = target.tabId;
    await persistSession();
  }
  await updateBadge();
}

async function checkpoint() {
  await loadSession();
  if (session) await flushSession(Date.now(), false);
  await updateBadge();
}

// --- Live badge ----------------------------------------------------------
// The toolbar icon is the one piece of UI you don't have to open anything to
// see, so it's the fastest way to prove passive tracking is actually
// happening rather than a silent black box. Green + elapsed time = tracking
// right now; blank = paused (idle, unfocused, or no billable-looking tab).

function formatBadge(ms) {
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

async function updateBadge() {
  await loadSession();
  if (!session) {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'Billable Time Tracker: paused' });
    return;
  }
  const elapsedMs = Date.now() - session.startedAt;
  chrome.action.setBadgeText({ text: formatBadge(elapsedMs) });
  chrome.action.setBadgeBackgroundColor({ color: '#059669' });
  chrome.action.setTitle({ title: `Billable Time Tracker: tracking ${session.domain} (${formatBadge(elapsedMs)})` });
}

// Best-effort smoothing: while the service worker happens to stay alive
// (e.g. during active browsing, when tab/idle events keep firing anyway),
// nudge the badge every 20s so the elapsed time doesn't look frozen. MV3 can
// still terminate the worker between events regardless of this timer — the
// badge simply catches back up on the next real event or the 60s checkpoint,
// so nothing is ever lost, it just may look briefly stale.
setInterval(updateBadge, 20000);

// --- Setup -------------------------------------------------------------

function setup() {
  chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SECONDS);
  chrome.alarms.create(CHECKPOINT_ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

// First-run onboarding: walk new users through what passive tracking means
// and get their first client set up, instead of dropping them into an empty
// dashboard and hoping they figure it out.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }
});

// Top-level init runs every time the service worker spins up (not just on
// install/browser-startup), since MV3 workers can be terminated and revived
// on any event.
(async () => {
  try {
    idleState = await new Promise((resolve) => chrome.idle.queryState(IDLE_THRESHOLD_SECONDS, resolve));
  } catch {
    /* default to 'active' */
  }
  try {
    const win = await chrome.windows.getLastFocused();
    if (win && win.focused) focusedWindowId = win.id;
  } catch {
    /* no focused window yet */
  }
  await sync();
})();

chrome.idle.onStateChanged.addListener((state) => {
  idleState = state;
  sync();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  focusedWindowId = windowId;
  sync();
});

chrome.tabs.onActivated.addListener(() => sync());

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'complete') sync();
});

chrome.tabs.onRemoved.addListener(() => sync());
chrome.windows.onRemoved.addListener(() => sync());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECKPOINT_ALARM) checkpoint();
});

// Best-effort: if the worker is about to be suspended, flush what we have.
chrome.runtime.onSuspend.addListener(() => {
  if (session) flushSession(Date.now(), false);
});

// Let popup/options/onboarding talk to the tracking state.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'flushNow') {
    checkpoint().then(() => sendResponse({ ok: true }));
    return true; // keep the message channel open for the async response
  }
  if (msg?.type === 'getStatus') {
    // Used by the onboarding page's live tracking demo.
    loadSession().then(() => {
      sendResponse({
        active: !!session,
        domain: session?.domain ?? null,
        elapsedMs: session ? Date.now() - session.startedAt : 0,
        lastDomain: lastTracked?.domain ?? null,
        lastAgoMs: lastTracked ? Date.now() - lastTracked.updatedAt : null,
      });
    });
    return true;
  }
  return false;
});
