use std::sync::Mutex;
use tauri::State;

mod cache;


/// Enhanced error message for file read failures.
/// Includes raw errno and distinguishes TCC (EPERM=1) from BSD (EACCES=13) permission errors.
/// On macOS, EPERM means TCC/FDA denial (App Sandbox / Full Disk Access).
/// EACCES on _s (sparse) files most likely means a mandatory byte-range lock conflict --
/// Discord holds _s files open with active locks while running. Closing Discord resolves this.
fn format_read_error(path: &str, e: &std::io::Error) -> String {
    let raw_errno = e.raw_os_error();
    let hint = match raw_errno {
        Some(1) => " [EPERM: macOS TCC/FDA denial — grant Full Disk Access to this binary]",
        Some(13) => " [EACCES: byte-range lock conflict -- _s file may be locked by Discord; close Discord and retry]",
        _ => "",
    };
    eprintln!(
        "[DCCacheRecovery] Read failed: path={}, error={}, errno={:?}, binary={}",
        path,
        e,
        raw_errno,
        std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_else(|_| "unknown".into())
    );
    format!("Failed to read {}: {}{}", path, e, hint)
}


/// Read file bytes with automatic retry on EACCES (errno 13).
/// On macOS, EACCES on _s sparse cache files is caused by mandatory byte-range lock
/// conflicts with Discord (which holds _s files open while running). Retrying with
/// exponential backoff resolves the conflict once Discord releases the lock.
/// Falls through immediately on any other error.
fn read_with_lock_retry(path: &str) -> Result<Vec<u8>, std::io::Error> {
    let mut attempt: u64 = 0;
    loop {
        match std::fs::read(path) {
            Ok(data) => return Ok(data),
            Err(e) if e.raw_os_error() == Some(13) && attempt < 5 => {
                attempt += 1;
                eprintln!(
                    "[DCCacheRecovery] EACCES on {} (attempt {}): byte-range lock conflict, retrying in {}ms",
                    path, attempt, 100 * attempt
                );
                std::thread::sleep(std::time::Duration::from_millis(100 * attempt));
            }
            Err(e) => return Err(e),
        }
    }
}

/// Chromium Simple Cache magic number (little-endian): 0xfcfb6d1ba7725c30
const SIMPLE_CACHE_MAGIC: u64 = 0xfcfb6d1ba7725c30;
/// Size of SimpleFileHeader: magic(8) + version(4) + key_length(4) + key_hash(4) + padding(4) = 24
const SIMPLE_CACHE_HEADER_SIZE: usize = 24;
/// Chromium Simple Cache final magic number (little-endian): 0xf4fa6f45970d41d8
const SIMPLE_CACHE_EOF_MAGIC: u64 = 0xf4fa6f45970d41d8;
/// Size of a SimpleFileEOF record: magic(8) + flags(4) + data_crc32(4) + stream_size(4) + padding(4) = 24
const SIMPLE_CACHE_EOF_SIZE: usize = 24;
/// FLAG_HAS_KEY_SHA256 bit in SimpleFileEOF flags field
const FLAG_HAS_KEY_SHA256: u32 = 2;

/// Parsed Simple Cache file layout.
/// On-disk format of a `{hash}_0` file:
///   [SimpleFileHeader: 24 bytes]
///   [URL key: key_length bytes]
///   [Stream 1 data: HTTP response BODY]   <-- the actual content
///   [SimpleFileEOF for stream 1: 24 bytes]
///   [Stream 0 data: HTTP response HEADERS as text]
///   [optional key SHA256: 32 bytes if FLAG_HAS_KEY_SHA256 set in EOF0]
///   [SimpleFileEOF for stream 0: 24 bytes]
struct SimpleCacheLayout {
    stream1_start: usize,
    stream1_end: usize,
    stream0_start: usize,
    stream0_end: usize,
}

/// Parse the layout of a Simple Cache `_0` file deterministically.
/// Uses the EOF0 record at the fixed end-of-file position to compute all boundaries.
fn parse_simple_cache_layout(data: &[u8]) -> Option<SimpleCacheLayout> {
    if data.len() < SIMPLE_CACHE_HEADER_SIZE + SIMPLE_CACHE_EOF_SIZE {
        return None;
    }
    // Verify initial magic
    let magic = u64::from_le_bytes(data[0..8].try_into().ok()?);
    if magic != SIMPLE_CACHE_MAGIC {
        return None;
    }
    let key_length = u32::from_le_bytes(data[12..16].try_into().ok()?) as usize;
    let stream1_start = SIMPLE_CACHE_HEADER_SIZE + key_length;
    if stream1_start >= data.len() {
        return None;
    }

    // Parse EOF0 from the last 24 bytes of the file
    let eof0_start = data.len() - SIMPLE_CACHE_EOF_SIZE;
    let eof0_magic = u64::from_le_bytes(data[eof0_start..eof0_start + 8].try_into().ok()?);
    if eof0_magic != SIMPLE_CACHE_EOF_MAGIC {
        // Corrupted file — fall back to scanning
        return parse_simple_cache_layout_fallback(data, stream1_start);
    }
    let eof0_flags = u32::from_le_bytes(data[eof0_start + 8..eof0_start + 12].try_into().ok()?);
    let stream0_size = u32::from_le_bytes(data[eof0_start + 16..eof0_start + 20].try_into().ok()?) as usize;

    // If FLAG_HAS_KEY_SHA256, 32 bytes of SHA256 sit immediately before EOF0
    let sha_len = if eof0_flags & FLAG_HAS_KEY_SHA256 != 0 { 32 } else { 0 };
    let stream0_end = data.len() - SIMPLE_CACHE_EOF_SIZE - sha_len;
    if stream0_size > stream0_end {
        return parse_simple_cache_layout_fallback(data, stream1_start);
    }
    let stream0_start = stream0_end - stream0_size;

    // EOF1 sits immediately before stream0 data
    if stream0_start < SIMPLE_CACHE_EOF_SIZE {
        return parse_simple_cache_layout_fallback(data, stream1_start);
    }
    let eof1_start = stream0_start - SIMPLE_CACHE_EOF_SIZE;
    let eof1_magic = u64::from_le_bytes(data[eof1_start..eof1_start + 8].try_into().ok()?);
    if eof1_magic != SIMPLE_CACHE_EOF_MAGIC {
        return parse_simple_cache_layout_fallback(data, stream1_start);
    }
    let stream1_end = eof1_start;

    if stream1_start > stream1_end {
        return None;
    }

    Some(SimpleCacheLayout {
        stream1_start,
        stream1_end,
        stream0_start,
        stream0_end,
    })
}
/// Fallback: scan for EOF magic to find stream 1 boundaries when EOF0 is corrupt.
fn parse_simple_cache_layout_fallback(data: &[u8], stream1_start: usize) -> Option<SimpleCacheLayout> {
    let search_data = &data[stream1_start..];
    let magic_bytes = SIMPLE_CACHE_EOF_MAGIC.to_le_bytes();
    // Find the first EOF magic after stream1_start (this should be EOF1)
    let eof1_pos = search_data.windows(8).position(|w| w == magic_bytes)?;
    let stream1_end = stream1_start + eof1_pos;
    Some(SimpleCacheLayout {
        stream1_start,
        stream1_end,
        // Can't reliably determine stream0 boundaries in fallback
        stream0_start: 0,
        stream0_end: 0,
    })
}

