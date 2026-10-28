import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStatement } from '../../public/lib/csv.js';
import { findSubscriptions, classifySeries, yearlyTotal } from '../../public/lib/detect.js';
import { merchantKey, cleanDescriptor, matchService, compileServices, searchCancelUrl } from '../../public/lib/merchants.js';
import { SERVICES } from '../../public/lib/services.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const expected = JSON.parse(read('../fixtures/expected.json'));
const D = (iso) => Math.floor(Date.parse(iso + 'T00:00:00Z') / 86400000);
const tx = (iso, description, amount) => ({ day: D(iso), description, amount });
const monthlyTx = (desc, amounts, startIso = '2026-01-05', dom) => amounts.map((a, i) => {
  const s = new Date(startIso + 'T00:00:00Z');
  const d = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + i, dom ?? s.getUTCDate()));
  return { day: Math.floor(d / 86400000), description: desc, amount: a };
});
const run = (txs) => findSubscriptions(txs, { services: SERVICES });
const names = (subs) => subs.map((s) => s.name);
const has = (subs, want) => subs.some((s) => s.name.toLowerCase().includes(want.toLowerCase()));

// ---------------------------------------------------------------- merchant normalisation
test('merchantKey strips processor prefixes, store numbers, refs, phones and states', () => {
  assert.equal(merchantKey('SQ *SUNRISE COFFEE CLUB'), 'SUNRISE COFFEE CLUB');
  assert.equal(merchantKey('TST* LUNA TAQUERIA'), 'LUNA TAQUERIA');
  assert.equal(merchantKey('PAYPAL *IRONHAUS GYM'), 'IRONHAUS GYM');
  assert.equal(merchantKey('PLANET FITNESS #4471 AUSTIN TX'), merchantKey('PLANET FITNESS #0912 AUSTIN TX'));
  assert.equal(merchantKey('AMAZON PRIME*2K7Y81'), merchantKey('AMAZON PRIME*8MX0Q4'));
  assert.equal(merchantKey('NETFLIX.COM'), 'NETFLIX');
  assert.equal(merchantKey('PURCHASE AUTHORIZED ON 09/14 SPOTIFY USA'), 'SPOTIFY');
  assert.equal(merchantKey('Debit Card Purchase - HULU 877-8244858 CA'), 'HULU');
  assert.equal(merchantKey('MCDONALDS F1234'), 'MCDONALDS'); // "MC" is not a prefix here
  assert.deepEqual(cleanDescriptor('GOOGLE *YouTubePremium g.co/helppay#'), ['YOUTUBEPREMIUM']);
});

test('known services match common descriptor variants', () => {
  const c = compileServices(SERVICES);
  const id = (d) => matchService(d, c)?.id;
  assert.equal(id('NETFLIX.COM'), 'netflix');
  assert.equal(id('Netflix 800-555-0104 CA'), 'netflix');
  assert.equal(id('DISNEYPLUS 800-555-0102'), 'disneyplus');
  assert.equal(id('DISNEY PLUS'), 'disneyplus');
  assert.equal(id('APPLE.COM/BILL 800-555-0101 CA'), 'apple');
  assert.equal(id('GOOGLE *YouTubePremium g.co/helppay#'), 'youtube-premium');
  assert.equal(id('OPENAI *CHATGPT SUBSCR'), 'chatgpt');
  assert.equal(id('ADOBE *CREATIVE CLD 800-555-0103 CA'), 'adobe');
  assert.equal(id('H-E-B #142 AUSTIN TX'), undefined);
  assert.equal(id('AMZN Mktp US*2K4LM1'), undefined); // marketplace shopping is not Prime
});

test('search fallback is a web search query, not an invented URL', () => {
  assert.equal(searchCancelUrl('Ironhaus Gym'), 'https://duckduckgo.com/?q=how%20to%20cancel%20Ironhaus%20Gym%20subscription');
});

