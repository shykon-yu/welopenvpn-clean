# Plan B Local Bridge

This is an isolated experimental bridge for the Plan B relay. It is not part
of the Electron application or installer.

```text
WE8 Winsock Hook <- UDP 127.0.0.1:22224 -> bridge.cjs <- UDP -> relay
```

The Hook sends its intercepted discovery broadcast and synthetic-peer UDP to
the bridge. The bridge wraps it in a `WLB1` room relay frame. A relay delivery
is returned to the Hook over localhost with a deterministic synthetic source
address in `198.18.0.0/15`.

The synthetic range is process-only: no address in this range is assigned to
an adapter, inserted into the Windows route table, or exposed as a firewall
scope.

## Run The Bridge

```bash
node bridge.cjs --room 1 --peer 0123456789abcdef0123456789abcdef --relay-host 8.133.189.9
```

The current bridge has no platform authentication. Integrating it requires a
short-lived room token from the WEL API before it can be packaged.

## Native Runtime

`wel_relay_hook.c` and `wel_relay_launcher.c` are the corresponding 32-bit
native runtime. They are built separately from the production TAP runtime:

```powershell
cl.exe /nologo /W4 /O2 /MT /D_CRT_SECURE_NO_WARNINGS /D_WIN32_WINNT=0x0601 /LD wel_relay_hook.c /Fe:welrelayhook.dll /link Ws2_32.lib Psapi.lib
cl.exe /nologo /W4 /O2 /MT /D_CRT_SECURE_NO_WARNINGS /D_WIN32_WINNT=0x0601 wel_relay_launcher.c /Fe:welrelaygame.exe
```

## Prototype Boundary

The bridge and native Hook now cover synchronous `sendto`, `WSASendTo`,
`recvfrom`, and `WSARecvFrom` for UDP. The runtime queues relay deliveries by
the game socket's local UDP port. It must also hook readiness APIs such as
`select` and `WSAPoll` before it can safely support nonblocking UDP games.
TCP, overlapped UDP, production authentication, and collision allocation are
not implemented. Do not package or deploy this as a player-facing network
feature yet.
