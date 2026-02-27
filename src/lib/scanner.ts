import { invoke } from "@tauri-apps/api/core";
import type { CacheFileEntry, CacheResource, FileType, VideoInfo } from "@/types";
import { generateId, getMediaCategory } from "@/lib/utils";
import { generateThumbnail as ffmpegThumbnail, ffmpegHealthCheck } from "@/lib/ffmpeg";
import { tempDir } from "@tauri-apps/api/path";
import { getCachedThumbnail, setCachedThumbnail } from "@/lib/thumbnailCache";

// ─── Signature Detection ────────────────────────────────────────────────────
//
// NOTE: For Simple Cache files ('_0' suffix) the Rust backend already strips
// the 24-byte SimpleFileHeader + key so that read_file_header() returns the
// first bytes of the actual HTTP body.  All offsets below are therefore
// relative to the HTTP body start, NOT the raw file start.
//
// Special cases handled below:
//   RIFF container  -> check bytes [8..12] to distinguish WAV / AVI / WEBP
//   ISO BMFF (ftyp) -> box-size at [0..4], type at [4..8]; major brand at [8..12]
//   MPEG-TS         -> sync byte 0x47 must repeat at +188
//   MP3 sync frame  -> 0xFF 0xE? or 0xFF 0xF? with valid layer/version bits
//   ID3-tagged MP3  -> starts with "ID3" tag

const SIGNATURES: Array<{
  bytes: number[];
  mask?: number[];
  offset: number;
  type: string;
}> = [
  // ── Images ────────────────────────────────────────────────────────────────
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], offset: 0, type: "png" },
  { bytes: [0xff, 0xd8, 0xff], offset: 0, type: "jpeg" },
  { bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], offset: 0, type: "gif" },
  { bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], offset: 0, type: "gif" },
  { bytes: [0x42, 0x4d], offset: 0, type: "bmp" },                        // BM
  { bytes: [0x49, 0x49, 0x2a, 0x00], offset: 0, type: "tiff" },           // TIFF LE
  { bytes: [0x4d, 0x4d, 0x00, 0x2a], offset: 0, type: "tiff" },           // TIFF BE
  { bytes: [0x00, 0x00, 0x01, 0x00], offset: 0, type: "ico" },             // ICO
  // ── RIFF container: WAV, AVI, WebP (resolved in detectFileType) ───────────
  { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0, type: "riff" },
  // ── Video ─────────────────────────────────────────────────────────────────
  { bytes: [0x1a, 0x45, 0xdf, 0xa3], offset: 0, type: "webm_mkv" },       // EBML
  { bytes: [0x46, 0x4c, 0x56, 0x01], offset: 0, type: "flv" },            // FLV
  { bytes: [0x47], offset: 0, type: "mpeg_ts_candidate" },                 // 0x47 – needs repeat check
  // ── Audio ─────────────────────────────────────────────────────────────────
  { bytes: [0x49, 0x44, 0x33], offset: 0, type: "mp3" },                  // ID3 tag
  { bytes: [0xff, 0xfb], offset: 0, type: "mp3" },                        // MPEG-1 Layer3 CBR
  { bytes: [0xff, 0xf3], offset: 0, type: "mp3" },                        // MPEG-2 Layer3
  { bytes: [0xff, 0xf2], offset: 0, type: "mp3" },                        // MPEG-2.5 Layer3
  { bytes: [0xff, 0xfe], offset: 0, type: "mp3" },                        // MPEG-1 Layer3 free
  { bytes: [0x4f, 0x67, 0x67, 0x53], offset: 0, type: "ogg" },            // OggS
  { bytes: [0x66, 0x4c, 0x61, 0x43], offset: 0, type: "flac" },           // fLaC
  { bytes: [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11,
            0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c], offset: 0, type: "wma" }, // ASF/WMA
];

// ADTS AAC frame sync: 0xFFF? or 0xFFE? (12-bit syncword 0xFFF, profile-dependent)
// We check for the 12 sync bits explicitly.
function isAdtsAac(h: Uint8Array): boolean {
  if (h.length < 2) return false;
  // Sync word: first 12 bits all set (0xFFF) — byte[0]=0xFF, byte[1] bits7-4 = 0xF
  return h[0] === 0xff && (h[1] & 0xf0) === 0xf0 && (h[1] & 0x06) !== 0x00; // layer ≠ 11 means AAC
}

// MPEG-TS: 0x47 sync byte repeats at intervals of 188, 192, or 204 bytes.
function isMpegTs(h: Uint8Array): boolean {
  if (h.length < 188 + 1) return false;
  return h[0] === 0x47 && h[188] === 0x47;
}

