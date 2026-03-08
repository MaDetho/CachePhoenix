use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// CacheAddr constants
// ---------------------------------------------------------------------------

const INITIALIZED_MASK: u32 = 0x80000000;
const FILE_TYPE_MASK: u32 = 0x70000000;
const FILE_TYPE_SHIFT: u32 = 28;
const _NUM_BLOCKS_MASK: u32 = 0x03000000;
const _NUM_BLOCKS_SHIFT: u32 = 24;
const FILE_SELECTOR_MASK: u32 = 0x00FF0000;
const FILE_SELECTOR_SHIFT: u32 = 16;
const START_BLOCK_MASK: u32 = 0x0000FFFF;
const EXTERNAL_FILE_MASK: u32 = 0x0FFFFFFF;

const INDEX_MAGIC: u32 = 0xC103CAC3;
const BLOCK_MAGIC: u32 = 0xC104CAC3;

const INDEX_HEADER_SIZE: usize = 368; // 256 IndexHeader + 112 LruData
const BLOCK_HEADER_SIZE: u64 = 8192;

// ---------------------------------------------------------------------------
// CacheAddr
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct CacheAddr(u32);

#[allow(dead_code)]
impl CacheAddr {
    fn is_initialized(&self) -> bool {
        (self.0 & INITIALIZED_MASK) != 0
    }

    /// 0=external, 1=rankings, 2=BLOCK_256, 3=BLOCK_1K, 4=BLOCK_4K
    fn file_type(&self) -> u32 {
        (self.0 & FILE_TYPE_MASK) >> FILE_TYPE_SHIFT
    }

    fn is_external(&self) -> bool {
        self.file_type() == 0
    }

    /// For external (type 0) files only.
    fn file_number(&self) -> u32 {
        self.0 & EXTERNAL_FILE_MASK
    }

    /// For block (type != 0) files.
    fn file_selector(&self) -> u32 {
        (self.0 & FILE_SELECTOR_MASK) >> FILE_SELECTOR_SHIFT
    }

    /// For block files.
    fn start_block(&self) -> u32 {
        self.0 & START_BLOCK_MASK
    }

    /// For block files — number of contiguous blocks (1-4).
    fn num_blocks(&self) -> u32 {
        ((self.0 & _NUM_BLOCKS_MASK) >> _NUM_BLOCKS_SHIFT) + 1
    }

    /// Resolve to a file path under `cache_dir`.
    fn to_file_path(&self, cache_dir: &Path) -> PathBuf {
        if self.is_external() {
            cache_dir.join(format!("f_{:06x}", self.file_number()))
        } else {
            cache_dir.join(format!("data_{}", self.file_selector()))
        }
    }

    /// Byte offset within the block file where data starts.
    fn byte_offset(&self, entry_size: u32) -> u64 {
        BLOCK_HEADER_SIZE + self.start_block() as u64 * entry_size as u64
    }

    /// Total allocated data length in the block file.
    fn data_length(&self, entry_size: u32) -> u64 {
        self.num_blocks() as u64 * entry_size as u64
    }
}

