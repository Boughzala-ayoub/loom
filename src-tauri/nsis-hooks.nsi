; Put the install dir on the *user* PATH so `loom` / `loom --help` / `loom
; --reset` work from any terminal. Loom installs per-user (LOCALAPPDATA), so
; HKCU is the right hive and no admin is needed. The folder reaches PowerShell
; as LOOM_INSTDIR, data and never source, so an apostrophe in it is just a
; character. The value is read unexpanded and written back REG_EXPAND_SZ, so
; %VAR% entries stay variables; WM_SETTINGCHANGE tells new terminals.
; ponytail: PowerShell instead of NSIS string plugins — split/filter/join in
; NSI needs StrFunc gymnastics; one PS line is idempotent and readable.
!macro LoomUserPath script
  Push $0
  StrCpy $0 $INSTDIR
  System::Call 'kernel32::SetEnvironmentVariable(t "LOOM_INSTDIR", t r0)'
  nsExec::Exec `powershell -NoProfile -Command "$$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); $$d=$$env:LOOM_INSTDIR; $$c=[string]$$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $$p=@($$c -split ';' | Where-Object { $$_ }); ${script}; $$k.SetValue('Path',($$p -join ';'),[Microsoft.Win32.RegistryValueKind]::ExpandString)"`
  Pop $0
  StrCmp $0 0 +2
    MessageBox MB_ICONEXCLAMATION|MB_OK "Loom couldn't update your PATH for $INSTDIR (PowerShell: $0). Add or remove that folder in your user PATH by hand." /SD IDOK
  SendMessage 0xFFFF 0x1A 0 "STR:Environment" /TIMEOUT=5000 ; HWND_BROADCAST, WM_SETTINGCHANGE
  Pop $0
!macroend

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
  !insertmacro LoomMoveAside "$INSTDIR\${MAINBINARYNAME}.exe" main
  ; A `loomctl watch --follow` (the mail bridge keeps one) outlives Loom and
  ; holds loomctl.exe: the File below would stop at abort/retry/ignore.
  !insertmacro LoomMoveAside "$INSTDIR\loomctl.exe" ctl
!macroend

; Old images are deleted once nothing holds them: here and after the install.
; `id` keeps each insertion's label its own.
!macro LoomMoveAside path id
  Delete "${path}.*.old"
  IfFileExists "${path}" 0 loom_aside_done_${id}
  System::Call 'kernel32::GetTickCount()i.R9'
  ClearErrors
  Rename "${path}" "${path}.$R9.old"
  IfErrors 0 +3
    DetailPrint "Couldn't move ${path} aside; the install writes over it in place."
    Goto loom_aside_done_${id}
  CopyFiles /SILENT "${path}.$R9.old" "${path}"
  loom_aside_done_${id}:
!macroend

; loomctl.exe controls a running Loom from a terminal (src/bin/loomctl.rs). The
; same cargo run builds it beside loom.exe, so it can't be a bundle resource:
; those must exist before cargo starts. The macro expands after the template
; defines MAINBINARYSRCPATH, so its folder is known here at compile time.
!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\${MAINBINARYNAME}.exe.*.old"
  Delete "$INSTDIR\loomctl.exe.*.old"
  !searchreplace LOOMCTL_SRC "${MAINBINARYSRCPATH}" "\${MAINBINARYNAME}.exe" "\loomctl.exe"
  SetOutPath "$INSTDIR"
  File "/oname=loomctl.exe" "${LOOMCTL_SRC}"
  !insertmacro LoomUserPath "if ($$p -notcontains $$d) { $$p += $$d }"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\${MAINBINARYNAME}.exe.*.old"
  Delete "$INSTDIR\loomctl.exe"
  Delete "$INSTDIR\loomctl.exe.*.old"
  ; What scripts/update.ps1 leaves: its backups and its lock.
  Delete "$INSTDIR\loom-before-update-*.exe"
  Delete "$INSTDIR\loomctl-before-update-*.exe"
  Delete "$INSTDIR\.update.lock"
  !insertmacro LoomUserPath "$$p = @($$p | Where-Object { $$_ -ne $$d })"
!macroend