// ---------------------------------------------------------------- cadence + amount rules
test('classifySeries: weekly, every two weeks, monthly, quarterly and yearly', () => {
  const every = (n, step, amt = 10) => Array.from({ length: n }, (_, i) => ({ day: 20000 + i * step, amount: amt }));
  assert.equal(classifySeries(every(6, 7)).cadence.id, 'weekly');
  assert.equal(classifySeries(every(5, 14)).cadence.id, 'biweekly');
  assert.equal(classifySeries(every(4, 30)).cadence.id, 'monthly');
  assert.equal(classifySeries(every(3, 91)).cadence.id, 'quarterly');
  assert.equal(classifySeries(every(2, 365)).cadence.id, 'yearly');
});

test('monthly detection tolerates date jitter (weekends, 28-31 day months)', () => {
  const days = ['2026-01-31', '2026-02-28', '2026-03-31', '2026-05-01', '2026-05-29', '2026-07-01'];
  const r = run(days.map((d) => tx(d, 'IRONHAUS GYM', 49)));
  assert.equal(r.subscriptions.length, 1);
  assert.equal(r.subscriptions[0].cadence, 'monthly');
  assert.equal(r.subscriptions[0].yearly, 588);
});

test('a single skipped month does not break a monthly series', () => {
  const t = monthlyTx('PIXELNEST STUDIO', [7.99, 7.99, 7.99, 7.99, 7.99, 7.99]).filter((_, i) => i !== 3);
  assert.equal(run(t).subscriptions.length, 1);
});

test('unknown merchants need 3+ monthly charges; known services need only 2', () => {
  assert.equal(run(monthlyTx('PIXELNEST STUDIO', [7.99, 7.99])).subscriptions.length, 0);
  assert.equal(run(monthlyTx('NETFLIX.COM', [17.99, 17.99])).subscriptions.length, 1);
});

test('variable-amount shopping at the same store is not a subscription', () => {
  const amounts = [43.12, 118.9, 61.07, 95.33, 22.5, 140.01, 77.7, 54.2];
  const t = amounts.map((a, i) => ({ day: D('2026-01-03') + i * 7, description: 'H-E-B #142 AUSTIN TX', amount: a }));
  assert.equal(run(t).subscriptions.length, 0);
});

test('irregular repeat purchases are not a subscription', () => {
  const gaps = [3, 11, 2, 19, 6, 25, 4];
  let d = D('2026-01-01');
  const t = gaps.map((g) => ({ day: (d += g), description: 'TST* LUNA TAQUERIA', amount: 18.5 }));
  assert.equal(run(t).subscriptions.length, 0);
});

test('refunds and payments (negative amounts) are ignored', () => {
  const t = [...monthlyTx('NETFLIX.COM', [17.99, 17.99, 17.99]), ...monthlyTx('PAYMENT THANK YOU', [-500, -500, -500])];
  assert.deepEqual(names(run(t).subscriptions), ['Netflix']);
});

// ---------------------------------------------------------------- flags
test('price increase is flagged with old and new price', () => {
  const s = run(monthlyTx('NETFLIX.COM', [15.49, 15.49, 15.49, 17.99, 17.99])).subscriptions[0];
  assert.deepEqual({ from: s.priceIncrease.from, to: s.priceIncrease.to, pct: s.priceIncrease.pct }, { from: 15.49, to: 17.99, pct: 16 });
  assert.equal(s.yearly, 215.88);
  assert.match(s.flags[0].text, /Price up 16%/);
});

test('a price decrease is not flagged as an increase', () => {
  const s = run(monthlyTx('NETFLIX.COM', [17.99, 17.99, 15.49, 15.49])).subscriptions[0];
  assert.equal(s.priceIncrease, null);
});

test('same service billed twice a month is split and flagged as a duplicate', () => {
  const t = [...monthlyTx('DISNEY PLUS', Array(5).fill(13.99), '2026-01-03'), ...monthlyTx('DISNEYPLUS 800-555-0102', Array(5).fill(13.99), '2026-01-19')];
  const subs = run(t).subscriptions;
  assert.equal(subs.length, 2);
  assert.ok(subs.every((s) => s.cadence === 'monthly' && s.flags.some((f) => f.type === 'duplicate')));
});

test('two plans of the same service on the same day are split by amount and flagged', () => {
  const t = [...monthlyTx('NETFLIX.COM', Array(4).fill(6.99), '2026-01-14'), ...monthlyTx('NETFLIX.COM', Array(4).fill(17.99), '2026-01-14')];
  const subs = run(t).subscriptions;
  assert.equal(subs.length, 2);
  assert.ok(subs.every((s) => s.flags.some((f) => f.type === 'duplicate' && /2 separate Netflix plans/.test(f.text))));
});

