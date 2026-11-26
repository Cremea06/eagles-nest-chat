#!/usr/bin/env bash
# CHG-176: Idempotent coturn setup for Milliway Go Live (Ubuntu 24.04).
# Installs coturn, configures time-limited REST auth (use-auth-secret),
# reuses Let's Encrypt certs on 5349 TLS if present, opens ufw if active,
# and stores TURN_SECRET in /etc/turnserver.conf and the app's .env without printing it.
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
ENV_FILE="${ENV_FILE:-${APP_DIR}/.env}"
CONF_FILE="${CONF_FILE:-/etc/turnserver.conf}"
DEFAULT_FILE="${DEFAULT_FILE:-/etc/default/coturn}"
REALM="${REALM:-chat.afirstflag.com}"
LE_LIVE_DIR="${LE_LIVE_DIR:-/etc/letsencrypt/live/${REALM}}"
CERT_DIR="${CERT_DIR:-/etc/coturn/certs}"
RENEWAL_HOOK="${RENEWAL_HOOK:-/etc/letsencrypt/renewal-hooks/deploy/coturn-reload.sh}"
RELAY_MIN="${RELAY_MIN:-49152}"
RELAY_MAX="${RELAY_MAX:-65535}"
SKIP_APT="${SKIP_APT:-0}"
SKIP_UFW="${SKIP_UFW:-0}"
SKIP_SYSTEMCTL="${SKIP_SYSTEMCTL:-0}"

