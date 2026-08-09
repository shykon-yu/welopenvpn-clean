#!/usr/bin/env bash
set -euo pipefail

# OpenVPN invokes this script with a temporary username/password file. The
# password is the WEL platform JWT, never an OpenVPN password stored on disk.
credential_file=${1:?missing credential file}
room_id=${WEL_ROOM_ID:?missing WEL_ROOM_ID}
api_base=${WEL_API_BASE_URL:?missing WEL_API_BASE_URL}

username=$(sed -n '1p' "$credential_file" | tr -d '\r')
token=$(sed -n '2p' "$credential_file" | tr -d '\r')

[[ "$username" =~ ^[A-Za-z0-9._-]{1,96}$ ]] || exit 1
[[ -n "$token" ]] || exit 1

response=$(curl --fail --silent --show-error --max-time 5 \
  -H "Authorization: Bearer ${token}" \
  "${api_base%/}/me/room-session") || exit 1

printf '%s' "$response" | jq -e \
  --arg username "$username" \
  --argjson room_id "$room_id" \
  '.lease != null and .lease.room_id == $room_id and .lease.username == $username' \
  >/dev/null

virtual_ip=$(printf '%s' "$response" | jq -r '.lease.virtual_ip // empty')
[[ "$virtual_ip" =~ ^10\.80\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || exit 1

ccd_dir="/run/welopenvpn/ccd/room-${room_id}"
mkdir -p "$ccd_dir"
tmp_file=$(mktemp "${ccd_dir}/.${username}.XXXXXX")
printf 'ifconfig-push %s 255.255.255.0\n' "$virtual_ip" >"$tmp_file"
mv "$tmp_file" "${ccd_dir}/${username}"
