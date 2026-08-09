# WEL OpenVPN Runtime

Release builds bundle the OpenVPN 2.5.10 I601 x64 runtime files directly in
`bin/`. The installer invokes the official TAP-Windows 9.24.7 I601 Win7
package in silent mode. It does not install OpenVPN GUI, the OpenVPN service,
Wintun or management tools.

The public server CA certificate is stored as `ca.crt`. OpenVPN redistribution
terms are included in `LICENSE-OpenVPN.txt`.

Never place server private keys in the repository.