/// Parse the layout of a Simple Cache `_1` (stream 2) file.
/// `_1` files store the full HTTP body for large resources.
/// Layout: [SimpleFileHeader: 24B] [URL key] [Stream 2 body] [SimpleFileEOF: 24B]
/// Unlike `_0` files, `_1` files have only ONE EOF record at the end, no stream 0.
fn parse_simple_cache_stream2_layout(data: &[u8]) -> Option<SimpleCacheLayout> {
    if data.len() < SIMPLE_CACHE_HEADER_SIZE + SIMPLE_CACHE_EOF_SIZE {
        return None;
    }
    // Verify initial magic
    let magic = u64::from_le_bytes(data[0..8].try_into().ok()?);
    if magic != SIMPLE_CACHE_MAGIC {
        return None;
    }
    let key_length = u32::from_le_bytes(data[12..16].try_into().ok()?) as usize;
    let body_start = SIMPLE_CACHE_HEADER_SIZE + key_length;
    // Single EOF at the end of file — body extends to just before it
    let eof_start = data.len() - SIMPLE_CACHE_EOF_SIZE;
    if body_start > eof_start {
        return None;
    }
    // Optionally verify trailing EOF magic (but don't fail if absent — some _1 files may vary)
    let eof_magic = u64::from_le_bytes(data[eof_start..eof_start + 8].try_into().ok()?);
    let body_end = if eof_magic == SIMPLE_CACHE_EOF_MAGIC {
        eof_start
    } else {
        // No EOF magic — body extends to end of file (non-standard but safe fallback)
        data.len()
    };
    Some(SimpleCacheLayout {
        stream1_start: body_start,
        stream1_end: body_end,
        // _1 files have no stream 0 (HTTP headers)
        stream0_start: 0,
        stream0_end: 0,
    })
}

/// Check if a file path refers to a Simple Cache `_1` (stream 2) file.
fn is_simple_cache_stream2(path: &str) -> bool {
    let filename = std::path::Path::new(path)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("");
    // Simple Cache _1 files: 16 hex chars + "_1"
    filename.len() == 18 && filename.ends_with("_1")
        && filename[..16].chars().all(|c| c.is_ascii_hexdigit())
}

/// Check if a file path refers to a Simple Cache  (sparse) file.
fn is_simple_cache_sparse(path: &str) -> bool {
    let filename = std::path::Path::new(path)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("");
    // Simple Cache _s files: 16 hex chars + "_s"
    filename.len() == 18 && filename.ends_with("_s")
        && filename[..16].chars().all(|c| c.is_ascii_hexdigit())
}

/// Reassemble sparse cache data from already-read file bytes.
/// Extracts and sorts range chunks, zero-fills gaps, returns contiguous buffer.
/// Used by both `read_sparse_cache_file` (Tauri command) and `concat_files` (internal).
fn reassemble_sparse_data(data: &[u8], path: &str) -> Result<Vec<u8>, String> {
    if data.len() < SIMPLE_CACHE_HEADER_SIZE {
        return Err(format!("File too small to be a sparse cache file: {}", path));
    }
    let magic = u64::from_le_bytes(data[0..8].try_into().map_err(|_| "read magic".to_string())?);
    if magic != SIMPLE_CACHE_MAGIC {
        return Err(format!("Not a Simple Cache file (bad magic): {}", path));
    }
    let key_length = u32::from_le_bytes(
        data[12..16].try_into().map_err(|_| "read key_len".to_string())?
    ) as usize;
    let mut pos = SIMPLE_CACHE_HEADER_SIZE + key_length;
    if pos > data.len() {
        return Err(format!("key_length extends past end of file: {}", path));
    }
    let mut chunks: Vec<(u64, &[u8])> = Vec::new();
    while pos + SPARSE_RANGE_HEADER_SIZE <= data.len() {
        let hdr = &data[pos..pos + SPARSE_RANGE_HEADER_SIZE];
        let range_magic = u64::from_le_bytes(hdr[0..8].try_into().map_err(|_| "range magic".to_string())?);
        if range_magic != SPARSE_RANGE_MAGIC { break; }
        let offset = u64::from_le_bytes(hdr[8..16].try_into().map_err(|_| "range offset".to_string())?);
        let length = u64::from_le_bytes(hdr[16..24].try_into().map_err(|_| "range length".to_string())?);
        let data_start = pos + SPARSE_RANGE_HEADER_SIZE;
        let data_end = data_start + length as usize;
        if data_end > data.len() {
            let available = &data[data_start..data.len()];
            if !available.is_empty() {
                chunks.push((offset, available));
            }
            break;
        }
        chunks.push((offset, &data[data_start..data_end]));
        pos = data_end;
    }
    if chunks.is_empty() {
        // No SparseRangeHeaders found. The _s file may store data directly after
        // the SimpleFileHeader+key (non-sparse format variant), or it may also have
        // an EOF record at the end. Try to extract the raw body.
        let body_start = SIMPLE_CACHE_HEADER_SIZE + key_length;
        if body_start < data.len() {
            let mut body_end = data.len();
            // Check for SimpleFileEOF at the end of file (24 bytes)
            if body_end >= body_start + SIMPLE_CACHE_EOF_SIZE {
                let eof_start = body_end - SIMPLE_CACHE_EOF_SIZE;
                let potential_eof = &data[eof_start..];
                if let Ok(eof_magic_bytes) = potential_eof[0..8].try_into() {
                    let eof_magic = u64::from_le_bytes(eof_magic_bytes);
                    if eof_magic == SIMPLE_CACHE_EOF_MAGIC {
                        // Check for optional SHA256 before EOF
                        let flags_bytes: [u8; 4] = potential_eof[8..12].try_into().unwrap_or([0; 4]);
                        let flags = u32::from_le_bytes(flags_bytes);
                        if flags & FLAG_HAS_KEY_SHA256 != 0 && eof_start >= 32 {
                            body_end = eof_start - 32; // SHA256 is 32 bytes before EOF
                        } else {
                            body_end = eof_start;
                        }
                    }
                }
            }
            let body = &data[body_start..body_end];
            if !body.is_empty() {
                eprintln!(
                    "[sparse] No range headers in {} — extracted {} bytes of raw body after header+key",
                    path, body.len()
                );
                return Ok(body.to_vec());
            }
        }
        return Ok(Vec::new());
    }
    chunks.sort_by_key(|(offset, _)| *offset);
    let total_size = chunks.iter().map(|(off, d)| off + d.len() as u64).max().unwrap_or(0) as usize;
    let mut buf = vec![0u8; total_size];
    for (offset, chunk) in &chunks {
        let start = *offset as usize;
        let end = start + chunk.len();
        if end <= buf.len() {
            buf[start..end].copy_from_slice(chunk);
        }
    }
    Ok(buf)
}


/// Extract the HTTP body from raw file data, stripping Simple Cache wrapper if present.
/// For `_1` files (stream 2), uses the simpler single-EOF layout.
/// For `_0` files (stream 1), uses the dual-EOF layout with stream 0 headers.
fn strip_simple_cache_wrapper(data: Vec<u8>, path: &str) -> Vec<u8> {
    let layout = if is_simple_cache_stream2(path) {
        parse_simple_cache_stream2_layout(&data)
    } else {
        parse_simple_cache_layout(&data)
    };
    if let Some(layout) = layout {
        data[layout.stream1_start..layout.stream1_end].to_vec()
    } else {
        data
    }
}

/// Read a cache file and return only the HTTP body data.
/// Handles _s (sparse) files via reassembly, and _0/_1 files via wrapper stripping.
/// For plain (blockfile) files, returns the raw bytes unchanged.
fn read_cache_body(path: &str) -> Result<Vec<u8>, String> {
    let data = read_with_lock_retry(path).map_err(|e| format_read_error(path, &e))?;
    if is_simple_cache_sparse(path) {
        reassemble_sparse_data(&data, path)
    } else {
        Ok(strip_simple_cache_wrapper(data, path))
    }
}

