!macro customInstall
  SetOutPath "$PLUGINSDIR"
  File /oname=ensure-wel-tap.ps1 "${BUILD_RESOURCES_DIR}\ensure-wel-tap.ps1"
  File /oname=remember-installed-tap.ps1 "${BUILD_RESOURCES_DIR}\remember-installed-tap.ps1"

  ; All runtime files remain under $INSTDIR\resources\n2n. This lets the
  ; installed directory be copied as a self-contained green edition.
  IfFileExists "$INSTDIR\resources\n2n\edge.exe" 0 runtime_missing
  IfFileExists "$INSTDIR\resources\n2n\tapctl.exe" 0 runtime_missing
  IfFileExists "$INSTDIR\resources\n2n\tap-windows-9.21.2.exe" runtime_ready

runtime_missing:
  MessageBox MB_ICONSTOP|MB_OK "WEL 联机运行文件不完整，请重新下载安装包。"
  Abort

runtime_ready:
  ; A pre-existing tap0901 adapter may belong to WEL, OpenVPN, or another
  ; platform. Reuse it exactly as it is. Never delete, rename, or reinstall it.
  DetailPrint "正在检查 TAP 虚拟网卡..."
  nsExec::ExecToStack '"$SYSDIR\cmd.exe" /D /S /C ""$INSTDIR\resources\n2n\tapctl.exe" list"'
  Pop $2
  Pop $3
  FileOpen $4 "$PLUGINSDIR\tap-before.txt" w
  FileWrite $4 "$3"
  FileClose $4

  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 ensure_tap_system32
  nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\ensure-wel-tap.ps1" -TapctlPath "$INSTDIR\resources\n2n\tapctl.exe"'
  Pop $2
  Goto ensure_tap_result
ensure_tap_system32:
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\ensure-wel-tap.ps1" -TapctlPath "$INSTDIR\resources\n2n\tapctl.exe"'
  Pop $2
ensure_tap_result:
  StrCmp $2 "0" installer_done

  DetailPrint "未检测到 TAP 驱动，正在安装官方 TAP-Windows 驱动..."
  nsExec::ExecToLog '"$INSTDIR\resources\n2n\tap-windows-9.21.2.exe" /S'
  Pop $2
  StrCmp $2 "0" remember_tap
  StrCmp $2 "1641" remember_tap
  StrCmp $2 "3010" remember_tap
  MessageBox MB_ICONSTOP|MB_OK "WEL 虚拟网卡驱动安装失败（错误代码：$2）。"
  Abort

remember_tap:
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 remember_tap_system32
  nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\remember-installed-tap.ps1" -TapctlPath "$INSTDIR\resources\n2n\tapctl.exe" -BeforeListPath "$PLUGINSDIR\tap-before.txt"'
  Pop $2
  Goto installer_done
remember_tap_system32:
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\remember-installed-tap.ps1" -TapctlPath "$INSTDIR\resources\n2n\tapctl.exe" -BeforeListPath "$PLUGINSDIR\tap-before.txt"'
  Pop $2

installer_done:
!macroend

!macro customUnInstall
  ; The TAP adapter can be shared by another WEL green edition, OpenVPN, or a
  ; different platform. Uninstalling WEL must never remove or alter it.
!macroend
