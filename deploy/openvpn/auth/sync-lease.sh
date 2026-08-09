#!/usr/bin/env bash
set -euo pipefail

room_id=${WEL_ROOM_ID:?missing WEL_ROOM_ID}
api_base=${WEL_API_BASE_URL:?missing WEL_API_BASE_URL}
secret=${OPENVPN_INTERNAL_SECRET:-${WEL_OPENVPN_INTERNAL_SECRET:-}}
username=${common_name:-}
script_mode=${script_type:-}

[[ "$room_id" =~ ^[1-6]$ ]] || exit 0
[[ "$username" =~ ^[A-Za-z0-9._-]{1,96}$ ]] || exit 0
[[ -n "$secret" ]] || exit 0

connected=false
virtual_ip=

case "$script_mode" in
  client-connect)
    connected=true
    virtual_ip=${ifconfig_pool_remote_ip:-}
    [[ "$virtual_ip" =~ ^10\.222\.${room_id}\.[0-9]{1,3}$ ]] || exit 0
    ;;
  client-disconnect)
    ;;
  *)
    exit 0
    ;;
esac

payload=$(jq -cn \
  --argjson room_id "$room_id" \
  --arg username "$username" \
  --arg virtual_ip "$virtual_ip" \
  --argjson connected "$connected" \
  '{room_id: $room_id, username: $username, virtual_ip: $virtual_ip, connected: $connected}')

curl --silent --show-error --max-time 5 \
  -H "Content-Type: application/json" \
  -H "X-WEL-OpenVPN-Secret: ${secret}" \
  -d "$payload" \
  "${api_base%/}/internal/openvpn/lease" >/dev/null || true