/// Extract the HTTP response headers (stream 0) from a Simple Cache file.
/// Returns None if not a Simple Cache file or if stream 0 boundaries are unknown.
fn extract_simple_cache_headers(data: &[u8]) -> Option<Vec<u8>> {
    let layout = parse_simple_cache_layout(data)?;
    if layout.stream0_start == 0 && layout.stream0_end == 0 {
        return None; // fallback mode, no stream0 info
    }
    if layout.stream0_start < layout.stream0_end {
        Some(data[layout.stream0_start..layout.stream0_end].to_vec())
    } else {
        None
    }
}

/// Application state shared across commands
pub struct AppState {
    pub scan_running: bool,
    pub recovery_running: bool,
}

/// Get the default Discord cache paths for the current OS
#[tauri::command]
fn get_default_cache_paths() -> Vec<String> {
    cache::get_default_cache_paths()
}

/// Check if a directory exists and contains cache files
#[tauri::command]
fn validate_cache_path(path: String) -> Result<cache::CachePathInfo, String> {
    cache::validate_cache_path(&path).map_err(|e| e.to_string())
}

/// Read the first N bytes of a file (for magic byte detection in TS).
/// For Simple Cache files, skips the header+key to return actual HTTP body bytes.
#[tauri::command]
fn read_file_header(path: String, size: usize) -> Result<Vec<u8>, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file =
        std::fs::File::open(&path).map_err(|e| format_read_error(&path, &e))?;
    // Read the fixed-size Simple Cache header (24 bytes) to check magic and get key_length.
    // We only need 24 bytes to determine whether this is a Simple Cache file and compute
    // the body offset — we do NOT need the full key in memory.
    let mut header_buf = [0u8; 24];
    let header_read = file
        .read(&mut header_buf)
        .map_err(|e| format!("Failed to read {}: {}", path, e))?;

    let is_simple_cache = header_read == 24 && {
        let magic = u64::from_le_bytes(header_buf[0..8].try_into().unwrap());
        magic == SIMPLE_CACHE_MAGIC
    };

    if is_simple_cache {
        let key_length = u32::from_le_bytes(header_buf[12..16].try_into().unwrap()) as u64;
        let body_offset = SIMPLE_CACHE_HEADER_SIZE as u64 + key_length;
        // Seek directly to the HTTP body and read the requested number of bytes
        file.seek(SeekFrom::Start(body_offset))
            .map_err(|e| format!("Failed to seek {}: {}", path, e))?;
        let mut buffer = vec![0u8; size.min(4096)];
        let bytes_read = file
            .read(&mut buffer)
            .map_err(|e| format!("Failed to read {}: {}", path, e))?;
        buffer.truncate(bytes_read);
        Ok(buffer)
    } else {
        // Blockfile or unknown — return bytes from start
        // We already consumed 24 bytes, so seek back and re-read
        file.seek(SeekFrom::Start(0))
            .map_err(|e| format!("Failed to seek {}: {}", path, e))?;
        let mut buffer = vec![0u8; size.min(4096)];
        let bytes_read = file
            .read(&mut buffer)
            .map_err(|e| format!("Failed to read {}: {}", path, e))?;
        buffer.truncate(bytes_read);
        Ok(buffer)
    }
}

/// Read entire file as bytes (for MP4 box parsing in TS).
/// For Simple Cache files, strips the header+key and returns only HTTP body data.
#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    let data = std::fs::read(&path).map_err(|e| format_read_error(&path, &e))?;
    Ok(strip_simple_cache_wrapper(data, &path))
}

/// Copy a file from src to dst, stripping Simple Cache wrapper if present.
#[tauri::command]
fn copy_file(src: String, dst: String) -> Result<(), String> {
    // Ensure parent directory exists
    if let Some(parent) = std::path::Path::new(&dst).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    let data = std::fs::read(&src).map_err(|e| format_read_error(&src, &e))?;
    let body = strip_simple_cache_wrapper(data, &src);
    std::fs::write(&dst, &body).map_err(|e| format!("Failed to write {}: {}", dst, e))?;
    Ok(())
}

/// Write bytes to a file
#[tauri::command]
fn write_file_bytes(path: String, data: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    std::fs::write(&path, &data).map_err(|e| format!("Failed to write {}: {}", path, e))
}

/// Get file size
#[tauri::command]
fn get_file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| format!("Failed to stat {}: {}", path, e))
}

/// List files in a directory matching the cache pattern
#[tauri::command]
fn list_cache_files(dir: String) -> Result<Vec<cache::CacheFileEntry>, String> {
    cache::list_cache_files(&dir).map_err(|e| e.to_string())
}

/// Open a folder in the system file explorer
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Concatenate multiple files into a single output file (avoids JS memory limits).
/// Strips Simple Cache wrappers from each input file before concatenation.
#[tauri::command]
fn concat_files(paths: Vec<String>, output: String) -> Result<u64, String> {
    use std::io::Write;
    if let Some(parent) = std::path::Path::new(&output).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    let mut out = std::fs::File::create(&output)
        .map_err(|e| format!("Failed to create {}: {}", output, e))?;
    let mut total: u64 = 0;
    for p in &paths {
        let data = read_with_lock_retry(p).map_err(|e| format_read_error(p, &e))?;
        // Sparse _s files need reassembly; _0/_1 files need wrapper stripping
        let body = if is_simple_cache_sparse(p) {
            reassemble_sparse_data(&data, p)?
        } else {
            strip_simple_cache_wrapper(data, p)
        };
        total += body.len() as u64;
        out.write_all(&body)
            .map_err(|e| format!("Failed to write: {}", e))?;
    }
    out.flush().map_err(|e| format!("Failed to flush: {}", e))?;
    Ok(total)
}

// ─── MP4 Reconstruction Helpers ────────────────────────────────────

/// Find an MP4 box (ftyp, mdat, moov, etc.) in raw data.
/// Returns (offset_of_box_start, declared_box_size, header_size).
fn find_mp4_box(data: &[u8], box_type: &[u8; 4]) -> Option<(usize, u64, usize)> {
    let mut pos = 0usize;
    while pos + 8 <= data.len() {
        let box_size = u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]);
        let btype = &data[pos + 4..pos + 8];

        let (actual_size, header_size) = if box_size == 1 {
            // Extended 64-bit size
            if pos + 16 > data.len() {
                break;
            }
            let hi =
                u32::from_be_bytes([data[pos + 8], data[pos + 9], data[pos + 10], data[pos + 11]])
                    as u64;
            let lo = u32::from_be_bytes([
                data[pos + 12],
                data[pos + 13],
                data[pos + 14],
                data[pos + 15],
            ]) as u64;
            (hi * 0x1_0000_0000 + lo, 16usize)
        } else if box_size == 0 {
            ((data.len() - pos) as u64, 8usize)
        } else {
            (box_size as u64, 8usize)
        };

        if actual_size < 8 {
            break;
        }

        // Validate box type is printable ASCII
        if !btype.iter().all(|&b| b >= 0x20 && b <= 0x7e) {
            break;
        }

        if btype == box_type {
            return Some((pos, actual_size, header_size));
        }

        let next = pos as u64 + actual_size;
        if next > data.len() as u64 || next <= pos as u64 {
            break;
        }
        pos = next as usize;
    }
    None
}

