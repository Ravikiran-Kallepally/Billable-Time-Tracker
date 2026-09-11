// popup.js — today-only quick glance view.

import { dateKey, formatDuration, formatCurrency } from './lib/util.js';
import { getClients, getDomainClientMap, getEntriesInRange, assignDomainToClient, aggregateByClient } from './lib/storage.js';

const totalTimeEl = document.getElementById('totalTime');
const totalAmountEl = document.getElementById('totalAmount');
const emptyStateEl = document.getElementById('emptyState');
const domainTableEl = document.getElementById('domainTable');
const domainTableBody = document.getElementById('domainTableBody');

document.getElementById('dashboardBtn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
document.getElementById('refreshBtn').addEventListener('click', render);

async function render() {
  // Ask the service worker to flush any in-progress session first, so
  // "today" reflects activity up to the moment the popup was opened.
  try {
    await chrome.runtime.sendMessage({ type: 'flushNow' });
  } catch {
    /* background may be waking up; storage read below is still fine */
  }

  const today = dateKey();
  const [clients, domainMap, entries] = await Promise.all([
    getClients(),
    getDomainClientMap(),
    getEntriesInRange(today, today),
  ]);

  const totals = aggregateByClient(entries, clients);
  totalTimeEl.textContent = formatDuration(totals.totalDurationMs);
  totalAmountEl.textContent = formatCurrency(totals.totalAmount);

  const byDomain = new Map();
  for (const e of entries) {
    if (e.source !== 'tracked') continue;
    byDomain.set(e.label, (byDomain.get(e.label) || 0) + e.durationMs);
  }

  const domains = [...byDomain.entries()].sort((a, b) => b[1] - a[1]);

  if (domains.length === 0) {
    emptyStateEl.hidden = false;
    domainTableEl.hidden = true;
    return;
  }
  emptyStateEl.hidden = true;
  domainTableEl.hidden = false;
  domainTableBody.innerHTML = '';

  for (const [domain, durationMs] of domains) {
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    nameTd.className = 'domain-name';
    nameTd.textContent = domain;
    nameTd.title = domain;

    const durationTd = document.createElement('td');
    durationTd.className = 'domain-duration';
    durationTd.textContent = formatDuration(durationMs);

    const clientTd = document.createElement('td');
    const select = document.createElement('select');
    select.className = 'client-select';

    const unassignedOpt = document.createElement('option');
    unassignedOpt.value = '';
    unassignedOpt.textContent = 'Unassigned';
    select.appendChild(unassignedOpt);

    for (const client of clients) {
      const opt = document.createElement('option');
      opt.value = client.id;
      opt.textContent = client.name;
      select.appendChild(opt);
    }
    select.value = domainMap[domain] || '';

    select.addEventListener('change', async () => {
      await assignDomainToClient(domain, select.value || null);
      render();
    });

    clientTd.appendChild(select);
    tr.append(nameTd, durationTd, clientTd);
    domainTableBody.appendChild(tr);
  }
}

render();
