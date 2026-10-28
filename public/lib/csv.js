// CSV parsing, bank format detection and transaction normalisation.
// Runs unchanged in the browser and in Node tests. No I/O.

/** RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF/LF, BOM. */
export function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows
    .map((r) => r.map((f) => f.trim()))
    .filter((r) => r.some((f) => f !== ''));
}

const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();

/**
 * Known bank layouts. `sign` says how an outflow (money spent) is represented:
 *  'negative'  – single Amount column, purchases negative (Chase, Bank of America)
 *  'positive'  – single Amount column, purchases positive (American Express)
 *  'debitcol'  – separate Debit / Credit columns (Capital One card)
 *  'typecol'   – positive Amount plus a Debit/Credit type column (Capital One 360)
 */
export const BANK_FORMATS = [
  {
    id: 'chase-card', label: 'Chase credit card',
    required: ['transaction date', 'post date', 'description', 'category', 'type', 'amount'],
    date: 'transaction date', description: 'description', amount: 'amount', sign: 'negative',
  },
  {
    id: 'chase-checking', label: 'Chase checking',
    required: ['details', 'posting date', 'description', 'amount', 'type', 'balance'],
    date: 'posting date', description: 'description', amount: 'amount', sign: 'negative',
  },
  {
    id: 'bofa-checking', label: 'Bank of America checking',
    required: ['date', 'description', 'amount', 'running bal'],
    date: 'date', description: 'description', amount: 'amount', sign: 'negative',
  },
  {
    id: 'bofa-card', label: 'Bank of America credit card',
    required: ['posted date', 'reference number', 'payee', 'amount'],
    date: 'posted date', description: 'payee', amount: 'amount', sign: 'negative',
  },
  {
    id: 'capone-card', label: 'Capital One credit card',
    required: ['transaction date', 'posted date', 'description', 'debit', 'credit'],
    date: 'transaction date', description: 'description', debit: 'debit', credit: 'credit', sign: 'debitcol',
  },
  {
    id: 'capone-360', label: 'Capital One 360',
    required: ['transaction description', 'transaction date', 'transaction type', 'transaction amount'],
    date: 'transaction date', description: 'transaction description', amount: 'transaction amount',
    type: 'transaction type', sign: 'typecol',
  },
  {
    // Amex: "Date,Description,Amount" (optionally with Card Member, Account #,
    // Extended Details, Appears On Your Statement As, ...). Charges are positive.
    id: 'amex', label: 'American Express',
    required: ['date', 'description', 'amount'],
    date: 'date', description: 'description', amount: 'amount', sign: 'positive',
    amexHint: true,
  },
];

const DATE_WORDS = ['transaction date', 'trans date', 'date', 'posted date', 'posting date', 'post date', 'trans. date'];
const DESC_WORDS = ['description', 'transaction description', 'payee', 'merchant', 'name', 'details', 'memo', 'narrative'];
const AMOUNT_WORDS = ['amount', 'transaction amount', 'amount usd', 'value'];
const DEBIT_WORDS = ['debit', 'withdrawal', 'withdrawals', 'debit amount', 'money out', 'charges'];
const CREDIT_WORDS = ['credit', 'deposit', 'deposits', 'credit amount', 'money in', 'payments'];

function findCol(headers, words) {
  const n = headers.map(norm);
  for (const w of words) { const i = n.indexOf(norm(w)); if (i >= 0) return i; }
  for (const w of words) { const i = n.findIndex((h) => h.includes(norm(w))); if (i >= 0) return i; }
  return -1;
}

/** Locate the header row (Bank of America checking puts a summary block above it). */
export function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const n = rows[i].map(norm);
    const hasDate = n.some((h) => h.includes('date'));
    const hasMoney = n.some((h) => /amount|debit|credit|withdrawal|deposit/.test(h));
    const hasDesc = n.some((h) => /description|payee|merchant|details|name|memo/.test(h));
    if (hasDate && hasMoney && hasDesc) return i;
  }
  return -1;
}

/** Detect a known layout from the header row; returns the format or null. */
export function detectFormat(headers) {
  const n = headers.map(norm);
  for (const f of BANK_FORMATS) {
    if (f.required.every((r) => n.some((h) => h === r || h.startsWith(r)))) {
      if (f.id === 'bofa-checking' && !n.some((h) => h.startsWith('running bal'))) continue;
      return f;
    }
  }
  return null;
}

/** Best-effort column guess used to prefill the manual mapping UI. */
export function guessMapping(headers, dataRows = []) {
  const date = findCol(headers, DATE_WORDS);
  const description = findCol(headers, DESC_WORDS);
  let amount = findCol(headers, AMOUNT_WORDS);
  const debit = findCol(headers, DEBIT_WORDS);
  const credit = findCol(headers, CREDIT_WORDS);
  const mapping = { date, description, amount, debit: -1, credit: -1, sign: 'negative' };
  if (debit >= 0 && (amount < 0 || debit !== amount)) {
    mapping.debit = debit; mapping.credit = credit; mapping.sign = 'debitcol'; mapping.amount = -1;
    amount = -1;
  }
  if (amount >= 0) mapping.sign = inferSign(dataRows.map((r) => parseAmount(r[amount])));
  return mapping;
}

/** If most amounts are positive the export probably shows purchases as positive (Amex style). */
export function inferSign(amounts) {
  const vals = amounts.filter((a) => Number.isFinite(a) && a !== 0);
  if (!vals.length) return 'negative';
  const neg = vals.filter((a) => a < 0).length;
  return neg / vals.length >= 0.5 ? 'negative' : 'positive';
}

