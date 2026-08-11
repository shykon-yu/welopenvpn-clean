# Client Hook Contract

The production client bridge must keep this protocol out of the game process.
The 32-bit hook only talks to localhost. Electron owns authentication, relay
socket lifetime, diagnostics, and reconnects.

## Synthetic Addresses

Each room member receives a stable synthetic IPv4 address from a reserved
user-mode range. These addresses must never be added to Windows routing tables
or network adapters. They only exist in the hooked Winsock calls.

The bridge maintains these mappings:

```text
synthetic IPv4 <-> room peer ID <-> relay endpoint
```

## Outbound Interception

1. Intercept UDP discovery broadcast to `255.255.255.255:5739`.
2. Send a `BROADCAST` relay frame carrying the original game UDP payload,
   source port, and destination port.
3. Intercept UDP packets addressed to a synthetic peer address.
4. Send a `UNICAST` relay frame instead of passing that packet to Windows.

For compatibility the hook must cover `sendto`, `WSASendTo`, `connect` plus
`send` for connected UDP sockets.

## Inbound Delivery

1. Electron receives a `DELIVERY` frame from the relay and forwards it to a
   localhost UDP port owned by the hook.
2. The hook stores the payload in a queue keyed by game socket and destination
   port.
3. The hook intercepts `recvfrom` and `WSARecvFrom`, returns the queued bytes,
   and sets the source sockaddr to the sender's synthetic address and source
   port.

This makes a remote room member look like a normal LAN sender to WE8 without
creating a TAP adapter.

## Scope And Risk

This first Plan B design supports UDP only. The successful captures establish
UDP 5739 discovery, but a real join capture must confirm the session traffic.
If WE8 uses TCP for joining, the hook needs a stream proxy for `connect`,
`send`, and `recv`; do not silently fall back to an unhooked TCP connection.