export function detectFileType(header: Uint8Array): FileType | null {
  // ── Signature table scan ─────────────────────────────────────────────────
  for (const sig of SIGNATURES) {
    if (header.length < sig.offset + sig.bytes.length) continue;
    let match = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      const expected = sig.bytes[i];
      const actual = header[sig.offset + i];
      if (sig.mask) {
        if ((actual & sig.mask[i]) !== expected) { match = false; break; }
      } else {
        if (actual !== expected) { match = false; break; }
      }
    }
    if (!match) continue;

    // ── RIFF disambiguation ─────────────────────────────────────────────────
    if (sig.type === "riff") {
      if (header.length >= 12) {
        const sub = String.fromCharCode(header[8], header[9], header[10], header[11]);
        if (sub === "WEBP") return "webp";
        if (sub === "AVI ") return "avi";
        if (sub === "WAVE") return "wav";
      }
      return "riff_unknown";
    }

    // ── MPEG-TS second-sync check ────────────────────────────────────────────
    if (sig.type === "mpeg_ts_candidate") {
      return isMpegTs(header) ? "mpeg_ts" : null;
    }

    return sig.type as FileType;
  }

  // ── ADTS AAC (must come BEFORE the generic 0xFF checks above) ────────────
  if (isAdtsAac(header)) return "aac";

  // ── ISO Base Media File Format (MP4 / MOV / M4A / AVIF / HEIC) ───────────
  // The box size is at bytes [0..4] (big-endian), the type at [4..8].
  // The major brand is at [8..12].
  if (header.length >= 12) {
    const boxSize = (header[0] << 24) | (header[1] << 16) | (header[2] << 8) | header[3];
    const boxType = String.fromCharCode(header[4], header[5], header[6], header[7]);
    if (boxType === "ftyp" && boxSize >= 8 && boxSize <= 512) {
      const brand = String.fromCharCode(header[8], header[9], header[10], header[11]).trim();
      // AVIF / HEIF brands
      if (brand === "avif" || brand === "avis") return "avif";
      if (brand === "heic" || brand === "hevc" || brand === "mif1" || brand === "msf1") return "heic";
      // M4A / audio-only MPEG-4
      if (brand === "M4A " || brand === "m4a " || brand === "M4B " || brand === "M4P ") return "m4a";
      // QuickTime MOV
      if (brand === "qt  ") return "mov";
      // Generic MP4
      return "mp4_complete"; // will be refined (hasMoov check) later in scanner
    }
  }


  // ── MP4 fragments (moof, styp, sidx, bare mdat — no ftyp) ────────────
  if (header.length >= 8) {
    const fragBoxSize = (header[0] << 24) | (header[1] << 16) | (header[2] << 8) | header[3];
    const fragBoxType = String.fromCharCode(header[4], header[5], header[6], header[7]);
    if (fragBoxSize >= 8 && fragBoxSize <= 50_000_000) {
      if (fragBoxType === "styp" || fragBoxType === "moof" || fragBoxType === "sidx") return "mp4_fragment";
      if (fragBoxType === "mdat") return "mp4_fragment";
    }
  }

  // ── WebM/MKV Cluster continuation (Element ID 0x1F43B675) ──────────────
  if (header.length >= 4 &&
      header[0] === 0x1f && header[1] === 0x43 && header[2] === 0xb6 && header[3] === 0x75) {
    return "webm_continuation";
  }

  return null;
}

interface MP4Box {
  offset: number;
  size: number;
  boxType: string;
  children: MP4Box[];
}

const CONTAINER_BOXES = new Set([
  "moov", "trak", "mdia", "minf", "stbl", "edts", "mvex",
  "dinf", "udta", "moof", "traf", "sinf", "schi",
]);

export function parseMP4Boxes(data: Uint8Array, start = 0, end?: number): MP4Box[] {
  if (end === undefined) end = data.length;
  const boxes: MP4Box[] = [];
  let pos = start;

  while (pos < end - 7) {
    const dv = new DataView(data.buffer, data.byteOffset + pos, Math.min(16, end - pos));
    let boxSize = dv.getUint32(0);
    const boxTypeBytes = data.slice(pos + 4, pos + 8);

    let boxType: string;
    try {
      boxType = String.fromCharCode(...boxTypeBytes);
      if (!/^[\x20-\x7e]{4}$/.test(boxType)) break;
    } catch {
      break;
    }

    let actualSize = boxSize;
    let headerSize = 8;

    if (boxSize === 1) {
      if (pos + 16 > end) break;
      const hi = dv.getUint32(8);
      const lo = dv.getUint32(12);
      actualSize = hi * 0x100000000 + lo;
      headerSize = 16;
    } else if (boxSize === 0) {
      actualSize = end - pos;
    }

    if (actualSize < 8) break;

    const box: MP4Box = { offset: pos, size: actualSize, boxType, children: [] };

    if (CONTAINER_BOXES.has(boxType)) {
      const childEnd = Math.min(pos + actualSize, end);
      box.children = parseMP4Boxes(data, pos + headerSize, childEnd);
    }

    boxes.push(box);
    pos += actualSize;
    if (pos < 0) break;
  }

  return boxes;
}

function findAllBoxes(boxes: MP4Box[], boxType: string): MP4Box[] {
  const result: MP4Box[] = [];
  for (const b of boxes) {
    if (b.boxType === boxType) result.push(b);
    result.push(...findAllBoxes(b.children, boxType));
  }
  return result;
}

export function scanForMoov(data: Uint8Array): Array<{ offset: number; size: number }> {
  const results: Array<{ offset: number; size: number }> = [];
  const moovBytes = [0x6d, 0x6f, 0x6f, 0x76]; // "moov"
  const mvhdBytes = [0x6d, 0x76, 0x68, 0x64]; // "mvhd"
  const trakBytes = [0x74, 0x72, 0x61, 0x6b]; // "trak"

  let searchFrom = 0;
  while (searchFrom < data.length - 4) {
    let idx = -1;
    for (let i = searchFrom; i < data.length - 3; i++) {
      if (data[i] === moovBytes[0] && data[i + 1] === moovBytes[1] &&
          data[i + 2] === moovBytes[2] && data[i + 3] === moovBytes[3]) {
        idx = i;
        break;
      }
    }
    if (idx === -1) break;

    if (idx >= 4) {
      const dv = new DataView(data.buffer, data.byteOffset + idx - 4, 4);
      const boxSize = dv.getUint32(0);
      if (boxSize >= 500 && boxSize <= 2_000_000) {
        const boxEnd = idx - 4 + boxSize;
        if (boxEnd <= data.length) {
          const inner = data.slice(idx - 4, boxEnd);
          const hasMvhd = findBytes(inner, mvhdBytes);
          const hasTrak = findBytes(inner, trakBytes);
          if (hasMvhd && hasTrak) {
            results.push({ offset: idx - 4, size: boxSize });
          }
        }
      }
    }
    searchFrom = idx + 1;
  }

  return results;
}

