; Pre-enable Windows Child Sessions (`WTSEnableChildSessions`) during installation on
; supported Windows Pro / Enterprise / Education editions so that by the user's next
; sign-in or reboot, LSA passwordless loopback credentials are already active.
!macro NSIS_HOOK_POSTINSTALL
  Push $0
  Push $1
  Push $2
  Push $3

  IfFileExists "$INSTDIR\harness\qianji-enable-child-sessions.exe" 0 qj_cs_postinstall_done

  SetRegView 64
  ClearErrors
  ReadRegStr $1 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "EditionID"
  StrCpy $2 $1 4
  StrCmp $2 "Core" qj_cs_postinstall_done
  StrCmp $1 "Starter" qj_cs_postinstall_done

  ClearErrors
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion\Terminal Server" "fEnableChildSessions"
  IfErrors qj_cs_check_elev
  IntCmp $0 1 qj_cs_postinstall_done

qj_cs_check_elev:
  ClearErrors
  UserInfo::GetAccountType
  Pop $2
  StrCmp $2 "Admin" qj_cs_run_elevated

  IfSilent qj_cs_postinstall_done
  ExecShell "" "$INSTDIR\harness\qianji-enable-child-sessions.exe" "--quiet" SW_HIDE
  Goto qj_cs_postinstall_done

qj_cs_run_elevated:
  nsExec::ExecToLog '"$INSTDIR\harness\qianji-enable-child-sessions.exe" --quiet'
  Pop $3

qj_cs_postinstall_done:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend
