// Merchant normalisation: turn noisy card descriptors into a stable grouping key
// and a human display name, and match known subscription services.

// Payment processors and bank boilerplate that prefix the real merchant name.
const PREFIXES = [
  /^(SQ|SQU|TST|PAYPAL|PP|SP|PY|IN|DD|FS|BT|WPY|EB|CKO|ZTL|LS|GGL|PADDLE\.NET|2CO\.COM|FSP|SMK|IC|PMT|AMZ) ?\* ?/,
  /^(POS|ACH|DEBIT|CHECKCARD|CHECK CARD|VISA|MC|PURCHASE|RECURRING|PREAUTHORIZED|ONLINE|ELECTRONIC|EXTERNAL|WITHDRAWAL)\b( (DEBIT|CARD|PURCHASE|PAYMENT|WITHDRAWAL|AUTHORIZED ON \d\d\/\d\d|PMT|TRANSFER|DEBIT CARD))* ?(-|:)? ?/,
  /^DEBIT CARD PURCHASE ?-? ?/,
  /^\d{4} /, // CHECKCARD 1012 ...
];

const NOISE = new Set(['INC', 'LLC', 'LTD', 'CO', 'CORP', 'COM', 'WWW', 'HTTPS', 'HTTP', 'THE', 'USA', 'US', 'BILL',
  'PAYMENT', 'PMT', 'PURCHASE', 'RECURRING', 'AUTOPAY', 'SUBSCR', 'SUBSCRIPTION', 'MEMBERSHIP', 'MONTHLY', 'ANNUAL',
  'ONLINE', 'DIGITAL', 'SERVICES', 'SVCS', 'CHARGE', 'DEBIT', 'CARD', 'POS', 'WEB']);

const AGGREGATORS = new Set(['GOOGLE', 'APPLE', 'AMAZON', 'AMZN', 'PAYPAL', 'MICROSOFT', 'MSFT', 'STRIPE']);

const STATES = new Set(('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM ' +
  'NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC').split(' '));

/** Strip processor prefixes, store numbers, references, phones and locations. Returns uppercase tokens. */
export function cleanDescriptor(desc) {
  let s = String(desc || '').toUpperCase().replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i++) {
    const before = s;
    for (const p of PREFIXES) s = s.replace(p, '');
    s = s.trim();
    if (s === before) break;
  }
  // "AMAZON PRIME*2K7Y81" -> drop the reference after '*'; "NYTIMES*NYTDIGITAL" -> keep the brand before '*'.
  if (s.includes('*')) {
    const [head, ...rest] = s.split('*');
    const tail = rest.join(' ').trim();
    const h = head.trim();
    if (/\d/.test(tail) || !tail) s = h;
    else if (AGGREGATORS.has(h) || h.length < 3) s = tail; // GOOGLE *YouTube -> YOUTUBE
    else s = h;
  }
  s = s
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b[A-Z0-9.-]+\.(COM|NET|ORG|CO|IO|TV|APP)\b(\/\S*)?/g, (m) => m.split('.')[0]) // NETFLIX.COM -> NETFLIX
    .replace(/#\s*\d+/g, ' ')
    .replace(/[^A-Z0-9&+' ]+/g, ' ');
  let tokens = s.split(' ').filter((t) => t.length > 1 || t === '&').filter((t) => !/\d/.test(t) || /^[A-Z]+\+?$/.test(t));
  while (tokens.length > 1 && STATES.has(tokens.at(-1))) tokens.pop();
  return tokens;
}

/** Grouping key: first three meaningful tokens. */
export function merchantKey(desc) {
  const tokens = cleanDescriptor(desc).filter((t) => !NOISE.has(t));
  return tokens.slice(0, 3).join(' ') || String(desc).toUpperCase().slice(0, 24);
}

export function titleCase(s) {
  return s.toLowerCase().replace(/(^|[\s&+-])([a-z])/g, (_, a, b) => a + b.toUpperCase());
}

/** Compile the service catalogue once. */
export function compileServices(services) {
  return services.map((s) => ({ ...s, re: new RegExp(s.match, 'i') }));
}

/** Match a raw descriptor against known services (raw first, then cleaned). */
export function matchService(desc, compiled) {
  const raw = String(desc || '').toUpperCase().replace(/\s+/g, ' ');
  const cleaned = cleanDescriptor(desc).join(' ');
  return compiled.find((s) => s.re.test(raw)) || compiled.find((s) => s.re.test(cleaned)) || null;
}

/** DuckDuckGo query used for merchants we don't have a verified link for. */
export function searchCancelUrl(name) {
  return `https://duckduckgo.com/?q=${encodeURIComponent(`how to cancel ${name} subscription`)}`;
}
