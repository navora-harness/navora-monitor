; Custom NSIS pages for Navora Monitor (electron-builder `nsis.include`)
; Bitmaps are wired by electron-builder from build/installerSidebar.bmp + installerHeader.bmp

!macro customHeader
  !define MUI_WELCOMEPAGE_TITLE "欢迎安装 Navora Monitor"
  !define MUI_WELCOMEPAGE_TEXT "Navora Monitor 用于局域网摄像头预览、循环录像与回放。$\r$\n$\r$\n安装程序会将应用写入所选目录，并可创建桌面与开始菜单快捷方式。$\r$\n$\r$\n点击「下一步」继续。"
  !define MUI_FINISHPAGE_TITLE "安装完成"
  !define MUI_FINISHPAGE_TEXT "Navora Monitor 已安装到本机。$\r$\n$\r$\n可从开始菜单或桌面快捷方式启动；也可在应用「设置 → 外观」中开启开机自动启动。"
  !define MUI_FINISHPAGE_RUN_TEXT "立即运行 Navora Monitor"
!macroend

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE_3LINES
  !define MUI_WELCOMEPAGE_TITLE "卸载 Navora Monitor"
  !define MUI_WELCOMEPAGE_TEXT "即将从本机移除 Navora Monitor。$\r$\n$\r$\n默认不会删除录像与配置数据。$\r$\n$\r$\n点击「卸载」继续。"
  !insertmacro MUI_UNPAGE_WELCOME
!macroend
