// CHG-106 — /api/safe-link: "does this link look safe?" for the Shop's third-window search box.
// Google Safe Browsing v4 Lookup (threatMatches:find) + brand-lookalike + red flags + short-link expansion.
// Privacy: URLs are never logged or stored. Only daily counters by verdict are kept, in memory.
// Network is injectable (opts.fetch, opts.lookup, opts.request) so the unit tests never touch the network.
const net = require('net');
const dns = require('dns');
const http = require('http');
const https = require('https');
const { domainToUnicode } = require('url');
const brands = require('./brands');
const { createRateLimiter } = require('./serverStats');

const MAX_INPUT = 2048;          // characters of URL we accept at all
const LONG_URL = 200;            // "very long" red flag
const MAX_HOPS = 5;
const HOP_TIMEOUT_MS = 3000;
const GSB_TIMEOUT_MS = 3000;
const GSB_URL = 'https://safebrowsing.googleapis.com/v4/threatMatches:find';
const THREAT_TYPES = ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'];
const ALLOWED_ORIGINS = new Set(['https://afirstflag.com', 'https://www.afirstflag.com']);
const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly',
  'cutt.ly', 'shorturl.at', 'tiny.cc', 'rb.gy']);
const RISKY_TLDS = new Set(['zip', 'mov', 'top', 'xyz', 'click', 'country', 'gq', 'tk', 'ml', 'cf', 'ga', 'work']);
const BAIT_WORDS = /(log-?in|sign-?in|verify|verification|account|update|secure|security|unlock|suspend|confirm|password|wallet)/i;
// Our own site is never a lookalike or bait-word hit.
const OWN_DOMAINS = ['afirstflag.com'];

// ---------- SSRF guard ----------
const BLOCK = new net.BlockList();
[['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
 ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
 ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]
  .forEach(([a, p]) => BLOCK.addSubnet(a, p, 'ipv4'));
[['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['64:ff9b::', 96],
 ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32], ['2002::', 16], ['2001::', 32]]
  .forEach(([a, p]) => BLOCK.addSubnet(a, p, 'ipv6'));

function isBlockedIp(ip) {
  const s = String(ip || '').replace(/^\[|\]$/g, '').split('%')[0];
  const fam = net.isIP(s);
  if (fam === 4) return BLOCK.check(s, 'ipv4');
  if (fam === 6) {
    const m = s.toLowerCase().match(/^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/) || s.toLowerCase().match(/^::(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return BLOCK.check(m[1], 'ipv4');
    // ::ffff:7f00:1 style (hex mapped)
    const h = s.toLowerCase().match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (h) { const a = parseInt(h[1], 16), b = parseInt(h[2], 16); return BLOCK.check([a >> 8, a & 255, b >> 8, b & 255].join('.'), 'ipv4'); }
    return BLOCK.check(s, 'ipv6');
  }
  return true; // not an IP at all: refuse
}

// Names that must never be looked up or fetched, whatever DNS says.
function isBlockedName(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return !h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') ||
    h.endsWith('.lan') || h.endsWith('.home.arpa') || h === 'metadata' || h === 'metadata.google.internal' ||
    !h.includes('.');
}

class Refused extends Error {}

// ---------- normalize ----------
// -> { url: URL, ascii, unicode } or throws Refused / TypeError for bad input.
function normalize(raw) {
  let s = String(raw == null ? '' : raw).trim().replace(/[\u0000-\u001f\u007f\s]+/g, '');
  if (!s) throw new TypeError('empty');
  if (s.length > MAX_INPUT) throw new TypeError('too_long');
  const scheme = s.match(/^([a-z][a-z0-9+.-]*):/i);
  const hasSlashes = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (scheme && (hasSlashes || /^(javascript|data|file|vbscript|ftp|mailto|blob|about|chrome|tel|sms|ws|wss)$/i.test(scheme[1]))) {
    if (!/^https?$/i.test(scheme[1])) throw new TypeError('scheme');
  } else {
    s = 'https://' + s.replace(/^\/+/, '');
  }
  let u;
  try { u = new URL(s); } catch (e) { throw new TypeError('parse'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new TypeError('scheme');
  if (!u.hostname) throw new TypeError('parse');
  const ascii = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const unicode = net.isIP(ascii) ? ascii : (domainToUnicode(ascii) || ascii);
  return { url: u, ascii, unicode };
}

// Literal check: an IP host that is private/local, or a local-only name.
function refuseLiteral(ascii) {
  if (net.isIP(ascii)) { if (isBlockedIp(ascii)) throw new Refused('ip'); return; }
  const h = ascii.replace(/\.$/, '');
  if (h && !h.includes('.') && h !== 'localhost' && h !== 'metadata') throw new TypeError('parse'); // 'gibberish'
  if (isBlockedName(ascii)) throw new Refused('name');
}

function withTimeout(p, ms, label) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label || 'timeout')), ms); })])
    .finally(() => clearTimeout(t));
}