function findBytes(data: Uint8Array, needle: number[]): boolean {
  for (let i = 0; i <= data.length - needle.length; i++) {
    let found = true;
    for (let j = 0; j < needle.length; j++) {
      if (data[i + j] !== needle[j]) { found = false; break; }
    }
    if (found) return true;
  }
  return false;
}

export function extractVideoInfo(data: Uint8Array, moovOffset: number, moovSize: number): VideoInfo {
  const info: VideoInfo = {
    width: 0, height: 0,
    videoCodec: "", audioCodec: "",
    duration: 0, hasVideo: false, hasAudio: false,
  };

  const moovData = data.slice(moovOffset, moovOffset + moovSize);
  const boxes = parseMP4Boxes(moovData);

  for (const trak of findAllBoxes(boxes, "trak")) {
    const hdlrBoxes = findAllBoxes(trak.children, "hdlr");
    if (hdlrBoxes.length === 0) continue;

    const hdlr = hdlrBoxes[0];
    const htOff = hdlr.offset + 16;
    let handler = "";
    if (htOff + 4 <= moovData.length) {
      handler = String.fromCharCode(
        moovData[htOff], moovData[htOff + 1],
        moovData[htOff + 2], moovData[htOff + 3],
      );
    }

    const stsdBoxes = findAllBoxes(trak.children, "stsd");
    if (stsdBoxes.length > 0) {
      const stsd = stsdBoxes[0];
      const entryOff = stsd.offset + 16;
      if (entryOff + 8 <= moovData.length) {
        const entryType = String.fromCharCode(
          moovData[entryOff + 4], moovData[entryOff + 5],
          moovData[entryOff + 6], moovData[entryOff + 7],
        ).trim();

        if (handler === "vide") {
          info.hasVideo = true;
          info.videoCodec = entryType;
          if (entryOff + 28 <= moovData.length) {
            const dvEntry = new DataView(moovData.buffer, moovData.byteOffset + entryOff, 28);
            info.width = dvEntry.getUint16(24);
            info.height = dvEntry.getUint16(26);
          }
        } else if (handler === "soun") {
          info.hasAudio = true;
          info.audioCodec = entryType;
        }
      }
    }
  }

  const mvhdBoxes = findAllBoxes(boxes, "mvhd");
  if (mvhdBoxes.length > 0) {
    const mvhd = mvhdBoxes[0];
    const version = moovData[mvhd.offset + 8];
    let timescale = 0;
    let duration = 0;

    if (version === 0 && mvhd.offset + 28 <= moovData.length) {
      const dv = new DataView(moovData.buffer, moovData.byteOffset + mvhd.offset, 28);
      timescale = dv.getUint32(20);
      duration = dv.getUint32(24);
    } else if (mvhd.offset + 40 <= moovData.length) {
      const dv = new DataView(moovData.buffer, moovData.byteOffset + mvhd.offset, 40);
      timescale = dv.getUint32(28);
      const hi = dv.getUint32(32);
      const lo = dv.getUint32(36);
      duration = hi * 0x100000000 + lo;
    }

    if (timescale > 0) {
      info.duration = duration / timescale;
    }
  }

  return info;
}

export interface ScanProgress {
  phase: "listing" | "detecting" | "grouping" | "thumbnails" | "done";
  current: number;
  total: number;
  currentFile: string;
}

const MIME_MAP: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  tiff: "image/tiff",
  ico: "image/x-icon",
  avif: "image/avif",
  heic: "image/heic",
};

function arrayBufferToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function generateImageDataUrl(
  filePath: string,
  fileType: FileType,
): Promise<string | undefined> {
  try {
    const mime = MIME_MAP[fileType];
    if (!mime) return undefined;
    const bytes: number[] = await invoke("read_file_bytes", { path: filePath });
    const data = new Uint8Array(bytes);
    const b64 = arrayBufferToBase64(data);
    return `data:${mime};base64,${b64}`;
  } catch {
    return undefined;
  }
}

async function generateVideoDataUrl(
  filePath: string,
): Promise<string | undefined> {
  const tmp = await tempDir();
  const uid = Date.now();
  const cleanPath = `${tmp}dccr_clean_${uid}.bin`;
  const isSparse = /[0-9a-f]{16}_s$/.test(filePath);

  // Step 1: Copy source file to a clean temp file
  try {
    if (isSparse) {
      await invoke("copy_sparse_file", { src: filePath, dst: cleanPath });
    } else {
      await invoke("copy_file", { src: filePath, dst: cleanPath });
    }
  } catch (err) {
    console.warn(`[thumbnail] STEP 1 FAILED (${isSparse ? "copy_sparse_file" : "copy_file"}) for ${filePath}:`, err);
    return undefined;
  }

  // Step 2: Generate thumbnail via ffmpeg sidecar
  const thumbPath = `${tmp}dccr_thumb_${uid}.jpg`;
  try {
    let ok = await ffmpegThumbnail(cleanPath, thumbPath, "00:00:00.500");
    if (!ok) {
      ok = await ffmpegThumbnail(cleanPath, thumbPath, "00:00:00");
    }
    if (!ok) {
      try { const { remove } = await import("@tauri-apps/plugin-fs"); await remove(cleanPath); } catch { /* ignore */ }
      return undefined;
    }
  } catch (err) {
    console.warn(`[thumbnail] STEP 2 FAILED (ffmpeg sidecar) for ${filePath}:`, err);
    try { const { remove } = await import("@tauri-apps/plugin-fs"); await remove(cleanPath); } catch { /* ignore */ }
    return undefined;
  }

  // Step 3: Read generated thumbnail
  try {
    const bytes: number[] = await invoke("read_file_bytes", { path: thumbPath });
    const data = new Uint8Array(bytes);
    const b64 = arrayBufferToBase64(data);
    try {
      const { remove } = await import("@tauri-apps/plugin-fs");
      await remove(thumbPath);
      await remove(cleanPath);
    } catch { /* ignore */ }
    return `data:image/jpeg;base64,${b64}`;
  } catch (err) {
    console.warn(`[thumbnail] STEP 3 FAILED (read thumbnail) for ${filePath}:`, err);
    return undefined;
  }
}

