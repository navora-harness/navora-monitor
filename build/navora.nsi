; Machine installation with transactional program replacement.
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!ifndef VERSION
 !define VERSION "0.0.0"
!endif
!ifndef STAGEDIR
 !error "STAGEDIR is required"
!endif
!ifndef OUTFILE
 !error "OUTFILE is required"
!endif
Unicode True
Name "Navora Monitor ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\Navora Monitor"
InstallDirRegKey HKLM "Software\NavoraMonitor" "InstallLocation"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
Var ServiceCheck
Var ServiceChoice
Var DataRoot
Var Output
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_TEXT "安装完成。配置和录像保留在独立数据目录。可从开始菜单打开浏览器管理界面。升级失败时会尝试恢复旧程序；详细步骤见随包安装更新说明。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
Page custom ServicePage ServiceLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
Function .onInit
 System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Global\NavoraMonitorInstaller") p .r0 ?e'
 Pop $1
 ${If} $1 == 183
  SetErrorLevel 1
  Abort
 ${EndIf}
 SetShellVarContext all
 SetRegView 64
 StrCpy $DataRoot "$APPDATA\Navora Monitor"
 StrCpy $ServiceChoice ${BST_CHECKED}
 IfSilent 0 initialized
 IfFileExists "$DataRoot\auth.json" initialized
 SetErrorLevel 1
 Abort
 initialized:
FunctionEnd
Function ServicePage
 nsDialogs::Create 1018
 Pop $0
 ${NSD_CreateLabel} 0 0 100% 42u "程序目录与数据目录分离。升级保留已有服务的数据路径、账户和录像。旧绿色版数据位于程序目录内时，请先按安装更新说明迁移。"
 Pop $0
 ${NSD_CreateCheckbox} 0 52u 100% 20u "注册并启动系统服务（开机运行录像服务）"
 Pop $ServiceCheck
 ${NSD_SetState} $ServiceCheck $ServiceChoice
 nsDialogs::Show
FunctionEnd
Function ServiceLeave
 ${NSD_GetState} $ServiceCheck $ServiceChoice
FunctionEnd
Section "Navora Monitor"
 InitPluginsDir
 SetOutPath "$PLUGINSDIR\payload"
 File "${STAGEDIR}\navora.exe"
 File "${STAGEDIR}\README.txt"
 File "${STAGEDIR}\LICENSE"
 File "${STAGEDIR}\MEDIA-BUILDINFO.json"
 File "${STAGEDIR}\安装更新说明.md"
 File "${STAGEDIR}\windows-deploy.ps1"
 File "${STAGEDIR}\manifest.json"
 SetOutPath "$PLUGINSDIR\payload\ffmpeg"
 File "${STAGEDIR}\ffmpeg\ffmpeg.exe"
 File "${STAGEDIR}\ffmpeg\ffprobe.exe"
 File "${STAGEDIR}\ffmpeg\LICENSE.txt"
 StrCpy $1 ""
 ${If} $ServiceChoice == ${BST_CHECKED}
  StrCpy $1 "-RegisterService"
 ${EndIf}
 nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\payload\windows-deploy.ps1" -Action Install -Payload "$PLUGINSDIR\payload" -InstallRoot "$INSTDIR" -DataRoot "$DataRoot" -ExpectedVersion "${VERSION}" $1'
 Pop $0
 Pop $Output
 ${If} $0 != 0
  MessageBox MB_ICONSTOP|MB_OK "安装未完成，已尝试恢复旧程序。$\r$\n$Output"
  SetErrorLevel 1
  Abort
 ${EndIf}
 ; Do not copy the one-time password into the installer details or a log file.
 IfSilent +2
 MessageBox MB_ICONINFORMATION|MB_OK "$Output$\r$\n请立即保存首次显示的管理员密码。"
 SetOutPath "$INSTDIR"
 CreateDirectory "$SMPROGRAMS\Navora Monitor"
 CreateShortcut "$SMPROGRAMS\Navora Monitor\Navora Monitor.lnk" "$INSTDIR\Navora Monitor.url"
 CreateShortcut "$SMPROGRAMS\Navora Monitor\安装更新说明.lnk" "$INSTDIR\安装更新说明.md"
 WriteUninstaller "$INSTDIR\Uninstall.exe"
 WriteRegStr HKLM "Software\NavoraMonitor" "InstallLocation" "$INSTDIR"
 WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\NavoraMonitor" "DisplayName" "Navora Monitor"
 WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\NavoraMonitor" "DisplayVersion" "${VERSION}"
 WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\NavoraMonitor" "InstallLocation" "$INSTDIR"
 WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\NavoraMonitor" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
 WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\NavoraMonitor" "NoModify" 1
 WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\NavoraMonitor" "NoRepair" 1
SectionEnd
Section "Uninstall"
 SetShellVarContext all
 SetRegView 64
 nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\windows-deploy.ps1" -Action Remove -InstallRoot "$INSTDIR"'
 Pop $0
 Pop $1
 ${If} $0 != 0
  MessageBox MB_ICONSTOP|MB_OK "服务未能停止或移除，卸载终止。$\r$\n$1"
  Abort
 ${EndIf}
 Delete "$INSTDIR\navora.exe"
 Delete "$INSTDIR\windows-deploy.ps1"
 Delete "$INSTDIR\README.txt"
 Delete "$INSTDIR\LICENSE"
 Delete "$INSTDIR\MEDIA-BUILDINFO.json"
 Delete "$INSTDIR\安装更新说明.md"
 Delete "$INSTDIR\Navora Monitor.url"
 Delete "$INSTDIR\ffmpeg\ffmpeg.exe"
 Delete "$INSTDIR\ffmpeg\ffprobe.exe"
 Delete "$INSTDIR\ffmpeg\LICENSE.txt"
 RMDir "$INSTDIR\ffmpeg"
 Delete "$INSTDIR\Uninstall.exe"
 RMDir "$INSTDIR"
 Delete "$SMPROGRAMS\Navora Monitor\Navora Monitor.lnk"
 Delete "$SMPROGRAMS\Navora Monitor\安装更新说明.lnk"
 RMDir "$SMPROGRAMS\Navora Monitor"
 DeleteRegKey HKLM "Software\NavoraMonitor"
 DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\NavoraMonitor"
SectionEnd
