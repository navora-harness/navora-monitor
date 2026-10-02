# Navora Monitor

局域网 CCTV 预览 / 录像 / 回放（Go 服务 + Vue + FFmpeg）。

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
npm run dev          # Vite 前端 http://127.0.0.1:5188
npm run dev:server   # Go 后端（另开终端）
```

本地数据写在 `portable/`（已 gitignore）。可从示例复制通道配置：

```bash
copy portable\channels.example.json portable\channels.json   # Windows
cp portable/channels.example.json portable/channels.json     # Linux
```

**不要**把含真实 RTSP 密码的 `channels.json` / `settings.json` 提交到仓库。

## 打包（Go + Vue）

| 命令 | 说明 |
|------|------|
| `npm run dist:go` | win-x64 portable + setup + linux-x64 portable |
| `npm run dist:go:portable` | 同上目标，仅 zip（跳过 NSIS） |
| `npm run dist:go:setup` | 仅 Windows x64 NSIS 安装包 |
| `npm run dist:go:win` | 仅 win-x64 |
| `npm run dist:go:linux` | 仅 linux-x64 portable |

产物在 `release/`（如 `NavoraMonitor-<ver>-win-x64-portable.zip`）。打包前请先 `ffmpeg:fetch` / `ffmpeg:fetch:all`。Windows 安装包需要本机安装 [NSIS](https://nsis.sourceforge.io/Download)（`makensis`）。

## GitHub Actions 自动发布

仓库工作流 [`.github/workflows/release.yml`](./.github/workflows/release.yml) 会在打标签或手动触发时：

1. 校验 `package.json` 与 `server/internal/core/version.go` 版本一致  
2. 拉取（并缓存）各平台 FFmpeg  
3. 交叉编译 win/linux × x64/arm64 绿色版 zip  
4. 上传 Actions artifact，并创建/更新 GitHub Release  

**前提：** 工作流文件必须已在要打的标签所指向的提交上（先合并进 `main`，再打标签）。

**打标签发布**（版本号三处一致：`package.json`、`version.go`、标签 `vX.Y.Z`）：

```bash
# 例如当前版本 0.3.37（已在 main）
git checkout main
git pull
git tag v0.3.37
git push origin v0.3.37
```

也可在 GitHub → Actions → **Release** → **Run workflow**（仅 `main`）手动跑一遍。

CI 在 Linux 上跳过 NSIS 安装包；需要 `.exe` 安装包时请在 Windows 本机执行 `npm run dist:go:setup`。

## 开源协议

本仓库源代码采用 [MIT License](./LICENSE)。

发行包中内置的 FFmpeg 二进制来自 [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)，遵循 **GPLv3**（见 `resources/ffmpeg/LICENSE.txt` / `vendor/ffmpeg/*/LICENSE.txt`）。分发含 FFmpeg 的安装包时，请一并遵守其 GPL 义务。

## 开源鸣谢

本程序基于以下开源项目构建与运行：

| 项目 | 链接 |
|------|------|
| Vue | https://github.com/vuejs/core |
| hls.js | https://github.com/video-dev/hls.js |
| mpegts.js | https://github.com/xqq/mpegts.js |
| FFmpeg | https://ffmpeg.org/ |
| FFmpeg Builds (BtbN) | https://github.com/BtbN/FFmpeg-Builds |
| Go | https://go.dev/ |
| golang.org/x/crypto | https://pkg.go.dev/golang.org/x/crypto |
| Vite | https://vitejs.dev/ |
| TypeScript | https://www.typescriptlang.org/ |
| vue-tsc | https://github.com/vuejs/language-tools |
| @vitejs/plugin-vue | https://github.com/vitejs/vite-plugin-vue |
| esbuild | https://esbuild.github.io/ |
| Vitest | https://vitest.dev/ |

完整列表见应用内「设置 → 关于 → 开源鸣谢」，以及 [`shared/open-source-credits.ts`](./shared/open-source-credits.ts)。

## 仓库隐私约定

以下内容默认忽略，勿强行加入版本库：

- `portable/` 下真实配置、录像、截图、预览缓存
- `vendor/ffmpeg/**/ffmpeg(.exe)` 大体积二进制
- `.env`、密钥、含口令的导出 JSON
