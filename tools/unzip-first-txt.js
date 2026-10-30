#!/usr/bin/env node
// CHG-147: extract the first *.txt entry of a .zip using only node built-ins (zlib), so fetch-dbip.sh needs no `unzip`.
// Usage: node tools/unzip-first-txt.js <in.zip> <out.txt>. Supports stored (0) and deflate (8) entries.
'use strict';
const fs = require('fs');
const zlib = require('zlib');

function extractFirstTxt(buf) {
  // Find End Of Central Directory (signature 0x06054b50) in the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (!/\.txt$/i.test(name) || name.endsWith('/')) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('bad local header');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    if (method === 0) return { name, data: Buffer.from(data) };
    if (method === 8) return { name, data: zlib.inflateRawSync(data) };
    throw new Error('unsupported zip method ' + method + ' for ' + name);
  }
  throw new Error('no .txt entry in zip');
}

if (require.main === module) {
  const [inp, out] = process.argv.slice(2);
  if (!inp || !out) { console.error('usage: unzip-first-txt.js <in.zip> <out.txt>'); process.exit(2); }
  const { name, data } = extractFirstTxt(fs.readFileSync(inp));
  fs.writeFileSync(out, data);
  console.log('extracted ' + name + ' (' + data.length + ' bytes)');
}
module.exports = { extractFirstTxt };
