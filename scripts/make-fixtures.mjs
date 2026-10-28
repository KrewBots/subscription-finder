// Generates the fictional sample statement and the per-bank test fixtures.
// Everything here is invented: no real people, accounts or statements.
//
//   node scripts/make-fixtures.mjs
//
// Writes public/sample-statement.csv, test/fixtures/*.csv and test/fixtures/expected.json.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Deterministic PRNG so fixtures are stable across runs.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const D = (iso) => Math.floor(Date.parse(iso + 'T00:00:00Z') / 86400000);
const iso = (day) => new Date(day * 86400000).toISOString().slice(0, 10);
const [Y, M, DD] = [(d) => iso(d).slice(0, 4), (d) => iso(d).slice(5, 7), (d) => iso(d).slice(8, 10)];
const mdy = (d) => `${M(d)}/${DD(d)}/${Y(d)}`;
const mdyy = (d) => `${M(d)}/${DD(d)}/${Y(d).slice(2)}`;
const money = (n) => n.toFixed(2);
const q = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);

/** Monthly charge on a day-of-month, with optional weekend shift (jitter) and amount function. */
function monthly(desc, dom, from, to, amount, { jitter = false } = {}) {
  const out = [];
  const start = new Date(D(from) * 86400000);
  for (let y = start.getUTCFullYear(), m = start.getUTCMonth(); ; m++) {
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    let day = Math.floor(Date.UTC(y, m, Math.min(dom, last)) / 86400000);
    if (day > D(to)) break;
    if (day < D(from)) continue;
    if (jitter) { const wd = new Date(day * 86400000).getUTCDay(); if (wd === 6) day += 2; else if (wd === 0) day += 1; }
    out.push({ day, desc, amount: typeof amount === 'function' ? amount(day) : amount });
  }
  return out;
}
function every(desc, firstIso, stepDays, toIso, amount) {
  const out = [];
  for (let d = D(firstIso); d <= D(toIso); d += stepDays) out.push({ day: d, desc, amount });
  return out;
}
function noise(seed, from, to, perWeek = 6) {
  const r = rng(seed);
  const shops = [
    ['H-E-B #142 AUSTIN TX', 38, 190, 'Groceries'], ['TRADER JOE S #551 AUSTIN TX', 22, 96, 'Groceries'],
    ['SHELL OIL 57444812 AUSTIN TX', 28, 64, 'Gas'], ['STARBUCKS STORE 08231', 4.5, 11, 'Food & Drink'],
    ['AMZN Mktp US*2K4LM1', 9, 120, 'Shopping'], ['UBER *TRIP HELP.UBER.COM', 9, 41, 'Travel'],
    ['TST* LUNA TAQUERIA', 14, 46, 'Food & Drink'], ['SQ *MAPLE & RYE BAKERY', 6, 24, 'Food & Drink'],
    ['TARGET 00021477 AUSTIN TX', 12, 140, 'Shopping'], ['CVS/PHARMACY #04512', 7, 52, 'Health & Wellness'],
  ];
  const out = [];
  for (let d = D(from); d <= D(to); d++) {
    if (r() < perWeek / 7) {
      const [desc, lo, hi, cat] = shops[Math.floor(r() * shops.length)];
      out.push({ day: d, desc, amount: Math.round((lo + r() * (hi - lo)) * 100) / 100, category: cat });
    }
  }
  return out;
}
const credits = (desc, from, to, amount, dom = 28) => monthly(desc, dom, from, to, amount).map((t) => ({ ...t, credit: true }));
const sortTx = (txs) => txs.sort((a, b) => b.day - a.day || a.desc.localeCompare(b.desc)); // banks export newest first

