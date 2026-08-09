!macro customInstall
  SetOutPath "$PLUGINSDIR"
  StrCpy $6 "0"
  File /oname=cleanup-openvpn-gui.ps1 "${BUILD_RESOURCES_DIR}\cleanup-openvpn-gui.ps1"
  File /oname=ensure-wel-tap.ps1 "${BUILD_RESOURCES_DIR}\ensure-wel-tap.ps1"
  File /oname=remove-wel-openvpn-msi.ps1 "${BUILD_RESOURCES_DIR}\remove-wel-openvpn-msi.ps1"
  File /oname=remove-wel-tap.ps1 "${BUILD_RESOURCES_DIR}\remove-wel-tap.ps1"
  File /oname=remember-installed-tap.ps1 "${BUILD_RESOURCES_DIR}\remember-installed-tap.ps1"
  File /oname=hide-tap-windows.ps1 "${BUILD_RESOURCES_DIR}\hide-tap-windows.ps1"
  File /oname=wel-tap-win7.exe "${BUILD_RESOURCES_DIR}\tap-windows-9.21.2.exe"

  ; OpenVPN runs directly from the application resources directory. Only the
  ; signed TAP-Windows driver is installed into Windows.
  IfFileExists "$INSTDIR\resources\openvpn\bin\openvpn.exe" 0 runtime_missing
  IfFileExists "$INSTDIR\resources\openvpn\bin\tapctl.exe" runtime_ready

runtime_missing:
  MessageBox MB_ICONSTOP|MB_OK "WEL 联机运行文件不完整，请重新下载安装包。"
  Abort

runtime_ready:
  ; Clean old OpenVPN GUI entries and legacy MSI leftovers, but keep any
  ; existing TAP adapter so upgrades can reuse it directly.
  SetShellVarContext all
  IfFileExists "$APPDATA\WELPlatform\tap-msi-2.5.10.ready" 0 cleanup_previous_msi_done
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 cleanup_previous_msi_system32
  nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\remove-wel-openvpn-msi.ps1" -TapctlPath "$INSTDIR\resources\openvpn\bin\tapctl.exe"'
  Pop $4
  Goto cleanup_previous_msi_result
cleanup_previous_msi_system32:
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\remove-wel-openvpn-msi.ps1" -TapctlPath "$INSTDIR\resources\openvpn\bin\tapctl.exe"'
  Pop $4
cleanup_previous_msi_result:
  StrCmp $4 "0" cleanup_previous_msi_done
  MessageBox MB_ICONSTOP|MB_OK "旧版 WEL TAP 组件清理失败（错误代码：$4）。请重启电脑后重新运行安装包。"
  Abort
cleanup_previous_msi_done:
  ; Clean startup entries left by older WEL releases that installed the full
  ; OpenVPN feature set. The current helper installs TAP-Windows only.
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM openvpn-gui.exe'
  Pop $3
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 cleanup_gui_system32
  nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\cleanup-openvpn-gui.ps1"'
  Pop $4
  Goto cleanup_gui_done
cleanup_gui_system32:
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\cleanup-openvpn-gui.ps1"'
  Pop $4
cleanup_gui_done:
  SetShellVarContext all
  Delete "$DESKTOP\OpenVPN GUI.lnk"
  Delete "$SMPROGRAMS\OpenVPN\OpenVPN GUI.lnk"
  Delete "$SMSTARTUP\OpenVPN GUI.lnk"
  SetRegView 64
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "OpenVPN GUI"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "OpenVPN-GUI"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "OpenVPNGUI"
  SetRegView 32
  SetShellVarContext current
  Delete "$DESKTOP\OpenVPN GUI.lnk"
  Delete "$SMPROGRAMS\OpenVPN\OpenVPN GUI.lnk"
  Delete "$SMSTARTUP\OpenVPN GUI.lnk"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OpenVPN GUI"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OpenVPN-GUI"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OpenVPNGUI"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "OpenVPN GUI"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "OpenVPN-GUI"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "OpenVPNGUI"
  DeleteRegValue HKLM "Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run" "OpenVPN GUI"
  DeleteRegValue HKLM "Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run" "OpenVPN-GUI"
  DeleteRegValue HKLM "Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run" "OpenVPNGUI"
  SetRegView lastused
  SetShellVarContext all

  DetailPrint "正在准备 WEL 虚拟网卡..."
  nsExec::ExecToStack '"$SYSDIR\cmd.exe" /D /S /C ""$INSTDIR\resources\openvpn\bin\tapctl.exe" list"'
  Pop $2
  Pop $3
  FileOpen $4 "$PLUGINSDIR\tap-before.txt" w
  FileWrite $4 "$3"
  FileClose $4
  Goto ensure_existing_tap

ensure_existing_tap:
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 ensure_existing_tap_system32
  nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\ensure-wel-tap.ps1" -TapctlPath "$INSTDIR\resources\openvpn\bin\tapctl.exe"'
  Pop $2
  Goto ensure_existing_tap_result
ensure_existing_tap_system32:
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\ensure-wel-tap.ps1" -TapctlPath "$INSTDIR\resources\openvpn\bin\tapctl.exe"'
  Pop $2
ensure_existing_tap_result:
  StrCmp $2 "0" tap_ready
  StrCmp $2 "3" install_tap_driver
  Goto install_tap_driver

