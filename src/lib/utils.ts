import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { DiscordInfo } from "@/types";

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

// ── Discord URL Parser ──────────────────────────────────────────────────────────────

const DISCORD_EPOCH = 1420070400000; // 2015-01-01T00:00:00.000Z in ms

function snowflakeToTimestamp(snowflake: string): number | undefined {
  try {
    const id = BigInt(snowflake);
    const ms = Number(id >> 22n) + DISCORD_EPOCH;
    // Sanity: Discord launched 2015, reject obviously wrong values
    const year = new Date(ms).getFullYear();
    if (year < 2015 || year > 2030) return undefined;
    return ms;
  } catch {
    return undefined;
  }
}

export function parseDiscordUrl(url: string): DiscordInfo | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    if (host !== 'cdn.discordapp.com' && host !== 'media.discordapp.net') {
      return null;
    }

    const isMediaProxy = host === 'media.discordapp.net';
    const segments = parsed.pathname.split('/').filter(Boolean);

    // Parse signed-URL query params
    const exHex = parsed.searchParams.get('ex');
    const isHex = parsed.searchParams.get('is');
    const expiresAt = exHex ? parseInt(exHex, 16) * 1000 : undefined;
    const issuedAt = isHex ? parseInt(isHex, 16) * 1000 : undefined;

    // Build clean URL (strip HMAC signature)
    const cleanParams = new URLSearchParams(parsed.searchParams);
    cleanParams.delete('hm');
    const qStr = cleanParams.toString();
    const cleanUrl = `${parsed.origin}${parsed.pathname}${qStr ? '?' + qStr : ''}`;

    // /attachments/{channel_id}/{attachment_id}/{filename}
    // /ephemeral-attachments/{channel_id}/{attachment_id}/{filename}
    if (segments[0] === 'attachments' || segments[0] === 'ephemeral-attachments') {
      const channelId = segments[1];
      const attachmentId = segments[2];
      const filename = segments[3] ? decodeURIComponent(segments[3]) : undefined;
      return {
        type: segments[0] === 'ephemeral-attachments' ? 'ephemeral_attachment' : 'attachment',
        filename,
        channelId,
        resourceId: attachmentId,
        uploadedAt: attachmentId ? snowflakeToTimestamp(attachmentId) : undefined,
        channelCreatedAt: channelId ? snowflakeToTimestamp(channelId) : undefined,
        expiresAt,
        issuedAt,
        isMediaProxy,
        cleanUrl,
      };
    }

    // /avatars/{user_id}/{hash}.ext
    if (segments[0] === 'avatars') {
      const userId = segments[1];
      return {
        type: 'avatar',
        userId,
        resourceId: userId,
        uploadedAt: userId ? snowflakeToTimestamp(userId) : undefined,
        isMediaProxy,
        cleanUrl,
      };
    }

    // /emojis/{emoji_id}.ext
    if (segments[0] === 'emojis') {
      const emojiId = segments[1]?.split('.')[0];
      return {
        type: 'emoji',
        resourceId: emojiId,
        uploadedAt: emojiId ? snowflakeToTimestamp(emojiId) : undefined,
        isMediaProxy,
        cleanUrl,
      };
    }

    // /stickers/{sticker_id}.ext
    if (segments[0] === 'stickers') {
      const stickerId = segments[1]?.split('.')[0];
      return {
        type: 'sticker',
        resourceId: stickerId,
        uploadedAt: stickerId ? snowflakeToTimestamp(stickerId) : undefined,
        isMediaProxy,
        cleanUrl,
      };
    }

    // /external/{encoded_path}
    if (segments[0] === 'external') {
      return { type: 'external_proxy', isMediaProxy: true, cleanUrl };
    }

    // Other Discord CDN URL
    return { type: 'other', isMediaProxy, cleanUrl };
  } catch {
    return null;
  }
}
