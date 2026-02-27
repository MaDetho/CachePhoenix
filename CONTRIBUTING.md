# Contributing to CachePhoenix

I'm happy you're interested in helping with CachePhoenix. Keeping the tool reliable and useful for everyone is a community effort.

## Reporting Bugs

If you find a bug, please open a GitHub Issue. Be sure to include:
- Your operating system and version.
- Steps to reproduce the issue.
- Which browser cache you were trying to scan.
- Any error messages you saw.

## Suggesting Features

Feature requests are always welcome. Open an issue and describe what you'd like to see and how it would help other users.

## Development Setup

### Prerequisites
- [Rust](https://www.rust-lang.org/tools/install) (latest stable)
- [Bun](https://bun.sh/)
- [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform

### Running Locally
1. Install dependencies:
   ```bash
   bun install
   ```
2. Run the development server:
   ```bash
   bun run tauri dev
   ```

### ffmpeg Sidecar Setup
CachePhoenix requires ffmpeg and ffprobe sidecars for media processing. Run the provided script to download the correct binaries for your platform:
- Windows: `scripts/download-ffmpeg.ps1`
- macOS/Linux: `scripts/download-ffmpeg.sh`

## Pull Request Guidelines

- Use a descriptive title that summarizes the change.
- Explain the "what" and "why" of your changes in the PR description.
- Keep PRs focused. One feature or fix per PR is best.
- Follow the existing code style.
- Ensure TypeScript passes strict mode checks.
- Rust code should be compatible with the latest stable version.

Thank you for contributing!
