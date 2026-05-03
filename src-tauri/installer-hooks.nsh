!macro MITM_AG_WRITE_STOP_SCRIPT
  StrCpy $0 "$TEMP\mitm-ag-stop-running.ps1"
  FileOpen $1 "$0" w
  FileWrite $1 "$$ErrorActionPreference = 'SilentlyContinue'$\r$\n"
  FileWrite $1 "$$names = @('mitm-ag-backend.exe', 'mitm-ag-tauri.exe', 'MITM AG.exe')$\r$\n"
  FileWrite $1 "foreach ($$name in $$names) {$\r$\n"
  FileWrite $1 "  & taskkill.exe /IM $$name /T /F | Out-Null$\r$\n"
  FileWrite $1 "}$\r$\n"
  FileWrite $1 "Start-Sleep -Milliseconds 700$\r$\n"
  FileClose $1
!macroend

!macro MITM_AG_STOP_RUNNING_PROCESSES
  DetailPrint "Stopping running MITM AG processes..."
  !insertmacro MITM_AG_WRITE_STOP_SCRIPT
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$0"`
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process -FilePath '$SYSDIR\WindowsPowerShell\v1.0\powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','$0') -Verb RunAs -Wait"`
  Delete "$0"
  Sleep 1000
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro MITM_AG_STOP_RUNNING_PROCESSES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro MITM_AG_STOP_RUNNING_PROCESSES
!macroend
