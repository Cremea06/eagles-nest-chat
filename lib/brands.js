// CHG-106 — brand-lookalike check for /api/safe-link. Pure functions, no network.
// Reuses the CHG-051 confusable skeleton (lib/username.js fold()) so Greek/Cyrillic lookalikes and
// 0/o, 1/l/i, rn/m fold the same way here as for reserved chat names. vv -> w is added on top.
const { fold } = require('./username');

// brand key -> official registrable domains (allowlist). Subdomains of these are official too.
const BRANDS = {
  amazon: ['amazon.com', 'amazon.co.uk', 'amazon.ca', 'amazon.de', 'amazonaws.com', 'amazon.jobs', 'a2z.com'],
  paypal: ['paypal.com', 'paypal.me', 'paypalobjects.com'],
  apple: ['apple.com', 'icloud.com', 'apple.news'],
  microsoft: ['microsoft.com', 'live.com', 'outlook.com', 'office.com', 'microsoftonline.com', 'windows.com', 'office365.com', 'bing.com', 'xbox.com'],
  google: ['google.com', 'gmail.com', 'youtube.com', 'googleapis.com', 'gstatic.com', 'withgoogle.com', 'g.co', 'goo.gl'],
  facebook: ['facebook.com', 'fb.com', 'fb.me', 'meta.com', 'messenger.com', 'instagram.com', 'whatsapp.com'],
  instagram: ['instagram.com'],
  whatsapp: ['whatsapp.com', 'whatsapp.net'],
  netflix: ['netflix.com'],
  chase: ['chase.com', 'jpmorganchase.com', 'jpmorgan.com'],
  wellsfargo: ['wellsfargo.com', 'wf.com'],
  bankofamerica: ['bankofamerica.com', 'bofa.com', 'ml.com'],
  citi: ['citi.com', 'citibank.com', 'citigroup.com'],
  capitalone: ['capitalone.com'],
  usps: ['usps.com', 'usps.gov'],
  ups: ['ups.com'],
  fedex: ['fedex.com'],
  dhl: ['dhl.com'],
  irs: ['irs.gov'],
  ssa: ['ssa.gov'],
  medicare: ['medicare.gov', 'cms.gov', 'hhs.gov'],
  coinbase: ['coinbase.com'],
  binance: ['binance.com', 'binance.us'],
  walmart: ['walmart.com'],
  costco: ['costco.com'],
  att: ['att.com', 'att.net'],
  verizon: ['verizon.com', 'verizonwireless.com', 'vzw.com'],
  tmobile: ['t-mobile.com'],
  comcast: ['comcast.com', 'comcast.net', 'xfinity.com'],
  xfinity: ['xfinity.com'],
  ebay: ['ebay.com'],
  venmo: ['venmo.com'],
  zelle: ['zellepay.com'],
  docusign: ['docusign.com', 'docusign.net'],
  dropbox: ['dropbox.com']
};
// Short keys are only matched as a whole label or hyphen part (never fuzzy, never as a substring).
const MIN_FUZZY = 5;

// Common second-level public suffixes, enough to find the registrable domain without a full PSL.
const MULTI_SUFFIX = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp',
  'com.br', 'com.mx', 'co.in', 'co.za', 'com.cn', 'com.tr', 'com.ar', 'com.sg', 'co.kr']);

function registrable(host) {
  const parts = String(host || '').toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.');
  return MULTI_SUFFIX.has(last2) ? parts.slice(-3).join('.') : last2;
}

// Lookalike skeleton for one DNS label (unicode form): CHG-051 fold, then vv -> w. Digits 0/1 are folded by fold().
function skel(label) {
  return fold(label).replace(/vv/g, 'w');
}

function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const BRAND_SKEL = Object.keys(BRANDS).map((k) => ({ key: k, s: skel(k) }));

function isOfficial(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  for (const list of Object.values(BRANDS)) {
    for (const d of list) if (h === d || h.endsWith('.' + d)) return true;
  }
  return false;
}

// host: unicode hostname. -> { brand, how } or null.
function lookalike(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || isOfficial(h)) return null;
  const reg = registrable(h);
  const regLabel = reg.split('.')[0];
  const labels = h.split('.');
  const regIdx = labels.length - reg.split('.').length;
  const sub = labels.slice(0, regIdx);
  // 1) brand inside the registrable label: exact, hyphen part, joined, or within edit distance 1-2
  const rs = skel(regLabel);
  const hyParts = regLabel.split('-').map(skel).filter(Boolean);
  for (const b of BRAND_SKEL) {
    if (rs === b.s) return { brand: b.key, how: 'name' };
    if (hyParts.length > 1 && hyParts.includes(b.s)) return { brand: b.key, how: 'hyphen' };
    if (b.s.length >= MIN_FUZZY) {
      if (rs.includes(b.s)) return { brand: b.key, how: 'contains' };
      // edit distance 1 for 5-7 letter brands, 1-2 for longer ones (keeps 'maple', 'phase' clear of apple/chase)
      const max = b.s.length >= 8 ? 2 : 1;
      const d = lev(rs, b.s, max);
      if (d >= 1 && d <= max && (b.s.length > 5 || rs[0] === b.s[0])) return { brand: b.key, how: 'typo' };
      if (hyParts.length > 1) for (const p of hyParts) { const dp = lev(p, b.s, 1); if (dp === 1 && (b.s.length > 5 || p[0] === b.s[0])) return { brand: b.key, how: 'typo' }; }
    }
  }
  // 2) brand as a subdomain label (or hyphen part of one) on a non-official domain: appleid.apple.com.evil.top
  for (const l of sub) {
    const ls = skel(l);
    const parts = l.split('-').map(skel);
    for (const b of BRAND_SKEL) {
      if (ls === b.s || parts.includes(b.s) || (b.s.length >= MIN_FUZZY && ls.includes(b.s))) return { brand: b.key, how: 'subdomain' };
    }
  }
  return null;
}

module.exports = { BRANDS, registrable, isOfficial, lookalike, skel, lev };
