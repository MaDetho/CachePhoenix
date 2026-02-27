export type FileType =
  // ── Images ──────────────────────────────────────────────────────
  | "png"
  | "jpeg"
  | "gif"
  | "webp"
  | "bmp"
  | "tiff"
  | "ico"
  | "avif"
  | "heic"
  // ── Video ───────────────────────────────────────────────────────
  | "mp4_complete"
  | "mp4_chunked"
  | "mp4_header_only"
  | "webm_mkv"
  | "avi"
  | "flv"
  | "mpeg_ts"
  | "wmv"
  | "mov"
  | "mp4_fragment"
  | "webm_continuation"
  // ── Audio ───────────────────────────────────────────────────────
  | "mp3"
  | "aac"
  | "ogg"
  | "flac"
  | "wav"
  | "opus"
  | "wma"
  | "m4a"
  // ── Fallback ────────────────────────────────────────────────────
  | "unknown_data"
  | "riff_unknown"
  | "media_data_chunk";

export type MediaCategory = "image" | "video" | "audio" | "other";

export interface CacheFileEntry {
  name: string;
  path: string;
  size: number;
  modified_at?: number;
}

export interface CachePathInfo {
  path: string;
  exists: boolean;
  file_count: number;
  total_size: number;
  client_name: string;
}

export interface ScannedFile {
  name: string;
  path: string;
  size: number;
  fileType: FileType;
  mediaCategory: MediaCategory;
  thumbnailPath?: string;
  previewable: boolean;
}

export interface CacheResource {
  id: string;
  resourceType: FileType;
  mediaCategory: MediaCategory;
  files: CacheFileEntry[];
  headerFile?: string;
  tailFile?: string;
  totalSize: number;
  displayName: string;
  thumbnailPath?: string;
  previewUrl?: string;
  videoInfo?: VideoInfo;
  modifiedAt?: number;
  selected: boolean;
}

export interface VideoInfo {
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string;
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface RecoveryOptions {
  outputFolder: string;
  convertWebmToMp4: boolean;
  organizeByType: boolean;
  organizeByDate: boolean;
  generateThumbnails: boolean;
  convertGifToMp4: boolean;
  concatenateVideos: boolean;
}

export interface RecoveryProgress {
  current: number;
  total: number;
  currentFile: string;
  phase: "copying" | "reconstructing" | "encoding" | "validating" | "complete";
  log: string[];
  errors: string[];
}

export interface AppSettings {
  maxThreads: number;
  outputNamingTemplate: string;
  autoOpenOutput: boolean;
  defaultOutputFolder: string;
  theme: "dark" | "light";
}

export type AppPage = "scanner" | "settings";

export type ScannerStep = "select" | "scanning" | "results" | "recovery" | "complete";

export type FilterCategory = "all" | "images" | "videos" | "audio" | "other";

export type SortOrder = "newest" | "oldest";
