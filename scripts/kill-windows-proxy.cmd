@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0kill-windows-proxy.ps1" %*
exit /b %ERRORLEVEL%
