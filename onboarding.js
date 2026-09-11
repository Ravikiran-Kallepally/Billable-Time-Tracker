// onboarding.js — 3-step first-run flow: prove passive tracking works,
// add a first client, recap where everything lives.

import { addClient } from './lib/storage.js';

const TOTAL_STEPS = 3;
let currentStep = 1;

const steps = document.querySelectorAll('.step');
const dots = document.querySelectorAll('.dot');

function goToStep(n) {
  currentStep = Math.min(Math.max(n, 1), TOTAL_STEPS);
  steps.forEach((el) => el.classList.toggle('active', Number(el.dataset.step) === currentStep));
  dots.forEach((el) => {
    const n2 = Number(el.dataset.dot);
    el.classList.toggle('active', n2 === currentStep);
    el.classList.toggle('done', n2 < currentStep);
  });
}

document.querySelectorAll('.next-btn').forEach((btn) => btn.addEventListener('click', () => goToStep(currentStep + 1)));
document.querySelectorAll('.back-btn').forEach((btn) => btn.addEventListener('click', () => goToStep(currentStep - 1)));
document.querySelector('.skip-btn')?.addEventListener('click', () => goToStep(3));

document.getElementById('openDashboardBtn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
document.getElementById('doneBtn').addEventListener('click', () => {
  window.close();
});

// --- Add first client ---------------------------------------------------

const onboardClientForm = document.getElementById('onboardClientForm');
const obClientConfirm = document.getElementById('obClientConfirm');

onboardClientForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('obClientName').value.trim();
  const rate = Number(document.getElementById('obClientRate').value);
  if (!name || Number.isNaN(rate) || rate < 0) return;

  await addClient({ name, hourlyRate: rate });
  obClientConfirm.hidden = false;
  onboardClientForm.reset();
});

// --- Live tracking demo ---------------------------------------------------

const liveDotEl = document.getElementById('liveDot');
const liveStatusEl = document.getElementById('liveStatus');
const liveSubEl = document.getElementById('liveSub');

let baselineDomain = null;
let baselineElapsedMs = 0;
let baselineAt = 0;

function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s and counting`;
}

function formatAgo(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  return `${Math.round(sec / 60)}m ago`;
}

function render(status) {
  if (!status) {
    liveDotEl.classList.remove('on');
    liveStatusEl.textContent = 'Starting up…';
    liveSubEl.textContent = '';
    baselineDomain = null;
    return;
  }

  if (status.active) {
    baselineDomain = status.domain;
    baselineElapsedMs = status.elapsedMs;
    baselineAt = Date.now();
    liveDotEl.classList.add('on');
    liveStatusEl.textContent = `Tracking ${status.domain}`;
    liveSubEl.textContent = formatElapsed(baselineElapsedMs);
    return;
  }

  baselineDomain = null;
  liveDotEl.classList.remove('on');
  liveStatusEl.textContent = 'Paused right now';
  if (status.lastDomain) {
    liveSubEl.textContent = `Was on ${status.lastDomain} ${formatAgo(status.lastAgoMs)} — switch tabs and back to see this update.`;
  } else {
    liveSubEl.textContent = 'Switch to another tab for a few seconds, then come back.';
  }
}

async function pollStatus() {
  let status = null;
  try {
    status = await chrome.runtime.sendMessage({ type: 'getStatus' });
  } catch {
    /* background waking up */
  }
  render(status);
}

function tick() {
  if (!baselineDomain) return;
  const elapsed = baselineElapsedMs + (Date.now() - baselineAt);
  liveSubEl.textContent = formatElapsed(elapsed);
}

pollStatus();
setInterval(pollStatus, 3000);
setInterval(tick, 1000);
