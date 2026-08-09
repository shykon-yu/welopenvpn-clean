# WEL 职业联盟对战平台

An OpenVPN TAP transport for the WEL WE8 platform. This is the active Windows
client line for the platform.

## Structure

- `frontend/`: Electron/Vue Windows client based on the existing WEL client.
- `deploy/openvpn/`: six-room Ubuntu OpenVPN TAP server template and JWT lease
  verifier.
- `.github/workflows/`: frontend checks and conditional Windows packaging.
- `docs/DEVELOPMENT.md`: development, testing, packaging and update workflow.
- `docs/OPERATIONS.md`: Docker, OpenVPN, firewall, log and recovery commands.

The client uses the production Laravel/Go login, room, membership and heartbeat
APIs. OpenVPN authentication sends the current platform JWT to the room
instance; the server verifies that token against the active room lease.

## Current milestone

The application connection lifecycle and server configuration are implemented.
Windows packaging bundles the official OpenVPN 2.5.10 I601 x64 runtime and
the public server CA directly in the client. The WEL installer invokes the
official TAP-Windows 9.24.7 I601 Win7 package silently and creates the
dedicated `WEL Virtual LAN` adapter; it does not install OpenVPN GUI, services or
Wintun. Private server keys are never committed.
