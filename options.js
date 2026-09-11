// options.js — the dashboard: date-range summary, entry table, manual entry,
// client management, CSV export, and invoice generation.

import { dateKey, getRangeKeys, formatDuration, formatCurrency, msToAmount, csvEscape } from './lib/util.js';
import {
  getClients,
  addClient,
  updateClient,
  deleteClient,
  restoreDeletedClient,
  getEntriesInRange,
  aggregateByClient,
  updateLogEntry,
  deleteLogEntry,
  restoreLogEntry,
  addManualEntry,
  updateManualEntry,
  deleteManualEntry,
  restoreManualEntry,
} from './lib/storage.js';

const state = {
  range: 'today',
  customStart: null,
  customEnd: null,
};

let clientsCache = [];
let entriesCache = [];

// --- Elements ---------------------------------------------------------
const rangeSegmented = document.getElementById('rangeSegmented');
const customRangeEl = document.getElementById('customRange');
const customStartInput = document.getElementById('customStart');
const customEndInput = document.getElementById('customEnd');
const applyCustomRangeBtn = document.getElementById('applyCustomRange');
const rangeLabelEl = document.getElementById('rangeLabel');

const summaryTotalTimeEl = document.getElementById('summaryTotalTime');
const summaryTotalAmountEl = document.getElementById('summaryTotalAmount');
const summaryUnassignedEl = document.getElementById('summaryUnassigned');
const clientSummaryBody = document.getElementById('clientSummaryBody');
const summaryEmptyEl = document.getElementById('summaryEmpty');

const entryTableBody = document.getElementById('entryTableBody');
const entryEmptyEl = document.getElementById('entryEmpty');

const manualEntryForm = document.getElementById('manualEntryForm');
const manualDateInput = document.getElementById('manualDate');
const manualDescriptionInput = document.getElementById('manualDescription');
const manualClientSelect = document.getElementById('manualClient');
const manualDurationInput = document.getElementById('manualDuration');

const clientTableBody = document.getElementById('clientTableBody');
const addClientForm = document.getElementById('addClientForm');
const newClientNameInput = document.getElementById('newClientName');
const newClientRateInput = document.getElementById('newClientRate');

const exportCsvBtn = document.getElementById('exportCsvBtn');
const invoiceClientSelect = document.getElementById('invoiceClient');
const generateInvoiceBtn = document.getElementById('generateInvoiceBtn');

const invoiceOverlay = document.getElementById('invoiceOverlay');
const invoiceContent = document.getElementById('invoiceContent');
const closeInvoiceBtn = document.getElementById('closeInvoiceBtn');
const printInvoiceBtn = document.getElementById('printInvoiceBtn');

const tourLinkBtn = document.getElementById('tourLinkBtn');
tourLinkBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
});

// --- Undo snackbar ------------------------------------------------------
// Deletes are optimistic (no blocking confirm() dialog) — an action happens
// immediately and this snackbar offers a few seconds to undo it instead.

const snackbarEl = document.getElementById('snackbar');
const snackbarMessageEl = document.getElementById('snackbarMessage');
const snackbarUndoBtn = document.getElementById('snackbarUndoBtn');
let snackbarTimer = null;
let pendingUndo = null;

function showUndoSnackbar(message, undoFn) {
  clearTimeout(snackbarTimer);
  snackbarMessageEl.textContent = message;
  pendingUndo = undoFn;
  snackbarEl.hidden = false;
  // Force a reflow so the transition plays even if a snackbar was already showing.
  void snackbarEl.offsetWidth;
  snackbarEl.classList.add('visible');
  snackbarTimer = setTimeout(hideSnackbar, 6000);
}

function hideSnackbar() {
  snackbarEl.classList.remove('visible');
  pendingUndo = null;
  setTimeout(() => {
    if (!snackbarEl.classList.contains('visible')) snackbarEl.hidden = true;
  }, 200);
}

snackbarUndoBtn.addEventListener('click', async () => {
  const undoFn = pendingUndo;
  clearTimeout(snackbarTimer);
  hideSnackbar();
  if (undoFn) {
    await undoFn();
    await refresh();
  }
});

// --- Range selection ----------------------------------------------------

