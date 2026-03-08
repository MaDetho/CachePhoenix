import { invoke } from "@tauri-apps/api/core";
import type { CacheFileEntry, CacheResource, FileType, VideoInfo, BlockfileIndexResult, BlockfileCacheEntry, ScanDebugData, ChunkAssociationDebug } from "@/types";
import { generateId, getMediaCategory, parseDiscordUrl } from "@/lib/utils";
import { generateThumbnail as ffmpegThumbnail, ffmpegHealthCheck, ffmpegRemux } from "@/lib/ffmpeg";
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
  // Process in chunks to avoid O(n²) string concatenation
  const CHUNK_SIZE = 8192;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
    chunks.push(String.fromCharCode(...slice));
  }
  return btoa(chunks.join(""));
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
    // For MP4s, remux (stream-copy) the reconstructed file before thumbnail extraction.
    // This fixes container issues (moov placement, timestamps) that prevent ffmpeg from
    // extracting frames. Recovery pipeline does this too — thumbnails should match.
    let thumbnailSource = rawPath;
    const remuxedPath = `${tmp}dccr_remuxed_${uid}${ext}`;
    if (isMP4) {
      try {
        const remuxOk = await ffmpegRemux(rawPath, remuxedPath);
        if (remuxOk) {
          thumbnailSource = remuxedPath;
        }
      } catch {
        // Remux failed — fall back to raw file for thumbnail attempt
      }
    }
    const dataUrl = await generateVideoDataUrl(thumbnailSource);
    // Clean up temp files
    try {
      const { remove } = await import("@tauri-apps/plugin-fs");
      await remove(rawPath).catch(() => {});
      if (thumbnailSource !== rawPath) {
        await remove(remuxedPath).catch(() => {});
      }
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
    const images = resources.filter(r => r.mediaCategory === "image" && r.files.length > 0);
    for (let i = 0; i < images.length; i++) {
      const resource = images[i];
      onProgress?.({ phase: "thumbnails", current: i + 1, total: images.length, currentFile: resource.displayName });
      const cacheKey = resource.files[0].path;
      const mtime = Math.max(...resource.files.map(f => f.modified_at ?? 0));
      const cached = await getCachedThumbnail(cacheKey, mtime, resource.totalSize);
      if (cached) { resource.previewUrl = cached; continue; }
      if (resource.files.length === 1) {
        try {
          const dataUrl = await generateImageDataUrl(resource.files[0].path, resource.resourceType);
          if (dataUrl) {
            resource.previewUrl = dataUrl;
            await setCachedThumbnail(cacheKey, dataUrl, mtime, resource.totalSize);
          }
        } catch (err) {
          console.warn(`[thumbnail] Image thumbnail failed for ${resource.displayName}:`, err);
        }
      }
    }
    return;
  }
  console.log(`[thumbnail] ffmpeg sidecar OK`);
  const previewable = resources.filter(
    (r) => (r.mediaCategory === "image" || r.mediaCategory === "video") && r.files.length > 0,
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

    // Timeout wrapper to prevent any single thumbnail from hanging the scan
    const THUMBNAIL_TIMEOUT_MS = 15_000; // 15 seconds per resource
    try {
      let dataUrl: string | undefined;
      const thumbPromise = (async (): Promise<string | undefined> => {
        if (resource.files.length === 1) {
          if (resource.mediaCategory === "image") {
            return await generateImageDataUrl(resource.files[0].path, resource.resourceType);
          } else if (resource.mediaCategory === "video") {
            return await generateVideoDataUrl(resource.files[0].path);
          }
        } else if (resource.mediaCategory === "video") {
          return await generateChunkedVideoDataUrl(resource);
        }
        return undefined;
      })();

      const timeoutPromise = new Promise<undefined>((resolve) =>
        setTimeout(() => {
          console.warn(`[thumbnail] TIMEOUT after ${THUMBNAIL_TIMEOUT_MS}ms for ${resource.displayName} (${resource.files[0].name})`);
          resolve(undefined);
        }, THUMBNAIL_TIMEOUT_MS)
      );

      dataUrl = await Promise.race([thumbPromise, timeoutPromise]);
      if (dataUrl) {
        resource.previewUrl = dataUrl;
        await setCachedThumbnail(cacheKey, dataUrl, mtime, totalSize);
      }
    } catch (err) {
      console.warn(`[thumbnail] Error generating thumbnail for ${resource.displayName}:`, err);
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

/**
 * Strip the Chromium cache key prefix (e.g. `1/0/`, `0/0/`) from URLs.
 * Chromium's GenerateCacheKey prepends `<has_credentials>/<partition>/` to URLs.
 * This makes `new URL(...)` fail because `1/0/https://...` isn't a valid URL.
 */
function stripCacheKeyPrefix(rawUrl: string): string {
  const match = rawUrl.match(/^\d+\/\d+\/(https?:\/\/.+)$/);
  return match ? match[1] : rawUrl;
}

export async function scanCacheFolder(
  folderPath: string,
  onProgress?: (progress: ScanProgress) => void,
): Promise<{ resources: CacheResource[]; debugData: ScanDebugData }> {
  onProgress?.({ phase: "listing", current: 0, total: 0, currentFile: "" });

  const files: CacheFileEntry[] = await invoke("list_cache_files", { dir: folderPath });
  const total = files.length;

  const debugData: ScanDebugData = {
    blockfileIndex: null,
    chunkAssociations: {},
    skippedEntries: [],
    affinityGroups: [],
    fileToEntryMap: {},
    indexClaimedFiles: [],
    heuristicClaimedFiles: [],
    stats: {
      totalFiles: total,
      blockfileFiles: 0,
      simpleCacheFiles: 0,
      indexEntries: 0,
      indexClaimedFiles: 0,
      heuristicGroupedFiles: 0,
      unclaimedFiles: 0,
      resourcesCreated: 0,
      resourcesWithMetadata: 0,
    },
  };

  if (total === 0) return { resources: [], debugData };

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
  debugData.stats.blockfileFiles = blockfileFiles.length;
  debugData.stats.simpleCacheFiles = simpleCacheMap.size;

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

  // ── Phase 2b-index: Parse blockfile index if present ──────────────────────
  // NOTE: list_cache_files() filters out 'index' and 'data_N' files, so we detect
  // a Blockfile cache by the presence of f_XXXXXX files instead. The Rust parser
  // reads index/data_N files directly from the folder path.
  const hasBlockfileFiles = blockfileFiles.some(f => /^f_[0-9a-f]{6}$/i.test(f.name));
  console.log(`[CachePhoenix][DEBUG] blockfileFiles count: ${blockfileFiles.length}, sample names: [${blockfileFiles.slice(0,5).map(f => f.name).join(', ')}]`);
  console.log(`[CachePhoenix][DEBUG] hasBlockfileFiles: ${hasBlockfileFiles}`);
  let blockfileIndex: BlockfileIndexResult | null = null;
  const indexClaimedFiles = new Set<string>();
  const indexEntryByFile = new Map<string, BlockfileCacheEntry>();

  if (hasBlockfileFiles) {
    try {
      console.log(`[CachePhoenix][DEBUG] Invoking parse_blockfile_index with dir: ${folderPath}`);
      blockfileIndex = await invoke("parse_blockfile_index", { dir: folderPath });
      console.log(`[CachePhoenix][DEBUG] parse_blockfile_index returned:`, blockfileIndex ? `entries=${blockfileIndex.entries.length}, errors=${blockfileIndex.errors.length}, version=0x${blockfileIndex.version?.toString(16)}` : 'null');
      if (blockfileIndex) {
        console.log(`[CachePhoenix] Blockfile index parsed: ${blockfileIndex.entries.length} entries, ${blockfileIndex.errors.length} errors`);
        if (blockfileIndex.entries.length > 0) {
          const sample = blockfileIndex.entries[0];
          console.log(`[CachePhoenix][DEBUG] Sample entry[0]: url=${sample.url?.slice(0,100)}, content_type=${sample.content_type}, body_size=${sample.body_size}, is_sparse=${sample.is_sparse}, state=${sample.state}, data_files=${sample.data_files?.length}, children=${sample.children?.length}`);
        }
        if (blockfileIndex.errors.length > 0) {
          console.warn(`[CachePhoenix] Index parse errors:`, blockfileIndex.errors);
        }
      }
      debugData.blockfileIndex = blockfileIndex;
      debugData.stats.indexEntries = blockfileIndex?.entries.length ?? 0;
    } catch (err) {
      console.warn(`[CachePhoenix][DEBUG] parse_blockfile_index FAILED:`, err);
      console.warn(`[CachePhoenix] Failed to parse blockfile index, falling back to heuristic:`, err);
      blockfileIndex = null;
      debugData.blockfileIndex = null;
    }
  }

  const resources: CacheResource[] = [];
  let resourceIdx = 0;

  const parseContentRangeTotal = (contentRange: string | undefined): number | undefined => {
    if (!contentRange) return undefined;
    const totalMatch = contentRange.match(/\/(\d+)$/);
    if (!totalMatch) return undefined;
    const totalBytes = parseInt(totalMatch[1], 10);
    return Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : undefined;
  };

  const recordChunkAssociations = (
    resource: CacheResource,
    method: ChunkAssociationDebug["method"],
    options?: {
      etag?: string;
      contentRangeTotal?: number;
      parentHeaderFile?: string;
      headerHex?: number | null;
    },
  ): void => {
    const headerHex = options?.headerHex ?? (resource.headerFile ? parseCacheHex(resource.headerFile) : null);
    const parentHeaderFile = options?.parentHeaderFile ?? resource.headerFile;
    debugData.chunkAssociations[resource.id] = resource.files.map((f) => {
      const hex = parseCacheHex(f.name);
      return {
        fileName: f.name,
        hexValue: hex ?? 0,
        method,
        etag: options?.etag,
        contentRangeTotal: options?.contentRangeTotal,
        parentHeaderFile,
        hexDistance: hex !== null && headerHex !== null ? hex - headerHex : undefined,
      };
    });
  };

  // Helper to extract filename from a data file path (handles Windows \, \\ and Unix /)
  const extractFilename = (filePath: string): string => {
    const parts = filePath.split(/[\\/]/);
    return parts[parts.length - 1];
  };

  if (blockfileIndex && blockfileIndex.entries.length > 0) {
    // INDEX-FIRST STRATEGY: Sparse entries (chunked videos) are authoritative.
    // Their children's external files are pre-claimed so the heuristic path
    // never creates duplicate resources for the same video. Non-sparse entries
    // with unmapped MIME types only claim files when a resource is actually created
    // (to avoid the "vanishing files" bug from overly-eager pre-claiming).
    // Build a map: external filename → index entry, so heuristic-created
    // resources (assembleChunkedMP4, sequential grouping) can inherit metadata.
    // For SPARSE entries: pre-claim ALL external child files immediately.
    let mapSkippedEmpty = 0, mapIncluded = 0, mapSparseCount = 0, mapWithExternalFiles = 0;
    for (const entry of blockfileIndex.entries) {
      if (entry.body_size === 0 && !entry.is_sparse) { mapSkippedEmpty++; continue; }
      mapIncluded++;
      if (entry.is_sparse) mapSparseCount++;
      // NOTE: Do NOT filter by state here — we want metadata for ALL entries
      // whose files still exist on disk, even if the cache entry is evicted/doomed.
      let hasExternal = false;
      for (const df of entry.data_files) {
        if (df.is_external) {
          const fname = extractFilename(df.file_path);
          indexEntryByFile.set(fname, entry);
          debugData.fileToEntryMap[fname] = { url: entry.url, contentType: entry.content_type, isSparse: entry.is_sparse, childCount: entry.children.length };
          hasExternal = true;
        }
      }
      for (const child of entry.children) {
        if (child.data_ref.is_external) {
          const fname = extractFilename(child.data_ref.file_path);
          indexEntryByFile.set(fname, entry);
          debugData.fileToEntryMap[fname] = { url: entry.url, contentType: entry.content_type, isSparse: entry.is_sparse, childCount: entry.children.length };
          hasExternal = true;
          // PRE-CLAIM: sparse children's external files are owned by this index entry.
          // This prevents the heuristic path from creating duplicate resources.
          if (entry.is_sparse) {
            indexClaimedFiles.add(fname);
          }
        }
      }
      // Also pre-claim the parent's own external body file for sparse entries
      if (entry.is_sparse) {
        for (const df of entry.data_files) {
          if (df.is_external) {
            indexClaimedFiles.add(extractFilename(df.file_path));
          }
        }
      }
      if (hasExternal) mapWithExternalFiles++;
    }
    console.log(`[CachePhoenix] indexEntryByFile map: ${indexEntryByFile.size} filenames mapped. Pre-claimed ${indexClaimedFiles.size} sparse files. Breakdown: ${mapIncluded} entries passed filter (${mapSkippedEmpty} skipped empty, ${mapSparseCount} sparse, ${mapWithExternalFiles} with external files) of ${blockfileIndex.entries.length} total`);

    // indexClaimedFiles is pre-populated for sparse entries (above), but
    // non-sparse entries only claim files when a resource is actually created.

    // Second pass: create resources from valid entries
    let skippedEmpty = 0, skippedNoFileType = 0, skippedNoFiles = 0, createdFromIndex = 0;
    for (const entry of blockfileIndex.entries) {
      // Skip entries with no body data (non-sparse with body_size=0).
      // NOTE: Do NOT filter by state — evicted/doomed entries may still have files
      // on disk that we want to create resources from. The file existence check
      // below (resourceFiles.length === 0) handles truly-deleted files.
      if (entry.body_size === 0 && !entry.is_sparse) {
        skippedEmpty++;
        debugData.skippedEntries.push({
          url: entry.url,
          reason: "empty-body",
          contentType: entry.content_type ?? undefined,
          bodySize: entry.body_size,
          entry,
        });
        continue;
      }

      // Build files list for the resource FIRST (we need the files to
      // attempt magic byte detection when MIME type is unmapped).
      const resourceFiles: CacheFileEntry[] = [];

      if (entry.is_sparse && entry.children.length > 0) {
        // Sparse entry — children sorted by child_id in Rust output
        for (const child of entry.children) {
          if (child.data_ref.is_external) {
            const refName = extractFilename(child.data_ref.file_path);
            const match = blockfileFiles.find(f => f.name === refName);
            if (match) resourceFiles.push(match);
          }
        }
      } else {
        // Non-sparse — find stream 1 (body) data file
        const stream1 = entry.data_files.find(d => d.stream_index === 1);
        if (stream1 && stream1.is_external) {
          const refName = extractFilename(stream1.file_path);
          const match = blockfileFiles.find(f => f.name === refName);
          if (match) resourceFiles.push(match);
        }
      }

      // For sparse entries with children, even if no external files were found on disk,
      // we can still reconstruct via reconstruct_from_index (which reads from block files).
      // Only skip if BOTH resourceFiles is empty AND entry has no children.
      if (resourceFiles.length === 0 && !(entry.is_sparse && entry.children.length > 0)) {
        console.debug(`[CachePhoenix] Index entry has 0 matching files: ${entry.url.slice(0, 120)} (sparse=${entry.is_sparse}, children=${entry.children.length}, data_files=${entry.data_files.length})`);
        skippedNoFiles++;
        debugData.skippedEntries.push({
          url: entry.url,
          reason: "no-files",
          contentType: entry.content_type ?? undefined,
          bodySize: entry.body_size,
          fileCount: resourceFiles.length,
          entry,
        });
        continue;
      }

      // Determine file type from content_type (MIME map), falling back to
      // magic byte detection on the first file if MIME type is unmapped.
      let fileType: FileType | null = null;
      if (entry.content_type) {
        const ct = entry.content_type.toLowerCase().split(";")[0].trim();
        fileType = mimeToFileType(ct);
      }
      if (!fileType && resourceFiles.length > 0) {
        // MIME type unmapped or missing — try magic byte detection on first file
        try {
          const headerBytes: number[] = await invoke("read_file_header", { path: resourceFiles[0].path, size: 256 });
          const header = new Uint8Array(headerBytes);
          fileType = detectFileType(header);
          if (fileType) {
            console.log(`[CachePhoenix][DEBUG] MIME fallback: content_type=${entry.content_type || 'null'} -> magic bytes detected: ${fileType} for ${resourceFiles[0].name}`);
          }
        } catch (err) {
          console.debug(`[CachePhoenix] Magic byte detection failed for ${resourceFiles[0].name}:`, err);
        }
      }
      if (!fileType) {
        // For sparse entries with children, the URL often indicates the content type
        // even if the MIME header is missing/unmapped. Try URL-based detection.
        if (entry.is_sparse && entry.children.length > 0) {
          // Check URL extension
          try {
            const urlObj = new URL(stripCacheKeyPrefix(entry.url));
            const pathname = urlObj.pathname.toLowerCase();
            if (pathname.endsWith('.mp4') || pathname.endsWith('.m4v')) fileType = 'mp4_complete';
            else if (pathname.endsWith('.webm')) fileType = 'webm_mkv';
            else if (pathname.endsWith('.mkv')) fileType = 'webm_mkv';
            else if (pathname.endsWith('.gif')) fileType = 'gif';
            else if (pathname.endsWith('.png')) fileType = 'png';
            else if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) fileType = 'jpeg';
            else if (pathname.endsWith('.webp')) fileType = 'webp';
          } catch { /* not a valid URL */ }
        }
        // If still no file type and we have no magic bytes to try, try reading
        // the first child's data via reconstruct_from_index header detection
        if (!fileType && entry.is_sparse && entry.children.length > 0) {
          // Default to video for sparse entries — they're almost always chunked video
          console.log(`[CachePhoenix][DEBUG] Sparse entry with ${entry.children.length} children but no file type detected, defaulting to mp4_chunked: ${entry.url.slice(0, 120)}`);
          fileType = 'mp4_complete';
        }
        if (!fileType) {
          skippedNoFileType++;
          debugData.skippedEntries.push({
            url: entry.url,
            reason: "no-file-type",
            contentType: entry.content_type ?? undefined,
            bodySize: entry.body_size,
            fileCount: resourceFiles.length,
            entry,
          });
          continue;
        }
      }

      // Determine resource type
      let resourceType: FileType = fileType;
      if (entry.is_sparse && entry.children.length > 1 &&
          (fileType === "mp4_complete" || fileType === "mp4_header_only" || fileType === "mp4_chunked")) {
        resourceType = "mp4_chunked";
      }

      resourceIdx++;
      const category = getMediaCategory(resourceType);
      const totalSize = entry.body_size > 0 ? entry.body_size : resourceFiles.reduce((sum, f) => sum + f.size, 0);

      // Display name from original filename or URL
      let displayName = entry.original_filename || "";
      if (!displayName) {
        try {
          const urlObj = new URL(stripCacheKeyPrefix(entry.url));
          const pathParts = urlObj.pathname.split("/").filter(Boolean);
          displayName = pathParts.length > 0 ? decodeURIComponent(pathParts[pathParts.length - 1]) : "";
        } catch {
          displayName = "";
        }
      }
      if (!displayName || displayName.length > 100) {
        const label = category === "image" ? "Image" : category === "video" ? "Video" : category === "audio" ? "Audio" : "File";
        const childCount = entry.children.length;
        const isChunked = resourceFiles.length > 1 || (entry.is_sparse && childCount > 1);
        displayName = isChunked ? `${label} ${resourceIdx} (${childCount} chunks)` : `${label} ${resourceIdx}`;
      }

      resources.push({
        id: generateId(),
        resourceType,
        mediaCategory: category,
        files: resourceFiles,
        totalSize,
        displayName,
        modifiedAt: entry.creation_time ?? (resourceFiles.length > 0 ? Math.max(...resourceFiles.map(f => f.modified_at || 0)) : 0),
        selected: false,
        indexUrl: entry.url,
        cacheDir: folderPath,
        indexContentType: entry.content_type ?? undefined,
        indexHttpStatus: entry.http_status ?? undefined,
        indexOriginalFilename: entry.original_filename ?? undefined,
        indexIsSparse: entry.is_sparse || undefined,
        indexChildCount: entry.children.length > 0 ? entry.children.length : undefined,
        indexRequestTime: entry.request_time ?? undefined,
        indexResponseTime: entry.response_time ?? undefined,
        indexHeaders: entry.response_headers ?? undefined,
        discordInfo: parseDiscordUrl(entry.url) ?? undefined,
      });
      recordChunkAssociations(resources[resources.length - 1], "index", {
        parentHeaderFile: resourceFiles[0]?.name,
        headerHex: resourceFiles[0] ? parseCacheHex(resourceFiles[0].name) : null,
      });
      createdFromIndex++;
      // Claim all files used by this resource so the heuristic fallback skips them
      for (const rf of resourceFiles) {
        indexClaimedFiles.add(rf.name);
      }
      console.log(`[CachePhoenix][DEBUG] Index resource CREATED: type=${resourceType}, category=${category}, files=${resourceFiles.length}, indexUrl=${entry.url?.slice(0,80)}, contentType=${entry.content_type}`);
    }
    console.log(`[CachePhoenix][DEBUG] === INDEX SECOND PASS SUMMARY: created=${createdFromIndex}, skippedEmpty=${skippedEmpty}, skippedNoFileType=${skippedNoFileType}, skippedNoFiles=${skippedNoFiles} ===`);
    console.log(`[CachePhoenix][DEBUG] === INDEX-BASED RESOURCE CREATION DONE: ${resources.length} resources, ${indexClaimedFiles.size} files claimed ===`);
    console.log(`[CachePhoenix][DEBUG] Sample resources with metadata:`, resources.slice(0,3).map(r => ({ id: r.id, indexUrl: r.indexUrl?.slice(0,60), indexContentType: r.indexContentType, discordInfo: !!r.discordInfo })));
  }

  for (let i = 0; i < blockfileFiles.length; i++) {
    const file = blockfileFiles[i];
    // Skip files already claimed by index-based processing, and skip index/data_N files
    if (indexClaimedFiles.has(file.name) || file.name === "index" || /^data_[0-3]$/.test(file.name)) {
      continue;
    }
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

  // ── Deduplicate MP4 header files ──────────────────────────────────────────
  // Chromium may cache the same video via different cache entries (e.g. range
  // requests), producing multiple f_XXXXXX files with identical ftyp+mdat
  // content.  If two headers share the same initial bytes they represent the
  // same video — keep only the one with the lowest hex number so that the
  // grouping walk below creates a single resource with all chunks.
  {
    const FINGERPRINT_LEN = 64; // enough to cover ftyp box + mdat header
    const fingerprints = new Map<string, Array<{ idx: number; hex: number }>>();
    for (let i = 0; i < mp4HeaderFiles.length; i++) {
      const entry = mp4HeaderFiles[i];
      const hex = parseCacheHex(entry.file.name);
      if (hex === null) continue;
      const slice = entry.data.slice(0, Math.min(FINGERPRINT_LEN, entry.data.length));
      const key = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join('');
      let group = fingerprints.get(key);
      if (!group) { group = []; fingerprints.set(key, group); }
      group.push({ idx: i, hex });
    }
    const demoted = new Set<number>();
    for (const group of fingerprints.values()) {
      if (group.length <= 1) continue;
      // Sort by hex ascending — keep the lowest, demote the rest
      group.sort((a, b) => a.hex - b.hex);
      for (let g = 1; g < group.length; g++) {
        demoted.add(group[g].idx);
        console.log(
          `[CachePhoenix] Demoting duplicate MP4 header ${mp4HeaderFiles[group[g].idx].file.name}` +
          ` (duplicate of ${mp4HeaderFiles[group[0].idx].file.name})`
        );
      }
    }
    if (demoted.size > 0) {
      // Move demoted headers to dataChunkFiles and filter mp4HeaderFiles in place
      const kept: typeof mp4HeaderFiles = [];
      for (let i = 0; i < mp4HeaderFiles.length; i++) {
        if (demoted.has(i)) {
          dataChunkFiles.push(mp4HeaderFiles[i].file);
        } else {
          kept.push(mp4HeaderFiles[i]);
        }
      }
      mp4HeaderFiles.length = 0;
      mp4HeaderFiles.push(...kept);
    }
  }

  onProgress?.({ phase: "grouping", current: 0, total: 0, currentFile: "" });

  // ── Separate standalone files into true-standalone vs Blockfile grouping candidates ──
  const trueStandalone: Array<{ file: CacheFileEntry; fileType: FileType }> = [];
  const blockfileStandalone: Array<{ file: CacheFileEntry; fileType: FileType; hex: number }> = [];
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
      // Blockfile file with a recognized type (image, complete video, etc.).
      // Keep it as a standalone candidate BUT also make it available for chunked
      // MP4 assembly — raw H.264 data chunks can be misidentified as JPEG/BMP/ICO
      // because the raw bytes happen to match those magic signatures.
      blockfileStandalone.push({ ...entry, hex });
    }
  }

  // ── Emit true standalone resources (non-blockfile = Simple Cache) ────────
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
    recordChunkAssociations(resources[resources.length - 1], "hex-proximity", {
      parentHeaderFile: file.name,
      headerHex: parseCacheHex(file.name),
    });
  }

  // ── Build unified Blockfile entry map for sequential grouping ─────────────
  // Pool sources: mp4HeaderFiles, dataChunkFiles (unidentified), blockfileGroupPool,
  //                blockfileStandalone (recognized types that may actually be raw video data)
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

  // Add blockfile standalone files (recognized types like jpeg/bmp/ico that may be
  // misidentified raw video data chunks — raw H.264 bytes can match magic signatures).
  // These are added to blockfileEntries so they're available for chunked MP4 assembly.
  // Unclaimed ones will be emitted as standalone resources after grouping.
  for (const { file, fileType, hex } of blockfileStandalone) {
    blockfileEntries.push({ hex, file, fileType });
  }

  // Sort all entries by hex number (ascending)
  blockfileEntries.sort((a, b) => a.hex - b.hex);

  // Helper: attach index metadata to a heuristic-created resource by looking up
  // any of its files in the indexEntryByFile map built during index processing.
  const attachIndexMetadata = (resource: CacheResource): void => {
    if (resource.indexUrl) return; // already has metadata
    // Try header file first, then any file in the resource
    const filesToCheck = resource.headerFile
      ? [resource.headerFile, ...resource.files.map(f => f.name)]
      : resource.files.map(f => f.name);
    for (const name of filesToCheck) {
      const entry = indexEntryByFile.get(name);
      if (entry) {
        resource.indexUrl = entry.url;
        resource.cacheDir = folderPath;
        resource.indexContentType = entry.content_type ?? undefined;
        resource.indexHttpStatus = entry.http_status ?? undefined;
        resource.indexOriginalFilename = entry.original_filename ?? undefined;
        resource.indexIsSparse = entry.is_sparse || undefined;
        resource.indexChildCount = entry.children.length > 0 ? entry.children.length : undefined;
        resource.indexRequestTime = entry.request_time ?? undefined;
        resource.indexResponseTime = entry.response_time ?? undefined;
        resource.indexHeaders = entry.response_headers ?? undefined;
        resource.discordInfo = parseDiscordUrl(entry.url) ?? undefined;
        // Try to get a better display name from index metadata
        if (entry.original_filename && (!resource.displayName || resource.displayName.startsWith('Video ') || resource.displayName.startsWith('Audio '))) {
          resource.displayName = entry.original_filename;
        } else if (entry.url && (!resource.displayName || resource.displayName.startsWith('Video ') || resource.displayName.startsWith('Audio '))) {
          try {
            const urlObj = new URL(stripCacheKeyPrefix(entry.url));
            const pathParts = urlObj.pathname.split('/').filter(Boolean);
            if (pathParts.length > 0) {
              const urlName = decodeURIComponent(pathParts[pathParts.length - 1]);
              if (urlName && urlName.length <= 100) resource.displayName = urlName;
            }
          } catch { /* keep existing displayName */ }
        }
        console.log(`[CachePhoenix] Attached index metadata to heuristic resource: ${entry.url.slice(0, 100)}`);
        return;
      }
    }
    // No match found in indexEntryByFile
    if (resource.mediaCategory === 'video') {
      console.warn(`[CachePhoenix] attachIndexMetadata MISS for video resource '${resource.displayName}': checked files [${filesToCheck.slice(0, 5).join(', ')}${filesToCheck.length > 5 ? '...' : ''}] (${filesToCheck.length} total). indexEntryByFile has ${indexEntryByFile.size} entries.`);
    }
  };
  const affinityByEtag = new Map<string, number[]>();
  const affinityByContentRange = new Map<number, number[]>();

  for (let i = 0; i < blockfileEntries.length; i++) {
    const entry = blockfileEntries[i];
    const indexEntry = indexEntryByFile.get(entry.file.name);
    if (!indexEntry?.response_headers) continue;

    const headers = indexEntry.response_headers;

    const etag = headers["etag"] || headers["ETag"];
    if (etag) {
      const group = affinityByEtag.get(etag) || [];
      group.push(i);
      affinityByEtag.set(etag, group);
    }

    const contentRange = headers["content-range"] || headers["Content-Range"];
    const contentRangeTotal = parseContentRangeTotal(contentRange);
    if (contentRangeTotal) {
      const group = affinityByContentRange.get(contentRangeTotal) || [];
      group.push(i);
      affinityByContentRange.set(contentRangeTotal, group);
    }
  }

  for (const [etag, indices] of affinityByEtag) {
    if (indices.length > 1) {
      const firstEntry = indexEntryByFile.get(blockfileEntries[indices[0]].file.name);
      debugData.affinityGroups.push({
        key: etag,
        method: "etag",
        fileNames: indices.map((idx) => blockfileEntries[idx].file.name),
        url: firstEntry?.url,
      });
    }
  }
  for (const [totalBytes, indices] of affinityByContentRange) {
    if (indices.length > 1) {
      debugData.affinityGroups.push({
        key: `${totalBytes} bytes`,
        method: "content-range-total",
        fileNames: indices.map((idx) => blockfileEntries[idx].file.name),
      });
    }
  }

  // ── Sequential grouping walk ──────────────────────────────────────────────
  // Media header types that start a new group
  const AUDIO_HEADER_TYPES = new Set<FileType>(["mp3", "ogg", "aac", "flac", "wav", "opus", "wma", "m4a"]);
  const VIDEO_HEADER_TYPES = new Set<FileType>(["webm_mkv", "avi", "flv", "mpeg_ts", "mov"]);

  // Content types that should NEVER be included in a video group, even if
  // their magic bytes were unrecognized (fileType === null).  Checked via
  // the blockfile index metadata (indexEntryByFile).
  const NON_MEDIA_CONTENT_TYPE_PREFIXES = [
    "font/", "text/", "application/javascript", "application/json",
    "application/xml", "application/wasm", "application/x-font",
    "application/font", "application/octet-stream",
  ];

  /** Check whether the blockfile index says this file is a non-media type. */
  function isKnownNonMedia(fileName: string): boolean {
    const entry = indexEntryByFile.get(fileName);
    if (!entry?.content_type) return false;
    const ct = entry.content_type.toLowerCase().split(";")[0].trim();
    // Positive media check — if the index says it's a media type, never exclude
    if (ct.startsWith("video/") || ct.startsWith("audio/") || ct.startsWith("image/")) return false;
    return NON_MEDIA_CONTENT_TYPE_PREFIXES.some(prefix => ct.startsWith(prefix));
  }

  const CHUNK_BLOCK_SIZE = 1_048_576; // 1 MB — Chromium's default block size

  function isMediaHeader(ft: FileType | null): boolean {
    if (ft === null) return false;
    if (ft === "mp4_header_only") return true;
    return AUDIO_HEADER_TYPES.has(ft) || VIDEO_HEADER_TYPES.has(ft);
  }

  /**
   * A file classified as mp4_complete at exactly CHUNK_BLOCK_SIZE is likely the
   * first 1 MB chunk of a larger chunked video, not a standalone complete MP4.
   * Treat it as a potential media header so it can start its own group.
   */
  function isSuspectChunkedMP4Complete(entry: { fileType: FileType | null; file: CacheFileEntry }): boolean {
    return entry.fileType === "mp4_complete" && entry.file.size === CHUNK_BLOCK_SIZE;
  }

  function isContinuationChunk(ft: FileType | null): boolean {
    return ft === null || ft === "mp4_fragment" || ft === "webm_continuation" || ft === "media_data_chunk";
  }

  const claimed = new Set<number>(); // track claimed entry indices

  // Walk through and group: header + subsequent continuation chunks
  for (let i = 0; i < blockfileEntries.length; i++) {
    if (claimed.has(i)) continue;
    const entry = blockfileEntries[i];

    if (!isMediaHeader(entry.fileType) && !isSuspectChunkedMP4Complete(entry)) continue;

    // Found a media header — collect continuation chunks
    claimed.add(i);

    if (entry.fileType === "mp4_header_only" && entry.mp4Data) {
      // ── MP4 header: use existing assembleChunkedMP4 for reconstruction ────
      // Only include unidentified chunks and known MP4 continuation types.
      // Exclude files identified as standalone media (WebM, images, audio, etc.)
      // because they are NOT continuation data for this MP4.
      const headerIndexEntry = indexEntryByFile.get(entry.file.name);
      let affinityIndices: Set<number> | null = null;
      let chunkMethod: ChunkAssociationDebug["method"] = "hex-proximity";
      let relevantEtag: string | undefined;
      let relevantContentRangeTotal: number | undefined;

      if (headerIndexEntry?.response_headers) {
        const headers = headerIndexEntry.response_headers;
        const etag = headers["etag"] || headers["ETag"];
        const etagGroup = etag ? affinityByEtag.get(etag) : undefined;
        if (etag && etagGroup && etagGroup.length > 1) {
          affinityIndices = new Set(etagGroup);
          chunkMethod = "etag";
          relevantEtag = etag;
          console.log(`[CachePhoenix] Using etag affinity for ${entry.file.name}: ${affinityIndices.size} members with etag=${etag}`);
        }

        if (!affinityIndices) {
          const contentRange = headers["content-range"] || headers["Content-Range"];
          const totalBytes = parseContentRangeTotal(contentRange);
          const contentRangeGroup = totalBytes ? affinityByContentRange.get(totalBytes) : undefined;
          if (totalBytes && contentRangeGroup && contentRangeGroup.length > 1) {
            affinityIndices = new Set(contentRangeGroup);
            chunkMethod = "content-range";
            relevantContentRangeTotal = totalBytes;
            console.log(`[CachePhoenix] Using content-range affinity for ${entry.file.name}: ${affinityIndices.size} members with total=${totalBytes}`);
          }
        }
      }

      if (!affinityIndices) {
        console.log(`[CachePhoenix] No affinity group for ${entry.file.name}; falling back to hex-proximity chunking`);
      }

      const availableChunks: CacheFileEntry[] = [];
      for (let j = 0; j < blockfileEntries.length; j++) {
        if (claimed.has(j)) continue;
        const ft = blockfileEntries[j].fileType;
        // null = unidentified raw data (likely video payload), mp4_fragment/media_data_chunk = known continuation
        if (ft !== null && ft !== "mp4_fragment" && ft !== "media_data_chunk") continue;

        // Exclude files the index identifies as non-media (font, CSS, JS, etc.)
        if (isKnownNonMedia(blockfileEntries[j].file.name)) continue;

        if (affinityIndices && !affinityIndices.has(j)) continue;

        availableChunks.push(blockfileEntries[j].file);
      }
      const totalUnclaimed = blockfileEntries.filter((_, j) => !claimed.has(j)).length;
      const filteredOut = totalUnclaimed - availableChunks.length;
      if (filteredOut > 0) {
        console.log(`[CachePhoenix] MP4 chunk filter for ${entry.file.name}: ${availableChunks.length} available of ${totalUnclaimed} unclaimed (${filteredOut} standalone files excluded)`);
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
        attachIndexMetadata(resource);
        resources.push(resource);
        recordChunkAssociations(resources[resources.length - 1], chunkMethod, {
          etag: relevantEtag,
          contentRangeTotal: relevantContentRangeTotal,
          parentHeaderFile: entry.file.name,
          headerHex: entry.hex,
        });
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
        attachIndexMetadata(resources[resources.length - 1]);
        recordChunkAssociations(resources[resources.length - 1], chunkMethod, {
          etag: relevantEtag,
          contentRangeTotal: relevantContentRangeTotal,
          parentHeaderFile: entry.file.name,
          headerHex: entry.hex,
        });
      }
    } else if (isSuspectChunkedMP4Complete(entry)) {
      // ── Suspect chunked mp4_complete: 1 MB file with ftyp+moov+mdat ───────
      // A 1 MB file that happens to contain all three MP4 atoms is very likely
      // the first chunk of a larger chunked video (Chromium splits at 1 MB),
      // not a standalone complete MP4.  Collect tightly sequential unclaimed
      // chunks after it as continuation data.
      const groupFiles: CacheFileEntry[] = [entry.file];
      const headerHex = entry.hex;
      let chunkMethod: ChunkAssociationDebug["method"] = "hex-proximity";
      let relevantEtag: string | undefined;
      let relevantContentRangeTotal: number | undefined;

      // Try affinity group (etag / content-range) from index metadata
      const headerIndexEntry = indexEntryByFile.get(entry.file.name);
      let affinityIndices: Set<number> | null = null;
      if (headerIndexEntry?.response_headers) {
        const headers = headerIndexEntry.response_headers;
        const etag = headers["etag"] || headers["ETag"];
        const etagGroup = etag ? affinityByEtag.get(etag) : undefined;
        if (etag && etagGroup && etagGroup.length > 1) {
          affinityIndices = new Set(etagGroup);
          chunkMethod = "etag";
          relevantEtag = etag;
        }
        if (!affinityIndices) {
          const contentRange = headers["content-range"] || headers["Content-Range"];
          const totalBytes = parseContentRangeTotal(contentRange);
          const contentRangeGroup = totalBytes ? affinityByContentRange.get(totalBytes) : undefined;
          if (totalBytes && contentRangeGroup && contentRangeGroup.length > 1) {
            affinityIndices = new Set(contentRangeGroup);
            chunkMethod = "content-range";
            relevantContentRangeTotal = totalBytes;
          }
        }
      }

      // Collect continuation chunks — use affinity if available, else tight hex proximity
      const MAX_HEX_GAP = 50;
      for (let j = i + 1; j < blockfileEntries.length; j++) {
        if (claimed.has(j)) continue;
        const next = blockfileEntries[j];

        // Stop at another media header or suspect chunked header
        if (isMediaHeader(next.fileType) || isSuspectChunkedMP4Complete(next)) break;

        // Hex proximity gate (even with affinity, don't reach too far)
        if (next.hex - headerHex > MAX_HEX_GAP) break;

        // Exclude files the index identifies as non-media
        if (isKnownNonMedia(next.file.name)) continue;

        // Affinity gate
        if (affinityIndices && !affinityIndices.has(j)) continue;

        // Only collect unidentified data / known continuation types
        if (isContinuationChunk(next.fileType)) {
          claimed.add(j);
          groupFiles.push(next.file);
        }
      }

      resourceIdx++;
      const totalSize = groupFiles.reduce((sum, f) => sum + f.size, 0);
      const rType: FileType = groupFiles.length > 1 ? "mp4_chunked" : "mp4_complete";
      resources.push({
        id: generateId(),
        resourceType: rType,
        mediaCategory: "video",
        files: groupFiles,
        headerFile: entry.file.name,
        totalSize,
        displayName: groupFiles.length > 1 ? `Video ${resourceIdx} (chunked)` : `Video ${resourceIdx}`,
        modifiedAt: Math.max(...groupFiles.map(f => f.modified_at || 0)),
        selected: false,
      });
      attachIndexMetadata(resources[resources.length - 1]);
      recordChunkAssociations(resources[resources.length - 1], chunkMethod, {
        etag: relevantEtag,
        contentRangeTotal: relevantContentRangeTotal,
        parentHeaderFile: entry.file.name,
        headerHex,
      });
    } else {
      // ── Non-MP4 media header (WebM, audio, etc.): sequential chunk collection ──
      const groupFiles: CacheFileEntry[] = [entry.file];
      const headerHex = entry.hex;
      let chunkMethod: ChunkAssociationDebug["method"] = "hex-proximity";
      let relevantEtag: string | undefined;
      let relevantContentRangeTotal: number | undefined;

      // Try affinity group (etag / content-range) from index metadata
      const headerIndexEntry = indexEntryByFile.get(entry.file.name);
      let affinityIndices: Set<number> | null = null;
      if (headerIndexEntry?.response_headers) {
        const headers = headerIndexEntry.response_headers;
        const etag = headers["etag"] || headers["ETag"];
        const etagGroup = etag ? affinityByEtag.get(etag) : undefined;
        if (etag && etagGroup && etagGroup.length > 1) {
          affinityIndices = new Set(etagGroup);
          chunkMethod = "etag";
          relevantEtag = etag;
          console.log(`[CachePhoenix] Using etag affinity for non-MP4 header ${entry.file.name}: ${affinityIndices.size} members`);
        }
        if (!affinityIndices) {
          const contentRange = headers["content-range"] || headers["Content-Range"];
          const totalBytes = parseContentRangeTotal(contentRange);
          const contentRangeGroup = totalBytes ? affinityByContentRange.get(totalBytes) : undefined;
          if (totalBytes && contentRangeGroup && contentRangeGroup.length > 1) {
            affinityIndices = new Set(contentRangeGroup);
            chunkMethod = "content-range";
            relevantContentRangeTotal = totalBytes;
            console.log(`[CachePhoenix] Using content-range affinity for non-MP4 header ${entry.file.name}: ${affinityIndices.size} members`);
          }
        }
      }

      // Collect subsequent continuation chunks.
      // Use a tight hex proximity limit to avoid grabbing unrelated files.
      // Real chunked video chunks are tightly sequential (gap of 1-2 per chunk).
      const MAX_HEX_GAP = 50;
      for (let j = i + 1; j < blockfileEntries.length; j++) {
        if (claimed.has(j)) continue;
        const next = blockfileEntries[j];

        // Stop if we hit another media header or suspect chunked mp4
        if (isMediaHeader(next.fileType) || isSuspectChunkedMP4Complete(next)) break;

        // Hex proximity gate — tightened from 500 to 50
        if (next.hex - headerHex > MAX_HEX_GAP) break;

        // Exclude files the index identifies as non-media (font, CSS, JS, etc.)
        if (isKnownNonMedia(next.file.name)) continue;

        // Affinity gate — if we have affinity info, only collect matching chunks
        if (affinityIndices && !affinityIndices.has(j)) continue;

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
      attachIndexMetadata(resources[resources.length - 1]);
      recordChunkAssociations(resources[resources.length - 1], chunkMethod, {
        etag: relevantEtag,
        contentRangeTotal: relevantContentRangeTotal,
        parentHeaderFile: entry.file.name,
        headerHex,
      });
    }
  }

  // ── Remaining unclaimed Blockfile chunks ─────────────────────────────────────
  // Blockfile standalone entries that were NOT claimed by a chunked group should
  // be emitted as standalone resources with their detected file type.
  // Truly unidentified chunks (fileType === null) go to the catch-all bucket.
  const blockfileStandaloneNames = new Set(blockfileStandalone.map(e => e.file.name));
  const unidentifiedChunks: CacheFileEntry[] = [];
  for (let i = 0; i < blockfileEntries.length; i++) {
    if (claimed.has(i)) continue;
    const entry = blockfileEntries[i];
    if (blockfileStandaloneNames.has(entry.file.name) && entry.fileType !== null) {
      // Unclaimed blockfile standalone — emit as its detected type
      resourceIdx++;
      const category = getMediaCategory(entry.fileType);
      resources.push({
        id: generateId(),
        resourceType: entry.fileType,
        mediaCategory: category,
        files: [entry.file],
        totalSize: entry.file.size,
        displayName: `${category === "image" ? "Image" : category === "video" ? "Video" : category === "audio" ? "Audio" : "File"} ${resourceIdx}`,
        modifiedAt: entry.file.modified_at,
        selected: false,
      });
      recordChunkAssociations(resources[resources.length - 1], "hex-proximity", {
        parentHeaderFile: entry.file.name,
        headerHex: entry.hex,
      });
    } else {
      unidentifiedChunks.push(entry.file);
    }
  }

  if (unidentifiedChunks.length > 0) {
    resources.push({
      id: generateId(),
      resourceType: "unknown_data",
      mediaCategory: "other",
      files: unidentifiedChunks,
      totalSize: unidentifiedChunks.reduce((sum, f) => sum + f.size, 0),
      displayName: `Unidentified chunks (${unidentifiedChunks.length})`,
      modifiedAt: Math.max(...unidentifiedChunks.map(f => f.modified_at || 0)),
      selected: false,
    });
    recordChunkAssociations(resources[resources.length - 1], "unclaimed");
  }



  // ── Post-processing: deduplicate resources with the same indexUrl ──────────
  // The index-first path creates authoritative resources, but edge cases
  // (non-sparse entries, heuristic grouping with attachIndexMetadata) can
  // produce duplicate resources for the same URL. Merge them: prefer the
  // index-created resource and absorb any extra files from heuristic ones.
  {
    const urlToIdx = new Map<string, number>();
    const toRemove = new Set<number>();
    for (let i = 0; i < resources.length; i++) {
      const url = resources[i].indexUrl;
      if (!url) continue;
      const existing = urlToIdx.get(url);
      if (existing !== undefined) {
        // Prefer the one with more metadata (index-created)
        const keep = resources[existing].indexIsSparse || resources[existing].indexChildCount ? existing : i;
        const drop = keep === existing ? i : existing;
        // Merge files from dropped resource into kept one (avoid duplicates)
        const keepRes = resources[keep];
        const dropRes = resources[drop];
        const existingFileNames = new Set(keepRes.files.map(f => f.name));
        for (const f of dropRes.files) {
          if (!existingFileNames.has(f.name)) {
            keepRes.files.push(f);
          }
        }
        // Update totalSize if the kept resource had no files but the dropped one did
        if (keepRes.files.length > 0 && keepRes.totalSize === 0) {
          keepRes.totalSize = keepRes.files.reduce((sum, f) => sum + f.size, 0);
        }
        toRemove.add(drop);
        urlToIdx.set(url, keep);
        console.log(`[CachePhoenix] Deduplicated resource: merged '${dropRes.displayName}' into '${keepRes.displayName}' (url=${url.slice(0, 80)})`);
      } else {
        urlToIdx.set(url, i);
      }
    }
    if (toRemove.size > 0) {
      const before = resources.length;
      // Remove in reverse order to keep indices valid
      const sortedRemoveIndices = Array.from(toRemove).sort((a, b) => b - a);
      for (const idx of sortedRemoveIndices) {
        resources.splice(idx, 1);
      }
      console.log(`[CachePhoenix] Deduplication removed ${before - resources.length} duplicate resources`);
    }
  }

  // Generate preview thumbnails for single-file images and videos
  await generatePreviewThumbnails(resources, onProgress);

  onProgress?.({ phase: "done", current: total, total, currentFile: "" });

  console.log(`[CachePhoenix][DEBUG] === scanCacheFolder RETURNING ${resources.length} resources ===`);
  const metaCount = resources.filter(r => r.indexUrl || r.indexContentType).length;
  console.log(`[CachePhoenix][DEBUG] Resources with metadata: ${metaCount}/${resources.length}`);
  // Populate claimed files lists for debug export
  debugData.indexClaimedFiles = Array.from(indexClaimedFiles);
  debugData.heuristicClaimedFiles = Array.from(claimed).map(i => blockfileEntries[i]?.file.name).filter(Boolean);

  debugData.stats = {
    totalFiles: total,
    blockfileFiles: blockfileFiles.length,
    simpleCacheFiles: simpleCacheMap.size,
    indexEntries: blockfileIndex?.entries.length ?? 0,
    indexClaimedFiles: indexClaimedFiles.size,
    heuristicGroupedFiles: claimed.size,
    unclaimedFiles: unidentifiedChunks.length,
    resourcesCreated: resources.length,
    resourcesWithMetadata: resources.filter(r => r.indexUrl || r.indexContentType).length,
  };

  return { resources, debugData };
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
