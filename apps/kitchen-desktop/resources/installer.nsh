; PickChick Kitchen: the installer itself turns on autostart for this Windows user (owner's decision
; 12.11.2026: no manual steps on each monoblock). The desktop shortcut comes from
; nsis.createDesktopShortcut: always; the silent self-update (--updated) does not make it
; again (Windows runner, 12.11.2026), so customInstall makes it when it is missing.
; Value 'PickChickKitchen' in HKCU\...\CurrentVersion\Run is the same one infra/windows/*-client.ps1
; -Autostart reads and changes; other Run values (iiko) are never read or changed.
; Every install writes it, the silent self-update (--updated) included, so -Autostart Off
; lasts until the next install. A real uninstall removes it; the uninstall step of an update
; (--updated) leaves it.

!macro customInstall
  ${ifNot} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ClearErrors
  ${endIf}
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "PickChickKitchen" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "PickChickKitchen"
    Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  ${endIf}
!macroend
