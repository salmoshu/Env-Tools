@echo off
rem Env-Tools cmd shim - forwards to scripts\setup.ps1 (it self-elevates with a UAC prompt).
rem Entry scripts live under scripts\ since v0.7.24; root fallback kept for old checkouts.
rem Keep comments in English: cmd reads .cmd files as ANSI, UTF-8 Chinese would garble.
setlocal
set "ENTRY=%~dp0scripts\setup.ps1"
if not exist "%ENTRY%" set "ENTRY=%~dp0setup.ps1"
if not exist "%ENTRY%" (
    echo setup.ps1 not found under scripts\ or repo root - incomplete checkout?
    exit /b 1
)
for /f "usebackq delims=" %%V in ("%~dp0VERSION") do set "ENVTOOLS_VERSION=%%V"
if defined ENVTOOLS_VERSION echo Env-Tools v%ENVTOOLS_VERSION%
powershell -NoProfile -ExecutionPolicy Bypass -File "%ENTRY%" %*
