import { test } from 'node:test';
import assert from 'node:assert/strict';
import { easeOutExpo, progress, countValue } from '../../public/lib/countup.js';

test('progress is clamped to [0, 1], including a rAF timestamp earlier than start', () => {
  assert.equal(progress(990, 1000, 1900), 0);
  assert.equal(progress(-5000, 1000, 1900), 0);
  assert.equal(progress(1000, 1000, 1900), 0);
  assert.equal(progress(1950, 1000, 1900), 0.5);
  assert.equal(progress(9999, 1000, 1900), 1);
  assert.equal(progress(1000, 1000, 0), 1);
});

test('count-up never shows a value below its start when the frame predates start', () => {
  // The reported bug: yearly total $0 → $4,371 showed about -88 on its first frame.
  for (const early of [0.1, 3, 8, 16.7, 33, 500]) {
    const v = countValue(1000 - early, 1000, 1900, 0, 4371);
    assert.ok(v >= 0 && !Object.is(v, -0), `frame ${early}ms early gave ${v}`);
    assert.equal(v, 0);
  }
  // Savings counter animates from the previous value; it must not overshoot either way.
  assert.equal(countValue(990, 1000, 650, 0, 168), 0);
  assert.equal(countValue(990, 1000, 650, 168, 0), 168);
});

test('count-up is monotonic and lands exactly on the target', () => {
  let prev = -Infinity;
  for (let now = 980; now <= 3000; now += 4) {
    const v = countValue(now, 1000, 1900, 0, 4371);
    assert.ok(v >= prev && v >= 0 && v <= 4371, `${v} at ${now}`);
    prev = v;
  }
  assert.equal(countValue(2900, 1000, 1900, 0, 4371), 4371);
  assert.equal(easeOutExpo(0), 0);
  assert.equal(easeOutExpo(1), 1);
});
