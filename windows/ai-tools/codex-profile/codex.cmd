@echo off
setlocal
set "REAL_CODEX=__CODEX_REAL_SHIM__"
set "RESOLVER=%~dp0codex-resolve.cjs"

if not exist "%RESOLVER%" (
    >&2 echo codex-profile: resolver not found: "%RESOLVER%"
    exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
    >&2 echo codex-profile: node is required but was not found
    exit /b 127
)
node "%RESOLVER%" --exec "%REAL_CODEX%" %*
exit /b %ERRORLEVEL%