/// Scan raw bytes for valid moov atoms. Returns (offset, size) of the first valid one.
fn scan_for_moov(data: &[u8]) -> Option<(usize, usize)> {
    let moov_sig: [u8; 4] = [0x6d, 0x6f, 0x6f, 0x76]; // "moov"
    let mvhd_sig: [u8; 4] = [0x6d, 0x76, 0x68, 0x64]; // "mvhd"
    let trak_sig: [u8; 4] = [0x74, 0x72, 0x61, 0x6b]; // "trak"

    let mut search_from = 0usize;
    while search_from < data.len().saturating_sub(4) {
        // Find next occurrence of "moov"
        let idx = match data[search_from..].windows(4).position(|w| w == moov_sig) {
            Some(i) => search_from + i,
            None => break,
        };

        if idx >= 4 {
            let box_size =
                u32::from_be_bytes([data[idx - 4], data[idx - 3], data[idx - 2], data[idx - 1]])
                    as usize;

            // Validate moov size: typically 500B-2MB
            if box_size >= 500 && box_size <= 2_000_000 {
                let box_end = idx - 4 + box_size;
                if box_end <= data.len() {
                    let inner = &data[idx - 4..box_end];
                    let has_mvhd = inner.windows(4).any(|w| w == mvhd_sig);
                    let has_trak = inner.windows(4).any(|w| w == trak_sig);
                    if has_mvhd && has_trak {
                        return Some((idx - 4, box_size));
                    }
                }
            }
        }
        search_from = idx + 1;
    }
    None
}

/// Extract hex number from a cache filename like "f_00630b"
fn parse_cache_hex(path: &str) -> Option<u64> {
    let filename = std::path::Path::new(path).file_name()?.to_str()?;
    if filename.starts_with("f_") && filename.len() == 8 {
        u64::from_str_radix(&filename[2..], 16).ok()
    } else {
        None
    }
}

