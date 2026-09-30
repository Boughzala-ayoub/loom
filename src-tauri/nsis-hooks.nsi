; Put the install dir on the *user* PATH so `loom` / `loom --help` / `loom
; --reset` work from any terminal. Loom installs per-user (LOCALAPPDATA), so
; HKCU is the right hive and no admin is needed. .NET's SetEnvironmentVariable
; also broadcasts WM_SETTINGCHANGE, so newly opened terminals see it.
; ponytail: PowerShell instead of NSIS string plugins — split/filter/join in
; NSI needs StrFunc gymnastics; one PS line is idempotent and readable.

; Tauri's template kills a running Loom, sleeps 500 ms and writes loom.exe. The
; write fails ("Error opening file for writing") while any process still has
; the old image loaded. On 2026-09-29 that was a loom.exe stuck mid-exit: no
; threads, no user, unkillable, holding loom.exe until reboot. A loaded image
; can't be overwritten but can be renamed, so this hook asks and kills the same
; way as the template, moves loom.exe aside and puts a copy back. The
; template's write lands on the copy, and an install that stops before it still
; leaves a loom.exe. The template's own check then finds nothing to kill.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  !insertmacro LoomMoveAside "$INSTDIR\${MAINBINARYNAME}.exe"
!macroend

; Old images are deleted once nothing holds them: here and after the install.
!macro LoomMoveAside path
  Delete "${path}.*.old"
  IfFileExists "${path}" 0 loom_aside_done
  System::Call 'kernel32::GetTickCount()i.R9'
  Rename "${path}" "${path}.$R9.old"
  CopyFiles /SILENT "${path}.$R9.old" "${path}"
  loom_aside_done:
!macroend

; loomctl.exe controls a running Loom from a terminal (src/bin/loomctl.rs). The
; same cargo run builds it beside loom.exe, so it can't be a bundle resource:
; those must exist before cargo starts. The macro expands after the template
; defines MAINBINARYSRCPATH, so its folder is known here at compile time.
!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\${MAINBINARYNAME}.exe.*.old"
  !searchreplace LOOMCTL_SRC "${MAINBINARYSRCPATH}" "\${MAINBINARYNAME}.exe" "\loomctl.exe"
  SetOutPath "$INSTDIR"
  File "/oname=loomctl.exe" "${LOOMCTL_SRC}"
  nsExec::Exec `powershell -NoProfile -Command "$$c=[Environment]::GetEnvironmentVariable('Path','User'); if(($$c -split ';') -notcontains '$INSTDIR'){ if($$c){$$c=$$c.TrimEnd(';')+';'}; [Environment]::SetEnvironmentVariable('Path',$$c+'$INSTDIR','User') }"`
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\${MAINBINARYNAME}.exe.*.old"
  Delete "$INSTDIR\loomctl.exe"
  nsExec::Exec `powershell -NoProfile -Command "$$c=[Environment]::GetEnvironmentVariable('Path','User'); [Environment]::SetEnvironmentVariable('Path',(($$c -split ';' | Where-Object {$$_ -ne '$INSTDIR'}) -join ';'),'User')"`
!macroend
