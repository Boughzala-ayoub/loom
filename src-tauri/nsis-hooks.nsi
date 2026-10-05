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
; The images moved aside are kept until both executables are in, so a failed
; install puts the previous pair back (.onInstFailed). Paths go in variables:
; the template defines MAINBINARYNAME after this file, so a function here
; can't name loom.exe itself.
Var LoomMain
Var LoomMainOld
Var LoomCtl
Var LoomCtlOld
Var LoomStuck
!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  StrCpy $LoomMain "$INSTDIR\${MAINBINARYNAME}.exe"
  StrCpy $LoomCtl "$INSTDIR\loomctl.exe"
  !insertmacro LoomMoveAside $LoomMain $LoomMainOld main
  ; A `loomctl watch --follow` (the mail bridge keeps one) outlives Loom and
  ; holds loomctl.exe: a write over it would stop at abort/retry/ignore.
  !insertmacro LoomMoveAside $LoomCtl $LoomCtlOld ctl
!macroend

; Old images are deleted once nothing holds them: here and once both new
; executables are in. `old` gets the image kept, or "" when none is. `id`
; keeps each insertion's labels its own.
!macro LoomMoveAside path old id
  StrCpy ${old} ""
  Delete "${path}.*.old"
  IfFileExists "${path}" 0 loom_aside_done_${id}
  System::Call 'kernel32::GetTickCount()i.R9'
  ClearErrors
  Rename "${path}" "${path}.$R9.old"
  IfErrors 0 loom_aside_moved_${id}
    DetailPrint "Couldn't move ${path} aside; the install writes over it in place."
    Goto loom_aside_done_${id}
  loom_aside_moved_${id}:
  ClearErrors
  CopyFiles /SILENT "${path}.$R9.old" "${path}"
  IfErrors 0 loom_aside_copied_${id}
    ; No copy to write over: the original goes back, and the install writes over it in place.
    Delete "${path}"
    Rename "${path}.$R9.old" "${path}"
    DetailPrint "Couldn't copy ${path}; the install writes over it in place."
    Goto loom_aside_done_${id}
  loom_aside_copied_${id}:
  StrCpy ${old} "${path}.$R9.old"
  loom_aside_done_${id}:
!macroend

; Puts `old` back at `path`, or names what couldn't be in $LoomStuck.
!macro LoomPutBack path old id
  StrCmp ${old} "" loom_back_done_${id}
  Delete "${path}"
  ClearErrors
  Rename "${old}" "${path}"
  IfErrors 0 loom_back_done_${id}
    StrCpy $LoomStuck "$LoomStuck$\r$\n${path} (the previous one is ${old})"
  loom_back_done_${id}:
  StrCpy ${old} ""
!macroend

; The install stopped after an executable may have been replaced: a write
; failed, or Abort was chosen at the template's retry prompt. The previous
; loom.exe and loomctl.exe go back together, never one new beside one old.
Function .onInstFailed
  StrCpy $0 "$LoomMainOld$LoomCtlOld"
  StrCpy $LoomStuck ""
  !insertmacro LoomPutBack $LoomMain $LoomMainOld main
  !insertmacro LoomPutBack $LoomCtl $LoomCtlOld ctl
  StrCmp $LoomStuck "" 0 loom_failed_stuck
  StrCmp $0 "" loom_failed_done
    MessageBox MB_ICONINFORMATION|MB_OK "Loom wasn't installed. The previous loom.exe and loomctl.exe were put back." /SD IDOK
    Goto loom_failed_done
  loom_failed_stuck:
    MessageBox MB_ICONSTOP|MB_OK "Loom wasn't installed, and these couldn't be put back as they were:$LoomStuck$\r$\nRun the installer again." /SD IDOK
  loom_failed_done:
FunctionEnd

; loomctl.exe controls a running Loom from a terminal (src/bin/loomctl.rs). The
; template writes it beside loom.exe, and a write the user told it to ignore
; leaves the old one: it goes in once more, without that prompt, and if that
; fails too the install fails and the previous pair goes back. The macro
; expands after the template defines MAINBINARYSRCPATH, so its folder is known
; here at compile time.
!macro NSIS_HOOK_POSTINSTALL
  !searchreplace LOOMCTL_SRC "${MAINBINARYSRCPATH}" "\${MAINBINARYNAME}.exe" "\loomctl.exe"
  SetOutPath "$INSTDIR"
  SetOverwrite try
  ClearErrors
  File "/oname=loomctl.exe" "${LOOMCTL_SRC}"
  SetOverwrite on
  IfErrors 0 loom_pair_in
    Abort "Couldn't write $LoomCtl."
  loom_pair_in:
  ; Both are in: the images kept to put them back go.
  StrCpy $LoomMainOld ""
  StrCpy $LoomCtlOld ""
  Delete "$LoomMain.*.old"
  Delete "$LoomCtl.*.old"
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
