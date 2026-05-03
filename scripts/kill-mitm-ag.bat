@echo off
setlocal

net session >nul 2>nul
if not "%errorlevel%"=="0" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo Stopping MITM AG backend and UI processes...
for %%P in ("mitm-ag-backend.exe" "mitm-ag-tauri.exe" "MITM AG.exe") do (
  taskkill.exe /IM %%~P /T /F >nul 2>nul
)

echo Done.
endlocal