rangeSegmented.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  const range = btn.dataset.range;
  [...rangeSegmented.children].forEach((b) => b.classList.toggle('active', b === btn));
  if (range === 'custom') {
    customRangeEl.hidden = false;
    if (!customStartInput.value) customStartInput.value = dateKey();
    if (!customEndInput.value) customEndInput.value = dateKey();
    return; // wait for Apply
  }
  customRangeEl.hidden = true;
  state.range = range;
  refresh();
});

applyCustomRangeBtn.addEventListener('click', () => {
  if (!customStartInput.value || !customEndInput.value) return;
  if (customStartInput.value > customEndInput.value) {
    alert('Start date must be before end date.');
    return;
  }
  state.range = 'custom';
  state.customStart = customStartInput.value;
  state.customEnd = customEndInput.value;
  refresh();
});

function currentRangeKeys() {
  return getRangeKeys(state.range, new Date(), state.customStart, state.customEnd);
}

function updateRangeLabel(startKey, endKey) {
  const opts = { month: 'short', day: 'numeric', year: 'numeric' };
  const start = new Date(startKey).toLocaleDateString(undefined, opts);
  const end = new Date(endKey).toLocaleDateString(undefined, opts);
  rangeLabelEl.textContent = startKey === endKey ? start : `${start} – ${end}`;
}

// --- Summary --------------------------------------------------------------

