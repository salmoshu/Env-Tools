; Env-Tools Windows 安装器（NSIS，静默安装兼容：/S）
; 用法：makensis /DAPP_DIR=<打包输出目录> /DSETUP_OUT=<输出exe> /DVERSION=<版本> installer.nsi
; 用户级安装（LOCALAPPDATA，无需管理员），带开始菜单/桌面快捷方式与卸载器。

Unicode true
ManifestDPIAware true

!define APPNAME "Env-Tools"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"
!define REGKEY "Software\${APPNAME}"

Name "${APPNAME}"
OutFile "${SETUP_OUT}"
InstallDir "$LOCALAPPDATA\${APPNAME}"
InstallDirRegKey HKCU "${REGKEY}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails nevershow
ShowUnInstDetails nevershow

Icon "${ICON}"
UninstallIcon "${ICON}"

; 升级场景：应用先自退出再拉起安装器；这里兜底等待旧进程退出（最多 30s）
Function .onInit
  IfFileExists "$INSTDIR\${APPNAME}.exe" 0 done
  StrCpy $R0 0
wait_loop:
  ClearErrors
  FileOpen $R1 "$INSTDIR\${APPNAME}.exe" a
  IfErrors locked
  FileClose $R1
  Goto done
locked:
  IntOp $R0 $R0 + 1
  IntCmp $R0 30 0 sleep_one done
sleep_one:
  Sleep 1000
  Goto wait_loop
done:
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "${APP_DIR}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "${REGKEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" "$INSTDIR\Uninstall.exe /S"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Env-Tools"

  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\${APPNAME}.exe"
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${APPNAME}.exe"
SectionEnd

Section "Uninstall"
  RMDir /r "$INSTDIR"
  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
  RMDir "$SMPROGRAMS\${APPNAME}"
  Delete "$DESKTOP\${APPNAME}.lnk"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "${REGKEY}"
SectionEnd
