// Verifies every candidate cancel/manage URL and generates public/lib/services.js
// from the services whose official URL could be proven real.
//
//   node scripts/verify-links.mjs
//
// For each service we try its candidate URLs in order: plain HTTPS GET first,
// then real headless Chromium for sites that block non-browser clients. A URL
// passes only if it ends on HTTP 2xx, on the service's own domain family, is not
// a "page not found" page and was not bounced to the site's home page.
// Results (status, final URL, method, title) go to data/cancel-links-verification.json.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const candidates = JSON.parse(await readFile(path.join(root, 'data/services.candidates.json'), 'utf8'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const NOT_FOUND = /page (not|can.?t be) found|page doesn.?t exist|404 not found|\b404\b.*(error|page)|no longer available|article (is )?not (found|available)|we couldn.?t find (that|this|the) page|oops/i;

const RELEVANT = /cancel|unsubscribe|subscription|membership|downgrade|renewal|auto-?renew|paid_memberships|manage[- _](your[- _])?(plan|subscription|membership|service)/i;

const baseDomain =(h) => h.replace(/^www\./, '').split('.').slice(-2).join('.');
// Some services serve help from a sibling brand domain.
const SIBLINGS = { 'hbomax.com': ['max.com'], 'notion.so': ['notion.com'], 'max.com': ['hbomax.com'] };

function judge(url, finalUrl, status, title, bodySnippet) {
  const a = new URL(url), b = new URL(finalUrl);
  const allowed = [baseDomain(a.hostname), ...(SIBLINGS[baseDomain(a.hostname)] || [])];
  if (status < 200 || status >= 300) return `HTTP ${status}`;
  if (!allowed.includes(baseDomain(b.hostname))) return `redirected off-site to ${b.hostname}`;
  if (a.pathname.length > 1 && (b.pathname === '/' || b.pathname === '') && !b.search) return 'redirected to home page';
  if (/\/(404|not-?found|error)(\/|$|\?)/i.test(b.pathname)) return 'redirected to error page';
  if (/(sign|log)[-_]?in|login|auth/i.test(b.hostname + b.pathname) && !/(sign|log)[-_]?in|login|auth/i.test(a.hostname + a.pathname)) {
    return null; // official account page behind sign-in: real, but note it
  }
  if (NOT_FOUND.test(title || '') || NOT_FOUND.test((bodySnippet || '').slice(0, 600))) return 'page says not found';
  // The landing page must actually be about cancelling/managing a subscription,
  // not a moved help article that now covers something else.
  const about = `${b.pathname} ${b.search} ${title} ${bodySnippet || ''}`;
  if (!RELEVANT.test(about)) return `not a cancel/manage page ("${(title || b.pathname).slice(0, 60)}")`;
  return null;
}

async function viaFetch(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctl.signal, headers: { 'user-agent': UA, accept: 'text/html,*/*', 'accept-language': 'en-US,en;q=0.9' } });
    const html = (await res.text()).slice(0, 400000);
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || '';
    const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]?.replace(/<[^>]+>/g, '').trim() || '';
    return { status: res.status, finalUrl: res.url, title, body: h1 };
  } finally { clearTimeout(t); }
}

let browser;
async function viaBrowser(url) {
  if (!browser) {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
  }
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US' });
  const page = await ctx.newPage();
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    const title = await page.title();
    const body = await page.evaluate(() => (document.querySelector('h1')?.innerText || '') + ' ' + document.body.innerText.slice(0, 400));
    // Client-side redirects (SPAs) can land somewhere other than the HTTP final URL.
    return { status: res ? res.status() : 0, finalUrl: page.url(), title, body };
  } finally { await ctx.close(); }
}

const checkedAt = new Date().toISOString();
const results = [];
for (const svc of candidates) {
  const attempts = Object.entries(svc.rejected || {}).map(([url, reason]) => ({ url, method: 'manual-review', ok: false, reason }));
  let verified = null;
  for (const url of svc.urls) {
    for (const [method, fn] of [['fetch', viaFetch], ['chromium', viaBrowser]]) {
      try {
        const r = await fn(url);
        const reason = judge(url, r.finalUrl, r.status, r.title, r.body);
        attempts.push({ url, method, status: r.status, finalUrl: r.finalUrl, title: r.title.slice(0, 140), ok: !reason, reason: reason || undefined });
        if (!reason) { verified = attempts.at(-1); break; }
      } catch (e) {
        attempts.push({ url, method, ok: false, reason: String(e.message || e).split('\n')[0].slice(0, 160) });
      }
    }
    if (verified) break;
  }
  results.push({ id: svc.id, name: svc.name, verified: !!verified, url: verified?.url, status: verified?.status, finalUrl: verified?.finalUrl, method: verified?.method, title: verified?.title, attempts });
  console.log(`${verified ? 'OK  ' : 'FAIL'} ${svc.id.padEnd(22)} ${verified ? `${verified.status} ${verified.finalUrl}` : attempts.map((a) => a.reason).join(' | ')}`);
}
if (browser) await browser.close();

const ok = results.filter((r) => r.verified);
await writeFile(path.join(root, 'data/cancel-links-verification.json'), JSON.stringify({
  checkedAt,
  method: 'HTTPS GET following redirects (Node fetch, then headless Chromium for bot-protected sites). Pass = final status 2xx on the service\'s own domain, not a not-found page, not bounced to the home page.',
  verifiedCount: ok.length, droppedCount: results.length - ok.length, results,
}, null, 2) + '\n');

// Prefer the canonical address the site redirected to, unless that adds session/query noise.
function linkFor(r) {
  const a = new URL(r.url), b = new URL(r.finalUrl);
  return b.search && b.search !== a.search ? r.url : r.finalUrl;
}
const services = candidates
  .filter((c) => ok.some((r) => r.id === c.id))
  .map((c) => ({ id: c.id, name: c.name, category: c.category, match: c.match, ...(c.note ? { note: c.note } : {}), url: linkFor(ok.find((r) => r.id === c.id)) }));
await writeFile(path.join(root, 'public/lib/services.js'),
  `// GENERATED by scripts/verify-links.mjs on ${checkedAt.slice(0, 10)}. Do not edit by hand.\n` +
  `// Only services whose official cancel/manage URL was verified are included;\n` +
  `// see data/cancel-links-verification.json for status and final URL evidence.\n` +
  `export const VERIFIED_ON = '${checkedAt.slice(0, 10)}';\n` +
  `export const SERVICES = ${JSON.stringify(services, null, 2)};\n`);
console.log(`\n${ok.length} verified, ${results.length - ok.length} dropped`);