/** "$1,234.56", "(12.34)", "-12.34", "12.34-", "1.234,56"? (US only: comma = thousands). */
export function parseAmount(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim();
  if (!s) return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  s = s.replace(/[$€£\s,]|USD/gi, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d*\.?\d+$/.test(s)) return NaN;
  const v = parseFloat(s);
  return neg ? -v : v;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Parse a date to a UTC day number (days since epoch). US month-first by default. */
export function parseDate(raw, dayFirst = false) {
  const s = String(raw || '').trim();
  let y, m, d, t;
  if ((t = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) [, y, m, d] = t.map(Number);
  else if ((t = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/))) {
    let [a, b] = [Number(t[1]), Number(t[2])];
    y = Number(t[3]);
    if (dayFirst || a > 12) [a, b] = [b, a];
    m = a; d = b;
  } else if ((t = s.match(/^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -,]*(\d{2,4})/))) {
    d = Number(t[1]); m = MONTHS[t[2].toLowerCase()]; y = Number(t[3]);
  } else if ((t = s.match(/^([A-Za-z]{3})[a-z]* (\d{1,2}),? (\d{4})/))) {
    m = MONTHS[t[1].toLowerCase()]; d = Number(t[2]); y = Number(t[3]);
  } else return NaN;
  if (y < 100) y += 2000;
  if (!m || m > 12 || !d || d > 31) return NaN;
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/** Should dates be read day-first? Only if some first component exceeds 12. */
function detectDayFirst(values) {
  let first = false, second = false;
  for (const v of values) {
    const t = String(v).match(/^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}/);
    if (!t) continue;
    if (Number(t[1]) > 12) first = true;
    if (Number(t[2]) > 12) second = true;
  }
  return first && !second;
}

/**
 * Turn rows into transactions using a mapping (column indexes + sign rule).
 * Output: [{ day, description, amount }] where amount > 0 means money spent.
 */
export function toTransactions(dataRows, mapping) {
  const dayFirst = detectDayFirst(dataRows.map((r) => r[mapping.date]));
  const out = [];
  for (const r of dataRows) {
    const day = parseDate(r[mapping.date], dayFirst);
    const description = (r[mapping.description] || '').replace(/\s+/g, ' ').trim();
    if (!Number.isFinite(day) || !description) continue;
    let spent;
    if (mapping.sign === 'debitcol') {
      const deb = parseAmount(r[mapping.debit]);
      const cred = mapping.credit >= 0 ? parseAmount(r[mapping.credit]) : NaN;
      if (Number.isFinite(deb) && deb !== 0) spent = Math.abs(deb);
      else if (Number.isFinite(cred) && cred !== 0) spent = -Math.abs(cred);
      else continue;
    } else {
      const a = parseAmount(r[mapping.amount]);
      if (!Number.isFinite(a)) continue;
      if (mapping.sign === 'typecol') {
        const type = String(r[mapping.type] || '').toLowerCase();
        spent = /debit|withdraw|purchase|sale/.test(type) ? Math.abs(a) : -Math.abs(a);
      } else spent = mapping.sign === 'positive' ? a : -a;
    }
    out.push({ day, description, amount: Math.round(spent * 100) / 100 });
  }
  return out;
}

/**
 * Parse a statement file end to end.
 * Returns { ok, format, headers, rows, mapping, transactions } or
 * { ok:false, needsMapping:true, headers, rows, mapping } for the manual UI.
 */
export function parseStatement(text) {
  const all = parseCsv(text);
  const h = findHeaderRow(all);
  if (h < 0) {
    if (!all.length) return { ok: false, error: 'This file looks empty.' };
    const width = Math.max(...all.map((r) => r.length));
    // A first row of pure text is a header we just don't recognise.
    const textHeader = all[0].every((c) => c === '' || (!/\d/.test(c) && c.length < 40));
    const headers = Array.from({ length: width }, (_, i) => (textHeader && all[0][i]) || `Column ${i + 1}`);
    const rows = textHeader ? all.slice(1) : all;
    return { ok: false, needsMapping: true, headers, rows, mapping: guessMapping(headers, rows) };
  }
  const headers = all[h];
  const rows = all.slice(h + 1).filter((r) => r.length >= 2);
  const format = detectFormat(headers);
  if (format) {
    const col = (name) => (name ? headers.map(norm).findIndex((x) => x === name || x.startsWith(name)) : -1);
    const mapping = {
      date: col(format.date), description: col(format.description),
      amount: col(format.amount), debit: col(format.debit), credit: col(format.credit),
      type: col(format.type), sign: format.sign,
    };
    // A bare Date/Description/Amount file could be any bank; trust the data for the sign.
    let label = format.label;
    if (format.amexHint) {
      const amexCols = headers.map(norm).some((x) => /card member|extended details|appears on your statement/.test(x));
      mapping.sign = amexCols ? 'positive' : inferSign(rows.map((r) => parseAmount(r[mapping.amount])));
      if (!amexCols) label = mapping.sign === 'positive' ? 'American Express' : 'Date / Description / Amount';
    }
    const transactions = toTransactions(rows, mapping);
    if (transactions.length) return { ok: true, format: { ...format, label }, headers, rows, mapping, transactions };
  }
  const mapping = guessMapping(headers, rows);
  if (mapping.date >= 0 && mapping.description >= 0 && (mapping.amount >= 0 || mapping.debit >= 0)) {
    const transactions = toTransactions(rows, mapping);
    if (transactions.length >= Math.max(1, rows.length * 0.5)) {
      return { ok: true, format: { id: 'generic', label: 'Auto-detected columns' }, headers, rows, mapping, transactions, guessed: true };
    }
  }
  return { ok: false, needsMapping: true, headers, rows, mapping };
}