install_tap_driver:
  DetailPrint "正在安装官方 Win7 TAP-Windows 驱动..."
  nsExec::ExecToLog '"$PLUGINSDIR\wel-tap-win7.exe" /S'
  Pop $2
  StrCmp $2 "0" tap_driver_installed
  StrCmp $2 "1641" tap_driver_installed
  StrCmp $2 "3010" tap_driver_installed
  MessageBox MB_ICONSTOP|MB_OK "WEL 虚拟网卡驱动安装失败（错误代码：$2）。请确认 Windows 7 已安装 SP1。"
  Abort

tap_driver_installed:
  ; The standalone TAP package creates its own adapter. Remember that adapter
  ; instead of relying on localized names such as "本地连接".
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 remember_tap_system32
  nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\remember-installed-tap.ps1" -TapctlPath "$INSTDIR\resources\openvpn\bin\tapctl.exe" -BeforeListPath "$PLUGINSDIR\tap-before.txt"'
  Pop $2
  Goto remember_tap_result
remember_tap_system32:
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\remember-installed-tap.ps1" -TapctlPath "$INSTDIR\resources\openvpn\bin\tapctl.exe" -BeforeListPath "$PLUGINSDIR\tap-before.txt"'
  Pop $2
remember_tap_result:
  StrCmp $2 "0" tap_ready
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 ensure_tap_after_install_system32
  nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\ensure-wel-tap.ps1" -TapctlPath "$INSTDIR\resources\openvpn\bin\tapctl.exe"'
  Pop $2
  Goto ensure_tap_after_install_result
ensure_tap_after_install_system32:
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\ensure-wel-tap.ps1" -TapctlPath "$INSTDIR\resources\openvpn\bin\tapctl.exe"'
  Pop $2
ensure_tap_after_install_result:
  StrCmp $2 "0" tap_ready
  SetRebootFlag true
  StrCpy $6 "1"
  Goto tap_ready

tap_ready:
  ; Hide the MSI entry as a second layer for Windows versions that ignore
  ; ARPSYSTEMCOMPONENT when the property is supplied on the command line.
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 hide_tap_system32
  nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\hide-tap-windows.ps1" -StatePath "$APPDATA\WELPlatform\tap-arp-state.txt"'
  Pop $5
  Goto hide_tap_done
hide_tap_system32:
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\hide-tap-windows.ps1" -StatePath "$APPDATA\WELPlatform\tap-arp-state.txt"'
  Pop $5
hide_tap_done:
  StrCmp $6 "1" 0 installer_done
  MessageBox MB_ICONINFORMATION|MB_OK "WEL职业联盟对战平台已安装完成。由于 Windows 7 对 TAP 虚拟网卡初始化较慢，请先重启电脑，再打开平台。"
installer_done:
!macroend

!macro customUnInstall
  SetOutPath "$PLUGINSDIR"
  File /oname=remove-wel-tap.ps1 "${BUILD_RESOURCES_DIR}\remove-wel-tap.ps1"
  File /oname=remove-wel-openvpn-msi.ps1 "${BUILD_RESOURCES_DIR}\remove-wel-openvpn-msi.ps1"
  File /oname=cleanup-openvpn-gui.ps1 "${BUILD_RESOURCES_DIR}\cleanup-openvpn-gui.ps1"
  File /oname=wel-tapctl.exe "${BUILD_RESOURCES_DIR}\..\resources\openvpn\bin\tapctl.exe"
  File /oname=remember-installed-tap.ps1 "${BUILD_RESOURCES_DIR}\remember-installed-tap.ps1"
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM openvpn-gui.exe'
  Pop $2
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 uninstall_cleanup_gui_system32
  nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\cleanup-openvpn-gui.ps1"'
  Pop $3
  Goto uninstall_cleanup_gui_done
uninstall_cleanup_gui_system32:
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\cleanup-openvpn-gui.ps1"'
  Pop $3
uninstall_cleanup_gui_done:
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\remove-wel-tap.ps1" -TapctlPath "$PLUGINSDIR\wel-tapctl.exe"'
  Pop $1
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\remove-wel-openvpn-msi.ps1" -TapctlPath "$PLUGINSDIR\wel-tapctl.exe"'
  Pop $4
  SetShellVarContext all
  Delete "$DESKTOP\OpenVPN GUI.lnk"
  Delete "$SMPROGRAMS\OpenVPN\OpenVPN GUI.lnk"
  Delete "$SMSTARTUP\OpenVPN GUI.lnk"
  SetRegView 64
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "OpenVPN GUI"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "OpenVPN-GUI"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "OpenVPNGUI"
  SetRegView 32
  SetShellVarContext current
  Delete "$DESKTOP\OpenVPN GUI.lnk"
  Delete "$SMPROGRAMS\OpenVPN\OpenVPN GUI.lnk"
  Delete "$SMSTARTUP\OpenVPN GUI.lnk"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OpenVPN GUI"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OpenVPN-GUI"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OpenVPNGUI"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "OpenVPN GUI"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "OpenVPN-GUI"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "OpenVPNGUI"
  DeleteRegValue HKLM "Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run" "OpenVPN GUI"
  DeleteRegValue HKLM "Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run" "OpenVPN-GUI"
  DeleteRegValue HKLM "Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run" "OpenVPNGUI"
  SetRegView lastused
!macroend
