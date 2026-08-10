const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const buildPath = (name) => path.join(__dirname, '..', 'build', name)
const installer = fs.readFileSync(buildPath('installer.nsh'), 'utf8')
const ensureTap = fs.readFileSync(buildPath('ensure-wel-tap.ps1'), 'utf8')
const removeTap = fs.readFileSync(buildPath('remove-wel-tap.ps1'), 'utf8')

test('bundles the n2n runtime and TAP installer for complete and green editions', () => {
  assert.match(installer, /weltap\.exe/)
  assert.match(installer, /resources\\welhelper\\weltap\.exe" \/S/)
  assert.match(installer, /remember-installed-tap\.ps1/)
  assert.match(installer, /tap-before\.txt/)
  assert.match(installer, /ensure_tap_result/)
  assert.match(installer, /StrCmp \$2 "0" installer_done/)
  assert.match(installer, /resources\\welhelper\\edge\.exe/)
  assert.match(installer, /ensure-wel-tap\.ps1/)
  assert.doesNotMatch(installer, /openvpn-gui|cleanup-openvpn|remove-wel-openvpn/i)
  assert.doesNotMatch(installer, /remove-wel-tap|remove-wel-openvpn-msi|hide-tap-windows/)
})

test('reuses any installed TAP adapter without creating, renaming, or removing it', () => {
  assert.doesNotMatch(ensureTap, /NetConnectionID -eq 'WEL TAP'/)
  assert.doesNotMatch(ensureTap, /Remove-NumberedWelTapAdapters/)
  assert.match(ensureTap, /Get-WmiObject -Class Win32_NetworkAdapter/)
  assert.doesNotMatch(ensureTap, /Get-NetAdapter/)
  assert.match(ensureTap, /if \(\$tapAdapters\.Count -gt 0\) {\s*exit 0\s*}/)
  assert.doesNotMatch(ensureTap, /\$existingTapAdapter\.Count/)
  assert.match(ensureTap, /ServiceName -match '[^']*tap0\?\(801\|901\)/)
  assert.match(ensureTap, /Name -match '[^']*TAP-Windows Adapter/)
  assert.match(ensureTap, /exit 3/)
  assert.doesNotMatch(ensureTap, /tapctl.*create|& \$TapctlPath create/)
  assert.match(removeTap, /delete \$rememberedGuid/)
})

test('does not remove installed TAP adapters during upgrade installs', () => {
  const installMacro = installer.slice(installer.indexOf('!macro customInstall'), installer.indexOf('!macro customUnInstall'))
  assert.doesNotMatch(installMacro, /remove-wel-tap|remove-wel-openvpn-msi/)
  assert.doesNotMatch(installMacro, /tapctl\.exe" delete/)
})

test('keeps the Windows network connection name stable on Windows 7', () => {
  assert.doesNotMatch(ensureTap, /Set-TapConnectionName/)
  assert.doesNotMatch(ensureTap, /Set-ItemProperty -LiteralPath \$connectionKey -Name 'Name'/)
  assert.doesNotMatch(removeTap, /Release-WelTapConnectionNames/)
  assert.match(ensureTap, /Windows-assigned connection name/)
})

test('runs installer system commands without visible console windows', () => {
  assert.doesNotMatch(installer, /ExecWait/)
  assert.match(installer, /nsExec::ExecToLog[^\n]+powershell\.exe/)
})

test('does not alter other VPN platforms during install or uninstall', () => {
  assert.doesNotMatch(installer, /taskkill|DeleteRegValue|Delete "\$DESKTOP|OpenVPN GUI/)
  assert.doesNotMatch(installer, /tapctl\.exe" delete/)
  assert.match(installer, /Uninstalling WEL must never remove or alter it/)
})