function renderSummary() {
  const totals = aggregateByClient(entriesCache, clientsCache);
  summaryTotalTimeEl.textContent = formatDuration(totals.totalDurationMs);
  summaryTotalAmountEl.textContent = formatCurrency(totals.totalAmount);
  summaryUnassignedEl.textContent = formatDuration(totals.unassignedDurationMs);

  clientSummaryBody.innerHTML = '';
  summaryEmptyEl.hidden = totals.byClient.length > 0;

  for (const c of totals.byClient) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(c.name)}</td>
      <td>${formatCurrency(c.rate)}/hr</td>
      <td>${formatDuration(c.durationMs)}</td>
      <td>${formatCurrency(c.amount)}</td>
    `;
    clientSummaryBody.appendChild(tr);
  }
}

// --- Entry table ------------------------------------------------------

function renderEntryTable() {
  entryTableBody.innerHTML = '';
  entryEmptyEl.hidden = entriesCache.length > 0;

  // Most recent first for readability.
  const sorted = [...entriesCache].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  for (const entry of sorted) {
    const tr = document.createElement('tr');

    const dateTd = document.createElement('td');
    dateTd.textContent = entry.date;

    const labelTd = document.createElement('td');
    labelTd.textContent = entry.label;
    labelTd.title = entry.source === 'tracked' ? 'Auto-tracked' : 'Manual entry';

    const clientTd = document.createElement('td');
    const select = document.createElement('select');
    select.className = 'select-input';
    select.appendChild(new Option('Unassigned', ''));
    for (const c of clientsCache) select.appendChild(new Option(c.name, c.id));
    select.value = entry.client || '';
    select.addEventListener('change', () => updateEntryClient(entry, select.value || null));
    clientTd.appendChild(select);

    const durationTd = document.createElement('td');
    const durationInput = document.createElement('input');
    durationInput.type = 'number';
    durationInput.min = '0';
    durationInput.step = '1';
    durationInput.className = 'duration-input';
    durationInput.value = Math.round(entry.durationMs / 60000);
    durationInput.addEventListener('change', () => {
      const minutes = Math.max(0, Math.round(Number(durationInput.value) || 0));
      updateEntryDuration(entry, minutes);
    });
    durationTd.appendChild(durationInput);

    const amountTd = document.createElement('td');
    const client = clientsCache.find((c) => c.id === entry.client);
    amountTd.textContent = client ? formatCurrency(msToAmount(entry.durationMs, client.hourlyRate)) : '—';

    const actionsTd = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className = 'icon-btn';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => deleteEntry(entry));
    actionsTd.appendChild(delBtn);

    tr.append(dateTd, labelTd, clientTd, durationTd, amountTd, actionsTd);
    entryTableBody.appendChild(tr);
  }
}

async function updateEntryClient(entry, clientId) {
  if (entry.source === 'tracked') await updateLogEntry(`log:${entry.date}`, entry.id, { client: clientId });
  else await updateManualEntry(entry.id, { client: clientId });
  await refresh();
}

async function updateEntryDuration(entry, minutes) {
  const durationMs = minutes * 60000;
  if (entry.source === 'tracked') await updateLogEntry(`log:${entry.date}`, entry.id, { durationMs });
  else await updateManualEntry(entry.id, { durationMs });
  await refresh();
}

async function deleteEntry(entry) {
  const logKey = `log:${entry.date}`;
  const removed = entry.source === 'tracked' ? await deleteLogEntry(logKey, entry.id) : await deleteManualEntry(entry.id);
  await refresh();
  showUndoSnackbar(`Deleted "${entry.label}"`, async () => {
    if (entry.source === 'tracked') await restoreLogEntry(logKey, removed);
    else await restoreManualEntry(removed);
  });
}

// --- Manual entry -----------------------------------------------------

manualEntryForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const minutes = Number(manualDurationInput.value);
  if (!manualDateInput.value || !manualDescriptionInput.value.trim() || !minutes || minutes <= 0) return;

  await addManualEntry({
    date: manualDateInput.value,
    description: manualDescriptionInput.value.trim(),
    client: manualClientSelect.value || null,
    durationMs: minutes * 60000,
  });

  manualEntryForm.reset();
  manualDateInput.value = dateKey();
  await refresh();
});

// --- Clients ------------------------------------------------------------

function renderClientTable() {
  clientTableBody.innerHTML = '';
  for (const client of clientsCache) {
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'name-input';
    nameInput.value = client.name;
    nameInput.addEventListener('change', () => saveClientEdit(client, { name: nameInput.value.trim() || client.name }));
    nameTd.appendChild(nameInput);

    const rateTd = document.createElement('td');
    const rateInput = document.createElement('input');
    rateInput.type = 'number';
    rateInput.min = '0';
    rateInput.step = '0.01';
    rateInput.className = 'rate-input';
    rateInput.value = client.hourlyRate;
    rateInput.addEventListener('change', () => saveClientEdit(client, { hourlyRate: Number(rateInput.value) || 0 }));
    rateTd.appendChild(rateInput);

    const actionsTd = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className = 'icon-btn';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => deleteClientRow(client));
    actionsTd.appendChild(delBtn);

    tr.append(nameTd, rateTd, actionsTd);
    clientTableBody.appendChild(tr);
  }
}

async function saveClientEdit(client, patch) {
  await updateClient(client.id, patch);
  await refresh();
}

async function deleteClientRow(client) {
  const snapshot = await deleteClient(client.id);
  await refresh();
  showUndoSnackbar(`Deleted client "${client.name}"`, async () => {
    await restoreDeletedClient(snapshot);
  });
}

addClientForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = newClientNameInput.value.trim();
  const rate = Number(newClientRateInput.value);
  if (!name || rate < 0 || Number.isNaN(rate)) return;
  await addClient({ name, hourlyRate: rate });
  addClientForm.reset();
  await refresh();
});

function renderClientDropdowns() {
  const currentManual = manualClientSelect.value;
  const currentInvoice = invoiceClientSelect.value;

  manualClientSelect.innerHTML = '';
  manualClientSelect.appendChild(new Option('Unassigned', ''));
  for (const c of clientsCache) manualClientSelect.appendChild(new Option(c.name, c.id));
  manualClientSelect.value = clientsCache.some((c) => c.id === currentManual) ? currentManual : '';

  invoiceClientSelect.innerHTML = '';
  if (clientsCache.length === 0) {
    invoiceClientSelect.appendChild(new Option('No clients yet', ''));
  } else {
    for (const c of clientsCache) invoiceClientSelect.appendChild(new Option(c.name, c.id));
    invoiceClientSelect.value = clientsCache.some((c) => c.id === currentInvoice) ? currentInvoice : clientsCache[0].id;
  }
}

// --- CSV export -----------------------------------------------------------

exportCsvBtn.addEventListener('click', () => {
  const { startKey, endKey } = currentRangeKeys();
  const rows = [['Date', 'Domain/Description', 'Client', 'Minutes', 'Rate', 'Amount']];

  for (const e of entriesCache) {
    const client = clientsCache.find((c) => c.id === e.client);
    const minutes = (e.durationMs / 60000).toFixed(2);
    rows.push([
      e.date,
      e.label,
      client ? client.name : 'Unassigned',
      minutes,
      client ? client.hourlyRate.toFixed(2) : '',
      client ? msToAmount(e.durationMs, client.hourlyRate).toFixed(2) : '0.00',
    ]);
  }

  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download(
    { url, filename: `billable-time_${startKey}_to_${endKey}.csv`, saveAs: true },
    () => setTimeout(() => URL.revokeObjectURL(url), 5000)
  );
});

// --- Invoice generation ----------------------------------------------------

generateInvoiceBtn.addEventListener('click', () => {
  const clientId = invoiceClientSelect.value;
  const client = clientsCache.find((c) => c.id === clientId);
  if (!client) {
    alert('Add a client first.');
    return;
  }
  const { startKey, endKey } = currentRangeKeys();
  const clientEntries = entriesCache.filter((e) => e.client === clientId);
  if (clientEntries.length === 0) {
    alert(`No billable time for ${client.name} in the selected range.`);
    return;
  }
  invoiceContent.innerHTML = buildInvoiceHTML(client, clientEntries, startKey, endKey);
  invoiceOverlay.hidden = false;
});

closeInvoiceBtn.addEventListener('click', () => {
  invoiceOverlay.hidden = true;
});
printInvoiceBtn.addEventListener('click', () => window.print());

function buildInvoiceHTML(client, clientEntries, startKey, endKey) {
  const byDate = new Map();
  for (const e of clientEntries) {
    if (!byDate.has(e.date)) byDate.set(e.date, { durationMs: 0, labels: new Set() });
    const bucket = byDate.get(e.date);
    bucket.durationMs += e.durationMs;
    bucket.labels.add(e.label);
  }

  const dates = [...byDate.keys()].sort();
  let total = 0;
  const rows = dates
    .map((date) => {
      const bucket = byDate.get(date);
      const hours = bucket.durationMs / 3600000;
      const amount = hours * client.hourlyRate;
      total += amount;
      return `<tr>
        <td>${formatDateLong(date)}</td>
        <td>${escapeHtml([...bucket.labels].join(', '))}</td>
        <td class="num">${hours.toFixed(2)}</td>
        <td class="num">${formatCurrency(amount)}</td>
      </tr>`;
    })
    .join('');

  const invoiceNumber = `INV-${startKey.replace(/-/g, '')}-${client.id.slice(0, 6).toUpperCase()}`;
  const today = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  return `
    <h1>Invoice</h1>
    <div class="invoice-meta">
      <div>
        <strong>Bill to:</strong><br />
        ${escapeHtml(client.name)}<br />
        Rate: ${formatCurrency(client.hourlyRate)}/hr
      </div>
      <div>
        <strong>Invoice #:</strong> ${invoiceNumber}<br />
        <strong>Date issued:</strong> ${today}<br />
        <strong>Period:</strong> ${formatDateLong(startKey)} – ${formatDateLong(endKey)}
      </div>
    </div>
    <table>
      <thead>
        <tr><th>Date</th><th>Description</th><th class="num">Hours</th><th class="num">Amount</th></tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td colspan="3">Total</td><td class="num">${formatCurrency(total)}</td></tr>
      </tfoot>
    </table>
  `;
}

function formatDateLong(key) {
  return new Date(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// --- Refresh / init ---------------------------------------------------

async function refresh() {
  try {
    await chrome.runtime.sendMessage({ type: 'flushNow' });
  } catch {
    /* background may be waking up */
  }

  const { startKey, endKey } = currentRangeKeys();
  updateRangeLabel(startKey, endKey);

  [clientsCache, entriesCache] = await Promise.all([getClients(), getEntriesInRange(startKey, endKey)]);

  renderSummary();
  renderEntryTable();
  renderClientTable();
  renderClientDropdowns();
}

manualDateInput.value = dateKey();
refresh();