// DNS check: every address the name resolves to must be public. -> 'ok' | 'nxdomain'. Throws Refused.
async function refuseResolved(ascii, lookup) {
  if (net.isIP(ascii)) return 'ok';
  let addrs;
  try {
    addrs = await withTimeout(new Promise((res, rej) => lookup(ascii, { all: true, verbatim: true },
      (err, a) => (err ? rej(err) : res(a)))), 2000, 'dns_timeout');
  } catch (e) {
    if (e && (e.code === 'ENOTFOUND' || e.code === 'ENODATA')) return 'nxdomain';
    return 'dnserror';
  }
  const list = (Array.isArray(addrs) ? addrs : [addrs]).map((a) => (typeof a === 'string' ? a : a.address));
  if (!list.length) return 'nxdomain';
  if (list.some(isBlockedIp)) throw new Refused('dns');
  return 'ok';
}

// lookup() for http(s).request that refuses private answers at connect time (no DNS-rebinding gap).
function guardedLookup(lookup) {
  return function (host, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    lookup(host, Object.assign({}, opts, { all: true }), (err, addrs) => {
      if (err) return cb(err);
      const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: net.isIP(addrs) }];
      if (!list.length || list.some((a) => isBlockedIp(a.address))) return cb(new Refused('dns'));
      if (opts && opts.all) return cb(null, list);
      cb(null, list[0].address, list[0].family);
    });
  };
}

// ---------- one redirect hop (only ever called for known shorteners) ----------
// -> { status, location } ; HEAD first, then GET with Range: bytes=0-0 and the body is never read.
function hopRequest(urlStr, method, deps) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const headers = { 'User-Agent': 'afirstflag-safe-link/1.0', Accept: '*/*' };
    if (method === 'GET') headers.Range = 'bytes=0-0';
    const req = (deps.request || mod.request)(u, { method, headers, lookup: guardedLookup(deps.lookup), timeout: HOP_TIMEOUT_MS,
      agent: false }, (res) => {
      const out = { status: res.statusCode, location: res.headers.location };
      res.destroy();
      resolve(out);
    });
    const timer = setTimeout(() => { req.destroy(new Error('timeout')); }, HOP_TIMEOUT_MS);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}

function isShortener(ascii) {
  const h = ascii.replace(/^www\./, '');
  return SHORTENERS.has(h);
}

// Follow short links. -> { hops: [urlStr...], finalUrl, note } ; throws Refused when a hop is private.
async function expand(start, deps) {
  const hops = [start.url.href];
  let cur = start;
  let note = '';
  for (let i = 0; i < MAX_HOPS && isShortener(cur.ascii); i++) {
    let r;
    try {
      r = await hopRequest(cur.url.href, 'HEAD', deps);
      if (r.status === 405 || r.status === 501 || r.status === 403 || (r.status >= 200 && r.status < 300 && !r.location)) {
        const g = await hopRequest(cur.url.href, 'GET', deps);
        if (g.location || r.status >= 400) r = g;
      }
    } catch (e) {
      if (e instanceof Refused) throw e;
      note = 'expand_failed';
      break;
    }
    if (!(r.status >= 300 && r.status < 400 && r.location)) { note = 'expand_failed'; break; } // still on a shortener: destination unknown
    let next;
    try { next = normalize(new URL(r.location, cur.url).href); } catch (e) { note = 'bad_redirect'; break; }
    refuseLiteral(next.ascii);
    if (isShortener(next.ascii)) await refuseResolved(next.ascii, deps.lookup); // fetched next round
    hops.push(next.url.href);
    cur = next;
    if (i === MAX_HOPS - 1 && isShortener(cur.ascii)) note = 'too_many';
  }
  return { hops, final: cur, note };
}