/// Reconstruct a chunked MP4 from Discord cache files.
/// chunk_paths = ALL non-header cache files (sorted by name); Rust identifies the tail via moov scan.
#[tauri::command]
fn reconstruct_chunked_mp4(
    header_path: String,
    chunk_paths: Vec<String>,
    output: String,
) -> Result<u64, String> {
    use std::io::Write;

    // Ensure output directory exists
    if let Some(parent) = std::path::Path::new(&output).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }

    let header_data = read_cache_body(&header_path)?;

    let ftyp_box = find_mp4_box(&header_data, b"ftyp")
        .ok_or_else(|| "No ftyp box found in header file".to_string())?;
    let mdat_box = find_mp4_box(&header_data, b"mdat")
        .ok_or_else(|| "No mdat box found in header file".to_string())?;

    let ftyp_offset = ftyp_box.0;
    let ftyp_size = ftyp_box.1 as usize;
    let mdat_offset = mdat_box.0;
    let mdat_declared_size = mdat_box.1;
    let mdat_header_size = mdat_box.2;

    // Bytes between ftyp end and mdat start (e.g. a "free" box).
    // These must be preserved so that the reconstructed file layout matches
    // the original offsets that moov references use.
    let gap_before_mdat = mdat_offset.saturating_sub(ftyp_offset + ftyp_size);

    println!("[reconstruct] ftyp: {} bytes, mdat_offset: {}", ftyp_size, mdat_offset);
    println!(
        "[reconstruct] mdat: declared size = {} bytes (header: {} bytes), gap_before_mdat: {}",
        mdat_declared_size, mdat_header_size, gap_before_mdat
    );

    // chunk_size_standard = max(all file sizes), used for gap padding
    let header_size = header_data.len() as u64;
    let mut chunk_sizes: Vec<(String, u64)> = Vec::new();
    chunk_sizes.push((header_path.clone(), header_size));
    for cp in &chunk_paths {
        let meta = std::fs::metadata(cp).map_err(|e| format!("Failed to stat {}: {}", cp, e))?;
        chunk_sizes.push((cp.clone(), meta.len()));
    }
    let chunk_size_standard = chunk_sizes
        .iter()
        .map(|(_, sz)| *sz)
        .max()
        .unwrap_or(1_048_576);

    println!(
        "[reconstruct] chunk_size_standard (max): {}",
        chunk_size_standard
    );

    // Identify tail: first undersized chunk containing a valid moov atom
    let mut tail_path: Option<String> = None;
    let mut middle_paths: Vec<String> = Vec::new();

    // full_chunk_size = most-common size (for size comparison during tail detection)
    let mut size_counts: std::collections::HashMap<u64, usize> = std::collections::HashMap::new();
    for (_, sz) in &chunk_sizes[1..] {
        *size_counts.entry(*sz).or_insert(0) += 1;
    }
    let full_chunk_size = size_counts
        .iter()
        .max_by_key(|(_, count)| *count)
        .map(|(size, _)| *size)
        .unwrap_or(chunk_size_standard);

    println!(
        "[reconstruct] full_chunk_size (most common): {}",
        full_chunk_size
    );

    for cp in &chunk_paths {
        let sz = std::fs::metadata(cp)
            .map_err(|e| format!("Failed to stat {}: {}", cp, e))?
            .len();
        if sz < full_chunk_size && tail_path.is_none() {
            let chunk_data = read_cache_body(cp)?;
            if scan_for_moov(&chunk_data).is_some() {
                println!(
                    "[reconstruct] Tail identified (has moov): {} ({} bytes)",
                    cp, sz
                );
                tail_path = Some(cp.clone());
            } else {
                middle_paths.push(cp.clone());
            }
        } else {
            middle_paths.push(cp.clone());
        }
    }

    // Fallback: scan ALL chunks for moov (may be in a full-size chunk)
    if tail_path.is_none() {
        println!("[reconstruct] No tail found by size heuristic, scanning all chunks for moov...");
        for cp in &chunk_paths {
            let chunk_data = read_cache_body(cp)?;
            if scan_for_moov(&chunk_data).is_some() {
                println!("[reconstruct] Tail found in full scan: {} ", cp);
                tail_path = Some(cp.clone());
                middle_paths.retain(|p| p != cp);
                break;
            }
        }
    }

    println!(
        "[reconstruct] Files: header=1, middle={}, tail={}",
        middle_paths.len(),
        if tail_path.is_some() { "yes" } else { "no" }
    );

    let mut all_data = Vec::with_capacity(header_data.len());
    all_data.extend_from_slice(&header_data);
    for mp in &middle_paths {
        let chunk = read_cache_body(mp)?;
        all_data.extend_from_slice(&chunk);
    }
    if let Some(ref tp) = tail_path {
        let tail = read_cache_body(tp)?;
        all_data.extend_from_slice(&tail);
    }

    let moov_result = scan_for_moov(&all_data);

    println!(
        "[reconstruct] Total raw data: {} bytes ({:.2} MB)",
        all_data.len(),
        all_data.len() as f64 / 1024.0 / 1024.0
    );

    match moov_result {
        Some((moov_offset, moov_size)) => {
            println!(
                "[reconstruct] Found moov at offset {} (size: {} bytes)",
                moov_offset, moov_size
            );

            let moov_at_end = moov_offset > all_data.len() / 2;
            println!(
                "[reconstruct] Layout: {}",
                if moov_at_end {
                    "moov-at-end (streaming)"
                } else {
                    "moov-at-front"
                }
            );

            if moov_at_end {
                let original_size = ftyp_size as u64 + gap_before_mdat as u64 + mdat_declared_size + moov_size as u64;
                println!(
                    "[reconstruct] Original file size: {} bytes ({:.2} MB)",
                    original_size,
                    original_size as f64 / 1024.0 / 1024.0
                );

                let mut reconstructed = vec![0u8; original_size as usize];

                let ftyp_data = &header_data[ftyp_offset..ftyp_offset + ftyp_size];
                reconstructed[0..ftyp_size].copy_from_slice(ftyp_data);

                // Place mdat header at ftyp_end + gap (preserving any free/skip boxes in between).
                let mdat_start = ftyp_size + gap_before_mdat;
                // Copy the gap bytes (e.g. "free" box) from the original header data.
                if gap_before_mdat > 0 {
                    let gap_src = &header_data[ftyp_offset + ftyp_size..mdat_offset];
                    reconstructed[ftyp_size..ftyp_size + gap_before_mdat]
                        .copy_from_slice(gap_src);
                }
                if mdat_header_size == 16 {
                    reconstructed[mdat_start..mdat_start + 4].copy_from_slice(&1u32.to_be_bytes());
                    reconstructed[mdat_start + 4..mdat_start + 8].copy_from_slice(b"mdat");
                    reconstructed[mdat_start + 8..mdat_start + 16]
                        .copy_from_slice(&mdat_declared_size.to_be_bytes());
                } else {
                    reconstructed[mdat_start..mdat_start + 4]
                        .copy_from_slice(&(mdat_declared_size as u32).to_be_bytes());
                    reconstructed[mdat_start + 4..mdat_start + 8].copy_from_slice(b"mdat");
                }

                // Extract media from header_data starting AFTER the mdat box header.
                let header_media_start = mdat_offset + mdat_header_size;
                let header_media = &header_data[header_media_start..];
                let media_start = mdat_start + mdat_header_size;
                let mut pos = media_start;

                let copy_len = header_media
                    .len()
                    .min(reconstructed.len().saturating_sub(pos));
                reconstructed[pos..pos + copy_len].copy_from_slice(&header_media[..copy_len]);
                pos += header_media.len();

                // Calculate tail_start so we know the boundary for middle chunk data.
                // tail_start = where the tail data begins in the final file.
                let tail_data_for_boundary = if let Some(ref tp) = tail_path {
                    Some(read_cache_body(tp)?)
                } else {
                    None
                };
                let tail_start = if let Some(ref td) = tail_data_for_boundary {
                    original_size as usize - td.len()
                } else {
                    reconstructed.len()
                };

                // Calculate how much middle media data we actually need.
                let middle_data_budget = tail_start.saturating_sub(pos);
                println!(
                    "[reconstruct] Middle data budget: {} bytes (tail_start: {}, current pos: {})",
                    middle_data_budget, tail_start, pos
                );

                // For gap detection: track the hex number of the last actually-written
                // chunk (or the baseline for the first chunk).
                // The baseline is header_hex + 1 to account for the tail file which
                // typically sits at header_hex + 1 in the sequence.
                let header_hex = parse_cache_hex(&header_path);
                let tail_hex = tail_path.as_ref().and_then(|tp| parse_cache_hex(tp));
                // Baseline: the highest of header_hex and tail_hex (they're usually adjacent).
                let mut last_written_hex: Option<u64> = match (header_hex, tail_hex) {
                    (Some(h), Some(t)) => Some(h.max(t)),
                    (Some(h), None) => Some(h),
                    (None, Some(t)) => Some(t),
                    (None, None) => None,
                };
                let mut skipped_non_standard = 0usize;
                for (_idx, mp) in middle_paths.iter().enumerate() {
                    // Stop if we've already filled up to the tail boundary.
                    if pos >= tail_start {
                        println!(
                            "[reconstruct] Reached tail_start boundary at pos={}, stopping middle chunks (processed {}/{})",
                            pos, _idx, middle_paths.len()
                        );
                        break;
                    }

                    let chunk = read_cache_body(mp)?;

                    // Filter: skip chunks that are NOT full_chunk_size.
                    // Non-standard-sized files in the hex range are almost certainly from
                    // other cached content (different downloads, images, etc.).
                    if chunk.len() as u64 != full_chunk_size {
                        skipped_non_standard += 1;
                        println!(
                            "[reconstruct] Skipping non-standard chunk {} ({} bytes, expected {})",
                            std::path::Path::new(mp).file_name().unwrap_or_default().to_string_lossy(),
                            chunk.len(),
                            full_chunk_size
                        );
                        continue;
                    }

                    // Gap detection: compare against last_written_hex (NOT middle_paths[idx-1],
                    // which may have been a skipped non-standard chunk).
                    if let (Some(prev_num), Some(curr_num)) =
                        (last_written_hex, parse_cache_hex(mp))
                    {
                        let gap = curr_num.saturating_sub(prev_num).saturating_sub(1);
                        if gap > 0 {
                            let gap_size = (gap * full_chunk_size) as usize;
                            // Cap gap padding so it doesn't exceed tail_start.
                            let capped_gap = gap_size.min(tail_start.saturating_sub(pos));
                            println!(
                                "[reconstruct] Gap: {} missing chunk(s) before {} ({} bytes padding, capped to {})",
                                gap,
                            std::path::Path::new(mp).file_name().unwrap_or_default().to_string_lossy(),
                                gap_size,
                                capped_gap
                            );
                            pos += capped_gap;
                        }
                    }

                    // Update last_written_hex to this chunk's hex number.
                    if let Some(num) = parse_cache_hex(mp) {
                        last_written_hex = Some(num);
                    }

                    // Don't write past tail_start.
                    if pos >= tail_start {
                        break;
                    }
                    let write_len = chunk.len().min(tail_start - pos);
                    reconstructed[pos..pos + write_len].copy_from_slice(&chunk[..write_len]);
                    pos += chunk.len();
                }

                if skipped_non_standard > 0 {
                    println!(
                        "[reconstruct] Skipped {} non-standard-sized chunks",
                        skipped_non_standard
                    );
                }

                if let Some(ref td) = tail_data_for_boundary {
                    println!(
                        "[reconstruct] Tail placement: offset {} ({} bytes)",
                        tail_start,
                        td.len()
                    );
                    if tail_start < reconstructed.len() {
                        let copy_len = td.len().min(reconstructed.len() - tail_start);
                        reconstructed[tail_start..tail_start + copy_len]
                            .copy_from_slice(&td[..copy_len]);
                    }
                }

                // Moov is already correctly placed by the tail chunk above.
                // Do NOT overwrite from all_data — all_data is a gap-less concatenation
                // where moov_offset doesn't correspond to the real file layout.

                let mut out_file = std::fs::File::create(&output)
                    .map_err(|e| format!("Failed to create {}: {}", output, e))?;
                out_file
                    .write_all(&reconstructed)
                    .map_err(|e| format!("Failed to write: {}", e))?;
                out_file
                    .flush()
                    .map_err(|e| format!("Failed to flush: {}", e))?;

                println!(
                    "[reconstruct] Written {} bytes to {}",
                    reconstructed.len(),
                    output
                );
                Ok(reconstructed.len() as u64)
            } else {
                let mut out_file = std::fs::File::create(&output)
                    .map_err(|e| format!("Failed to create {}: {}", output, e))?;
                out_file
                    .write_all(&all_data)
                    .map_err(|e| format!("Failed to write: {}", e))?;
                out_file
                    .flush()
                    .map_err(|e| format!("Failed to flush: {}", e))?;
                Ok(all_data.len() as u64)
            }
        }
        None => {
            println!("[reconstruct] No moov found — writing concatenated data");
            let mut out_file = std::fs::File::create(&output)
                .map_err(|e| format!("Failed to create {}: {}", output, e))?;
            out_file
                .write_all(&all_data)
                .map_err(|e| format!("Failed to write: {}", e))?;
            out_file
                .flush()
                .map_err(|e| format!("Failed to flush: {}", e))?;
            Ok(all_data.len() as u64)
        }
    }
}

