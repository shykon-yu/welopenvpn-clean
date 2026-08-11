# WEL Network Capture

`WEL网络诊断工具.exe` is a standalone Windows capture utility for recording a
complete WE8 host/client session. It is intentionally outside the WEL client
installer and does not install a virtual adapter, packet driver, or change a
firewall rule.

## What It Produces

After **Start capture** on both computers, run the game session normally, then
press **Stop and create file**. The utility writes one `.welcap.zip` file to
the desktop. Label one run `Host A` and the other `Client B`.

On Windows 10/11 it uses the built-in `pktmon` command and includes raw ETL,
PCAPNG when conversion succeeds, and text decoding. On Windows 7 it falls
back to the built-in `netsh trace` capture and keeps its ETL report.

Each archive also includes:

- start/end IP configuration, adapter list, routes, interface metrics, ARP,
  firewall profile/rule state, drivers, and complete endpoint snapshots;
- a two-second timeline of WE8/edge processes, their loaded modules, and their
  UDP/TCP sockets with owning PID;
- the latest WEL n2n logs when they exist.

The packet capture is not restricted to UDP 5739. That is deliberate: it lets
us establish discovery, join, and match traffic without assuming its ports or
transport beforehand.

Packet files may contain IP addresses and game/network payloads. Use them only
for diagnosing the test session.