// ---------- Google Safe Browsing ----------
// -> { ok: true, matches: [{threatType, url}] } or { ok: false }
async function safeBrowsing(urls, deps) {
  const key = deps.key;
  if (!key) return { ok: false };
  const body = {
    client: { clientId: 'afirstflag', clientVersion: '1.0' },
    threatInfo: {
      threatTypes: THREAT_TYPES,
      platformTypes: ['ANY_PLATFORM'],
      threatEntryTypes: ['URL'],
      threatEntries: [...new Set(urls)].map((url) => ({ url }))
    }
  };
  try {
    const r = await (deps.fetch || fetch)(GSB_URL + '?key=' + encodeURIComponent(key), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(GSB_TIMEOUT_MS)
    });
    if (!r.ok) return { ok: false };
    const j = await r.json();
    const matches = Array.isArray(j && j.matches) ? j.matches.map((m) => ({ threatType: m.threatType, url: m.threat && m.threat.url })) : [];
    return { ok: true, matches };
  } catch (e) {
    return { ok: false };
  }
}

// ---------- red flags ----------
function isOwn(host) { return OWN_DOMAINS.some((d) => host === d || host.endsWith('.' + d)); }

function redFlags(n, rawLen) {
  const reasons = [];
  const host = n.ascii;
  const u = n.url;
  if (net.isIP(host)) reasons.push('It uses a number address instead of a normal website name.');
  const labels = host.split('.');
  if (!net.isIP(host)) {
    if (labels.some((l) => l.startsWith('xn--'))) {
      const scripts = new Set();
      for (const ch of n.unicode.replace(/[.\-0-9]/g, '')) {
        if (/\p{Script=Latin}/u.test(ch)) scripts.add('Latin');
        else if (/\p{Script=Cyrillic}/u.test(ch)) scripts.add('Cyrillic');
        else if (/\p{Script=Greek}/u.test(ch)) scripts.add('Greek');
        else scripts.add('Other');
      }
      reasons.push(scripts.size > 1 || scripts.has('Cyrillic') || scripts.has('Greek')
        ? 'The name mixes letters from different alphabets, a common trick to copy a real site.'
        : 'The name uses special letters that can look like normal ones.');
    }
    const tld = labels[labels.length - 1];
    if (RISKY_TLDS.has(tld)) reasons.push('It ends in .' + tld + ', an ending often used by scam sites.');
    const reg = brands.registrable(host);
    const subLevels = labels.length - reg.split('.').length;
    if (subLevels > 4) reasons.push('The address has an unusual number of parts.');
  }
  if (u.username || u.password || /@/.test(decodeSafe(u.pathname + u.search))) {
    reasons.push('It contains an @ sign, which can hide where the link really goes.');
  }
  const pct = (u.href.match(/%[0-9a-f]{2}/gi) || []).length;
  if (rawLen > LONG_URL || u.href.length > LONG_URL) reasons.push('The link is unusually long.');
  else if (pct >= 10) reasons.push('Much of the link is hidden in code characters.');
  if (!net.isIP(host) && !brands.isOfficial(host) && !isOwn(host) && BAIT_WORDS.test(host + u.pathname)) {
    reasons.push('It uses words like "login" or "verify" on a site that isn\'t the real company.');
  }
  return reasons;
}

