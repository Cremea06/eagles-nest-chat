// CHG-176: unit tests for lib/turn.js and tools/setup-coturn.sh (local temp dirs only).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const turn = require('../lib/turn');

function serve(handler) {
  const app = express();
  app.all('/api/ice-servers', handler);
  return new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
}

test('buildTurnCredentials computes standard coturn REST HMAC-SHA1 and clamps TTL', () => {
  const secret = 'test-shared-secret-value';
  const c = turn.buildTurnCredentials({ secret, nowSec: 1700000000, ttlSec: 3600, tag: 'milliway' });
  assert.strictEqual(c.username, '1700003600:milliway');
  assert.strictEqual(c.ttlSec, 3600);
  assert.strictEqual(c.expiresAt, 1700003600);
  const expected = crypto.createHmac('sha1', secret).update('1700003600:milliway').digest('base64');
  assert.strictEqual(c.credential, expected);

  const low = turn.buildTurnCredentials({ secret, nowSec: 1000, ttlSec: 5 });
  assert.strictEqual(low.ttlSec, 60);
  const high = turn.buildTurnCredentials({ secret, nowSec: 1000, ttlSec: 999999 });
  assert.strictEqual(high.ttlSec, 86400);
  assert.strictEqual(turn.buildTurnCredentials({ secret: '' }), null);
});

test('buildIceServers returns STUN-only when secret is absent, and UDP/TCP (+TLS optional) when set', () => {
  const off = turn.buildIceServers({ secret: '' });
  assert.strictEqual(off.turn, false);
  assert.deepStrictEqual(off.iceServers, [{ urls: 'stun:stun.l.google.com:19302' }]);

  const on = turn.buildIceServers({
    secret: 'super-secret-hex',
    host: 'chat.afirstflag.com',
    port: 3478,
    tls: false,
    nowSec: 2000000000,
    ttlSec: 3600
  });
  assert.strictEqual(on.turn, true);
  assert.strictEqual(on.tls, false);
  assert.strictEqual(on.ttlSec, 3600);
  assert.strictEqual(on.iceServers.length, 2);
  assert.deepStrictEqual(on.iceServers[1].urls, [
    'turn:chat.afirstflag.com:3478?transport=udp',
    'turn:chat.afirstflag.com:3478?transport=tcp'
  ]);
  assert.ok(on.iceServers[1].username.startsWith('2000003600:'));
  assert.ok(!JSON.stringify(on).includes('super-secret-hex'));

  const withTls = turn.buildIceServers({
    secret: 'super-secret-hex',
    host: 'chat.afirstflag.com',
    tls: true,
    tlsPort: 5349,
    nowSec: 2000000000
  });
  assert.strictEqual(withTls.tls, true);
  assert.deepStrictEqual(withTls.iceServers[1].urls, [
    'turn:chat.afirstflag.com:3478?transport=udp',
    'turn:chat.afirstflag.com:3478?transport=tcp',
    'turns:chat.afirstflag.com:5349?transport=tcp'
  ]);
});