/// Parse top-level MP4 boxes and strip duplicate moov boxes.
/// If the file contains exactly one moov, it's left untouched.
/// If the file contains two or more moov boxes, all but the first are
/// removed and the file is rewritten in-place.
/// Returns the number of moov boxes found (before fixing).
#[tauri::command]
fn fix_mp4_moov(path: String) -> Result<u32, String> {
    use std::io::Write;
    let data = std::fs::read(&path).map_err(|e| format!("Failed to read {}: {}", path, e))?;

    // Parse all top-level boxes
    let mut boxes: Vec<(usize, usize, [u8; 4])> = Vec::new(); // (offset, size, type)
    let mut pos = 0usize;
    while pos + 8 <= data.len() {
        let box_size_u32 = u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]);
        let btype: [u8; 4] = [data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]];

        let actual_size = if box_size_u32 == 1 {
            if pos + 16 > data.len() { break; }
            let hi = u32::from_be_bytes([data[pos + 8], data[pos + 9], data[pos + 10], data[pos + 11]]) as u64;
            let lo = u32::from_be_bytes([data[pos + 12], data[pos + 13], data[pos + 14], data[pos + 15]]) as u64;
            (hi * 0x1_0000_0000 + lo) as usize
        } else if box_size_u32 == 0 {
            data.len() - pos
        } else {
            box_size_u32 as usize
        };

        if actual_size < 8 { break; }
        if !btype.iter().all(|&b| b >= 0x20 && b <= 0x7e) { break; }

        let end = pos + actual_size;
        if end > data.len() { break; }

        boxes.push((pos, actual_size, btype));
        pos = end;
    }

    let moov_tag = *b"moov";
    let moov_count = boxes.iter().filter(|(_, _, t)| *t == moov_tag).count() as u32;

    if moov_count <= 1 {
        return Ok(moov_count);
    }

    println!("[fix_mp4_moov] Found {} moov boxes in {}, stripping duplicates", moov_count, path);

    // Keep all boxes except duplicate moovs (keep the first moov only)
    let mut seen_moov = false;
    let mut fixed = Vec::with_capacity(data.len());
    for (offset, size, btype) in &boxes {
        if *btype == moov_tag {
            if seen_moov {
                println!("[fix_mp4_moov] Removing duplicate moov at offset {} ({} bytes)", offset, size);
                continue;
            }
            seen_moov = true;
        }
        fixed.extend_from_slice(&data[*offset..*offset + *size]);
    }

    let mut out = std::fs::File::create(&path)
        .map_err(|e| format!("Failed to write {}: {}", path, e))?;
    out.write_all(&fixed).map_err(|e| format!("Failed to write: {}", e))?;
    out.flush().map_err(|e| format!("Failed to flush: {}", e))?;

    println!("[fix_mp4_moov] Fixed: {} -> {} bytes", data.len(), fixed.len());
    Ok(moov_count)
}

/// Extract the Content-Type from a Simple Cache file's HTTP response headers (stream 0).
/// Chromium stores headers as null-byte separated strings: "HTTP/1.1 200\0Content-Type: video/mp4\0..."
#[tauri::command]
fn read_file_content_type(path: String) -> Result<String, String> {
    let data = std::fs::read(&path).map_err(|e| format_read_error(&path, &e))?;
    let headers = extract_simple_cache_headers(&data)
        .ok_or_else(|| "Not a Simple Cache file or no headers".to_string())?;
    let header_str = String::from_utf8_lossy(&headers);
    // Chromium HttpResponseHeaders uses null-byte separators
    for part in header_str.split('\0') {
        let lower = part.to_lowercase();
        if lower.starts_with("content-type:") {
            let ct = part["content-type:".len()..].trim();
            // Strip parameters like charset, boundary, etc.
            let mime = ct.split(';').next().unwrap_or(ct).trim();
            return Ok(mime.to_lowercase());
        }
    }
    Err("No Content-Type header found".to_string())
}


// ─── Sparse File Parsing ( files) ──────────────────────────────────────
//
// Chromium writes HTTP 206 Partial Content responses into  sparse files.
// On macOS, Discord always triggers range requests (), so
// virtually all video data ends up in  files rather than / files.
//
// File layout (matches Chromium net/disk_cache/simple/simple_entry_format.h):
//   [SimpleFileHeader: 24 bytes]  magic + version + key_len + key_hash + pad
//   [URL key: key_len bytes]
//   Zero or more sparse data entries, each:
//     [SparseRangeHeader: 32 bytes]  magic + offset + length + crc32 + pad
//     [raw data: length bytes]
//
// We reassemble by sorting all chunks by  and writing them into a
// contiguous buffer (zero-filled gaps stay zero — matching Chromium behavior).

/// Chromium Simple Sparse Range Header magic (little-endian): 0xeb97bf016553676b
const SPARSE_RANGE_MAGIC: u64 = 0xeb97bf016553676b;
/// Size of a SparseRangeHeader: magic(8) + offset(8) + length(8) + crc32(4) + padding(4) = 32
const SPARSE_RANGE_HEADER_SIZE: usize = 32;

/// Parse a Chromium Simple Cache _s (sparse) file and return the reassembled data.
/// Returns an error string if the file doesn't look like a valid sparse cache file.
/// Returns an empty Vec if the file header is valid but contains no data chunks.
#[tauri::command]
fn read_sparse_cache_file(path: String) -> Result<Vec<u8>, String> {
    let data = read_with_lock_retry(&path)
        .map_err(|e| format_read_error(&path, &e))?;
    reassemble_sparse_data(&data, &path)
}

/// Get the total reassembled size of a sparse cache file without reading all data.
/// Returns 0 if not a valid sparse file or if the file is empty.
#[tauri::command]
fn get_sparse_cache_size(path: String) -> Result<u64, String> {
    let data = read_with_lock_retry(&path)
        .map_err(|e| format_read_error(&path, &e))?;

    if data.len() < SIMPLE_CACHE_HEADER_SIZE {
        return Ok(0);
    }
    let magic = u64::from_le_bytes(match data[0..8].try_into() {
        Ok(b) => b,
        Err(_) => return Ok(0),
    });
    if magic != SIMPLE_CACHE_MAGIC {
        return Ok(0);
    }
    let key_length = u32::from_le_bytes(match data[12..16].try_into() {
        Ok(b) => b,
        Err(_) => return Ok(0),
    }) as usize;

    let mut pos = SIMPLE_CACHE_HEADER_SIZE + key_length;
    let mut max_end: u64 = 0;

    while pos + SPARSE_RANGE_HEADER_SIZE <= data.len() {
        let hdr = &data[pos..pos + SPARSE_RANGE_HEADER_SIZE];
        let range_magic = u64::from_le_bytes(match hdr[0..8].try_into() {
            Ok(b) => b,
            Err(_) => break,
        });
        if range_magic != SPARSE_RANGE_MAGIC {
            break;
        }
        let offset = u64::from_le_bytes(match hdr[8..16].try_into() {
            Ok(b) => b,
            Err(_) => break,
        });
        let length = u64::from_le_bytes(match hdr[16..24].try_into() {
            Ok(b) => b,
            Err(_) => break,
        });
        let end = offset + length;
        if end > max_end {
            max_end = end;
        }
        pos += SPARSE_RANGE_HEADER_SIZE + length as usize;
    }

    Ok(max_end)
}

