import { invoke } from "@tauri-apps/api/core";
import type { CacheResource, RecoveryOptions, RecoveryProgress } from "@/types";
import { getFileExtension } from "@/lib/utils";
import {
  ffmpegReEncode,
  ffmpegRemux,
  ffmpegConcat,
  generateThumbnail,
  convertGifToMp4,
} from "@/lib/ffmpeg";

export async function recoverResources(
  resources: CacheResource[],
  options: RecoveryOptions,
  onProgress: (progress: RecoveryProgress) => void,
): Promise<void> {
  const total = resources.length;
  const log: string[] = [];
  const errors: string[] = [];

  const addLog = (msg: string) => {
    log.push(msg);
    notifyProgress();
  };

  let lastProgressUpdate = 0;
  const THROTTLE_MS = 150;

  const notifyProgress = () => {
    const now = Date.now();
    if (now - lastProgressUpdate < THROTTLE_MS) return;
    lastProgressUpdate = now;
    onProgress({
      current: 0, total, currentFile: "",
      phase: "copying", log: [...log], errors: [...errors],
    });
  };

  const flushProgress = () => {
    lastProgressUpdate = 0;
    onProgress({
      current: 0, total, currentFile: "",
      phase: "copying", log: [...log], errors: [...errors],
    });
  };

  await invoke("write_file_bytes", {
    path: options.outputFolder + "/.cachephoenix_marker",
    data: Array.from(new TextEncoder().encode("CachePhoenix output")),
  });

  for (let i = 0; i < resources.length; i++) {
    const resource = resources[i];
    const ext = getFileExtension(resource.resourceType);
    const baseName = `${resource.displayName.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

    let subFolder = options.outputFolder;
    if (options.organizeByType) {
      const typeFolder = resource.mediaCategory === "image" ? "images"
        : resource.mediaCategory === "video" ? "videos"
        : resource.mediaCategory === "audio" ? "audio"
        : "other";
      subFolder = `${options.outputFolder}/${typeFolder}`;
    }

    const outputPath = `${subFolder}/${baseName}${ext}`;

    onProgress({
      current: i + 1, total,
      currentFile: resource.displayName,
      phase: "copying",
      log: [...log], errors: [...errors],
    });

    try {
      if (resource.resourceType === "mp4_complete" ||
          // ── Images ──────────────────────────────────────────────────────────
          resource.resourceType === "png" ||
          resource.resourceType === "jpeg" ||
          resource.resourceType === "gif" ||
          resource.resourceType === "webp" ||
          resource.resourceType === "bmp" ||
          resource.resourceType === "tiff" ||
          resource.resourceType === "ico" ||
          resource.resourceType === "avif" ||
          resource.resourceType === "heic" ||
          // ── Video (single-file) ──────────────────────────────────────────────
          resource.resourceType === "avi" ||
          resource.resourceType === "flv" ||
          resource.resourceType === "mpeg_ts" ||
          resource.resourceType === "wmv" ||
          resource.resourceType === "mov" ||
          // ── New resource types (Simple Cache / fragment detection) ─────────
          resource.resourceType === "mp4_header_only" ||
          resource.resourceType === "mp4_fragment" ||
          resource.resourceType === "webm_continuation" ||
          resource.resourceType === "media_data_chunk" ||
          resource.resourceType === "riff_unknown" ||
          // ── Audio ────────────────────────────────────────────────────────────
          resource.resourceType === "mp3" ||
          resource.resourceType === "aac" ||
          resource.resourceType === "ogg" ||
          resource.resourceType === "flac" ||
          resource.resourceType === "wav" ||
          resource.resourceType === "opus" ||
          resource.resourceType === "wma" ||
          resource.resourceType === "m4a") {
        addLog(`Copying ${resource.displayName}...`);
        // _s files are Chromium Simple Cache sparse files (HTTP 206 range data on macOS).
        // They must be reassembled via copy_sparse_file rather than copied raw.
        const isSparseSource = /[0-9a-f]{16}_s$/.test(resource.files[0].path);
        if (isSparseSource) {
          await invoke("copy_sparse_file", {
            src: resource.files[0].path,
            dst: outputPath,
          });
        } else {
          await invoke("copy_file", {
            src: resource.files[0].path,
            dst: outputPath,
          });
        }
        addLog(`  -> ${outputPath}`);

        // Re-mux ALL recovered videos through ffmpeg with error tolerance.
        // Cache-extracted video data (both sparse _s and regular _0) often has
        // structural issues (truncated mdat, wrong box sizes, partial downloads)
        // that ffmpeg's error-tolerance flags can repair for playback.
        if (resource.mediaCategory === "video") {
          const remuxedPath = outputPath.replace(/\.([^.]+)$/, "_remuxed.$1");
          addLog(`  Re-encoding video for playability...`);
          const remuxOk = await ffmpegReEncode(outputPath, remuxedPath);
          if (remuxOk) {
            try {
              const { remove, rename } = await import("@tauri-apps/plugin-fs");
              await remove(outputPath);
              await rename(remuxedPath, outputPath);
              addLog(`  Re-encode successful`);
              // Defensive: strip duplicate moov boxes that can occur if ffmpeg's
              // +faststart pass is interrupted or the process runs twice.
              const moovCount: number = await invoke("fix_mp4_moov", { path: outputPath });
              if (moovCount > 1) {
                addLog(`  Fixed ${moovCount} moov boxes (stripped duplicates)`);
              }
            } catch { /* keep remuxed file as-is */ }
          } else {
            // Re-encode failed — keep original copy (may still partially play)
            try {
              const { remove } = await import("@tauri-apps/plugin-fs");
              await remove(remuxedPath);
            } catch { /* best effort */ }
            addLog(`  Re-encode failed, keeping raw copy`);
          }
        }

        if (resource.resourceType === "gif" && options.convertGifToMp4) {
          const mp4Path = outputPath.replace(/\.gif$/i, "_converted.mp4");
          addLog(`  Converting GIF to MP4...`);
          const success = await convertGifToMp4(outputPath, mp4Path);
          if (success) addLog(`  -> ${mp4Path}`);
          else errors.push(`Failed to convert GIF: ${resource.displayName}`);
        }

        if (resource.mediaCategory === "video" && options.generateThumbnails) {
          const thumbPath = outputPath.replace(/\.[^.]+$/, "_thumb.jpg");
          await generateThumbnail(outputPath, thumbPath);
        }
      } else if (resource.resourceType === "mp4_chunked") {
        addLog(`Reconstructing chunked MP4: ${resource.displayName} (${resource.files.length} chunks)...`);
        onProgress({
          current: i + 1, total,
          currentFile: resource.displayName,
          phase: "reconstructing",
          log: [...log], errors: [...errors],
        });
        const headerPath = resource.files[0].path;
        const chunkPaths = resource.files.slice(1).map((f) => f.path);
        const totalBytes: number = await invoke("reconstruct_chunked_mp4", {
          headerPath,
          chunkPaths,
          output: outputPath,
        });
        addLog(`  Raw reconstruction: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);

        // Remux (stream-copy) reconstructed MP4 through ffmpeg to fix container structure.
        // IMPORTANT: use remux (-c copy) NOT re-encode for chunked files.
        // Re-encoding causes ffmpeg to silently truncate at zero-filled gap regions.
        const remuxedPath = outputPath.replace(/\.([^.]+)$/, "_remuxed.$1");
        addLog(`  Re-muxing for playability...`);
        const remuxOk = await ffmpegRemux(outputPath, remuxedPath);
        if (remuxOk) {
          try {
            const { remove, rename } = await import("@tauri-apps/plugin-fs");
            await remove(outputPath);
            await rename(remuxedPath, outputPath);
            addLog(`  Re-mux successful`);
            // Defensive: strip duplicate moov boxes that can occur if ffmpeg's
            // +faststart pass is interrupted or the process runs twice.
            const moovCount: number = await invoke("fix_mp4_moov", { path: outputPath });
            if (moovCount > 1) {
              addLog(`  Fixed ${moovCount} moov boxes (stripped duplicates)`);
            }
          } catch { /* keep remuxed file as-is */ }
        } else {
          try {
            const { remove } = await import("@tauri-apps/plugin-fs");
            await remove(remuxedPath);
          } catch { /* best effort */ }
          addLog(`  Re-mux failed, keeping raw reconstruction`);
        }

        addLog(`  -> ${outputPath}`);
        if (options.generateThumbnails) {
          const thumbPath = outputPath.replace(/\.[^.]+$/, "_thumb.jpg");
          await generateThumbnail(outputPath, thumbPath);
        }
      } else if (resource.resourceType === "webm_mkv") {
        addLog(`Recovering WebM/MKV: ${resource.displayName}...`);
        const rawPath = outputPath.replace(/\.webm$/i, "_raw.webm");

        const chunkPaths = resource.files.map((f) => f.path);
        await invoke("concat_files", { paths: chunkPaths, output: rawPath });

        const mp4OutputPath = options.convertWebmToMp4
          ? outputPath.replace(/\.webm$/i, ".mp4")
          : outputPath;

        let webmSuccess = false;
        try {
          webmSuccess = await ffmpegReEncode(rawPath, mp4OutputPath, (line) => {
            if (line.includes("frame=") || line.includes("time=")) {
              const logIdx = log.findIndex((l) => l.startsWith("  ffmpeg: "));
              if (logIdx !== -1) {
                log[logIdx] = `  ffmpeg: ${line.trim()}`;
              } else {
                log.push(`  ffmpeg: ${line.trim()}`);
              }
              notifyProgress();
            }
          });
        } finally {
          // Always clean up _raw.webm temp file, even on failure
          try {
            const { remove } = await import("@tauri-apps/plugin-fs");
            await remove(rawPath);
          } catch { /* best effort */ }
        }

        if (webmSuccess) {
          addLog(`  -> ${mp4OutputPath}`);
        } else {
          errors.push(`Failed to recover WebM: ${resource.displayName}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const src = resource.files[0]?.path ?? 'unknown';
      // Detect macOS TCC permission errors and give actionable guidance
      const isPermissionDenied = /permission denied|os error 13|EACCES/i.test(msg);
      const userMsg = isPermissionDenied
        ? `${resource.displayName}: Permission denied — grant Full Disk Access in System Settings > Privacy & Security (src: ${src})`
        : `${resource.displayName}: ${msg} (src: ${src}, dst: ${outputPath})`;
      errors.push(userMsg);
      addLog(`  ERROR: ${msg}`);
      addLog(`    Source: ${src}`);
      addLog(`    Destination: ${outputPath}`);
      if (isPermissionDenied) {
        addLog(`    → Fix: System Settings > Privacy & Security > Full Disk Access > enable CachePhoenix`);
      }
    }

    flushProgress();
  }

  // ── Concatenate selected videos (optional) ───────────────────────────────
  if (options.concatenateVideos) {
    // Collect all successfully recovered video output paths
    const videoPaths: { path: string; modifiedAt: number }[] = [];
    for (const resource of resources) {
      if (resource.mediaCategory !== "video") continue;
      const ext = getFileExtension(resource.resourceType);
      const baseName = resource.displayName.replace(/[^a-zA-Z0-9_-]/g, "_");
      let subFolder = options.outputFolder;
      if (options.organizeByType) {
        subFolder = `${options.outputFolder}/videos`;
      }
      const filePath = `${subFolder}/${baseName}${ext}`;
      // Only include if file was not in the error list
      const wasError = errors.some((e) => e.includes(resource.displayName));
      if (!wasError) {
        videoPaths.push({
          path: filePath,
          modifiedAt: resource.modifiedAt ?? 0,
        });
      }
    }

    if (videoPaths.length >= 2) {
      // Sort by timestamp (chronological order)
      videoPaths.sort((a, b) => a.modifiedAt - b.modifiedAt);

      const concatFolder = options.organizeByType
        ? `${options.outputFolder}/videos`
        : options.outputFolder;
      const concatOutput = `${concatFolder}/Concatenated_Video.mp4`;

      addLog(`Concatenating ${videoPaths.length} videos...`);
      onProgress({
        current: total, total,
        currentFile: "Concatenating videos...",
        phase: "copying",
        log: [...log], errors: [...errors],
      });

      const concatOk = await ffmpegConcat(
        videoPaths.map((v) => v.path),
        concatOutput,
        (line) => {
          if (line.includes("frame=") || line.includes("time=")) {
            const logIdx = log.findIndex((l) => l.startsWith("  ffmpeg concat: "));
            if (logIdx !== -1) {
              log[logIdx] = `  ffmpeg concat: ${line.trim()}`;
            } else {
              log.push(`  ffmpeg concat: ${line.trim()}`);
            }
            notifyProgress();
          }
        },
      );

      if (concatOk) {
        addLog(`  -> ${concatOutput}`);
      } else {
        errors.push("Failed to concatenate videos");
        addLog("  Concatenation failed");
      }
    } else if (videoPaths.length === 1) {
      addLog("Skipping concatenation: only 1 video recovered");
    } else {
      addLog("Skipping concatenation: no videos recovered successfully");
    }
  }

  onProgress({
    current: total, total,
    currentFile: "",
    phase: "complete",
    log: [...log], errors: [...errors],
  });
}
