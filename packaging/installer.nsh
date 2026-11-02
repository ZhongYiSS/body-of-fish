; 自定义安装脚本。
;
; 为什么需要它：这台机器上 Chromium 拉 GPU 子进程会被拒（error_code=18），
; 随后 FATAL 自杀，而该检查发生在主进程 JS 运行之前 —— 所以
; `app.commandLine.appendSwitch()` 来不及，参数必须出现在命令行上。
; 直接双击 exe 没有参数，必崩；因此所有入口（桌面 / 开始菜单）都指向带参数的快捷方式。
;
; 应用名在 10-31 改成「本鱼陪伴」：**快捷方式和开始菜单用中文显示名，可执行文件保持英文**
; （中文 exe 名在 Electron 上容易出岔子：子进程路径、taskkill、第三方库的编码都可能翻车）。
; 改名字的时候一定要和 package.json 的 executableName 对齐，否则快捷方式会指向不存在的 exe。

!define APP_EXE "BodyOfFish.exe"
!define APP_LINK "本鱼陪伴.lnk"
!define APP_ARGS "--no-sandbox --disable-gpu-sandbox --in-process-gpu"

; 安装/升级前先把还在跑的那只收掉。
;
; 为什么必须在 customInit 里做：解压要覆盖 resources\app\runtime 与 assets\webm，
; 只要有进程开着这些文件，NSIS 就只会甩一句「不能打开要写入的文件：xxx.webm」，
; 用户完全看不出原因是"程序还开着"。electron-builder 自带的"请关闭应用"检查
; 按产品名找进程，改名/绿色版经常认不出来，所以这里自己动手：静默 taskkill，
; 删不到也不报错（没在跑就是正常情况）。
!macro customInit
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /IM ${APP_EXE}'
  Sleep 1200
!macroend

!macro customInstall
  Delete "$DESKTOP\${APP_LINK}"
  CreateShortCut "$DESKTOP\${APP_LINK}" "$INSTDIR\${APP_EXE}" "${APP_ARGS}" "$INSTDIR\${APP_EXE}" 0
  Delete "$SMPROGRAMS\本鱼陪伴\${APP_LINK}"
  CreateDirectory "$SMPROGRAMS\本鱼陪伴"
  CreateShortCut "$SMPROGRAMS\本鱼陪伴\${APP_LINK}" "$INSTDIR\${APP_EXE}" "${APP_ARGS}" "$INSTDIR\${APP_EXE}" 0
  ; 绿色用法也留一个：装完想复制整个目录走，双击这个也能起。
  FileOpen $0 "$INSTDIR\pet.cmd" w
  FileWrite $0 '@echo off$\r$\nstart "" "%~dp0${APP_EXE}" ${APP_ARGS}$\r$\n'
  FileClose $0
!macroend

!macro customUnInstall
  Delete "$DESKTOP\${APP_LINK}"
  Delete "$SMPROGRAMS\本鱼陪伴\${APP_LINK}"
  RMDir "$SMPROGRAMS\本鱼陪伴"

  ; 卸载时问一句：配置要不要一起删（哥哥 10-31 定「卸载时问我」）。
  ; 0.4.0 起配置目录改名 ~/.dsh/body-of-fish（老版本 ~/.dsh/dsh-pet），两个都认。
  ; 人格、碎碎念池、快捷键、语音缓存都在里面，误删等于把攒的句子和调好的嗓子一起丢掉，
  ; 所以默认不删，只有点「是」才删。本安装器 perMachine=false，$PROFILE 就是当前用户目录。
  StrCpy $0 "$PROFILE\.dsh\body-of-fish"
  IfFileExists "$0\*.*" +2 0
  StrCpy $0 "$PROFILE\.dsh\dsh-pet"
  IfFileExists "$0\*.*" 0 dshPetUninstallDone
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "要把桌宠的配置也一起删除吗？$\r$\n$\r$\n包括：人格设定、碎碎念池、全局快捷键、语音缓存。$\r$\n$\r$\n选「否」只卸载程序，配置留着，下次装回来还在。" \
    IDNO dshPetUninstallDone
  RMDir /r "$0"
  dshPetUninstallDone:
!macroend