function decodeSafe(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

const BRAND_NAMES = { att: 'AT&T', usps: 'USPS', ups: 'UPS', irs: 'IRS', ssa: 'Social Security', bankofamerica: 'Bank of America',
  wellsfargo: 'Wells Fargo', paypal: 'PayPal', tmobile: 'T-Mobile', fedex: 'FedEx', dhl: 'DHL', capitalone: 'Capital One',
  ebay: 'eBay', docusign: 'DocuSign', whatsapp: 'WhatsApp' };
function brandName(k) { return BRAND_NAMES[k] || k.charAt(0).toUpperCase() + k.slice(1); }

const GSB_REASON = {
  SOCIAL_ENGINEERING: 'Google Safe Browsing lists this as a suspected deceptive (phishing) site that may try to steal passwords or card numbers.',
  MALWARE: 'Google Safe Browsing lists this as a site that may harm your computer.',
  UNWANTED_SOFTWARE: 'Google Safe Browsing lists this as a site that may contain harmful programs.',
  POTENTIALLY_HARMFUL_APPLICATION: 'Google Safe Browsing lists this as a site that may install harmful apps.'
};

// ---------- the whole check ----------
// deps: { key, fetch, lookup, request }
async function check(rawUrl, deps) {
  const d = { lookup: dns.lookup };
  for (const [k, v] of Object.entries(deps || {})) if (v !== undefined) d[k] = v; // undefined never overrides a default
  const n = normalize(rawUrl);           // TypeError -> 400
  refuseLiteral(n.ascii);                // Refused -> 400 refused
  const dnsState = await refuseResolved(n.ascii, d.lookup);
  const reasons = [];
  let caution = false;

  let exp = { hops: [n.url.href], final: n, note: '' };
  if (isShortener(n.ascii) && dnsState === 'ok') exp = await expand(n, d);
  const final = exp.final;
  const expanded = exp.hops.length > 1;

  const gsb = await safeBrowsing(exp.hops, d);
  let threats = [];
  if (gsb.ok && gsb.matches.length) {
    threats = [...new Set(gsb.matches.map((m) => m.threatType))];
    for (const t of threats) reasons.push(GSB_REASON[t] || 'Google Safe Browsing lists this as a possibly unsafe site.');
  }

  // lookalike + red flags on the final destination (and the original if it isn't a shortener)
  const targets = expanded ? [n, final].filter((x) => !isShortener(x.ascii)) : [n];
  const seen = new Set();
  for (const t of targets) {
    const lk = isOwn(t.ascii) ? null : brands.lookalike(t.unicode);
    if (lk) { caution = true; pushOnce(reasons, seen, 'The name looks like ' + brandName(lk.brand) + ', but it isn\'t the real ' + brandName(lk.brand) + ' website.'); }
    for (const r of redFlags(t, String(rawUrl).length)) { caution = true; pushOnce(reasons, seen, r); }
  }
  if (dnsState === 'nxdomain') { caution = true; reasons.push('This website name doesn\'t seem to exist.'); }
  if (exp.note === 'too_many') { caution = true; reasons.push('The short link bounces through too many other short links.'); }
  if (exp.note === 'expand_failed' || exp.note === 'bad_redirect') { caution = true; reasons.push('We couldn\'t see where this short link goes.'); }

  let verdict;
  if (threats.length) verdict = 'danger';
  else if (!gsb.ok) {
    verdict = caution ? 'caution' : 'unknown';
    reasons.push('Google Safe Browsing couldn\'t be reached right now, so this check is incomplete.');
  } else if (caution) verdict = 'caution';
  else { verdict = 'safe'; reasons.push('Google Safe Browsing has no warnings for it, and nothing else looks off.'); }

  const out = { verdict, reasons, host: n.unicode };
  if (n.unicode !== n.ascii) out.hostAscii = n.ascii;
  if (expanded) out.finalUrl = final.url.href;
  if (threats.length) { out.threats = threats; out.advisory = 'google'; }
  return out;
}

function pushOnce(arr, seen, s) { if (!seen.has(s)) { seen.add(s); arr.push(s); } }

// ---------- counters (no URLs, ever) ----------
function createCounters(now = () => new Date()) {
  let day = '', counts = {};
  function bump(v) {
    const d = now().toISOString().slice(0, 10);
    if (d !== day) { day = d; counts = { safe: 0, caution: 0, danger: 0, unknown: 0, refused: 0, bad: 0 }; }
    counts[v] = (counts[v] || 0) + 1;
  }
  return { bump, snapshot: () => ({ day, counts: Object.assign({}, counts) }) };
}

// ---------- express route ----------
function rateKey(req, trustProxy) {
  const peer = String((req.socket && req.socket.remoteAddress) || '');
  // X-Forwarded-For only with TRUST_PROXY=1 AND a loopback peer (nginx on the same box); a direct caller can't fake it.
  if (trustProxy && (peer === '::1' || peer.startsWith('127.') || peer.startsWith('::ffff:127.'))) {
    const xf = req.headers['x-forwarded-for'];
    if (typeof xf === 'string' && xf.trim()) { const last = xf.split(',').pop().trim(); if (last) return last.slice(0, 64); }
  }
  return peer || 'unknown';
}

// Mount with app.all('/api/safe-link', ...) BEFORE the global cors() and express.json().
function safeLinkRoute(opts = {}) {
  const express = require('express');
  const limiter = opts.limiter || createRateLimiter({ limit: 10, windowMs: 60000 });
  const counters = opts.counters || createCounters();
  const trustProxy = opts.trustProxy != null ? !!opts.trustProxy : process.env.TRUST_PROXY === '1';
  const parse = express.json({ limit: '2kb', strict: true, type: () => true });
  const deps = () => ({ key: opts.key != null ? opts.key : process.env.GOOGLE_SAFE_BROWSING_KEY, fetch: opts.fetch, lookup: opts.lookup, request: opts.request });

  const handler = function safeLinkHandler(req, res) {
    const origin = req.get('origin');
    const home = !!origin && ALLOWED_ORIGINS.has(origin);
    res.removeHeader('X-Powered-By');
    res.set({ 'Cache-Control': 'no-store', Vary: 'Origin', 'X-Content-Type-Options': 'nosniff' });
    if (home) res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'Retry-After' });
    if (req.method === 'OPTIONS') {
      if (home) res.set({ 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
      return res.status(204).end();
    }
    if (req.method !== 'POST') { res.set('Allow', 'POST, OPTIONS'); return res.status(405).json({ error: 'method' }); }
    if (origin && !home) return res.status(403).json({ error: 'origin' });
    const r = limiter.hit(rateKey(req, trustProxy));
    if (!r.ok) {
      res.set('Retry-After', String(r.retryAfterSec));
      return res.status(429).json({ error: 'rate_limit', message: 'Too many checks. Wait a minute and try again.' });
    }
    parse(req, res, (err) => {
      if (err) { counters.bump('bad'); return res.status(err.status === 413 ? 413 : 400).json({ error: 'bad_input', message: 'Please paste one link.' }); }
      const url = req.body && typeof req.body.url === 'string' ? req.body.url : '';
      if (!url.trim()) { counters.bump('bad'); return res.status(400).json({ error: 'bad_input', message: 'Please paste one link.' }); }
      check(url, deps()).then((out) => {
        counters.bump(out.verdict);
        res.json(out);
      }, (e) => {
        if (e instanceof Refused) {
          counters.bump('refused');
          return res.status(400).json({ error: 'refused', message: 'That link points to a private or local address, so we won\'t check it.' });
        }
        if (e instanceof TypeError) {
          counters.bump('bad');
          return res.status(400).json({ error: 'bad_input', message: e.message === 'scheme' ? 'Only web links (http or https) can be checked.' : 'That doesn\'t look like a web link.' });
        }
        counters.bump('unknown');
        res.status(500).json({ error: 'server' }); // never echo or log the URL
      });
    });
  };
  handler.counters = counters;
  return handler;
}

module.exports = {
  check, normalize, isBlockedIp, isBlockedName, refuseLiteral, refuseResolved, redFlags, expand, safeBrowsing,
  isShortener, guardedLookup, createCounters, safeLinkRoute, rateKey, Refused,
  SHORTENERS, RISKY_TLDS, THREAT_TYPES, ALLOWED_ORIGINS, MAX_HOPS
};
