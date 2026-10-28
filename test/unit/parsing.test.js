import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCsv, parseAmount, parseDate, parseStatement, detectFormat, findHeaderRow, toTransactions, inferSign } from '../../public/lib/csv.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}.csv`, import.meta.url), 'utf8');
const day = (iso) => Math.floor(Date.parse(iso + 'T00:00:00Z') / 86400000);

test('parseCsv handles quotes, escaped quotes, embedded newlines, CRLF and BOM', () => {
  const rows = parseCsv('﻿a,b,c\r\n"x, y","he said ""hi""","line1\nline2"\r\n\r\n1,2,3');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['x, y', 'he said "hi"', 'line1\nline2'], ['1', '2', '3']]);
});

test('parseAmount understands bank number styles', () => {
  assert.equal(parseAmount('-15.99'), -15.99);
  assert.equal(parseAmount('"1,234.56"'.replace(/"/g, '')), 1234.56);
  assert.equal(parseAmount('$1,234.56'), 1234.56);
  assert.equal(parseAmount('(42.10)'), -42.1);
  assert.equal(parseAmount('42.10-'), -42.1);
  assert.equal(parseAmount('-$9.99'), -9.99);
  assert.equal(parseAmount('21'), 21);
  assert.ok(Number.isNaN(parseAmount('')));
  assert.ok(Number.isNaN(parseAmount('n/a')));
});

test('parseDate reads US, ISO, two-digit-year and day-first dates', () => {
  assert.equal(parseDate('03/14/2026'), day('2026-03-14'));
  assert.equal(parseDate('2026-03-14'), day('2026-03-14'));
  assert.equal(parseDate('03/14/26'), day('2026-03-14'));
  assert.equal(parseDate('14/03/2026'), day('2026-03-14')); // first part > 12 -> day-first
  assert.equal(parseDate('05/04/2026', true), day('2026-04-05'));
  assert.equal(parseDate('Mar 14, 2026'), day('2026-03-14'));
  assert.equal(parseDate('14 Mar 2026'), day('2026-03-14'));
  assert.ok(Number.isNaN(parseDate('Beginning balance')));
});

test('findHeaderRow skips the Bank of America summary preamble', () => {
  const rows = parseCsv(fixture('bofa-checking'));
  const h = findHeaderRow(rows);
  assert.deepEqual(rows[h], ['Date', 'Description', 'Amount', 'Running Bal.']);
});

test('detectFormat tells apart all seven supported layouts', () => {
  const cases = {
    'Transaction Date,Post Date,Description,Category,Type,Amount,Memo': 'chase-card',
    'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #': 'chase-checking',
    'Date,Description,Amount,Running Bal.': 'bofa-checking',
    'Posted Date,Reference Number,Payee,Address,Amount': 'bofa-card',
    'Date,Description,Amount': 'amex',
    'Date,Description,Card Member,Account #,Amount,Extended Details,Appears On Your Statement As,Address,City/State,Zip Code,Country,Reference,Category': 'amex',
    'Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit': 'capone-card',
    'Account Number,Transaction Description,Transaction Date,Transaction Type,Transaction Amount,Balance': 'capone-360',
  };
  for (const [header, id] of Object.entries(cases)) assert.equal(detectFormat(header.split(','))?.id, id, header);
});

// Each fixture: expected format, and spot checks that purchases come out positive (money spent).
const SIGN_CHECKS = {
  'chase-card': ['NETFLIX.COM', 17.99, 'Payment Thank You-Mobile', -900],
  'chase-checking': ['HULU 877-8244858 CA', 9.99, 'ACME ROBOTICS PAYROLL PPD ID: 9000000001', -2400],
  'bofa-checking': ['APPLE.COM/BILL 800-555-0101 CA', 2.99, 'ACME ROBOTICS DES:PAYROLL ID:000001 INDN:SAMPLE CUSTOMER', -2350],
  'bofa-card': ['OPENAI *CHATGPT SUBSCR', 20, 'PAYMENT - THANK YOU', -700],
  amex: ['NYTIMES*NYTDIGITAL', 25, 'AUTOPAY PAYMENT - THANK YOU', -800],
  'capone-card': ['DUOLINGO', 12.99, 'CAPITAL ONE MOBILE PYMT', -650],
  'capone-360': ['Debit Card Purchase - PEACOCK PREMIUM', 7.99, 'Deposit from ACME ROBOTICS PAYROLL', -2100],
};

for (const [name, [spendDesc, spendAmt, creditDesc, creditAmt]] of Object.entries(SIGN_CHECKS)) {
  test(`parseStatement: ${name} fixture is detected and signs are normalised`, () => {
    const p = parseStatement(fixture(name));
    assert.equal(p.ok, true);
    assert.equal(p.format.id, name);
    assert.ok(p.transactions.length > 90, `got ${p.transactions.length} transactions`);
    const spend = p.transactions.find((t) => t.description === spendDesc);
    const credit = p.transactions.find((t) => t.description === creditDesc);
    assert.equal(spend?.amount, spendAmt);
    assert.equal(credit?.amount, creditAmt);
    assert.ok(p.transactions.every((t) => Number.isFinite(t.day) && t.day >= day('2026-01-01') && t.day <= day('2026-06-30')));
  });
}

test('Bank of America checking: beginning-balance pseudo-row is dropped', () => {
  const p = parseStatement(fixture('bofa-checking'));
  assert.ok(!p.transactions.some((t) => /Beginning balance/.test(t.description)));
});

test('Amex: multi-line Extended Details do not break rows', () => {
  const p = parseStatement(fixture('amex'));
  assert.ok(p.transactions.every((t) => !t.description.includes('\n')));
  assert.equal(p.rows.every((r) => r.length === 13), true);
});

test('bare Date/Description/Amount file infers the sign from the data', () => {
  const neg = parseStatement('Date,Description,Amount\n01/02/2026,COFFEE,-4.50\n01/03/2026,TEA,-3.00\n01/05/2026,REFUND,2.00\n');
  assert.equal(neg.mapping.sign, 'negative');
  assert.equal(neg.transactions[0].amount, 4.5);
  const pos = parseStatement('Date,Description,Amount\n01/02/2026,COFFEE,4.50\n01/03/2026,TEA,3.00\n01/05/2026,PAYMENT,-200.00\n');
  assert.equal(pos.mapping.sign, 'positive');
  assert.equal(pos.transactions[0].amount, 4.5);
  assert.equal(inferSign([]), 'negative');
});

test('generic headers are auto-mapped (Withdrawals / Deposits columns)', () => {
  const p = parseStatement('Trans Date,Merchant,Withdrawals,Deposits\n2026-01-02,NETFLIX.COM,15.49,\n2026-01-03,PAYROLL,,2000\n');
  assert.equal(p.ok, true);
  assert.equal(p.format.id, 'generic');
  assert.deepEqual(p.transactions.map((t) => t.amount), [15.49, -2000]);
});

test('unrecognised layout asks for a column mapping, and the mapping works', () => {
  const p = parseStatement(fixture('unknown-layout'));
  assert.equal(p.ok, false);
  assert.equal(p.needsMapping, true);
  assert.deepEqual(p.headers, ['When', 'Who', 'Spent', 'Received', 'Ref']);
  const tx = toTransactions(p.rows, { date: 0, description: 1, amount: -1, debit: 2, credit: 3, sign: 'debitcol' });
  assert.ok(tx.length > 50);
  assert.ok(tx.every((t) => t.amount > 0));
});

test('empty file reports an error instead of throwing', () => {
  assert.equal(parseStatement('').ok, false);
  assert.match(parseStatement('').error, /empty/);
});
