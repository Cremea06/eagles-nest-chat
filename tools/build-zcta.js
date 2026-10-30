// CHG-145: Census Gazetteer ZCTA .txt (tab- or pipe-separated, GEOID ... INTPTLAT INTPTLONG) -> compact JSON
// {"v":1,"z":["01001",...],"la":[42.06,...],"lo":[-72.61,...]} with 3-decimal coordinates.
const fs = require('fs');
const [src, dst] = process.argv.slice(2);
const lines = fs.readFileSync(src, 'utf8').split(/\r?\n/);
const first = lines.shift().replace(/^\uFEFF/, '');
const SEP = first.includes('|') ? '|' : '\t'; // 2025+ files are pipe-delimited, older ones tab-delimited
const head = first.split(SEP).map((s) => s.trim());
const iz = head.indexOf('GEOID'), ia = head.indexOf('INTPTLAT'), io = head.indexOf('INTPTLONG');
if (iz < 0 || ia < 0 || io < 0) throw new Error('unexpected gazetteer header');
const out = { v: 1, z: [], la: [], lo: [] };
for (const l of lines) {
  const c = l.split(SEP); if (c.length <= io) continue;
  const z = c[iz].trim(), la = +c[ia], lo = +c[io];
  if (!/^\d{5}$/.test(z) || !isFinite(la) || !isFinite(lo)) continue;
  out.z.push(z); out.la.push(Math.round(la * 1000) / 1000); out.lo.push(Math.round(lo * 1000) / 1000);
}
fs.writeFileSync(dst, JSON.stringify(out));
console.log('ZCTA centroids:', out.z.length);
