# Bundled FFmpeg

Navora Monitor ships platform-specific **GPL** FFmpeg builds from
[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (not committed to git).

| Directory | Binary | Electron target |
|-----------|--------|-----------------|
| `win-x64/` | `ffmpeg.exe` | Windows x64 |
| `win-arm64/` | `ffmpeg.exe` | Windows ARM64 |
| `linux-x64/` | `ffmpeg` | Linux x64 |
| `linux-arm64/` | `ffmpeg` | Linux ARM64 |
| `win64/` | legacy alias of `win-x64` | — |

## Fetch

```bash
# Current machine only
npm run ffmpeg:fetch

# Everything needed for dist:all
npm run ffmpeg:fetch:all

# Specific targets
npm run ffmpeg:fetch -- win-x64 win-arm64
npm run ffmpeg:fetch -- linux-x64 linux-arm64

# Re-download
npm run ffmpeg:fetch -- --force win-x64
```

Each folder should contain the binary plus `LICENSE.txt` from upstream.
Packaging copies the matching folder into `resources/ffmpeg/` via `scripts/pack.mjs`.
