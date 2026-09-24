# Navora Monitor

局域网 CCTV 预览 / 录像 / 回放桌面端（Electron + Vue + FFmpeg）。

## 功能概览

- 设备树、多画面宫格、通道属性、回放时间轴
- 实时预览：FFmpeg → MPEG-TS → mpegts.js（低延迟 remux）
- 分段录像、计划录像、截图、已保存片段
- 一键扫描添加摄像头、配置导入导出
- 局域网远程访问（浏览器桌面 / 手机滚动分屏）
- 托盘常驻、存储感知与循环清理

完整清单见 [`docs/features.md`](./docs/features.md)。

## 准备

1. Node.js ≥ 20  
2. 拉取对应平台的内置 FFmpeg（**二进制不入库**，需本机下载）：

```bash
npm install
npm run ffmpeg:fetch          # 当前系统
# 或打包全平台前：
npm run ffmpeg:fetch:all
```

也可设置环境变量 `NAVORA_MONITOR_FFMPEG` / `FFMPEG_PATH` 指向自有 ffmpeg。

## 开发

```bash
npm install
npm test
npm run electron:dev
```

本地数据写在 `portable/`（已 gitignore）。可从示例复制通道配置：

```bash
copy portable\channels.example.json portable\channels.json   # Windows
cp portable/channels.example.json portable/channels.json     # Linux
```

**不要**把含真实 RTSP 密码的 `channels.json` / `settings.json` 提交到仓库。

## 打包

| 命令 | 说明 |
|------|------|
| `npm run dist` | 当前主机默认目标（Windows 上为 win-x64） |
| `npm run dist:win` | Windows x64（NSIS + portable） |
| `npm run dist:win-arm` | Windows ARM64 |
| `npm run dist:linux` | Linux x64（AppImage + tar.gz） |
| `npm run dist:linux-arm` | Linux ARM64 |
| `npm run dist:all` | 上述四个目标依次打包 |
| `npm run pack` | 仅解包目录（`--dir`） |
| `npm run dist:nsis` / `dist:portable` | 仅 Windows x64 安装包 / 绿色版 |

产物在 `release/`。打包前请先 `ffmpeg:fetch` 对应架构。

跨平台说明：可在 Windows 上打 Linux 包（electron-builder 下载对应 Electron）；Linux ARM / Win ARM 需已下载对应 FFmpeg。

## 开源协议

本仓库源代码采用 [MIT License](./LICENSE)。

发行包中内置的 FFmpeg 二进制来自 [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)，遵循 **GPLv3**（见 `resources/ffmpeg/LICENSE.txt` / `vendor/ffmpeg/*/LICENSE.txt`）。分发含 FFmpeg 的安装包时，请一并遵守其 GPL 义务。

## 仓库隐私约定

以下内容默认忽略，勿强行加入版本库：

- `portable/` 下真实配置、录像、截图、预览缓存
- `vendor/ffmpeg/**/ffmpeg(.exe)` 大体积二进制
- `.env`、密钥、含口令的导出 JSON
