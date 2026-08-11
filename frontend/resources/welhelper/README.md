# WEL helper runtime

The release workflow builds `edge.exe` from the pinned official ntop/n2n
source before running electron-builder. The client supplies the supernode
host, UDP port, room community, and assigned virtual IP at runtime.

This directory must contain:

- `edge.exe`, built for Windows x64 from ntop/n2n.
- `tapctl.exe`, copied from the signed TAP-Windows runtime.
- `weltap.exe`, the signed TAP-Windows driver installer for first-run setup.
- `n2n-source-notice.txt`, describing the source revision and license.
- `net-compat/`, the Windows 7/8/10 discovery broadcast runtime.
- `net-modern/`, the Windows 10/11 discovery broadcast runtime.

Each broadcast runtime contains `welnet.exe`, the matching official signed
WinDivert DLL and driver, and `WinDivert-LICENSE.txt`. Only limited outbound
UDP discovery packets to `255.255.255.255:5739` are redirected.

Do not copy `fonta0.exe` into this directory or into the installer.