// ---------------------------------------------------------------- sample statement
const S_FROM = '2025-10-01', S_TO = '2026-10-26';
const sampleSubs = [
  ['Netflix', monthly('NETFLIX.COM', 14, S_FROM, S_TO, (d) => (d < D('2026-06-01') ? 15.49 : 17.99))],
  ['Spotify', monthly('SPOTIFY USA', 2, S_FROM, S_TO, 11.99)],
  ['Disney+', monthly('DISNEY PLUS', 3, S_FROM, S_TO, 13.99)],
  ['Disney+', monthly('DISNEYPLUS 800-555-0102', 19, '2026-03-01', S_TO, 13.99)],
  ['Hulu', monthly('HULU 877-8244858 CA', 9, S_FROM, S_TO, 9.99)],
  ['Apple', monthly('APPLE.COM/BILL 800-555-0101 CA', 5, S_FROM, S_TO, 2.99)],
  ['Apple', monthly('APPLE.COM/BILL 800-555-0101 CA', 22, S_FROM, S_TO, 10.99)],
  ['Adobe', monthly('ADOBE *CREATIVE CLD 800-555-0103 CA', 11, S_FROM, S_TO, 59.99, { jitter: true })],
  ['Planet Fitness', monthly('PLANET FITNESS #4471 AUSTIN TX', 17, S_FROM, S_TO, 24.99, { jitter: true })],
  ['Amazon Prime', [{ day: D('2025-10-20'), desc: 'AMAZON PRIME*2K7Y81', amount: 139.0 }, { day: D('2026-10-20'), desc: 'AMAZON PRIME*8MX0Q4', amount: 139.0 }]],
  ['ChatGPT', monthly('OPENAI *CHATGPT SUBSCR', 24, S_FROM, S_TO, 20.0)],
  ['YouTube Premium', monthly('GOOGLE *YouTubePremium g.co/helppay#', 27, S_FROM, S_TO, (d) => (d < D('2026-08-01') ? 11.99 : 13.99))],
  ['Sunrise Coffee Club', every('SQ *SUNRISE COFFEE CLUB', '2025-10-06', 7, S_TO, 12.0)],
  ['Greenleaf Pantry', every('TST* GREENLEAF PANTRY', '2025-10-10', 14, S_TO, 34.5)],
  ['New York Times', monthly('NYTIMES*NYTDIGITAL', 6, S_FROM, S_TO, 25.0)],
];
const sampleStopped = monthly('PELOTON* MEMBERSHIP', 8, S_FROM, '2026-03-31', 44.0);
const sample = sortTx([
  ...sampleSubs.flatMap(([, t]) => t), ...sampleStopped,
  ...noise(7, S_FROM, S_TO),
  ...credits('Payment Thank You-Mobile', S_FROM, S_TO, 1650.0),
  { day: D('2026-02-12'), desc: 'AMZN Mktp US*RT5RF1 RETURN', amount: 34.12, credit: true, category: 'Shopping' },
]);
const catOf = (desc) => /NETFLIX|SPOTIFY|DISNEY|HULU|YOUTUBE|NYTIMES|APPLE/.test(desc) ? 'Entertainment'
  : /ADOBE|OPENAI|AMAZON PRIME/.test(desc) ? 'Bills & Utilities' : /FITNESS|PELOTON/.test(desc) ? 'Health & Wellness' : 'Food & Drink';
const chaseCard = (txs) => ['Transaction Date,Post Date,Description,Category,Type,Amount,Memo',
  ...txs.map((t) => [mdy(t.day), mdy(t.day + 1), q(t.desc), t.credit ? (/Payment/.test(t.desc) ? '' : t.category) : (t.category || catOf(t.desc)),
    t.credit ? (/Payment/.test(t.desc) ? 'Payment' : 'Return') : 'Sale', money(t.credit ? t.amount : -t.amount), ''].join(','))].join('\n') + '\n';

await writeFile(path.join(root, 'public/sample-statement.csv'), chaseCard(sample));

// ---------------------------------------------------------------- bank fixtures (Jan–Jun 2026)
const F_FROM = '2026-01-01', F_TO = '2026-06-28';
const expected = {};
const fixtures = {};

