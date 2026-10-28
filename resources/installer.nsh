; Additions to electron-builder's assisted NSIS installer (`nsis.include` in electron-builder.yml).
; Pages: installation mode, location, options (desktop shortcut), progress, finish. An in-app update
; (`--updated`) skips every choice and keeps the existing mode, location and shortcuts.

!include nsDialogs.nsh

; An existing installation fixes the mode, so a second copy never appears beside it. A fresh
; installation asks: only for me (default) or for all users.
!macro customInstallMode
  ${if} $hasPerUserInstallation == "1"
    StrCpy $isForceCurrentInstall "1"
  ${elseif} $hasPerMachineInstallation == "1"
    StrCpy $isForceMachineInstall "1"
  ${endif}
!macroend

!ifndef BUILD_UNINSTALLER
  ; "0" only when the user cleared the option; a silent installation keeps the default shortcut.
  Var xidaoDesktopShortcut
  Var xidaoDesktopCheckbox

  !macro customPageAfterChangeDir
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
