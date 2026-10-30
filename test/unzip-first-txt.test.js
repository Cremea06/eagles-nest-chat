// CHG-147: node-only zip extraction for tools/fetch-dbip.sh.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path'); const { execFileSync } = require('child_process');
const { extractFirstTxt } = require('../tools/unzip-first-txt');
const py = (code) => execFileSync('python3', ['-c', code]);
function mkzip(method) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'z')), 'z.zip');
  py(`import zipfile;z=zipfile.ZipFile(${JSON.stringify(f)},'w',${method});z.writestr('readme.md','x');z.writestr('2025_Gaz_zcta_national.txt','GEOID|ALAND\\n54902|1\\n'*50);z.close()`);
  return f;
}
test('extracts first .txt (deflate)', () => {
  const r = extractFirstTxt(fs.readFileSync(mkzip('zipfile.ZIP_DEFLATED')));
  assert.strictEqual(r.name, '2025_Gaz_zcta_national.txt'); assert.ok(r.data.toString().startsWith('GEOID|ALAND\n54902|1\n')); assert.strictEqual(r.data.length, 20 * 50);
});
test('extracts stored entries', () => { assert.strictEqual(extractFirstTxt(fs.readFileSync(mkzip('zipfile.ZIP_STORED'))).data.length, 20 * 50); });
test('rejects non-zip', () => { assert.throws(() => extractFirstTxt(Buffer.from('hello world, not a zip at all')), /not a zip/); });
test('fetch-dbip.sh no longer calls unzip', () => {
  const s = fs.readFileSync(path.join(__dirname, '../tools/fetch-dbip.sh'), 'utf8');
  assert.ok(!/^\s*[^#]*\bunzip\s/m.test(s)); assert.ok(s.includes('unzip-first-txt.js'));
});