function parseCacheHex(name: string): number | null {
  if (name.length === 8 && name.startsWith("f_")) {
    const num = parseInt(name.slice(2), 16);
    return Number.isNaN(num) ? null : num;
  }
  return null;
}

/** Extract the 16-hex-char hash from a Simple Cache filename (e.g. "170e8695a0c85bd4_0" → "170e8695a0c85bd4"). */
function parseSimpleCacheHash(name: string): { hash: string; stream: string } | null {
  const match = name.match(/^([0-9a-f]{16})_([01s])$/);
  return match ? { hash: match[1], stream: match[2] } : null;
}

async function generateChunkedVideoDataUrl(
  resource: CacheResource,
): Promise<string | undefined> {
  try {
    const tmp = await tempDir();
    const uid = Date.now();
    const isMP4 = resource.resourceType === "mp4_chunked" || resource.resourceType === "mp4_complete" || resource.resourceType === "mp4_header_only" || resource.resourceType === "mp4_fragment";
    const ext = isMP4 ? ".mp4" : ".webm";
    const rawPath = `${tmp}dccr_chunked_${uid}${ext}`;
    const allPaths = resource.files.map((f) => f.path);

    if (isMP4 && allPaths.length >= 2) {
      // Use MP4-specific reconstruction (moov relocation, gap-filling)
      const headerPath = allPaths[0];
      const chunkPaths = allPaths.slice(1);
      await invoke("reconstruct_chunked_mp4", {
        headerPath,
        chunkPaths,
        output: rawPath,
      });
    } else {
      // Generic concatenation for WebM, audio, or single-file MP4 fragments
      await invoke("concat_files", {
        paths: allPaths,
        output: rawPath,
      });
    }
    const dataUrl = await generateVideoDataUrl(rawPath);
    try {
      const { remove } = await import("@tauri-apps/plugin-fs");
      await remove(rawPath);
    } catch { /* ignore */ }
    return dataUrl;
  } catch (err) {
    console.warn(`[thumbnail] generateChunkedVideoDataUrl failed for ${resource.displayName}:`, err);
    return undefined;
  }
}
async function generatePreviewThumbnails(
  resources: CacheResource[],
  onProgress?: (progress: ScanProgress) => void,
): Promise<void> {
  // Pre-flight: auto-fix sidecar permissions (chmod +x, remove quarantine on macOS)
  try {
    const fixResult = await invoke("fix_sidecar_permissions");
    console.log(`[thumbnail] Sidecar permission fix result:`, fixResult);
  } catch (err) {
    console.warn(`[thumbnail] Could not auto-fix sidecar permissions:`, err);
  }

  // Verify ffmpeg sidecar is executable after fix
  const healthCheck = await ffmpegHealthCheck();
  if (!healthCheck.ok) {
    console.error(`[thumbnail] ffmpeg sidecar CANNOT execute after permission fix: ${healthCheck.error}`);
    console.error(`[thumbnail] Skipping ALL video thumbnails. On macOS, run: chmod +x src-tauri/binaries/ffmpeg-* && xattr -d com.apple.quarantine src-tauri/binaries/ffmpeg-*`);
    // Still generate image thumbnails (they don't need ffmpeg)
    const images = resources.filter(r => r.mediaCategory === "image");
    for (let i = 0; i < images.length; i++) {
      const resource = images[i];
      onProgress?.({ phase: "thumbnails", current: i + 1, total: images.length, currentFile: resource.displayName });
      const cacheKey = resource.files[0].path;
      const mtime = Math.max(...resource.files.map(f => f.modified_at ?? 0));
      const cached = await getCachedThumbnail(cacheKey, mtime, resource.totalSize);
      if (cached) { resource.previewUrl = cached; continue; }
      if (resource.files.length === 1) {
        const dataUrl = await generateImageDataUrl(resource.files[0].path, resource.resourceType);
        if (dataUrl) {
          resource.previewUrl = dataUrl;
          await setCachedThumbnail(cacheKey, dataUrl, mtime, resource.totalSize);
        }
      }
    }
    return;
  }
  console.log(`[thumbnail] ffmpeg sidecar OK`);
  const previewable = resources.filter(
    (r) => r.mediaCategory === "image" || r.mediaCategory === "video",
  );
  for (let i = 0; i < previewable.length; i++) {
    const resource = previewable[i];
    const cacheKey = resource.files[0].path;
    const mtime = Math.max(...resource.files.map(f => f.modified_at ?? 0));
    const totalSize = resource.totalSize;
    onProgress?.({
      phase: "thumbnails",
      current: i + 1,
      total: previewable.length,
      currentFile: resource.displayName,
    });

    const cached = await getCachedThumbnail(cacheKey, mtime, totalSize);
    if (cached) {
      resource.previewUrl = cached;
      continue;
    }
    let dataUrl: string | undefined;
    if (resource.files.length === 1) {
      if (resource.mediaCategory === "image") {
        dataUrl = await generateImageDataUrl(resource.files[0].path, resource.resourceType);
      } else if (resource.mediaCategory === "video") {
        dataUrl = await generateVideoDataUrl(resource.files[0].path);
      }
    } else if (resource.mediaCategory === "video") {
      dataUrl = await generateChunkedVideoDataUrl(resource);
    }
    if (dataUrl) {
      resource.previewUrl = dataUrl;
      await setCachedThumbnail(cacheKey, dataUrl, mtime, totalSize);
    }
  }
}


