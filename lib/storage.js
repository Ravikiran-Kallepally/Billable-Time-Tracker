// lib/storage.js
// Shared data-access layer over chrome.storage.local, used by background.js,
// popup.js, and options.js. Keeps the storage schema (see PRD §7) in one place.

import { dateKey, dateKeysBetween, uuid, msToAmount } from './util.js';

const UNASSIGNED_ID = null; // client id used for untagged time

// ---------------------------------------------------------------------------
// Per-day tracked log: "log:YYYY-MM-DD" -> [{ id, domain, durationMs, startedAt, endedAt, client }]
// ---------------------------------------------------------------------------

async function getLog(key) {
  const data = await chrome.storage.local.get(key);
  return data[key] || [];
}

async function setLog(key, entries) {
  await chrome.storage.local.set({ [key]: entries });
}

/**
 * Append a freshly-tracked chunk of time to the day's log, applying the
 * merge/noise rules from the PRD:
 *  - merge into the previous entry if same domain and gap < 5s
 *  - otherwise drop it if the chunk itself is under 3s (tab-switch noise)
 */
export async function appendTrackedEntry(key, { domain, durationMs, startedAt, endedAt }) {
  const log = await getLog(key);
  const last = log[log.length - 1];

  if (last && last.domain === domain && startedAt - last.endedAt < 5000 && startedAt - last.endedAt >= 0) {
    last.endedAt = endedAt;
    last.durationMs = last.endedAt - last.startedAt;
    await setLog(key, log);
    return last;
  }

  if (durationMs < 3000) return null; // noise, drop it

  const clientId = await getClientForDomain(domain);
  const entry = { id: uuid(), domain, durationMs, startedAt, endedAt, client: clientId };
  log.push(entry);
  await setLog(key, log);
  return entry;
}

export async function updateLogEntry(key, id, patch) {
  const log = await getLog(key);
  const entry = log.find((e) => e.id === id);
  if (!entry) return null;
  Object.assign(entry, patch);
  if (patch.durationMs != null && entry.startedAt != null) {
    entry.endedAt = entry.startedAt + patch.durationMs;
  }
  await setLog(key, log);
  return entry;
}

/** Deletes the entry and returns it (so the caller can offer an Undo). */
export async function deleteLogEntry(key, id) {
  const log = await getLog(key);
  const removed = log.find((e) => e.id === id) || null;
  await setLog(key, log.filter((e) => e.id !== id));
  return removed;
}

/** Undo for deleteLogEntry: re-inserts a previously-deleted entry. */
export async function restoreLogEntry(key, entry) {
  if (!entry) return;
  const log = await getLog(key);
  log.push(entry);
  log.sort((a, b) => a.startedAt - b.startedAt);
  await setLog(key, log);
}

// ---------------------------------------------------------------------------
// Manual entries: "manualEntries" -> [{ id, date, description, client, durationMs, createdAt }]
// ---------------------------------------------------------------------------

export async function getManualEntries() {
  const data = await chrome.storage.local.get('manualEntries');
  return data.manualEntries || [];
}

async function setManualEntries(entries) {
  await chrome.storage.local.set({ manualEntries: entries });
}

export async function addManualEntry({ date, description, client, durationMs }) {
  const entries = await getManualEntries();
  const entry = { id: uuid(), date, description, client: client || null, durationMs, createdAt: Date.now() };
  entries.push(entry);
  await setManualEntries(entries);
  return entry;
}

export async function updateManualEntry(id, patch) {
  const entries = await getManualEntries();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return null;
  Object.assign(entry, patch);
  await setManualEntries(entries);
  return entry;
}

/** Deletes the entry and returns it (so the caller can offer an Undo). */
export async function deleteManualEntry(id) {
  const entries = await getManualEntries();
  const removed = entries.find((e) => e.id === id) || null;
  await setManualEntries(entries.filter((e) => e.id !== id));
  return removed;
}

