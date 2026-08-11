# WEL helper runtime

The release workflow builds `edge.exe` from the pinned official ntop/n2n
source before running electron-builder. The client supplies the supernode
host, UDP port, room community, and assigned virtual IP at runtime.

This directory must contain:

- `edge.exe`, built for Windows x64 from ntop/n2n.
- `tapctl.exe`, copied from the signed TAP-Windows runtime.
- `weltap.exe`, the signed TAP-Windows driver installer for first-run setup.
- `n2n-source-notice.txt`, describing the source revision and license.
- `game-runtime/welgame.exe`, the x86 launcher for WE8.
- `game-runtime/welhook.dll`, the x86 WE8 socket-binding module.

The launcher starts WE8 suspended, loads the socket module, and then resumes
the game. The module binds WE8 UDP sockets to the active TAP IP and changes
only discovery broadcasts to the active room's directed broadcast address.

Do not copy `fonta0.exe` into this directory or into the installer.