// Chase credit card: purchases negative.
{
  const subs = [
    ['Netflix', monthly('NETFLIX.COM', 14, F_FROM, F_TO, (d) => (d < D('2026-04-01') ? 15.49 : 17.99))],
    ['Spotify', monthly('SPOTIFY USA', 2, F_FROM, F_TO, 11.99)],
    ['Ironhaus Gym', monthly('PAYPAL *IRONHAUS GYM', 1, F_FROM, F_TO, 49.0)],
  ];
  fixtures['chase-card'] = chaseCard(sortTx([...subs.flatMap(([, t]) => t), ...noise(11, F_FROM, F_TO), ...credits('Payment Thank You-Mobile', F_FROM, F_TO, 900)]));
  expected['chase-card'] = { format: 'chase-card', subscriptions: subs.map(([n]) => n), priceIncrease: ['Netflix'] };
}
// Chase checking: Details DEBIT/CREDIT, signed amount, trailing check-number column.
{
  const subs = [
    ['Planet Fitness', monthly('PLANET FITNESS CLUB FEES', 17, F_FROM, F_TO, 24.99, { jitter: true })],
    ['Hulu', monthly('HULU 877-8244858 CA', 9, F_FROM, F_TO, 9.99)],
    ['Sunrise Coffee Club', every('SQ *SUNRISE COFFEE CLUB', '2026-01-05', 7, F_TO, 12.0)],
  ];
  const txs = sortTx([...subs.flatMap(([, t]) => t), ...noise(12, F_FROM, F_TO, 4), ...credits('ACME ROBOTICS PAYROLL PPD ID: 9000000001', F_FROM, F_TO, 2400, 15)]);
  let bal = 8200;
  fixtures['chase-checking'] = ['Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #',
    ...txs.map((t) => { bal += t.credit ? -t.amount : t.amount; return [t.credit ? 'CREDIT' : 'DEBIT', mdy(t.day), q(t.desc), money(t.credit ? t.amount : -t.amount), t.credit ? 'ACH_CREDIT' : 'DEBIT_CARD', money(bal), ''].join(',') + ','; })].join('\n') + '\n';
  expected['chase-checking'] = { format: 'chase-checking', subscriptions: subs.map(([n]) => n) };
}
// Bank of America checking: summary preamble, quoted thousands, beginning-balance pseudo-row.
{
  const subs = [
    ['Netflix', monthly('NETFLIX.COM DES:NETFLIX.COM ID:XXXXX', 21, F_FROM, F_TO, 17.99)],
    ['Apple', monthly('APPLE.COM/BILL 800-555-0101 CA', 5, F_FROM, F_TO, 2.99)],
    ['Disney+', monthly('DISNEY PLUS', 3, F_FROM, F_TO, 13.99)],
    ['Disney+', monthly('DISNEYPLUS 800-555-0102', 19, F_FROM, F_TO, 13.99)],
  ];
  const txs = sortTx([...subs.flatMap(([, t]) => t), ...noise(13, F_FROM, F_TO, 4), ...credits('ACME ROBOTICS DES:PAYROLL ID:000001 INDN:SAMPLE CUSTOMER', F_FROM, F_TO, 2350, 15)]).reverse();
  let bal = 12345.67;
  const fmt = (n) => `"${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}"`;
  const rows = txs.map((t) => { bal += t.credit ? t.amount : -t.amount; return [mdy(t.day), q(t.desc), fmt(t.credit ? t.amount : -t.amount), fmt(bal)].join(','); });
  fixtures['bofa-checking'] = ['Description,,Summary Amt.', `Beginning balance as of ${mdy(D(F_FROM))},,"12,345.67"`, 'Total credits,,"14,100.00"', 'Total debits,,"-9,876.54"', `Ending balance as of ${mdy(D(F_TO))},,${fmt(bal)}`, '',
    'Date,Description,Amount,Running Bal.', `${mdy(D(F_FROM))},Beginning balance as of ${mdy(D(F_FROM))},,"12,345.67"`, ...rows].join('\r\n') + '\r\n';
  expected['bofa-checking'] = { format: 'bofa-checking', subscriptions: subs.map(([n]) => n), duplicate: ['Disney+'] };
}
// Bank of America credit card: purchases negative, payments positive.
{
  const subs = [
    ['Adobe Creative Cloud', monthly('ADOBE *CREATIVE CLD 800-555-0103 CA', 11, F_FROM, F_TO, 59.99, { jitter: true })],
    ['ChatGPT Plus', monthly('OPENAI *CHATGPT SUBSCR', 24, F_FROM, F_TO, 20.0)],
    ['Greenleaf Pantry', every('TST* GREENLEAF PANTRY', '2026-01-09', 14, F_TO, 34.5)],
  ];
  const txs = sortTx([...subs.flatMap(([, t]) => t), ...noise(14, F_FROM, F_TO), ...credits('PAYMENT - THANK YOU', F_FROM, F_TO, 700)]);
  fixtures['bofa-card'] = ['Posted Date,Reference Number,Payee,Address,Amount',
    ...txs.map((t, i) => [mdy(t.day), String(24492150000000000000 + i * 7919).slice(0, 23), q(t.desc), q(t.credit ? '' : 'AUSTIN TX'), money(t.credit ? t.amount : -t.amount)].join(','))].join('\n') + '\n';
  expected['bofa-card'] = { format: 'bofa-card', subscriptions: subs.map(([n]) => n) };
}
// American Express (all additional details): charges positive, multi-line Extended Details.
{
  const subs = [
    ['YouTube Premium', monthly('GOOGLE *YouTubePremium g.co/helppay#', 27, F_FROM, F_TO, (d) => (d < D('2026-03-01') ? 11.99 : 13.99))],
    ['The New York Times', monthly('NYTIMES*NYTDIGITAL', 6, F_FROM, F_TO, 25.0)],
    ['Spotify', monthly('SPOTIFY USA', 2, F_FROM, F_TO, 11.99)],
    ['Pixelnest Studio', monthly('PADDLE.NET* PIXELNEST STUDIO', 12, F_FROM, F_TO, 7.99)],
  ];
  const txs = sortTx([...subs.flatMap(([, t]) => t), ...noise(15, F_FROM, F_TO), ...credits('AUTOPAY PAYMENT - THANK YOU', F_FROM, F_TO, 800)]);
  fixtures.amex = ['Date,Description,Card Member,Account #,Amount,Extended Details,Appears On Your Statement As,Address,City/State,Zip Code,Country,Reference,Category',
    ...txs.map((t, i) => [mdy(t.day), q(t.desc), 'SAMPLE CARDMEMBER', '-71004', money(t.credit ? -t.amount : t.amount),
      q(t.credit ? 'Payment received\nThank you' : `${i}\n${t.desc}\nMerchant ref ${100000 + i}`), q(t.desc), q('123 EXAMPLE ST'), q('AUSTIN\nTX'), '78701', 'UNITED STATES', `'${320260000000 + i}'`,
      q(t.credit ? 'Fees & Adjustments-Fees & Adjustments' : 'Merchandise & Supplies-Internet Purchase')].join(','))].join('\n') + '\n';
  expected.amex = { format: 'amex', subscriptions: subs.map(([n]) => n), priceIncrease: ['YouTube Premium'] };
}
// Capital One credit card: ISO dates, separate Debit / Credit columns.
{
  const subs = [
    ['Max', monthly('HBO MAX', 8, F_FROM, F_TO, 16.99)],
    ['Duolingo Super', monthly('DUOLINGO', 18, F_FROM, F_TO, 12.99)],
    ['Netflix', monthly('NETFLIX.COM', 14, F_FROM, F_TO, 17.99)],
  ];
  const txs = sortTx([...subs.flatMap(([, t]) => t), ...noise(16, F_FROM, F_TO), ...credits('CAPITAL ONE MOBILE PYMT', F_FROM, F_TO, 650)]);
  fixtures['capone-card'] = ['Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit',
    ...txs.map((t) => [iso(t.day), iso(t.day + 1), '0042', q(t.desc), t.credit ? 'Payment/Credit' : 'Merchandise', t.credit ? '' : money(t.amount), t.credit ? money(t.amount) : ''].join(','))].join('\n') + '\n';
  expected['capone-card'] = { format: 'capone-card', subscriptions: subs.map(([n]) => n) };
}
// Capital One 360 checking: unsigned amounts plus a Debit/Credit type column, MM/DD/YY.
{
  const subs = [
    ['Peacock', monthly('Debit Card Purchase - PEACOCK PREMIUM', 4, F_FROM, F_TO, 7.99)],
    ['Hulu', monthly('Debit Card Purchase - HULU 877-8244858 CA', 9, F_FROM, F_TO, 9.99)],
    ['Ironhaus Gym', monthly('Debit Card Purchase - PAYPAL *IRONHAUS GYM', 1, F_FROM, F_TO, 49.0)],
  ];
  const txs = sortTx([...subs.flatMap(([, t]) => t), ...noise(17, F_FROM, F_TO, 3).map((t) => ({ ...t, desc: `Debit Card Purchase - ${t.desc}` })), ...credits('Deposit from ACME ROBOTICS PAYROLL', F_FROM, F_TO, 2100, 15)]);
  let bal = 5400;
  fixtures['capone-360'] = ['Account Number,Transaction Description,Transaction Date,Transaction Type,Transaction Amount,Balance',
    ...txs.map((t) => { bal += t.credit ? -t.amount : t.amount; return ['1122', q(t.desc), mdyy(t.day), t.credit ? 'Credit' : 'Debit', String(Number(t.amount.toFixed(2))), money(bal)].join(','); })].join('\n') + '\n';
  expected['capone-360'] = { format: 'capone-360', subscriptions: subs.map(([n]) => n) };
}
// Unknown layout: headers we can't auto-map, used to exercise the column-mapping UI.
{
  const subs = [['Netflix', monthly('NETFLIX.COM', 14, F_FROM, F_TO, 17.99)], ['Spotify', monthly('SPOTIFY USA', 2, F_FROM, F_TO, 11.99)], ['Hulu', monthly('HULU', 9, F_FROM, F_TO, 9.99)]];
  const txs = sortTx([...subs.flatMap(([, t]) => t), ...noise(18, F_FROM, F_TO, 3)]);
  fixtures['unknown-layout'] = ['When,Who,Spent,Received,Ref',
    ...txs.map((t, i) => [iso(t.day), q(t.desc), t.credit ? '' : money(t.amount), t.credit ? money(t.amount) : '', `R${1000 + i}`].join(','))].join('\n') + '\n';
  expected['unknown-layout'] = { format: null, needsMapping: true, mapping: { date: 0, description: 1, debit: 2, credit: 3 }, subscriptions: subs.map(([n]) => n) };
}

for (const [name, text] of Object.entries(fixtures)) await writeFile(path.join(root, `test/fixtures/${name}.csv`), text);
expected.sample = {
  subscriptions: sampleSubs.map(([n]) => n), stopped: ['Peloton'],
  priceIncrease: ['Netflix', 'YouTube Premium'], duplicate: ['Disney+'],
};
await writeFile(path.join(root, 'test/fixtures/expected.json'), JSON.stringify(expected, null, 2) + '\n');
console.log(`sample: ${sample.length} transactions; fixtures: ${Object.keys(fixtures).join(', ')}`);