// ─── Content-Type → FileType mapping (fallback for Simple Cache files) ──────
const CONTENT_TYPE_MAP: Record<string, FileType> = {
  // Video
  "video/mp4": "mp4_complete",
  "video/webm": "webm_mkv",
  "video/x-matroska": "webm_mkv",
  "video/x-flv": "flv",
  "video/x-msvideo": "avi",
  "video/quicktime": "mov",
  "video/mp2t": "mpeg_ts",
  // Audio
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/x-ms-wma": "wma",
  // Images
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heic",
};

function mimeToFileType(mime: string): FileType | null {
  return CONTENT_TYPE_MAP[mime] ?? null;
}

export async function scanCacheFolder(
  folderPath: string,
  onProgress?: (progress: ScanProgress) => void,
): Promise<CacheResource[]> {
  onProgress?.({ phase: "listing", current: 0, total: 0, currentFile: "" });

  const files: CacheFileEntry[] = await invoke("list_cache_files", { dir: folderPath });
  const total = files.length;

  if (total === 0) return [];

  const mp4HeaderFiles: Array<{ file: CacheFileEntry; data: Uint8Array }> = [];
  const standaloneFiles: Array<{ file: CacheFileEntry; fileType: FileType }> = [];
  const dataChunkFiles: CacheFileEntry[] = [];
  // ── Phase 1: Partition files into Simple Cache pairs and Blockfile files ──
  const simpleCacheMap = new Map<string, { file0?: CacheFileEntry; file1?: CacheFileEntry; fileS?: CacheFileEntry }>();
  const blockfileFiles: CacheFileEntry[] = [];

  for (const file of files) {
    const parsed = parseSimpleCacheHash(file.name);
    if (parsed) {
      const entry = simpleCacheMap.get(parsed.hash) || {};
      if (parsed.stream === "0") entry.file0 = file;
      else if (parsed.stream === "1") entry.file1 = file;
      else if (parsed.stream === "s") entry.fileS = file; // sparse file (_s) — HTTP 206 range response data
      simpleCacheMap.set(parsed.hash, entry);
    } else {
      blockfileFiles.push(file);
    }
  }

  // ── Phase 2a: Process Simple Cache paired entries ─────────────────────────
  // Chromium Simple Cache layout:
  //   _0 file = Stream 0 (HTTP headers) + Stream 1 (HTTP response body)
  //   _s file = Sparse stream (HTTP 206 range response data — the PRIMARY video data on macOS)
  //   _1 file = Stream 2 (service worker side data — NOT relevant for media recovery)
  //
  // On macOS/Linux, Discord serves videos via HTTP 206 range requests. The actual video
  // bytes live in the _s (sparse) file, NOT in the _0 body (which may be empty or just a
  // tiny stub). We MUST check _s first when it exists.
  let detectIdx = 0;
  for (const [, { file0, file1: _file1, fileS }] of simpleCacheMap) {
    if (!file0 && !fileS) continue;
    detectIdx++;
    const progressFile = fileS ?? file0!;
    onProgress?.({ phase: "detecting", current: detectIdx, total, currentFile: progressFile.name });

    // ── Strategy 1: Try _s (sparse) file FIRST — primary video data source on macOS ──
    if (fileS && fileS.size > 0) {
      let sparseHandled = false;
      try {
        onProgress?.({ phase: "detecting", current: detectIdx, total, currentFile: fileS.name });
        // Read just the first 256 bytes of reassembled sparse data for type detection
        // (avoids reading entire video into memory)
        const sparseHeaderBytes: number[] = await invoke("read_sparse_cache_header", { path: fileS.path, size: 256 });
        console.log(`[scan-debug] read_sparse_cache_header OK for ${fileS.name}: ${sparseHeaderBytes.length} bytes`);
        const sparseHeader = new Uint8Array(sparseHeaderBytes);
        if (sparseHeader.length > 8) {
          const sparseType = detectFileType(sparseHeader);
          if (sparseType) {
            if (sparseType === "mp4_complete" || sparseType === "mp4_header_only" || sparseType === "mp4_chunked") {
              // For MP4, we need to check moov+mdat — read full sparse data
              const sparseBytes: number[] = await invoke("read_sparse_cache_file", { path: fileS.path });
              const sparseData = new Uint8Array(sparseBytes);
              const boxes = parseMP4Boxes(sparseData);
              const hasMoov = boxes.some((b) => b.boxType === "moov");
              const hasMdat = boxes.some((b) => b.boxType === "mdat");
              standaloneFiles.push({
                file: { ...fileS, size: sparseData.length },
                fileType: (hasMoov && hasMdat) ? "mp4_complete" : "mp4_header_only",
              });
            } else {
              // Non-MP4 media detected in sparse data — get actual reassembled size
              let sparseSize: number = await invoke("get_sparse_cache_size", { path: fileS.path });
              // Sanity check: reassembled size should be >= on-disk sparse file size.
              // If get_sparse_cache_size returns something suspiciously small (e.g. just header bytes),
              // fall back to reading full sparse data for the true length.
              if (sparseSize <= 0 || sparseSize < fileS.size) {
                const fallbackBytes: number[] = await invoke("read_sparse_cache_file", { path: fileS.path });
                sparseSize = fallbackBytes.length;
              }
              standaloneFiles.push({
                file: { ...fileS, size: sparseSize > 0 ? sparseSize : fileS.size },
                fileType: sparseType,
              });
            }
            sparseHandled = true;
          } else {
            // Magic bytes didn't match — try Content-Type from _0 headers to identify sparse data
            if (file0) {
              try {
                const contentType: string = await invoke("read_file_content_type", { path: file0.path });
                const ct = contentType.toLowerCase().split(";")[0].trim();
                const ctFileType = mimeToFileType(ct);
                if (ctFileType) {
                  const sparseSize: number = await invoke("get_sparse_cache_size", { path: fileS.path });
                  if (ctFileType === "mp4_complete" || ctFileType.startsWith("mp4")) {
                    // MP4 identified by Content-Type — read sparse for moov/mdat check
                    const sparseBytes: number[] = await invoke("read_sparse_cache_file", { path: fileS.path });
                    const sparseData = new Uint8Array(sparseBytes);
                    const boxes = parseMP4Boxes(sparseData);
                    const hasMoov = boxes.some((b) => b.boxType === "moov");
                    const hasMdat = boxes.some((b) => b.boxType === "mdat");
                    standaloneFiles.push({
                      file: { ...fileS, size: sparseData.length },
                      fileType: (hasMoov && hasMdat) ? "mp4_complete" : "mp4_header_only",
                    });
                  } else {
                    let ctSparseSize = sparseSize;
                    // Same sanity check: if sparse computed size is suspicious, read full data
                    if (ctSparseSize <= 0 || ctSparseSize < fileS.size) {
                      const fallbackBytes: number[] = await invoke("read_sparse_cache_file", { path: fileS.path });
                      ctSparseSize = fallbackBytes.length;
                    }
                    standaloneFiles.push({
                      file: { ...fileS, size: ctSparseSize > 0 ? ctSparseSize : fileS.size },
                      fileType: ctFileType,
                    });
                  }
                  sparseHandled = true;
                }
              } catch (err) { console.warn(`[scan] Content-Type fallback failed for ${file0.path}:`, err); }
            }
          }
        }
      } catch (err) { console.warn(`[scan-debug] Sparse detection FAILED for ${fileS?.path}:`, err); onProgress?.({ phase: "detecting", current: detectIdx, total, currentFile: `${fileS?.name} (sparse read failed)` }); }

      if (sparseHandled) continue;
    }

    // ── Strategy 2: Try _0 body (works when there's no _s, or _s was empty/unrecognized) ──
    if (!file0) continue;

    const headerBytes: number[] = await invoke("read_file_header", { path: file0.path, size: 256 });
    const header = new Uint8Array(headerBytes);
    let fileType = detectFileType(header);

    // MP4 with ftyp detected — check for complete moov+mdat
    if (fileType && (fileType === "mp4_complete" || fileType === "mp4_header_only" || fileType === "mp4_chunked")) {
      const fullBytes: number[] = await invoke("read_file_bytes", { path: file0.path });
      const fullData = new Uint8Array(fullBytes);
      const boxes = parseMP4Boxes(fullData);
      const hasMoov = boxes.some((b) => b.boxType === "moov");
      const hasMdat = boxes.some((b) => b.boxType === "mdat");
      if (hasMoov && hasMdat) {
        standaloneFiles.push({ file: file0, fileType: "mp4_complete" });
      } else {
        // Incomplete MP4 in Simple Cache — still standalone (not blockfile-chunked)
        standaloneFiles.push({ file: file0, fileType: "mp4_header_only" });
      }
      continue;
    }

    // Non-MP4 identified by magic bytes
    if (fileType) {
      standaloneFiles.push({ file: file0, fileType });
      continue;
    }

    // Magic bytes failed — try Content-Type from _0 file's HTTP headers
    try {
      const contentType: string = await invoke("read_file_content_type", { path: file0.path });
      const ct = contentType.toLowerCase().split(";")[0].trim();
      const ctFileType = mimeToFileType(ct);
      if (ctFileType) {
        if (ctFileType === "mp4_complete" || ctFileType.startsWith("mp4")) {
          const fullBytes: number[] = await invoke("read_file_bytes", { path: file0.path });
          const fullData = new Uint8Array(fullBytes);
          const boxes = parseMP4Boxes(fullData);
          const hasMoov = boxes.some((b) => b.boxType === "moov");
          const hasMdat = boxes.some((b) => b.boxType === "mdat");
          if (hasMoov && hasMdat) {
            standaloneFiles.push({ file: file0, fileType: "mp4_complete" });
          } else {
            standaloneFiles.push({ file: file0, fileType: "mp4_header_only" });
          }
        } else {
          standaloneFiles.push({ file: file0, fileType: ctFileType });
        }
        continue;
      }
    } catch {
      // No Content-Type header — skip
    }

    // Unidentified Simple Cache files are NOT added to dataChunkFiles (they are NOT blockfile chunks).
  }
  // ── Phase 2b: Process Blockfile files (f_XXXXXX) ─────────────────────────
  for (let i = 0; i < blockfileFiles.length; i++) {
    const file = blockfileFiles[i];
    detectIdx++;
    onProgress?.({ phase: "detecting", current: detectIdx, total, currentFile: file.name });
    const headerBytes: number[] = await invoke("read_file_header", { path: file.path, size: 256 });
    const header = new Uint8Array(headerBytes);
    const fileType = detectFileType(header);
    if (fileType && (fileType === "mp4_complete" || fileType === "mp4_header_only" || fileType === "mp4_chunked")) {
      const fullBytes: number[] = await invoke("read_file_bytes", { path: file.path });
      const fullData = new Uint8Array(fullBytes);
      const boxes = parseMP4Boxes(fullData);
      const hasMoov = boxes.some((b) => b.boxType === "moov");
      const hasMdat = boxes.some((b) => b.boxType === "mdat");
      if (hasMoov && hasMdat) {
        standaloneFiles.push({ file, fileType: "mp4_complete" });
      } else {
        mp4HeaderFiles.push({ file, data: fullData });
      }
    } else if (fileType) {
      standaloneFiles.push({ file, fileType });
    } else {
      dataChunkFiles.push(file);
    }
  }

  onProgress?.({ phase: "grouping", current: 0, total: 0, currentFile: "" });

  const resources: CacheResource[] = [];
  let resourceIdx = 0;
  // ── Separate standalone files into true-standalone vs Blockfile grouping candidates ──
  const trueStandalone: Array<{ file: CacheFileEntry; fileType: FileType }> = [];
  const blockfileGroupPool: Array<{ file: CacheFileEntry; fileType: FileType; hex: number }> = [];

  for (const entry of standaloneFiles) {
    const hex = parseCacheHex(entry.file.name);
    if (hex === null) {
      // Simple Cache file — always standalone
      trueStandalone.push(entry);
    } else if (entry.fileType === "mp4_fragment" || entry.fileType === "webm_continuation") {
      // Fragment/continuation in Blockfile — must NOT be standalone, goes to grouping pool
      blockfileGroupPool.push({ ...entry, hex });
    } else {
      // Blockfile file with a recognized non-fragment type (image, complete video, etc.)
      trueStandalone.push(entry);
    }
  }

  // ── Emit true standalone resources ────────────────────────────────────────
  for (const { file, fileType } of trueStandalone) {
    resourceIdx++;
    const category = getMediaCategory(fileType);
    resources.push({
      id: generateId(),
      resourceType: fileType,
      mediaCategory: category,
      files: [file],
      totalSize: file.size,
      displayName: `${category === "image" ? "Image" : category === "video" ? "Video" : category === "audio" ? "Audio" : "File"} ${resourceIdx}`,
      modifiedAt: file.modified_at,
      selected: false,
    });
  }

  // ── Build unified Blockfile entry map for sequential grouping ─────────────
  // Pool sources: mp4HeaderFiles, dataChunkFiles (unidentified), blockfileGroupPool (fragments/continuations)
  const blockfileEntries: Array<{
    hex: number;
    file: CacheFileEntry;
    fileType: FileType | null; // null = unidentified data chunk
    mp4Data?: Uint8Array; // only for mp4HeaderFiles
  }> = [];

  // Add mp4HeaderFiles
  for (const { file, data } of mp4HeaderFiles) {
    const hex = parseCacheHex(file.name);
    if (hex !== null) {
      blockfileEntries.push({ hex, file, fileType: "mp4_header_only", mp4Data: data });
    }
  }

  // Add unidentified data chunks (only Blockfile ones)
  for (const file of dataChunkFiles) {
    const hex = parseCacheHex(file.name);
    if (hex !== null) {
      blockfileEntries.push({ hex, file, fileType: null });
    }
  }

  // Add fragment/continuation files from the group pool
  for (const { file, fileType, hex } of blockfileGroupPool) {
    blockfileEntries.push({ hex, file, fileType });
  }

  // Sort all entries by hex number (ascending)
  blockfileEntries.sort((a, b) => a.hex - b.hex);

  // ── Sequential grouping walk ──────────────────────────────────────────────
  // Media header types that start a new group
  const AUDIO_HEADER_TYPES = new Set<FileType>(["mp3", "ogg", "aac", "flac", "wav", "opus", "wma", "m4a"]);
  const VIDEO_HEADER_TYPES = new Set<FileType>(["webm_mkv", "avi", "flv", "mpeg_ts", "mov"]);

  function isMediaHeader(ft: FileType | null): boolean {
    if (ft === null) return false;
    if (ft === "mp4_header_only") return true;
    return AUDIO_HEADER_TYPES.has(ft) || VIDEO_HEADER_TYPES.has(ft);
  }

  function isContinuationChunk(ft: FileType | null): boolean {
    return ft === null || ft === "mp4_fragment" || ft === "webm_continuation" || ft === "media_data_chunk";
  }

  const claimed = new Set<number>(); // track claimed entry indices

  // Walk through and group: header + subsequent continuation chunks
  for (let i = 0; i < blockfileEntries.length; i++) {
    if (claimed.has(i)) continue;
    const entry = blockfileEntries[i];

    if (!isMediaHeader(entry.fileType)) continue;

    // Found a media header — collect continuation chunks
    claimed.add(i);

    if (entry.fileType === "mp4_header_only" && entry.mp4Data) {
      // ── MP4 header: use existing assembleChunkedMP4 for reconstruction ────
      // Collect all unclaimed data chunks for assembleChunkedMP4 to pick from
      const availableChunks: CacheFileEntry[] = [];
      for (let j = 0; j < blockfileEntries.length; j++) {
        if (claimed.has(j)) continue;
        if (isContinuationChunk(blockfileEntries[j].fileType)) {
          availableChunks.push(blockfileEntries[j].file);
        }
      }
      const resource = assembleChunkedMP4(
        folderPath, entry.file, entry.mp4Data, availableChunks,
      );

      resourceIdx++;
      if (resource && resource.files.length > 1) {
        resource.id = generateId();
        resource.displayName = `Video ${resourceIdx} (chunked)`;
        resource.selected = false;
        resource.modifiedAt = Math.max(...resource.files.map(f => f.modified_at || 0));
        resources.push(resource);
        // Mark claimed chunks by matching file names
        const usedNames = new Set(resource.files.map(f => f.name));
        for (let j = 0; j < blockfileEntries.length; j++) {
          if (usedNames.has(blockfileEntries[j].file.name)) {
            claimed.add(j);
          }
        }
      } else {
        // assembleChunkedMP4 returned null or single-file — emit as standalone mp4_header_only
        const fallbackFiles = resource ? resource.files : [entry.file];
        const fallbackSize = fallbackFiles.reduce((sum, f) => sum + f.size, 0);
        resources.push({
          id: generateId(),
          resourceType: "mp4_header_only",
          mediaCategory: "video",
          files: fallbackFiles,
          headerFile: entry.file.name,
          totalSize: fallbackSize,
          displayName: `Video ${resourceIdx}`,
          modifiedAt: entry.file.modified_at,
          selected: false,
        });
      }
    } else {
      // ── Non-MP4 media header (WebM, audio, etc.): sequential chunk collection ──
      const groupFiles: CacheFileEntry[] = [entry.file];
      const headerHex = entry.hex;

      // Collect subsequent continuation chunks with reasonable hex proximity
      for (let j = i + 1; j < blockfileEntries.length; j++) {
        if (claimed.has(j)) continue;
        const next = blockfileEntries[j];

        // Stop if we hit another media header
        if (isMediaHeader(next.fileType)) break;

        // Stop if hex gap is too large (> 500 indicates different resource)
        if (next.hex - headerHex > 500) break;

        // Only collect continuation/unidentified chunks
        if (isContinuationChunk(next.fileType)) {
          claimed.add(j);
          groupFiles.push(next.file);
        }
      }

      resourceIdx++;
      const totalSize = groupFiles.reduce((sum, f) => sum + f.size, 0);
      const category = getMediaCategory(entry.fileType!);
      const label = category === "video" ? "Video" : category === "audio" ? "Audio" : "File";
      resources.push({
        id: generateId(),
        resourceType: entry.fileType!,
        mediaCategory: category,
        files: groupFiles,
        headerFile: entry.file.name,
        totalSize,
        displayName: groupFiles.length > 1 ? `${label} ${resourceIdx} (chunked)` : `${label} ${resourceIdx}`,
        modifiedAt: Math.max(...groupFiles.map(f => f.modified_at || 0)),
        selected: false,
      });
    }
  }

  // ── Remaining unclaimed Blockfile chunks → "Unidentified chunks" resource ──
  const unclaimed: CacheFileEntry[] = [];
  for (let i = 0; i < blockfileEntries.length; i++) {
    if (!claimed.has(i)) {
      unclaimed.push(blockfileEntries[i].file);
    }
  }

  if (unclaimed.length > 0) {
    resources.push({
      id: generateId(),
      resourceType: "unknown_data",
      mediaCategory: "other",
      files: unclaimed,
      totalSize: unclaimed.reduce((sum, f) => sum + f.size, 0),
      displayName: `Unidentified chunks (${unclaimed.length})`,
      modifiedAt: Math.max(...unclaimed.map(f => f.modified_at || 0)),
      selected: false,
    });
  }


  // Generate preview thumbnails for single-file images and videos
  await generatePreviewThumbnails(resources, onProgress);

  onProgress?.({ phase: "done", current: total, total, currentFile: "" });

  return resources;
}

