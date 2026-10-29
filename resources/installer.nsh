; Additions to electron-builder's assisted NSIS installer (`nsis.include` in electron-builder.yml).
; Pages: installation mode, location, options (desktop shortcut), progress, finish. An in-app update
; (`--updated`) skips every choice and keeps the existing mode, location and shortcuts.

!include nsDialogs.nsh

; An in-app update keeps the existing mode without showing the page. Otherwise the page is shown;
; with an existing installation (see xidaoModeShow) its mode is preselected and the other one
; cannot be chosen, so a second copy never appears beside it.
!macro customInstallMode
  ${if} ${isUpdated}
    ${if} $hasPerUserInstallation == "1"
      StrCpy $isForceCurrentInstall "1"
    ${elseif} $hasPerMachineInstallation == "1"
      StrCpy $isForceMachineInstall "1"
    ${endif}
  ${endif}
!macroend

!ifndef BUILD_UNINSTALLER
  ; "0" only when the user cleared the option; a silent installation keeps the default shortcut.
  Var xidaoDesktopShortcut
  Var xidaoDesktopCheckbox

  ; Installing for all users without administrator rights puts the UAC shield on the next button
  ; (see InstModeChange in electron-builder's multiUserUi.nsh), and the stock 50-dialog-unit button
  ; then has no room for the shield beside 「下一步(N) >」. Once per installer window, the next button
  ; grows leftwards by the shield's room and the back button moves with it, so back and next stay
  ; adjacent while cancel and its gap to next keep their places. Dialog units follow the window's
  ; font and DPI.
  !define XIDAO_NEXT_BUTTON_EXTRA_DLU 18
  !define MUI_CUSTOMFUNCTION_GUIINIT xidaoFooterInit

  Function xidaoFooterInit
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6

    ; $0: the extra width in pixels.
    System::Call "*(i 0, i 0, i ${XIDAO_NEXT_BUTTON_EXTRA_DLU}, i 0) p.r1"
    System::Call "user32::MapDialogRect(p $HWNDPARENT, p r1)"
    System::Call "*$1(i .r3, i .r4, i .r0, i .r6)"

    ; Next button (id 1): same right edge, wider to the left. 0x14 = SWP_NOZORDER | SWP_NOACTIVATE.
    GetDlgItem $2 $HWNDPARENT 1
    System::Call "user32::GetWindowRect(p r2, p r1)"
    System::Call "user32::MapWindowPoints(p 0, p $HWNDPARENT, p r1, i 2)"
    System::Call "*$1(i .r3, i .r4, i .r5, i .r6)"
    IntOp $3 $3 - $0
    IntOp $5 $5 - $3
    IntOp $6 $6 - $4
    System::Call "user32::SetWindowPos(p r2, p 0, i r3, i r4, i r5, i r6, i 0x14)"

    ; Back button (id 3): moved left by the same amount. 0x15 adds SWP_NOSIZE.
    GetDlgItem $2 $HWNDPARENT 3
    System::Call "user32::GetWindowRect(p r2, p r1)"
    System::Call "user32::MapWindowPoints(p 0, p $HWNDPARENT, p r1, i 2)"
    System::Call "*$1(i .r3, i .r4, i .r5, i .r6)"
    IntOp $3 $3 - $0
    System::Call "user32::SetWindowPos(p r2, p 0, i r3, i r4, i 0, i 0, i 0x15)"

    System::Free $1
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; No welcome page: this only hooks the show step of the installation mode page that follows.
  !macro customWelcomePage
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW xidaoModeShow
  !macroend

  !macro customPageAfterChangeDir
    ; Defined here, after the installation mode page has declared its controls.
    Function xidaoModeShow
      ${if} $hasPerUserInstallation == "1"
      ${andIf} $hasPerMachineInstallation == "0"
        EnableWindow $MultiUser.InstallModePage.AllUsers 0
        ${NSD_CreateLabel} 0u 75u 100% 24u "已为当前用户安装汐岛。要改为为所有用户安装，请先卸载。"
        Pop $0
      ${elseIf} $hasPerMachineInstallation == "1"
      ${andIf} $hasPerUserInstallation == "0"
        EnableWindow $MultiUser.InstallModePage.CurrentUser 0
        ${NSD_CreateLabel} 0u 75u 100% 24u "已为所有用户安装汐岛。要改为仅为我安装，请先卸载。"
        Pop $0
      ${endif}
    FunctionEnd

    Page custom xidaoOptionsShow xidaoOptionsLeave

    Function xidaoOptionsShow
      ${if} ${isUpdated}
        Abort
      ${endif}
      !insertmacro MUI_HEADER_TEXT "附加选项" "选择安装汐岛时要执行的附加任务。"
      nsDialogs::Create 1018
      Pop $0
      ${NSD_CreateCheckbox} 0u 0u 100% 12u "创建桌面快捷方式"
      Pop $xidaoDesktopCheckbox
      ${if} $xidaoDesktopShortcut != "0"
        ${NSD_Check} $xidaoDesktopCheckbox
      ${endif}
      nsDialogs::Show
    FunctionEnd

    Function xidaoOptionsLeave
      ${NSD_GetState} $xidaoDesktopCheckbox $0
      ${if} $0 == ${BST_CHECKED}
        StrCpy $xidaoDesktopShortcut "1"
      ${else}
        StrCpy $xidaoDesktopShortcut "0"
      ${endif}
    FunctionEnd
  !macroend

  ; electron-builder has just created the desktop shortcut of a fresh installation or reinstallation
  ; (updates keep whatever the user has); remove it when the option was cleared.
  !macro customInstall
    ${ifNot} ${isUpdated}
    ${andIf} $xidaoDesktopShortcut == "0"
      WinShell::UninstShortcut "$newDesktopLink"
      Delete "$newDesktopLink"
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${endif}
  !macroend

  ; The finish page (with 「运行汐岛」) ends a normal installation. An in-app update ends without it:
  ; with --force-run it opens the installed version, as the silent update does.
  !macro customFinishPage
    Function xidaoStartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    Function xidaoFinishPre
      ${if} ${isUpdated}
        ${if} ${isForceRun}
          HideWindow
          Call xidaoStartApp
        ${endif}
        Abort
      ${endif}
    FunctionEnd

    !define MUI_PAGE_CUSTOMFUNCTION_PRE xidaoFinishPre
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION xidaoStartApp
    !insertmacro MUI_PAGE_FINISH
  !macroend
!endif