/** Undo for deleteManualEntry: re-inserts a previously-deleted entry. */
export async function restoreManualEntry(entry) {
  if (!entry) return;
  const entries = await getManualEntries();
  entries.push(entry);
  await setManualEntries(entries);
}

// ---------------------------------------------------------------------------
// Clients: "clients" -> [{ id, name, hourlyRate }]
// ---------------------------------------------------------------------------

export async function getClients() {
  const data = await chrome.storage.local.get('clients');
  return data.clients || [];
}

async function setClients(clients) {
  await chrome.storage.local.set({ clients });
}

export async function addClient({ name, hourlyRate }) {
  const clients = await getClients();
  const client = { id: uuid(), name, hourlyRate: Number(hourlyRate) || 0 };
  clients.push(client);
  await setClients(clients);
  return client;
}

export async function updateClient(id, patch) {
  const clients = await getClients();
  const client = clients.find((c) => c.id === id);
  if (!client) return null;
  Object.assign(client, patch);
  if (patch.hourlyRate != null) client.hourlyRate = Number(patch.hourlyRate) || 0;
  await setClients(clients);
  return client;
}

/**
 * Delete a client and clean up every dangling reference to it. Returns a
 * snapshot describing everything that changed, so the caller can offer a
 * full Undo (see restoreDeletedClient) rather than just a confirm() dialog.
 */
export async function deleteClient(id) {
  const clients = await getClients();
  const client = clients.find((c) => c.id === id) || null;
  await setClients(clients.filter((c) => c.id !== id));

  const map = await getDomainClientMap();
  const unmappedDomains = [];
  for (const domain of Object.keys(map)) {
    if (map[domain] === id) {
      unmappedDomains.push(domain);
      delete map[domain];
    }
  }
  if (unmappedDomains.length) await setDomainClientMap(map);

  const manualEntries = await getManualEntries();
  const clearedManualIds = [];
  for (const e of manualEntries) {
    if (e.client === id) {
      e.client = null;
      clearedManualIds.push(e.id);
    }
  }
  if (clearedManualIds.length) await setManualEntries(manualEntries);

  const allData = await chrome.storage.local.get(null);
  const logUpdates = {};
  const clearedLogEntries = []; // { logKey, id }
  for (const key of Object.keys(allData)) {
    if (!key.startsWith('log:')) continue;
    let changed = false;
    for (const entry of allData[key]) {
      if (entry.client === id) {
        entry.client = null;
        changed = true;
        clearedLogEntries.push({ logKey: key, id: entry.id });
      }
    }
    if (changed) logUpdates[key] = allData[key];
  }
  if (Object.keys(logUpdates).length) await chrome.storage.local.set(logUpdates);

  return { client, unmappedDomains, clearedManualIds, clearedLogEntries };
}

/** Undo for deleteClient: restores the client and every reference deleteClient cleared. */
export async function restoreDeletedClient(snapshot) {
  if (!snapshot?.client) return;

  const clients = await getClients();
  clients.push(snapshot.client);
  await setClients(clients);

  if (snapshot.unmappedDomains?.length) {
    const map = await getDomainClientMap();
    for (const domain of snapshot.unmappedDomains) map[domain] = snapshot.client.id;
    await setDomainClientMap(map);
  }

  if (snapshot.clearedManualIds?.length) {
    const manualEntries = await getManualEntries();
    for (const e of manualEntries) {
      if (snapshot.clearedManualIds.includes(e.id)) e.client = snapshot.client.id;
    }
    await setManualEntries(manualEntries);
  }

  if (snapshot.clearedLogEntries?.length) {
    const keys = [...new Set(snapshot.clearedLogEntries.map((e) => e.logKey))];
    const data = await chrome.storage.local.get(keys);
    const updates = {};
    for (const logKey of keys) {
      const ids = snapshot.clearedLogEntries.filter((e) => e.logKey === logKey).map((e) => e.id);
      const log = data[logKey] || [];
      for (const entry of log) {
        if (ids.includes(entry.id)) entry.client = snapshot.client.id;
      }
      updates[logKey] = log;
    }
    await chrome.storage.local.set(updates);
  }
}