/// Read the first N reassembled bytes from a sparse cache file (for magic byte / type detection).
/// This avoids reading the entire file into memory just to check the first few hundred bytes.
/// Returns the first `size` bytes starting from offset 0 of the reassembled data.
#[tauri::command]
fn read_sparse_cache_header(path: String, size: usize) -> Result<Vec<u8>, String> {
    let data = read_with_lock_retry(&path)
        .map_err(|e| format_read_error(&path, &e))?;

    if data.len() < SIMPLE_CACHE_HEADER_SIZE {
        return Err(format!("File too small to be a sparse cache file: {}", path));
    }

    let magic = u64::from_le_bytes(data[0..8].try_into().map_err(|_| "read magic".to_string())?);
    if magic != SIMPLE_CACHE_MAGIC {
        return Err(format!("Not a Simple Cache file (bad magic): {}", path));
    }

    let key_length = u32::from_le_bytes(
        data[12..16].try_into().map_err(|_| "read key_len".to_string())?
    ) as usize;

    let mut pos = SIMPLE_CACHE_HEADER_SIZE + key_length;
    if pos > data.len() {
        return Err(format!("key_length extends past end of file: {}", path));
    }

    // Collect all ranges and find the one starting at or near offset 0
    let mut chunks: Vec<(u64, usize, usize)> = Vec::new(); // (offset, data_start, data_end)
    while pos + SPARSE_RANGE_HEADER_SIZE <= data.len() {
        let hdr = &data[pos..pos + SPARSE_RANGE_HEADER_SIZE];
        let range_magic = u64::from_le_bytes(hdr[0..8].try_into().map_err(|_| "range magic".to_string())?);
        if range_magic != SPARSE_RANGE_MAGIC { break; }
        let offset = u64::from_le_bytes(hdr[8..16].try_into().map_err(|_| "offset".to_string())?);
        let length = u64::from_le_bytes(hdr[16..24].try_into().map_err(|_| "length".to_string())?);
        let data_start = pos + SPARSE_RANGE_HEADER_SIZE;
        let data_end = (data_start + length as usize).min(data.len());
        if data_end > data_start {
            chunks.push((offset, data_start, data_end));
        }
        if data_end >= data.len() { break; }
        pos = data_end;
    }

    if chunks.is_empty() {
        return Ok(Vec::new());
    }

    // Sort by offset and assemble just the first `size` bytes
    chunks.sort_by_key(|(off, _, _)| *off);
    let needed = size.min(4096);
    let mut buf = vec![0u8; needed];
    for (offset, data_start, data_end) in &chunks {
        let start = *offset as usize;
        let len = data_end - data_start;
        if start >= needed { break; }
        let copy_end = (start + len).min(needed);
        let copy_len = copy_end - start;
        buf[start..copy_end].copy_from_slice(&data[*data_start..*data_start + copy_len]);
    }

    // Trim trailing zeros if the sparse data doesn't fill the buffer
    let actual_len = chunks.iter()
        .map(|(off, ds, de)| (*off as usize + (de - ds)).min(needed))
        .max()
        .unwrap_or(0);
    buf.truncate(actual_len.min(needed));

    Ok(buf)
}

/// Copy a _s (sparse) Simple Cache file to dst, reassembling range chunks into contiguous data.
/// This is the correct way to extract video data from macOS Discord _s cache files.
#[tauri::command]
fn copy_sparse_file(src: String, dst: String) -> Result<u64, String> {
    use std::io::Write;
    if let Some(parent) = std::path::Path::new(&dst).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    let data = read_with_lock_retry(&src)
        .map_err(|e| format_read_error(&src, &e))?;
    let buf = reassemble_sparse_data(&data, &src)?;
    let total_size = buf.len() as u64;
    let mut out = std::fs::File::create(&dst)
        .map_err(|e| format!("Failed to create {}: {}", dst, e))?;
    out.write_all(&buf).map_err(|e| format!("Failed to write: {}", e))?;
    out.flush().map_err(|e| format!("Failed to flush: {}", e))?;
    Ok(total_size)
}

/// Get scan status
#[tauri::command]
fn get_status(state: State<'_, Mutex<AppState>>) -> Result<(bool, bool), String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    Ok((s.scan_running, s.recovery_running))
}

/// Probe whether this process truly has Full Disk Access on macOS.
/// Uses File::open (which triggers open(2) → TCC check) on the TCC database.
/// access(2)/metadata()/exists() do NOT trigger TCC, so we must use open(2).
/// Returns: { has_access: bool, error_code: Option<i32>, error_msg: Option<String>, binary_path: String }
#[tauri::command]
fn probe_full_disk_access() -> Result<serde_json::Value, String> {
    let binary_path = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    #[cfg(target_os = "macos")]
    {
        // TCC.db requires FDA to open. This is the Apple-recommended probe.
        let tcc_path = "/Library/Application Support/com.apple.TCC/TCC.db";
        match std::fs::File::open(tcc_path) {
            Ok(_) => Ok(serde_json::json!({
                "has_access": true,
                "error_code": null,
                "error_msg": null,
                "binary_path": binary_path
            })),
            Err(e) => {
                let raw_errno = e.raw_os_error();
                let is_eperm = raw_errno == Some(1); // EPERM = TCC denial
                let is_eacces = raw_errno == Some(13); // EACCES = BSD perms
                eprintln!(
                    "[FDA probe] open({}) failed: {} (errno: {:?}, is_tcc_denial: {}, binary: {})",
                    tcc_path, e, raw_errno, is_eperm, binary_path
                );
                Ok(serde_json::json!({
                    "has_access": false,
                    "error_code": raw_errno,
                    "error_msg": format!("{}", e),
                    "binary_path": binary_path
                }))
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(serde_json::json!({
            "has_access": true,
            "error_code": null,
            "error_msg": null,
            "binary_path": binary_path
        }))
    }
}

/// Test whether this process can actually read files in a given directory.
/// Tries to open (not just stat) a file in the directory to trigger TCC checks.
/// Returns detailed diagnostic info including errno, binary path, and error type.
#[tauri::command]
fn test_path_access(path: String) -> Result<serde_json::Value, String> {
    let binary_path = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "unknown".to_string());

    // First test: can we list the directory?
    let can_list = match std::fs::read_dir(&path) {
        Ok(_) => true,
        Err(_) => false,
    };

    // Second test: try to open+read the first file we find
    let mut read_result = serde_json::json!({
        "tested": false,
        "success": false,
        "error_code": null,
        "error_msg": null,
        "tested_file": null
    });

    if let Ok(entries) = std::fs::read_dir(&path) {
        for entry in entries.flatten() {
            let file_path = entry.path();
            if file_path.is_file() {
                let file_str = file_path.display().to_string();
                // Try to actually read (not just stat) — this triggers TCC
                match std::fs::File::open(&file_path) {
                    Ok(mut f) => {
                        use std::io::Read;
                        let mut buf = [0u8; 1];
                        match f.read(&mut buf) {
                            Ok(_) => {
                                read_result = serde_json::json!({
                                    "tested": true,
                                    "success": true,
                                    "error_code": null,
                                    "error_msg": null,
                                    "tested_file": file_str
                                });
                            }
                            Err(e) => {
                                read_result = serde_json::json!({
                                    "tested": true,
                                    "success": false,
                                    "error_code": e.raw_os_error(),
                                    "error_msg": format!("{}", e),
                                    "tested_file": file_str
                                });
                            }
                        }
                    }
                    Err(e) => {
                        read_result = serde_json::json!({
                            "tested": true,
                            "success": false,
                            "error_code": e.raw_os_error(),
                            "error_msg": format!("{}", e),
                            "tested_file": file_str
                        });
                    }
                }
                break; // Only test one file
            }
        }
    }

    Ok(serde_json::json!({
        "path": path,
        "can_list_directory": can_list,
        "file_read_test": read_result,
        "binary_path": binary_path
    }))
}

/// Get the current executable path. Useful for showing the user which binary
/// needs Full Disk Access in System Settings.
#[tauri::command]
fn get_app_binary_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.display().to_string())
        .map_err(|e| format!("Failed to get binary path: {}", e))
}

