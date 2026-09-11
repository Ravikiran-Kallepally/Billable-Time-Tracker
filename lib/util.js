// lib/util.js
// Pure helper functions shared by background.js, popup.js, and options.js.
// No chrome.storage access here — see lib/storage.js for the data layer.

/** Turn a tab URL into a normalized domain, or null if it shouldn't be tracked. */
export function normalizeDomain(url) {
  if (!url) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  let host = u.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  return host || null;
}

/** 'YYYY-MM-DD' for a Date, in local time. */
export function dateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Parse a 'YYYY-MM-DD' key back into a local Date (midnight). */
export function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** All date keys from startKey to endKey inclusive. */
export function dateKeysBetween(startKey, endKey) {
  const start = parseDateKey(startKey);
  const end = parseDateKey(endKey);
  const keys = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    keys.push(dateKey(d));
  }
  return keys;
}

/** { startKey, endKey } for a named range, anchored on `today`. Week = Mon-Sun. */
export function getRangeKeys(rangeType, today = new Date(), customStart, customEnd) {
  const todayKey = dateKey(today);
  switch (rangeType) {
    case 'today':
      return { startKey: todayKey, endKey: todayKey };
    case 'week': {
      const day = today.getDay(); // 0 = Sun
      const mondayOffset = day === 0 ? -6 : 1 - day;
      const monday = new Date(today);
      monday.setDate(today.getDate() + mondayOffset);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      return { startKey: dateKey(monday), endKey: dateKey(sunday) };
    }
    case 'month': {
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      return { startKey: dateKey(first), endKey: dateKey(last) };
    }
    case 'custom':
      return { startKey: customStart, endKey: customEnd };
    default:
      return { startKey: todayKey, endKey: todayKey };
  }
}

/** ms -> "1h 23m" (or "45m", or "<1m"). */
export function formatDuration(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0 && m === 0) return '<1m';
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/** ms -> decimal hours string, e.g. "1.38", for CSV/invoice line items. */
export function formatHoursDecimal(ms) {
  return (ms / 3600000).toFixed(2);
}

export function formatCurrency(amount) {
  return `$${amount.toFixed(2)}`;
}

export function msToAmount(ms, hourlyRate) {
  return (ms / 3600000) * hourlyRate;
}

export function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Fallback (shouldn't be needed in modern Chrome).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