test('iceServersRoute enforces methods, origin allowlist, no-store, and rate limiting', async () => {
  const srv = await serve(turn.iceServersRoute({
    limit: 2,
    windowMs: 60000,
    getConfig: () => ({ secret: 'unit-secret-1234', host: 'chat.afirstflag.com', tls: false })
  }));
  const base = 'http://127.0.0.1:' + srv.address().port + '/api/ice-servers';
  try {
    const opt = await fetch(base, { method: 'OPTIONS' });
    assert.strictEqual(opt.status, 204);
    assert.strictEqual(opt.headers.get('allow'), 'GET, HEAD, OPTIONS');

    const badMethod = await fetch(base, { method: 'POST' });
    assert.strictEqual(badMethod.status, 405);

    const badOrigin = await fetch(base, { headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(badOrigin.status, 403);

    const r1 = await fetch(base, { headers: { Origin: 'https://chat.afirstflag.com' } });
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r1.headers.get('cache-control'), 'no-store');
    const j1 = await r1.json();
    assert.strictEqual(j1.turn, true);
    assert.ok(!JSON.stringify(j1).includes('unit-secret-1234'));

    const r2 = await fetch(base);
    assert.strictEqual(r2.status, 200);

    const r3 = await fetch(base);
    assert.strictEqual(r3.status, 429);
    assert.ok(Number(r3.headers.get('retry-after')) >= 1);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('tools/setup-coturn.sh is idempotent, preserves .env, configures TLS when cert exists, and never prints secret', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chg176-coturn-'));
  try {
    const appDir = path.join(tmp, 'app');
    const envFile = path.join(appDir, '.env');
    const confFile = path.join(tmp, 'turnserver.conf');
    const defaultFile = path.join(tmp, 'coturn-default');
    const leDir = path.join(tmp, 'le-live');
    const certDir = path.join(tmp, 'coturn-certs');
    const hookFile = path.join(tmp, 'hooks', 'coturn-reload.sh');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(envFile, 'PORT=3000\nXAI_API_KEY=keep-me\n');
    fs.writeFileSync(defaultFile, '#TURNSERVER_ENABLED=1\n');

    const script = path.join(__dirname, '..', 'tools', 'setup-coturn.sh');
    const env = Object.assign({}, process.env, {
      APP_DIR: appDir,
      ENV_FILE: envFile,
      CONF_FILE: confFile,
      DEFAULT_FILE: defaultFile,
      LE_LIVE_DIR: leDir,
      CERT_DIR: certDir,
      RENEWAL_HOOK: hookFile,
      REALM: 'chat.afirstflag.com',
      SKIP_APT: '1',
      SKIP_UFW: '1',
      SKIP_SYSTEMCTL: '1'
    });

    // Run 1: no Let's Encrypt cert yet
    const out1 = execFileSync('bash', [script], { env, encoding: 'utf8' });
    const envAfter1 = fs.readFileSync(envFile, 'utf8');
    const confAfter1 = fs.readFileSync(confFile, 'utf8');
    const secretMatch = envAfter1.match(/^TURN_SECRET=([a-f0-9]{64})$/m);
    assert.ok(secretMatch, 'TURN_SECRET generated in .env');
    const secret = secretMatch[1];
    assert.ok(!out1.includes(secret), 'stdout must never print TURN_SECRET');
    assert.ok(envAfter1.includes('XAI_API_KEY=keep-me'));
    assert.ok(envAfter1.includes('TURN_HOST=chat.afirstflag.com'));
    assert.ok(envAfter1.includes('TURN_TLS=0'));
    assert.ok(confAfter1.includes('use-auth-secret'));
    assert.ok(confAfter1.includes('static-auth-secret=' + secret));
    assert.ok(confAfter1.includes('realm=chat.afirstflag.com'));
    assert.ok(confAfter1.includes('min-port=49152'));
    assert.ok(confAfter1.includes('max-port=65535'));
    assert.ok(!confAfter1.includes('tls-listening-port=5349'));
    assert.ok(fs.readFileSync(defaultFile, 'utf8').includes('TURNSERVER_ENABLED=1'));

    // Run 2: add cert files and re-run — secret must stay identical and TLS must enable
    fs.mkdirSync(leDir, { recursive: true });
    fs.writeFileSync(path.join(leDir, 'fullchain.pem'), 'CERTDATA');
    fs.writeFileSync(path.join(leDir, 'privkey.pem'), 'KEYDATA');
    const out2 = execFileSync('bash', [script], { env, encoding: 'utf8' });
    const envAfter2 = fs.readFileSync(envFile, 'utf8');
    const confAfter2 = fs.readFileSync(confFile, 'utf8');
    assert.ok(!out2.includes(secret), 'stdout must never print TURN_SECRET on re-run');
    assert.strictEqual(envAfter2.match(/^TURN_SECRET=(.+)$/m)[1], secret);
    assert.ok(envAfter2.includes('TURN_TLS=1'));
    assert.ok(confAfter2.includes('tls-listening-port=5349'));
    assert.ok(confAfter2.includes('cert=' + path.join(certDir, 'fullchain.pem')));
    assert.ok(fs.existsSync(hookFile));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
