#!/usr/bin/env bash
# CHG-177: Idempotent MediaMTX setup for Milliway Go Live (Ubuntu 24.04).
# Downloads pinned MediaMTX v1.21.4 with SHA-256 verification, configures
# /etc/mediamtx/mediamtx.yml restricted to live/<streamkey> with HTTP auth hook,
# sets WebRTC ICE UDP port (8189) + coturn TURN use, creates systemd service,
# opens ufw 8189/udp if active, and updates .env without printing secrets.
set -euo pipefail

MTX_VERSION="v1.21.4"
SHA_AMD64="be0c05d9c8af8338116977e7f1c3fcb409fbf882075e5ab075cf8baad76a59d2"
SHA_ARM64="47784081da54c0608ea4dc359f5cfb19880209434769c532b3ed3a67ea99c29d"

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
ENV_FILE="${ENV_FILE:-${APP_DIR}/.env}"
BIN_PATH="${BIN_PATH:-/usr/local/bin/mediamtx}"
CONF_FILE="${CONF_FILE:-/etc/mediamtx/mediamtx.yml}"
SERVICE_FILE="${SERVICE_FILE:-/etc/systemd/system/mediamtx.service}"
COTURN_CONF="${COTURN_CONF:-/etc/turnserver.conf}"
REALM="${REALM:-chat.afirstflag.com}"
AUTH_PORT="${AUTH_PORT:-3000}"
WEBRTC_HTTP_ADDR="${WEBRTC_HTTP_ADDR:-127.0.0.1:8889}"
WEBRTC_ICE_PORT="${WEBRTC_ICE_PORT:-8189}"
SKIP_DOWNLOAD="${SKIP_DOWNLOAD:-0}"
SKIP_UFW="${SKIP_UFW:-0}"
SKIP_SYSTEMCTL="${SKIP_SYSTEMCTL:-0}"

if [ "$SKIP_DOWNLOAD" != "1" ] && [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (e.g. sudo bash tools/setup-mediamtx.sh)" >&2
  exit 1
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

ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  x86_64|amd64) MTX_ARCH="linux_amd64"; MTX_SHA="$SHA_AMD64" ;;
  aarch64|arm64) MTX_ARCH="linux_arm64"; MTX_SHA="$SHA_ARM64" ;;
  *) echo "Unsupported architecture: $ARCH_RAW" >&2; exit 1 ;;
esac

if [ "$SKIP_DOWNLOAD" != "1" ]; then
  if ! id -u mediamtx >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin mediamtx
  fi

  NEED_INSTALL=1
  if [ -x "$BIN_PATH" ] && "$BIN_PATH" --version 2>/dev/null | grep -q "${MTX_VERSION}"; then
    NEED_INSTALL=0
  fi

  if [ "$NEED_INSTALL" = "1" ]; then
    TMP_DIR="$(mktemp -d)"
    trap 'rm -rf "$TMP_DIR"' EXIT
    TARBALL="mediamtx_${MTX_VERSION}_${MTX_ARCH}.tar.gz"
    URL="https://github.com/bluenviron/mediamtx/releases/download/${MTX_VERSION}/${TARBALL}"
    curl -fsSL -o "${TMP_DIR}/${TARBALL}" "$URL"
    echo "${MTX_SHA}  ${TMP_DIR}/${TARBALL}" | sha256sum -c -
    tar -xzf "${TMP_DIR}/${TARBALL}" -C "$TMP_DIR" mediamtx
    install -m 0755 -o root -g root "${TMP_DIR}/mediamtx" "$BIN_PATH"
  fi
fi

# Resolve AUTH_PORT from .env NEST_PORT if configured
ENV_PORT="$(read_env_val "NEST_PORT" "$ENV_FILE" | tr -d '\r\n')"
if [ -n "$ENV_PORT" ]; then
  AUTH_PORT="$ENV_PORT"
fi

# Per-deployment secret authenticating MediaMTX -> Node /api/mediamtx/auth
MTX_AUTH_SECRET="$(read_env_val "MEDIAMTX_AUTH_SECRET" "$ENV_FILE" | tr -d '\r\n')"
if [ -z "$MTX_AUTH_SECRET" ]; then
  MTX_AUTH_SECRET="$(openssl rand -hex 32)"
fi

# Read TURN config from .env or /etc/turnserver.conf (never printed)
TURN_SECRET="$(read_env_val "TURN_SECRET" "$ENV_FILE" | tr -d '\r\n')"
if [ -z "$TURN_SECRET" ] && [ -f "$COTURN_CONF" ]; then
  TURN_SECRET="$(awk -F= '/^[[:space:]]*static-auth-secret=/{ sub(/^[^=]*=/, ""); gsub(/[[:space:]]/, ""); print; exit }' "$COTURN_CONF")"