if [ "$SKIP_APT" != "1" ] && [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (e.g. sudo bash tools/setup-coturn.sh)" >&2
  exit 1
fi

if [ "$SKIP_APT" != "1" ]; then
  if ! command -v turnserver >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq coturn
  fi
fi

if [ -f "$DEFAULT_FILE" ]; then
  if grep -qE '^[#[:space:]]*TURNSERVER_ENABLED=' "$DEFAULT_FILE"; then
    sed -i -E 's/^[#[:space:]]*TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' "$DEFAULT_FILE"
  else
    printf '\nTURNSERVER_ENABLED=1\n' >> "$DEFAULT_FILE"
  fi
fi

read_env_val() {
  local key="$1" file="$2"
  [ -f "$file" ] || return 0
  awk -F= -v k="$key" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "$file"
}

upsert_env_val() {
  local key="$1" val="$2" file="$3"
  local dir tmp
  dir="$(dirname "$file")"
  mkdir -p "$dir"
  tmp="$(mktemp "${dir}/.env.tmp.XXXXXX")"
  if [ -f "$file" ]; then
    awk -v k="$key" -v v="$val" '
      BEGIN { done = 0 }
      $0 ~ ("^" k "=") {
        if (!done) { print k "=" v; done = 1 }
        next
      }
      { print }
      END { if (!done) print k "=" v }
    ' "$file" > "$tmp"
  else
    printf '%s=%s\n' "$key" "$val" > "$tmp"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

# Reuse existing secret from .env or turnserver.conf so re-runs are idempotent.
SECRET=""
SECRET="$(read_env_val "TURN_SECRET" "$ENV_FILE" | tr -d '\r\n')"
if [ -z "$SECRET" ] && [ -f "$CONF_FILE" ]; then
  SECRET="$(awk -F= '/^[[:space:]]*static-auth-secret=/{ sub(/^[^=]*=/, ""); gsub(/[[:space:]]/, ""); print; exit }' "$CONF_FILE")"
fi
if [ -z "$SECRET" ]; then
  SECRET="$(openssl rand -hex 32)"
fi

TLS_ENABLED=0
if [ -r "${LE_LIVE_DIR}/fullchain.pem" ] && [ -r "${LE_LIVE_DIR}/privkey.pem" ]; then
  mkdir -p "$CERT_DIR"
  cp -L "${LE_LIVE_DIR}/fullchain.pem" "${CERT_DIR}/fullchain.pem"
  cp -L "${LE_LIVE_DIR}/privkey.pem" "${CERT_DIR}/privkey.pem"
  chmod 750 "$CERT_DIR"
  chmod 644 "${CERT_DIR}/fullchain.pem"
  chmod 600 "${CERT_DIR}/privkey.pem"
  if id -u turnserver >/dev/null 2>&1; then
    chown -R turnserver:turnserver "$CERT_DIR"
  fi

  mkdir -p "$(dirname "$RENEWAL_HOOK")"
  cat > "$RENEWAL_HOOK" <<HOOK
#!/usr/bin/env bash
set -euo pipefail
if [ -r "${LE_LIVE_DIR}/fullchain.pem" ] && [ -r "${LE_LIVE_DIR}/privkey.pem" ]; then
  mkdir -p "${CERT_DIR}"
  cp -L "${LE_LIVE_DIR}/fullchain.pem" "${CERT_DIR}/fullchain.pem"
  cp -L "${LE_LIVE_DIR}/privkey.pem" "${CERT_DIR}/privkey.pem"
  chmod 644 "${CERT_DIR}/fullchain.pem"
  chmod 600 "${CERT_DIR}/privkey.pem"
  if id -u turnserver >/dev/null 2>&1; then
    chown -R turnserver:turnserver "${CERT_DIR}"
  fi
  systemctl reload-or-restart coturn || true
fi
HOOK
  chmod 755 "$RENEWAL_HOOK"
  TLS_ENABLED=1
fi

CONF_DIR="$(dirname "$CONF_FILE")"
mkdir -p "$CONF_DIR"
TMP_CONF="$(mktemp "${CONF_DIR}/.turnserver.conf.tmp.XXXXXX")"
cat > "$TMP_CONF" <<CONF
# Managed by tools/setup-coturn.sh (CHG-176)
listening-port=3478
realm=${REALM}
server-name=${REALM}
use-auth-secret
static-auth-secret=${SECRET}
fingerprint
min-port=${RELAY_MIN}
max-port=${RELAY_MAX}
stale-nonce=600
no-multicast-peers
no-cli
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
CONF

if [ "$TLS_ENABLED" = "1" ]; then
  cat >> "$TMP_CONF" <<TLSCONF
tls-listening-port=5349
cert=${CERT_DIR}/fullchain.pem
pkey=${CERT_DIR}/privkey.pem
no-tlsv1
no-tlsv1_1
TLSCONF
fi

chmod 640 "$TMP_CONF"
if getent group turnserver >/dev/null 2>&1; then
  chown root:turnserver "$TMP_CONF"
fi
mv "$TMP_CONF" "$CONF_FILE"

upsert_env_val "TURN_SECRET" "$SECRET" "$ENV_FILE"
upsert_env_val "TURN_HOST" "$REALM" "$ENV_FILE"
upsert_env_val "TURN_TLS" "$TLS_ENABLED" "$ENV_FILE"
unset SECRET

if [ "$SKIP_UFW" != "1" ] && command -v ufw >/dev/null 2>&1; then
  if ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow 3478/tcp comment 'coturn TURN/STUN TCP'
    ufw allow 3478/udp comment 'coturn TURN/STUN UDP'
    ufw allow "${RELAY_MIN}:${RELAY_MAX}/udp" comment 'coturn TURN relay UDP'
    if [ "$TLS_ENABLED" = "1" ]; then
      ufw allow 5349/tcp comment 'coturn TURNS TLS'
    fi
  fi
fi

if [ "$SKIP_SYSTEMCTL" != "1" ] && command -v systemctl >/dev/null 2>&1; then
  systemctl enable coturn >/dev/null 2>&1 || true
  systemctl restart coturn
  systemctl is-active --quiet coturn
fi

echo "coturn configured cleanly (realm=${REALM}, udp/tcp=3478, relay=${RELAY_MIN}-${RELAY_MAX}/udp, tls=${TLS_ENABLED})."
echo "TURN_SECRET stored in ${CONF_FILE} and ${ENV_FILE} (not printed)."
