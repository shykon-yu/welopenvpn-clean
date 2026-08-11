# Plan B: User-Mode Game Relay

This directory is isolated from the current n2n/TAP client. Nothing under
`plan-b` is packaged or started by the production client.

## Goal

Provide LAN-style WE8 discovery and UDP game transport without a TAP/TUN
adapter, a packet-capture driver, route changes, or Windows firewall rules for
a virtual subnet.

The design is deliberately not a generic VPN:

```text
WE8.exe (32-bit)
  -> injected Winsock hook
  -> localhost UDP bridge
  -> WEL room relay (one outbound UDP session)
  -> other room members
  -> their localhost bridge and injected hook
```

The hook assigns each room member a synthetic user-mode address. It captures
the game's LAN discovery broadcast and forwards it as a relay broadcast. For
subsequent UDP game traffic addressed to a synthetic peer, it sends a relay
unicast. Incoming relay frames are returned by the hook through `recvfrom` /
`WSARecvFrom` with the corresponding synthetic source address.

No Windows network adapter is created. The game sees a LAN-like UDP socket API;
Windows only sees the bridge's ordinary outbound UDP connection to the relay.

## Why Existing Open-Source VPNs Do Not Fit

OpenVPN TAP, n2n, ZeroTier, Radmin VPN, Hamachi-compatible projects, and
SoftEther all create or require a virtual network interface. XLink Kai-style
solutions need packet capture or a network driver. They do not remove the
driver/firewall compatibility surface that Plan B is intended to avoid.

There is no reusable, game-agnostic open-source replacement for commercial
LAN emulation products that can transparently proxy an arbitrary Windows game
without an adapter. The reusable component here is the existing open-source
Winsock IAT-hook approach already used by WEL; Plan B changes its transport
from TAP frames to a user-mode room relay.

## First Deliverable

`relay/` is a runnable, dependency-free Node UDP room relay and a binary
protocol implementation. It is transport only: it knows rooms, peers,
broadcasts, and unicasts. It does not authenticate a player yet.

```bash
cd plan-b/relay
node --test relay.test.cjs
node server.cjs 22223
```

## Required Client Work Before Any Production Switch

1. Add a 32-bit `welrelayhook.dll` and launcher separate from `welhook.dll`.
2. Hook `bind`, `sendto`, `WSASendTo`, `recvfrom`, `WSARecvFrom`, `connect`,
   `send`, and `recv` for UDP sockets.
3. Build a localhost bridge in Electron that authenticates the room lease and
   forwards protocol frames to this relay.
4. Capture a successful WE8 join to confirm whether all game-session traffic
   is UDP. TCP must be handled separately if the capture proves it is used.
5. Replace the relay's proof-of-concept peer ID registration with a signed,
   short-lived room-session token validated by the platform API.

The current evidence confirms UDP discovery on port 5739. It does not yet
prove the exact WE8 session protocol, so Plan B must remain an opt-in
experiment until discovery and joining both pass on Windows 7/10/11.
