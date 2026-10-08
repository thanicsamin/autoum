; Build with makensis -DPROJECT=<repo> -DBUNDLE=<windows bundle> -DOUTPUT=<setup.exe>.
Unicode true
!include "MUI2.nsh"
!include "x64.nsh"
Name "Autoum"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\Autoum"
RequestExecutionLevel user
SetCompressor zlib
SetOverwrite on
Icon "${PROJECT}/dist/extension/icons/Autoum.ico"
UninstallIcon "${PROJECT}/dist/extension/icons/Autoum.ico"
VIProductVersion "0.1.0.1"
VIAddVersionKey /LANG=1033 "ProductName" "Autoum"
VIAddVersionKey /LANG=1033 "FileDescription" "Autoum browser setup"
VIAddVersionKey /LANG=1033 "FileVersion" "0.1.0.1"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Autoum contributors; upstream notices included"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\browser\thorium.exe"
!define MUI_FINISHPAGE_RUN_PARAMETERS '--user-data-dir=$\"$LOCALAPPDATA\Autoum\browser-profile$\" --load-extension=$\"$INSTDIR\dist\extension$\" --no-first-run --no-default-browser-check'
!define MUI_FINISHPAGE_RUN_TEXT "Open Autoum"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${PROJECT}/LICENSE"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "Autoum needs 64-bit Windows."
    Abort
  ${EndIf}
  SetShellVarContext current
  SetRegView 64
FunctionEnd

Section "Autoum"
  SetOutPath "$INSTDIR"
  File /r "${BUNDLE}/*"
  DetailPrint "Setting up Autoum for your account..."
  nsExec::ExecToLog /TIMEOUT=120000 '"$INSTDIR\runtime\node.exe" "$INSTDIR\scripts\install.mjs" --no-desktop'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Autoum could not finish setup. Close Autoum and run this installer again. Details are available in the setup log."
    SetErrorLevel 1
    Abort
  ${EndIf}
  CreateDirectory "$SMPROGRAMS\Autoum"
  CreateShortcut "$DESKTOP\Autoum.lnk" "$INSTDIR\browser\thorium.exe" '--user-data-dir="$LOCALAPPDATA\Autoum\browser-profile" --load-extension="$INSTDIR\dist\extension" --no-first-run --no-default-browser-check' "$INSTDIR\dist\extension\icons\Autoum.ico"
  CreateShortcut "$SMPROGRAMS\Autoum\Autoum.lnk" "$INSTDIR\browser\thorium.exe" '--user-data-dir="$LOCALAPPDATA\Autoum\browser-profile" --load-extension="$INSTDIR\dist\extension" --no-first-run --no-default-browser-check' "$INSTDIR\dist\extension\icons\Autoum.ico"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\Autoum\Uninstall Autoum.lnk" "$INSTDIR\Uninstall.exe"
  FileOpen $0 "$INSTDIR\autoum-install.marker" w
  FileWrite $0 "Autoum application files"
  FileClose $0
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Autoum" "DisplayName" "Autoum"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Autoum" "DisplayVersion" "0.1.0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Autoum" "DisplayIcon" "$INSTDIR\dist\extension\icons\Autoum.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Autoum" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Autoum" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Autoum" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Autoum" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  SetRegView 64
  FileOpen $0 "$INSTDIR\autoum-install.marker" r
  IfErrors unsafe
  FileRead $0 $1
  FileClose $0
  StrCmp $1 "Autoum application files" 0 unsafe
  Delete "$DESKTOP\Autoum.lnk"
  RMDir /r "$SMPROGRAMS\Autoum"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Autoum"
  ; Browser profile, accounts, conversations and artifacts live outside INSTDIR.
  RMDir /r "$INSTDIR"
  Goto done
unsafe:
  MessageBox MB_OK|MB_ICONSTOP "The Autoum installation marker is missing. Application files were left in place."
  SetErrorLevel 1
done:
SectionEnd
