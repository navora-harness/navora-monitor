; Navora Monitor installer. Staged by scripts/dist-go.mjs.
; makensis /DVERSION=0.3.27 /DSTAGEDIR=... /DOUTFILE=... build/navora.nsi

!include "MUI2.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef STAGEDIR
  !error "STAGEDIR is required"
!endif
!ifndef OUTFILE
  !error "OUTFILE is required"
!endif

Name "Navora Monitor ${VERSION}"
OutFile "${OUTFILE}"
Unicode True
InstallDir "$LOCALAPPDATA\Navora Monitor"
RequestExecutionLevel user

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "Navora Monitor"
  SetOutPath "$INSTDIR"
  File "${STAGEDIR}\navora.exe"
  File "${STAGEDIR}\README.txt"
  SetOutPath "$INSTDIR\ffmpeg"
  File /nonfatal "${STAGEDIR}\ffmpeg\ffmpeg.exe"
  File /nonfatal "${STAGEDIR}\ffmpeg\LICENSE.txt"
  CreateDirectory "$INSTDIR\portable"
  CreateShortcut "$DESKTOP\Navora Monitor.lnk" "$INSTDIR\navora.exe"
  CreateDirectory "$SMPROGRAMS\Navora Monitor"
  CreateShortcut "$SMPROGRAMS\Navora Monitor\Navora Monitor.lnk" "$INSTDIR\navora.exe"
  CreateShortcut "$SMPROGRAMS\Navora Monitor\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NavoraMonitor" "DisplayName" "Navora Monitor"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NavoraMonitor" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NavoraMonitor" "Publisher" "Navora"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NavoraMonitor" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NavoraMonitor" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NavoraMonitor" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\navora.exe"
  Delete "$INSTDIR\Uninstall.exe"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\ffmpeg\ffmpeg.exe"
  Delete "$INSTDIR\ffmpeg\LICENSE.txt"
  RMDir "$INSTDIR\ffmpeg"
  RMDir "$INSTDIR\portable"
  RMDir "$INSTDIR"
  Delete "$DESKTOP\Navora Monitor.lnk"
  Delete "$SMPROGRAMS\Navora Monitor\Navora Monitor.lnk"
  Delete "$SMPROGRAMS\Navora Monitor\Uninstall.lnk"
  RMDir "$SMPROGRAMS\Navora Monitor"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\NavoraMonitor"
SectionEnd