// ---------------------------------------------------------------------------
// Domain -> client auto-tagging: "domainClientMap" -> { domain: clientId }
// ---------------------------------------------------------------------------

export async function getDomainClientMap() {
  const data = await chrome.storage.local.get('domainClientMap');
  return data.domainClientMap || {};
}

async function setDomainClientMap(map) {
  await chrome.storage.local.set({ domainClientMap: map });
}

export async function getClientForDomain(domain) {
  const map = await getDomainClientMap();
  return map[domain] ?? null;
}

/**
 * Assign a domain to a client (or unassign with clientId = null): updates the
 * map for future tracking, and retags any entries already logged today for
 * that domain so the popup reflects the change immediately.
 */
export async function assignDomainToClient(domain, clientId) {
  const map = await getDomainClientMap();
  if (clientId) map[domain] = clientId;
  else delete map[domain];
  await setDomainClientMap(map);

  const todayKeyStr = dateKey();
  const log = await getLog(todayKeyStr);
  let changed = false;
  for (const entry of log) {
    if (entry.domain === domain) {
      entry.client = clientId || null;
      changed = true;
    }
  }
  if (changed) await setLog(todayKeyStr, log);
}

// ---------------------------------------------------------------------------
// Range queries + aggregation
// ---------------------------------------------------------------------------

/**
 * All entries (tracked + manual) between startKey and endKey inclusive,
 * normalized to: { id, source, date, label, client, durationMs }
 */
export async function getEntriesInRange(startKey, endKey) {
  const keys = dateKeysBetween(startKey, endKey);
  const logKeys = keys.map((k) => `log:${k}`);
  const data = await chrome.storage.local.get([...logKeys, 'manualEntries']);

  const entries = [];
  for (const k of keys) {
    const dayLog = data[`log:${k}`] || [];
    for (const e of dayLog) {
      entries.push({ id: e.id, source: 'tracked', date: k, label: e.domain, client: e.client, durationMs: e.durationMs });
    }
  }
  const manual = data.manualEntries || [];
  for (const e of manual) {
    if (e.date >= startKey && e.date <= endKey) {
      entries.push({ id: e.id, source: 'manual', date: e.date, label: e.description, client: e.client, durationMs: e.durationMs });
    }
  }
  entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return entries;
}

/**
 * Sum duration/$ per client for a list of normalized entries.
 * Returns { totalDurationMs, totalAmount, byClient: [...], unassignedDurationMs }
 * totalAmount only counts time assigned to a client (unassigned time is
 * visible for the user's own awareness but never counted as billable $).
 */
export function aggregateByClient(entries, clients) {
  const byClientId = new Map();
  let unassignedDurationMs = 0;

  for (const e of entries) {
    const cid = e.client || UNASSIGNED_ID;
    if (!cid) {
      unassignedDurationMs += e.durationMs;
      continue;
    }
    if (!byClientId.has(cid)) byClientId.set(cid, 0);
    byClientId.set(cid, byClientId.get(cid) + e.durationMs);
  }

  const byClient = [];
  let totalAmount = 0;
  for (const [clientId, durationMs] of byClientId.entries()) {
    const client = clients.find((c) => c.id === clientId);
    const name = client ? client.name : 'Deleted client';
    const rate = client ? client.hourlyRate : 0;
    const amount = msToAmount(durationMs, rate);
    totalAmount += amount;
    byClient.push({ clientId, name, rate, durationMs, amount });
  }
  byClient.sort((a, b) => b.durationMs - a.durationMs);

  const totalDurationMs = byClient.reduce((s, c) => s + c.durationMs, 0) + unassignedDurationMs;

  return { totalDurationMs, totalAmount, byClient, unassignedDurationMs };
}

export { UNASSIGNED_ID };
