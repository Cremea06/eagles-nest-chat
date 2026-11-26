// CHG-177: unit tests for lib/mediamtx.js and tools/setup-mediamtx.sh (local temp dirs only).
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const mediamtx = require('../lib/mediamtx');

test('createLiveSessionStore issues tokens, enforces path & publish auth, and allows public read on live/<key>', () => {
  let allowed = true;
  let nowMs = 1000000;
  const store = mediamtx.createLiveSessionStore({
    now: () => nowMs,
    isSocketAllowed: (sid) => allowed && sid === 'sock-1'
  });

  const sess = store.issue({ socketId: 'sock-1', username: 'Andy' });
  assert.ok(mediamtx.STREAM_KEY_RE.test(sess.streamKey));
  assert.strictEqual(sess.streamPath, 'live/' + sess.streamKey);
  assert.ok(sess.token.length >= 24);

  // Public read on live/<streamkey> succeeds without token
  assert.deepStrictEqual(
    store.verifyHook({ action: 'read', path: sess.streamPath, protocol: 'webrtc' }),
    { ok: true, status: 200 }
  );

  // Paths outside live/<streamkey> are rejected
  assert.strictEqual(store.verifyHook({ action: 'read', path: 'other/stream' }).status, 403);
  assert.strictEqual(store.verifyHook({ action: 'publish', path: 'other/stream', token: sess.token }).status, 403);
  assert.strictEqual(store.verifyHook({ action: 'read', path: 'live/bad!path' }).status, 403);

  // Non-publish/read actions rejected
  assert.strictEqual(store.verifyHook({ action: 'api', path: sess.streamPath }).status, 403);
  assert.strictEqual(store.verifyHook({ action: 'metrics', path: sess.streamPath }).status, 403);

  // Publish requires matching token and allowed socket
  assert.strictEqual(store.verifyHook({ action: 'publish', path: sess.streamPath, token: '' }).status, 401);
  assert.strictEqual(store.verifyHook({ action: 'publish', path: sess.streamPath, token: 'wrong-token' }).status, 401);
  assert.strictEqual(store.verifyHook({ action: 'publish', path: sess.streamPath, token: sess.token }).status, 200);
  assert.strictEqual(store.verifyHook({ action: 'publish', path: sess.streamPath, password: sess.token }).status, 200);

  // Muted/disconnected socket fails publish auth
  allowed = false;
  assert.strictEqual(store.verifyHook({ action: 'publish', path: sess.streamPath, token: sess.token }).status, 401);
  allowed = true;

  // Another socket cannot activate sock-1's streamKey
  assert.strictEqual(store.activate('sock-2', sess.streamKey), null);
  assert.ok(store.activate('sock-1', sess.streamKey));

  // Revoke invalidates publish immediately
  store.revokeSocket('sock-1');
  assert.strictEqual(store.verifyHook({ action: 'publish', path: sess.streamPath, token: sess.token }).status, 401);
});