fi
TURN_HOST="$(read_env_val "TURN_HOST" "$ENV_FILE" | tr -d '\r\n')"
TURN_HOST="${TURN_HOST:-$REALM}"
TURN_TLS="$(read_env_val "TURN_TLS" "$ENV_FILE" | tr -d '\r\n')"

CONF_DIR="$(dirname "$CONF_FILE")"
mkdir -p "$CONF_DIR"
chmod 750 "$CONF_DIR"
TMP_CONF="$(mktemp "${CONF_DIR}/.mediamtx.yml.tmp.XXXXXX")"

cat > "$TMP_CONF" <<YAML
# Managed by tools/setup-mediamtx.sh (CHG-177, MediaMTX ${MTX_VERSION})
logLevel: info
rtsp: false
rtmp: false
hls: false
srt: false
moq: false
api: false
metrics: false
pprof: false
playback: false

authMethod: http
authHTTPAddress: http://127.0.0.1:${AUTH_PORT}/api/mediamtx/auth?secret=${MTX_AUTH_SECRET}
authHTTPExclude: []

webrtc: true
webrtcAddress: ${WEBRTC_HTTP_ADDR}
webrtcEncryption: false
webrtcAllowOrigins: ['https://${REALM}']
webrtcTrustedProxies: ['127.0.0.1/32', '::1/128']
webrtcLocalUDPAddress: :${WEBRTC_ICE_PORT}
webrtcAdditionalHosts: ['${REALM}']
webrtcICEServers2:
  - url: stun:stun.l.google.com:19302
YAML

if [ -n "$TURN_SECRET" ]; then
  cat >> "$TMP_CONF" <<TURNYAML
  - url: turn:${TURN_HOST}:3478?transport=udp
    username: AUTH_SECRET
    password: "${TURN_SECRET}"
    clientOnly: false
  - url: turn:${TURN_HOST}:3478?transport=tcp
    username: AUTH_SECRET
    password: "${TURN_SECRET}"
    clientOnly: false
TURNYAML
  if [ "$TURN_TLS" = "1" ]; then
    cat >> "$TMP_CONF" <<TURNSYAML
  - url: turns:${TURN_HOST}:5349?transport=tcp
    username: AUTH_SECRET
    password: "${TURN_SECRET}"
    clientOnly: false
TURNSYAML
  fi
fi

cat >> "$TMP_CONF" <<PATHYAML

paths:
  "~^live/[A-Za-z0-9_-]{8,32}$":
    source: publisher
PATHYAML

chmod 640 "$TMP_CONF"
if id -u mediamtx >/dev/null 2>&1; then
  chown root:mediamtx "$CONF_DIR" "$TMP_CONF"
fi
mv "$TMP_CONF" "$CONF_FILE"

mkdir -p "$(dirname "$SERVICE_FILE")"
cat > "$SERVICE_FILE" <<UNIT
[Unit]
Description=MediaMTX WebRTC WHIP/WHEP SFU (Milliway Go Live)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mediamtx
Group=mediamtx
ExecStart=${BIN_PATH} ${CONF_FILE}
Restart=on-failure
RestartSec=3
LimitNOFILE=65536
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadOnlyPaths=${CONF_DIR}

[Install]
WantedBy=multi-user.target
UNIT
chmod 644 "$SERVICE_FILE"

upsert_env_val "MEDIAMTX_ENABLED" "1" "$ENV_FILE"
upsert_env_val "MEDIAMTX_PUBLIC_BASE" "/mtx" "$ENV_FILE"
upsert_env_val "MEDIAMTX_AUTH_SECRET" "$MTX_AUTH_SECRET" "$ENV_FILE"
unset TURN_SECRET MTX_AUTH_SECRET

if [ "$SKIP_UFW" != "1" ] && command -v ufw >/dev/null 2>&1; then
  if ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "${WEBRTC_ICE_PORT}/udp" comment 'MediaMTX WebRTC ICE UDP'
  fi
fi

if [ "$SKIP_SYSTEMCTL" != "1" ] && command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl enable mediamtx >/dev/null 2>&1 || true
  systemctl restart mediamtx
  systemctl is-active --quiet mediamtx
fi

echo "MediaMTX ${MTX_VERSION} configured (HTTP=${WEBRTC_HTTP_ADDR}, ICE=:${WEBRTC_ICE_PORT}/udp, path=live/<streamkey>)."
echo "Next: add tools/nginx-mediamtx.conf snippet to your nginx site config and reload nginx."
