// Subscription Finder UI. Everything happens in this tab: the file is read with
// the File API, parsed and analysed in memory, and discarded on "start over".
import { parseStatement, toTransactions } from './lib/csv.js';
import { findSubscriptions, yearlyTotal } from './lib/detect.js';
import { SERVICES, VERIFIED_ON } from './lib/services.js';
import { progress, countValue } from './lib/countup.js';

const $ = (sel, root = document) => root.querySelector(sel);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const MAX_BYTES = 20 * 1024 * 1024;

const state = { result: null, decisions: new Map(), pending: null, source: '' };

// ---------------------------------------------------------------- formatting
const usd = (n, digits = 0) => n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const money = (n) => `$${usd(n, 2)}`;
const fmtDay = (day, withYear = false) => new Date(day * 86400000).toLocaleDateString('en-US', {
  month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC',
});
const hueFor = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const svg = (paths) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  for (const d of paths) { const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); s.append(p); }
  return s;
};
const ICONS = {
  increase: ['M4 17l6-6 4 4 6-7', 'M15 8h5v5'],
  duplicate: ['M8 8h11v11H8z', 'M5 16V5h11'],
  overlap: ['M8 8h11v11H8z', 'M5 16V5h11'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4'],
};

// ---------------------------------------------------------------- views
function show(view) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.view !== view;
  document.body.classList.toggle('on-results', view === 'results');
  $('#savebar').classList.toggle('is-in', view === 'results');
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function showError(msg) {
  const e = $('#error');
  e.textContent = msg; e.hidden = !msg;
}

function countUp(node, to, { duration = 1600, digits = 0, from = 0 } = {}) {
  cancelAnimationFrame(node._raf);
  if (reduceMotion || duration === 0) { node.textContent = usd(to, digits); return; }
  const start = performance.now();
  const tick = (now) => {
    node.textContent = usd(countValue(now, start, duration, from, to), digits);
    if (progress(now, start, duration) < 1) node._raf = requestAnimationFrame(tick);
  };
  node._raf = requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- input
async function loadFile(file) {
  showError('');
  if (!file) return;
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
    showError("PDF statements aren't supported yet. In your bank's website, look for Download → CSV (sometimes called \"Spreadsheet\" or \"Excel\") and drop that file in instead.");
    return;
  }
  if (file.size > MAX_BYTES) { showError('That file is over 20 MB. Try exporting a shorter date range.'); return; }
  const text = await file.text();
  handleText(text, file.name);
}

async function loadSample() {
  showError('');
  const res = await fetch('sample-statement.csv', { cache: 'no-store' });
  handleText(await res.text(), 'Sample statement (fictional)');
}

function handleText(text, source) {
  state.source = source;
  let parsed;
  try { parsed = parseStatement(text); } catch { parsed = { ok: false, error: "We couldn't read that file." }; }
  if (parsed.ok) return analyse(parsed.transactions, parsed.format.label);
  if (parsed.needsMapping) return openMapping(parsed);
  showError(parsed.error || "We couldn't read that file. Is it a CSV export?");
}

// ---------------------------------------------------------------- mapping
function openMapping(parsed) {
  state.pending = parsed;
  const opts = (sel, includeNone) => {
    sel.replaceChildren();
    if (includeNone) sel.append(new Option('(none)', '-1'));
    parsed.headers.forEach((h, i) => sel.append(new Option(h, String(i))));
  };
  const m = parsed.mapping;
  const pick = (id, v, none) => { const s = $(id); opts(s, none); if (v >= 0) s.value = String(v); };
  pick('#map-date', m.date >= 0 ? m.date : 0);
  pick('#map-desc', m.description >= 0 ? m.description : Math.min(1, parsed.headers.length - 1));
  pick('#map-amount', m.amount >= 0 ? m.amount : Math.min(2, parsed.headers.length - 1));
  pick('#map-debit', m.debit >= 0 ? m.debit : Math.min(2, parsed.headers.length - 1));
  pick('#map-credit', m.credit >= 0 ? m.credit : -1, true);
  $('#map-mode').value = m.sign === 'debitcol' ? 'split' : m.sign === 'positive' ? 'single-positive' : 'single-negative';
  syncMapping();
  show('mapping');
}
function currentMapping() {
  const mode = $('#map-mode').value;
  const n = (id) => Number($(id).value);
  return {
    date: n('#map-date'), description: n('#map-desc'),
    amount: mode === 'split' ? -1 : n('#map-amount'),
    debit: mode === 'split' ? n('#map-debit') : -1,
    credit: mode === 'split' ? n('#map-credit') : -1,
    sign: mode === 'split' ? 'debitcol' : mode === 'single-positive' ? 'positive' : 'negative',
  };
}
function syncMapping() {
  const split = $('#map-mode').value === 'split';
  $('#field-amount').hidden = split;
  $('#field-debit').hidden = !split;
  $('#field-credit').hidden = !split;
  const m = currentMapping();
  const picked = new Set([m.date, m.description, m.amount, m.debit, m.credit].filter((x) => x >= 0));
  const table = $('#preview');
  table.replaceChildren();
  const head = el('tr');
  state.pending.headers.forEach((h, i) => head.append(el('th', picked.has(i) ? 'is-picked' : '', h)));
  table.append(el('thead'), el('tbody'));
  table.tHead.append(head);
  for (const r of state.pending.rows.slice(0, 5)) {
    const tr = el('tr');
    state.pending.headers.forEach((_, i) => tr.append(el('td', picked.has(i) ? 'is-picked' : '', r[i] ?? '')));
    table.tBodies[0].append(tr);
  }
}

// ---------------------------------------------------------------- analysis
async function analyse(transactions, formatLabel) {
  if (!transactions.length) { show('start'); showError('No transactions found in that file.'); return; }
  const result = findSubscriptions(transactions, { services: SERVICES });
  state.result = result;
  state.decisions = new Map(result.subscriptions.map((s) => [s.id, 'keep']));
  state.formatLabel = formatLabel;
  await scanAnimation(transactions.length, result);
  renderResults();
}

function scanAnimation(count, result) {
  if (reduceMotion) return Promise.resolve();
  show('scan');
  countUp($('#scan-count'), count, { duration: 900 });
  const lines = ['Reading your statement…', 'Grouping merchants…', 'Spotting repeat charges…', `Found ${result.subscriptions.length} subscriptions`];
  const line = $('#scan-line');
  return new Promise((resolve) => {
    lines.forEach((t, i) => setTimeout(() => { line.textContent = t; }, i * 330));
    setTimeout(resolve, lines.length * 330 + 250);
  });
}

function renderResults() {
  const { subscriptions, stopped, statement } = state.result;
  show('results');
  const view = $('#view-results');
  view.classList.add('is-ready');

  const total = yearlyTotal(subscriptions);
  countUp($('#total'), Math.round(total), { duration: 1900 });
  const monthly = total / 12;
  const sub = $('#hero-sub');
  sub.replaceChildren();
  if (subscriptions.length) {
    sub.append('a year on ', el('b', '', `${subscriptions.length} subscription${subscriptions.length === 1 ? '' : 's'}`), ` · about ${money(monthly)} a month`);
  } else {
    sub.textContent = "No recurring charges found. Try a longer date range (3+ months works best).";
  }

  const chips = $('#chips');
  chips.replaceChildren();
  const inc = subscriptions.filter((s) => s.flags.some((f) => f.type === 'increase')).length;
  const dup = subscriptions.filter((s) => s.flags.some((f) => f.type === 'duplicate' || f.type === 'overlap')).length;
  const chip = (cls, text, i) => { const c = el('span', `chip ${cls}`); c.append(el('i'), text); c.style.setProperty('--d', `${1.5 + i * 0.12}s`); return c; };
  let ci = 0;
  if (inc) chips.append(chip('warn', `${inc} price increase${inc === 1 ? '' : 's'}`, ci++));
  if (dup) chips.append(chip('dup', `${dup} possible duplicate${dup === 1 ? '' : 's'}`, ci++));
  chips.append(chip('', `${fmtDay(statement.from, true)} – ${fmtDay(statement.to, true)}`, ci++));

  const list = $('#subs');
  list.replaceChildren(...subscriptions.map((s, i) => card(s, i)));
  const stoppedBox = $('#stopped');
  stoppedBox.hidden = !stopped.length;
  $('#stopped-count').textContent = stopped.length ? `(${stopped.length})` : '';
  $('#stopped-list').replaceChildren(...stopped.map((s, i) => card(s, i, true)));

  $('#source-note').textContent = `${state.source} · read as ${state.formatLabel} · ${statement.count.toLocaleString('en-US')} transactions analysed on this device.`;
  $('#verified-on').textContent = new Date(VERIFIED_ON + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  updateSavings(false);
}

function card(s, i, stopped = false) {
  const li = el('li', 'sub');
  li.dataset.id = s.id;
  li.dataset.testid = 'sub';
  li.style.setProperty('--d', `${0.35 + Math.min(i, 14) * 0.07}s`);

  const mono = el('div', 'mono', s.name.replace(/^The /, '').charAt(0).toUpperCase());
  mono.style.setProperty('--h', String(hueFor(s.name)));
  mono.setAttribute('aria-hidden', 'true');

  const main = el('div', 'sub-main');
  main.append(el('h3', 'sub-name', s.name));
  const meta = el('p', 'sub-meta');
  const service = SERVICES.find((x) => x.id === s.service?.id);
  meta.append(s.cadenceLabel, el('span', 'dot', '·'), stopped ? `last ${money(s.lastAmount)} on ${fmtDay(s.lastDay, true)}` : `${money(s.lastAmount)} on ${fmtDay(s.lastDay)}`);
  if (service?.note) meta.append(el('span', 'dot', '·'), service.note);
  main.append(meta);

  const cost = el('div', 'sub-cost');
  const yearly = el('span', 'sub-yearly', `$${usd(s.yearly, s.yearly % 1 ? 2 : 0)}`);
  yearly.append(el('small', '', '/yr'));
  cost.append(yearly, el('span', 'sub-monthly', s.cadence === 'monthly' ? `${s.count} charges` : `≈ ${money(s.monthly)}/mo`));

  li.append(mono, main, cost);

  if (s.flags.length) {
    const flags = el('div', 'flags');
    for (const f of s.flags) {
      const tag = el('span', `flag flag-${f.type}`);
      tag.append(svg(ICONS[f.type] || ICONS.duplicate), f.text);
      flags.append(tag);
    }
    li.append(flags);
  }

  const actions = el('div', 'sub-actions');
  if (!stopped) {
    const toggle = el('div', 'toggle');
    toggle.setAttribute('role', 'group');
    toggle.setAttribute('aria-label', `Keep or cancel ${s.name}`);
    for (const choice of ['keep', 'cancel']) {
      const b = el('button', '', choice === 'keep' ? 'Keep' : 'Cancel');
      b.type = 'button';
      b.dataset.choice = choice;
      b.setAttribute('aria-pressed', String(choice === 'keep'));
      toggle.append(b);
    }
    actions.append(toggle);
  }
  const a = el('a', 'cancel-link');
  a.href = s.cancelUrl;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.dataset.kind = s.cancelKind;
  if (s.cancelKind === 'official') a.append('How to cancel', svg(ICONS.external));
  else a.append(svg(ICONS.search), 'Search how to cancel');
  a.title = s.cancelKind === 'official' ? `Official ${s.service.name} help page` : 'Opens a web search in a new tab';
  actions.append(a);
  li.append(actions);
  return li;
}

function setDecision(id, choice) {
  state.decisions.set(id, choice);
  const li = document.querySelector(`#subs .sub[data-id="${CSS.escape(id)}"]`);
  li.classList.toggle('is-cancel', choice === 'cancel');
  for (const b of li.querySelectorAll('.toggle button')) b.setAttribute('aria-pressed', String(b.dataset.choice === choice));
  updateSavings(true);
}

function updateSavings(animate) {
  const subs = state.result.subscriptions;
  const cancelled = subs.filter((s) => state.decisions.get(s.id) === 'cancel');
  const saved = Math.round(yearlyTotal(cancelled));
  const total = yearlyTotal(subs) || 1;
  const node = $('#savings');
  const prev = Number(node.dataset.value || 0);
  node.dataset.value = String(saved);
  countUp(node, saved, { from: prev, duration: animate ? 650 : 0 });
  const pct = Math.round((saved / total) * 100);
  $('#save-pct').textContent = `${pct}%`;
  $('#save-ring').style.strokeDashoffset = String(97.4 * (1 - saved / total));
  const bar = $('#savebar');
  bar.classList.toggle('has-savings', saved > 0);
  $('#save-label').replaceChildren();
  if (cancelled.length) $('#save-label').append(`Cancelling ${cancelled.length} of ${subs.length}`);
  else $('#save-label').append('Tap ', el('b', '', 'Cancel'), " on anything you don't need");
  if (animate) { const amt = $('.save-amount'); amt.classList.remove('bump'); void amt.offsetWidth; amt.classList.add('bump'); }
}

function restart() {
  state.result = null; state.pending = null; state.decisions.clear();
  $('#file').value = '';
  $('#view-results').classList.remove('is-ready');
  showError('');
  show('start');
}

// ---------------------------------------------------------------- wiring
$('#file').addEventListener('change', (e) => loadFile(e.target.files[0]));
$('#sample').addEventListener('click', loadSample);
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.toggle button');
  if (btn) setDecision(btn.closest('.sub').dataset.id, btn.dataset.choice);
  if (e.target.closest('[data-action="restart"]')) restart();
});
for (const id of ['#map-date', '#map-desc', '#map-mode', '#map-amount', '#map-debit', '#map-credit']) $(id).addEventListener('change', syncMapping);
$('#mapping-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const tx = toTransactions(state.pending.rows, currentMapping());
  if (!tx.length) { alertMapping(); return; }
  analyse(tx, 'your column choices');
});
function alertMapping() {
  const p = $('#preview');
  p.classList.remove('bump'); void p.offsetWidth; p.classList.add('bump');
}

// Drag and drop anywhere on the start screen.
const drop = $('#drop');
let depth = 0;
addEventListener('dragenter', (e) => { if ($('#view-start').hidden) return; e.preventDefault(); depth++; drop.classList.add('is-over'); });
addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; drop.classList.remove('is-over'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault(); depth = 0; drop.classList.remove('is-over');
  if (!$('#view-start').hidden) loadFile(e.dataTransfer?.files?.[0]);
});
