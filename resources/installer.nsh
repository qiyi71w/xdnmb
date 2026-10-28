﻿; Additions to electron-builder's assisted NSIS installer (`nsis.include` in electron-builder.yml).
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
