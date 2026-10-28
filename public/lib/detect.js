// Recurring-charge detection. Input: transactions [{ day, description, amount }]
// (day = UTC days since epoch, amount > 0 = money spent). Output: subscriptions.
import { merchantKey, cleanDescriptor, titleCase, compileServices, matchService, searchCancelUrl } from './merchants.js';

// Per-interval tolerance windows; `min` is the fewest charges needed for an unknown merchant.
export const CADENCES = [
  { id: 'weekly', label: 'Weekly', unit: 'wk', days: 7, lo: 5, hi: 9, perYear: 52, min: 4 },
  { id: 'biweekly', label: 'Every 2 weeks', unit: '2 wk', days: 14, lo: 12, hi: 17, perYear: 26, min: 3 },
  { id: 'monthly', label: 'Monthly', unit: 'mo', days: 30.44, lo: 25, hi: 36, perYear: 12, min: 3 },
  { id: 'quarterly', label: 'Quarterly', unit: 'qtr', days: 91.3, lo: 82, hi: 100, perYear: 4, min: 3 },
  { id: 'yearly', label: 'Yearly', unit: 'yr', days: 365.25, lo: 340, hi: 390, perYear: 1, min: 2 },
];

// Services that bill several unrelated products under one descriptor.
const MULTI_PRODUCT = new Set(['apple', 'google-play', 'amazon-prime', 'microsoft-365']);
// Categories where paying for two at once is usually redundant.
const OVERLAP_CATEGORIES = { music: 'music streaming', storage: 'cloud storage' };

const round2 = (n) => Math.round(n * 100) / 100;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Classify a date-sorted run of charges; returns cadence info or null. */
export function classifySeries(charges, known = false) {
  if (charges.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < charges.length; i++) gaps.push(charges[i].day - charges[i - 1].day);
  if (gaps.some((g) => g <= 0)) return null;
  const m = median(gaps);
  const cad = CADENCES.find((c) => m >= c.lo && m <= c.hi);
  if (!cad) return null;
  if (charges.length < (known ? 2 : cad.min)) return null;
  // Most gaps must sit within one period; the rest may be a single skipped period.
  const fits = gaps.filter((g) => g >= cad.lo && g <= cad.hi).length;
  const skips = gaps.filter((g) => g >= cad.lo * 2 && g <= cad.hi * 2).length;
  if (fits + skips < gaps.length || fits < Math.ceil(gaps.length * 0.75)) return null;

  // Amounts: subscriptions hold a price, with the odd increase. Groceries don't.
  const amounts = charges.map((c) => c.amount);
  const med = median(amounts);
  if (amounts.some((a) => a < med * 0.5 || a > med * 2)) return null;
  let changes = 0;
  for (let i = 1; i < amounts.length; i++) if (Math.abs(amounts[i] - amounts[i - 1]) > Math.max(0.02 * amounts[i - 1], 0.01)) changes++;
  if (!known && changes > Math.max(2, Math.floor(amounts.length * 0.2))) return null;
  return { cadence: cad, changes };
}

/** Cluster charges by day-of-month (circular); used to split two parallel monthly bills. */
function phaseClusters(charges) {
  const dom = (day) => new Date(day * 86400000).getUTCDate();
  const sorted = [...charges].sort((a, b) => dom(a.day) - dom(b.day));
  const doms = sorted.map((c) => dom(c.day));
  const clusters = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (doms[i] - doms[i - 1] > 4) { clusters.push(cur); cur = []; }
    cur.push(sorted[i]);
  }
  clusters.push(cur);
  // Wrap-around: days 30/31 and 1/2 belong together.
  if (clusters.length > 1 && doms[0] + 31 - doms.at(-1) <= 4) clusters[0].push(...clusters.pop());
  return clusters.map((cl) => cl.sort((a, b) => a.day - b.day));
}

/** Cluster by amount (gap > 20% starts a new cluster); used to split two plans billed on the same day. */
function amountClusters(charges) {
  const sorted = [...charges].sort((a, b) => a.amount - b.amount);
  const clusters = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].amount > sorted[i - 1].amount * 1.2) clusters.push([]);
    clusters.at(-1).push(sorted[i]);
  }
  return clusters.map((cl) => cl.sort((a, b) => a.day - b.day));
}

/** Do two series run at the same time (not just one replacing the other)? */
function concurrent(a, b) {
  const start = Math.max(a[0].day, b[0].day);
  const end = Math.min(a.at(-1).day, b.at(-1).day);
  return end - start >= 20;
}

/** Split one merchant's charges into one or more recurring series. */
export function seriesForGroup(charges, known) {
  const sorted = [...charges].sort((a, b) => a.day - b.day);
  if (sorted.length >= 4) {
    for (const split of [phaseClusters(sorted), amountClusters(sorted)]) {
      if (split.length < 2) continue;
      const found = split.map((s) => ({ charges: s, info: classifySeries(s, known) })).filter((s) => s.info);
      if (found.length >= 2 && found.every((s, i) => found.some((t, j) => i !== j && concurrent(s.charges, t.charges)))) {
        return found;
      }
    }
  }
  const info = classifySeries(sorted, known);
  return info ? [{ charges: sorted, info }] : [];
}

