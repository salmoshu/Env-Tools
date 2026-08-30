@echo off
rem Env-Tools cmd shim - forwards to setup.ps1 (it self-elevates with a UAC prompt).
rem Keep comments in English: cmd reads .cmd files as ANSI, UTF-8 Chinese would garble.
setlocal
for /f "usebackq delims=" %%V in ("%~dp0VERSION") do set "ENVTOOLS_VERSION=%%V"
if defined ENVTOOLS_VERSION echo Env-Tools v%ENVTOOLS_VERSION%
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
