import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SERVICES, VERIFIED_ON } from '../../public/lib/services.js';

const verification = JSON.parse(readFileSync(new URL('../../data/cancel-links-verification.json', import.meta.url), 'utf8'));

test('at least 40 services have a verified official cancel/manage URL', () => {
  assert.ok(SERVICES.length >= 40, `only ${SERVICES.length}`);
  assert.equal(verification.verifiedCount, SERVICES.length);
});

test('every shipped URL is backed by a passing check in the verification file', () => {
  for (const s of SERVICES) {
    const r = verification.results.find((x) => x.id === s.id);
    assert.ok(r?.verified, `${s.id} not verified`);
    assert.ok(r.status >= 200 && r.status < 300, `${s.id} status ${r.status}`);
    assert.ok(s.url === r.url || s.url === r.finalUrl, `${s.id} url differs from evidence`);
    assert.match(s.url, /^https:\/\//);
  }
});

test('verification file records its date and no unverified service ships', () => {
  assert.match(verification.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(verification.checkedAt.slice(0, 10), VERIFIED_ON);
  const shipped = new Set(SERVICES.map((s) => s.id));
  for (const r of verification.results.filter((x) => !x.verified)) assert.ok(!shipped.has(r.id), `${r.id} shipped unverified`);
});

test('service match patterns compile and ids are unique', () => {
  assert.equal(new Set(SERVICES.map((s) => s.id)).size, SERVICES.length);
  for (const s of SERVICES) assert.doesNotThrow(() => new RegExp(s.match, 'i'), s.id);
});
