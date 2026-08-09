#!/usr/bin/env bash
set -euo pipefail

output_dir=${1:-/etc/welopenvpn/rooms}
api_base=${WEL_API_BASE_URL:-http://127.0.0.1:8082/api/v1}
mkdir -p "$output_dir"
mkdir -p /run/welopenvpn/ccd/room-{1,2,3,4,5,6}

for room_id in 1 2 3 4 5 6; do
  subnet="10.80.${room_id}"
  port=$((12000 + room_id))
  cat >"${output_dir}/room-${room_id}.conf" <<EOF
port ${port}
proto udp4
dev tap${room_id}
mode server
topology subnet

ca /etc/welopenvpn/pki/ca.crt
cert /etc/welopenvpn/pki/server.crt
key /etc/welopenvpn/pki/server.key
dh none
ecdh-curve prime256v1
verify-client-cert none
username-as-common-name
data-ciphers AES-256-GCM:AES-128-GCM:AES-256-CBC
data-ciphers-fallback AES-256-CBC
cipher AES-256-CBC
setenv WEL_ROOM_ID ${room_id}
setenv WEL_API_BASE_URL ${api_base}

# A dedicated layer-2 broadcast domain for this WE8 room. No redirect-gateway
# or DNS options are pushed, so ordinary Internet traffic stays local.
ifconfig ${subnet}.1 255.255.255.0
server-bridge ${subnet}.1 255.255.255.0 ${subnet}.10 ${subnet}.109
client-to-client
keepalive 5 20
persist-key
persist-tun
script-security 3
auth-user-pass-verify /etc/welopenvpn/auth/verify-lease.sh via-file
client-config-dir /run/welopenvpn/ccd/room-${room_id}

status /var/log/welopenvpn/room-${room_id}.status 30
status-version 2
verb 3
EOF
done
