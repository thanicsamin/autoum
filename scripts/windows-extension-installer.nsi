Unicode true
!include "MUI2.nsh"
!include "x64.nsh"
Name "Autoum Extension"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\Autoum Extension"
RequestExecutionLevel user
SetCompressor zlib
SetOverwrite on
Icon "${PROJECT}/dist/extension/icons/Autoum.ico"
UninstallIcon "${PROJECT}/dist/extension/icons/Autoum.ico"
VIProductVersion "0.1.0.2"
VIAddVersionKey /LANG=1033 "ProductName" "Autoum Extension"
VIAddVersionKey /LANG=1033 "FileDescription" "Autoum extension and local companion setup"
VIAddVersionKey /LANG=1033 "FileVersion" "0.1.0.2"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Autoum contributors; third-party notices included"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION OpenGuide
!define MUI_FINISHPAGE_RUN_TEXT "Show extension installation steps"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${PROJECT}/LICENSE"
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "Autoum Extension needs 64-bit Windows." /SD IDOK
    Abort
  ${EndIf}
  SetShellVarContext current
  SetRegView 64
FunctionEnd
Function OpenGuide
  ExecShell "open" "$INSTDIR\Extension-setup.html"
FunctionEnd
Section "Companion and bundled voice models (required)"
  SectionIn RO
  SetOutPath "$INSTDIR"
  File /r "${BUNDLE}/*"
  FileOpen $0 "$INSTDIR\autoum-extension.marker" w
  FileWrite $0 "Autoum extension installation"
  FileClose $0
  CreateDirectory "$SMPROGRAMS\Autoum Extension"
  CreateShortcut "$SMPROGRAMS\Autoum Extension\Installation steps.lnk" "$INSTDIR\Extension-setup.html"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\Autoum Extension\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AutoumExtension" "DisplayName" "Autoum Extension"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AutoumExtension" "DisplayVersion" "0.1.0-preview.2"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AutoumExtension" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AutoumExtension" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AutoumExtension" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AutoumExtension" "NoRepair" 1
SectionEnd
Section "Google Chrome"
  nsExec::ExecToStack /TIMEOUT=300000 '$\"$INSTDIR\runtime\node.exe$\" $\"$INSTDIR\scripts\install-extension.mjs$\" --chrome'
  Pop $0
  Pop $1
  DetailPrint $1
  FileOpen $2 "$INSTDIR\setup-last.log" w
  FileWrite $2 $1
  FileClose $2
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Chrome setup failed. Close Chrome and retry. The setup log contains details." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  CreateShortcut "$SMPROGRAMS\Autoum Extension\Chrome extension folder.lnk" "$WINDIR\explorer.exe" '$\"$LOCALAPPDATA\Autoum-Extension\google-chrome\extension$\"'
SectionEnd
Section "Vivaldi"
  nsExec::ExecToStack /TIMEOUT=300000 '$\"$INSTDIR\runtime\node.exe$\" $\"$INSTDIR\scripts\install-extension.mjs$\"'
  Pop $0
  Pop $1
  DetailPrint $1
  FileOpen $2 "$INSTDIR\setup-last.log" w
  FileWrite $2 $1
  FileClose $2
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Vivaldi setup failed. Close Vivaldi and retry. The setup log contains details." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  CreateShortcut "$SMPROGRAMS\Autoum Extension\Vivaldi extension folder.lnk" "$WINDIR\explorer.exe" '$\"$LOCALAPPDATA\Autoum-Extension\vivaldi\extension$\"'
SectionEnd
Section "Uninstall"
  SetShellVarContext current
  SetRegView 64
  FileOpen $0 "$INSTDIR\autoum-extension.marker" r
  IfErrors unsafe
  FileRead $0 $1
  FileClose $0
  StrCmp $1 "Autoum extension installation" 0 unsafe
  nsExec::ExecToStack /TIMEOUT=120000 '$\"$INSTDIR\runtime\node.exe$\" $\"$INSTDIR\scripts\install-extension.mjs$\" --uninstall --chrome'
  Pop $0
  Pop $1
  DetailPrint $1
  FileOpen $2 "$INSTDIR\setup-last.log" w
  FileWrite $2 $1
  FileClose $2
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Close Chrome and retry uninstalling. Your data has been kept." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  nsExec::ExecToStack /TIMEOUT=120000 '$\"$INSTDIR\runtime\node.exe$\" $\"$INSTDIR\scripts\install-extension.mjs$\" --uninstall'
  Pop $0
  Pop $1
  DetailPrint $1
  FileOpen $2 "$INSTDIR\setup-last.log" w
  FileWrite $2 $1
  FileClose $2
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Close Vivaldi and retry uninstalling. Your data has been kept." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  RMDir /r "$SMPROGRAMS\Autoum Extension"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AutoumExtension"
  ; Independent account/chat stores live outside the program installation.
  RMDir /r "$INSTDIR"
  Goto done
unsafe:
  MessageBox MB_OK|MB_ICONSTOP "The installation marker is missing. Files were kept." /SD IDOK
  SetErrorLevel 1
done:
SectionEnd
