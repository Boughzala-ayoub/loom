; Put the install dir on the *user* PATH so `loom` / `loom --help` / `loom
; --reset` work from any terminal. Loom installs per-user (LOCALAPPDATA), so
; HKCU is the right hive and no admin is needed. .NET's SetEnvironmentVariable
; also broadcasts WM_SETTINGCHANGE, so newly opened terminals see it.
; ponytail: PowerShell instead of NSIS string plugins — split/filter/join in
; NSI needs StrFunc gymnastics; one PS line is idempotent and readable.

!macro NSIS_HOOK_POSTINSTALL
  nsExec::Exec `powershell -NoProfile -Command "$$c=[Environment]::GetEnvironmentVariable('Path','User'); if(($$c -split ';') -notcontains '$INSTDIR'){ if($$c){$$c=$$c.TrimEnd(';')+';'}; [Environment]::SetEnvironmentVariable('Path',$$c+'$INSTDIR','User') }"`
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  nsExec::Exec `powershell -NoProfile -Command "$$c=[Environment]::GetEnvironmentVariable('Path','User'); [Environment]::SetEnvironmentVariable('Path',(($$c -split ';' | Where-Object {$$_ -ne '$INSTDIR'}) -join ';'),'User')"`
!macroend
