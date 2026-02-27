import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function getMediaCategory(fileType: string): "image" | "video" | "audio" | "other" {
  switch (fileType) {
    // ── Images ──────────────────────────────────────────────────────────────
    case "png":
    case "jpeg":
    case "gif":
    case "webp":
    case "bmp":
    case "tiff":
    case "ico":
    case "avif":
    case "heic":
      return "image";
    // ── Video ───────────────────────────────────────────────────────────────
    case "mp4_complete":
    case "mp4_chunked":
    case "mp4_header_only":
    case "webm_mkv":
    case "avi":
    case "flv":
    case "mpeg_ts":
    case "wmv":
    case "mov":
    case "mp4_fragment":
    case "webm_continuation":
      return "video";
    // ── Audio ───────────────────────────────────────────────────────────────
    case "mp3":
    case "aac":
    case "ogg":
    case "flac":
    case "wav":
    case "opus":
    case "wma":
    case "m4a":
      return "audio";
    default:
      return "other";
  }
}

export function getFileExtension(fileType: string): string {
  switch (fileType) {
    // ── Images ──────────────────────────────────────────────────────────────
    case "png": return ".png";
    case "jpeg": return ".jpg";
    case "gif": return ".gif";
    case "webp": return ".webp";
    case "bmp": return ".bmp";
    case "tiff": return ".tiff";
    case "ico": return ".ico";
    case "avif": return ".avif";
    case "heic": return ".heic";
    // ── Video ───────────────────────────────────────────────────────────────
    case "mp4_complete":
    case "mp4_chunked":
    case "mp4_header_only":
      return ".mp4";
    case "mp4_fragment": return ".mp4";
    case "webm_mkv": return ".webm";
    case "webm_continuation": return ".webm";
    case "avi": return ".avi";
    case "flv": return ".flv";
    case "mpeg_ts": return ".ts";
    case "wmv": return ".wmv";
    case "mov": return ".mov";
    // ── Audio ───────────────────────────────────────────────────────────────
    case "mp3": return ".mp3";
    case "aac": return ".aac";
    case "ogg": return ".ogg";
    case "flac": return ".flac";
    case "wav": return ".wav";
    case "opus": return ".opus";
    case "wma": return ".wma";
    case "m4a": return ".m4a";
    default: return ".bin";
  }
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