test('authRoute enforces loopback-only, no X-Forwarded-For, POST only, and MEDIAMTX_AUTH_SECRET', async () => {
  const store = mediamtx.createLiveSessionStore();
  const sess = store.issue({ socketId: 's1', username: 'Andy' });
  const app = express();
  app.all('/api/mediamtx/auth', mediamtx.authRoute({ store, authSecret: 'hook-secret-abc' }));
  const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const port = srv.address().port;

  function post(p, body, headers = {}, method = 'POST') {
    return new Promise((res, rej) => {
      const r = http.request({
        host: '127.0.0.1',
        port,
        path: p,
        method,
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers)
      }, (x) => {
        let b = '';
        x.on('data', (d) => (b += d));
        x.on('end', () => res({ status: x.statusCode, body: b }));
      });
      r.on('error', rej);
      if (body !== undefined) r.write(JSON.stringify(body));
      r.end();
    });
  }

  try {
    // Proxied request (X-Forwarded-For) looks external -> 404
    const xff = await post('/api/mediamtx/auth?secret=hook-secret-abc', {
      action: 'publish', path: sess.streamPath, token: sess.token
    }, { 'X-Forwarded-For': '203.0.113.5' });
    assert.strictEqual(xff.status, 404);

    // Wrong method -> 405
    const getRes = await post('/api/mediamtx/auth?secret=hook-secret-abc', undefined, {}, 'GET');
    assert.strictEqual(getRes.status, 405);

    // Missing/wrong hook secret -> 401
    const noSec = await post('/api/mediamtx/auth', { action: 'read', path: sess.streamPath });
    assert.strictEqual(noSec.status, 401);

    // Valid hook secret + publish token -> 200
    const okPub = await post('/api/mediamtx/auth?secret=hook-secret-abc', {
      action: 'publish', path: sess.streamPath, token: sess.token
    });
    assert.strictEqual(okPub.status, 200);

    // Valid hook secret + bad publish token -> 401
    const badPub = await post('/api/mediamtx/auth?secret=hook-secret-abc', {
      action: 'publish', path: sess.streamPath, token: 'nope'
    });
    assert.strictEqual(badPub.status, 401);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('tools/setup-mediamtx.sh is idempotent, wires TURN + auth hook + live/<key> path, and prints no secrets', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chg177-mtx-'));
  try {
    const appDir = path.join(tmp, 'app');
    const envFile = path.join(appDir, '.env');
    const confFile = path.join(tmp, 'etc-mediamtx', 'mediamtx.yml');
    const svcFile = path.join(tmp, 'systemd', 'mediamtx.service');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(envFile, 'PORT=3000\nTURN_SECRET=turn-secret-keep\nTURN_HOST=chat.afirstflag.com\nTURN_TLS=1\n');

    const script = path.join(__dirname, '..', 'tools', 'setup-mediamtx.sh');
    const env = Object.assign({}, process.env, {
      APP_DIR: appDir,
      ENV_FILE: envFile,
      CONF_FILE: confFile,
      SERVICE_FILE: svcFile,
      BIN_PATH: '/usr/local/bin/mediamtx',
      REALM: 'chat.afirstflag.com',
      SKIP_DOWNLOAD: '1',
      SKIP_UFW: '1',
      SKIP_SYSTEMCTL: '1'
    });

    const out1 = execFileSync('bash', [script], { env, encoding: 'utf8' });
    const env1 = fs.readFileSync(envFile, 'utf8');
    const conf1 = fs.readFileSync(confFile, 'utf8');
    const svc1 = fs.readFileSync(svcFile, 'utf8');
    const mtxSec = env1.match(/^MEDIAMTX_AUTH_SECRET=([a-f0-9]{64})$/m)[1];

    assert.ok(!out1.includes('turn-secret-keep'));
    assert.ok(!out1.includes(mtxSec));
    assert.ok(env1.includes('MEDIAMTX_ENABLED=1'));
    assert.ok(env1.includes('MEDIAMTX_PUBLIC_BASE=/mtx'));
    assert.ok(conf1.includes('authMethod: http'));
    assert.ok(conf1.includes('http://127.0.0.1:3000/api/mediamtx/auth?secret=' + mtxSec));
    assert.ok(conf1.includes('webrtcAddress: 127.0.0.1:8889'));
    assert.ok(conf1.includes('webrtcLocalUDPAddress: :8189'));
    assert.ok(conf1.includes('username: AUTH_SECRET'));
    assert.ok(conf1.includes('password: "turn-secret-keep"'));
    assert.ok(conf1.includes('turns:chat.afirstflag.com:5349?transport=tcp'));
    assert.ok(conf1.includes('"~^live/[A-Za-z0-9_-]{8,32}$":'));
    assert.ok(svc1.includes('ExecStart=/usr/local/bin/mediamtx ' + confFile));

    // Re-run keeps exact same MEDIAMTX_AUTH_SECRET
    execFileSync('bash', [script], { env, encoding: 'utf8' });
    const env2 = fs.readFileSync(envFile, 'utf8');
    assert.strictEqual(env2.match(/^MEDIAMTX_AUTH_SECRET=(.+)$/m)[1], mtxSec);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
