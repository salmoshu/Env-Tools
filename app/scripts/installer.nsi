; Env-Tools Windows 安装器（NSIS，静默安装兼容：/S）
; 用法：makensis /DAPP_DIR=<打包输出目录> /DSETUP_OUT=<输出exe> /DVERSION=<版本> installer.nsi
; 用户级安装（LOCALAPPDATA，无需管理员），带开始菜单/桌面快捷方式与卸载器。

Unicode true
ManifestDPIAware true

!define APPNAME "Env-Tools"
!define BACKEND_EXE "env-tools-api.exe"
!define BACKEND_REL "resources\app\backend-rs\target\release\env-tools-api.exe"
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

; 进程守卫：探测 $INSTDIR 下 Env-Tools.exe 与 env-tools-api.exe 的文件锁。
; 返回 $R9 = 1 表示仍被锁定，0 表示可写。安装器与卸载器各插入一份（un. 前缀）。
!macro PROBE_LOCKS un
Function ${un}ProbeLocks
  StrCpy $R9 0
  IfFileExists "$INSTDIR\${APPNAME}.exe" 0 ${un}probe_backend
  ClearErrors
  FileOpen $R1 "$INSTDIR\${APPNAME}.exe" a
  IfErrors ${un}probe_locked
  FileClose $R1
${un}probe_backend:
  IfFileExists "$INSTDIR\${BACKEND_REL}" 0 ${un}probe_done
  ClearErrors
  FileOpen $R1 "$INSTDIR\${BACKEND_REL}" a
  IfErrors ${un}probe_locked
  FileClose $R1
  Goto ${un}probe_done
${un}probe_locked:
  StrCpy $R9 1
${un}probe_done:
FunctionEnd
!macroend

; 强杀仍在运行的 Env-Tools 主程序与 Rust 后端进程
!macro KILL_RUNNING un
Function ${un}KillRunning
  nsExec::Exec 'taskkill /F /IM ${APPNAME}.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /IM ${BACKEND_EXE}'
  Pop $0
FunctionEnd
!macroend

!insertmacro PROBE_LOCKS ""
!insertmacro PROBE_LOCKS "un."
!insertmacro KILL_RUNNING ""
!insertmacro KILL_RUNNING "un."

; 安装/升级前确保旧进程已退出，否则 File /r 会静默写失败产出残缺安装。
; 流程：先等最多 10s（自升级场景应用正在自退出）→ 仍锁定则
;   静默模式：taskkill 强杀后再等最多 15s，仍锁 → Abort（不产出残缺包）
;   交互模式：提示用户关闭，RETRY 重新探测，CANCEL → Abort
Function .onInit
  IfFileExists "$INSTDIR\${APPNAME}.exe" 0 init_done
  StrCpy $R0 0
init_wait:
  Call ProbeLocks
  IntCmp $R9 0 init_done
  IntOp $R0 $R0 + 1
  IntCmp $R0 10 0 init_sleep init_still_locked
init_sleep:
  Sleep 1000
  Goto init_wait
init_still_locked:
  IfSilent init_kill init_ask
init_ask:
  MessageBox MB_RETRYCANCEL|MB_ICONEXAMINATION "检测到 Env-Tools 正在运行。$\r$\n请先关闭 Env-Tools 后点击“重试”，或点击“取消”中止安装。" IDRETRY init_retry IDCANCEL init_abort
init_retry:
  StrCpy $R0 0
  Goto init_wait
init_abort:
  Abort
init_kill:
  Call KillRunning
  StrCpy $R0 0
init_kill_wait:
  Call ProbeLocks
  IntCmp $R9 0 init_done
  IntOp $R0 $R0 + 1
  IntCmp $R0 15 0 init_kill_sleep init_abort
init_kill_sleep:
  Sleep 1000
  Goto init_kill_wait
init_done:
FunctionEnd

; 卸载前同样的进程守卫：Env-Tools 运行中卸载会删不干净。
; 静默卸载直接 taskkill 强杀（等 15s，仍锁 → Abort）。
Function un.onInit
  IfFileExists "$INSTDIR\${APPNAME}.exe" 0 uninit_done
  StrCpy $R0 0
uninit_wait:
  Call un.ProbeLocks
  IntCmp $R9 0 uninit_done
  IntOp $R0 $R0 + 1
  IntCmp $R0 10 0 uninit_sleep uninit_still_locked
uninit_sleep:
  Sleep 1000
  Goto uninit_wait
uninit_still_locked:
  IfSilent uninit_kill uninit_ask
uninit_ask:
  MessageBox MB_RETRYCANCEL|MB_ICONEXAMINATION "检测到 Env-Tools 正在运行。$\r$\n请先关闭 Env-Tools 后点击“重试”，或点击“取消”中止卸载。" IDRETRY uninit_retry IDCANCEL uninit_abort
uninit_retry:
  StrCpy $R0 0
  Goto uninit_wait
uninit_abort:
  Abort
uninit_kill:
  Call un.KillRunning
  StrCpy $R0 0
uninit_kill_wait:
  Call un.ProbeLocks
  IntCmp $R9 0 uninit_done
  IntOp $R0 $R0 + 1
  IntCmp $R0 15 0 uninit_kill_sleep uninit_abort
uninit_kill_sleep:
  Sleep 1000
  Goto uninit_kill_wait
uninit_done:
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

  ; 安装/升级完成后自动打开（RequestExecutionLevel user，直接 Exec 无 UAC 上下文问题）
  Exec '"$INSTDIR\${APPNAME}.exe"'
SectionEnd

Section "Uninstall"
  RMDir /r "$INSTDIR"
  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
  RMDir "$SMPROGRAMS\${APPNAME}"
  Delete "$DESKTOP\${APPNAME}.lnk"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "${REGKEY}"
SectionEnd