/// Diagnostic command: test multiple file-read strategies on a given path.
/// Returns detailed JSON with what worked and what failed, including errno.
/// Use this to figure out WHY _s files fail when _0 files succeed.
#[tauri::command]
fn diagnose_file_read(path: String) -> Result<serde_json::Value, String> {
    use std::io::Read;
    let mut results = serde_json::Map::new();

    // Test 0: stat (metadata)
    match std::fs::metadata(&path) {
        Ok(meta) => {
            results.insert("stat".into(), serde_json::json!({
                "ok": true,
                "size": meta.len(),
                "readonly": meta.permissions().readonly(),
            }));
        }
        Err(e) => {
            results.insert("stat".into(), serde_json::json!({
                "ok": false,
                "error": format!("{}", e),
                "errno": e.raw_os_error(),
            }));
        }
    }

    // Test 1: std::fs::read (reads entire file at once)
    match std::fs::read(&path) {
        Ok(data) => {
            results.insert("fs_read".into(), serde_json::json!({
                "ok": true,
                "bytes_read": data.len(),
                "first_8": format!("{:02x?}", &data[..data.len().min(8)]),
            }));
        }
        Err(e) => {
            results.insert("fs_read".into(), serde_json::json!({
                "ok": false,
                "error": format!("{}", e),
                "errno": e.raw_os_error(),
            }));
        }
    }

    // Test 2: File::open + read_to_end (streaming read)
    match std::fs::File::open(&path) {
        Ok(mut file) => {
            let mut buf = Vec::new();
            match file.read_to_end(&mut buf) {
                Ok(n) => {
                    results.insert("file_open_read".into(), serde_json::json!({
                        "ok": true,
                        "bytes_read": n,
                    }));
                }
                Err(e) => {
                    results.insert("file_open_read".into(), serde_json::json!({
                        "ok": false,
                        "open_ok": true,
                        "read_error": format!("{}", e),
                        "errno": e.raw_os_error(),
                    }));
                }
            }
        }
        Err(e) => {
            results.insert("file_open_read".into(), serde_json::json!({
                "ok": false,
                "open_ok": false,
                "error": format!("{}", e),
                "errno": e.raw_os_error(),
            }));
        }
    }

    // Test 3: File::open + seek + small read (how read_file_header works)
    match std::fs::File::open(&path) {
        Ok(mut file) => {
            let mut small_buf = [0u8; 64];
            match file.read(&mut small_buf) {
                Ok(n) => {
                    results.insert("file_open_small_read".into(), serde_json::json!({
                        "ok": true,
                        "bytes_read": n,
                        "first_8": format!("{:02x?}", &small_buf[..n.min(8)]),
                    }));
                }
                Err(e) => {
                    results.insert("file_open_small_read".into(), serde_json::json!({
                        "ok": false,
                        "error": format!("{}", e),
                        "errno": e.raw_os_error(),
                    }));
                }
            }
        }
        Err(e) => {
            results.insert("file_open_small_read".into(), serde_json::json!({
                "ok": false,
                "error": format!("{}", e),
                "errno": e.raw_os_error(),
            }));
        }
    }

    // Test 4: Copy to temp then read (workaround test)
    let temp_path = std::env::temp_dir().join("dccache_diag_test");
    match std::fs::copy(&path, &temp_path) {
        Ok(bytes_copied) => {
            let read_ok = std::fs::read(&temp_path).is_ok();
            let _ = std::fs::remove_file(&temp_path);
            results.insert("copy_then_read".into(), serde_json::json!({
                "ok": true,
                "bytes_copied": bytes_copied,
                "read_after_copy_ok": read_ok,
            }));
        }
        Err(e) => {
            results.insert("copy_then_read".into(), serde_json::json!({
                "ok": false,
                "error": format!("{}", e),
                "errno": e.raw_os_error(),
            }));
        }
    }

    // Metadata about the process
    results.insert("process_info".into(), serde_json::json!({
        "pid": std::process::id(),
        "exe": std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_else(|_| "unknown".into()),
    }));

    Ok(serde_json::Value::Object(results))
}

/// Ensure sidecar binaries (ffmpeg, ffprobe) are executable on macOS/Linux.
/// On macOS, also removes com.apple.quarantine xattr that blocks execution.
/// 
/// tauri-build copies sidecars from src-tauri/binaries/ffmpeg-<triple> to
/// target/debug/ffmpeg (triple stripped, flat next to the app binary).
/// At runtime, tauri-plugin-shell resolves sidecars as exe_dir/<name>.
/// Returns a JSON object with the results for each binary.
#[tauri::command]
fn fix_sidecar_permissions() -> Result<serde_json::Value, String> {
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Cannot determine exe path: {}", e))?;
    let exe_dir = exe_path.parent()
        .ok_or_else(|| "Cannot determine exe directory".to_string())?;

    // tauri-build copies sidecars FLAT into the exe directory (triple stripped).
    // Dev mode:  target/debug/ffmpeg  (NOT target/debug/binaries/ffmpeg)
    // Prod mode: .app/Contents/MacOS/ffmpeg
    // See tauri-build copy_binaries() and tauri-plugin-shell relative_command_path().
    let mut results = serde_json::Map::new();
    results.insert("exe_dir".into(), serde_json::json!(exe_dir.display().to_string()));

    let sidecar_names: &[&str] = if cfg!(windows) {
        &["ffmpeg.exe", "ffprobe.exe"]
    } else {
        &["ffmpeg", "ffprobe"]
    };

    let mut fixed: Vec<serde_json::Value> = Vec::new();

    for &name in sidecar_names {
        let path = exe_dir.join(name);
        let mut entry_result = serde_json::Map::new();
        entry_result.insert("name".into(), serde_json::json!(name));
        entry_result.insert("path".into(), serde_json::json!(path.display().to_string()));
        entry_result.insert("exists".into(), serde_json::json!(path.exists()));

        if !path.exists() {
            entry_result.insert("error".into(), serde_json::json!("binary not found"));
            fixed.push(serde_json::Value::Object(entry_result));
            continue;
        }

        // Check and fix execute permission (Unix only)
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(metadata) = std::fs::metadata(&path) {
                let mode = metadata.permissions().mode();
                let is_executable = mode & 0o111 != 0;
                entry_result.insert("mode".into(), serde_json::json!(format!("0o{:o}", mode)));
                entry_result.insert("was_executable".into(), serde_json::json!(is_executable));

                if !is_executable {
                    let new_mode = mode | 0o755;
                    if let Err(e) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(new_mode)) {
                        entry_result.insert("chmod_error".into(), serde_json::json!(e.to_string()));
                    } else {
                        entry_result.insert("chmod_fixed".into(), serde_json::json!(true));
                        eprintln!("[sidecar] Fixed execute permission on: {}", path.display());
                    }
                }
            }
        }

        // Remove quarantine xattr on macOS
        #[cfg(target_os = "macos")]
        {
            let output = std::process::Command::new("xattr")
                .args(["-d", "com.apple.quarantine"])
                .arg(&path)
                .output();
            match output {
                Ok(o) if o.status.success() => {
                    entry_result.insert("quarantine_removed".into(), serde_json::json!(true));
                    eprintln!("[sidecar] Removed quarantine xattr from: {}", path.display());
                }
                Ok(o) => {
                    let stderr = String::from_utf8_lossy(&o.stderr).to_string();
                    if stderr.contains("No such xattr") {
                        entry_result.insert("quarantine_removed".into(), serde_json::json!(false));
                        entry_result.insert("quarantine_note".into(), serde_json::json!("not quarantined"));
                    } else {
                        entry_result.insert("quarantine_error".into(), serde_json::json!(stderr));
                    }
                }
                Err(e) => {
                    entry_result.insert("quarantine_error".into(), serde_json::json!(e.to_string()));
                }
            }
        }

        fixed.push(serde_json::Value::Object(entry_result));
    }

    results.insert("binaries".into(), serde_json::json!(fixed));
    Ok(serde_json::Value::Object(results))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_macos_permissions::init())
        .manage(Mutex::new(AppState {
            scan_running: false,
            recovery_running: false,
        }))
        .invoke_handler(tauri::generate_handler![
            get_default_cache_paths,
            validate_cache_path,
            read_file_header,
            read_file_bytes,
            copy_file,
            write_file_bytes,
            get_file_size,
            list_cache_files,
            open_folder,
            concat_files,
            reconstruct_chunked_mp4,
            fix_mp4_moov,
            read_file_content_type,
            read_sparse_cache_file,
            get_sparse_cache_size,
            read_sparse_cache_header,
            copy_sparse_file,
            get_status,
            probe_full_disk_access,
            test_path_access,
            get_app_binary_path,
            diagnose_file_read,
            fix_sidecar_permissions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
