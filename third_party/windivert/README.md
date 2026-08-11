# WinDivert build inputs

WEL uses official signed WinDivert runtime packages to redirect only WE8's
limited UDP discovery broadcast while a player is in a room. The archives are
build inputs and are not copied wholesale into the client.

Pinned packages:

- `WinDivert-1.4.3-A.zip` for Windows 7/8/10 compatibility.
  SHA-256: `4084bc3931f31546d375ed89e3f842776efa46f321ed0adcd32d3972a7d02566`
- `WinDivert-2.2.2-A.zip` for Windows 10/11.
  SHA-256: `63cb41763bb4b20f600b6de04e991a9c2be73279e317d4d82f237b150c5f3f15`

Official project: <https://github.com/basil00/Divert>

WinDivert is dual-licensed under LGPLv3 or GPLv2. The release workflow copies
the package's `LICENSE` file beside each bundled runtime.