test('Apple bills several products under one descriptor: split, but not called duplicates', () => {
  const t = [...monthlyTx('APPLE.COM/BILL', Array(4).fill(2.99), '2026-01-05'), ...monthlyTx('APPLE.COM/BILL', Array(4).fill(10.99), '2026-01-22')];
  const subs = run(t).subscriptions;
  assert.equal(subs.length, 2);
  assert.ok(subs.every((s) => !s.flags.some((f) => f.type === 'duplicate')));
});

test('two music services at once are flagged as an overlap', () => {
  const t = [...monthlyTx('SPOTIFY USA', [11.99, 11.99, 11.99]), ...monthlyTx('PANDORA*PLUS', [5.99, 5.99, 5.99])];
  const catalogue = [
    { id: 'spotify', name: 'Spotify', category: 'music', match: 'SPOTIFY', url: 'https://example.test/a' },
    { id: 'pandora', name: 'Pandora', category: 'music', match: 'PANDORA', url: 'https://example.test/b' },
  ];
  const subs = findSubscriptions(t, { services: catalogue }).subscriptions;
  assert.equal(subs.length, 2);
  assert.ok(subs.every((s) => s.flags.some((f) => f.type === 'overlap')));
});

test('a subscription that stopped months ago is reported as stopped, not counted', () => {
  const t = [...monthlyTx('PELOTON* MEMBERSHIP', [44, 44, 44, 44]), ...monthlyTx('NETFLIX.COM', Array(10).fill(17.99))];
  const r = run(t);
  assert.deepEqual(names(r.subscriptions), ['Netflix']);
  assert.equal(r.stopped.length, 1);
  assert.match(r.stopped[0].name, /Peloton/);
});

// ---------------------------------------------------------------- fixtures end to end
const fixtureNames = Object.keys(expected).filter((k) => k !== 'sample' && k !== 'unknown-layout');
for (const name of fixtureNames) {
  test(`fixture ${name}: finds exactly the expected subscriptions`, () => {
    const p = parseStatement(read(`../fixtures/${name}.csv`));
    const r = run(p.transactions);
    const want = expected[name];
    assert.equal(r.subscriptions.length, want.subscriptions.length, `got ${names(r.subscriptions).join(', ')}`);
    for (const n of want.subscriptions) assert.ok(has(r.subscriptions, n), `missing ${n} in ${names(r.subscriptions).join(', ')}`);
    for (const n of want.priceIncrease || []) assert.ok(r.subscriptions.find((s) => s.name.includes(n))?.priceIncrease, `${n} increase`);
    for (const n of want.duplicate || []) assert.ok(r.subscriptions.filter((s) => s.name.includes(n)).every((s) => s.flags.some((f) => f.type === 'duplicate')));
  });
}

test('sample statement: 8+ subscriptions, an increase, a duplicate and a yearly total', () => {
  const p = parseStatement(read('../../public/sample-statement.csv'));
  assert.equal(p.format.id, 'chase-card');
  const r = run(p.transactions);
  const want = expected.sample;
  assert.ok(r.subscriptions.length >= 8);
  assert.equal(r.subscriptions.length, want.subscriptions.length);
  for (const n of want.subscriptions) assert.ok(has(r.subscriptions, n), `missing ${n}`);
  assert.ok(r.subscriptions.filter((s) => s.priceIncrease).length >= 1);
  assert.ok(r.subscriptions.filter((s) => s.flags.some((f) => f.type === 'duplicate')).length >= 1);
  assert.deepEqual(r.stopped.map((s) => s.name.split(' ')[0]), want.stopped);
  const total = yearlyTotal(r.subscriptions);
  assert.ok(total > 1000, `total ${total}`);
  assert.equal(total, Math.round(r.subscriptions.reduce((a, s) => a + s.yearly, 0) * 100) / 100);
  // Sorted by yearly cost, highest first.
  for (let i = 1; i < r.subscriptions.length; i++) assert.ok(r.subscriptions[i - 1].yearly >= r.subscriptions[i].yearly);
});