function priceChange(charges) {
  for (let i = charges.length - 1; i > 0; i--) {
    const prev = charges[i - 1].amount, next = charges[i].amount;
    if (Math.abs(next - prev) > Math.max(0.01 * prev, 0.25)) {
      if (next > prev && next === charges.at(-1).amount) {
        return { from: prev, to: next, day: charges[i].day, pct: Math.round(((next - prev) / prev) * 100) };
      }
      return null;
    }
  }
  return null;
}

/**
 * Find subscriptions in a list of transactions.
 * Returns { subscriptions, stopped, statement: { from, to, count } } sorted by yearly cost.
 */
export function findSubscriptions(transactions, { services = [], asOf } = {}) {
  const compiled = compileServices(services);
  const spent = transactions.filter((t) => t.amount > 0 && Number.isFinite(t.day));
  const allDays = transactions.map((t) => t.day).filter(Number.isFinite);
  const end = asOf ?? Math.max(...allDays);
  const groups = new Map();
  for (const t of spent) {
    const svc = matchService(t.description, compiled);
    const key = svc ? `svc:${svc.id}` : merchantKey(t.description);
    if (!groups.has(key)) groups.set(key, { key, service: svc, charges: [] });
    groups.get(key).charges.push(t);
  }

  const found = [];
  for (const g of groups.values()) {
    const series = seriesForGroup(g.charges, !!g.service);
    series.forEach((s, idx) => {
      const last = s.charges.at(-1);
      const cad = s.info.cadence;
      const name = g.service ? g.service.name : titleCase(cleanDescriptor(last.description).slice(0, 4).join(' ') || last.description);
      const nextDay = Math.round(last.day + cad.days);
      found.push({
        id: `${g.key}#${idx}`.replace(/[^a-z0-9#:-]/gi, '-').toLowerCase(),
        groupKey: g.key,
        name,
        descriptor: last.description,
        service: g.service ? { id: g.service.id, name: g.service.name, category: g.service.category, url: g.service.url } : null,
        cancelUrl: g.service ? g.service.url : searchCancelUrl(name),
        cancelKind: g.service ? 'official' : 'search',
        cadence: cad.id,
        cadenceLabel: cad.label,
        cadenceUnit: cad.unit,
        lastAmount: last.amount,
        lastDay: last.day,
        firstDay: s.charges[0].day,
        nextDay,
        count: s.charges.length,
        totalPaid: round2(s.charges.reduce((a, c) => a + c.amount, 0)),
        yearly: round2(last.amount * cad.perYear),
        monthly: round2((last.amount * cad.perYear) / 12),
        active: end - last.day <= cad.days * 1.5 + 5,
        priceIncrease: priceChange(s.charges),
        flags: [],
        charges: s.charges.map((c) => ({ day: c.day, amount: c.amount })),
      });
    });
  }

  // Duplicates: one merchant producing parallel series.
  const byGroup = new Map();
  for (const s of found) if (s.active) byGroup.set(s.groupKey, [...(byGroup.get(s.groupKey) || []), s]);
  for (const list of byGroup.values()) {
    if (list.length < 2) continue;
    for (const s of list) {
      const others = list.filter((o) => o !== s);
      const twin = others.find((o) => Math.abs(o.lastAmount - s.lastAmount) <= s.lastAmount * 0.25 && o.cadence === s.cadence);
      if (twin) s.flags.push({ type: 'duplicate', text: `Billed twice — another ${s.name} charge of $${twin.lastAmount.toFixed(2)} ${s.cadenceLabel.toLowerCase()}` });
      else if (!MULTI_PRODUCT.has(s.service?.id)) s.flags.push({ type: 'duplicate', text: `${list.length} separate ${s.name} plans` });
    }
  }
  // Overlaps: two active services doing the same job.
  for (const [cat, label] of Object.entries(OVERLAP_CATEGORIES)) {
    const inCat = found.filter((s) => s.active && s.service?.category === cat);
    const names = [...new Set(inCat.map((s) => s.name))];
    if (names.length < 2) continue;
    for (const s of inCat) {
      const other = names.filter((n) => n !== s.name);
      s.flags.push({ type: 'overlap', text: `Also paying for ${other.join(' & ')} — 2 ${label} services` });
    }
  }
  for (const s of found) {
    if (s.priceIncrease) {
      const p = s.priceIncrease;
      s.flags.unshift({ type: 'increase', text: `Price up ${p.pct}% — $${p.from.toFixed(2)} → $${p.to.toFixed(2)}` });
    }
  }

  const byCost = (a, b) => b.yearly - a.yearly || a.name.localeCompare(b.name);
  return {
    subscriptions: found.filter((s) => s.active).sort(byCost),
    stopped: found.filter((s) => !s.active).sort(byCost),
    statement: { from: Math.min(...allDays), to: end, count: transactions.length },
  };
}

export function yearlyTotal(subs) {
  return round2(subs.reduce((a, s) => a + s.yearly, 0));
}
