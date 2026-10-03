; Custom NSIS hooks for electron-builder.
; Closes any running copy of the app before installing (so an upgrade/reinstall
; doesn't fail with "file in use") and before uninstalling (so removal actually
; deletes everything and doesn't leave an orphaned process behind).

!macro customInit
  nsExec::Exec 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"'
!macroend

!macro customUnInstall
  nsExec::Exec 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"'
!macroend
