@echo off
rem Env-Tools cmd shim - forwards to tools.ps1 (PowerShell does the real work).
rem Keep comments in English: cmd reads .cmd files as ANSI, UTF-8 Chinese would garble.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools.ps1" %*
