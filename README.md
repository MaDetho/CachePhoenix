# CachePhoenix 🔥

Recover media files from Chromium-based browser caches — including videos, images, and audio. Works with Discord, Chrome, Brave, Edge, Opera, and any custom cache folder.

Built with [Tauri v2](https://v2.tauri.app/), React, and Rust. Runs natively on Windows, macOS, and Linux.

---

## Features

- **Auto-detect browser installations** — Automatically finds cache folders for Discord (Stable, PTB, Canary, Development), Chrome, Brave, Edge, and Opera
- **Chunked video reconstruction** — Reassembles MP4 videos split across multiple 1MB Chromium cache chunks, including out-of-order and gapped downloads
- **Live thumbnail previews** — Generates preview thumbnails for scanned media directly in the app
- **Format support** — Recovers MP4, WebM, PNG, JPEG, GIF, WebP, AVI, and audio files
- **WebM/GIF to MP4 conversion** — Optionally converts recovered WebM and GIF files to MP4
- **Organize by type** — Automatically sorts recovered files into subfolders by media type
- **Scan state preservation** — Navigate between pages without losing your scan progress
- **Sort & filter** — Filter results by type and sort by date (newest first by default)
- **Custom output folder** — Choose where to save recovered files (defaults to `~/CachePhoenix`)

---

## Download

Download the latest release for your platform from the [Releases](https://github.com/MaDetho/CachePhoenix/releases) page.

| Platform | Download |
|----------|----------|
| Windows  | `.msi` or `.exe` installer |
| macOS    | `.dmg` |
| Linux    | `.deb` or `.AppImage` |

> **Note:** ffmpeg and ffprobe are bundled with the application — no separate installation required.

### macOS Users
If you get a message saying the app is damaged or can't be opened, run this command in your terminal:
```bash
sudo xattr -rd com.apple.quarantine /Applications/CachePhoenix.app
```

---

## How to Use

1. **Launch the app** and it will auto-detect your browser cache folders (Discord, Chrome, Brave, Edge, Opera)
2. **Select a cache source** — pick one or more detected installations, or add a custom folder
3. **Start the scan** — the app analyzes every cache file, identifies media types, groups video chunks, and generates thumbnails
4. **Review results** — browse recovered media with previews, filter by type, sort by date, and select what to recover
5. **Configure recovery** — choose an output folder and processing options (organize by type, convert formats, generate thumbnails)
6. **Recover** — selected files are reconstructed and saved to your chosen folder

---

## Where Are Cache Files?

Chromium-based browsers store an HTTP disk cache. Common locations:

| Browser | Windows | macOS | Linux |
|---------|---------|-------|-------|
| Discord | `%APPDATA%\discord\Cache\Cache_Data\` | `~/Library/Application Support/discord/Cache/Cache_Data/` | `~/.config/discord/Cache/Cache_Data/` |
| Chrome | `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Cache\Cache_Data\` | `~/Library/Caches/Google/Chrome/Default/Cache/` | `~/.cache/google-chrome/Default/Cache/` |
| Brave | `%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data\Default\Cache\Cache_Data\` | `~/Library/Caches/BraveSoftware/Brave-Browser/Default/Cache/` | `~/.cache/BraveSoftware/Brave-Browser/Default/Cache/` |
| Edge | `%LOCALAPPDATA%\Microsoft\Edge\User Data\Default\Cache\Cache_Data\` | `~/Library/Caches/Microsoft Edge/Default/Cache/` | `~/.cache/microsoft-edge/Default/Cache/` |
| Opera | `%APPDATA%\Opera Software\Opera Stable\Cache\Cache_Data\` | `~/Library/Caches/com.operasoftware.Opera/Cache/` | `~/.cache/opera/Cache/` |

Replace `discord` with `discordptb`, `discordcanary`, or `discorddevelopment` for other Discord builds. Multi-profile browsers (Chrome, Brave, Edge) also scan `Profile 1`, `Profile 2`, etc.

> **Tip:** Cache files are evicted over time. The sooner you scan after content is viewed, the better your chances of recovery.

---

## How It Works

### The Problem

When you view media in a Chromium-based browser, the disk cache stores the downloaded data. Older Chromium versions use **Blockfile** format with files named `f_XXXXXX` (hex-numbered). Newer versions use **Simple Cache** format with files named `{16hex}_0`. Large files may be split into **1MB chunks**, each as a separate file with no extension. You can't just rename these files — they need to be properly reassembled.

### The Solution

CachePhoenix:

1. **Identifies files** by reading magic bytes (file signatures) from each cache file
2. **Groups chunks** by detecting hex-sequential filenames belonging to the same original file
3. **Reconstructs videos** by placing chunks in the correct order, zero-filling gaps from missing chunks, and locating the `moov` atom (MP4 metadata) needed for playback
4. **Handles Chromium's download order** — Chromium downloads the start and end of a file first (for streaming + metadata access), then fills the middle. The app accounts for this non-sequential pattern.

### Supported Formats

| Format | Recovery | Notes |
|--------|----------|-------|
| MP4 (H.264/H.265) | Full reconstruction | Handles chunked and complete files |
| WebM/MKV (VP8/VP9) | Direct copy or convert to MP4 | Optional conversion |
| PNG | Direct copy | |
| JPEG | Direct copy | |
| GIF | Direct copy or convert to MP4 | Optional conversion |
| WebP | Direct copy | |
| AVI | Direct copy | |

---

## Limitations

- **Missing chunks = visual artifacts.** Gaps in the video produce corrupted frames. These are zero-filled during reconstruction.
- **Fully evicted cache = no recovery.** If a browser's cache has rotated out the files, they're gone.
- **Encrypted or DRM content** cannot be recovered through cache.
- **Supports both Chromium cache formats** — Blockfile (`f_XXXXXX`) and Simple Cache (`{hex}_0`) are both handled automatically.

---

## Development

### Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (latest stable)
- [Bun](https://bun.sh/) (or Node.js)
- [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform

### Setup

```bash
git clone https://github.com/MaDetho/CachePhoenix.git
cd CachePhoenix
bun install
```

### Development

```bash
bun run tauri dev
```

### Build

```bash
bun run tauri build
```

The built installer will be in `src-tauri/target/release/bundle/`.

### ffmpeg/ffprobe Sidecars

The app bundles ffmpeg and ffprobe as [Tauri sidecar binaries](https://v2.tauri.app/develop/sidecar/). Place the platform-appropriate binaries in `src-tauri/binaries/` before building:

- `ffmpeg-x86_64-pc-windows-msvc.exe` / `ffprobe-x86_64-pc-windows-msvc.exe` (Windows)
- `ffmpeg-x86_64-unknown-linux-gnu` / `ffprobe-x86_64-unknown-linux-gnu` (Linux)
- `ffmpeg-aarch64-apple-darwin` / `ffprobe-aarch64-apple-darwin` (macOS ARM)
- `ffmpeg-x86_64-apple-darwin` / `ffprobe-x86_64-apple-darwin` (macOS Intel)

### Tech Stack

- **Frontend:** React 19, TypeScript, Tailwind CSS 4, Zustand
- **Backend:** Rust (Tauri v2)
- **Media Processing:** ffmpeg/ffprobe (bundled sidecars)
- **Storage:** IndexedDB (thumbnail cache)

---

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

---

## Author

Created by [MaDetho](https://github.com/MaDetho)