// ---------------------------------------------------------------------------
// Output structs (JSON-serializable)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
pub struct BlockfileCacheEntry {
    pub url: String,
    pub content_type: Option<String>,
    pub content_length: Option<u64>,
    pub original_filename: Option<String>,
    pub http_status: Option<String>,
    pub creation_time: Option<f64>,
    /// HTTP request timestamp from cache metadata (unix seconds)
    pub request_time: Option<f64>,
    /// HTTP response timestamp from cache metadata (unix seconds)
    pub response_time: Option<f64>,
    /// All parsed HTTP response headers as key-value pairs
    pub response_headers: Option<std::collections::HashMap<String, String>>,
    pub state: u32,
    pub flags: u32,
    pub data_files: Vec<BlockfileDataRef>,
    pub body_size: u64,
    pub is_sparse: bool,
    pub children: Vec<BlockfileSparseChild>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BlockfileDataRef {
    pub stream_index: u32,
    pub file_path: String,
    pub offset: u64,
    pub size: u64,
    pub is_external: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BlockfileSparseChild {
    pub child_id: u64,
    pub offset_bytes: u64,
    pub data_ref: BlockfileDataRef,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SparseLinkingStats {
    pub total_children_linked: usize,
    pub orphaned_groups: usize,
    pub orphaned_children_total: usize,
    pub unmatched_parents: usize,
    pub orphaned_details: Vec<OrphanedChildGroup>,
    pub unmatched_parent_urls: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OrphanedChildGroup {
    pub parent_url: String,
    pub child_count: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BlockfileIndexResult {
    pub entries: Vec<BlockfileCacheEntry>,
    pub entry_count: u32,
    pub version: u32,
    pub errors: Vec<String>,
    pub sparse_linking_stats: SparseLinkingStats,
}

// ---------------------------------------------------------------------------
// Internal: raw entry store fields
// ---------------------------------------------------------------------------

struct RawEntry {
    _hash: u32,
    next: CacheAddr,
    _rankings_node: CacheAddr,
    _reuse_count: u32,
    _refetch_count: u32,
    state: u32,
    creation_time: u64,
    key_len: u32,
    long_key: CacheAddr,
    data_size: [i32; 4],
    data_addr: [CacheAddr; 4],
    flags: u32,
    _self_hash: u32,
    key_data: Vec<u8>,
}

// ---------------------------------------------------------------------------
// Block file header cache
// ---------------------------------------------------------------------------

struct BlockFileInfo {
    entry_size: u32,
    data: Vec<u8>,
}

struct BlockFileCache {
    files: HashMap<PathBuf, BlockFileInfo>,
}

impl BlockFileCache {
    fn new() -> Self {
        Self {
            files: HashMap::new(),
        }
    }

    fn get_or_load(&mut self, path: &Path, errors: &mut Vec<String>) -> Option<&BlockFileInfo> {
        if !self.files.contains_key(path) {
            match fs::read(path) {
                Ok(data) => {
                    if data.len() < BLOCK_HEADER_SIZE as usize {
                        errors.push(format!(
                            "Block file too small: {} ({} bytes)",
                            path.display(),
                            data.len()
                        ));
                        return None;
                    }
                    let magic = read_u32_le(&data, 0);
                    if magic != BLOCK_MAGIC {
                        errors.push(format!(
                            "Bad block magic in {}: 0x{:08X}",
                            path.display(),
                            magic
                        ));
                        return None;
                    }
                    let entry_size = read_u32_le(&data, 0x0C);
                    self.files
                        .insert(path.to_path_buf(), BlockFileInfo { entry_size, data });
                }
                Err(e) => {
                    errors.push(format!("Cannot read block file {}: {}", path.display(), e));
                    return None;
                }
            }
        }
        self.files.get(path)
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn read_u32_le(buf: &[u8], offset: usize) -> u32 {
    if offset + 4 > buf.len() {
        return 0;
    }
    u32::from_le_bytes([
        buf[offset],
        buf[offset + 1],
        buf[offset + 2],
        buf[offset + 3],
    ])
}

fn read_i32_le(buf: &[u8], offset: usize) -> i32 {
    if offset + 4 > buf.len() {
        return 0;
    }
    i32::from_le_bytes([
        buf[offset],
        buf[offset + 1],
        buf[offset + 2],
        buf[offset + 3],
    ])
}

fn read_u64_le(buf: &[u8], offset: usize) -> u64 {
    if offset + 8 > buf.len() {
        return 0;
    }
    u64::from_le_bytes([
        buf[offset],
        buf[offset + 1],
        buf[offset + 2],
        buf[offset + 3],
        buf[offset + 4],
        buf[offset + 5],
        buf[offset + 6],
        buf[offset + 7],
    ])
}

fn read_i64_le(buf: &[u8], offset: usize) -> i64 {
    if offset + 8 > buf.len() {
        return 0;
    }
    i64::from_le_bytes([
        buf[offset],
        buf[offset + 1],
        buf[offset + 2],
        buf[offset + 3],
        buf[offset + 4],
        buf[offset + 5],
        buf[offset + 6],
        buf[offset + 7],
    ])
}

fn filetime_to_unix(ft: u64) -> f64 {
    (ft as f64 / 1_000_000.0) - 11_644_473_600.0
}

/// Read bytes from a CacheAddr location, respecting data_size.
fn read_stream_data(
    addr: CacheAddr,
    size: u32,
    cache_dir: &Path,
    block_cache: &mut BlockFileCache,
    errors: &mut Vec<String>,
) -> Option<Vec<u8>> {
    if !addr.is_initialized() || size == 0 {
        return None;
    }

    let path = addr.to_file_path(cache_dir);

    if addr.is_external() {
        // External file — read size bytes from offset 0
        match fs::read(&path) {
            Ok(data) => {
                let end = (size as usize).min(data.len());
                Some(data[..end].to_vec())
            }
            Err(e) => {
                errors.push(format!(
                    "Cannot read external file {}: {}",
                    path.display(),
                    e
                ));
                None
            }
        }
    } else {
        // Block file — look up entry_size, compute offset
        let info = block_cache.get_or_load(&path, errors)?;
        let entry_size = info.entry_size;
        let offset = addr.byte_offset(entry_size) as usize;
        let end = offset + size as usize;
        if end > info.data.len() {
            errors.push(format!(
                "Block read out of bounds in {}: offset={} size={} file_len={}",
                path.display(),
                offset,
                size,
                info.data.len()
            ));
            // Read as much as we can
            let available_end = info.data.len().min(end);
            if offset < available_end {
                Some(info.data[offset..available_end].to_vec())
            } else {
                None
            }
        } else {
            Some(info.data[offset..end].to_vec())
        }
    }
}

/// Parse an EntryStore from raw bytes (may span 1-4 contiguous 256-byte blocks).
/// The first 256 bytes contain the fixed header; bytes 0x60+ hold the inline key.
/// When key_len > 160, the key extends into subsequent blocks (up to 863 bytes inline).
fn parse_entry_store(buf: &[u8]) -> Option<RawEntry> {
    if buf.len() < 256 {
        return None;
    }
    let hash = read_u32_le(buf, 0x00);
    let next = CacheAddr(read_u32_le(buf, 0x04));
    let rankings_node = CacheAddr(read_u32_le(buf, 0x08));
    let reuse_count = read_u32_le(buf, 0x0C);
    let refetch_count = read_u32_le(buf, 0x10);
    let state = read_u32_le(buf, 0x14);
    let creation_time = read_u64_le(buf, 0x18);
    let key_len = read_u32_le(buf, 0x20);
    let long_key = CacheAddr(read_u32_le(buf, 0x24));

    let mut data_size = [0i32; 4];
    for i in 0..4 {
        data_size[i] = read_i32_le(buf, 0x28 + i * 4);
    }
    let mut data_addr = [CacheAddr(0); 4];
    for i in 0..4 {
        data_addr[i] = CacheAddr(read_u32_le(buf, 0x38 + i * 4));
    }

    let flags = read_u32_le(buf, 0x48);
    let self_hash = read_u32_le(buf, 0x5C);

    // Key data starts at offset 0x60 and can extend beyond 256 bytes
    // when the entry spans multiple contiguous blocks (up to 4 * 256 = 1024 bytes total).
    // Max inline key = 4 * 256 - 0x60 - 1 = 863 bytes.
    let key_start = 0x60;
    let key_data = buf[key_start..].to_vec();

    Some(RawEntry {
        _hash: hash,
        next,
        _rankings_node: rankings_node,
        _reuse_count: reuse_count,
        _refetch_count: refetch_count,
        state,
        creation_time,
        key_len,
        long_key,
        data_size,
        data_addr,
        flags,
        _self_hash: self_hash,
        key_data,
    })
}

/// Read the URL key for an entry.
/// Chromium stores keys in three ways:
/// 1. Inline short key (key_len <= 160): fits in the first EntryStore block's key_data area
/// 2. Inline long key (161 <= key_len <= 863): spans across 2-4 contiguous EntryStore blocks
///    starting at offset 0x60 of the first block (key_data already contains all the bytes)
/// 3. External long key (key_len > 863 or long_key is set): stored via a separate CacheAddr
fn read_entry_key(
    entry: &RawEntry,
    cache_dir: &Path,
    block_cache: &mut BlockFileCache,
    errors: &mut Vec<String>,
) -> Option<String> {
    if entry.key_len == 0 {
        return None;
    }

    if !entry.long_key.is_initialized() && (entry.key_len as usize) <= entry.key_data.len() {
        // Inline key — key_data holds the full key (may be up to 863 bytes
        // when the entry spans multiple blocks)
        let len = entry.key_len as usize;
        let key_bytes = &entry.key_data[..len];
        // Find null terminator
        let actual_len = key_bytes
            .iter()
            .position(|&b| b == 0)
            .unwrap_or(key_bytes.len());
        Some(String::from_utf8_lossy(&key_bytes[..actual_len]).to_string())
    } else if entry.long_key.is_initialized() {
        // External long key — follow the CacheAddr
        let data = read_stream_data(
            entry.long_key,
            entry.key_len,
            cache_dir,
            block_cache,
            errors,
        )?;
        let actual_len = data.iter().position(|&b| b == 0).unwrap_or(data.len());
        Some(String::from_utf8_lossy(&data[..actual_len]).to_string())
    } else {
        // key_len > key_data.len() but no long_key pointer — shouldn't happen,
        // but handle gracefully by reading what we have
        errors.push(format!(
            "Entry has key_len={} but key_data only has {} bytes and no long_key",
            entry.key_len, entry.key_data.len()
        ));
        let len = entry.key_data.len().min(entry.key_len as usize);
        if len == 0 { return None; }
        let key_bytes = &entry.key_data[..len];
        let actual_len = key_bytes.iter().position(|&b| b == 0).unwrap_or(key_bytes.len());
        Some(String::from_utf8_lossy(&key_bytes[..actual_len]).to_string())
    }
}

/// Parsed HTTP metadata from stream 0 Pickle.
struct ParsedHttpMeta {
    http_status: Option<String>,
    content_type: Option<String>,
    content_length: Option<u64>,
    original_filename: Option<String>,
    request_time: Option<f64>,
    response_time: Option<f64>,
    headers: Option<HashMap<String, String>>,
}

impl ParsedHttpMeta {
    fn empty() -> Self {
        Self {
            http_status: None,
            content_type: None,
            content_length: None,
            original_filename: None,
            request_time: None,
            response_time: None,
            headers: None,
        }
    }
}

/// Convert Chromium microsecond timestamp (since 1601-01-01) to Unix seconds.
fn chrome_time_to_unix(us: i64) -> f64 {
    // Chromium stores time as microseconds since 1601-01-01 00:00:00 UTC
    // Unix epoch starts at 1970-01-01 00:00:00 UTC
    // Difference = 11644473600 seconds
    (us as f64 / 1_000_000.0) - 11_644_473_600.0
}

/// Read a Pickle-encoded int32 at `pos`, returning the value and the new position.
/// All Pickle values are 4-byte aligned.
fn pickle_read_i32(data: &[u8], pos: usize) -> Option<(i32, usize)> {
    if pos + 4 > data.len() {
        return None;
    }
    let val = read_i32_le(data, pos);
    Some((val, pos + 4))
}

/// Read a Pickle-encoded int64 at `pos`, returning the value and the new position.
fn pickle_read_i64(data: &[u8], pos: usize) -> Option<(i64, usize)> {
    if pos + 8 > data.len() {
        return None;
    }
    let val = read_i64_le(data, pos);
    Some((val, pos + 8))
}

/// Read a Pickle-encoded string at `pos`: 4-byte length prefix + data + padding.
fn pickle_read_string(data: &[u8], pos: usize) -> Option<(Vec<u8>, usize)> {
    if pos + 4 > data.len() {
        return None;
    }
    let len = read_i32_le(data, pos) as usize;
    let start = pos + 4;
    if start + len > data.len() {
        return None;
    }
    let bytes = data[start..start + len].to_vec();
    // Align to next 4-byte boundary
    let aligned = (start + len + 3) & !3;
    Some((bytes, aligned))
}

/// Parse HTTP response metadata from stream 0 (Chromium Pickle format).
///
/// Stream 0 is a Pickle-serialized HttpResponseInfo. Layout:
///   [4 bytes: pickle payload_size (u32 LE)]
///   Payload:
///     int32 flags (version in bits[7:0], HAS_EXTRA_FLAGS = bit 31)
///     int32 extra_flags (only if HAS_EXTRA_FLAGS set)
///     int64 request_time (Chrome microseconds since 1601-01-01)
///     int64 response_time
///     int64 original_response_time (only if extra_flags bit 2 set)
///     string raw_headers_ (null-separated: "HTTP/1.1 200 OK\0header: value\0...\0")
///     ...optional SSL/cert fields (ignored)...
fn parse_http_headers(data: &[u8]) -> ParsedHttpMeta {
    const HAS_EXTRA_FLAGS: i32 = 1 << 31; // flags bit 31
    const HAS_ORIGINAL_RESPONSE_TIME: i32 = 1 << 2; // extra_flags bit 2

    if data.len() < 8 {
        return ParsedHttpMeta::empty();
    }

    // Skip pickle header (4-byte payload_size)
    let mut pos: usize = 4;

    // Read flags
    let (flags, next) = match pickle_read_i32(data, pos) {
        Some(v) => v,
        None => return ParsedHttpMeta::empty(),
    };
    pos = next;

    // Read extra_flags if HAS_EXTRA_FLAGS is set
    let mut extra_flags: i32 = 0;
    if flags & HAS_EXTRA_FLAGS != 0 {
        let (ef, next) = match pickle_read_i32(data, pos) {
            Some(v) => v,
            None => return ParsedHttpMeta::empty(),
        };
        extra_flags = ef;
        pos = next;
    }

    // Read request_time (int64, Chrome microseconds)
    let (request_time_us, next) = match pickle_read_i64(data, pos) {
        Some(v) => v,
        None => return ParsedHttpMeta::empty(),
    };
    pos = next;

    // Read response_time (int64, Chrome microseconds)
    let (response_time_us, next) = match pickle_read_i64(data, pos) {
        Some(v) => v,
        None => return ParsedHttpMeta::empty(),
    };
    pos = next;

    // Read original_response_time if present
    if extra_flags & HAS_ORIGINAL_RESPONSE_TIME != 0 {
        let (_, next) = match pickle_read_i64(data, pos) {
            Some(v) => v,
            None => return ParsedHttpMeta::empty(),
        };
        pos = next;
    }

    // Read raw_headers_ string (Pickle string: 4-byte len + data + padding)
    let raw_headers_bytes = match pickle_read_string(data, pos) {
        Some((bytes, _)) => bytes,
        None => {
            // Fallback: try to find HTTP/ signature in the remaining data
            // This handles edge cases where flag bits are unexpected
            match find_http_headers_fallback(data) {
                Some(bytes) => bytes,
                None => return ParsedHttpMeta::empty(),
            }
        }
    };

    parse_raw_headers(&raw_headers_bytes, request_time_us, response_time_us)
}

/// Fallback: scan the data for "HTTP/" to find where the raw headers blob starts.
/// This handles cases where the flags contain unexpected bits that shift the offsets.
fn find_http_headers_fallback(data: &[u8]) -> Option<Vec<u8>> {
    // Search for "HTTP/" in the data after the pickle header
    let needle = b"HTTP/";
    for i in 4..data.len().saturating_sub(needle.len()) {
        if &data[i..i + needle.len()] == needle {
            // Found HTTP/ — now backtrack to find the Pickle string length prefix
            // The 4-byte length prefix should be at i-4
            if i >= 4 {
                let str_len = read_i32_le(data, i - 4) as usize;
                if str_len > 0 && str_len < data.len() && i - 4 + 4 + str_len <= data.len() {
                    return Some(data[i..i + str_len].to_vec());
                }
            }
            // If backtrack doesn't work, just take from HTTP/ to the next double-null
            let rest = &data[i..];
            // Find double-null terminator
            let end = rest
                .windows(2)
                .position(|w| w == [0, 0])
                .map(|p| p + 1) // include the first null
                .unwrap_or(rest.len());
            return Some(rest[..end].to_vec());
        }
    }
    None
}

/// Parse the null-separated raw_headers_ blob into structured metadata.
fn parse_raw_headers(raw: &[u8], request_time_us: i64, response_time_us: i64) -> ParsedHttpMeta {
    let mut http_status: Option<String> = None;
    let mut content_type: Option<String> = None;
    let mut content_length: Option<u64> = None;
    let mut original_filename: Option<String> = None;
    let mut headers_map: HashMap<String, String> = HashMap::new();

    // Split on null bytes — raw_headers_ is null-separated
    // First segment = status line ("HTTP/1.1 200 OK")
    // Rest = header lines ("content-type: video/mp4")
    let mut found_status = false;
    for part in raw.split(|&b| b == 0) {
        if part.is_empty() {
            continue;
        }
        let s = String::from_utf8_lossy(part);

        if !found_status {
            // First non-empty segment is the HTTP status line
            // Validate it looks like an HTTP status line
            if s.starts_with("HTTP/") {
                http_status = Some(s.to_string());
            } else {
                // Doesn't look like a status line — might be garbage
                http_status = Some(s.to_string());
            }
            found_status = true;
            continue;
        }

        // Parse header: "name: value"
        if let Some(colon_pos) = s.find(':') {
            let name = s[..colon_pos].trim().to_string();
            let value = s[colon_pos + 1..].trim().to_string();
            let lower_name = name.to_lowercase();

            if lower_name == "content-type" {
                content_type = Some(value.clone());
            } else if lower_name == "content-length" {
                content_length = value.parse::<u64>().ok();
            } else if lower_name == "content-disposition" {
                original_filename = parse_content_disposition_filename(&value);
            }

            // Store all headers (lowercase key for consistency)
            headers_map.insert(lower_name, value);
        }
    }

    let request_time = if request_time_us > 0 {
        Some(chrome_time_to_unix(request_time_us))
    } else {
        None
    };
    let response_time = if response_time_us > 0 {
        Some(chrome_time_to_unix(response_time_us))
    } else {
        None
    };

    ParsedHttpMeta {
        http_status,
        content_type,
        content_length,
        original_filename,
        request_time,
        response_time,
        headers: if headers_map.is_empty() {
            None
        } else {
            Some(headers_map)
        },
    }
}

/// Extract filename from Content-Disposition header value.
fn parse_content_disposition_filename(value: &str) -> Option<String> {
    // Try filename*=UTF-8''... first (RFC 5987)
    if let Some(pos) = value.to_lowercase().find("filename*=utf-8''") {
        let start = pos + "filename*=utf-8''".len();
        let rest = &value[start..];
        let end = rest.find(';').unwrap_or(rest.len());
        let encoded = rest[..end].trim();
        // URL-decode
        return Some(url_decode(encoded));
    }

    // Try filename="..."
    if let Some(pos) = value.to_lowercase().find("filename=\"") {
        let start = pos + "filename=\"".len();
        let rest = &value[start..];
        if let Some(end) = rest.find('"') {
            return Some(rest[..end].to_string());
        }
    }

    // Try filename=... (unquoted)
    if let Some(pos) = value.to_lowercase().find("filename=") {
        let start = pos + "filename=".len();
        let rest = &value[start..];
        let end = rest.find(';').unwrap_or(rest.len());
        let name = rest[..end].trim();
        if !name.is_empty() {
            return Some(name.to_string());
        }
    }

    None
}

/// Simple percent-decoding for URL-encoded filenames.
fn url_decode(input: &str) -> String {
    let mut result = Vec::new();
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&String::from_utf8_lossy(&bytes[i + 1..i + 3]), 16)
            {
                result.push(byte);
                i += 3;
                continue;
            }
        }
        result.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&result).to_string()
}

/// Build a DataRef for a stream.
fn build_data_ref(
    stream_index: u32,
    addr: CacheAddr,
    size: i32,
    cache_dir: &Path,
    block_cache: &mut BlockFileCache,
    errors: &mut Vec<String>,
) -> Option<BlockfileDataRef> {
    if !addr.is_initialized() || size <= 0 {
        return None;
    }

    let path = addr.to_file_path(cache_dir);
    let is_external = addr.is_external();

    let (offset, actual_size) = if is_external {
        (0u64, size as u64)
    } else {
        let info = block_cache.get_or_load(&path, errors)?;
        (addr.byte_offset(info.entry_size), size as u64)
    };

    Some(BlockfileDataRef {
        stream_index,
        file_path: path.to_string_lossy().to_string(),
        offset,
        size: actual_size,
        is_external,
    })
}

// ---------------------------------------------------------------------------
// Core parser
// ---------------------------------------------------------------------------

fn parse_index_internal(dir: &Path) -> Result<BlockfileIndexResult, String> {
    let index_path = dir.join("index");
    let index_data = fs::read(&index_path)
        .map_err(|e| format!("Cannot read index file {}: {}", index_path.display(), e))?;

    if index_data.len() < INDEX_HEADER_SIZE {
        return Err(format!(
            "Index file too small: {} bytes (need at least {})",
            index_data.len(),
            INDEX_HEADER_SIZE
        ));
    }

    // Validate magic
    let magic = read_u32_le(&index_data, 0);
    if magic != INDEX_MAGIC {
        return Err(format!(
            "Bad index magic: 0x{:08X} (expected 0x{:08X})",
            magic, INDEX_MAGIC
        ));
    }

    // Version check
    let version = read_u32_le(&index_data, 4);
    if version != 0x20000 && version != 0x20001 && version != 0x30000 {
        return Err(format!("Unsupported index version: 0x{:X}", version));
    }

    let entry_count = read_u32_le(&index_data, 8);
    let mut table_len = read_u32_le(&index_data, 0x1C);
    if table_len == 0 {
        table_len = 0x10000;
    }

    let mut errors: Vec<String> = Vec::new();
    let mut block_cache = BlockFileCache::new();

    // Pre-load block files (data_0..data_3)
    for i in 0..4 {
        let bf_path = dir.join(format!("data_{}", i));
        if bf_path.exists() {
            block_cache.get_or_load(&bf_path, &mut errors);
        }
    }

    // Walk hash table
    let hash_table_start = INDEX_HEADER_SIZE;
    let hash_table_end = hash_table_start + (table_len as usize) * 4;
    if hash_table_end > index_data.len() {
        return Err(format!(
            "Index file too small for hash table: need {} bytes, have {}",
            hash_table_end,
            index_data.len()
        ));
    }

    // Collect all raw entries with their addresses
    struct ParsedRawEntry {
        _addr: CacheAddr,
        url: String,
        state: u32,
        flags: u32,
        creation_time: u64,
        data_size: [i32; 4],
        data_addr: [CacheAddr; 4],
    }

    let mut raw_entries: Vec<ParsedRawEntry> = Vec::new();
    let mut visited: HashSet<u32> = HashSet::new();

    for bucket in 0..table_len as usize {
        let offset = hash_table_start + bucket * 4;
        let addr_val = read_u32_le(&index_data, offset);
        let mut current = CacheAddr(addr_val);

        // Walk collision chain
        while current.is_initialized() {
            if !visited.insert(current.0) {
                // Already visited — infinite loop guard
                errors.push(format!(
                    "Infinite loop detected at CacheAddr 0x{:08X} in bucket {}",
                    current.0, bucket
                ));
                break;
            }

            // Read the EntryStore
            let entry_path = current.to_file_path(dir);
            let entry_data = if current.is_external() {
                // Shouldn't happen for entries, but handle gracefully
                match fs::read(&entry_path) {
                    Ok(d) => d,
                    Err(e) => {
                        errors.push(format!(
                            "Cannot read entry at {}: {}",
                            entry_path.display(),
                            e
                        ));
                        break;
                    }
                }
            } else {
                match block_cache.get_or_load(&entry_path, &mut errors) {
                    Some(info) => {
                        let off = current.byte_offset(info.entry_size) as usize;
                        // Chromium entries can span 1-4 contiguous blocks (256 bytes each).
                        // num_blocks encodes how many blocks this entry occupies.
                        // Keys 161-863 bytes are stored inline across these extra blocks.
                        let n_blocks = current.num_blocks() as usize;
                        let total_size = n_blocks * info.entry_size as usize;
                        let end = off + total_size;
                        if end > info.data.len() {
                            errors.push(format!(
                                "Entry read out of bounds at 0x{:08X} in {} (off={}, size={}, file_len={})",
                                current.0,
                                entry_path.display(),
                                off,
                                total_size,
                                info.data.len()
                            ));
                            break;
                        }
                        info.data[off..end].to_vec()
                    }
                    None => break,
                }
            };

            match parse_entry_store(&entry_data) {
                Some(entry) => {

                    let url = read_entry_key(&entry, dir, &mut block_cache, &mut errors)
                        .unwrap_or_default();

                    let next = entry.next;

                    raw_entries.push(ParsedRawEntry {
                        _addr: current,
                        url,
                        state: entry.state,
                        flags: entry.flags,
                        creation_time: entry.creation_time,
                        data_size: entry.data_size,
                        data_addr: entry.data_addr,
                    });

                    current = next;
                }
                None => {
                    errors.push(format!("Failed to parse entry at 0x{:08X}", current.0));
                    break;
                }
            }
        }
    }

    // Build cache entries
    let mut entries: Vec<BlockfileCacheEntry> = Vec::new();
    // Track children by parent URL for sparse reconstruction
    // Children have key like "Range_<parent_key>:<signature_hex>:<child_id_hex>"
    let mut children_map: HashMap<String, Vec<(u64, BlockfileDataRef)>> = HashMap::new();
    let mut child_count = 0usize;
    let mut parent_count = 0usize;
    let mut child_no_url_count = 0usize;
    let mut child_no_data_ref_count = 0usize;
    let mut child_no_range_prefix_count = 0usize;
    let mut child_parse_fail_count = 0usize;

    for raw in &raw_entries {
        let is_child = raw.flags & 2 != 0;
        let is_parent = raw.flags & 1 != 0;

        // Build data refs
        let mut data_files = Vec::new();
        for i in 0..4u32 {
            if let Some(dr) = build_data_ref(
                i,
                raw.data_addr[i as usize],
                raw.data_size[i as usize],
                dir,
                &mut block_cache,
                &mut errors,
            ) {
                data_files.push(dr);
            }
        }

        // Parse HTTP headers from stream 0 (Pickle-serialized HttpResponseInfo)
        let meta = if raw.data_size[0] > 0 && raw.data_addr[0].is_initialized() {
            match read_stream_data(
                raw.data_addr[0],
                raw.data_size[0] as u32,
                dir,
                &mut block_cache,
                &mut errors,
            ) {
                Some(header_data) => parse_http_headers(&header_data),
                None => ParsedHttpMeta::empty(),
            }
        } else {
            ParsedHttpMeta::empty()
        };

        let body_size = if raw.data_size[1] > 0 {
            raw.data_size[1] as u64
        } else {
            0
        };

        let creation_ts = if raw.creation_time > 0 {
            Some(filetime_to_unix(raw.creation_time))
        } else {
            None
        };

        if is_child {
            child_count += 1;
            // Extract parent URL and child_id from key.
            // Chromium child key format: Range_<parent_key>:<signature_hex>:<child_id_hex>
            // See chromium/src/net/disk_cache/blockfile/sparse_control.cc GenerateChildName()
            if raw.url.is_empty() {
                child_no_url_count += 1;
                println!(
                    "[parse_blockfile_index] CHILD SKIP: empty URL for child entry (flags=0x{:X}, data_size={:?})",
                    raw.flags, raw.data_size
                );
            } else if let Some(stripped) = raw.url.strip_prefix("Range_") {
                // Find the last ':' to split off child_id
                if let Some(child_colon) = stripped.rfind(':') {
                    let child_id_hex = &stripped[child_colon + 1..];
                    let child_id = u64::from_str_radix(child_id_hex.trim(), 16).unwrap_or(0);
                    let remainder = &stripped[..child_colon]; // <parent_key>:<signature>

                    // Find the second-to-last ':' to split off the signature,
                    // leaving only the true parent key.
                    // The parent entry's URL does NOT include the signature.
                    let parent_url = if let Some(sig_colon) = remainder.rfind(':') {
                        // Verify the segment after sig_colon looks like a hex signature
                        let sig_candidate = &remainder[sig_colon + 1..];
                        if sig_candidate.len() >= 4 && sig_candidate.chars().all(|c| c.is_ascii_hexdigit()) {
                            &remainder[..sig_colon]
                        } else {
                            // Doesn't look like a signature — use full remainder as parent URL
                            remainder
                        }
                    } else {
                        remainder
                    };


                    // Build data ref — try all streams, not just stream 1.
                    // In Chromium sparse child entries, body data can be stored in
                    // any stream (0-3). Stream 1 (data_1, 256-byte blocks) is most
                    // common, but many children store body data in stream 2
                    // (data_2, 1024-byte blocks). Try preferred order: 1, 2, 0, 3.
                    let dr = build_data_ref(1, raw.data_addr[1], raw.data_size[1], dir, &mut block_cache, &mut errors)
                        .or_else(|| build_data_ref(2, raw.data_addr[2], raw.data_size[2], dir, &mut block_cache, &mut errors))
                        .or_else(|| build_data_ref(0, raw.data_addr[0], raw.data_size[0], dir, &mut block_cache, &mut errors))
                        .or_else(|| build_data_ref(3, raw.data_addr[3], raw.data_size[3], dir, &mut block_cache, &mut errors));

                    if let Some(dr) = dr {
                        println!(
                            "[parse_blockfile_index] CHILD OK: child_id={}, stream={}, size={} bytes, is_external={}, parent_url={}",
                            child_id, dr.stream_index, dr.size, dr.is_external, &parent_url[..parent_url.len().min(80)]
                        );
                        children_map
                            .entry(parent_url.to_string())
                            .or_default()
                            .push((child_id, dr));
                    } else {
                        child_no_data_ref_count += 1;
                        println!(
                            "[parse_blockfile_index] CHILD SKIP: no data ref in ANY stream for child_id={} (addrs=[0x{:08X}, 0x{:08X}, 0x{:08X}, 0x{:08X}], sizes={:?})",
                            child_id, raw.data_addr[0].0, raw.data_addr[1].0, raw.data_addr[2].0, raw.data_addr[3].0, raw.data_size
                        );
                    }
                } else {
                    child_parse_fail_count += 1;
                    println!(
                        "[parse_blockfile_index] CHILD SKIP: no ':' in stripped key '{}'",
                        &stripped[..stripped.len().min(120)]
                    );
                }
            } else {
                child_no_range_prefix_count += 1;
                println!(
                    "[parse_blockfile_index] CHILD SKIP: no Range_ prefix, url='{}'",
                    &raw.url[..raw.url.len().min(120)]
                );
            }
            // Don't add child entries as top-level entries
            continue;
        }

        if is_parent {
            parent_count += 1;
        }

        entries.push(BlockfileCacheEntry {
            url: raw.url.clone(),
            content_type: meta.content_type,
            content_length: meta.content_length,
            original_filename: meta.original_filename,
            http_status: meta.http_status,
            creation_time: creation_ts,
            request_time: meta.request_time,
            response_time: meta.response_time,
            response_headers: meta.headers,
            state: raw.state,
            flags: raw.flags,
            data_files,
            body_size,
            is_sparse: is_parent,
            children: Vec::new(),
        });
    }

    println!(
        "[parse_blockfile_index] Child stats: total={} no_url={} no_range_prefix={} parse_fail={} no_data_ref={} | Parents: {}",
        child_count, child_no_url_count, child_no_range_prefix_count, child_parse_fail_count, child_no_data_ref_count, parent_count
    );
    // Link children to parent entries
    let mut linked_count = 0usize;
    let mut unmatched_parent_urls: Vec<String> = Vec::new();
    for entry in &mut entries {
        if entry.is_sparse {
            if let Some(mut child_list) = children_map.remove(&entry.url) {
                child_list.sort_by_key(|(id, _)| *id);
                linked_count += child_list.len();
                println!(
                    "[parse_blockfile_index] Linked {} children to sparse parent: {}",
                    child_list.len(),
                    &entry.url[..entry.url.len().min(120)]
                );
                entry.children = child_list
                    .into_iter()
                    .map(|(child_id, data_ref)| BlockfileSparseChild {
                        child_id,
                        offset_bytes: child_id << 20, // each child covers 1MB
                        data_ref,
                    })
                    .collect();

                // Update body_size for sparse entries: parent's data_size[1] is 0
                // because body data lives in children, not the parent entry.
                if entry.body_size == 0 && !entry.children.is_empty() {
                    entry.body_size = entry.children.iter().map(|c| c.data_ref.size).sum();
                }
            } else {
                println!(
                    "[parse_blockfile_index] WARNING: Sparse parent has 0 children matched: {}",
                    &entry.url[..entry.url.len().min(120)]
                );
                unmatched_parent_urls.push(entry.url[..entry.url.len().min(200)].to_string());
            }
        }
    }

    // Collect orphaned children stats
    let mut orphaned_details: Vec<OrphanedChildGroup> = Vec::new();
    let mut orphaned_children_total = 0usize;
    if !children_map.is_empty() {
        for (parent_url, children) in &children_map {
            println!(
                "[parse_blockfile_index] WARNING: {} orphaned children for unmatched parent URL: {}",
                children.len(),
                &parent_url[..parent_url.len().min(120)]
            );
            errors.push(format!(
                "Orphaned children: {} children for parent '{}'",
                children.len(),
                &parent_url[..parent_url.len().min(120)]
            ));
            orphaned_children_total += children.len();
            orphaned_details.push(OrphanedChildGroup {
                parent_url: parent_url[..parent_url.len().min(200)].to_string(),
                child_count: children.len(),
            });
        }
    }

    let sparse_linking_stats = SparseLinkingStats {
        total_children_linked: linked_count,
        orphaned_groups: orphaned_details.len(),
        orphaned_children_total,
        unmatched_parents: unmatched_parent_urls.len(),
        orphaned_details,
        unmatched_parent_urls,
    };

    println!("[parse_blockfile_index] Total: {} entries, {} children linked, {} orphaned groups, {} unmatched parents",
        entries.len(), linked_count, sparse_linking_stats.orphaned_groups, sparse_linking_stats.unmatched_parents);

    Ok(BlockfileIndexResult {
        entries,
        entry_count,
        version,
        errors,
        sparse_linking_stats,
    })
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn parse_blockfile_index(dir: String) -> Result<BlockfileIndexResult, String> {
    let dir_path = Path::new(&dir);
    if !dir_path.exists() {
        return Err(format!("Directory does not exist: {}", dir));
    }
    parse_index_internal(dir_path)
}

#[tauri::command]
pub fn reconstruct_from_index(dir: String, url: String, output: String) -> Result<u64, String> {
    let dir_path = Path::new(&dir);
    let result = parse_index_internal(dir_path)?;

    // Find matching entry
    let entry = result
        .entries
        .iter()
        .find(|e| e.url == url)
        .ok_or_else(|| format!("No entry found matching URL: {}", url))?;

    let mut errors: Vec<String> = Vec::new();
    let mut block_cache = BlockFileCache::new();
    let mut output_data: Vec<u8> = Vec::new();

    if entry.is_sparse && !entry.children.is_empty() {
        // Sparse: read each child's data and place at correct byte offset.
        // children are already sorted by child_id.
        // Each child covers 1MB (offset_bytes = child_id << 20).
        // We MUST zero-fill gaps for missing children so that moov's
        // stco/co64 absolute byte offsets remain valid.

        println!(
            "[reconstruct_from_index] Sparse entry with {} children, url: {}",
            entry.children.len(),
            entry.url
        );

        // Step 1: Read all children into a position-aware buffer
        let mut raw_data: Vec<u8> = Vec::new();
        for child in &entry.children {
            let target_offset = child.offset_bytes as usize;
            let dr = &child.data_ref;
            let addr_path = Path::new(&dr.file_path);

            println!(
                "[reconstruct_from_index] Child #{}: child_id={}, offset={}, data_size={} bytes, is_external={}, file={}",
                entry.children.iter().position(|c| c.child_id == child.child_id).unwrap_or(0),
                child.child_id,
                target_offset,
                dr.size,
                dr.is_external,
                &dr.file_path[dr.file_path.len().saturating_sub(30)..]
            );
            let child_data: Vec<u8> = if dr.is_external {
                match fs::read(addr_path) {
                    Ok(data) => {
                        let end = (dr.size as usize).min(data.len());
                        data[..end].to_vec()
                    }
                    Err(e) => {
                        println!(
                            "[reconstruct_from_index] WARNING: Cannot read child {} ({}): {} — zero-filling",
                            child.child_id, dr.file_path, e
                        );
                        continue;
                    }
                }
            } else {
                let info = match block_cache.get_or_load(addr_path, &mut errors) {
                    Some(info) => info,
                    None => {
                        println!(
                            "[reconstruct_from_index] WARNING: Cannot load block file for child {} ({}) — skipping",
                            child.child_id, dr.file_path
                        );
                        continue;
                    }
                };
                let offset = dr.offset as usize;
                let end = offset + dr.size as usize;
                if end > info.data.len() {
                    println!(
                        "[reconstruct_from_index] WARNING: Child {} data out of bounds in {} — skipping",
                        child.child_id, dr.file_path
                    );
                    continue;
                }
                info.data[offset..end].to_vec()
            };

            // Zero-fill gap if this child starts beyond current buffer length
            if target_offset > raw_data.len() {
                let gap = target_offset - raw_data.len();
                println!(
                    "[reconstruct_from_index] Gap before child {}: {} bytes zero-fill",
                    child.child_id, gap
                );
                raw_data.resize(raw_data.len() + gap, 0u8);
            }

            // Write child data at target offset
            if target_offset == raw_data.len() {
                raw_data.extend_from_slice(&child_data);
            } else if target_offset < raw_data.len() {
                // Overlapping — overwrite existing zeros/data
                let end = target_offset + child_data.len();
                if end > raw_data.len() {
                    raw_data.resize(end, 0u8);
                }
                raw_data[target_offset..target_offset + child_data.len()]
                    .copy_from_slice(&child_data);
            }
        }

        println!(
            "[reconstruct_from_index] Raw concatenation: {} bytes ({:.2} MB)",
            raw_data.len(),
            raw_data.len() as f64 / 1024.0 / 1024.0
        );

        // Step 2: Try MP4-aware reconstruction (ftyp/mdat/moov handling)
        let ftyp_result = crate::find_mp4_box(&raw_data, b"ftyp");
        let mdat_result = crate::find_mp4_box(&raw_data, b"mdat");
        let moov_result = crate::scan_for_moov(&raw_data);

        if let (Some(ftyp_box), Some(mdat_box)) = (ftyp_result, mdat_result) {
            let ftyp_offset = ftyp_box.0;
            let ftyp_size = ftyp_box.1 as usize;
            let mdat_offset = mdat_box.0;
            let mdat_declared_size = mdat_box.1;
            let mdat_header_size = mdat_box.2;

            println!(
                "[reconstruct_from_index] MP4 structure found: ftyp={} bytes at {}, mdat={} bytes (header {}) at {}",
                ftyp_size, ftyp_offset, mdat_declared_size, mdat_header_size, mdat_offset
            );

            let gap_before_mdat = mdat_offset.saturating_sub(ftyp_offset + ftyp_size);

            // Build reconstructed buffer with proper MP4 structure
            let mut reconstructed: Vec<u8> =
                Vec::with_capacity(raw_data.len() + 4 * 1024 * 1024);

            // 1. Write ftyp box
            let ftyp_end = ftyp_offset + ftyp_size;
            if ftyp_end <= raw_data.len() {
                reconstructed.extend_from_slice(&raw_data[ftyp_offset..ftyp_end]);
            }

            // 2. Write gap between ftyp and mdat (e.g. free/uuid boxes)
            if gap_before_mdat > 0 {
                let gap_end = (ftyp_offset + ftyp_size + gap_before_mdat).min(raw_data.len());
                reconstructed
                    .extend_from_slice(&raw_data[ftyp_offset + ftyp_size..gap_end]);
            }

            // 3. Write mdat header placeholder (will be patched)
            let mdat_start = reconstructed.len();
            if mdat_header_size == 16 {
                reconstructed.extend_from_slice(&1u32.to_be_bytes());
                reconstructed.extend_from_slice(b"mdat");
                reconstructed.extend_from_slice(&0u64.to_be_bytes());
            } else {
                reconstructed.extend_from_slice(&0u32.to_be_bytes());
                reconstructed.extend_from_slice(b"mdat");
            }

            // 4. Write media data (everything in mdat after header)
            let media_start = mdat_offset + mdat_header_size;
            // Determine where mdat body data ends:
            // - If moov exists AFTER mdat, mdat body ends at moov offset
            // - If moov exists BEFORE mdat (faststart layout), mdat body extends to end of raw_data
            // - If no moov found, mdat body extends to end of raw_data
            let media_end = if let Some((moov_off, _moov_sz)) = moov_result {
                if moov_off > mdat_offset {
                    // moov is AFTER mdat (streaming layout) — mdat body ends at moov
                    moov_off.min(raw_data.len())
                } else {
                    // moov is BEFORE mdat (faststart layout) — mdat body extends to end
                    raw_data.len()
                }
            } else {
                raw_data.len()
            };
            if media_start < media_end {
                reconstructed.extend_from_slice(&raw_data[media_start..media_end]);
            }

            // 5. Compute actual mdat size from what we assembled.
            // Do NOT pad to the original declared size — if we only have a partial
            // download (e.g. 11MB of a 60MB video), padding would create a huge
            // file full of zeros that plays as black screen.
            // Gaps between cached chunks are already zero-filled in step 1,
            // preserving moov stco/co64 byte offsets for the data we DO have.
            let actual_mdat_size = (reconstructed.len() - mdat_start) as u64;

            println!(
                "[reconstruct_from_index] Actual mdat body: {} bytes ({:.2} MB), declared was: {} bytes ({:.2} MB)",
                actual_mdat_size,
                actual_mdat_size as f64 / 1024.0 / 1024.0,
                mdat_declared_size,
                mdat_declared_size as f64 / 1024.0 / 1024.0
            );

            // 6. Patch mdat header with actual size
            if mdat_header_size == 16 {
                reconstructed[mdat_start + 8..mdat_start + 16]
                    .copy_from_slice(&actual_mdat_size.to_be_bytes());
            } else if actual_mdat_size > u32::MAX as u64 {
                // Need to upgrade to 64-bit mdat header
                let mut new_header = Vec::with_capacity(16);
                new_header.extend_from_slice(&1u32.to_be_bytes());
                new_header.extend_from_slice(b"mdat");
                new_header.extend_from_slice(&(actual_mdat_size + 8).to_be_bytes());
                reconstructed.splice(mdat_start..mdat_start + 8, new_header);
            } else {
                reconstructed[mdat_start..mdat_start + 4]
                    .copy_from_slice(&(actual_mdat_size as u32).to_be_bytes());
            }

            // 7. Append moov after mdat as separate top-level box
            //    Only if moov is AFTER mdat (streaming layout).
            //    If moov is BEFORE mdat (faststart), it was already written
            //    as part of the gap between ftyp and mdat in step 2.
            if let Some((moov_off, moov_sz)) = moov_result {
                if moov_off > mdat_offset {
                    // Streaming layout: moov after mdat — append it
                    let moov_end = (moov_off + moov_sz).min(raw_data.len());
                    if moov_off < raw_data.len() {
                        let moov_data = &raw_data[moov_off..moov_end];
                        println!(
                            "[reconstruct_from_index] Appending moov ({} bytes) at file offset {}",
                            moov_data.len(),
                            reconstructed.len()
                        );
                        reconstructed.extend_from_slice(moov_data);
                    }
                } else {
                    // Faststart layout: moov before mdat — already included in gap
                    println!(
                        "[reconstruct_from_index] Moov is before mdat (faststart layout, offset {}), already included in output",
                        moov_off
                    );
                }
            } else {
                println!(
                    "[reconstruct_from_index] WARNING: No moov atom found — video may not play correctly"
                );
            }

            println!(
                "[reconstruct_from_index] Final file: {} bytes ({:.2} MB)",
                reconstructed.len(),
                reconstructed.len() as f64 / 1024.0 / 1024.0
            );

            output_data = reconstructed;
        } else {
            // No ftyp/mdat structure — not an MP4 or structure unrecognizable.
            // Write raw zero-filled concatenation as-is (ffmpeg remux will attempt recovery).
            println!(
                "[reconstruct_from_index] No MP4 box structure found — writing raw {} bytes",
                raw_data.len()
            );
            output_data = raw_data;
        }
    } else {
        // Non-sparse: read stream 1 directly
        // Find stream 1 data ref
        let stream1 = entry
            .data_files
            .iter()
            .find(|d| d.stream_index == 1)
            .ok_or_else(|| "Entry has no stream 1 (body) data".to_string())?;

        let addr_path = Path::new(&stream1.file_path);

        if stream1.is_external {
            match fs::read(addr_path) {
                Ok(data) => {
                    let end = (stream1.size as usize).min(data.len());
                    output_data.extend_from_slice(&data[..end]);
                }
                Err(e) => {
                    return Err(format!(
                        "Cannot read stream 1 file {}: {}",
                        stream1.file_path, e
                    ));
                }
            }
        } else {
            let info = block_cache
                .get_or_load(addr_path, &mut errors)
                .ok_or_else(|| format!("Cannot load block file: {}", stream1.file_path))?;
            let offset = stream1.offset as usize;
            let end = offset + stream1.size as usize;
            if end > info.data.len() {
                return Err(format!(
                    "Stream 1 data out of bounds in {}: offset={} size={} file_len={}",
                    stream1.file_path,
                    offset,
                    stream1.size,
                    info.data.len()
                ));
            }
            output_data.extend_from_slice(&info.data[offset..end]);
        }
    }

    // Write output
    let output_path = Path::new(&output);
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create output directory: {}", e))?;
    }

    let mut file = fs::File::create(output_path)
        .map_err(|e| format!("Cannot create output file {}: {}", output, e))?;

    file.write_all(&output_data)
        .map_err(|e| format!("Cannot write output file: {}", e))?;

    Ok(output_data.len() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnose_discord_cache() {
        let cache_dir = std::env::var("APPDATA")
            .map(|appdata| format!("{}\\discord\\Cache\\Cache_Data", appdata))
            .unwrap_or_default();
        let dir = Path::new(&cache_dir);
        if !dir.join("index").exists() {
            println!("Discord cache not found at {:?}, skipping", dir);
            return;
        }
        println!("Reading Discord cache at {:?}", dir);
        match parse_index_internal(dir) {
            Ok(result) => {
                println!("\n=== RESULT ===");
                println!("Entries: {}, Entry count: {}", result.entries.len(), result.entry_count);
                println!("Errors: {}", result.errors.len());
                println!("Sparse linking: linked={}, orphaned_groups={}, unmatched_parents={}",
                    result.sparse_linking_stats.total_children_linked,
                    result.sparse_linking_stats.orphaned_groups,
                    result.sparse_linking_stats.unmatched_parents);
                println!("\n=== SPARSE ENTRIES ===");
                for e in &result.entries {
                    if e.is_sparse {
                        println!("  SPARSE: children={} body_size={} url='{}'",
                            e.children.len(), e.body_size, &e.url[..e.url.len().min(150)]);
                        for c in &e.children {
                            println!("    child_id={} offset={} size={} path='{}'",
                                c.child_id, c.offset_bytes, c.data_ref.size,
                                &c.data_ref.file_path[c.data_ref.file_path.len().saturating_sub(30)..]);
                        }
                    }
                }
                println!("\n=== ERRORS ({}) ===", result.errors.len());
                for e in &result.errors {
                    println!("  {}", e);
                }
            }
            Err(e) => println!("Error: {}", e),
        }
    }
}
