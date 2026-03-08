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
  /** URL from blockfile index — if set, recovery uses reconstruct_from_index */
  indexUrl?: string;
  /** Cache directory path — needed for reconstruct_from_index */
  cacheDir?: string;
  /** Content-Type from blockfile index HTTP headers */
  indexContentType?: string;
  /** HTTP status line from blockfile index */
  indexHttpStatus?: string;
  /** Original filename from Content-Disposition header */
  indexOriginalFilename?: string;
  /** Whether the entry uses sparse/range-request storage */
  indexIsSparse?: boolean;
  /** Number of sparse children (range-request chunks) */
  indexChildCount?: number;
  /** HTTP request timestamp from cache metadata (unix seconds) */
  indexRequestTime?: number;
  /** HTTP response timestamp from cache metadata (unix seconds) */
  indexResponseTime?: number;
  /** All HTTP response headers as key-value pairs */
  indexHeaders?: Record<string, string>;
  /** Parsed Discord-specific metadata from the source URL */
  discordInfo?: DiscordInfo;
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

// ── Discord URL Metadata ───────────────────────────────────────────────────

export interface DiscordInfo {
  /** Type of Discord resource */
  type: 'attachment' | 'ephemeral_attachment' | 'avatar' | 'emoji' | 'sticker' | 'external_proxy' | 'other';
  /** Original filename from URL path (decoded) */
  filename?: string;
  /** Channel Snowflake ID (for attachments) */
  channelId?: string;
  /** Attachment/resource Snowflake ID */
  resourceId?: string;
  /** User ID (for avatars) */
  userId?: string;
  /** Upload/creation timestamp derived from Snowflake ID (ms since Unix epoch) */
  uploadedAt?: number;
  /** Channel creation timestamp from channel Snowflake (ms since Unix epoch) */
  channelCreatedAt?: number;
  /** URL expiry timestamp (ms since Unix epoch, from `ex` query param) */
  expiresAt?: number;
  /** URL issued timestamp (ms since Unix epoch, from `is` query param) */
  issuedAt?: number;
  /** Whether the URL is served through media proxy vs direct CDN */
  isMediaProxy: boolean;
  /** The full URL without HMAC signature */
  cleanUrl?: string;
}

// ── Blockfile Index Parser Types ─────────────────────────────────────────────

export interface BlockfileDataRef {
  stream_index: number;
  file_path: string;
  offset: number;
  size: number;
  is_external: boolean;
}

export interface BlockfileSparseChild {
  child_id: number;
  offset_bytes: number;
  data_ref: BlockfileDataRef;
}

export interface BlockfileCacheEntry {
  url: string;
  content_type: string | null;
  content_length: number | null;
  original_filename: string | null;
  http_status: string | null;
  creation_time: number | null;
  request_time: number | null;
  response_time: number | null;
  response_headers: Record<string, string> | null;
  state: number;
  flags: number;
  data_files: BlockfileDataRef[];
  body_size: number;
  is_sparse: boolean;
  children: BlockfileSparseChild[];
}

export interface BlockfileIndexResult {
  entries: BlockfileCacheEntry[];
  entry_count: number;
  version: number;
  errors: string[];
  /** Sparse child-to-parent linking diagnostics */
  sparse_linking_stats: {
    total_children_linked: number;
    orphaned_groups: number;
    orphaned_children_total: number;
    unmatched_parents: number;
    /** Details of orphaned child groups (parent URL → child count) */
    orphaned_details: Array<{ parent_url: string; child_count: number }>;
    /** Sparse parents with 0 matched children */
    unmatched_parent_urls: string[];
  };
}

// ── Debug / Metadata Dump Types ──────────────────────────────────────────────

/** Tracks why a chunk was associated with a particular resource during scanning. */
export interface ChunkAssociationDebug {
  /** The cache file name (e.g. f_000a1b) */
  fileName: string;
  /** Hex number parsed from filename */
  hexValue: number;
  /** How this chunk was associated: 'index' | 'etag' | 'content-range' | 'hex-proximity' | 'unclaimed' */
  method: 'index' | 'etag' | 'content-range' | 'hex-proximity' | 'unclaimed';
  /** The etag value if used for association */
  etag?: string;
  /** The content-range total size if used for association */
  contentRangeTotal?: number;
  /** The parent resource's header file name */
  parentHeaderFile?: string;
  /** Hex distance from the header file */
  hexDistance?: number;
}

/** Full scan debug data returned alongside resources. */
export interface ScanDebugData {
  /** Raw blockfile index result (null if no blockfile cache or parse failed) */
  blockfileIndex: BlockfileIndexResult | null;
  /** Per-resource chunk association reasoning */
  chunkAssociations: Record<string, ChunkAssociationDebug[]>;
  /** Files that were in the index but skipped (with reason and full entry data) */
  skippedEntries: Array<{
    url: string;
    reason: string;
    contentType?: string;
    bodySize?: number;
    fileCount?: number;
    /** Full index entry data for this skipped entry */
    entry?: BlockfileCacheEntry;
  }>;
  /** Affinity groups built from etag/content-range (before hex fallback) */
  affinityGroups: Array<{
    key: string;
    method: 'etag' | 'content-range-total';
    fileNames: string[];
    url?: string;
  }>;
  /** Mapping of cache filenames to their index entry's URL and content type */
  fileToEntryMap: Record<string, { url: string; contentType: string | null; isSparse: boolean; childCount: number }>;
  /** Files claimed by index-based resource creation */
  indexClaimedFiles: string[];
  /** Files claimed by heuristic grouping (hex-proximity, etag, content-range) */
  heuristicClaimedFiles: string[];
  /** Summary statistics */
  stats: {
    totalFiles: number;
    blockfileFiles: number;
    simpleCacheFiles: number;
    indexEntries: number;
    indexClaimedFiles: number;
    heuristicGroupedFiles: number;
    unclaimedFiles: number;
    resourcesCreated: number;
    resourcesWithMetadata: number;
  };
}
