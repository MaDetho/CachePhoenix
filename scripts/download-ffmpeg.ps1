<# Downloads platform-specific ffmpeg/ffprobe binaries for local Tauri development. #>
$ErrorActionPreference = "Stop"

$BINARIES_DIR = "src-tauri\binaries"
$TARGET = "x86_64-pc-windows-msvc"

if (!(Test-Path $BINARIES_DIR)) {
    New-Item -ItemType Directory -Path $BINARIES_DIR | Out-Null
}

Write-Host "Downloading ffmpeg for Windows ($TARGET)..."
$url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip"
$zipPath = "$env:TEMP\ffmpeg.zip"
$extractPath = "$env:TEMP\ffmpeg-extracted"

Invoke-WebRequest -Uri $url -OutFile $zipPath
if (Test-Path $extractPath) { Remove-Item -Recurse -Force $extractPath }
Expand-Archive $zipPath -DestinationPath $extractPath

$dir = Get-ChildItem $extractPath -Directory | Select-Object -First 1
Copy-Item "$($dir.FullName)\bin\ffmpeg.exe"  "$BINARIES_DIR\ffmpeg-$TARGET.exe"
Copy-Item "$($dir.FullName)\bin\ffprobe.exe" "$BINARIES_DIR\ffprobe-$TARGET.exe"

Remove-Item -Recurse -Force $zipPath, $extractPath

Write-Host ""
Write-Host "Sidecar binaries installed:"
Get-ChildItem $BINARIES_DIR
Write-Host ""
Write-Host "Ready to run: bun tauri dev"
