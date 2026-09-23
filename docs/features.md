# Navora Monitor — 功能清单

底层：**FFmpeg 子进程**（优先 `-c copy` remux）。UI：Electron + Vue，壳布局对齐 Navora Flow。

图例：`[ ]` 未做 · `[~]` 进行中 · `[x]` 已完成

## P0 骨架

- [x] U01 壳布局（TitleBar / 设备树 / 宫格 / 属性 / 底栏 / StatusBar）
- [x] U02 可拖拽分栏 + 布局持久化
- [x] U03 主题变量（Navora 浅绿 accent）
- [x] Y03 便携数据目录 `portable/`
- [x] Y07 单实例
- [x] D01 手动添加/编辑通道（UI + `channels.json`）
- [x] D04 通道启用/停用
- [x] R01 手动开始/停止录像
- [x] R05 / R06 分段 300s + MP4 remux（对齐现有脚本）
- [x] M01 / M02 / M07 FFmpeg 拉流 remux + 进程管理
- [x] S01 录像目录 `portable/recordings/<channelId>/`

## P1 单路可用

- [x] L01 多画面布局切换（1/4/9/16）
- [x] L02 拖拽上墙
- [x] L03 全屏/单路放大（双击或 OSD「放大」，Esc 还原）
- [x] L04 截图（OSD → `portable/snapshots/`）
- [x] L05 OSD（通道名 / LIVE / REC）
- [x] L07 预览策略（子码流 `previewUrl`，否则主码流）
- [x] L08 断线重连（预览进程指数退避）
- [x] 实时预览管线：FFmpeg MPEG-TS 直推 + mpegts.js（低延迟 remux，替代 HLS）
- [x] 预览宽度：宫格 `minmax(0,1fr)` + video 绝对铺满，避免被撑破
- [x] S02 录像分段索引（扫描文件系统）
- [x] P01–P02 底栏列表 + 本机 MP4 回放（日期筛选 / 倍速 / 连续播放）
- [x] D05 主/子码流字段
- [x] D06 连通性探测（ffmpeg 短开流）
- [ ] L06 音频预览

## P2 多路与计划

- [x] R02 计划录像（周几 + 时段，含跨夜）
- [x] Y01 托盘常驻（关窗进托盘）
- [ ] R07–R08 双码流策略与状态指示完善
- [x] S03–S04 满盘策略与磁盘监控（告警 → 自动清理最早分段 → 停录/禁开；占用展示）
- [ ] Y02 开机自启
- [x] Y06 设置页（录像/截图路径、默认分段、保留天数、FFmpeg、关窗进托盘）

## P3 转发与发现

- [ ] F01–F04 RTSP/RTMP 转发与访问控制
- [ ] D02 ONVIF 发现
- [x] D03 设备树分组（`group` 字段）+ 分组开始/停止录像 + 重命名/解散
- [x] 标题栏菜单 + 分组启停
- [x] 宫格上墙布局持久化（重启恢复预览）
- [x] 全局快捷键（Ctrl+N / Ctrl+, / Ctrl+E/T / Ctrl+1–4 / Ctrl+R / F5 / Delete）

## P4 事件与增强

- [ ] A01–A05 告警
- [ ] R03–R04 事件录像 / 预录
- [ ] P03–P07 倍速、剪辑、同步回放
- [ ] M08 硬件加速
- [ ] F05 级联

## FFmpeg 命令

### 录像（已实现）

```bash
ffmpeg -rtsp_transport tcp -i "<url>" \
  -c copy -reset_timestamps 1 -metadata title="<name>" -map 0 \
  -f segment -segment_time 300 -segment_format mp4 \
  "<stem>-%03d.mp4"
```

### 预览 MPEG-TS（已实现，低延迟）

```bash
ffmpeg -fflags nobuffer+genpts+discardcorrupt -flags low_delay \
  -probesize 32 -analyzeduration 0 -rtsp_transport tcp -i "<url>" \
  -an -c:v copy -bsf:v h264_mp4toannexb \
  -f mpegts -muxdelay 0 -muxpreload 0 -flush_packets 1 pipe:1
```

经本地 HTTP `/preview/<id>/live.ts` 由 mpegts.js 播放。
