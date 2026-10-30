#!/usr/bin/env bash
# CHG-145: download the offline data used by /api/wx (Weather Radio) into ./data (gitignored).
#  - DB-IP "IP to City Lite" (CC BY 4.0, https://db-ip.com) -> data/dbip-city-lite.mmdb  (~130 MB)
#  - US Census Gazetteer ZCTA centroids (public domain)   -> data/zcta-centroids.json  (~0.7 MB)
# Safe to re-run monthly (DB-IP publishes a new Lite file each month). Then: pm2 restart <nest app>.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

ym=$(date -u +%Y-%m); prev=$(date -u -d "$(date -u +%Y-%m-01) -1 month" +%Y-%m)
ok=0
for m in "$ym" "$prev"; do
  if curl -fsSL -o "$tmp/db.gz" "https://download.db-ip.com/free/dbip-city-lite-$m.mmdb.gz"; then ok=1; echo "DB-IP Lite $m downloaded"; break; fi
done
[ "$ok" = 1 ] || { echo "DB-IP download failed" >&2; exit 1; }
gunzip -c "$tmp/db.gz" > "$tmp/db.mmdb" && mv "$tmp/db.mmdb" data/dbip-city-lite.mmdb

y=$(date -u +%Y); got=0
for yr in "$y" $((y-1)) $((y-2)); do
  if curl -fsSL -o "$tmp/z.zip" "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/${yr}_Gazetteer/${yr}_Gaz_zcta_national.zip"; then got=1; echo "Census ZCTA gazetteer $yr downloaded"; break; fi
done
[ "$got" = 1 ] || { echo "ZCTA gazetteer download failed" >&2; exit 1; }
(cd "$tmp" && unzip -oq z.zip)
node tools/build-zcta.js "$(ls "$tmp"/*.txt | head -1)" data/zcta-centroids.json
ls -la data/dbip-city-lite.mmdb data/zcta-centroids.json