function assembleChunkedMP4(
  _folderPath: string,
  headerFile: CacheFileEntry,
  headerData: Uint8Array,
  dataChunks: CacheFileEntry[],
): CacheResource | null {
  const boxes = parseMP4Boxes(headerData);
  const mdatBox = boxes.find((b) => b.boxType === "mdat");
  if (!mdatBox) return null;
  const headerHex = parseCacheHex(headerFile.name);
  if (headerHex === null) return null;

  const CHUNK_BLOCK_SIZE = 1_048_576;
  const mdatDeclaredSize = mdatBox.size;
  const mdatReachedEnd = mdatBox.offset + mdatBox.size >= headerData.length;
  let maxChunks: number;
  let hexRange: number;
  if (mdatReachedEnd) {
    // mdat extends beyond header file — use declared size to estimate chunk count.
    // Total bytes = mdat data beyond header + moov (tail) chunk.
    // Add +5 margin for tail chunk, gaps, and rounding.
    const remainingBytes = mdatDeclaredSize - (headerData.length - mdatBox.offset);
    maxChunks = Math.ceil(remainingBytes / CHUNK_BLOCK_SIZE) + 5;
    hexRange = maxChunks + 10; // small margin for non-sequential numbering
  } else {
    const expectedTotalSize = mdatDeclaredSize + headerData.length;
    maxChunks = Math.ceil(expectedTotalSize / CHUNK_BLOCK_SIZE) + 5;
    hexRange = maxChunks * 2;
  }
  const sorted = dataChunks
    .map((c) => ({ file: c, hex: parseCacheHex(c.name) }))
    .filter((c): c is { file: CacheFileEntry; hex: number } =>
      c.hex !== null && c.hex > headerHex && c.hex <= headerHex + hexRange,
    )
    .sort((a, b) => a.hex - b.hex);
  const collected: CacheFileEntry[] = [];
  for (const { file } of sorted) {
    if (collected.length >= maxChunks) break;
    collected.push(file);
  }

  if (collected.length === 0) {
    return {
      id: "",
      resourceType: "mp4_header_only",
      mediaCategory: "video",
      files: [headerFile],
      headerFile: headerFile.name,
      totalSize: headerFile.size,
      displayName: "",
      selected: false,
    };
  }

  const allFiles = [headerFile, ...collected];
  const totalSize = allFiles.reduce((sum, f) => sum + f.size, 0);
  return {
    id: "",
    resourceType: "mp4_chunked",
    mediaCategory: "video",
    files: allFiles,
    headerFile: headerFile.name,
    totalSize,
    displayName: "",
    selected: false,
  };
}
