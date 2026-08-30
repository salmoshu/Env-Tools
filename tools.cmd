@echo off
rem Env-Tools cmd shim - forwards to tools.ps1 (PowerShell does the real work).
rem Keep comments in English: cmd reads .cmd files as ANSI, UTF-8 Chinese would garble.
setlocal
for /f "usebackq delims=" %%V in ("%~dp0VERSION") do set "ENVTOOLS_VERSION=%%V"
if defined ENVTOOLS_VERSION echo Env-Tools v%ENVTOOLS_VERSION%
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools.ps1" %*
