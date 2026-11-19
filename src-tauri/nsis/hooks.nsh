; ClipNest NSIS Installer Hooks
; Installs the `clipnest` CLI command wrapper and adds $INSTDIR to the current user's PATH
; (HKCU\Environment) without requiring Administrator privileges, avoiding duplicates on install
; and cleanly removing only $INSTDIR on uninstall.

!macro NSIS_HOOK_POSTINSTALL
  ; Create console-friendly clipnest.cmd wrapper next to ClipNest.exe
  ClearErrors
  FileOpen $0 "$INSTDIR\clipnest.cmd" w
  IfErrors _clipnest_skip_shim
    FileWrite $0 "@echo off$\r$\n"
    FileWrite $0 "setlocal$\r$\n"
    FileWrite $0 "if exist $\"%~dp0clipnest-cli.exe$\" goto :run_cli$\r$\n"
    FileWrite $0 "$\"%~dp0ClipNest.exe$\" %*$\r$\n"
    FileWrite $0 "exit /b %ERRORLEVEL%$\r$\n"
    FileWrite $0 ":run_cli$\r$\n"
    FileWrite $0 "$\"%~dp0clipnest-cli.exe$\" %*$\r$\n"
    FileWrite $0 "exit /b %ERRORLEVEL%$\r$\n"
    FileClose $0
  _clipnest_skip_shim:
  ClearErrors

  ; Ask ClipNest to register $INSTDIR in HKCU\Environment\Path (safe, deduplicated, non-admin)
  nsExec::ExecToLog '"$INSTDIR\ClipNest.exe" path install'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Remove $INSTDIR from HKCU\Environment\Path before deleting files
  nsExec::ExecToLog '"$INSTDIR\ClipNest.exe" path uninstall'
  Delete "$INSTDIR\clipnest.cmd"
  Delete "$INSTDIR\clipn.cmd"
  Delete "$INSTDIR\clipnest-cli.exe"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\ClipNest"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\ClipNestBasket"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\ClipNest"
  DeleteRegKey HKCU "Software\Classes\*\shell\ClipNestCollect"
!macroend
